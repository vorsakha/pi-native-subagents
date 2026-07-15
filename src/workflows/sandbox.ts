import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_SOURCE_BYTES = 256 * KIB;
const MAX_ARGS_BYTES = 128 * KIB;
const MAX_RESULT_BYTES = MIB;
const MAX_IPC_BYTES = 512 * KIB;
const MAX_AGENT_CALLS = 32;
const TERMINATION_GRACE_MS = 250;
const AGENT_DRAIN_GRACE_MS = 1_000;

export interface WorkflowAgentResult {
  ok: boolean;
  output: string;
  jobId?: string;
  error?: string;
  usage?: unknown;
  structured?: unknown;
}

export interface WorkflowSandboxOptions {
  source: string;
  args: unknown;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  onAgent(
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkflowAgentResult>;
  onPhase(title: string): void;
}

export interface WorkflowSandboxResult {
  meta?: unknown;
  result: unknown;
}

type ChildMessage =
  | { token: string; type: "agent"; id: number; prompt: string; options: Record<string, unknown> }
  | { token: string; type: "phase"; title: string }
  | { token: string; type: "result-start"; chunks: number; bytes: number }
  | { token: string; type: "result-chunk"; index: number; data: string }
  | { token: string; type: "result-end" }
  | { token: string; type: "error"; message: string };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function serializeArgs(args: unknown): string {
  try {
    const serialized = JSON.stringify(args);
    return serialized === undefined ? "null" : serialized;
  } catch (error) {
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

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Workflow sandbox timed out after ${timeoutMs} ms`);
  error.name = "TimeoutError";
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

function safeAgentFailure(error: unknown): WorkflowAgentResult {
  return { ok: false, output: "", error: errorMessage(error) };
}

export async function runWorkflowSandbox(options: WorkflowSandboxOptions): Promise<WorkflowSandboxResult> {
  if (typeof options.source !== "string") throw new TypeError("Workflow source must be a string");
  if (byteLength(options.source) > MAX_SOURCE_BYTES) {
    throw new RangeError("Workflow source exceeds the 256 KiB limit");
  }
  const argsJson = serializeArgs(options.args);
  if (byteLength(argsJson) > MAX_ARGS_BYTES) {
    throw new RangeError("Workflow args exceed the 128 KiB limit");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("Workflow timeoutMs must be a positive finite number");
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
      clearTimeout(timeout);
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
      const boundedDrain = Promise.race([
        Promise.allSettled([...agentTasks]).then(() => undefined),
        new Promise<void>((resolveDrain) => {
          const timer = setTimeout(resolveDrain, AGENT_DRAIN_GRACE_MS);
          timer.unref();
        }),
      ]);
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
    const timeout = setTimeout(() => fail(timeoutError(options.timeoutMs)), options.timeoutMs);
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
      if (message.type === "phase") {
        if (typeof message.title !== "string") return fail(new Error("Invalid phase message from workflow sandbox"));
        try { options.onPhase(message.title); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (message.type === "agent") {
        if (!Number.isSafeInteger(message.id) || typeof message.prompt !== "string" ||
            !message.options || typeof message.options !== "object" || Array.isArray(message.options)) {
          return fail(new Error("Invalid agent request from workflow sandbox"));
        }
        agentCalls++;
        if (agentCalls > MAX_AGENT_CALLS) {
          fail(new Error(`Workflow sandbox exceeded ${MAX_AGENT_CALLS} agent calls`));
          return;
        }
        const controller = new AbortController();
        agentControllers.set(message.id, controller);
        const task = Promise.resolve()
          .then(() => options.onAgent(message.prompt, message.options, controller.signal))
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

    const initialized = send({ type: "init", source: options.source, argsJson });
    if (!initialized) fail(new Error("Unable to initialize workflow sandbox within the 512 KiB IPC limit"));
  });
}
