import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_CHANGED_PATHS = 4_096;

export interface WorkflowCheckoutProof {
  cwd: string;
  root: string;
  gitDir: string;
  head: string;
  changedPaths: number;
  digest: string;
}

async function git(
  cwd: string,
  args: string[],
  encoding: "utf8" | "buffer" = "utf8",
  signal?: AbortSignal,
): Promise<string | Buffer> {
  signal?.throwIfAborted();
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: encoding === "buffer" ? "buffer" : "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  signal?.throwIfAborted();
  return stdout;
}

function containedPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Workflow continuation cannot prove checkout path ${JSON.stringify(path)}`);
  }
  return absolute;
}

async function hashRegularFile(hash: ReturnType<typeof createHash>, path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile()) throw new Error(`Workflow continuation does not support changed checkout entry ${path}`);
  await new Promise<void>((resolveRead, rejectRead) => {
    const stream = createReadStream(path, { signal });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectRead);
    stream.once("end", resolveRead);
  });
  signal?.throwIfAborted();
  const after = await lstat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error(`Workflow checkout changed while continuation state was being recorded: ${path}`);
  }
}

/**
 * Captures the exact Git-visible checkout state without modifying the index.
 * Ignored files are outside Git's checkout state and are deliberately omitted.
 * Unsupported entries and oversized dirty sets fail closed.
 */
export async function captureWorkflowCheckout(cwd: string, signal?: AbortSignal): Promise<WorkflowCheckoutProof> {
  signal?.throwIfAborted();
  const canonicalCwd = await realpath(resolve(cwd));
  const rootText = String(await git(canonicalCwd, ["rev-parse", "--show-toplevel"], "utf8", signal)).trim();
  const root = await realpath(rootText);
  const gitDirText = String(await git(canonicalCwd, ["rev-parse", "--absolute-git-dir"], "utf8", signal)).trim();
  const gitDir = await realpath(gitDirText);
  const head = String(await git(canonicalCwd, ["rev-parse", "HEAD"], "utf8", signal)).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Workflow continuation requires a checkout with a valid HEAD commit");

  const index = await git(canonicalCwd, ["ls-files", "--stage", "-z"], "buffer", signal) as Buffer;
  const indexFlags = await git(canonicalCwd, ["ls-files", "-v", "-z"], "buffer", signal) as Buffer;
  const flaggedEntries = indexFlags.toString("utf8").split("\0").filter(Boolean);
  if (flaggedEntries.some((entry) => /^[a-zS] /.test(entry))) {
    throw new Error("Workflow continuation does not support checkout index flags that hide worktree changes");
  }
  const fsmonitorFlags = await git(canonicalCwd, ["ls-files", "-f", "-z"], "buffer", signal) as Buffer;
  const fsmonitorEntries = fsmonitorFlags.toString("utf8").split("\0").filter(Boolean);
  if (fsmonitorEntries.some((entry) => /^[a-z] /.test(entry))) {
    throw new Error("Workflow continuation does not support fsmonitor-valid index entries that can hide worktree changes");
  }
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];
  const raw = await git(canonicalCwd, statusArgs, "buffer", signal) as Buffer;
  const entries = raw.toString("utf8").split("\0").filter(Boolean);
  if (entries.length > MAX_CHANGED_PATHS) {
    throw new Error(`Workflow continuation checkout has more than ${MAX_CHANGED_PATHS} changed paths`);
  }

  const hash = createHash("sha256");
  hash.update("workflow-checkout-v4\0");
  hash.update(canonicalCwd).update("\0").update(root).update("\0").update(gitDir).update("\0").update(head).update("\0");
  hash.update("index\0").update(index).update("\0");
  hash.update("index-flags\0").update(indexFlags).update("\0");
  hash.update("index-fsmonitor\0").update(fsmonitorFlags).update("\0");
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Workflow continuation could not parse Git checkout status");
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    hash.update(status).update("\0").update(path).update("\0");
    if (status.includes("D")) continue;
    const absolute = containedPath(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) hash.update("symlink\0").update(await readlink(absolute)).update("\0");
    else await hashRegularFile(hash, absolute, signal);
  }

  const [stableIndex, stableIndexFlags, stableFsmonitorFlags, stableStatus] = await Promise.all([
    git(canonicalCwd, ["ls-files", "--stage", "-z"], "buffer", signal) as Promise<Buffer>,
    git(canonicalCwd, ["ls-files", "-v", "-z"], "buffer", signal) as Promise<Buffer>,
    git(canonicalCwd, ["ls-files", "-f", "-z"], "buffer", signal) as Promise<Buffer>,
    git(canonicalCwd, statusArgs, "buffer", signal) as Promise<Buffer>,
  ]);
  if (!index.equals(stableIndex)
      || !indexFlags.equals(stableIndexFlags)
      || !fsmonitorFlags.equals(stableFsmonitorFlags)
      || !raw.equals(stableStatus)) {
    throw new Error("Workflow checkout changed while continuation state was being recorded");
  }

  return {
    cwd: canonicalCwd,
    root,
    gitDir,
    head,
    changedPaths: entries.length,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

export async function assertWorkflowCheckout(proof: WorkflowCheckoutProof, signal?: AbortSignal): Promise<void> {
  const current = await captureWorkflowCheckout(proof.cwd, signal);
  if (current.cwd !== proof.cwd
      || current.root !== proof.root
      || current.gitDir !== proof.gitDir
      || current.head !== proof.head
      || current.changedPaths !== proof.changedPaths
      || current.digest !== proof.digest) {
    throw new Error("Workflow continuation checkout is missing or diverged from its durable handoff checkpoint");
  }
}
