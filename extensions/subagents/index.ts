import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ClaudeBackend, CodexAppServerBackend, PiRpcBackend } from "../../src/backends/index.ts";
import { isTerminal, JobManager } from "../../src/manager.ts";
import { claimExtensionInstall } from "../../src/install-guard.ts";
import { providerFamily } from "../../src/policy.ts";
import { loadModelRouting, type ModelRoutingConfig } from "../../src/model-routing.ts";
import { openSubagentsDashboard } from "./dashboard.ts";
import {
  formatEffort,
  linesComponent,
  renderJobCard,
  renderJobListCard,
  renderJobReceipt,
  renderToolCallLine,
  sendBehaviorLabel,
  shortId,
  traceResultLine,
  truncatePreview,
} from "./render.ts";
import { loadProfiles, type ProfileCatalog } from "../../src/profiles.ts";
import type { AccessMode, Backend, BackendName, EffortLevel, JobSnapshot, ModelTier, ProviderFamily, SendBehavior } from "../../src/types.ts";
import { registerWorkflows } from "../workflows/index.ts";

/** The configured expand-key hint (e.g. "ctrl+o to expand"), threaded into render options so render.ts stays testable without live keybinding state. */
function expandHint(): string {
  // Tool renderers can be invoked by headless hosts before Pi's interactive theme initializes.
  try { return keyHint("app.tools.expand", "to expand"); }
  catch { return "to expand"; }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_ENTRY = "native-subagents-profile";
const SUBAGENT_RESULT_MESSAGE = "native-subagent-result";
const BACKENDS = ["codex", "claude", "pi"] as const;
const TIERS = ["economy", "balanced", "quality"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const ACCESS = ["readOnly", "full"] as const;

export interface RegistrationOptions {
  registry?: object;
  legacyRoot?: string | false;
  backends?: Backend[];
  workflowArtifactRoot?: string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  globalProfilesDir?: string;
  /** Test seam for the administrator-owned, global-only model routing file. */
  globalConfigPath?: string;
}

interface LiveCardBlink {
  invalidate?: () => void;
  shouldContinue?: () => boolean;
}

interface LiveCardRenderState {
  nativeSubagentBlink?: LiveCardBlink;
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
  const globalProfilesDir = options.globalProfilesDir ?? resolve(getAgentDir(), "subagents");
  const globalConfigPath = options.globalConfigPath ?? resolve(getAgentDir(), "subagents.json");
  let profileCatalog: ProfileCatalog = loadProfiles(globalProfilesDir);
  let modelRouting: ModelRoutingConfig = loadModelRouting(globalConfigPath);
  const configuredBackend = configuredBackendFromEnv(process.env);
  let activeBackend = configuredBackend;
  let manager: JobManager | undefined;
  let unsubscribeManager: (() => void) | undefined;
  let sessionContext: { isIdle(): boolean } | undefined;
  const deferredResults = new Map<string, JobSnapshot>();
  const cardSnapshots = new Map<string, JobSnapshot>();
  const liveCardBlinks = new Set<LiveCardBlink>();
  const scheduleBlink = options.setInterval ?? setInterval;
  const cancelBlink = options.clearInterval ?? clearInterval;
  let liveCardTicker: ReturnType<typeof setInterval> | undefined;
  const waitInterest = new Map<string, number>();
  const consumedResults = new Set<string>();
  const resultKey = (id: string, generation: number) => `${id}:${generation}`;

  const createManager = () => new JobManager({
    profiles: profileCatalog.profiles,
    mappings: modelRouting.mappings,
    concurrency: 4,
    backends: options.backends ?? [new PiRpcBackend(), new ClaudeBackend(), new CodexAppServerBackend()],
  });
  const getManager = () => manager ??= createManager();
  const jobCallTarget = (jobId: string): { accent: string; detail: string } => {
    try {
      const job = manager?.check(jobId);
      if (!job) throw new Error("Job manager is not active");
      return { accent: job.name, detail: shortId(job.id) };
    } catch {
      return { accent: shortId(jobId), detail: "" };
    }
  };
  const renderFailure = (theme: Theme, text: string) => linesComponent([traceResultLine(theme, "×", text, "error")]);
  const stopCardBlink = (blink: LiveCardBlink) => {
    blink.invalidate = undefined;
    blink.shouldContinue = undefined;
    liveCardBlinks.delete(blink);
    if (!liveCardBlinks.size && liveCardTicker) {
      cancelBlink(liveCardTicker);
      liveCardTicker = undefined;
    }
  };
  const clearCardBlinks = () => {
    for (const blink of liveCardBlinks) {
      blink.invalidate = undefined;
      blink.shouldContinue = undefined;
    }
    liveCardBlinks.clear();
    if (liveCardTicker) cancelBlink(liveCardTicker);
    liveCardTicker = undefined;
  };
  const syncCardBlink = (context: LiveCardRenderContext | undefined, active: boolean, shouldContinue: () => boolean) => {
    if (!context?.state) return;
    const blink = context.state.nativeSubagentBlink ??= {};
    if (!active) return stopCardBlink(blink);
    blink.invalidate = context.invalidate;
    blink.shouldContinue = shouldContinue;
    liveCardBlinks.add(blink);
    if (liveCardTicker) return;
    liveCardTicker = scheduleBlink(() => {
      for (const current of [...liveCardBlinks]) {
        if (!current.shouldContinue?.()) {
          stopCardBlink(current);
          continue;
        }
        try { current.invalidate?.(); }
        catch { stopCardBlink(current); }
      }
    }, 500);
    liveCardTicker.unref?.();
  };
  const refreshCardBlinks = () => {
    for (const blink of [...liveCardBlinks]) {
      const keep = blink.shouldContinue?.() === true;
      try { blink.invalidate?.(); }
      catch { stopCardBlink(blink); continue; }
      if (!keep) stopCardBlink(blink);
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
    syncCardBlink(context, active, () => {
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
    syncCardBlink(
      context,
      !!manager && jobs.some((job) => !isTerminal(job.status)),
      () => !!manager && manager.list().some((job) => !isTerminal(job.status)),
    );
    return renderJobListCard(jobs, theme, { expanded, now: Date.now() });
  };
  const workflows = registerWorkflows(pi, {
    artifactRoot: options.workflowArtifactRoot,
    defaultBackend: () => activeBackend,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE, (message, { expanded }, theme) => {
    const job = (message.details as { job?: JobSnapshot } | undefined)?.job;
    if (!job) return renderToolCallLine(theme, "Inspect", "subagent result unavailable");
    return renderJobCard(job, theme, { expanded, now: Date.now(), expandHint: expandHint(), standalone: true });
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
    clearCardBlinks();
    profileCatalog = loadProfiles(
      globalProfilesDir,
      ctx.isProjectTrusted() ? resolve(ctx.cwd, CONFIG_DIR_NAME, "subagents") : undefined,
    );
    modelRouting = loadModelRouting(globalConfigPath);
    manager = createManager();
    sessionContext = ctx;
    deferredResults.clear();
    cardSnapshots.clear();
    waitInterest.clear();
    consumedResults.clear();
    activeBackend = configuredBackend;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data as { backend?: unknown } | undefined;
      const restored = entry.customType === STATE_ENTRY ? normalizeBackend(data?.backend) : undefined;
      if (restored) activeBackend = restored;
    }
    const sessionManager = manager;
    unsubscribeManager = sessionManager.subscribe((job, event) => {
      rememberCardSnapshot(job);
      refreshCardBlinks();
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
    clearCardBlinks();
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
      ctx.ui.notify(`Default backend: ${activeBackend}\nProfiles: ${profileCatalog.profiles.size}\nModel routing: ${modelRouting.source === "global" ? modelRouting.path : "built-in"} (${modelRouting.warnings.length} warnings)`, modelRouting.warnings.length ? "warning" : "info");
    } else if (value === "models") {
      const mappings = ["codex", "claude", "pi"].map((backend) => {
        const tiers = modelRouting.mappings[backend as BackendName];
        return `${backend}: economy=${tiers.economy}, balanced=${tiers.balanced}, quality=${tiers.quality}`;
      });
      const source = `Source: ${modelRouting.source === "global" ? modelRouting.path : "built-in fallback"}`;
      const warnings = modelRouting.warnings.map((warning) => `Warning [${warning.code}] ${warning.path}: ${warning.message}`);
      ctx.ui.notify([source, ...mappings, ...warnings].join("\n"), warnings.length ? "warning" : "info");
    } else if (value === "profiles") {
      const resolved = [...profileCatalog.profiles.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((profile) => `${profile.name} (${profile.origin}) — ${profile.filePath}`);
      const warnings = profileCatalog.warnings.map((warning) => `Warning (${warning.origin}) ${warning.filePath}: ${warning.message}`);
      ctx.ui.notify([...resolved, ...warnings].join("\n") || "No subagent profiles configured.", warnings.length ? "warning" : "info");
    } else {
      ctx.ui.notify("Usage: /subagents [status|models|profiles|codex|claude|pi|--use-codex|--use-claude] or /subagents-config <backend>", "warning");
    }
  };

  pi.registerCommand("subagents", {
    description: "Open the subagent dashboard; inspect model tiers with /subagents models.",
    getArgumentCompletions: (prefix) => ["status", "models", "profiles", ...BACKENDS, "--use-codex", "--use-claude"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
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
    task: Type.String({ minLength: 1, maxLength: 100_000 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    cwd: Type.Optional(Type.String()),
    backend: Type.Optional(StringEnum(BACKENDS)),
    modelTier: Type.Optional(StringEnum(TIERS)),
    effort: Type.Optional(StringEnum(EFFORTS, { description: "Optional provider effort hint; omitted by default for adaptive behavior" })),
    access: Type.Optional(StringEnum(ACCESS, { description: "Access policy; defaults to full after project trust is established" })),
    independent: Type.Optional(Type.Boolean({ description: "Require a native provider different from the parent" })),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Human-authored profile name; omit unless the human explicitly requested one" })),
  });

  pi.registerTool({
    name: "subagent_spawn",
    renderShell: "self",
    label: "Spawn Subagent",
    description: "Spawn a generic task-driven native background subagent. Maximum four jobs run concurrently. Unconsumed results are delivered automatically as one follow-up.",
    promptSnippet: "Spawn a native Pi, Claude Code, or Codex subagent in the background",
    promptGuidelines: [
      "Give each isolated agent a complete task with all relevant paths, requirements, constraints, and expected verification.",
      "Omit profile by default; use a profile only when the human explicitly requests that named profile.",
      "Use access=readOnly for inspection and independent=true for a cross-provider second opinion.",
    ],
    parameters: spawnParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rejectLegacyParams(params);
      const snapshot = spawn(getManager(), params, ctx.cwd, ctx.isProjectTrusted(), activeBackend, providerFamily(ctx.model?.provider));
      return result(snapshot, `Spawned ${snapshot.id} (${snapshot.name}, ${snapshot.access}, ${snapshot.backend}/${snapshot.model}, effort ${formatEffort(snapshot.effort)})`);
    },
    renderCall(args, theme) {
      const route = args.independent ? "independent" : args.backend
        ? `${args.backend}${args.modelTier ? `/${args.modelTier}` : ""}`
        : args.modelTier ?? "";
      const detail = [args.access ?? "full", args.profile ? `profile:${args.profile}` : "", route, args.effort ? `effort:${args.effort}` : "", truncatePreview(args.task)].filter(Boolean).join(" · ");
      return renderToolCallLine(theme, "Spawn", args.name ?? "agent", detail);
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "spawn failed");
      return renderLiveJob(job, theme, { expanded, isPartial }, context);
    },
  });

  pi.registerTool({
    name: "subagent_check",
    renderShell: "self",
    label: "Check Subagent",
    description: "Check one background subagent without waiting.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const snapshot = getManager().check(params.jobId);
      return result(snapshot, statusLine(snapshot));
    },
    renderCall(args, theme) {
      const target = jobCallTarget(args.jobId);
      return renderToolCallLine(theme, "Inspect", target.accent, target.detail);
    },
    renderResult(res, { expanded }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "subagent not found");
      return renderLiveJob(job, theme, { expanded, receipt: (current) => current.status }, context);
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    renderShell: "self",
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
      const target = jobCallTarget(args.jobId);
      const timeout = args.timeoutMs ? `timeout ${Math.round(args.timeoutMs / 1000)}s` : "";
      return renderToolCallLine(theme, "Wait", target.accent, [target.detail, timeout].filter(Boolean).join(" · "));
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "subagent not found");
      return renderLiveJob(job, theme, {
        expanded,
        isPartial,
        receipt: (current) => isTerminal(current.status) ? current.status : "waiting",
      }, context);
    },
  });

  pi.registerTool({
    name: "subagent_send",
    renderShell: "self",
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
      const target = jobCallTarget(args.jobId);
      return renderToolCallLine(theme, sendTitle(resolved), target.accent, [target.detail, truncatePreview(args.message)].filter(Boolean).join(" · "));
    },
    renderResult(res, { expanded }, theme, context) {
      const resolved = ((context.args as { behavior?: SendBehavior } | undefined)?.behavior ?? "steer") as SendBehavior;
      const job = jobOf(res);
      if (!job) return renderFailure(theme, `${sendBehaviorLabel(resolved)} failed`);
      const behavior = sendBehaviorLabel(resolved);
      return renderLiveJob(job, theme, {
        expanded,
        receipt: behavior === "follow-up" ? "follow-up sent" : "steer sent",
      }, context);
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    renderShell: "self",
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
      const target = jobCallTarget(args.jobId);
      return renderToolCallLine(theme, "Cancel", target.accent, target.detail);
    },
    renderResult(res, { expanded }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "cancel failed");
      return renderLiveJob(job, theme, { expanded, receipt: (current) => current.status }, context);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    renderShell: "self",
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
    renderShell: "self",
    label: "Subagent",
    description: `Foreground convenience for one generic task-driven subagent. Default backend: ${activeBackend}.`,
    promptSnippet: "Run one isolated generic subagent and wait for its result",
    promptGuidelines: [
      "Use subagent_spawn for independent work that can run in parallel; use subagent_wait before consuming its result.",
      "Use subagent for a single foreground delegation.",
      "Subagents have isolated context; include all required paths, requirements, constraints, and verification evidence in task.",
      "Use access=readOnly for inspection and independent=true for a cross-provider second opinion.",
      "Omit profile by default; use a profile only when the human explicitly requests that named profile.",
    ],
    parameters: spawnParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      rejectLegacyParams(params);
      const snapshot = spawn(getManager(), params, ctx.cwd, ctx.isProjectTrusted(), activeBackend, providerFamily(ctx.model?.provider));
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
      const backend = args.independent ? "independent" : args.backend ?? activeBackend;
      const route = args.modelTier ? `${backend}/${args.modelTier}` : backend;
      const effort = args.effort ? ` · effort:${args.effort}` : "";
      const profile = args.profile ? ` · profile:${args.profile}` : "";
      return renderToolCallLine(theme, "Run", args.name ?? "agent", `[${route}${effort}${profile}] ${truncatePreview(args.task)}`);
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "subagent failed");
      return renderLiveJob(job, theme, { expanded, isPartial }, context);
    },
  });
}

function rejectLegacyParams(params: object): void {
  if (Object.hasOwn(params, "role") || Object.hasOwn(params, "agent") || Object.hasOwn(params, "modelProfile")) {
    throw new Error("Legacy role, agent, and modelProfile arguments are not supported");
  }
}

function sendTitle(behavior: SendBehavior): "Steer" | "Follow up" {
  return behavior === "followUp" ? "Follow up" : "Steer";
}

function spawn(
  manager: JobManager,
  params: { task: string; name?: string; cwd?: string; backend?: BackendName; modelTier?: ModelTier; effort?: EffortLevel; access?: AccessMode; independent?: boolean; profile?: string },
  parentCwd: string,
  trusted: boolean,
  defaultBackend?: BackendName,
  parentProvider?: ProviderFamily,
): JobSnapshot {
  const cwd = secureCwd(parentCwd, params.cwd);
  return manager.spawn({
    name: params.name,
    task: params.task,
    cwd,
    trusted,
    backend: params.backend,
    modelTier: params.modelTier,
    effort: params.effort,
    access: params.access,
    independent: params.independent,
    profile: params.profile,
    defaultBackend,
    parentProvider,
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
  return normalizeBackend(env.PI_NATIVE_SUBAGENTS_BACKEND) ?? "codex";
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
  const profile = job.profile ? `; profile ${job.profile}` : "";
  return `${job.id} ${job.status} ${job.name} [${job.access}; ${job.backend}/${job.model}; effort ${formatEffort(job.effort)}${profile}]`;
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
