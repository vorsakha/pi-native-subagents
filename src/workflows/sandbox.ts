import { isWorkflowConvergence, MAX_CONVERGENCE_ROUNDS } from "./convergence.ts";
import type { WorkflowConvergence } from "./types.ts";
import { openWorkflowRuntime } from "./runtime.ts";
import { workflowCode } from "./source.ts";

const KIB = 1024;
const MAX_SOURCE_BYTES = 512 * KIB;
export const MAX_WORKFLOW_ARGS_BYTES = 256 * KIB;
const MAX_AGENT_CALLS = 32;

export interface WorkflowAgentResult {
  ok: boolean;
  output: string;
  jobId?: string;
  error?: string;
  usage?: unknown;
  structured?: unknown;
  /**
   * Machine-readable marker that a workflow budget refused this call, so a
   * bounded convergence loop can report `limit-reached` instead of guessing
   * from failure prose.
   */
  limit?: "budget";
}

/** Bounded convergence progress reported by the sandbox `converge()` helper. */
export type WorkflowConvergenceProgress = WorkflowConvergence;

export interface WorkflowPhaseCapacity {
  ok: boolean;
  reason?: string;
}

export interface WorkflowSandboxOptions {
  source: string;
  /** Private per-run database. Omit only for ephemeral sandbox callers. */
  database?: string;
  args: unknown;
  cwd: string;
  signal: AbortSignal;
  /** Manager-configured call ceiling, capped by the sandbox's hard 32-call limit. */
  maxAgentCalls?: number;
  onAgent(
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
    callIndex: number,
  ): Promise<WorkflowAgentResult>;
  /** Continues a retained workflow-owned job instead of starting a fresh one. */
  onFollowUp(
    jobId: string,
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
    callIndex: number,
  ): Promise<WorkflowAgentResult>;
  onMeta(meta: unknown): void;
  onPhase(title: string): void;
  /** Checks proposed phase titles against the manager's authoritative run state. */
  onPhaseCapacity(titles: string[]): WorkflowPhaseCapacity;
  onLog(message: string): void;
  onConvergence(progress: WorkflowConvergenceProgress): void;
}

export interface WorkflowSandboxResult {
  meta?: unknown;
  result: unknown;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function serializeWorkflowArgs(args: unknown): string {
  try {
    const serialized = JSON.stringify(args);
    const normalized = serialized === undefined ? "null" : serialized;
    if (byteLength(normalized) > MAX_WORKFLOW_ARGS_BYTES) {
      throw new RangeError("Workflow args exceed the 256 KiB limit");
    }
    return normalized;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new TypeError(`Workflow args must be JSON-serializable: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("Workflow sandbox aborted");
  error.name = "AbortError";
  return error;
}

const CONVERGENCE_STATES: ReadonlySet<string> = new Set(["running", "approved", "blocked", "limit-reached", "stalled", "failed"]);
const CONVERGENCE_VERDICTS: ReadonlySet<string> = new Set(["approve", "request_changes", "blocked"]);
function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/**
 * The child is untrusted: a convergence progress frame is only forwarded when
 * every required field is present, correctly typed, and inside its own bound.
 * Anything else is a protocol violation rather than partially rendered state;
 * optional free text is truncated rather than rejecting the whole frame.
 */
function normalizeConvergenceProgress(value: unknown): WorkflowConvergenceProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const integer = (item: unknown, min: number, max: number): number | undefined =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= min && item <= max ? item : undefined;
  const round = integer(raw.round, 0, MAX_CONVERGENCE_ROUNDS);
  const maxRounds = integer(raw.maxRounds, 1, MAX_CONVERGENCE_ROUNDS);
  const state = typeof raw.state === "string" && CONVERGENCE_STATES.has(raw.state) ? raw.state : undefined;
  if (round === undefined || maxRounds === undefined || state === undefined || !Array.isArray(raw.rounds)) return undefined;
  if (raw.rounds.length > MAX_CONVERGENCE_ROUNDS) return undefined;
  const rounds: WorkflowConvergenceProgress["rounds"] = [];
  for (const item of raw.rounds) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;
    const index = integer(entry.round, 1, MAX_CONVERGENCE_ROUNDS);
    const actionableCount = integer(entry.actionableCount, 0, 1_000);
    const fingerprint = boundedString(entry.fingerprint, 64);
    if (index === undefined || actionableCount === undefined || fingerprint === undefined) return undefined;
    if (typeof entry.verdict !== "string" || !CONVERGENCE_VERDICTS.has(entry.verdict)) return undefined;
    rounds.push({ round: index, verdict: entry.verdict as WorkflowConvergenceProgress["rounds"][number]["verdict"], actionableCount, fingerprint });
  }
  const optional = (item: unknown, max: number): string | undefined =>
    typeof item === "string" ? item.slice(0, max) : undefined;
  if ([raw.name, raw.stoppingReason, raw.fingerprint, raw.pendingFindings, raw.implementerJobId, raw.reviewerJobId]
    .some((item) => item !== undefined && typeof item !== "string")) return undefined;
  if (raw.verdict !== undefined && (typeof raw.verdict !== "string" || !CONVERGENCE_VERDICTS.has(raw.verdict))) return undefined;
  if (raw.actionableCount !== undefined && integer(raw.actionableCount, 0, 1_000) === undefined) return undefined;
  const progress: WorkflowConvergenceProgress = {
    name: optional(raw.name, 200),
    round,
    maxRounds,
    state: state as WorkflowConvergenceProgress["state"],
    verdict: raw.verdict as WorkflowConvergenceProgress["verdict"] | undefined,
    actionableCount: raw.actionableCount as number | undefined,
    fingerprint: optional(raw.fingerprint, 64),
    pendingFindings: optional(raw.pendingFindings, 8_192),
    stoppingReason: optional(raw.stoppingReason, 2_000),
    implementerJobId: optional(raw.implementerJobId, 200),
    reviewerJobId: optional(raw.reviewerJobId, 200),
    rounds,
  };
  return isWorkflowConvergence(progress) ? progress : undefined;
}


export async function runWorkflowSandbox(options: WorkflowSandboxOptions): Promise<WorkflowSandboxResult> {
  if (typeof options.source !== "string") throw new TypeError("Workflow source must be a string");
  if (byteLength(options.source) > MAX_SOURCE_BYTES) throw new RangeError("Workflow source exceeds the 512 KiB limit");
  const argsJson = serializeWorkflowArgs(options.args);
  const maxAgentCalls = options.maxAgentCalls ?? MAX_AGENT_CALLS;
  if (!Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 1 || maxAgentCalls > MAX_AGENT_CALLS) {
    throw new RangeError(`Workflow maxAgentCalls must be an integer from 1 to ${MAX_AGENT_CALLS}`);
  }
  if (options.signal.aborted) throw abortError();
  const runtime = await openWorkflowRuntime(options, normalizeConvergenceProgress);
  try {
    return await runtime.run(workflowCode(options.source, argsJson, maxAgentCalls));
  } finally {
    await runtime.close();
  }
}
