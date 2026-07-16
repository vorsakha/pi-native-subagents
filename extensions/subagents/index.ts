import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ClaudeBackend, CodexAppServerBackend, PiRpcBackend } from "../../src/backends/index.ts";
import { isTerminal, JobManager } from "../../src/manager.ts";
import { claimExtensionInstall } from "../../src/install-guard.ts";
import { providerFamily } from "../../src/policy.ts";
import { openSubagentsDashboard } from "./dashboard.ts";
import {
  renderJobCard,
  renderJobListCard,
  renderJobReceipt,
  renderToolCallLine,
  sendBehaviorLabel,
  shortId,
  truncatePreview,
} from "./render.ts";
import { loadRoles, parseAllowedRoles } from "../../src/roles.ts";
import type { Backend, BackendName, EffortLevel, JobSnapshot, ModelTier, ProviderFamily, SendBehavior } from "../../src/types.ts";
import { registerWorkflows } from "../workflows/index.ts";

/** The configured expand-key hint (e.g. "ctrl+o to expand"), threaded into render options so render.ts stays testable without live keybinding state. */
function expandHint(): string {
  // Tool renderers can be invoked by headless hosts before Pi's interactive theme initializes.
  try { return keyHint("app.tools.expand", "to expand"); }
  catch { return "to expand"; }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = resolve(ROOT, "agents");
const STATE_ENTRY = "native-subagents-profile";
const LEGACY_STATE_ENTRY = "subagents-profile";
const SUBAGENT_RESULT_MESSAGE = "native-subagent-result";
const BACKENDS = ["codex", "claude", "pi"] as const;
const TIERS = ["economy", "balanced", "quality"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

interface RegistrationOptions {
  registry?: object;
  legacyRoot?: string | false;
  backends?: Backend[];
  workflowArtifactRoot?: string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

interface LiveCardPulse {
  invalidate?: () => void;
  shouldContinue?: () => boolean;
}

interface LiveCardRenderState {
  nativeSubagentPulse?: LiveCardPulse;
  nativeSubagentSnapshot?: JobSnapshot;
}

interface LiveCardRenderContext {
  state: LiveCardRenderState;
  invalidate(): void;
}

export default function nativeSubagents(pi: ExtensionAPI): void {
  registerNativeSubagents(pi);
}

export function registerNativeSubagents(pi: ExtensionAPI, options: RegistrationOptions = {}): void {
  const legacyRoot = options.legacyRoot === false
    ? undefined
    : options.legacyRoot ?? resolve(homedir(), ".pi/agent/extensions/subagents");
  const releaseInstall = claimExtensionInstall(ROOT, options.registry ?? globalThis, legacyRoot);
  const roles = loadRoles(AGENTS_DIR, parseAllowedRoles(process.env));
  const roleNames = [...roles.keys()];
  const roleSchema = roleNames.length > 0
    ? StringEnum(roleNames as [string, ...string[]])
    : Type.String();
  const configuredBackend = configuredBackendFromEnv(process.env);
  let activeBackend = configuredBackend;
  let manager: JobManager | undefined;
  let unsubscribeManager: (() => void) | undefined;
  let sessionContext: { isIdle(): boolean } | undefined;
  const deferredResults = new Map<string, JobSnapshot>();
  const cardSnapshots = new Map<string, JobSnapshot>();
  const liveCardPulses = new Set<LiveCardPulse>();
  const schedulePulse = options.setInterval ?? setInterval;
  const cancelPulse = options.clearInterval ?? clearInterval;
  let liveCardTicker: ReturnType<typeof setInterval> | undefined;
  const waitInterest = new Map<string, number>();
  const consumedResults = new Set<string>();
  const resultKey = (id: string, generation: number) => `${id}:${generation}`;

  const createManager = () => new JobManager({
    roles,
    concurrency: 4,
    maxDepth: 2,
    backends: options.backends ?? [new PiRpcBackend(), new ClaudeBackend(), new CodexAppServerBackend()],
  });
  const getManager = () => manager ??= createManager();
  const stopCardPulse = (pulse: LiveCardPulse) => {
    pulse.invalidate = undefined;
    pulse.shouldContinue = undefined;
    liveCardPulses.delete(pulse);
    if (!liveCardPulses.size && liveCardTicker) {
      cancelPulse(liveCardTicker);
      liveCardTicker = undefined;
    }
  };
  const clearCardPulses = () => {
    for (const pulse of liveCardPulses) {
      pulse.invalidate = undefined;
      pulse.shouldContinue = undefined;
    }
    liveCardPulses.clear();
    if (liveCardTicker) cancelPulse(liveCardTicker);
    liveCardTicker = undefined;
  };
  const syncCardPulse = (context: LiveCardRenderContext | undefined, active: boolean, shouldContinue: () => boolean) => {
    if (!context?.state) return;
    const pulse = context.state.nativeSubagentPulse ??= {};
    if (!active) return stopCardPulse(pulse);
    pulse.invalidate = context.invalidate;
    pulse.shouldContinue = shouldContinue;
    liveCardPulses.add(pulse);
    if (liveCardTicker) return;
    liveCardTicker = schedulePulse(() => {
      for (const current of [...liveCardPulses]) {
        if (!current.shouldContinue?.()) {
          stopCardPulse(current);
          continue;
        }
        try { current.invalidate?.(); }
        catch { stopCardPulse(current); }
      }
    }, 200);
    liveCardTicker.unref?.();
  };
  const refreshCardPulses = () => {
    for (const pulse of [...liveCardPulses]) {
      const keep = pulse.shouldContinue?.() === true;
      try { pulse.invalidate?.(); }
      catch { stopCardPulse(pulse); continue; }
      if (!keep) stopCardPulse(pulse);
    }
  };
  const cardKey = (job: Pick<JobSnapshot, "id" | "generation">) => `${job.id}:${job.generation}`;
  const rememberCardSnapshot = (job: JobSnapshot) => {
    cardSnapshots.set(cardKey(job), job);
    if (cardSnapshots.size > 400) cardSnapshots.delete(cardSnapshots.keys().next().value!);
  };
  const liveJob = (fallback: JobSnapshot, context?: LiveCardRenderContext): { job: JobSnapshot; tracked: boolean } => {
    const key = cardKey(fallback);
    let job = cardSnapshots.get(key) ?? context?.state?.nativeSubagentSnapshot ?? fallback;
    let tracked = false;
    if (manager) {
      try {
        const current = manager.check(fallback.id);
        if (current.generation === fallback.generation) {
          job = current;
          tracked = true;
          rememberCardSnapshot(current);
        }
      } catch { /* retained row snapshot survives manager eviction */ }
    }
    if (context?.state) context.state.nativeSubagentSnapshot = job;
    return { job, tracked };
  };
  const renderLiveJob = (
    fallback: JobSnapshot,
    theme: Theme,
    options: { expanded: boolean; isPartial?: boolean; lead?: string; receipt?: string | ((job: JobSnapshot) => string) },
    context?: LiveCardRenderContext,
  ) => {
    const current = liveJob(fallback, context);
    const active = current.tracked && !isTerminal(current.job.status);
    const key = cardKey(fallback);
    syncCardPulse(context, active, () => {
      const remembered = cardSnapshots.get(key);
      if (remembered && isTerminal(remembered.status)) return false;
      if (!manager) return false;
      try {
        const latest = manager.check(fallback.id);
        return latest.generation === fallback.generation && !isTerminal(latest.status);
      } catch { return false; }
    });
    const now = Date.now();
    if (!options.expanded && options.receipt) {
      const action = typeof options.receipt === "function" ? options.receipt(current.job) : options.receipt;
      return renderJobReceipt(current.job, theme, { action, now });
    }
    return renderJobCard(current.job, theme, {
      ...options,
      now,
      isPartial: options.isPartial || active,
      expandHint: expandHint(),
    });
  };
  const renderLiveList = (
    fallback: JobSnapshot[],
    theme: Theme,
    expanded: boolean,
    context?: LiveCardRenderContext,
  ) => {
    const jobs = manager?.list() ?? fallback;
    syncCardPulse(
      context,
      !!manager && jobs.some((job) => !isTerminal(job.status)),
      () => !!manager && manager.list().some((job) => !isTerminal(job.status)),
    );
    return renderJobListCard(jobs, theme, { expanded, now: Date.now() });
  };
  const workflows = registerWorkflows(pi, { roleNames, artifactRoot: options.workflowArtifactRoot });

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE, (message, { expanded }, theme) => {
    const job = (message.details as { job?: JobSnapshot } | undefined)?.job;
    if (!job) return renderToolCallLine(theme, "Inspect", "subagent result unavailable");
    return renderJobCard(job, theme, { expanded, now: Date.now(), expandHint: expandHint() });
  });

  const deliverResult = (job: JobSnapshot) => {
    const compact = compactJob(job);
    pi.sendMessage({
      customType: SUBAGENT_RESULT_MESSAGE,
      content: terminalText(job),
      display: true,
      details: { job: compact },
    }, { deliverAs: "followUp", triggerTurn: true });
  };
  const flushDeferredResults = () => {
    for (const [id, job] of deferredResults) {
      deferredResults.delete(id);
      try { deliverResult(job); } catch { /* session may be shutting down */ }
    }
  };
  const deferResult = (job: JobSnapshot) => {
    const key = resultKey(job.id, job.generation);
    if (job.workflow || consumedResults.has(key) || (waitInterest.get(key) ?? 0) > 0) return;
    deferredResults.set(key, job);
    if (sessionContext?.isIdle()) flushDeferredResults();
  };
  const beginResultConsumption = (id: string): number => {
    const generation = manager?.check(id).generation ?? 0;
    const key = resultKey(id, generation);
    waitInterest.set(key, (waitInterest.get(key) ?? 0) + 1);
    deferredResults.delete(key);
    return generation;
  };
  const endResultConsumption = (id: string, generation: number, consumed: boolean) => {
    const key = resultKey(id, generation);
    const count = (waitInterest.get(key) ?? 1) - 1;
    if (count <= 0) waitInterest.delete(key);
    else waitInterest.set(key, count);
    if (consumed) {
      consumedResults.add(key);
      if (consumedResults.size > 200) consumedResults.delete(consumedResults.values().next().value!);
    } else {
      try {
        const current = manager?.check(id);
        if (current && current.generation === generation && isTerminal(current.status)) deferResult(current);
      } catch { /* job may have been evicted */ }
    }
  };

  pi.on("session_start", (_event, ctx) => {
    clearCardPulses();
    manager = createManager();
    sessionContext = ctx;
    deferredResults.clear();
    cardSnapshots.clear();
    waitInterest.clear();
    consumedResults.clear();
    activeBackend = configuredBackend;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data as { backend?: unknown; profile?: unknown } | undefined;
      const restored = entry.customType === STATE_ENTRY
        ? normalizeBackend(data?.backend)
        : entry.customType === LEGACY_STATE_ENTRY
          ? normalizeBackend(data?.profile)
          : undefined;
      if (restored) activeBackend = restored;
    }
    const sessionManager = manager;
    unsubscribeManager = sessionManager.subscribe((job, event) => {
      rememberCardSnapshot(job);
      refreshCardPulses();
      updateStatus(ctx, sessionManager, activeBackend);
      if (event.type === "completed" || event.type === "failed" || (event.type === "cancelled" && event.reason !== "Session shutdown")) {
        deferResult(job);
      }
    });
    updateStatus(ctx, sessionManager, activeBackend);
    workflows.sessionStart(ctx, sessionManager);
  });

  pi.on("agent_settled", flushDeferredResults);

  pi.on("session_shutdown", async () => {
    unsubscribeManager?.();
    unsubscribeManager = undefined;
    sessionContext = undefined;
    clearCardPulses();
    deferredResults.clear();
    cardSnapshots.clear();
    waitInterest.clear();
    consumedResults.clear();
    try {
      await workflows.sessionShutdown();
      await manager?.shutdown();
    }
    finally {
      manager = undefined;
      releaseInstall();
    }
  });

  const configure = async (args: string, ctx: ExtensionCommandContext) => {
    const value = args.trim().toLowerCase();
    const selected = normalizeBackend(value);
    if (selected) {
      activeBackend = selected;
      pi.appendEntry(STATE_ENTRY, { backend: selected });
      updateStatus(ctx, getManager(), activeBackend);
      ctx.ui.notify(`Default subagent backend: ${selected}`, "info");
    } else if (value === "status") {
      ctx.ui.notify(`Default backend: ${activeBackend}\nRoles: ${roleNames.join(", ") || "none"}`, "info");
    } else {
      ctx.ui.notify("Usage: /subagents [status|codex|claude|pi|--use-codex|--use-claude] or /subagents-config <backend>", "warning");
    }
  };

  pi.registerCommand("subagents", {
    description: "Open the subagent dashboard; status/backend arguments retain configuration behavior.",
    getArgumentCompletions: (prefix) => ["status", ...BACKENDS, "--use-codex", "--use-claude"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (args.trim()) await configure(args, ctx);
      else await openSubagentsDashboard(ctx, getManager());
    },
  });

  pi.registerCommand("subagents-config", {
    description: "Show or switch the default native subagent backend.",
    getArgumentCompletions: (prefix) => ["status", ...BACKENDS].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: configure,
  });

  const spawnParameters = Type.Object({
    role: roleSchema,
    task: Type.String({ minLength: 1, maxLength: 100_000 }),
    cwd: Type.Optional(Type.String()),
    backend: Type.Optional(StringEnum(BACKENDS)),
    modelTier: Type.Optional(StringEnum(TIERS)),
    effort: Type.Optional(StringEnum(EFFORTS, { description: "Optional provider effort hint; omitted by default for adaptive behavior" })),
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: `Spawn a native background subagent. Roles: ${roleNames.join(", ") || "none"}. Maximum four jobs run concurrently. Unconsumed results are delivered automatically as one follow-up.`,
    promptSnippet: "Spawn a native Pi, Claude Code, or Codex subagent in the background",
    parameters: spawnParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = spawn(getManager(), params, ctx.cwd, ctx.isProjectTrusted(), undefined, providerFamily(ctx.model?.provider));
      return result(snapshot, `Spawned ${snapshot.id} (${snapshot.role}, ${snapshot.backend}/${snapshot.model})`);
    },
    renderCall(args, theme) {
      const route = args.backend
        ? `${args.backend}${args.modelTier ? `/${args.modelTier}` : ""}`
        : roles.get(args.role)?.differentProviderFromParent ? "cross-provider" : args.modelTier ?? "";
      const detail = [route, args.effort ? `effort:${args.effort}` : "", truncatePreview(args.task)].filter(Boolean).join(" · ");
      return renderToolCallLine(theme, "Spawn", args.role, detail);
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderToolCallLine(theme, "Spawn", "failed");
      return renderLiveJob(job, theme, { expanded, isPartial }, context);
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: "Check one background subagent without waiting.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const snapshot = getManager().check(params.jobId);
      return result(snapshot, statusLine(snapshot));
    },
    renderCall(args, theme) {
      return renderToolCallLine(theme, "Inspect", shortId(args.jobId));
    },
    renderResult(res, { expanded }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderToolCallLine(theme, "Inspect", "not found");
      return renderLiveJob(job, theme, { expanded, receipt: "Checked" }, context);
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait for a background subagent to finish, or return its current state after a timeout.",
    parameters: Type.Object({
      jobId: Type.String(),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
    }),
    async execute(_id, params, signal, onUpdate) {
      const manager = getManager();
      const generation = beginResultConsumption(params.jobId);
      let consumed = false;
      const timer = setInterval(() => {
        const current = manager.check(params.jobId);
        onUpdate?.({ content: [{ type: "text", text: statusLine(current) }], details: { job: compactJob(current) } });
      }, 500);
      timer.unref();
      try {
        const snapshot = await manager.wait(params.jobId, { timeoutMs: params.timeoutMs ?? 600_000, signal });
        consumed = isTerminal(snapshot.status);
        return result(snapshot, terminalText(snapshot));
      } finally {
        clearInterval(timer);
        endResultConsumption(params.jobId, generation, consumed);
      }
    },
    renderCall(args, theme) {
      const timeout = args.timeoutMs ? `timeout ${Math.round(args.timeoutMs / 1000)}s` : undefined;
      return renderToolCallLine(theme, "Wait", shortId(args.jobId), timeout);
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderToolCallLine(theme, "Wait", "not found");
      return renderLiveJob(job, theme, {
        expanded,
        isPartial,
        receipt: (current) => isTerminal(current.status) ? "Wait complete" : "Waiting on",
      }, context);
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: "Steer an active subagent now or queue a follow-up on its native session.",
    parameters: Type.Object({
      jobId: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 100_000 }),
      behavior: Type.Optional(StringEnum(["steer", "followUp"] as const)),
    }),
    async execute(_id, params) {
      const snapshot = await getManager().send(params.jobId, params.message, (params.behavior ?? "steer") as SendBehavior);
      return result(snapshot, `Sent ${params.behavior ?? "steer"} message to ${snapshot.id}`);
    },
    renderCall(args, theme) {
      const resolved = (args.behavior ?? "steer") as SendBehavior;
      const behavior = sendBehaviorLabel(resolved);
      return renderToolCallLine(theme, sendTitle(resolved), shortId(args.jobId), `${behavior}: ${truncatePreview(args.message)}`);
    },
    renderResult(res, { expanded }, theme, context) {
      const resolved = ((context.args as { behavior?: SendBehavior } | undefined)?.behavior ?? "steer") as SendBehavior;
      const job = jobOf(res);
      if (!job) return renderToolCallLine(theme, sendTitle(resolved), "failed");
      const behavior = sendBehaviorLabel(resolved);
      return renderLiveJob(job, theme, {
        expanded,
        lead: theme.fg("success", `✓ Sent ${behavior} message`),
        receipt: behavior === "follow-up" ? "Follow-up sent" : "Steer sent",
      }, context);
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagent",
    description: "Cancel a queued or running background subagent and tear down its process tree.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const generation = beginResultConsumption(params.jobId);
      let consumed = false;
      try {
        const snapshot = await getManager().cancel(params.jobId);
        consumed = isTerminal(snapshot.status);
        return result(snapshot, statusLine(snapshot));
      } finally {
        endResultConsumption(params.jobId, generation, consumed);
      }
    },
    renderCall(args, theme) {
      return renderToolCallLine(theme, "Cancel", shortId(args.jobId));
    },
    renderResult(res, { expanded }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderToolCallLine(theme, "Cancel", "failed");
      return renderLiveJob(job, theme, { expanded, receipt: "Cancel complete" }, context);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all jobs scoped to the current Pi session.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = getManager().list();
      const text = jobs.length ? jobs.map(statusLine).join("\n") : "No subagent jobs in this session.";
      return { content: [{ type: "text", text }], details: { jobs: jobs.map(compactJob) } };
    },
    renderCall(_args, theme) {
      return renderToolCallLine(theme, "List", "session jobs");
    },
    renderResult(res, { expanded }, theme, context) {
      const jobs = (res.details as { jobs?: JobSnapshot[] } | undefined)?.jobs ?? [];
      return renderLiveList(jobs, theme, expanded, context);
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Compatibility foreground subagent call. Runs one role and waits for completion. Default backend: ${activeBackend}.`,
    promptSnippet: `Run an isolated subagent: ${roleNames.join(", ") || "none"}`,
    promptGuidelines: [
      "Use subagent_spawn for independent work that can run in parallel; use subagent_wait before consuming its result.",
      "Use subagent for a single compatibility foreground delegation.",
      "Subagents have isolated context; include all required paths, requirements, constraints, and verification evidence in task.",
    ],
    parameters: Type.Object({
      agent: roleSchema,
      task: Type.String({ minLength: 1, maxLength: 100_000 }),
      cwd: Type.Optional(Type.String()),
      backend: Type.Optional(StringEnum(BACKENDS)),
      modelProfile: Type.Optional(StringEnum(BACKENDS)),
      modelTier: Type.Optional(StringEnum(TIERS)),
      effort: Type.Optional(StringEnum(EFFORTS, { description: "Optional provider effort hint; omitted by default for adaptive behavior" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const snapshot = spawn(getManager(), {
        role: params.agent, task: params.task, cwd: params.cwd,
        backend: params.backend ?? params.modelProfile, modelTier: params.modelTier, effort: params.effort,
      }, ctx.cwd, ctx.isProjectTrusted(), roles.get(params.agent)?.lockedBackend || roles.get(params.agent)?.differentProviderFromParent ? undefined : activeBackend, providerFamily(ctx.model?.provider));
      const generation = beginResultConsumption(snapshot.id);
      let consumed = false;
      const timer = setInterval(() => {
        const current = getManager().check(snapshot.id);
        onUpdate?.({ content: [{ type: "text", text: statusLine(current) }], details: { job: compactJob(current) } });
      }, 500);
      timer.unref();
      try {
        const final = await getManager().wait(snapshot.id, { signal });
        if (!isTerminal(final.status)) throw new Error("Subagent wait ended before completion");
        consumed = true;
        if (final.status === "failed") throw new Error(final.error ?? "Subagent failed");
        return result(final, terminalText(final));
      } catch (error) {
        if (signal?.aborted) await getManager().cancel(snapshot.id, "Parent tool aborted");
        throw error;
      } finally {
        clearInterval(timer);
        endResultConsumption(snapshot.id, generation, consumed);
      }
    },
    renderCall(args, theme) {
      const role = roles.get(args.agent);
      const backend = args.backend ?? args.modelProfile ?? role?.lockedBackend ?? (role?.differentProviderFromParent ? "cross-provider" : activeBackend);
      const route = args.modelTier ? `${backend}/${args.modelTier}` : backend;
      const effort = args.effort ? ` · effort:${args.effort}` : "";
      return renderToolCallLine(theme, "Run", args.agent, `[${route}${effort}] ${truncatePreview(args.task)}`);
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderToolCallLine(theme, "Run", "failed");
      return renderLiveJob(job, theme, { expanded, isPartial }, context);
    },
  });
}

function sendTitle(behavior: SendBehavior): "Steer" | "Follow up" {
  return behavior === "followUp" ? "Follow up" : "Steer";
}

function spawn(
  manager: JobManager,
  params: { role: string; task: string; cwd?: string; backend?: BackendName; modelTier?: ModelTier; effort?: EffortLevel },
  parentCwd: string,
  trusted: boolean,
  compatibilityBackend?: BackendName,
  parentProvider?: ProviderFamily,
): JobSnapshot {
  const cwd = secureCwd(parentCwd, params.cwd);
  const depth = Number.parseInt(process.env.PI_NATIVE_SUBAGENTS_DEPTH ?? "0", 10) || 0;
  return manager.spawn({
    role: params.role,
    task: params.task,
    cwd,
    trusted,
    backend: resolveBackendOverride(params.backend, params.modelTier, compatibilityBackend),
    tier: params.modelTier,
    effort: params.effort,
    parentProvider,
    depth,
  });
}

function secureCwd(parentCwd: string, requested?: string): string {
  const root = realpathSync(parentCwd);
  const candidatePath = resolve(root, requested ?? ".");
  if (!existsSync(candidatePath)) throw new Error(`Subagent cwd does not exist: ${candidatePath}`);
  const candidate = realpathSync(candidatePath);
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Subagent cwd must stay within the trusted project directory");
  }
  return candidate;
}

export function configuredBackendFromEnv(env: NodeJS.ProcessEnv): BackendName {
  return normalizeBackend(env.PI_NATIVE_SUBAGENTS_BACKEND)
    ?? normalizeBackend(env.PI_SUBAGENTS_PROFILE)
    ?? "codex";
}

export function resolveBackendOverride(
  requested: BackendName | undefined,
  tier: ModelTier | undefined,
  compatibilityBackend?: BackendName,
): BackendName | undefined {
  return requested ?? (tier ? undefined : compatibilityBackend);
}

export function normalizeBackend(value: unknown): BackendName | undefined {
  const text = String(value ?? "").trim().toLowerCase().replace(/^--use-/, "");
  if (text === "codex" || text === "openai" || text === "gpt") return "codex";
  if (text === "claude" || text === "anthropic") return "claude";
  if (text === "pi") return "pi";
  return undefined;
}

function updateStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }, manager: JobManager, backend: BackendName): void {
  const jobs = manager.list();
  const running = jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const finished = jobs.filter((job) => isTerminal(job.status)).length;
  ctx.ui.setStatus("native-subagents", `subagents:${backend}${running ? ` ${running}↻` : ""}${finished ? ` ${finished}✓` : ""}`);
}

function statusLine(job: JobSnapshot): string {
  return `${job.id} ${job.status} ${job.role} [${job.backend}/${job.model}]`;
}
function terminalText(job: JobSnapshot): string {
  if (job.status === "completed") return job.output || "(completed with no text output)";
  if (job.status === "failed" || job.status === "cancelled") return `${statusLine(job)}\n${job.error ?? ""}`.trim();
  return statusLine(job);
}
function compactJob(job: JobSnapshot): JobSnapshot {
  return { ...job, transcript: [], liveThinking: "", queuedMessages: [] };
}
function result(job: JobSnapshot, text: string) {
  return { content: [{ type: "text" as const, text }], details: { job: compactJob(job) } };
}
function jobOf(res: { details?: unknown }): JobSnapshot | undefined {
  return (res.details as { job?: JobSnapshot } | undefined)?.job;
}
