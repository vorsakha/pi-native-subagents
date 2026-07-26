import { createActivityWatchdog } from "../activity-watchdog.ts";
import { sanitizeSubscriptionEnv } from "../env.ts";
import { asObject, JsonRpcPeer } from "../jsonrpc.ts";
import { spawnManaged } from "../process-tree.ts";
import { boundedAppend } from "../reducer.ts";
import type { Backend, BackendEvent, BackendRequest, BackendRun, SendBehavior } from "../types.ts";

interface CodexBackendOptions {
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}

export class CodexAppServerBackend implements Backend {
  readonly name = "codex" as const;
  readonly #command: string;
  readonly #requestTimeoutMs: number;
  readonly #inactivityTimeoutMs: number;

  constructor(command = "codex", options: CodexBackendOptions = {}) {
    this.#command = command;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15 * 60_000;
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    request.signal.throwIfAborted();
    const managed = spawnManaged(this.#command, ["app-server", "--stdio"], {
      cwd: request.cwd,
      env: sanitizeSubscriptionEnv(request.env, "codex"),
    });
    let threadId = "";
    let turnId = "";
    let turnOutput = "";
    let output = "";
    let settled = false;
    let closing = false;
    let cancellingReason: string | undefined;
    let stderr = "";
    const followUps: string[] = [];
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    let peer!: JsonRpcPeer;
    let closePromise: Promise<void> | undefined;
    const closePeer = () => closePromise ??= peer.close();
    const watchdog = createActivityWatchdog(this.#inactivityTimeoutMs, () => {
      closing = true;
      finish({ type: "failed", error: `Codex produced no activity for ${this.#inactivityTimeoutMs}ms` });
      void closePeer();
    });
    const finish = (event: BackendEvent) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      emit(event);
      resolveCompleted();
    };
    const input = (text: string) => [{ type: "text", text }];
    const startTurn = async (text: string): Promise<void> => {
      turnOutput = "";
      watchdog.arm();
      emit({ type: "user_message", text });
      const turnResult = asObject(await peer.request("turn/start", {
        threadId,
        input: input(text),
        ...(request.policy.effort ? { effort: request.policy.effort } : {}),
        approvalPolicy: request.policy.approvalPolicy,
        sandboxPolicy: request.policy.codexSandbox,
        cwd: request.cwd,
      }, this.#requestTimeoutMs));
      watchdog.touch();
      turnId = String(asObject(turnResult.turn).id ?? "");
      if (!turnId) throw new Error("Codex turn/start returned no turn id");
    };

    peer = new JsonRpcPeer({
      process: managed,
      onActivity: () => watchdog.touch(),
      onRequest: (_id, method) => {
        if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "decline" };
        if (method === "item/permissions/requestApproval") return { permissions: { network: false, fileSystem: { read: [], write: [] } }, scope: "turn" };
        throw new Error(`Unsupported server request: ${method}`);
      },
      onNotification: (method, params) => {
        if (method === "item/agentMessage/delta" || method === "agentMessage/delta") {
          const delta = String(params.delta ?? "");
          turnOutput = boundedOutput(turnOutput, delta);
          emit({ type: "text_delta", text: delta });
        } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
          emit({ type: "thinking_delta", text: String(params.delta ?? "") });
        } else if (method === "item/started") {
          const item = asObject(params.item);
          const type = String(item.type ?? "item");
          if (type !== "agentMessage" && type !== "reasoning") emit({ type: "tool_start", id: String(item.id ?? type), name: type, summary: itemSummary(item) });
        } else if (method === "item/completed") {
          const item = asObject(params.item);
          const type = String(item.type ?? "item");
          if (type === "agentMessage" && typeof item.text === "string") {
            turnOutput = boundedOutput("", item.text);
            emit({ type: "message", text: turnOutput });
          } else if (type === "reasoning") {
            const reasoning = [...stringArray(item.summary), ...stringArray(item.content)].join("\n");
            if (reasoning) emit({ type: "thinking_message", text: reasoning });
          } else emit({ type: "tool_end", id: String(item.id ?? type), name: type, output: itemOutput(item), error: item.status === "failed" });
        } else if (method === "thread/tokenUsage/updated") {
          const tokenUsage = asObject(params.tokenUsage ?? params.usage);
          const usage = asObject(tokenUsage.last ?? tokenUsage);
          emit({ type: "usage", usage: { input: num(usage.inputTokens), output: num(usage.outputTokens), cacheRead: num(usage.cachedInputTokens) } });
        } else if (method === "turn/completed") {
          const turn = asObject(params.turn);
          const status = String(turn.status ?? "failed");
          turnId = "";
          if (cancellingReason) return;
          if (status === "completed") {
            output = appendTurn(output, turnOutput);
            emit({ type: "usage", usage: { turns: 1 } });
            const next = followUps.shift();
            emit({ type: "queue_changed", messages: followUps.map((text) => ({ text, behavior: "followUp" })) });
            if (next !== undefined) {
              void startTurn(next).catch((error) => finish({ type: "failed", error: error instanceof Error ? error.message : String(error) }));
            } else {
              finish({ type: "completed", output });
            }
          } else if (status === "interrupted") finish({ type: "cancelled", reason: "Codex turn interrupted" });
          else finish({ type: "failed", error: String(asObject(turn.error).message ?? `Codex turn ${status}`) });
        }
      },
    });

    let startupAbortTeardown: Promise<void> | undefined;
    const abortStartup = () => {
      closing = true;
      watchdog.clear();
      startupAbortTeardown ??= closePeer();
    };
    request.signal.addEventListener("abort", abortStartup, { once: true });

    managed.child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    managed.child.on("error", (error) => {
      if (!settled) finish({ type: "failed", error: `Codex app-server failed: ${error.message}` });
    });
    managed.child.on("close", (code, signal) => {
      if (!settled && !closing) {
        finish({ type: "failed", error: `Codex app-server exited (${code ?? signal ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}` });
      }
    });

    const initialization = (async () => {
      try {
        await peer.request("initialize", { clientInfo: { name: "pi-native-subagents", title: "Pi Native Subagents", version: "0.1.0" } }, this.#requestTimeoutMs);
        peer.notify("initialized");
        const accountResult = asObject(await peer.request("account/read", { refreshToken: false }, this.#requestTimeoutMs));
        const account = asObject(accountResult.account);
        if (account.type !== "chatgpt") throw new Error(`Codex ChatGPT login required; account type is ${String(account.type ?? "none")}`);
        const threadResult = asObject(await peer.request("thread/start", {
          cwd: request.cwd,
          ...(request.policy.model ? { model: request.policy.model } : {}),
          modelProvider: "openai",
          approvalPolicy: request.policy.approvalPolicy,
          sandboxPolicy: request.policy.codexSandbox,
          ephemeral: false,
          developerInstructions: `${request.systemPrompt}\n\n${request.policy.access === "readOnly" ? "Hard policy: remain read-only; do not mutate files, Git state, or external systems." : "This is a trusted workspace. Work autonomously without asking for per-command approval."}`,
        }, this.#requestTimeoutMs));
        const thread = asObject(threadResult.thread);
        const returnedProviders = [threadResult.modelProvider, thread.modelProvider]
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        if (returnedProviders.length === 0 || returnedProviders.some((provider) => provider !== "openai")) {
          throw new Error(`Codex thread/start did not retain the built-in openai provider (got ${returnedProviders.join(",") || "none"})`);
        }
        threadId = String(thread.id ?? "");
        if (!threadId) throw new Error("Codex thread/start returned no thread id");
        emit({ type: "started", backendSessionId: threadId, sessionFile: typeof thread.path === "string" ? thread.path : undefined });
        await startTurn(`Task: ${request.task}`);
      } catch (error) {
        if (!closing) finish({ type: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    })();

    await initialization;
    request.signal.removeEventListener("abort", abortStartup);
    if (request.signal.aborted) {
      await startupAbortTeardown;
      throw request.signal.reason;
    }

    const send = async (message: string, behavior: SendBehavior = "steer") => {
      await initialization;
      if (closing) throw new Error("Codex session is closed");
      if (!threadId) throw new Error("Codex thread failed to initialize");
      if (settled) {
        settled = false;
        output = "";
        watchdog.arm();
        emit({ type: "started" });
        await startTurn(message);
        return;
      }
      watchdog.touch();
      if (behavior === "followUp") {
        followUps.push(message);
        emit({ type: "queue_changed", messages: followUps.map((text) => ({ text, behavior: "followUp" })) });
        return;
      }
      if (!turnId) throw new Error("Codex has no active turn to steer");
      await peer.request("turn/steer", { threadId, expectedTurnId: turnId, input: input(message) }, this.#requestTimeoutMs);
      emit({ type: "user_message", text: message });
      emit({ type: "queue_changed", messages: [{ text: message, behavior: "steer" }] });
    };

    return {
      completed,
      send,
      async cancel(reason = "Cancelled") {
        cancellingReason = reason;
        closing = true;
        watchdog.clear();
        if (!settled && threadId && turnId) {
          await peer.request("turn/interrupt", { threadId, turnId }, 5_000).catch(() => undefined);
        }
        await closePeer();
        await initialization;
        finish({ type: "cancelled", reason });
      },
      async close() {
        if (!closing) {
          closing = true;
          watchdog.clear();
          if (threadId) await peer.request("thread/backgroundTerminals/clean", { threadId }, 2_000).catch(() => undefined);
        }
        await closePeer();
        await initialization;
      },
      async forceClose() {
        closing = true;
        watchdog.clear();
        await managed.terminate(0);
        finish({ type: "cancelled", reason: "Codex force-closed after shutdown deadline" });
      },
    };
  }
}

function boundedOutput(current: string, addition: string): string {
  return boundedAppend(current, addition).text;
}
function appendTurn(current: string, next: string): string {
  return boundedOutput(current, `${current ? "\n\n" : ""}${next}`);
}
function num(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function itemSummary(item: Record<string, unknown>): string {
  const candidate = item.command ?? item.path ?? item.query ?? item.name ?? "";
  return String(candidate).replace(/\s+/g, " ").slice(0, 160);
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function itemOutput(item: Record<string, unknown>): string {
  const candidate = item.aggregatedOutput ?? item.output ?? item.result ?? item.error ?? "";
  if (typeof candidate === "string") return candidate.slice(0, 4_096);
  try { return JSON.stringify(candidate).slice(0, 4_096); } catch { return ""; }
}
