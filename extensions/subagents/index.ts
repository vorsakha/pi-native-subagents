import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, keyHint, SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ClaudeBackend, CodexAppServerBackend, PiRpcBackend } from "../../src/backends/index.ts";
import { PI_CHILD_MARKER } from "../../src/backends/pi-rpc.ts";
import {
  CAPABILITY_EFFECTS,
  CAPABILITY_KINDS,
  capabilityAvailability,
  DEFAULT_SEARCH_LIMIT,
  formatCapabilityLine,
  formatCatalogSummary,
  MAX_REQUIREMENTS,
  MAX_REQUIREMENT_LENGTH,
  MAX_SEARCH_LIMIT,
  normalizeCapability,
  type CapabilityEffect,
  type CapabilityKind,
} from "../../src/capabilities.ts";
import { routeCapabilities, type RequestedHarness } from "../../src/capability-routing.ts";
import { CapabilityService, type CapabilityRouter } from "../../src/capability-service.ts";
import {
  formatProviderStatusReport,
  ProviderStatusService,
  type ProviderStatusReader,
} from "../../src/provider-status.ts";
import { isTerminal, JobManager } from "../../src/manager.ts";
import { claimExtensionInstall } from "../../src/install-guard.ts";
import { providerFamily } from "../../src/policy.ts";
import { captureParentThread, type ParentThreadSnapshot } from "../../src/parent-thread-context.ts";
import { openSubagentsDashboard } from "./dashboard.ts";
import {
  emptyComponent,
  formatEffort,
  linesComponent,
  MAX_COLLAPSED_LINES,
  MAX_EXPANDED_LINES,
  renderJobCard,
  renderJobListCard,
  renderPeerListCard,
  renderJobReceipt,
  renderToolCallLine,
  sendBehaviorLabel,
  shortId,
  traceResultLine,
  truncatePreview,
} from "./render.ts";
import { loadProfiles, type ProfileCatalog } from "../../src/profiles.ts";
import {
  DEFAULT_PEER_LIST_LIMIT,
  forkPeerSession,
  listPeerSessions,
  MAX_PEER_LIST_LIMIT,
  type PeerSessionSummary,
  type SessionPeerSource,
} from "../../src/session-peers.ts";
import type { AccessMode, Backend, HarnessName, EffortLevel, JobSnapshot, ProfileDefinition, ProviderFamily, SendBehavior } from "../../src/types.ts";
import type { SpendBudget } from "../../src/budget.ts";
import { formatSpendBudget } from "../../src/budget.ts";
import { registerWorkflows } from "../workflows/index.ts";

/** Production session-peer source backed by Pi's real SessionManager. Never mutates the source session. */
export function createRealSessionPeerSource(): SessionPeerSource {
  return {
    async listAll(sessionDir) {
      const sessions = await SessionManager.listAll(sessionDir);
      return sessions.map((session) => ({
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        name: session.name,
        createdAt: session.created.getTime(),
        modifiedAt: session.modified.getTime(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
      }));
    },
    fork(sourcePath, targetCwd, sessionDir) {
      const forked = SessionManager.forkFrom(sourcePath, targetCwd, sessionDir);
      const sessionFile = forked.getSessionFile();
      if (!sessionFile) throw new Error("Session peer fork could not be persisted");
      return { sessionFile, sessionId: forked.getSessionId() };
    },
  };
}

/** The configured expand-key hint (e.g. "ctrl+o to expand"), threaded into render options so render.ts stays testable without live keybinding state. */
function expandHint(): string {
  // Tool renderers can be invoked by headless hosts before Pi's interactive theme initializes.
  try { return keyHint("app.tools.expand", "to expand"); }
  catch { return "to expand"; }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_ENTRY = "native-subagents-harness";
const SUBAGENT_RESULT_MESSAGE = "native-subagent-result";
const HARNESSES = ["codex", "claude", "pi"] as const;
const REQUESTED_HARNESSES = ["codex", "claude", "pi", "auto"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const ACCESS = ["readOnly", "full"] as const;
const MAX_CAPABILITY_LINES = 40;
const HUMAN_SUBAGENT_ENTRY = "native-human-subagent";
const SUBAGENT_ACTIVITY_WIDGET = "native-subagents-active";
const HUMAN_SUBAGENT_USAGE = "/subagent [--harness pi|claude|codex] [--model ID] [--name NAME] [--effort LEVEL] [--access readOnly|full] [--max-tokens N] [--max-cost USD] [--max-turns N] [--cwd PATH] [--profile NAME] [--independent] <task>";

export interface ActivitySegment {
  owner: "direct" | "workflow";
  running: number;
  queued: number;
  summary: string;
  breakdown: string;
  pointer: string;
}

export interface SubagentActivity {
  segments: ActivitySegment[];
  pointers: string[];
  key: string;
  text: string;
}

/** Buckets active jobs by ownership so the activity widget can point to the right dashboard(s) without conflating counts. */
export function summarizeSubagentActivity(
  jobs: ReadonlyArray<Pick<JobSnapshot, "status" | "workflow">>,
): SubagentActivity {
  const counts = {
    direct: { running: 0, queued: 0 },
    workflow: { running: 0, queued: 0 },
  };
  for (const job of jobs) {
    if (job.status !== "running" && job.status !== "queued") continue;
    counts[job.workflow ? "workflow" : "direct"][job.status]++;
  }

  const owners: Array<{ owner: "direct" | "workflow"; noun: string; pointer: string }> = [
    { owner: "direct", noun: "subagent", pointer: "/subagents" },
    { owner: "workflow", noun: "workflow agent", pointer: "/workflows" },
  ];
  const active = owners.filter(({ owner }) => counts[owner].running + counts[owner].queued > 0);
  const segments: ActivitySegment[] = active.map(({ owner, noun, pointer }) => {
    const { running, queued } = counts[owner];
    const total = running + queued;
    const plural = (n: number) => `${noun}${n === 1 ? "" : "s"}`;
    const summary = queued === 0
      ? `${running} ${plural(running)} running`
      : running === 0
        ? `${queued} ${plural(queued)} queued`
        : `${total} ${plural(total)} active`;
    const breakdown = running && queued
      ? active.length > 1
        ? ` (${running} running · ${queued} queued)`
        : ` · ${running} running · ${queued} queued`
      : "";
    return { owner, running, queued, summary, breakdown, pointer };
  });

  const pointers = segments.map((segment) => segment.pointer);
  const key = `${counts.direct.running}:${counts.direct.queued}:${counts.workflow.running}:${counts.workflow.queued}`;
  const text = segments.length
    ? `◆ ${segments.map((segment) => `${segment.summary}${segment.breakdown}`).join(" · ")} • ${pointers.join(" · ")}${pointers.length === 1 ? " to view" : ""}`
    : "";

  return { segments, pointers, key, text };
}

interface HumanSubagentEntryData {
  job: JobSnapshot;
  /** Anchors are visible cards; updates are durable state deltas rendered through their anchor. */
  kind?: "anchor" | "update";
}

export interface RegistrationOptions {
  registry?: object;
  legacyRoot?: string | false;
  backends?: Backend[];
  workflowArtifactRoot?: string;
  savedWorkflowRoot?: string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  globalProfilesDir?: string;
  /** Injectable for tests; production uses the real Pi SessionManager. */
  sessionPeerSource?: SessionPeerSource;
  /** Injectable for tests; production probes the real provider CLIs. */
  providerStatus?: ProviderStatusReader;
  /** Injectable for tests; production reads the real process environment. */
  env?: NodeJS.ProcessEnv;
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
  const env = options.env ?? process.env;
  // A Pi child launched by this package must never register the delegation
  // surface again: nested orchestration is denied by construction, not by prompt.
  if (env[PI_CHILD_MARKER] === "1") return;
  const legacyRoot = options.legacyRoot === false
    ? undefined
    : options.legacyRoot ?? resolve(homedir(), ".pi/agent/extensions/subagents");
  const releaseInstall = claimExtensionInstall(ROOT, options.registry ?? globalThis, legacyRoot);
  const globalProfilesDir = options.globalProfilesDir ?? resolve(getAgentDir(), "subagents");
  const sessionPeers = options.sessionPeerSource ?? createRealSessionPeerSource();
  let profileCatalog: ProfileCatalog = loadProfiles(globalProfilesDir);
  const configuredHarness = configuredHarnessFromEnv(env);
  let activeHarness = configuredHarness;
  let manager: JobManager | undefined;
  let unsubscribeManager: (() => void) | undefined;
  let sessionContext: { isIdle(): boolean } | undefined;
  let sessionUi: ExtensionUIContext | undefined;
  let displayedHarness: HarnessName | undefined;
  let displayedActivity: string | undefined;
  const deferredResults = new Map<string, JobSnapshot>();
  const cardSnapshots = new Map<string, JobSnapshot>();
  const liveCardBlinks = new Set<LiveCardBlink>();
  const waitInterest = new Map<string, number>();
  const consumedResults = new Set<string>();
  const humanEntryReady = new Set<string>();
  const humanResultsPublished = new Set<string>();
  const pendingHumanResults = new Map<string, JobSnapshot>();
  const hiddenLegacyHumanEntries = new Set<string>();
  const resultKey = (id: string, generation: number) => `${id}:${generation}`;

  // The Pi adapter reports the parent's live tool/command inventory so Pi
  // capability discovery reflects what a child would actually load.
  const backends = options.backends ?? [
    new PiRpcBackend("pi", { parentInventory: () => ({ tools: parentTools(pi), commands: parentCommands(pi) }) }),
    new ClaudeBackend(),
    new CodexAppServerBackend(),
  ];
  const capabilities = new CapabilityService({ backends, env });
  // Pi readiness reuses the zero-turn capability catalog; Claude and Codex are
  // probed through their own account surfaces, never through a model request.
  const providerStatus = options.providerStatus ?? new ProviderStatusService({ piReadiness: capabilities, env });
  const createManager = () => new JobManager({
    profiles: profileCatalog.profiles,
    concurrency: 4,
    backends,
  });
  const getManager = () => manager ??= createManager();
  const updateSessionUi = (ui: ExtensionUIContext, sessionManager: JobManager, harness: HarnessName) => {
    if (displayedHarness !== harness) {
      displayedHarness = harness;
      ui.setStatus("native-subagents", `subagents:${harness}`);
    }

    const activity = summarizeSubagentActivity(sessionManager.list());
    if (displayedActivity === activity.key) return;
    displayedActivity = activity.key;

    if (!activity.segments.length) {
      ui.setWidget(SUBAGENT_ACTIVITY_WIDGET, undefined);
      return;
    }

    ui.setWidget(SUBAGENT_ACTIVITY_WIDGET, (_tui, theme) => {
      const summaries = activity.segments
        .map((segment) => theme.fg("text", segment.summary) + theme.fg("dim", segment.breakdown))
        .join(theme.fg("dim", " · "));
      const pointers = activity.pointers.map((pointer) => theme.fg("accent", pointer)).join(theme.fg("dim", " · "));
      const line =
        theme.fg("accent", "◆ ") +
        summaries +
        theme.fg("dim", " • ") +
        pointers +
        (activity.pointers.length === 1 ? theme.fg("dim", " to view") : "");
      return {
        render: (width: number) => [truncateToWidth(line, Math.max(0, width), "")],
        invalidate() {},
      };
    });
  };
  const spawnJob = (
    params: SpawnToolParams,
    ctx: { cwd: string; isProjectTrusted(): boolean; model?: { provider?: string } },
    signal?: AbortSignal,
    humanVisible = false,
    parentThread?: ParentThreadSnapshot,
  ) => spawn(getManager(), capabilities, params, {
    parentCwd: ctx.cwd,
    trusted: ctx.isProjectTrusted(),
    defaultHarness: activeHarness,
    parentProvider: providerFamily(ctx.model?.provider),
    profile: params.profile ? profileCatalog.profiles.get(params.profile.trim()) : undefined,
    humanVisible,
    humanPiTools: humanVisible ? permittedHumanPiToolNames(parentTools(pi)) : undefined,
    parentThread,
    signal,
  });
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
  };
  const clearCardBlinks = () => {
    for (const blink of liveCardBlinks) {
      blink.invalidate = undefined;
      blink.shouldContinue = undefined;
    }
    liveCardBlinks.clear();
  };
  const syncCardBlink = (context: LiveCardRenderContext | undefined, active: boolean, shouldContinue: () => boolean) => {
    if (!context?.state) return;
    const blink = context.state.nativeSubagentBlink ??= {};
    if (!active) return stopCardBlink(blink);
    blink.invalidate = context.invalidate;
    blink.shouldContinue = shouldContinue;
    liveCardBlinks.add(blink);
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
    const parentIsWaiting = active && (waitInterest.get(resultKey(current.job.id, current.job.generation)) ?? 0) > 0;
    return renderJobCard(current.job, theme, {
      ...options,
      now,
      statusLabel: parentIsWaiting ? "waiting" : undefined,
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
    savedWorkflowRoot: options.savedWorkflowRoot,
    defaultHarness: () => activeHarness,
    router: capabilities,
    resolveProfile: (name) => profileCatalog.profiles.get(name),
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE, (message, { expanded }, theme) => {
    const job = (message.details as { job?: JobSnapshot } | undefined)?.job;
    if (!job) return renderToolCallLine(theme, "Inspect", "subagent result unavailable");
    return renderJobCard(job, theme, { expanded, now: Date.now(), expandHint: expandHint(), standalone: true });
  });

  // Human-triggered jobs use durable TUI-only entries instead of custom messages,
  // so the orchestrator never receives a prompt or context update. The first entry
  // is the one visible card. Later entries persist state but render through that
  // anchor, preventing completion from creating a duplicate card.
  pi.registerEntryRenderer<HumanSubagentEntryData>(HUMAN_SUBAGENT_ENTRY, (entry, { expanded }, theme) => {
    const job = entry.data?.job;
    if (!job) return renderToolCallLine(theme, "Inspect", "human subagent entry unavailable");
    if (entry.data?.kind === "update" || hiddenLegacyHumanEntries.has(entry.id)) return emptyComponent();
    return {
      render(width: number) {
        const current = liveJob(job).job;
        return renderJobCard(current, theme, { expanded, now: Date.now(), expandHint: expandHint(), standalone: true }).render(width);
      },
      invalidate() {},
    };
  });

  const appendHumanEntry = (job: JobSnapshot, kind: "anchor" | "update") => {
    pi.appendEntry<HumanSubagentEntryData>(HUMAN_SUBAGENT_ENTRY, { job: compactJob(job), kind });
  };
  const publishHumanResult = (job: JobSnapshot) => {
    const key = resultKey(job.id, job.generation);
    if (humanResultsPublished.has(key)) return;
    if (!humanEntryReady.has(key) && job.generation === 0) {
      pendingHumanResults.set(key, job);
      return;
    }
    humanResultsPublished.add(key);
    rememberCardSnapshot(job);
    const kind = humanEntryReady.has(key) ? "update" : "anchor";
    if (kind === "anchor") humanEntryReady.add(key);
    appendHumanEntry(job, kind);
  };
  const appendHumanAnchor = (job: JobSnapshot) => {
    const key = resultKey(job.id, job.generation);
    humanEntryReady.add(key);
    appendHumanEntry(job, "anchor");
    const pending = pendingHumanResults.get(key);
    if (pending) {
      pendingHumanResults.delete(key);
      humanResultsPublished.add(key);
      rememberCardSnapshot(pending);
      appendHumanEntry(pending, "update");
    }
  };

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
    if (job.humanVisible) {
      publishHumanResult(job);
      return;
    }
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
    refreshCardBlinks();
    return generation;
  };
  const endResultConsumption = (id: string, generation: number, consumed: boolean) => {
    const key = resultKey(id, generation);
    const count = (waitInterest.get(key) ?? 1) - 1;
    if (count <= 0) waitInterest.delete(key);
    else waitInterest.set(key, count);
    refreshCardBlinks();
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
    displayedHarness = undefined;
    displayedActivity = undefined;
    sessionUi = ctx.ui;
    profileCatalog = loadProfiles(
      globalProfilesDir,
      ctx.isProjectTrusted() ? resolve(ctx.cwd, CONFIG_DIR_NAME, "subagents") : undefined,
    );
    manager = createManager();
    // A new session may open a different project or follow a configuration change.
    capabilities.invalidate();
    providerStatus.invalidate?.();
    sessionContext = ctx;
    deferredResults.clear();
    cardSnapshots.clear();
    waitInterest.clear();
    consumedResults.clear();
    humanEntryReady.clear();
    humanResultsPublished.clear();
    pendingHumanResults.clear();
    hiddenLegacyHumanEntries.clear();
    activeHarness = configuredHarness;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data as { harness?: unknown; job?: JobSnapshot; kind?: "anchor" | "update" } | undefined;
      const restored = entry.customType === STATE_ENTRY ? normalizeHarness(data?.harness) : undefined;
      if (restored) activeHarness = restored;
      if (entry.customType !== HUMAN_SUBAGENT_ENTRY || !data?.job) continue;
      const key = resultKey(data.job.id, data.job.generation);
      rememberCardSnapshot(data.job);
      if (data.kind === "update" || humanEntryReady.has(key)) hiddenLegacyHumanEntries.add(entry.id);
      else humanEntryReady.add(key);
      if (isTerminal(data.job.status)) humanResultsPublished.add(key);
    }
    const sessionManager = manager;
    unsubscribeManager = sessionManager.subscribe((job, event) => {
      rememberCardSnapshot(job);
      refreshCardBlinks();
      updateSessionUi(ctx.ui, sessionManager, activeHarness);
      if (event.type === "completed" || event.type === "failed" || (event.type === "cancelled" && event.reason !== "Session shutdown")) {
        if (job.humanVisible) publishHumanResult(job);
        else deferResult(job);
      }
    });
    updateSessionUi(ctx.ui, sessionManager, activeHarness);
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
    humanEntryReady.clear();
    humanResultsPublished.clear();
    pendingHumanResults.clear();
    hiddenLegacyHumanEntries.clear();
    try {
      sessionUi?.setStatus("native-subagents", undefined);
      sessionUi?.setWidget(SUBAGENT_ACTIVITY_WIDGET, undefined);
    } catch { /* UI may already be unavailable during teardown. */ }
    sessionUi = undefined;
    displayedHarness = undefined;
    displayedActivity = undefined;
    try {
      await workflows.sessionShutdown();
      await manager?.shutdown();
    }
    finally {
      manager = undefined;
      releaseInstall();
    }
  });

  /** Text inventory shared by `/subagents capabilities` and `subagent_capabilities`. */
  const capabilityReport = async (
    request: { cwd: string; access: AccessMode; refresh?: boolean; query?: string; harness?: HarnessName; kind?: CapabilityKind; effect?: CapabilityEffect; includeUnavailable?: boolean; limit?: number; signal?: AbortSignal },
  ): Promise<string> => {
    const found = await capabilities.search(request);
    const now = Date.now();
    const lines = [
      ...found.catalogs.map((catalog) => formatCatalogSummary(catalog, now)),
      "",
      found.matches.length
        ? `${found.matches.length} of ${found.total} capability match${found.total === 1 ? "" : "es"} under ${request.access} access:`
        : `No capability matches ${request.query ? `for "${request.query}" ` : ""}under ${request.access} access.`,
      ...found.matches.map((match) => formatCapabilityLine(match, now)),
    ];
    for (const catalog of found.catalogs) {
      for (const warning of catalog.warnings) lines.push(`warning (${catalog.harness}): ${warning}`);
    }
    return lines.slice(0, MAX_CAPABILITY_LINES).join("\n").trim();
  };

  const configure = async (args: string, ctx: ExtensionCommandContext) => {
    const value = args.trim().toLowerCase();
    const selected = normalizeHarness(value);
    if (selected) {
      activeHarness = selected;
      pi.appendEntry(STATE_ENTRY, { harness: selected });
      updateSessionUi(ctx.ui, getManager(), activeHarness);
      ctx.ui.notify(`Default subagent harness: ${selected}`, "info");
    } else if (value === "status") {
      ctx.ui.notify(`Default harness: ${activeHarness}\nProfiles: ${profileCatalog.profiles.size}\nModels: caller-selected or native harness default`, "info");
    } else if (value === "profiles") {
      const resolved = [...profileCatalog.profiles.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((profile) => `${profile.name} (${profile.origin}) — ${profile.filePath}`);
      const warnings = profileCatalog.warnings.map((warning) => `Warning (${warning.origin}) ${warning.filePath}: ${warning.message}`);
      ctx.ui.notify([...resolved, ...warnings].join("\n") || "No subagent profiles configured.", warnings.length ? "warning" : "info");
    } else if (value === "capabilities" || value.startsWith("capabilities ")) {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Subagent capability discovery is disabled for untrusted projects.", "warning");
        return;
      }
      const refresh = value.slice("capabilities".length).trim() === "refresh";
      try {
        ctx.ui.notify(await capabilityReport({ cwd: ctx.cwd, access: "full", refresh, includeUnavailable: true }), "info");
      } catch (error) {
        ctx.ui.notify(`Capability discovery failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    } else if (value === "providers" || value.startsWith("providers ")) {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Subagent provider status is disabled for untrusted projects.", "warning");
        return;
      }
      const refresh = value.slice("providers".length).trim() === "refresh";
      try {
        const statuses = await providerStatus.statuses({ cwd: ctx.cwd, refresh });
        ctx.ui.notify(formatProviderStatusReport(statuses, Date.now()), statuses.some((status) => status.ready) ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Provider status failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    } else {
      ctx.ui.notify("Usage: /subagents [status|profiles|providers [refresh]|capabilities [refresh]|codex|claude|pi|--use-codex|--use-claude] or /subagents-config <harness>", "warning");
    }
  };

  pi.registerCommand("subagents", {
    description: "Open the subagent dashboard; inspect profiles with /subagents profiles, provider login state with /subagents providers, and native capabilities with /subagents capabilities.",
    getArgumentCompletions: (prefix) => ["status", "profiles", "providers", "providers refresh", "capabilities", "capabilities refresh", ...HARNESSES, "--use-codex", "--use-claude"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (args.trim()) await configure(args, ctx);
      else await openSubagentsDashboard(ctx, getManager());
    },
  });

  pi.registerCommand("subagent", {
    description: "Spawn a background subagent for the human without notifying the orchestrator.",
    getArgumentCompletions: (prefix) => ["--harness", "--model", "--name", "--effort", "--access", "--max-tokens", "--max-cost", "--max-turns", "--cwd", "--profile", "--independent", "--independent-of"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!args.trim() || args.trim() === "--help" || args.trim() === "-h") {
        ctx.ui.notify(`Usage: ${HUMAN_SUBAGENT_USAGE}`, "info");
        return;
      }
      try {
        const params = parseHumanSubagentCommand(args);
        const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
        const parentThread = captureParentThread(messages);
        const spawned = await spawnJob(params, ctx, undefined, true, parentThread);
        await getManager().wait(spawned.id, { timeoutMs: 0 });
        appendHumanAnchor(spawned);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("subagents-config", {
    description: "Show or switch the default native subagent harness.",
    getArgumentCompletions: (prefix) => ["status", ...HARNESSES].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: configure,
  });

  const spawnParameters = Type.Object({
    task: Type.String({ minLength: 1, maxLength: 100_000 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    cwd: Type.Optional(Type.String()),
    harness: Type.Optional(StringEnum(REQUESTED_HARNESSES, { description: "Explicit harness, or auto to pick a healthy/authenticated route and satisfy any supplied requirements" })),
    requires: Type.Optional(Type.Array(
      Type.String({ minLength: 1, maxLength: MAX_REQUIREMENT_LENGTH }),
      { maxItems: MAX_REQUIREMENTS, description: "Capability IDs from subagent_capabilities the child must really have; verified live before dispatch" },
    )),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Harness-local model ID; omit with harness auto or to use the explicit harness default" })),
    effort: Type.Optional(StringEnum(EFFORTS, { description: "Optional provider effort hint; omitted by default for adaptive behavior" })),
    access: Type.Optional(StringEnum(ACCESS, { description: "Access policy; defaults to full after project trust is established" })),
    independent: Type.Optional(Type.Boolean({ description: "Require a native provider different from the parent" })),
    independentOf: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Route on a native provider different from this existing job ID" })),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Human-authored profile name; omit unless the human explicitly requested one" })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000_000, description: "Optional cumulative fresh input plus output token boundary for the retained session" })),
    maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_000, description: "Optional cumulative reported-cost boundary for the retained session" })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "Optional cumulative native-turn boundary for the retained session" })),
  });

  pi.registerTool({
    name: "subagent_capabilities",
    renderShell: "self",
    label: "Subagent Capabilities",
    description: "List the native tools, skills, commands, plugins, MCP servers, and hooks a subagent would really have on each harness, with the access ceiling already applied. Use the returned capability IDs as subagent requires.",
    promptSnippet: "Discover what native capabilities each subagent harness actually provides",
    promptGuidelines: [
      "Call this before requiring a capability; requires must use IDs reported here, never guessed names.",
      "Discovery is live and model-free; use refresh only after the human changed their harness configuration.",
      "Match the discovery access ceiling to the child request; use readOnly for review and inspection.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Case-insensitive filter over capability ID, name, description, and origin" })),
      harness: Type.Optional(StringEnum(HARNESSES, { description: "Limit discovery to one harness; omit to compare every configured harness" })),
      kind: Type.Optional(StringEnum(CAPABILITY_KINDS)),
      effect: Type.Optional(StringEnum(CAPABILITY_EFFECTS)),
      access: Type.Optional(StringEnum(ACCESS, { description: "Access ceiling to evaluate; defaults to full" })),
      includeUnavailable: Type.Optional(Type.Boolean({ description: "Include denied or blocked capabilities with the reason they are unusable" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `Maximum capabilities to return (default ${DEFAULT_SEARCH_LIMIT})` })),
      refresh: Type.Optional(Type.Boolean({ description: "Bypass the bounded discovery cache" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Subagent capability discovery is disabled for untrusted projects");
      const access = (params.access ?? "full") as AccessMode;
      const text = await capabilityReport({
        cwd: ctx.cwd,
        access,
        query: params.query,
        harness: params.harness as HarnessName | undefined,
        kind: params.kind as CapabilityKind | undefined,
        effect: params.effect as CapabilityEffect | undefined,
        includeUnavailable: params.includeUnavailable,
        limit: params.limit,
        refresh: params.refresh,
        signal,
      });
      return { content: [{ type: "text" as const, text }], details: { access } };
    },
    renderCall(args, theme) {
      const input = args ?? {};
      const detail = [input.harness ?? "all harnesses", input.kind ?? "", input.effect ?? "", input.access ?? "full", input.refresh ? "refresh" : ""].filter(Boolean).join(" · ");
      return renderToolCallLine(theme, "Inspect", input.query ? `capabilities: ${input.query}` : "capabilities", detail);
    },
    renderResult(res, { expanded }, theme) {
      const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "";
      const lines = text.split("\n").filter(Boolean);
      const budget = expanded ? MAX_EXPANDED_LINES - 1 : MAX_COLLAPSED_LINES - 1;
      const shown = lines.slice(0, budget).map((line) => traceResultLine(theme, "·", line));
      if (lines.length > budget) shown.push(traceResultLine(theme, "…", `${lines.length - budget} more line${lines.length - budget === 1 ? "" : "s"} hidden`, "dim"));
      return linesComponent(shown.length ? shown : [traceResultLine(theme, "○", "No capabilities reported.", "muted")]);
    },
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
      "Use access=readOnly for inspection; use independent=true only for a different native provider, or independentOf=<jobId> to review with a different provider than the producer.",
      "Use requires only for capabilities confirmed by subagent_capabilities; pair it with harness=auto to let the capable harness be chosen.",
      "Omit model to use the native harness default; a different model on the same provider is not independent.",
    ],
    parameters: spawnParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      rejectSchemaMismatch(params);
      const spawned = await spawnJob(params, ctx, signal);
      const snapshot = await getManager().wait(spawned.id, { timeoutMs: 0, signal });
      return result(snapshot, `Spawned ${snapshot.id} (${snapshot.name}, ${snapshot.access}, ${snapshot.harness}/${snapshot.model}, effort ${formatEffort(snapshot.effort)}${capabilityText(snapshot)})`);
    },
    renderCall(args, theme) {
      const route = args.independentOf ? `independent-of:${shortId(args.independentOf)}` : args.independent ? "independent" : args.harness
        ? `${args.harness}${args.model ? `/${args.model}` : ""}`
        : args.model ?? "";
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
    renderCall() {
      // Waiting is orchestration, not a second user-facing event. The original job card
      // switches to `waiting` while this tool is active and carries the final outcome.
      return emptyComponent();
    },
    renderResult(res, { isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "subagent not found");
      if (isPartial || job.status === "completed") return emptyComponent();
      const current = liveJob(job, context).job;
      if (current.status === "completed") return emptyComponent();
      const timeoutMs = (context.args as { timeoutMs?: number } | undefined)?.timeoutMs ?? 600_000;
      const timeout = timeoutMs < 1_000 ? "<1s" : `${Math.round(timeoutMs / 1000)}s`;
      const action = isTerminal(current.status)
        ? current.status
        : `${current.status} after ${timeout} wait timeout`;
      return renderJobReceipt(current, theme, { action, now: Date.now(), standalone: true });
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
    description: `Foreground convenience for one generic task-driven subagent. Default harness: ${activeHarness}.`,
    promptSnippet: "Run one isolated generic subagent and wait for its result",
    promptGuidelines: [
      "Use subagent_spawn for independent work that can run in parallel; use subagent_wait before consuming its result.",
      "Use subagent for a single foreground delegation.",
      "Subagents have isolated context; include all required paths, requirements, constraints, and verification evidence in task.",
      "Use access=readOnly for inspection; use independent=true only for a different native provider, or independentOf=<jobId> to review with a provider different from the producer.",
      "Use requires only for capabilities confirmed by subagent_capabilities; pair it with harness=auto to let the capable harness be chosen.",
      "Omit model to use the native harness default; a different model on the same provider is not independent.",
      "Omit profile by default; use a profile only when the human explicitly requests that named profile.",
    ],
    parameters: spawnParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      rejectSchemaMismatch(params);
      const snapshot = await spawnJob(params, ctx, signal);
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
      const harness = args.independentOf ? `independent-of:${shortId(args.independentOf)}` : args.independent ? "independent" : args.harness ?? activeHarness;
      const route = args.model ? `${harness}/${args.model}` : harness;
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

  pi.registerTool({
    name: "session_peer_list",
    renderShell: "self",
    label: "List Session Peers",
    description: "List saved Pi sessions available to fork as a read-only clarification peer, excluding the current session. Bounded and optionally filtered by query.",
    promptSnippet: "List saved Pi sessions that can be forked as a read-only clarification peer",
    promptGuidelines: [
      "Use this before session_peer_fork to find the exact sessionId of a saved conversation.",
      "Filter with query when you know part of the session's name, first message, or project directory.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Case-insensitive filter over session name, first message, and project cwd" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PEER_LIST_LIMIT, description: `Maximum sessions to return (default ${DEFAULT_PEER_LIST_LIMIT})` })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Session peers are disabled for untrusted projects");
      const peers = await listPeerSessions(sessionPeers, {
        query: params.query,
        limit: params.limit,
        excludeSessionId: ctx.sessionManager.getSessionId(),
      });
      const text = peers.length
        ? peers.map((peer) => `${peer.sessionId} ${peer.name ?? "(unnamed)"} · ${peer.cwd} · ${peer.messageCount} messages`).join("\n")
        : "No other saved sessions available to fork.";
      return { content: [{ type: "text", text }], details: { peers } };
    },
    renderCall(args, theme) {
      const detail = [args.query ? `query:${args.query}` : "", args.limit ? `limit:${args.limit}` : ""].filter(Boolean).join(" · ");
      return renderToolCallLine(theme, "List", "session peers", detail);
    },
    renderResult(res, { expanded }, theme) {
      const peers = (res.details as { peers?: PeerSessionSummary[] } | undefined)?.peers ?? [];
      return renderPeerListCard(peers, theme, { expanded });
    },
  });

  pi.registerTool({
    name: "session_peer_fork",
    renderShell: "self",
    label: "Fork Session Peer",
    description: "Fork a saved Pi session (chosen from session_peer_list) into a new read-only, tool-less background job under the current trusted project, without mutating the source session. The peer retains the source conversation's context; continue talking to it with subagent_send/wait/check/cancel using the returned jobId.",
    promptSnippet: "Fork a saved Pi session as a read-only clarification peer and ask it an initial question",
    promptGuidelines: [
      "Call session_peer_list first and pass the exact sessionId it returns; arbitrary paths are never accepted.",
      "The peer has no tools and cannot delegate; use it only to ask clarification questions about its retained context.",
      "Use subagent_wait for its reply, then subagent_send for follow-up turns on the same jobId.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 128, description: "Stable session id returned by session_peer_list" }),
      message: Type.String({ minLength: 1, maxLength: 100_000, description: "Initial clarification question sent to the forked peer" }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Session peers are disabled for untrusted projects");
      const forked = await forkPeerSession(sessionPeers, {
        sessionId: params.sessionId,
        targetCwd: ctx.cwd,
        currentSessionId: ctx.sessionManager.getSessionId(),
      });
      const snapshot = getManager().spawn({
        name: params.name,
        task: params.message,
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        harness: "pi",
        access: "readOnly",
        peer: {
          sourceSessionId: forked.source.id,
          sourceCwd: forked.source.cwd,
          sourceName: forked.source.name,
          sessionFile: forked.sessionFile,
        },
      });
      return result(snapshot, `Forked session peer ${snapshot.id} (${snapshot.name}) from ${forked.source.id}`);
    },
    renderCall(args, theme) {
      return renderToolCallLine(theme, "Fork", args.name ?? "peer", [args.sessionId, truncatePreview(args.message)].filter(Boolean).join(" · "));
    },
    renderResult(res, { expanded, isPartial }, theme, context) {
      const job = jobOf(res);
      if (!job) return renderFailure(theme, "session peer fork failed");
      return renderLiveJob(job, theme, { expanded, isPartial }, context);
    },
  });
}

/**
 * Full-access human Pi jobs inherit every loaded parent tool that remains below
 * the package's hard orchestration/interactivity ceiling. Read-only jobs ignore
 * this list later in policy compilation.
 */
export function permittedHumanPiToolNames(
  tools: Array<{ name: string; description?: string; source?: string }>,
): string[] {
  const permitted = tools.filter((tool) => capabilityAvailability(normalizeCapability("pi", {
    kind: "tool",
    name: tool.name,
    description: tool.description,
    origin: tool.source,
  }), "full").available);
  return [...new Set(permitted.map((tool) => tool.name.trim()).filter(Boolean))];
}

/** Live parent inventories, tolerant of hosts that do not implement them. */
function parentTools(pi: ExtensionAPI): Array<{ name: string; description?: string; source?: string }> {
  try {
    return (pi.getAllTools?.() ?? []).map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      source: tool.sourceInfo?.source,
    }));
  } catch { return []; }
}

function parentCommands(pi: ExtensionAPI): Array<{ name: string; description?: string; source?: string }> {
  try {
    return (pi.getCommands?.() ?? []).map((command) => ({
      name: command.name,
      description: command.description,
      source: command.source,
    }));
  } catch { return []; }
}

function rejectSchemaMismatch(params: object): void {
  if (["role", "agent", "modelProfile", "modelTier", "tier", "backend"].some((key) => Object.hasOwn(params, key))) {
    throw new Error("Subagent API schema mismatch: reload Pi to use the current task-driven schema.");
  }
}

function sendTitle(behavior: SendBehavior): "Steer" | "Follow up" {
  return behavior === "followUp" ? "Follow up" : "Steer";
}

export function parseHumanSubagentCommand(input: string): SpawnToolParams {
  const tokens = tokenizeCommandArgs(input);
  const params: SpawnToolParams = { task: "" };
  const task: string[] = [];
  let parseFlags = true;

  const takeValue = (flag: string, inlineValue: string | undefined, index: number): { value: string; nextIndex: number } => {
    const value = inlineValue ?? tokens[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value. Usage: ${HUMAN_SUBAGENT_USAGE}`);
    return { value, nextIndex: inlineValue === undefined ? index + 1 : index };
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (parseFlags && token === "--") {
      parseFlags = false;
      continue;
    }
    if (!parseFlags || !token.startsWith("--")) {
      task.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    const inlineValue = equals >= 0 ? token.slice(equals + 1) : undefined;
    switch (flag) {
      case "--harness": {
        const taken = takeValue(flag, inlineValue, index);
        const harness = normalizeHarness(taken.value);
        if (!harness) throw new Error(`Unknown harness '${taken.value}'. Choose pi, claude, or codex.`);
        params.harness = harness;
        index = taken.nextIndex;
        break;
      }
      case "--model": {
        const taken = takeValue(flag, inlineValue, index);
        params.model = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--name": {
        const taken = takeValue(flag, inlineValue, index);
        params.name = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--effort": {
        const taken = takeValue(flag, inlineValue, index);
        if (!(EFFORTS as readonly string[]).includes(taken.value)) throw new Error(`Unknown effort '${taken.value}'. Choose ${EFFORTS.join(", ")}.`);
        params.effort = taken.value as EffortLevel;
        index = taken.nextIndex;
        break;
      }
      case "--access": {
        const taken = takeValue(flag, inlineValue, index);
        if (!(ACCESS as readonly string[]).includes(taken.value)) throw new Error(`Unknown access '${taken.value}'. Choose ${ACCESS.join(" or ")}.`);
        params.access = taken.value as AccessMode;
        index = taken.nextIndex;
        break;
      }
      case "--max-tokens":
      case "--max-turns": {
        const taken = takeValue(flag, inlineValue, index);
        const value = Number(taken.value);
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} requires a positive integer.`);
        if (flag === "--max-tokens") params.maxTokens = value;
        else params.maxTurns = value;
        index = taken.nextIndex;
        break;
      }
      case "--max-cost": {
        const taken = takeValue(flag, inlineValue, index);
        const value = Number(taken.value);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} requires a positive number.`);
        params.maxCost = value;
        index = taken.nextIndex;
        break;
      }
      case "--cwd": {
        const taken = takeValue(flag, inlineValue, index);
        params.cwd = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--profile": {
        const taken = takeValue(flag, inlineValue, index);
        params.profile = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--independent":
        if (inlineValue !== undefined) throw new Error(`${flag} does not take a value.`);
        params.independent = true;
        break;
      case "--independent-of": {
        const taken = takeValue(flag, inlineValue, index);
        params.independentOf = taken.value;
        index = taken.nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown option '${flag}'. Usage: ${HUMAN_SUBAGENT_USAGE}`);
    }
  }

  params.task = task.join(" ").trim();
  if (!params.task) throw new Error(`A task is required. Usage: ${HUMAN_SUBAGENT_USAGE}`);
  return params;
}

function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in /subagent command.");
  if (started) tokens.push(current);
  return tokens;
}

export interface SpawnToolParams {
  task: string;
  name?: string;
  cwd?: string;
  harness?: RequestedHarness;
  requires?: string[];
  model?: string;
  effort?: EffortLevel;
  access?: AccessMode;
  independent?: boolean;
  independentOf?: string;
  profile?: string;
  maxTokens?: number;
  maxCost?: number;
  maxTurns?: number;
}

/**
 * Compile the caller's request, resolve and live-revalidate any capability
 * requirements, then dispatch. Requests without `requires`/`harness: "auto"`
 * take the original synchronous routing path unchanged.
 */
async function spawn(
  manager: JobManager,
  router: CapabilityRouter | undefined,
  params: SpawnToolParams,
  context: {
    parentCwd: string;
    trusted: boolean;
    defaultHarness?: HarnessName;
    parentProvider?: ProviderFamily;
    profile?: ProfileDefinition;
    humanVisible?: boolean;
    humanPiTools?: string[];
    parentThread?: ParentThreadSnapshot;
    signal?: AbortSignal;
  },
): Promise<JobSnapshot> {
  if (!context.trusted) throw new Error("Subagents are disabled for untrusted projects");
  const cwd = secureCwd(context.parentCwd, params.cwd);
  const request = {
    name: params.name,
    task: params.task,
    cwd,
    trusted: context.trusted,
    model: params.model,
    effort: params.effort,
    access: params.access,
    independent: params.independent,
    independentOf: params.independentOf,
    profile: params.profile,
    defaultHarness: context.defaultHarness,
    parentProvider: context.parentProvider,
    humanVisible: context.humanVisible,
    humanPiTools: context.humanPiTools,
    parentThread: context.parentThread,
    budget: directBudget(params),
  };
  const routing = await routeCapabilities(router, {
    request: { ...request, harness: params.harness, requires: params.requires },
    profile: context.profile,
    independentOfProvider: independenceProvider(manager, params.independentOf),
    preference: context.defaultHarness ? [context.defaultHarness] : undefined,
    signal: context.signal,
  });
  return manager.spawn({
    ...request,
    harness: routing.harness ?? (params.harness === "auto" ? undefined : params.harness),
    requires: routing.requires,
    capabilityRoute: routing.capabilityRoute,
  });
}

/** Provider of an existing independence target, when it is still retained. */
function independenceProvider(manager: JobManager, independentOf?: string): ProviderFamily | undefined {
  if (!independentOf) return undefined;
  try {
    const harness = manager.check(independentOf).harness;
    return harness === "claude" || harness === "codex" ? harness : undefined;
  } catch {
    // Unknown or evicted targets keep failing closed inside JobManager.spawn().
    return undefined;
  }
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

export function configuredHarnessFromEnv(env: NodeJS.ProcessEnv): HarnessName {
  return normalizeHarness(env.PI_NATIVE_SUBAGENTS_HARNESS) ?? "pi";
}

export function normalizeHarness(value: unknown): HarnessName | undefined {
  const text = String(value ?? "").trim().toLowerCase().replace(/^--use-/, "");
  if (text === "codex" || text === "openai" || text === "gpt") return "codex";
  if (text === "claude" || text === "anthropic") return "claude";
  if (text === "pi") return "pi";
  return undefined;
}

function statusLine(job: JobSnapshot): string {
  const profile = job.profile ? `; profile ${job.profile}` : "";
  return `${job.id} ${job.status} ${job.name} [${job.access}; ${job.harness}/${job.model}; effort ${formatEffort(job.effort)}${profile}; budget ${formatSpendBudget(job.budget, job.usage, job.harness)}]`;
}

function directBudget(params: Pick<SpawnToolParams, "maxTokens" | "maxCost" | "maxTurns">): SpendBudget | undefined {
  const budget = { maxTokens: params.maxTokens, maxCost: params.maxCost, maxTurns: params.maxTurns };
  return Object.values(budget).some((value) => value !== undefined) ? budget : undefined;
}
/** Route provenance for tool text: what was required, and which live inventory satisfied it. */
function capabilityText(job: JobSnapshot): string {
  if (!job.capabilities) return "";
  const route = job.capabilities;
  return `, capabilities ${route.matched.join(", ") || "none"}${route.auto ? " (auto-routed)" : ""} @ ${route.revision.slice(7, 15)}`;
}
function terminalText(job: JobSnapshot): string {
  const warnings = terminalWarnings(job.warnings);
  if (job.status === "completed") return `${job.output || "(completed with no text output)"}${warnings}`;
  if (job.status === "failed" || job.status === "cancelled") return `${statusLine(job)}\n${job.error ?? ""}${warnings}`.trim();
  return statusLine(job);
}
function terminalWarnings(warnings: string[] | undefined): string {
  const shown = warnings?.slice(-3) ?? [];
  return shown.length ? `\nWarnings:\n${shown.map((warning) => `- ${warning}`).join("\n")}` : "";
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
