import { createActivityWatchdog } from "../activity-watchdog.ts";
import type { CapabilityHealth, CapabilitySourceStatus, DiscoveredCapability } from "../capabilities.ts";
import { sanitizeSubscriptionEnv } from "../env.ts";
import { asObject, JsonRpcPeer } from "../jsonrpc.ts";
import { spawnManaged } from "../process-tree.ts";
import { boundedAppend } from "../reducer.ts";
import type { Backend, BackendEvent, BackendPolicy, BackendRequest, BackendRun, DiscoveryRequest, DiscoveryResult, SendBehavior } from "../types.ts";

const CLIENT_INFO = { name: "pi-native-subagents", title: "Pi Native Subagents", version: "0.1.0" };
/** Optional native integrations whose failure must not take down unrelated work. */
const OPTIONAL_INTEGRATION = /mcp|plugin|marketplace|oauth|invalid_grant|refresh token|hook/i;

interface CodexBackendOptions {
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}

/**
 * Thread config overrides applied on top of the user's native Codex setup.
 * Full-access children keep native parity; read-only children lose the surfaces
 * that could mutate outside the sandbox.
 */
export function codexThreadConfig(policy: Pick<BackendPolicy, "customization" | "access">): Record<string, unknown> | undefined {
  if (policy.customization === "native" && policy.access === "full") return undefined;
  return { mcp_servers: {}, hooks: {} };
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

  /**
   * Live app-server inventory with no thread and no turn. Every source is polled
   * independently so one broken integration degrades to a warning instead of an
   * empty catalog.
   */
  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    request.signal.throwIfAborted();
    const managed = spawnManaged(this.#command, ["app-server", "--stdio"], {
      cwd: request.cwd,
      env: sanitizeSubscriptionEnv(request.env, "codex"),
    });
    const peer = new JsonRpcPeer({
      process: managed,
      // Discovery is unattended: never answer an interactive server request.
      onRequest: (_id, method) => { throw new Error(`Interactive request denied during discovery: ${method}`); },
    });
    const capabilities: DiscoveredCapability[] = [];
    const sources: CapabilitySourceStatus[] = [];
    const warnings: string[] = [];
    let nativeVersion: string | undefined;
    const abort = () => void peer.close();
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const initialize = asObject(await peer.request("initialize", { clientInfo: CLIENT_INFO }, this.#requestTimeoutMs));
      const userAgent = asObject(initialize.userAgent);
      nativeVersion = typeof initialize.version === "string"
        ? initialize.version
        : typeof userAgent.codexVersion === "string" ? userAgent.codexVersion : undefined;
      peer.notify("initialized");
      sources.push({ source: "codex-app-server", health: "healthy" });

      const skills = await this.#probe(peer, "skills/list", { cwds: [request.cwd], forceReload: request.refresh });
      if (skills.ok) {
        for (const entry of arrayOf(asObject(skills.value).data)) {
          const record = asObject(entry);
          for (const item of arrayOf(record.skills)) {
            const skill = asObject(item);
            if (typeof skill.name !== "string") continue;
            capabilities.push({
              kind: "skill",
              name: skill.name,
              description: typeof skill.description === "string" ? skill.description : undefined,
              origin: typeof skill.scope === "string" ? `skill:${skill.scope}` : "skill",
              enabled: skill.enabled !== false,
            });
          }
          for (const item of arrayOf(record.errors)) {
            const error = asObject(item);
            warnings.push(`Codex skill error at ${String(error.path ?? "unknown")}: ${String(error.message ?? "unknown")}`);
          }
        }
        sources.push({ source: "codex-skills", health: "healthy" });
      } else {
        sources.push({ source: "codex-skills", health: "unknown", detail: skills.detail });
        warnings.push(`Codex skill inventory unavailable: ${skills.detail}`);
      }

      const plugins = await this.#probe(peer, "plugin/installed", { cwds: [request.cwd] });
      if (plugins.ok) {
        for (const marketplace of arrayOf(asObject(plugins.value).marketplaces)) {
          for (const item of arrayOf(asObject(marketplace).plugins)) {
            const plugin = asObject(item);
            if (typeof plugin.name !== "string" || plugin.installed !== true) continue;
            capabilities.push({
              kind: "plugin",
              name: plugin.name,
              description: typeof plugin.description === "string" ? plugin.description : undefined,
              origin: `plugin:${String(asObject(marketplace).name ?? "local")}`,
              enabled: plugin.enabled !== false,
              health: plugin.availability === "DISABLED_BY_ADMIN" ? "unavailable" : "healthy",
            });
          }
        }
        sources.push({ source: "codex-plugins", health: "healthy" });
      } else {
        sources.push({ source: "codex-plugins", health: "unknown", detail: plugins.detail });
        warnings.push(`Codex plugin inventory unavailable: ${plugins.detail}`);
      }

      const nativeIntegrationsEnabled = request.customization === "native" && request.access === "full";
      const hooks = await this.#probe(peer, "hooks/list", { cwds: [request.cwd] });
      if (hooks.ok) {
        for (const entry of arrayOf(asObject(hooks.value).data)) {
          for (const item of arrayOf(asObject(entry).hooks)) {
            const hook = asObject(item);
            if (typeof hook.key !== "string") continue;
            capabilities.push({
              kind: "hook",
              name: hook.key,
              description: typeof hook.eventName === "string" ? `event ${hook.eventName}` : undefined,
              origin: typeof hook.source === "string" ? `hook:${hook.source}` : "hook",
              enabled: hook.enabled !== false,
              health: nativeIntegrationsEnabled
                ? hook.trustStatus === "trusted" || hook.trustStatus === undefined ? "healthy" : "degraded"
                : "unavailable",
              detail: nativeIntegrationsEnabled
                ? typeof hook.statusMessage === "string" ? hook.statusMessage : undefined
                : "hooks are disabled by the child access/customization policy",
            });
          }
        }
        sources.push({ source: "codex-hooks", health: "healthy" });
      } else {
        sources.push({ source: "codex-hooks", health: "unknown", detail: hooks.detail });
      }

      const mcp = await this.#probe(peer, "mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
      if (mcp.ok) {
        let degraded = 0;
        for (const item of arrayOf(asObject(mcp.value).data)) {
          const server = asObject(item);
          if (typeof server.name !== "string") continue;
          const authStatus = String(server.authStatus ?? "unsupported");
          const health: CapabilityHealth = !nativeIntegrationsEnabled || authStatus === "notLoggedIn" ? "unavailable" : "healthy";
          if (health !== "healthy") degraded++;
          capabilities.push({
            kind: "mcp",
            name: server.name,
            origin: "mcp",
            health,
            detail: !nativeIntegrationsEnabled
              ? "MCP is disabled by the child access/customization policy"
              : authStatus === "notLoggedIn" ? "MCP server is not authenticated" : undefined,
          });
          for (const [toolName, tool] of Object.entries(asObject(server.tools))) {
            const record = asObject(tool);
            const annotations = asObject(record.annotations);
            capabilities.push({
              kind: "tool",
              name: `mcp__${server.name}__${toolName}`,
              description: typeof record.description === "string" ? record.description : undefined,
              origin: `mcp:${server.name}`,
              health,
              effect: annotations.readOnlyHint === true || annotations.readOnly === true ? "external-read" : "external-write",
            });
          }
        }
        sources.push({
          source: "codex-mcp",
          health: degraded ? "degraded" : "healthy",
          detail: degraded ? `${degraded} MCP server(s) need authentication` : undefined,
        });
        if (degraded) warnings.push(`Codex reports ${degraded} MCP server(s) that need authentication`);
      } else {
        sources.push({ source: "codex-mcp", health: "unknown", detail: mcp.detail });
        warnings.push(`Codex MCP status unavailable: ${mcp.detail}`);
      }
    } catch (error) {
      sources.push({ source: "codex-app-server", health: "unavailable", detail: errorMessage(error) });
      warnings.push(`Codex app-server discovery failed: ${errorMessage(error)}`);
    } finally {
      request.signal.removeEventListener("abort", abort);
      await peer.close().catch(() => undefined);
    }
    return { capabilities, sources, warnings, nativeVersion };
  }

  async #probe(peer: JsonRpcPeer, method: string, params: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
    try {
      return { ok: true, value: await peer.request(method, params, this.#requestTimeoutMs) };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
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
        // Unattended children never answer elicitation, login, or approval
        // prompts introduced by native plugins, hooks, or newer protocols.
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

    const startThread = async (config?: Record<string, unknown>) => asObject(await peer.request("thread/start", {
      cwd: request.cwd,
      ...(request.policy.model ? { model: request.policy.model } : {}),
      modelProvider: "openai",
      approvalPolicy: request.policy.approvalPolicy,
      sandboxPolicy: request.policy.codexSandbox,
      ephemeral: false,
      ...(config ? { config } : {}),
      developerInstructions: `${request.systemPrompt}\n\n${request.policy.access === "readOnly" ? "Hard policy: remain read-only; do not mutate files, Git state, or external systems." : "This is a trusted workspace. Work autonomously without asking for per-command approval."}`,
    }, this.#requestTimeoutMs));

    const initialization = (async () => {
      try {
        await peer.request("initialize", { clientInfo: CLIENT_INFO }, this.#requestTimeoutMs);
        peer.notify("initialized");
        const accountResult = asObject(await peer.request("account/read", { refreshToken: false }, this.#requestTimeoutMs));
        const account = asObject(accountResult.account);
        if (account.type !== "chatgpt") throw new Error(`Codex ChatGPT login required; account type is ${String(account.type ?? "none")}`);
        const baseConfig = codexThreadConfig(request.policy);
        let threadResult: Record<string, unknown>;
        try {
          threadResult = await startThread(baseConfig);
        } catch (error) {
          // A broken optional integration must not take down unrelated work, but
          // a job that explicitly required that integration must still fail.
          const detail = errorMessage(error);
          const required = (request.policy.requires ?? []).some((requirement) =>
            /:(?:mcp|plugin|hook):/.test(requirement) || /:tool:mcp__/.test(requirement) || OPTIONAL_INTEGRATION.test(requirement),
          );
          if (required || !OPTIONAL_INTEGRATION.test(detail)) throw error;
          emit({ type: "degraded", source: "codex-native-integrations", detail });
          threadResult = await startThread({ ...(baseConfig ?? {}), mcp_servers: {}, hooks: {} });
        }
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
      finish({ type: "cancelled", reason: String(request.signal.reason ?? "Codex startup aborted") });
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
function arrayOf(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
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
