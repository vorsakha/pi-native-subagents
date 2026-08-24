import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActivityWatchdog } from "../activity-watchdog.ts";
import type { DiscoveredCapability, CapabilitySourceStatus } from "../capabilities.ts";
import { sanitizeSubscriptionEnv } from "../env.ts";
import { JsonlFramer, parseJsonRecord } from "../framing.ts";
import { spawnManaged } from "../process-tree.ts";
import { boundedAppend } from "../reducer.ts";
import { PI_PARENT_THREAD_FILE } from "../parent-thread-context.ts";
import type {
  Backend,
  BackendEvent,
  BackendPolicy,
  BackendRequest,
  BackendRun,
  DiscoveryRequest,
  DiscoveryResult,
  SendBehavior,
  ToolResultSnapshot,
} from "../types.ts";

/** Marks a Pi child so this package registers nothing inside it. */
export const PI_CHILD_MARKER = "PI_NATIVE_SUBAGENTS_CHILD";
const CHILD_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/parent-thread/index.ts", import.meta.url));

/** Parent-session inventory injected by the extension; discovery never imports Pi's runtime. */
export interface PiParentInventory {
  tools?: Array<{ name: string; description?: string; source?: string }>;
  commands?: Array<{ name: string; description?: string; source?: string }>;
}

interface PiBackendOptions {
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  /** Live parent tool/command inventory, e.g. `pi.getAllTools()` and `pi.getCommands()`. */
  parentInventory?: () => PiParentInventory;
}

/**
 * Native customization parity: a full-access child loads the user's skills,
 * prompt templates, and extensions, while a read-only child keeps extensions off
 * so its sandbox stays deny-by-construction. Isolated children keep the original
 * fully stripped launch.
 */
export function piResourceArgs(policy: Pick<BackendPolicy, "customization" | "access">): string[] {
  if (policy.customization !== "native") return ["--no-skills", "--no-prompt-templates", "--no-extensions"];
  return policy.access === "readOnly" ? ["--no-extensions"] : [];
}

/** Pi children inherit the parent provider environment plus a recursion marker. */
export function piChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...sanitizeSubscriptionEnv(env, "pi"), [PI_CHILD_MARKER]: "1" };
}

interface PendingCommand {
  command: string;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PiModelRecord {
  provider: string;
  id: string;
}

interface PiChildInventory {
  commands: Array<{ name: string; description?: string; source?: string }>;
  commandError?: string;
  selectedModel?: PiModelRecord;
  availableModels: PiModelRecord[];
}

export class PiRpcBackend implements Backend {
  readonly name = "pi" as const;
  readonly #command: string;
  readonly #requestTimeoutMs: number;
  readonly #inactivityTimeoutMs: number;
  readonly #parentInventory?: () => PiParentInventory;

  constructor(command = "pi", options: PiBackendOptions = {}) {
    this.#command = command;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15 * 60_000;
    this.#parentInventory = options.parentInventory;
  }

  /**
   * Zero-model-turn inventory: the parent's live tool/command list plus the
   * child's own `get_commands` reply, which reflects the resources a real child
   * launch would load under the same policy.
   */
  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const capabilities: DiscoveredCapability[] = [];
    const sources: CapabilitySourceStatus[] = [];
    const warnings: string[] = [];

    if (this.#parentInventory) {
      try {
        const inventory = this.#parentInventory();
        for (const tool of inventory.tools ?? []) {
          const nativeBuiltin = tool.source === "builtin" || tool.source === "sdk";
          capabilities.push({
            kind: "tool",
            name: tool.name,
            description: tool.description,
            origin: tool.source ?? "parent",
            // Read-only Pi children keep extensions disabled because extension
            // hooks are outside the core tool sandbox. Report extension tools
            // honestly as unavailable instead of routing to a surface that will
            // not be loaded.
            effect: request.access === "readOnly" && !nativeBuiltin ? "unknown" : undefined,
          });
        }
        for (const command of inventory.commands ?? []) {
          capabilities.push({
            kind: command.source === "skill" ? "skill" : "command",
            name: command.name,
            description: command.description,
            origin: command.source ?? "parent",
          });
        }
        sources.push({ source: "pi-parent", health: "healthy" });
      } catch (error) {
        sources.push({ source: "pi-parent", health: "unknown", detail: message(error) });
        warnings.push(`Pi parent inventory unavailable: ${message(error)}`);
      }
    } else {
      sources.push({ source: "pi-parent", health: "unknown", detail: "no live parent tool inventory was provided" });
      warnings.push("Pi parent tool inventory is unavailable; the catalog may omit extension tools");
    }

    try {
      const inventory = await this.#childInventory(request);
      for (const command of inventory.commands) {
        capabilities.push({
          kind: command.source === "skill" ? "skill" : "command",
          name: command.name,
          description: command.description,
          origin: command.source ? `child:${command.source}` : "child",
        });
      }
      if (inventory.commandError) {
        sources.push({ source: "pi-child", health: "unknown", detail: inventory.commandError });
        warnings.push(`Pi child command inventory unavailable: ${inventory.commandError}`);
      } else {
        sources.push({ source: "pi-child", health: "healthy" });
      }
      const selected = inventory.selectedModel;
      const ready = selected && inventory.availableModels.some((model) => model.provider === selected.provider && model.id === selected.id);
      if (ready) {
        sources.push({ source: "pi-model", health: "healthy", detail: `${selected.provider}/${selected.id}` });
      } else {
        const detail = selected
          ? `selected model ${selected.provider}/${selected.id} is not available with current credentials`
          : "Pi has no selected authenticated model";
        sources.push({ source: "pi-model", health: "unavailable", detail });
        warnings.unshift(`Pi model unavailable: ${detail}`);
      }
    } catch (error) {
      sources.push({ source: "pi-child", health: "unavailable", detail: message(error) });
      warnings.unshift(`Pi child readiness probe unavailable: ${message(error)}`);
    }
    return { capabilities, sources, warnings };
  }

  async #childInventory(request: DiscoveryRequest): Promise<PiChildInventory> {
    request.signal.throwIfAborted();
    const args = [
      "--mode", "rpc", "--approve",
      ...piResourceArgs({ customization: request.customization, access: request.access }),
      "--name", "subagent-capability-probe",
      "--no-tools",
    ];
    if (request.model) args.push("--model", request.model);
    const managed = spawnManaged(this.#command, args, { cwd: request.cwd, env: piChildEnv(request.env) });
    const framer = new JsonlFramer();
    try {
      return await new Promise<PiChildInventory>((resolveInventory, reject) => {
        const ids = {
          state: "capability-probe-state",
          models: "capability-probe-models",
          commands: "capability-probe-commands",
        } as const;
        const knownIds = new Set<string>(Object.values(ids));
        let stateReceived = false;
        let selectedModel: PiModelRecord | undefined;
        let availableModels: PiModelRecord[] | undefined;
        let commands: PiChildInventory["commands"] | undefined;
        let commandError: string | undefined;
        let settled = false;
        const model = (value: unknown): PiModelRecord | undefined => {
          const record = asObject(value);
          return typeof record.provider === "string" && record.provider && typeof record.id === "string" && record.id
            ? { provider: record.provider, id: record.id }
            : undefined;
        };
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onAbort = () => settle(() => reject(request.signal.reason ?? new Error("Pi capability discovery aborted")));
        const cleanup = () => {
          request.signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
        };
        const timer = setTimeout(() => settle(() => reject(new Error("Pi readiness probe timed out"))), this.#requestTimeoutMs);
        const maybeResolve = () => {
          if (!stateReceived || availableModels === undefined || commands === undefined) return;
          settle(() => resolveInventory({ selectedModel, availableModels: availableModels!, commands: commands!, commandError }));
        };
        const handle = (record: string) => {
          const event = parseJsonRecord(record);
          if (!event || event.type !== "response" || !knownIds.has(String(event.id))) return;
          if (event.success === false) {
            const detail = String(event.error ?? `Pi rejected ${event.command ?? "readiness probe"}`);
            if (event.id === ids.commands) {
              commandError = detail;
              commands = [];
              maybeResolve();
              return;
            }
            return settle(() => reject(new Error(detail)));
          }
          const data = asObject(event.data);
          if (event.id === ids.state) {
            stateReceived = true;
            selectedModel = model(data.model);
          }
          if (event.id === ids.models) availableModels = (Array.isArray(data.models) ? data.models : []).map(model).filter((item): item is PiModelRecord => !!item);
          if (event.id === ids.commands) commands = (Array.isArray(data.commands) ? data.commands : []).map((item) => {
            const command = asObject(item);
            return {
              name: String(command.name ?? ""),
              description: typeof command.description === "string" ? command.description : undefined,
              source: typeof command.source === "string" ? command.source : undefined,
            };
          }).filter((command) => command.name);
          maybeResolve();
        };
        managed.child.stdout.on("data", (chunk: Buffer) => {
          try { for (const record of framer.push(chunk)) handle(record); }
          catch (error) { settle(() => reject(error instanceof Error ? error : new Error(String(error)))); }
        });
        managed.child.on("error", (error) => settle(() => reject(error)));
        managed.child.on("close", (code, signal) => settle(() => reject(new Error(`Pi capability probe exited (${code ?? signal ?? "signal"})`))));
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          managed.child.stdin.write(`${JSON.stringify({ id: ids.state, type: "get_state" })}\n`);
          managed.child.stdin.write(`${JSON.stringify({ id: ids.models, type: "get_available_models" })}\n`);
          managed.child.stdin.write(`${JSON.stringify({ id: ids.commands, type: "get_commands" })}\n`);
        } catch (error) {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
    } finally {
      await managed.terminate(0).catch(() => undefined);
    }
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    request.signal.throwIfAborted();
    if (request.policy.structuredOutput) throw new Error("Pi does not support native structured results");
    const args = [
      "--mode", "rpc", "--approve",
      ...piResourceArgs(request.policy),
      "--name", `subagent-${request.name}-${request.jobId.slice(0, 8)}`,
    ];
    let parentThreadDir: string | undefined;
    let parentThreadCleaned = false;
    const cleanupParentThread = async () => {
      if (parentThreadCleaned || !parentThreadDir) return;
      parentThreadCleaned = true;
      await rm(parentThreadDir, { recursive: true, force: true });
    };
    let childEnv = piChildEnv(request.env);
    try {
      if (request.parentThread) {
        parentThreadDir = await mkdtemp(join(tmpdir(), "pi-parent-thread-"));
        const snapshotPath = join(parentThreadDir, "snapshot.json");
        await writeFile(snapshotPath, JSON.stringify(request.parentThread), { encoding: "utf8", mode: 0o600 });
        childEnv = { ...childEnv, [PI_PARENT_THREAD_FILE]: snapshotPath };
        args.push("--extension", CHILD_EXTENSION_PATH);
      }
    } catch (error) {
      await cleanupParentThread();
      throw error;
    }
    if (request.resumeSessionFile) args.push("--session", request.resumeSessionFile);
    if (request.policy.model) args.push("--model", request.policy.model);
    args.push(
      "--thinking", request.policy.thinking,
      "--append-system-prompt", request.systemPrompt,
    );
    if (request.policy.piTools.length > 0) args.push("--tools", request.policy.piTools.join(","));
    else args.push("--no-tools");

    let managed;
    try {
      request.signal.throwIfAborted();
      managed = spawnManaged(this.#command, args, { cwd: request.cwd, env: childEnv });
    } catch (error) {
      await cleanupParentThread();
      throw error;
    }
    const pending = new Map<string, PendingCommand>();
    let commandSequence = 0;
    let output = "";
    let stderr = "";
    let terminalProblem: Extract<BackendEvent, { type: "failed" | "cancelled" }> | undefined;
    let retryableAssistantProblem = false;
    let settled = false;
    let closed = false;
    let tearingDown = false;
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const watchdog = createActivityWatchdog(this.#inactivityTimeoutMs, () => {
      closed = true;
      tearingDown = true;
      finish({ type: "failed", error: `Pi RPC produced no activity for ${this.#inactivityTimeoutMs}ms` });
      void managed.terminate();
    });

    const rejectPending = (error: Error) => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    };
    const finish = (event: BackendEvent) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      emit(event);
      resolveCompleted();
    };
    const write = (value: Record<string, unknown>) => {
      if (closed || managed.child.stdin.destroyed || !managed.child.stdin.writable) throw new Error("Pi RPC process is closed");
      managed.child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const command = (type: string, fields: Record<string, unknown> = {}, timeoutMs = this.#requestTimeoutMs): Promise<void> => {
      if (closed) return Promise.reject(new Error("Pi RPC process is closed"));
      const id = `${request.jobId}:${++commandSequence}`;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Pi RPC command timed out: ${type}`));
        }, timeoutMs);
        pending.set(id, { command: type, resolve, reject, timer });
        try { write({ id, type, ...fields }); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    const framer = new JsonlFramer();
    const handle = (record: string) => {
      const event = parseJsonRecord(record);
      if (!event) {
        if (record.trim()) throw new Error("invalid JSON object");
        return;
      }
      watchdog.touch();
      if (event.type === "response" && typeof event.id === "string") {
        const item = pending.get(event.id);
        if (item) {
          pending.delete(event.id);
          clearTimeout(item.timer);
          if (event.success === false) item.reject(new Error(String(event.error ?? `Pi rejected ${item.command}`)));
          else item.resolve();
        }
        return;
      }
      if (event.type === "message_update") {
        const delta = asObject(event.assistantMessageEvent);
        if (delta.type === "text_delta") emit({ type: "text_delta", text: String(delta.delta ?? "") });
        else if (delta.type === "thinking_delta") emit({ type: "thinking_delta", text: String(delta.delta ?? "") });
        else if (delta.type === "error") {
          terminalProblem = assistantProblem(asObject(delta.error ?? delta.message ?? delta.partial), "Pi assistant stream failed");
          retryableAssistantProblem = terminalProblem.type === "failed";
        }
      } else if (event.type === "message_end") {
        const message = asObject(event.message);
        if (message.role === "assistant") {
          output = bound(textContent(message.content) || output);
          const thinking = thinkingContent(message.content);
          if (thinking) emit({ type: "thinking_message", text: thinking });
          if (output) emit({ type: "message", text: output });
          const stopReason = String(message.stopReason ?? "");
          if (stopReason === "error" || stopReason === "aborted") {
            terminalProblem = assistantProblem(message, stopReason === "aborted" ? "Pi assistant aborted" : "Pi assistant failed");
            retryableAssistantProblem = stopReason === "error";
          } else if (retryableAssistantProblem) {
            terminalProblem = undefined;
            retryableAssistantProblem = false;
          }
          const usage = asObject(message.usage);
          emit({ type: "usage", usage: {
            input: number(usage.input), output: number(usage.output), cacheRead: number(usage.cacheRead),
            cacheWrite: number(usage.cacheWrite), cost: number(asObject(usage.cost).total), turns: 1,
          } });
          // responseModel, when present, is the concrete model that served the request; message.model is only the requested/configured model and is never a substitute.
          const servingModel = typeof message.responseModel === "string" && message.responseModel ? message.responseModel : undefined;
          const contextTokens = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined;
          if (servingModel !== undefined || contextTokens !== undefined) {
            emit({ type: "context", context: {
              ...(servingModel !== undefined ? { servingModel } : {}),
              ...(contextTokens !== undefined ? { tokens: contextTokens } : {}),
            } });
          }
        } else if (message.role === "user") {
          const text = textContent(message.content);
          if (text) emit({ type: "user_message", text });
        }
      } else if (event.type === "tool_execution_start") {
        const args = asObject(event.args);
        emit({
          type: "tool_start",
          id: String(event.toolCallId ?? "tool"),
          name: String(event.toolName ?? "tool"),
          args,
          summary: summarize(args),
        });
      } else if (event.type === "tool_execution_end") {
        const result = toolResultSnapshot(event.result, event.isError === true);
        emit({
          type: "tool_end",
          id: String(event.toolCallId ?? "tool"),
          name: String(event.toolName ?? "tool"),
          result,
          output: resultPreview(event.result),
          error: result.isError,
        });
      } else if (event.type === "queue_update") {
        const steering = Array.isArray(event.steering) ? event.steering : [];
        const followUp = Array.isArray(event.followUp) ? event.followUp : [];
        emit({ type: "queue_changed", messages: [
          ...steering.map((text) => ({ text: String(text), behavior: "steer" as const })),
          ...followUp.map((text) => ({ text: String(text), behavior: "followUp" as const })),
        ] });
      } else if (event.type === "extension_ui_request" && typeof event.id === "string") {
        // Native extensions may ask the host user questions. Generic children
        // are unattended, so decline immediately instead of parking the RPC
        // process until the inactivity watchdog fires.
        write({ type: "extension_ui_response", id: event.id, cancelled: true });
      } else if (event.type === "extension_error") {
        terminalProblem = { type: "failed", error: `Pi extension error: ${errorText(event.error, String(event.extensionPath ?? "unknown extension"))}` };
        retryableAssistantProblem = false;
      } else if (event.type === "auto_retry_end") {
        if (event.success === false) {
          terminalProblem = { type: "failed", error: errorText(event.finalError, "Pi automatic retries exhausted") };
          retryableAssistantProblem = false;
        } else if (retryableAssistantProblem) {
          terminalProblem = undefined;
          retryableAssistantProblem = false;
        }
      } else if (event.type === "agent_settled") {
        finish(terminalProblem ?? { type: "completed", output });
      }
    };

    const receive = (lines: string[]) => { for (const line of lines) handle(line); };
    const framingFailure = (error: unknown) => {
      closed = true;
      const message = `Pi RPC framing failed: ${error instanceof Error ? error.message : String(error)}`;
      rejectPending(new Error(message));
      finish({ type: "failed", error: message });
      void managed.terminate();
    };
    managed.child.stdout.on("data", (chunk: Buffer) => { try { receive(framer.push(chunk)); } catch (error) { framingFailure(error); } });
    managed.child.stdout.on("end", () => { try { receive(framer.end()); } catch (error) { framingFailure(error); } });
    managed.child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    managed.child.stdin.on("error", (error) => {
      closed = true;
      rejectPending(new Error(`Pi RPC stdin failed: ${error.message}`));
      finish({ type: "failed", error: `Pi RPC stdin failed: ${error.message}` });
    });
    managed.child.on("error", (error) => {
      closed = true;
      rejectPending(error);
      finish({ type: "failed", error: `Pi RPC failed: ${error.message}` });
    });
    managed.child.on("close", (code, signal) => {
      closed = true;
      void cleanupParentThread();
      const detail = `Pi RPC exited (${code ?? signal ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
      rejectPending(new Error(detail));
      if (!settled && !tearingDown) finish({ type: "failed", error: detail });
    });

    let startupAbortTeardown: Promise<void> | undefined;
    const abortStartup = () => {
      tearingDown = true;
      watchdog.clear();
      startupAbortTeardown ??= managed.terminate(0);
    };
    request.signal.addEventListener("abort", abortStartup, { once: true });

    const initialMessage = request.rawInitialMessage ? request.task : `Task: ${request.task}`;
    emit({ type: "user_message", text: initialMessage });
    void command("prompt", { message: initialMessage })
      .then(() => {
        if (!settled) watchdog.arm();
        emit({ type: "started" });
      })
      .catch((error) => {
        if (!request.signal.aborted) finish({ type: "failed", error: error instanceof Error ? error.message : String(error) });
      });

    const send = async (message: string, behavior: SendBehavior = "steer") => {
      if (closed) throw new Error("Pi RPC process is closed");
      const restarting = settled;
      if (!restarting) watchdog.touch();
      if (restarting) {
        settled = false;
        output = "";
        terminalProblem = undefined;
        retryableAssistantProblem = false;
        emit({ type: "started" });
        behavior = "followUp";
      }
      await command(restarting ? "prompt" : behavior === "steer" ? "steer" : "follow_up", { message });
      if (restarting && !settled) watchdog.arm();
      emit({ type: "queue_changed", messages: [{ text: message, behavior }] });
    };

    const run: BackendRun = {
      completed,
      send,
      async cancel(reason = "Cancelled") {
        tearingDown = true;
        watchdog.clear();
        if (!settled) await command("abort", {}, 5_000).catch(() => undefined);
        closed = true;
        rejectPending(new Error(reason));
        await managed.terminate();
        await cleanupParentThread();
        finish({ type: "cancelled", reason });
      },
      async close() {
        if (closed && managed.child.exitCode !== null) return;
        closed = true;
        tearingDown = true;
        watchdog.clear();
        rejectPending(new Error("Pi RPC run closed"));
        await managed.terminate();
        await cleanupParentThread();
      },
      async forceClose() {
        closed = true;
        tearingDown = true;
        watchdog.clear();
        rejectPending(new Error("Pi RPC run force-closed"));
        await managed.terminate(0);
        await cleanupParentThread();
        finish({ type: "cancelled", reason: "Pi RPC force-closed after shutdown deadline" });
      },
    };

    // Yield once so cancellation issued immediately after spawn can revoke
    // startup before ownership of the live process transfers to the caller.
    await Promise.resolve();
    request.signal.removeEventListener("abort", abortStartup);
    if (request.signal.aborted) {
      closed = true;
      tearingDown = true;
      watchdog.clear();
      rejectPending(new Error("Pi RPC startup aborted"));
      await startupAbortTeardown;
      finish({ type: "cancelled", reason: "Pi RPC startup aborted" });
      throw request.signal.reason;
    }
    return run;
  }
}

function bound(value: string): string {
  return boundedAppend("", value).text;
}
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => asObject(part)).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
}
function thinkingContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((part) => asObject(part)).filter((part) => part.type === "thinking" && part.redacted !== true).map((part) => String(part.thinking ?? part.text ?? "")).join("\n");
}
function resultPreview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4_096);
  const record = asObject(value);
  const content = textContent(record.content);
  if (content) return content.slice(0, 4_096);
  try { return JSON.stringify(value).slice(0, 4_096); } catch { return ""; }
}
function toolResultSnapshot(value: unknown, isError: boolean): ToolResultSnapshot {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }], isError };
  }
  const record = asObject(value);
  const content = Array.isArray(record.content)
    ? record.content.map((item) => asObject(item)).map((item) => ({
        type: String(item.type ?? "text"),
        text: typeof item.text === "string" ? item.text : undefined,
        data: typeof item.data === "string" ? item.data : undefined,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      }))
    : [{ type: "text", text: resultPreview(value) }];
  return { content, details: record.details, isError };
}
function summarize(args: Record<string, unknown>): string {
  const value = args.path ?? args.command ?? args.query ?? args.url ?? "";
  return String(value).replace(/\s+/g, " ").slice(0, 160);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  const record = asObject(value);
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  if (typeof record.errorMessage === "string" && record.errorMessage.trim()) return record.errorMessage;
  return fallback;
}
function assistantProblem(message: Record<string, unknown>, fallback: string): Extract<BackendEvent, { type: "failed" | "cancelled" }> {
  const stopReason = String(message.stopReason ?? asObject(message.partial).stopReason ?? "");
  const text = errorText(message, fallback);
  return stopReason === "aborted" ? { type: "cancelled", reason: text } : { type: "failed", error: text };
}
