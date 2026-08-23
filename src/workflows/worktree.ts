import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, constants as fsConstants, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const WORKTREE_BRANCH_PATTERN = /^pi-workflow\/(wf_[a-f0-9]+)\/(\d+)$/;

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
  /** Set when an operator reclaimed the checkout and branch after finalization. */
  reclaimedAt?: number;
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

export function workflowWorktreeBranch(runId: string, agentIndex: number): string {
  return `pi-workflow/${runId}/${agentIndex}`;
}

export function workflowWorktreeDirectory(artifactDir: string): string {
  return join(artifactDir, "worktrees");
}

export function workflowWorktreePath(artifactDir: string, agentIndex: number): string {
  return join(workflowWorktreeDirectory(artifactDir), `agent-${agentIndex}`);
}

/** Round-trips a branch created by {@link workflowWorktreeBranch} back to its identity. */
export function parseWorkflowWorktreeBranch(branch: string): { runId: string; agentIndex: number } | undefined {
  const match = WORKTREE_BRANCH_PATTERN.exec(branch);
  if (!match) return undefined;
  const agentIndex = Number(match[2]);
  if (!Number.isSafeInteger(agentIndex) || agentIndex < 0 || agentIndex >= 32) return undefined;
  return { runId: match[1]!, agentIndex };
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
  const worktreesDir = workflowWorktreeDirectory(input.artifactDir);
  const path = workflowWorktreePath(input.artifactDir, input.agentIndex);
  assertWithin(input.artifactDir, path);
  await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
  const worktreesInfo = await lstat(worktreesDir);
  if (worktreesInfo.isSymbolicLink() || !worktreesInfo.isDirectory()) throw new Error("Workflow worktrees path is not a private directory");
  await chmod(worktreesDir, 0o700);
  const branch = workflowWorktreeBranch(input.runId, input.agentIndex);
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
    await assertWorkflowWorktreeRemoved(handle.root, handle.path, handle.branch);
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

export interface WorkflowWorktreeGitFacts {
  registered: boolean;
  branchExists: boolean;
  checkoutPresent: boolean;
}

async function workflowWorktreeFacts(root: string, path: string, branch: string): Promise<WorkflowWorktreeGitFacts> {
  const list = await git(root, ["worktree", "list", "--porcelain"]);
  const target = resolve(path);
  const registered = list.split(/\r?\n\r?\n/).some((block) =>
    block.split(/\r?\n/).some((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === target));

  const ref = `refs/heads/${branch}`;
  const refs = await git(root, ["for-each-ref", "--format=%(refname)", ref]);
  const branchExists = refs.split(/\r?\n/).some((line) => line.trim() === ref);

  let checkoutPresent = false;
  try {
    await lstat(path);
    checkoutPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return { registered, branchExists, checkoutPresent };
}

async function assertWorkflowWorktreeRemoved(root: string, path: string, branch: string): Promise<void> {
  const facts = await workflowWorktreeFacts(root, path, branch);
  if (facts.registered || facts.checkoutPresent || facts.branchExists) {
    throw new Error(
      `Workflow worktree cleanup incomplete: checkout ${facts.checkoutPresent ? "remains" : "absent"}, `
      + `registration ${facts.registered ? "remains" : "absent"}, branch ${facts.branchExists ? "remains" : "absent"}`,
    );
  }
}

/** Best-effort Git/filesystem facts for a protected worktree. Returns
 * undefined when `cwd` no longer identifies a Git repository. */
export async function inspectWorkflowWorktree(input: { cwd: string; path: string; branch: string }): Promise<WorkflowWorktreeGitFacts | undefined> {
  let root: string;
  try {
    const trustedRoot = await realpath(resolve(input.cwd));
    root = (await git(trustedRoot, ["rev-parse", "--show-toplevel"])).trim();
    if (!root) return undefined;
  } catch { return undefined; }

  try { return await workflowWorktreeFacts(root, input.path, input.branch); }
  catch { return undefined; }
}

export interface ReclaimWorkflowWorktreeInput {
  cwd: string;
  artifactDir: string;
  runId: string;
  agentIndex: number;
  branch: string;
  state: "preserved" | "orphaned";
  /** Recorded patch artifact filename, if any; re-verified against disk. */
  patchArtifact?: string;
  force?: boolean;
}

export interface WorkflowWorktreeReclamation {
  removedRegistration: boolean;
  removedCheckout: boolean;
  deletedBranch: boolean;
  warnings: string[];
}

/**
 * Explicit operator reclamation of a preserved or orphaned isolated worktree:
 * removes the Git worktree registration, deletes its checkout, and drops the
 * `pi-workflow/<runId>/<agentIndex>` branch. Refuses to discard an orphaned
 * checkout's only copy of changed work unless `force` is set.
 */
export async function reclaimWorkflowWorktree(input: ReclaimWorkflowWorktreeInput): Promise<WorkflowWorktreeReclamation> {
  if (!/^wf_[a-f0-9]+$/.test(input.runId) || !Number.isSafeInteger(input.agentIndex) || input.agentIndex < 0 || input.agentIndex >= 32) {
    throw new Error("Invalid workflow worktree identity");
  }
  const expectedBranch = workflowWorktreeBranch(input.runId, input.agentIndex);
  if (input.branch !== expectedBranch) throw new Error("Workflow worktree branch does not match its run and agent identity");
  const path = workflowWorktreePath(input.artifactDir, input.agentIndex);
  assertWithin(input.artifactDir, path);
  const trustedRoot = await realpath(resolve(input.cwd));
  const root = (await git(trustedRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (!root || resolve(root) !== trustedRoot) throw new Error("Worktree reclamation requires the trusted project to be the Git repository root");

  const warnings: string[] = [];
  const patchPath = input.patchArtifact ? join(input.artifactDir, input.patchArtifact) : undefined;
  const patchWithinArtifactDir = !!patchPath && resolve(dirname(patchPath)) === resolve(input.artifactDir);
  const patchExists = patchWithinArtifactDir && await access(patchPath!, fsConstants.F_OK).then(() => true, () => false);

  if (input.state === "orphaned" && !patchExists) {
    if (!input.force) {
      throw new Error(`Reclaiming orphaned worktree at ${path} would discard its only copy of changed work: no patch artifact was found. Pass force to discard it.`);
    }
    warnings.push(`Discarded orphaned checkout at ${path} with no patch artifact protecting its changes`);
  } else if (input.state === "preserved" && input.patchArtifact && !patchExists) {
    warnings.push(`Recorded patch artifact ${input.patchArtifact} is missing from the run directory`);
  }

  let cleanupError: unknown;
  try {
    await git(root, ["worktree", "remove", "--force", path]);
  } catch (error) {
    cleanupError = error;
  }

  let facts = await workflowWorktreeFacts(root, path, input.branch);
  if (facts.checkoutPresent) {
    try { await rm(path, { recursive: true, force: true }); }
    catch (error) { cleanupError ??= error; }
  }
  facts = await workflowWorktreeFacts(root, path, input.branch);
  if (facts.registered) {
    try { await git(root, ["worktree", "prune"]); }
    catch (error) { cleanupError ??= error; }
  }

  try { await git(root, ["branch", "-D", input.branch]); }
  catch (error) { cleanupError ??= error; }

  facts = await workflowWorktreeFacts(root, path, input.branch);
  if (facts.registered || facts.checkoutPresent || facts.branchExists) {
    const detail = `checkout ${facts.checkoutPresent ? "remains" : "absent"}, registration ${facts.registered ? "remains" : "absent"}, branch ${facts.branchExists ? "remains" : "absent"}`;
    const cause = cleanupError ? `: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` : "";
    throw new Error(`Workflow worktree cleanup incomplete (${detail})${cause}`);
  }

  return { removedRegistration: true, removedCheckout: true, deletedBranch: true, warnings };
}
