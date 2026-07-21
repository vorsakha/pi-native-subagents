import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createActivityWatchdog } from "../activity-watchdog.ts";
import { sanitizeSubscriptionEnv } from "../env.ts";
import { boundedAppend } from "../reducer.ts";
import type { Backend, BackendEvent, BackendRequest, BackendRun, SendBehavior } from "../types.ts";

const READ_ONLY_DENY = ["Bash", "Edit", "Write", "NotebookEdit", "Agent"];
const execFileAsync = promisify(execFile);

type ClaudeQuery = typeof query;
type ClaudeAuthVerifier = (command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<void>;
interface ClaudeBackendOptions {
  inactivityTimeoutMs?: number;
  queryFn?: ClaudeQuery;
  verifyAuth?: ClaudeAuthVerifier;
}

export class ClaudeBackend implements Backend {
  readonly name = "claude" as const;
  readonly #command: string;
  readonly #inactivityTimeoutMs: number;
  readonly #query: ClaudeQuery;
  readonly #verifyAuth: ClaudeAuthVerifier;

  constructor(command = "claude", options: ClaudeBackendOptions = {}) {
    this.#command = command;
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15 * 60_000;
    this.#query = options.queryFn ?? query;
    this.#verifyAuth = options.verifyAuth ?? verifyClaudeSubscription;
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    request.signal.throwIfAborted();
    const env = sanitizeSubscriptionEnv(request.env, "claude");
    await this.#verifyAuth(this.#command, request.cwd, env, request.signal);
    request.signal.throwIfAborted();
    const controller = new AbortController();
    const input = new AsyncInput();
    input.push(userMessage(`Task: ${request.task}`, "next"));
    emit({ type: "user_message", text: `Task: ${request.task}` });
    let closing = false;
    let terminal = false;
    let expectedResults = 1;
    let resultCount = 0;
    let output = "";
    const queuedMessages: Array<{ text: string; behavior: SendBehavior }> = [];
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const watchdog = createActivityWatchdog(this.#inactivityTimeoutMs, () => {
      closing = true;
      finish({ type: "failed", error: `Claude produced no activity for ${this.#inactivityTimeoutMs}ms` });
      controller.abort();
      input.close();
      stream.close();
    });
    const finish = (event: BackendEvent) => {
      if (terminal) return;
      terminal = true;
      watchdog.clear();
      emit(event);
      resolveCompleted();
    };
    const stream = this.#query({
      prompt: input,
      options: {
        abortController: controller,
        cwd: request.cwd,
        env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "pi-native-subagents/0.1.0" },
        pathToClaudeCodeExecutable: this.#command,
        ...(request.policy.model ? { model: request.policy.model } : {}),
        ...(request.policy.effort ? { effort: request.policy.effort } : {}),
        thinking: request.policy.thinking === "off" ? { type: "disabled" } : { type: "adaptive" },
        systemPrompt: { type: "preset", preset: "claude_code", append: request.systemPrompt },
        tools: request.policy.claudeTools,
        allowedTools: request.policy.claudeTools,
        disallowedTools: request.policy.access === "readOnly" ? READ_ONLY_DENY : [],
        permissionMode: request.policy.access === "full" ? "bypassPermissions" : "dontAsk",
        allowDangerouslySkipPermissions: request.policy.access === "full",
        settingSources: [],
        extraArgs: { "safe-mode": null },
        persistSession: true,
        includePartialMessages: true,
        maxTurns: 80,
      },
    });
    watchdog.arm();

    const consuming = (async () => {
      try {
        for await (const message of stream) {
          watchdog.touch();
          const result = handleMessage(message, emit, controller, request.policy.access === "readOnly");
          if (!result) continue;
          resultCount++;
          if (queuedMessages.length) {
            queuedMessages.shift();
            emit({ type: "queue_changed", messages: [...queuedMessages] });
          }
          output = appendOutput(output, result.output);
          if (!result.success) {
            finish({ type: "failed", error: result.error });
          } else if (resultCount >= expectedResults) {
            finish({ type: "completed", output });
          }
        }
        if (!terminal && !closing) finish({ type: "failed", error: "Claude stream ended without a result" });
      } catch (error) {
        if (controller.signal.aborted) {
          if (!terminal) finish({ type: "cancelled", reason: "Claude query aborted" });
        } else {
          finish({ type: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();

    const stop = async () => {
      closing = true;
      watchdog.clear();
      input.close();
      if (!controller.signal.aborted) controller.abort();
      stream.close();
      await withTimeout(consuming, 5_000, "Claude SDK shutdown").catch(() => undefined);
    };

    return {
      completed,
      async send(message: string, behavior: SendBehavior = "steer") {
        if (closing) throw new Error("Claude session is closed");
        const restarting = terminal;
        if (restarting) {
          terminal = false;
          output = "";
          expectedResults = resultCount + 1;
          behavior = "followUp";
          emit({ type: "started" });
        } else if (behavior === "followUp") expectedResults++;
        if (restarting) watchdog.arm();
        else watchdog.touch();
        input.push(userMessage(message, behavior === "steer" ? "now" : "later"));
        emit({ type: "user_message", text: message });
        queuedMessages.push({ text: message, behavior });
        emit({ type: "queue_changed", messages: [...queuedMessages] });
      },
      async cancel(reason = "Cancelled") {
        await stop();
        finish({ type: "cancelled", reason });
      },
      close: stop,
      async forceClose() {
        closing = true;
        watchdog.clear();
        input.close();
        controller.abort();
        stream.close();
        finish({ type: "cancelled", reason: "Claude force-closed after shutdown deadline" });
      },
    };
  }
}

class AsyncInput implements AsyncIterable<SDKUserMessage> {
  readonly #queued: SDKUserMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude input stream is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#queued.push(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.#queued.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function userMessage(text: string, priority: "now" | "next" | "later"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    priority,
  };
}

interface ClaudeResult { success: boolean; output: string; error: string }

function handleMessage(message: SDKMessage, emit: (event: BackendEvent) => void, controller: AbortController, readOnly: boolean): ClaudeResult | undefined {
  if (message.type === "system" && message.subtype === "init") {
    const source = message.apiKeySource as string;
    if (source !== "oauth" && source !== "none") {
      emit({ type: "failed", error: "Claude subscription OAuth required; CLI reported a non-subscription auth source" });
      controller.abort();
      return { success: false, output: "", error: "Claude subscription OAuth required" };
    }
    const mutatingTools = message.tools.filter((tool) => READ_ONLY_DENY.includes(tool));
    if (readOnly && mutatingTools.length > 0) {
      const error = `Claude read-only initialization exposed mutating tools: ${mutatingTools.join(", ")}`;
      controller.abort();
      return { success: false, output: "", error };
    }
    emit({ type: "started", backendSessionId: message.session_id });
    return;
  }
  if (message.type === "system" && message.subtype === "permission_denied") {
    emit({ type: "tool_start", id: message.tool_use_id, name: message.tool_name, summary: "Denied by read-only policy" });
    emit({ type: "tool_end", id: message.tool_use_id, name: message.tool_name, error: true });
    return;
  }
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      emit({ type: "text_delta", text: event.delta.text });
    } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
      emit({ type: "thinking_delta", text: event.delta.thinking });
    }
    return;
  }
  if (message.type === "assistant") {
    let text = "";
    for (const block of message.message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") emit({ type: "thinking_message", text: block.thinking });
      else if (block.type === "redacted_thinking") emit({ type: "thinking_message", text: "[redacted reasoning]" });
      else if (block.type === "tool_use") emit({ type: "tool_start", id: block.id, name: block.name, summary: summarize(block.input) });
    }
    if (text) emit({ type: "message", text: boundedAppend("", text).text });
    if (message.error) return { success: false, output: "", error: `Claude assistant error: ${message.error}` };
    return;
  }
  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result") emit({ type: "tool_end", id: block.tool_use_id, output: summarize(block.content), error: block.is_error === true });
    }
    return;
  }
  if (message.type === "result") {
    const usage = message.usage as unknown as Record<string, unknown>;
    emit({ type: "usage", usage: {
      input: num(usage.input_tokens), output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
      cost: message.total_cost_usd, turns: message.num_turns,
    } });
    if (message.subtype === "success" && message.result) emit({ type: "message", text: boundedAppend("", message.result).text });
    return message.subtype === "success"
      ? { success: true, output: message.result, error: "" }
      : { success: false, output: "", error: message.errors.join("\n") || message.subtype };
  }
}

async function verifyClaudeSubscription(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ["auth", "status", "--json"], { cwd, env, encoding: "utf8", timeout: 10_000, signal }));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error("Unable to verify Claude subscription login", { cause: error });
  }
  let status: unknown;
  try { status = JSON.parse(stdout); } catch { throw new Error("Claude auth status returned invalid JSON"); }
  const record = status !== null && typeof status === "object" ? status as Record<string, unknown> : {};
  if (record.loggedIn !== true || record.authMethod !== "claude.ai") throw new Error("Claude Code must be logged in with a claude.ai subscription");
}

function appendOutput(current: string, next: string): string {
  return boundedAppend(current, `${current && next ? "\n\n" : ""}${next}`).text;
}
function num(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function summarize(value: unknown): string {
  try { return JSON.stringify(value).replace(/\s+/g, " ").slice(0, 160); } catch { return ""; }
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
