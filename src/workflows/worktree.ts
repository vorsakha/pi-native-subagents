import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export interface WorkflowWorktreeHandle {
  path: string;
  root: string;
  branch: string;
  runId: string;
  agentIndex: number;
}

export interface WorkflowWorktreeResult {
  type: "worktree";
  state: "removed" | "preserved" | "orphaned";
  branch: string;
  changed: boolean;
  patchArtifact?: string;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function assertWithin(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (path.startsWith("..") || resolve(parent) === resolve(child)) throw new Error("Workflow worktree path escapes its private run directory");
}

export async function prepareWorkflowWorktree(input: {
  cwd: string;
  artifactDir: string;
  runId: string;
  agentIndex: number;
}): Promise<WorkflowWorktreeHandle> {
  if (!/^wf_[a-f0-9]+$/.test(input.runId) || !Number.isSafeInteger(input.agentIndex) || input.agentIndex < 0 || input.agentIndex >= 32) {
    throw new Error("Invalid workflow worktree identity");
  }
  const artifactInfo = await lstat(input.artifactDir);
  if (artifactInfo.isSymbolicLink() || !artifactInfo.isDirectory()) throw new Error("Workflow artifact directory is not a private directory");
  const trustedRoot = await realpath(resolve(input.cwd));
  const root = (await git(trustedRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) throw new Error("Worktree isolation requires a Git repository");
  if (resolve(root) !== trustedRoot) throw new Error("Worktree isolation requires the trusted project to be the Git repository root");
  const sourceStatus = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (sourceStatus.trim()) {
    throw new Error("Worktree isolation requires a clean source checkout so the isolated base cannot omit uncommitted work");
  }
  const worktreesDir = join(input.artifactDir, "worktrees");
  const path = join(worktreesDir, `agent-${input.agentIndex}`);
  assertWithin(input.artifactDir, path);
  await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
  const worktreesInfo = await lstat(worktreesDir);
  if (worktreesInfo.isSymbolicLink() || !worktreesInfo.isDirectory()) throw new Error("Workflow worktrees path is not a private directory");
  await chmod(worktreesDir, 0o700);
  const branch = `pi-workflow/${input.runId}/${input.agentIndex}`;
  await git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, root, branch, runId: input.runId, agentIndex: input.agentIndex };
}

export async function finishWorkflowWorktree(
  handle: WorkflowWorktreeHandle,
  artifactDir: string,
): Promise<WorkflowWorktreeResult> {
  const sourceStatus = await git(handle.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (sourceStatus.trim()) throw new Error("Worktree isolation breach: the source checkout changed while the isolated agent was running");
  const status = await git(handle.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.trim()) {
    await git(handle.root, ["worktree", "remove", "--force", handle.path]);
    await git(handle.root, ["branch", "-D", handle.branch]);
    return { type: "worktree", state: "removed", branch: handle.branch, changed: false };
  }

  await git(handle.path, ["add", "-N", "--", "."]);
  const patch = await git(handle.path, ["diff", "--binary", "HEAD", "--", "."]);
  const patchArtifact = `agent-${handle.agentIndex}.patch`;
  const patchPath = join(artifactDir, patchArtifact);
  if (resolve(dirname(patchPath)) !== resolve(artifactDir)) throw new Error("Workflow patch path escapes its run directory");
  const fileHandle = await open(patchPath, "wx", 0o600);
  try {
    await fileHandle.writeFile(patch, "utf8");
    await fileHandle.sync();
    await fileHandle.chmod(0o600);
  } finally { await fileHandle.close(); }
  return { type: "worktree", state: "preserved", branch: handle.branch, changed: true, patchArtifact };
}
