import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_STALE_AFTER_MS,
  listWorkflowRunIds,
  readWorkflowRunSummary,
  removeWorkflowRun,
  workflowRunDirectory,
} from "./artifacts.ts";
import {
  inspectWorkflowWorktree,
  workflowWorktreeBranch,
  workflowWorktreeDirectory,
  workflowWorktreePath,
  type WorkflowWorktreeGitFacts,
} from "./worktree.ts";
import type { WorkflowSnapshot, WorkflowStatus } from "./types.ts";

/** Bounded artifact retention default, matching the in-session run history cap. */
export const DEFAULT_WORKFLOW_RETAINED_RUNS = 64;

const AGENT_DIRECTORY_PATTERN = /^agent-(\d+)$/;
const LEASE_DIRECTORY_NAME = ".leases";
const RETENTION_LOCK_NAME = ".retention.lock";
const RETENTION_STATE_SUFFIX = ".runtime";
const RETENTION_LOCK_TIMEOUT_MS = 30_000;
const RETENTION_LOCK_RETRY_MS = 25;
const LEASE_HEARTBEAT_MS = 60_000;

interface RetentionLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

interface DurableWorkflowLease {
  version: 1;
  sessionId: string;
  pid: number;
  token: string;
  createdAt: number;
  heartbeatAt: number;
  runIds: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Workflow retention path is not a private directory: ${path}`);
  await chmod(path, 0o700);
}

function retentionStateDirectory(root: string): string {
  return `${resolve(root)}${RETENTION_STATE_SUFFIX}`;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function reclaimDeadRetentionLock(lockPath: string): Promise<boolean> {
  let owner: RetentionLockOwner;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as RetentionLockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { await lstat(lockPath); return false; }
      catch (recheckError) { return (recheckError as NodeJS.ErrnoException).code === "ENOENT"; }
    }
    return false;
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  if (!processIsAlive(owner.pid)) {
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function acquireRetentionLock(root: string): Promise<() => Promise<void>> {
  const normalizedRoot = resolve(root);
  await ensurePrivateDirectory(normalizedRoot);
  const stateDirectory = retentionStateDirectory(normalizedRoot);
  await ensurePrivateDirectory(stateDirectory);
  const lockPath = join(stateDirectory, RETENTION_LOCK_NAME);
  const deadline = Date.now() + RETENTION_LOCK_TIMEOUT_MS;
  for (;;) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await atomicWriteJson(join(lockPath, "owner.json"), {
        pid: process.pid,
        token: randomBytes(12).toString("hex"),
        createdAt: Date.now(),
      } satisfies RetentionLockOwner);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimDeadRetentionLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for workflow retention lock: ${normalizedRoot}`);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, RETENTION_LOCK_RETRY_MS));
    }
  }
}

/** Serializes retention, lease updates, and run creation across managers that
 * share the same machine-global artifact root. */
export async function withWorkflowRetentionLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireRetentionLock(root);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function ensureLeaseDirectory(root: string): Promise<string> {
  const directory = join(retentionStateDirectory(root), LEASE_DIRECTORY_NAME);
  await ensurePrivateDirectory(directory);
  return directory;
}

function leasePath(root: string, token: string): string {
  return join(retentionStateDirectory(root), LEASE_DIRECTORY_NAME, `${token}.json`);
}

function leaseRunIds(state: DurableWorkflowLease): string[] {
  if (state.version !== 1 || typeof state.sessionId !== "string"
      || !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.token !== "string"
      || !Number.isSafeInteger(state.createdAt) || !Number.isSafeInteger(state.heartbeatAt)
      || !Array.isArray(state.runIds) || state.runIds.some((runId) => typeof runId !== "string" || !/^wf_[a-f0-9]+$/.test(runId))) {
    throw new Error("Workflow session lease is invalid");
  }
  return state.runIds;
}

async function activeLeaseRunIds(root: string): Promise<Set<string>> {
  const directory = join(retentionStateDirectory(root), LEASE_DIRECTORY_NAME);
  let entries;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Workflow lease path is not a private directory: ${directory}`);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }

  const runIds = new Set<string>();
  const stale: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) throw new Error(`Workflow session lease is not a regular file: ${entry.name}`);
    const path = join(directory, entry.name);
    let state: DurableWorkflowLease;
    try {
      state = JSON.parse(await readFile(path, "utf8")) as DurableWorkflowLease;
      leaseRunIds(state);
    } catch (error) {
      throw new Error(`Could not read workflow session lease ${entry.name}: ${errorMessage(error)}`);
    }
    if (processIsAlive(state.pid)) {
      for (const runId of state.runIds) runIds.add(runId);
    } else {
      stale.push(path);
    }
  }
  for (const path of stale) await rm(path, { force: true });
  return runIds;
}

export interface WorkflowSessionLease {
  readonly sessionId: string;
  claim(runIds: Iterable<string>): Promise<void>;
  /** Claims IDs while the caller already owns the artifact-root retention lock. */
  claimWhileLocked(runIds: Iterable<string>): Promise<void>;
  release(runId: string): Promise<void>;
  close(): Promise<void>;
}

/** Creates a durable claim for one open manager session. A live process keeps
 * its claimed run artifacts out of every other session's retention pass. */
export async function openWorkflowSessionLease(root: string, sessionId: string): Promise<WorkflowSessionLease> {
  const normalizedRoot = resolve(root);
  await ensurePrivateDirectory(normalizedRoot);
  await ensureLeaseDirectory(normalizedRoot);
  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const path = leasePath(normalizedRoot, token);
  const now = Date.now();
  const state: DurableWorkflowLease = {
    version: 1,
    sessionId,
    pid: process.pid,
    token,
    createdAt: now,
    heartbeatAt: now,
    runIds: [],
  };
  await withWorkflowRetentionLock(normalizedRoot, async () => atomicWriteJson(path, state));

  let closed = false;
  let mutationChain: Promise<void> = Promise.resolve();
  const writeStateWhileLocked = async (runIds: Iterable<string>): Promise<void> => {
    const next = [...new Set(runIds)];
    if (next.some((runId) => !/^wf_[a-f0-9]+$/.test(runId))) throw new Error("Workflow session lease contains an invalid run ID");
    state.runIds = next;
    state.heartbeatAt = Date.now();
    await atomicWriteJson(path, state);
  };
  const enqueueMutation = <T>(action: () => Promise<T>): Promise<T> => {
    const next = mutationChain.catch(() => undefined).then(action);
    mutationChain = next.then(() => undefined, () => undefined);
    return next;
  };
  const heartbeat = setInterval(() => {
    if (closed) return;
    void enqueueMutation(async () => {
      if (closed) return;
      await withWorkflowRetentionLock(normalizedRoot, () => writeStateWhileLocked(state.runIds));
    }).catch(() => undefined);
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    sessionId,
    async claim(runIds) {
      const requested = [...runIds];
      await enqueueMutation(async () => {
        if (closed) throw new Error("Workflow session lease is closed");
        const next = [...new Set([...state.runIds, ...requested])];
        await withWorkflowRetentionLock(normalizedRoot, () => writeStateWhileLocked(next));
      });
    },
    async claimWhileLocked(runIds) {
      if (closed) throw new Error("Workflow session lease is closed");
      await writeStateWhileLocked([...new Set([...state.runIds, ...runIds])]);
    },
    async release(runId) {
      await enqueueMutation(async () => {
        if (closed) return;
        await withWorkflowRetentionLock(normalizedRoot, () => writeStateWhileLocked(state.runIds.filter((candidate) => candidate !== runId)));
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await mutationChain;
      await withWorkflowRetentionLock(normalizedRoot, () => rm(path, { force: true }));
    },
  };
}

function isTerminal(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

export interface WorkflowProtectedWorktree {
  runId: string;
  agentIndex: number;
  state: "active" | "preserved" | "orphaned";
  branch: string;
  worktreePath: string;
  patchArtifact?: string;
  /** Bounded finalization error for an orphaned checkout. */
  error?: string;
  /** True when only the on-disk checkout exists — the run ended before finalization recorded anything. */
  unrecorded: boolean;
  /** Best-effort Git facts; omitted when `cwd` is not supplied or no longer identifies a repository. */
  git?: WorkflowWorktreeGitFacts;
}

export interface WorkflowRunRetentionRecord {
  runId: string;
  artifactDir: string;
  sessionId: string;
  status: WorkflowStatus;
  updatedAt: number;
  worktrees: WorkflowProtectedWorktree[];
  /** False when `workflow.json` could not be read or parsed; such a run is never reclaimed. */
  readable: boolean;
  /** A worktree directory scan or summary read failed. Such a run is never reclaimed. */
  scanError?: string;
}

export interface WorkflowRetentionOptions {
  /** Newest runs, by `updatedAt`, that retention will never remove. */
  maxRuns?: number;
  staleAfterMs?: number;
  now?: number;
  /** Runs that must never be reclaimed regardless of age or position, e.g. every run held in memory. */
  protectRunIds?: Iterable<string>;
}

export interface WorkflowRetentionReport {
  scanned: number;
  removed: string[];
  retained: number;
  failed: Array<{ runId: string; error: string }>;
}

async function protectedWorktreesForRun(
  runId: string,
  snapshot: WorkflowSnapshot | undefined,
  artifactDir: string,
): Promise<WorkflowProtectedWorktree[]> {
  const results: WorkflowProtectedWorktree[] = [];
  const recorded = new Set<number>();
  for (const agent of snapshot?.agents ?? []) {
    const isolation = agent.isolation;
    if (!isolation) continue;
    if (isolation.state === "removed") continue;
    if (isolation.state !== "preserved" && isolation.state !== "orphaned") {
      throw new Error(`Workflow agent ${agent.index} has an unknown worktree state`);
    }
    if (!Number.isSafeInteger(agent.index) || agent.index < 0 || agent.index >= 32) {
      throw new Error(`Workflow agent has an invalid worktree index: ${agent.index}`);
    }
    if (recorded.has(agent.index)) throw new Error(`Workflow has duplicate protected worktree index: ${agent.index}`);
    recorded.add(agent.index);
    results.push({
      runId,
      agentIndex: agent.index,
      state: isolation.state,
      branch: isolation.branch,
      worktreePath: workflowWorktreePath(artifactDir, agent.index),
      patchArtifact: isolation.patchArtifact,
      error: isolation.error,
      unrecorded: false,
    });
  }
  let entries;
  const worktreesDirectory = workflowWorktreeDirectory(artifactDir);
  try {
    const directoryInfo = await lstat(worktreesDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(`Workflow worktrees path is not a private directory: ${worktreesDirectory}`);
    }
    entries = await readdir(worktreesDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return results;
    throw error;
  }
  const active = snapshot?.status === "running" || snapshot?.status === "paused";
  for (const entry of entries) {
    const match = AGENT_DIRECTORY_PATTERN.exec(entry.name);
    if (!match) throw new Error(`Unrecognized entry under workflow worktrees directory: ${entry.name}`);
    if (!entry.isDirectory()) throw new Error(`Workflow worktree entry is not a directory: ${entry.name}`);
    const agentIndex = Number(match[1]);
    if (!Number.isSafeInteger(agentIndex) || agentIndex < 0 || agentIndex >= 32 || `agent-${agentIndex}` !== entry.name) {
      throw new Error(`Ambiguous workflow worktree directory entry: ${entry.name}`);
    }
    if (recorded.has(agentIndex)) continue;
    results.push({
      runId,
      agentIndex,
      state: active ? "active" : "orphaned",
      branch: workflowWorktreeBranch(runId, agentIndex),
      worktreePath: workflowWorktreePath(artifactDir, agentIndex),
      error: active ? undefined : "the run ended before its worktree was finalized",
      unrecorded: true,
    });
  }
  return results;
}

/** Scans the artifact root and merges recorded plus unrecorded worktree state
 * per run. Unrecorded paths in active checkpoints stay `active`; terminal
 * checkpoints classify them as crash-orphaned. Reads only `workflow.json`. */
export async function listWorkflowRunRetentionRecords(root: string): Promise<WorkflowRunRetentionRecord[]> {
  const normalizedRoot = resolve(root);
  const runIds = await listWorkflowRunIds(normalizedRoot);
  const records: WorkflowRunRetentionRecord[] = [];
  for (const runId of runIds) {
    const artifactDir = workflowRunDirectory(normalizedRoot, runId);
    const snapshot = await readWorkflowRunSummary(normalizedRoot, runId);
    let worktrees: WorkflowProtectedWorktree[] = [];
    let scanError: string | undefined;
    try {
      worktrees = await protectedWorktreesForRun(runId, snapshot, artifactDir);
    } catch (error) {
      scanError = `Could not inspect workflow worktrees: ${errorMessage(error)}`;
    }
    if (!snapshot) scanError = scanError ? `${scanError}; workflow summary is unreadable` : "Workflow summary is unreadable";
    records.push({
      runId,
      artifactDir,
      sessionId: snapshot?.sessionId ?? "",
      status: snapshot?.status ?? "running",
      updatedAt: snapshot?.timestamps.updatedAt ?? 0,
      worktrees,
      readable: snapshot !== undefined,
      scanError,
    });
  }
  return records;
}

/**
 * Pure retention decision: which run directories may be removed. Fails
 * closed — an unreadable run, a scan failure, a protected run, a run inside
 * the retained window, an active (non-stale) run, or a run carrying any
 * active, preserved, or orphaned worktree is always kept.
 */
export function planWorkflowRetention(
  records: WorkflowRunRetentionRecord[],
  options: WorkflowRetentionOptions = {},
): { remove: string[]; keep: string[] } {
  const maxRuns = Math.max(0, options.maxRuns ?? DEFAULT_WORKFLOW_RETAINED_RUNS);
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const now = options.now ?? Date.now();
  const protectRunIds = new Set(options.protectRunIds ?? []);

  const ranked = [...records].sort((left, right) => right.updatedAt - left.updatedAt);
  const withinWindow = new Set(ranked.slice(0, maxRuns).map((record) => record.runId));

  const remove: string[] = [];
  const keep: string[] = [];
  for (const record of records) {
    if (!record.readable || record.scanError || protectRunIds.has(record.runId) || withinWindow.has(record.runId) || record.worktrees.length > 0) {
      keep.push(record.runId);
      continue;
    }
    const active = record.status === "running" || record.status === "paused";
    // staleAfterMs=0 mirrors abortStaleWorkflow's no-resume mode: any active
    // checkpoint is treated as stale rather than immortal.
    const stale = active && (staleAfterMs === 0 || now - record.updatedAt > staleAfterMs);
    if (!isTerminal(record.status) && !stale) {
      keep.push(record.runId);
      continue;
    }
    remove.push(record.runId);
  }
  return { remove, keep };
}

/** Applies the retention plan to disk. Never throws for one bad run; failures
 * are collected in the report so a retention pass cannot fail workflow start. */
export async function applyWorkflowRetention(
  root: string,
  options: WorkflowRetentionOptions = {},
): Promise<WorkflowRetentionReport> {
  const normalizedRoot = resolve(root);
  try {
    return await withWorkflowRetentionLock(normalizedRoot, async () => {
      let records: WorkflowRunRetentionRecord[];
      try {
        records = await listWorkflowRunRetentionRecords(normalizedRoot);
      } catch (error) {
        return { scanned: 0, removed: [], retained: 0, failed: [{ runId: "<artifact-root>", error: errorMessage(error) }] };
      }
      const failed: Array<{ runId: string; error: string }> = records
        .filter((record) => record.scanError)
        .map((record) => ({ runId: record.runId, error: record.scanError! }));
      let leasedRunIds: Set<string>;
      try {
        leasedRunIds = await activeLeaseRunIds(normalizedRoot);
      } catch (error) {
        return {
          scanned: records.length,
          removed: [],
          retained: records.length,
          failed: [...failed, { runId: "<session-leases>", error: errorMessage(error) }],
        };
      }
      const protectedRunIds = new Set(options.protectRunIds ?? []);
      for (const runId of leasedRunIds) protectedRunIds.add(runId);
      const { remove } = planWorkflowRetention(records, { ...options, protectRunIds: protectedRunIds });
      const removed: string[] = [];
      for (const runId of remove) {
        try {
          await removeWorkflowRun(normalizedRoot, runId);
          removed.push(runId);
        } catch (error) {
          failed.push({ runId, error: errorMessage(error) });
        }
      }
      return { scanned: records.length, removed, retained: records.length - removed.length, failed };
    });
  } catch (error) {
    return { scanned: 0, removed: [], retained: 0, failed: [{ runId: "<retention>", error: errorMessage(error) }] };
  }
}

/** Enumerates every active, preserved, or orphaned worktree across the artifact
 * root, for operator inventory and reclamation. */
export async function listWorkflowProtectedWorktrees(
  root: string,
  options: { cwd?: string } = {},
): Promise<WorkflowProtectedWorktree[]> {
  const records = await listWorkflowRunRetentionRecords(resolve(root));
  const scanErrors = records.filter((record) => record.scanError).map((record) => `${record.runId}: ${record.scanError}`);
  if (scanErrors.length) throw new Error(`Could not inspect protected worktrees: ${scanErrors.join("; ")}`);
  const worktrees = records.flatMap((record) => record.worktrees);
  if (!options.cwd) return worktrees;
  const cwd = options.cwd;
  return Promise.all(worktrees.map(async (worktree) => ({
    ...worktree,
    git: await inspectWorkflowWorktree({ cwd, path: worktree.worktreePath, branch: worktree.branch }),
  })));
}

/** Same as {@link listWorkflowProtectedWorktrees}, scoped to one run so a
 * single reclamation does not require scanning the whole artifact root. */
export async function listWorkflowRunProtectedWorktrees(
  root: string,
  runId: string,
  options: { cwd?: string } = {},
): Promise<WorkflowProtectedWorktree[]> {
  const normalizedRoot = resolve(root);
  const artifactDir = workflowRunDirectory(normalizedRoot, runId);
  const snapshot = await readWorkflowRunSummary(normalizedRoot, runId);
  const worktrees = await protectedWorktreesForRun(runId, snapshot, artifactDir);
  if (!options.cwd) return worktrees;
  const cwd = options.cwd;
  return Promise.all(worktrees.map(async (worktree) => ({
    ...worktree,
    git: await inspectWorkflowWorktree({ cwd, path: worktree.worktreePath, branch: worktree.branch }),
  })));
}
