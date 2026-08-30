import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isWorkflowConvergence, MAX_CONVERGENCE_ROUNDS } from "./convergence.ts";
import type { WorkflowConvergence } from "./types.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_SOURCE_BYTES = 512 * KIB;
export const MAX_WORKFLOW_ARGS_BYTES = 256 * KIB;
const MAX_RESULT_BYTES = MIB;
const MAX_IPC_BYTES = 512 * KIB;
const MAX_AGENT_CALLS = 32;
const MAX_PHASE_CAPACITY_REQUESTS = 64;
const MAX_PHASE_CAPACITY_TITLES = 2;
const TERMINATION_GRACE_MS = 250;
const AGENT_DRAIN_GRACE_MS = 1_000;

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

type ChildMessage =
  | { token: string; type: "agent"; id: number; prompt: string; options: Record<string, unknown> }
  | { token: string; type: "followUp"; id: number; jobId: string; prompt: string; options: Record<string, unknown> }
  | { token: string; type: "meta"; meta: unknown }
  | { token: string; type: "phase"; title: string }
  | { token: string; type: "phase-capacity"; id: number; titles: string[] }
  | { token: string; type: "log"; message: string }
  | { token: string; type: "convergence"; progress: unknown }
  | { token: string; type: "result-start"; chunks: number; bytes: number }
  | { token: string; type: "result-chunk"; index: number; data: string }
  | { token: string; type: "result-end" }
  | { token: string; type: "error"; message: string };

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

function frameSize(message: unknown): number {
  try { return byteLength(JSON.stringify(message)); }
  catch { return MAX_IPC_BYTES + 1; }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* process has already exited */ }
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(forceTimer);
      clearTimeout(watchdog);
      resolve();
    };
    child.once("close", finish);
    signalProcessTree(child, "SIGTERM");
    const forceTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
    const watchdog = setTimeout(finish, TERMINATION_GRACE_MS * 2);
  });
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

function safeAgentFailure(error: unknown): WorkflowAgentResult {
  return { ok: false, output: "", error: errorMessage(error) };
}

export async function runWorkflowSandbox(options: WorkflowSandboxOptions): Promise<WorkflowSandboxResult> {
  if (typeof options.source !== "string") throw new TypeError("Workflow source must be a string");
  if (byteLength(options.source) > MAX_SOURCE_BYTES) {
    throw new RangeError("Workflow source exceeds the 512 KiB limit");
  }
  const argsJson = serializeWorkflowArgs(options.args);
  const maxAgentCalls = options.maxAgentCalls ?? MAX_AGENT_CALLS;
  if (!Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 1 || maxAgentCalls > MAX_AGENT_CALLS) {
    throw new RangeError(`Workflow maxAgentCalls must be an integer from 1 to ${MAX_AGENT_CALLS}`);
  }
  if (options.signal.aborted) throw abortError();

  const bootstrap = fileURLToPath(new URL("./sandbox-child.cjs", import.meta.url));
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [
    "--permission",
    `--allow-fs-read=${bootstrap}`,
    "--experimental-vm-modules",
    "--max-old-space-size=128",
    bootstrap,
    token,
  ], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: {},
    shell: false,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  return new Promise<WorkflowSandboxResult>((resolve, reject) => {
    let settled = false;
    let agentCalls = 0;
    let resultChunks: string[] | undefined;
    let resultBytes = 0;
    const agentControllers = new Map<number, AbortController>();
    const agentTasks = new Set<Promise<unknown>>();
    let stderr = "";

    const clear = () => {
      options.signal.removeEventListener("abort", onAbort);
      child.removeListener("message", onMessage);
      child.removeListener("error", onChildError);
      child.removeListener("close", onClose);
    };
    const abortAgents = () => {
      for (const controller of agentControllers.values()) controller.abort();
      agentControllers.clear();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clear();
      abortAgents();
      const boundedDrain = new Promise<void>((resolveDrain) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolveDrain();
        };
        // Keep this timer referenced until either every agent task settles or
        // the bounded drain expires. An unref() here lets Node exit while the
        // parent workflow promise is still waiting to reject.
        const timer = setTimeout(finish, AGENT_DRAIN_GRACE_MS);
        void Promise.allSettled([...agentTasks]).then(finish, finish);
      });
      void Promise.allSettled([terminate(child), boundedDrain]).then(() => reject(error), () => reject(error));
    };
    const succeed = (value: WorkflowSandboxResult) => {
      if (settled) return;
      settled = true;
      clear();
      abortAgents();
      resolve(value);
    };
    const send = (message: Record<string, unknown>): boolean => {
      const authenticated = { token, ...message };
      if (frameSize(authenticated) > MAX_IPC_BYTES) return false;
      if (!child.connected) return false;
      try { return child.send(authenticated); }
      catch { return false; }
    };
    const onAbort = () => fail(abortError());
    const onChildError = (error: Error) => fail(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      fail(new Error(`Workflow sandbox exited before returning a result (code ${String(code)}, signal ${String(signal)})${suffix}`));
    };

    const onMessage = (raw: unknown) => {
      if (settled || frameSize(raw) > MAX_IPC_BYTES || !raw || typeof raw !== "object") return;
      const message = raw as ChildMessage;
      if (message.token !== token) return;
      if (message.type === "meta") {
        try { options.onMeta(message.meta); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (message.type === "phase") {
        if (typeof message.title !== "string") return fail(new Error("Invalid phase message from workflow sandbox"));
        try { options.onPhase(message.title); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (message.type === "phase-capacity") {
        if (!Number.isSafeInteger(message.id) || message.id < 1 || message.id > MAX_PHASE_CAPACITY_REQUESTS ||
            !Array.isArray(message.titles) || message.titles.length < 1 ||
            message.titles.length > MAX_PHASE_CAPACITY_TITLES ||
            !message.titles.every((title) => typeof title === "string")) {
          return fail(new Error("Invalid phase capacity request from workflow sandbox"));
        }
        let result: WorkflowPhaseCapacity;
        try { result = options.onPhaseCapacity(message.titles); }
        catch (error) { return fail(error instanceof Error ? error : new Error(String(error))); }
        if (typeof result.ok !== "boolean" || (result.reason !== undefined && typeof result.reason !== "string")) {
          return fail(new Error("Invalid phase capacity response from workflow host"));
        }
        if (!send({ type: "phase-capacity-result", id: message.id, result })) {
          fail(new Error("Unable to return workflow phase capacity"));
        }
        return;
      }
      if (message.type === "log") {
        if (typeof message.message !== "string") return fail(new Error("Invalid log message from workflow sandbox"));
        try { options.onLog(message.message); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (message.type === "convergence") {
        const progress = normalizeConvergenceProgress(message.progress);
        if (!progress) return fail(new Error("Invalid convergence message from workflow sandbox"));
        try { options.onConvergence(progress); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (message.type === "agent" || message.type === "followUp") {
        if (!Number.isSafeInteger(message.id) || typeof message.prompt !== "string" ||
            !message.options || typeof message.options !== "object" || Array.isArray(message.options)) {
          return fail(new Error("Invalid agent request from workflow sandbox"));
        }
        if (message.type === "followUp" && (typeof message.jobId !== "string" || !message.jobId.trim() || message.jobId.length > 200)) {
          return fail(new Error("Invalid follow-up request from workflow sandbox"));
        }
        if (message.id !== agentCalls + 1) return fail(new Error("Workflow sandbox agent call IDs are not contiguous"));
        agentCalls++;
        if (agentCalls > MAX_AGENT_CALLS) {
          fail(new Error(`Workflow sandbox exceeded ${MAX_AGENT_CALLS} agent calls`));
          return;
        }
        const controller = new AbortController();
        agentControllers.set(message.id, controller);
        const dispatch = message.type === "followUp"
          ? () => options.onFollowUp(message.jobId, message.prompt, message.options, controller.signal, message.id - 1)
          : () => options.onAgent(message.prompt, message.options, controller.signal, message.id - 1);
        const task = Promise.resolve()
          .then(dispatch)
          .catch(safeAgentFailure)
          .then((result) => {
            agentControllers.delete(message.id);
            if (settled) return;
            let normalized: WorkflowAgentResult;
            try {
              const json = JSON.stringify(result);
              if (json === undefined) throw new TypeError("Agent returned undefined");
              normalized = JSON.parse(json) as WorkflowAgentResult;
            } catch (error) {
              normalized = safeAgentFailure(`Agent result is not JSON-serializable: ${errorMessage(error)}`);
            }
            if (!send({ type: "agent-result", id: message.id, result: normalized })) {
              send({
                type: "agent-result",
                id: message.id,
                result: safeAgentFailure("Agent result exceeds the 512 KiB IPC limit"),
              });
            }
          });
        agentTasks.add(task);
        void task.finally(() => agentTasks.delete(task));
        return;
      }
      if (message.type === "result-start") {
        if (!Number.isSafeInteger(message.chunks) || message.chunks < 1 || message.chunks > 8 ||
            !Number.isSafeInteger(message.bytes) || message.bytes < 0 || message.bytes > MAX_RESULT_BYTES) {
          return fail(new Error("Invalid or oversized result from workflow sandbox"));
        }
        resultChunks = new Array<string>(message.chunks);
        resultBytes = message.bytes;
        return;
      }
      if (message.type === "result-chunk") {
        if (!resultChunks || !Number.isSafeInteger(message.index) || message.index < 0 ||
            message.index >= resultChunks.length || typeof message.data !== "string" ||
            resultChunks[message.index] !== undefined) {
          return fail(new Error("Invalid result chunk from workflow sandbox"));
        }
        resultChunks[message.index] = message.data;
        return;
      }
      if (message.type === "result-end") {
        if (!resultChunks || resultChunks.some((chunk) => typeof chunk !== "string")) {
          return fail(new Error("Incomplete result from workflow sandbox"));
        }
        try {
          const buffer = Buffer.concat(resultChunks.map((chunk) => Buffer.from(chunk, "base64")));
          if (buffer.byteLength !== resultBytes || buffer.byteLength > MAX_RESULT_BYTES) {
            throw new Error("Workflow result exceeds the 1 MiB limit");
          }
          const wire = JSON.parse(buffer.toString("utf8")) as {
            hasMeta: boolean;
            metaUndefined?: boolean;
            resultUndefined?: boolean;
            meta?: unknown;
            result?: unknown;
          };
          const value: WorkflowSandboxResult = {
            result: wire.resultUndefined ? undefined : wire.result,
          };
          if (wire.hasMeta) value.meta = wire.metaUndefined ? undefined : wire.meta;
          succeed(value);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (message.type === "error") {
        fail(new Error(typeof message.message === "string" ? message.message : "Workflow sandbox failed"));
      }
    };

    options.signal.addEventListener("abort", onAbort, { once: true });
    child.on("message", onMessage);
    child.once("error", onChildError);
    child.once("close", onClose);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 64 * KIB) stderr += chunk.toString().slice(0, 64 * KIB - stderr.length);
    });

    // Source and args are individually bounded above. The combined init frame may
    // legitimately exceed the ordinary 512 KiB agent-message limit. A false
    // child.send() return only signals backpressure, so completion is callback-based.
    try {
      if (!child.connected) fail(new Error("Unable to initialize workflow sandbox"));
      else child.send({ token, type: "init", source: options.source, argsJson, maxAgentCalls }, (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
