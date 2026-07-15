import { fileURLToPath } from "node:url";
import { sanitizeSubscriptionEnv } from "../env.ts";
import { JsonlFramer, parseJsonRecord } from "../framing.ts";
import { spawnManaged } from "../process-tree.ts";
import { boundedAppend } from "../reducer.ts";
import type { Backend, BackendEvent, BackendRequest, BackendRun, SendBehavior } from "../types.ts";

const NESTED_EXTENSION = fileURLToPath(new URL("../../extensions/subagents/index.ts", import.meta.url));

interface PiBackendOptions {
  requestTimeoutMs?: number;
  runTimeoutMs?: number;
}

interface PendingCommand {
  command: string;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PiRpcBackend implements Backend {
  readonly name = "pi" as const;
  readonly #command: string;
  readonly #requestTimeoutMs: number;
  readonly #runTimeoutMs: number;

  constructor(command = "pi", options: PiBackendOptions = {}) {
    this.#command = command;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#runTimeoutMs = options.runTimeoutMs ?? 15 * 60_000;
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    request.signal.throwIfAborted();
    const args = [
      "--mode", "rpc", "--approve", "--no-skills", "--no-prompt-templates", "--no-extensions",
      "--name", `subagent-${request.role}-${request.jobId.slice(0, 8)}`,
      "--model", request.policy.model,
      "--thinking", request.policy.thinking,
      "--append-system-prompt", request.systemPrompt,
    ];
    // Load only this package for explicitly allowed nested delegation. This
    // avoids unrelated global extensions while preserving the role allowlist.
    if (request.policy.nestedAgents.length > 0 && request.policy.depth < request.policy.maxDepth) {
      args.push("--extension", NESTED_EXTENSION);
    }
    if (request.policy.piTools.length > 0) args.push("--tools", request.policy.piTools.join(","));
    else args.push("--no-tools");

    request.signal.throwIfAborted();
    const managed = spawnManaged(this.#command, args, { cwd: request.cwd, env: sanitizeSubscriptionEnv(request.env, "codex") });
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
    let runTimer: NodeJS.Timeout | undefined;
    const armRunTimer = () => {
      if (runTimer) clearTimeout(runTimer);
      runTimer = setTimeout(() => {
        finish({ type: "failed", error: `Pi RPC run timed out after ${this.#runTimeoutMs}ms` });
        void managed.terminate();
      }, this.#runTimeoutMs);
    };

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
      clearTimeout(runTimer);
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

    armRunTimer();
    const framer = new JsonlFramer();
    const handle = (record: string) => {
      const event = parseJsonRecord(record);
      if (!event) {
        if (record.trim()) throw new Error("invalid JSON object");
        return;
      }
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
        } else if (message.role === "user") {
          const text = textContent(message.content);
          if (text) emit({ type: "user_message", text });
        }
      } else if (event.type === "tool_execution_start") {
        emit({ type: "tool_start", id: String(event.toolCallId ?? "tool"), name: String(event.toolName ?? "tool"), summary: summarize(asObject(event.args)) });
      } else if (event.type === "tool_execution_end") {
        emit({ type: "tool_end", id: String(event.toolCallId ?? "tool"), name: String(event.toolName ?? "tool"), output: resultPreview(event.result), error: event.isError === true });
      } else if (event.type === "queue_update") {
        const steering = Array.isArray(event.steering) ? event.steering : [];
        const followUp = Array.isArray(event.followUp) ? event.followUp : [];
        emit({ type: "queue_changed", messages: [
          ...steering.map((text) => ({ text: String(text), behavior: "steer" as const })),
          ...followUp.map((text) => ({ text: String(text), behavior: "followUp" as const })),
        ] });
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
      const detail = `Pi RPC exited (${code ?? signal ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
      rejectPending(new Error(detail));
      if (!settled && !tearingDown) finish({ type: "failed", error: detail });
    });

    let startupAbortTeardown: Promise<void> | undefined;
    const abortStartup = () => { startupAbortTeardown ??= managed.terminate(0); };
    request.signal.addEventListener("abort", abortStartup, { once: true });

    emit({ type: "user_message", text: `Task: ${request.task}` });
    void command("prompt", { message: `Task: ${request.task}` })
      .then(() => emit({ type: "started" }))
      .catch((error) => {
        if (!request.signal.aborted) finish({ type: "failed", error: error instanceof Error ? error.message : String(error) });
      });

    const send = async (message: string, behavior: SendBehavior = "steer") => {
      if (closed) throw new Error("Pi RPC process is closed");
      const restarting = settled;
      if (restarting) {
        settled = false;
        output = "";
        terminalProblem = undefined;
        retryableAssistantProblem = false;
        armRunTimer();
        emit({ type: "started" });
        behavior = "followUp";
      }
      await command(restarting ? "prompt" : behavior === "steer" ? "steer" : "follow_up", { message });
      emit({ type: "queue_changed", messages: [{ text: message, behavior }] });
    };

    const run: BackendRun = {
      completed,
      send,
      async cancel(reason = "Cancelled") {
        if (!settled) await command("abort", {}, 5_000).catch(() => undefined);
        closed = true;
        tearingDown = true;
        rejectPending(new Error(reason));
        await managed.terminate();
        finish({ type: "cancelled", reason });
      },
      async close() {
        if (closed && managed.child.exitCode !== null) return;
        closed = true;
        tearingDown = true;
        clearTimeout(runTimer);
        rejectPending(new Error("Pi RPC run closed"));
        await managed.terminate();
      },
      async forceClose() {
        closed = true;
        tearingDown = true;
        clearTimeout(runTimer);
        rejectPending(new Error("Pi RPC run force-closed"));
        await managed.terminate(0);
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
      clearTimeout(runTimer);
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
function summarize(args: Record<string, unknown>): string {
  const value = args.path ?? args.command ?? args.query ?? args.url ?? "";
  return String(value).replace(/\s+/g, " ").slice(0, 160);
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
