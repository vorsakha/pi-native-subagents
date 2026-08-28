import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  alignDashboardSummaryRow,
  clampDashboard,
  createDashboardFrame,
  DASHBOARD_COMPACT_ROWS,
  dashboardCancelKeyLabel,
  dashboardConfirmKeyLabel,
  dashboardFoldRow,
  dashboardLayout,
  dashboardListViewport,
  dashboardNestedSelectionMarker,
  dashboardOverlayRows,
  dashboardScrollRule,
  dashboardSectionRow,
  dashboardSelectionMarker,
  dashboardSummaryColor,
  fitDashboardRows,
  formatDurationLabel,
  isFullscreenTui,
  renderDashboardConfirmHint,
  renderDashboardHelp,
} from "../dashboard-style.ts";
import type { DashboardFrame, DashboardKeyGroup, DashboardLayout } from "../dashboard-style.ts";
import {
  dashboardCollectionViewport,
  groupDashboardCollection,
  type DashboardCollection,
  type DashboardCollectionGroupDefinition,
  type DashboardCollectionRow,
  type DashboardCollectionViewport,
} from "../dashboard-collection.ts";
import { aggregateWorkflowUsage, workflowIsTerminal } from "../../src/workflows/manager.ts";
import { isTranscriptTruncationEntry } from "../../src/workflows/artifacts.ts";
import { availabilityLabel } from "../../src/harness-availability.ts";
import { formatWorkflowBudget } from "../../src/workflows/budget.ts";
import type {
  WorkflowAgentRecord,
  WorkflowPhase,
  WorkflowSnapshot,
} from "../../src/workflows/types.ts";
import { formatContext, formatUsage, sanitizeInline, sanitizeText, shortId, traceStatusMeta } from "../subagents/render.ts";
import {
  formatWorkflowConvergence,
  formatWorkflowInteraction,
  workflowAgentDashboardSummary,
  workflowConvergenceMeta,
  workflowDashboardSummary,
  workflowNeedsInput,
  workflowPhaseProgress,
  workflowStatusMeta,
} from "./render.ts";
import {
  appendBoundedSection,
  boundedHeadTailText,
  boundedInline,
  boundedTranscriptParts,
  boundRenderedRows,
  detailSignature,
  renderPrefixedRows,
  renderWorkflowMarkdown,
  serializeResult,
  truncateWorkflowDashboardLine,
} from "./dashboard-detail.ts";
import {
  DEFAULT_TOOL_DISPLAY,
  pairToolEntries,
  renderToolGroupRow,
  resolveToolRenderSnapshot,
  summarizeToolCalls,
  toolCallState,
  type ToolDisplayMode,
  type ToolEntry,
} from "../tool-summary.ts";
import { renderPiTool } from "../subagents/transcript.ts";

export { renderWorkflowMarkdown, truncateWorkflowDashboardLine } from "./dashboard-detail.ts";

const MAX_RESULT_CHARS = 16_384;
const MAX_RESULT_ROWS = 400;
const MAX_ERROR_CHARS = 4 * 1024;
const MAX_PROMPT_CHARS = 8 * 1024;
const MAX_ACTIVITY_CHARS = 2 * 1024;
const MAX_STRUCTURED_CHARS = 4 * 1024;
const MAX_FINAL_RESULT_CHARS = 8 * 1024;
/** One scroll label row plus one body row must survive pinned metadata. */
const MIN_SCROLLABLE_DETAIL_ROWS = 2;

/**
 * Every other workflow action (pause/resume, restart, agent/run cancellation)
 * is applied in place against the live manager while the overlay stays
 * mounted; `close` is the only action the caller still needs to react to.
 */
export type WorkflowsDashboardAction = { type: "close" };

export interface WorkflowsDashboardManager {
  list(): WorkflowSnapshot[];
  check(runId: string): WorkflowSnapshot;
  cancel(runId: string, reason?: string): Promise<WorkflowSnapshot>;
  cancelAgent(runId: string, agentIndex: number, reason?: string): Promise<WorkflowSnapshot>;
  pause(runId: string): Promise<WorkflowSnapshot>;
  resume(runId: string): Promise<WorkflowSnapshot>;
  restartAgent(runId: string, agentIndex: number): Promise<{ snapshot: WorkflowSnapshot }>;
  subscribe(listener: (snapshot: WorkflowSnapshot) => void): () => void;
}

export interface WorkflowsDashboardOverlayOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  renderMarkdown?: (text: string, width: number) => string[];
  /** Run selected when a dashboard is reopened after an action. */
  focusRunId?: string;
  /** Forces the fullscreen height policy; defaults to Pi's renderer mode. */
  fullscreen?: boolean;
}

type AgentFilter = "all" | "active" | "failed" | "completed";
const AGENT_FILTERS: AgentFilter[] = ["all", "active", "failed", "completed"];
type WorkflowPane = "list" | "overview" | "agent";
type WorkflowDashboardGroup = "input" | "active" | "failed" | "finished";

const WORKFLOW_DASHBOARD_GROUPS = [
  { key: "input", label: "Needs input" },
  { key: "active", label: "Active" },
  { key: "failed", label: "Failed" },
  { key: "finished", label: "Finished", foldLabel: "finished" },
] as const satisfies readonly DashboardCollectionGroupDefinition<WorkflowDashboardGroup>[];

type CancelTarget =
  | { type: "run"; runId: string; confirmKey: "X" }
  | { type: "agent"; runId: string; agentIndex: number; confirmKey: "x" };

export function createWorkflowsDashboardOverlay(
  tui: Pick<TUI, "requestRender" | "terminal">,
  theme: Theme,
  keybindings: KeybindingsManager,
  manager: WorkflowsDashboardManager,
  done: (action: WorkflowsDashboardAction) => void,
  options: WorkflowsDashboardOverlayOptions = {},
): WorkflowsDashboardOverlay {
  return new WorkflowsDashboardOverlay(tui, theme, keybindings, manager, done, options);
}

/**
 * Workflow supervision keeps the same adaptive shell as `/subagents`, but has
 * one extra hierarchy level: runs → workflow overview → agent inspector.
 * Selection is identity-based; positions are derived only for movement and
 * viewport centering. In a disappearing collection, the fallback is the first
 * active run, then the first queued run, then the newest retained run. A
 * filtered-out agent falls back to the first visible agent in that phase.
 */
export class WorkflowsDashboardOverlay implements Focusable {
  #focused = false;
  #finished = false;
  #selectedRunId: string | undefined;
  #selectionRunId: string | undefined;
  #selectedPhaseIndex: number | undefined;
  #selectedAgentIndex: number | undefined;
  #pane: WorkflowPane = "list";
  #agentFilter: AgentFilter = "all";
  #scroll = 0;
  #scrollKey: string | undefined;
  #followTail = true;
  /** One display preference per overlay instance; survives run/agent changes, not resets. */
  #toolDisplay: ToolDisplayMode = DEFAULT_TOOL_DISPLAY;
  #resultRows = 0;
  #resultTotal = 0;
  #confirmCancel: CancelTarget | undefined;
  /** `?` cheatsheet toggle; browse-only (list/overview/agent), never intercepted while armed for cancellation. */
  #showHelp = false;
  #notice = "";
  #runs: WorkflowSnapshot[] = [];
  #layout: DashboardLayout | undefined;
  #visibleAgent: { runId: string; phaseIndex: number | undefined; agentIndex: number } | undefined;
  /** Destructive controls present in the last rendered hint. */
  #renderedAgentCancel: { runId: string; agentIndex: number } | undefined;
  #renderedRunCancelId: string | undefined;
  #renderedConfirmationTarget: string | undefined;
  #lastRenderWidth = 0;
  #lastRenderRows = 0;
  #detailCache = new Map<string, string[]>();
  #ticker: ReturnType<typeof setInterval> | undefined;
  #coalesce: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #now: () => number;
  readonly #setInterval: typeof setInterval;
  readonly #clearInterval: typeof clearInterval;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #renderMarkdown: (text: string, width: number) => string[];
  readonly #forceFullscreen: boolean | undefined;
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly manager: WorkflowsDashboardManager;
  private readonly done: (action: WorkflowsDashboardAction) => void;

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    keybindings: KeybindingsManager,
    manager: WorkflowsDashboardManager,
    done: (action: WorkflowsDashboardAction) => void,
    options: WorkflowsDashboardOverlayOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.manager = manager;
    this.done = done;
    this.#now = options.now ?? Date.now;
    this.#setInterval = options.setInterval ?? setInterval;
    this.#clearInterval = options.clearInterval ?? clearInterval;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
    this.#renderMarkdown = options.renderMarkdown ?? renderWorkflowMarkdown;
    this.#selectedRunId = options.focusRunId;
    this.#forceFullscreen = options.fullscreen;
    this.#unsubscribe = manager.subscribe(() => {
      if (this.#finished) return;
      this.invalidate();
      this.invalidateSoon();
    });
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
  }

  render(width: number): string[] {
    width = Math.max(0, width);
    this.#lastRenderWidth = width;
    this.#layout = undefined;
    this.#visibleAgent = undefined;
    this.#renderedAgentCancel = undefined;
    this.#renderedRunCancelId = undefined;
    this.#renderedConfirmationTarget = undefined;
    const rows = dashboardOverlayRows(this.tui.terminal?.rows ?? 0, this.fullscreen());
    this.#lastRenderRows = rows;
    if (!rows) return [];

    const runs = this.manager.list();
    const collection = workflowDashboardCollection(runs);
    this.#runs = runs;
    this.syncTicker(runs);
    const chosen = this.resolveSelectedRun(collection.items);
    if (chosen) this.#runs = runs.map((candidate) => candidate.runId === chosen.runId ? chosen : candidate);
    this.syncSelections(chosen);

    if (width < 4) {
      this.resetCompactHierarchy();
      return [truncateWorkflowDashboardLine(`Workflows ${runs.length}`, width)];
    }

    const frame = createDashboardFrame(this.theme, width, this.#focused);
    if (rows < DASHBOARD_COMPACT_ROWS) {
      this.resetCompactHierarchy();
      return fitDashboardRows(this.renderCompact(rows, runs.length, frame), rows);
    }

    const layout = dashboardLayout(width, rows);
    this.#layout = layout;
    if (this.#showHelp) return fitDashboardRows(this.renderHelp(frame, layout, runs), rows);
    if (layout.kind === "wide") return fitDashboardRows(this.renderWide(frame, layout, runs, collection, chosen), rows);
    if (layout.kind === "medium") return fitDashboardRows(this.renderMedium(frame, layout, runs, collection, chosen), rows);
    return fitDashboardRows(this.renderNarrow(frame, layout, runs, collection, chosen), rows);
  }

  invalidate(): void {
    this.#detailCache.clear();
  }

  dispose(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.#finished) return;

    const runs = this.manager.list();
    const orderedRuns = workflowDashboardCollection(runs).items;
    this.#runs = runs;
    const run = this.resolveSelectedRun(orderedRuns);
    if (run) this.#runs = runs.map((candidate) => candidate.runId === run.runId ? run : candidate);
    this.syncSelections(run);

    const compact = this.isCompactGeometry();
    const armed = compact ? undefined : this.#confirmCancel;
    this.#confirmCancel = undefined;
    this.#notice = "";
    const cancel = matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel");

    if (compact) {
      this.resetCompactHierarchy();
      if (cancel) this.finish();
      else this.tui.requestRender();
      return;
    }

    // A clipped one-line summary has no interactive pane. Keep the global
    // close binding available, but do not route pane actions through hidden
    // layout state while the panel is below its interactive width.
    if (!this.#layout) {
      this.resetCompactHierarchy();
      if (cancel) this.finish();
      else this.tui.requestRender();
      return;
    }

    if (armed) {
      if (cancel) {
        this.#notice = "Cancellation dismissed.";
        this.tui.requestRender();
        return;
      }
      if (data === armed.confirmKey || (armed.confirmKey === "X" && matchesKey(data, Key.shift("x")))) {
        if (this.#renderedConfirmationTarget === cancelTargetKey(armed)) this.confirmCancel(armed, run);
        else {
          this.#notice = "Cancellation dismissed.";
          this.tui.requestRender();
        }
        return;
      }
      this.#notice = "Cancellation dismissed.";
      this.tui.requestRender();
      return;
    }

    // The cheatsheet is a modal legend: `?` or cancel dismiss it without
    // touching pane, scroll, selection, filter, or tool-display state.
    if (this.#showHelp) {
      if (cancel || data === "?") this.#showHelp = false;
      this.tui.requestRender();
      return;
    }

    // Navigation can change the selected agent between host paints. Recompute
    // the exact control tokens that fit at the last rendered width before
    // accepting a destructive key; clipped controls remain disabled.
    this.refreshRenderedControls(run);

    if (cancel) {
      if (this.#pane === "agent") {
        this.#pane = "overview";
        this.resetScroll();
      } else if (this.#layout?.kind === "narrow" && this.#pane === "overview") {
        this.#pane = "list";
        this.resetScroll();
      } else {
        this.finish();
        return;
      }
      this.tui.requestRender();
      return;
    }

    if (data === "?") {
      this.#showHelp = true;
      this.tui.requestRender();
      return;
    }

    const narrowList = this.#layout?.kind === "narrow" && this.#pane === "list";
    const agentPane = this.#pane === "agent";
    const overviewControls = !narrowList && !agentPane;
    const detailControls = !narrowList;

    if (detailControls && matchesKey(data, Key.shift(Key.up))) this.scrollResult(-1);
    else if (detailControls && matchesKey(data, Key.shift(Key.down))) this.scrollResult(1);
    else if (detailControls && matchesKey(data, Key.pageUp)) this.scrollResult(-this.pageStep());
    else if (detailControls && matchesKey(data, Key.pageDown)) this.scrollResult(this.pageStep());
    else if (detailControls && matchesKey(data, Key.ctrl("u"))) this.scrollResult(-this.halfPageStep());
    else if (detailControls && matchesKey(data, Key.ctrl("d"))) this.scrollResult(this.halfPageStep());
    else if (detailControls && matchesKey(data, "g")) this.scrollTo(0);
    else if (detailControls && matchesKey(data, Key.shift("g"))) this.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (this.#pane === "agent" && (matchesKey(data, Key.left) || matchesKey(data, "h"))) {
      this.#pane = "overview";
      this.resetScroll();
    }
    else if (!agentPane && (matchesKey(data, Key.up) || matchesKey(data, "k"))) this.selectRun(-1, orderedRuns);
    else if (!agentPane && (matchesKey(data, Key.down) || matchesKey(data, "j"))) this.selectRun(1, orderedRuns);
    else if (overviewControls && (matchesKey(data, Key.left) || matchesKey(data, "h"))) this.selectPhase(-1, run);
    else if (overviewControls && (matchesKey(data, Key.right) || matchesKey(data, "l"))) this.selectPhase(1, run);
    else if (overviewControls && data === "\t") this.selectAgent(run);
    else if (overviewControls && matchesKey(data, "f")) this.cycleAgentFilter(run);
    else if (!agentPane && (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))) this.openSelectedPane(run);
    else if (overviewControls && matchesKey(data, "p")) this.pauseOrResume(run);
    else if (matchesKey(data, "r")) this.restartAgent(run);
    else if (matchesKey(data, "x")) this.requestAgentCancel(run);
    else if (data === "X" || matchesKey(data, Key.shift("x"))) this.requestRunCancel(run);
    else if (agentPane && (matchesKey(data, "t") || matchesKey(data, Key.ctrl("t")))) this.toggleToolDisplay();

    this.tui.requestRender();
  }

  private finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
    this.done({ type: "close" });
  }

  private cleanup(): void {
    if (this.#ticker !== undefined) {
      this.#clearInterval(this.#ticker);
      this.#ticker = undefined;
    }
    if (this.#coalesce !== undefined) {
      this.#clearTimeout(this.#coalesce);
      this.#coalesce = undefined;
    }
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
    }
  }

  private invalidateSoon(): void {
    if (this.#finished || this.#coalesce !== undefined) return;
    const timer = this.#setTimeout(() => {
      this.#coalesce = undefined;
      if (!this.#finished) this.tui.requestRender();
    }, 50);
    timer.unref?.();
    this.#coalesce = timer;
  }

  private syncTicker(runs: WorkflowSnapshot[]): void {
    const active = runs.some((run) => !workflowIsTerminal(run.status));
    if (active && this.#ticker === undefined && !this.#finished) {
      const timer = this.#setInterval(() => {
        if (!this.#finished) this.tui.requestRender();
      }, 1_000);
      timer.unref?.();
      this.#ticker = timer;
    } else if (!active && this.#ticker !== undefined) {
      this.#clearInterval(this.#ticker);
      this.#ticker = undefined;
    }
  }

  private fullscreen(): boolean {
    return this.#forceFullscreen ?? isFullscreenTui(this.tui);
  }

  private isCompactGeometry(): boolean {
    return dashboardOverlayRows(this.tui.terminal?.rows ?? 0, this.fullscreen()) < DASHBOARD_COMPACT_ROWS;
  }

  private resetCompactHierarchy(): void {
    this.#pane = "list";
    this.#selectedPhaseIndex = undefined;
    this.#selectedAgentIndex = undefined;
    this.#confirmCancel = undefined;
    this.#renderedAgentCancel = undefined;
    this.#renderedRunCancelId = undefined;
    this.#renderedConfirmationTarget = undefined;
    this.#showHelp = false;
    this.#notice = "";
    this.resetScroll();
  }

  private toggleToolDisplay(): void {
    this.#toolDisplay = this.#toolDisplay === "compact" ? "full" : "compact";
    this.invalidate();
  }

  /* ── selection and actions ───────────────────────────────────────────── */

  private resolveSelectedRun(runs: readonly WorkflowSnapshot[]): WorkflowSnapshot | undefined {
    if (!runs.length) {
      this.#selectedRunId = undefined;
      this.#selectionRunId = undefined;
      this.#selectedPhaseIndex = undefined;
      this.#selectedAgentIndex = undefined;
      this.#pane = "list";
      this.resetScroll();
      return undefined;
    }

    let selected = runs.find((run) => run.runId === this.#selectedRunId);
    if (!selected) {
      selected = defaultWorkflow(runs);
      this.#selectedRunId = selected.runId;
      this.#selectedPhaseIndex = undefined;
      this.#selectedAgentIndex = undefined;
      this.#pane = "list";
      this.resetScroll();
    }

    try {
      // The checked snapshot is the single source for detail metadata and
      // actions; list() remains the source for ordering and the run rail.
      return this.manager.check(selected.runId);
    } catch {
      return selected;
    }
  }

  private syncSelections(run: WorkflowSnapshot | undefined): void {
    if (!run) return;

    if (this.#selectionRunId !== run.runId) {
      this.#selectionRunId = run.runId;
      this.#selectedRunId = run.runId;
      this.#selectedPhaseIndex = undefined;
      this.#selectedAgentIndex = undefined;
      this.#pane = "list";
      this.resetScroll();
    }

    const phaseBefore = this.#selectedPhaseIndex;
    const phase = this.resolvePhase(run);
    if (!phase) {
      this.#selectedAgentIndex = undefined;
      if (this.#pane === "agent") this.#pane = "overview";
      return;
    }
    if (phaseBefore !== undefined && phaseBefore !== phase.index && this.#pane === "agent") {
      this.#pane = "overview";
    }

    const agents = this.phaseAgents(run, phase);
    const selectedAgent = agents.find((agent) => agent.index === this.#selectedAgentIndex);
    if (!selectedAgent) {
      const previousAgent = this.#selectedAgentIndex;
      const next = agents[0];
      const changed = this.#selectedAgentIndex !== next?.index;
      this.#selectedAgentIndex = next?.index;
      if (changed) this.resetScroll();
      // Do not silently redirect an agent action after a filter/state update.
      // The fallback remains visibly selectable in the phase overview.
      if (this.#pane === "agent" && previousAgent !== undefined && previousAgent !== next?.index) {
        this.#pane = "overview";
      }
    }
  }

  private resolvePhase(run: WorkflowSnapshot): WorkflowPhase | undefined {
    if (!run.phases.length) {
      this.#selectedPhaseIndex = undefined;
      return undefined;
    }
    const selected = run.phases.find((phase) => phase.index === this.#selectedPhaseIndex);
    if (selected) return selected;

    const current = run.currentPhase === null
      ? undefined
      : run.phases.find((phase) => phase.index === run.currentPhase);
    const fallback = current ?? run.phases[0]!;
    const changed = this.#selectedPhaseIndex !== fallback.index;
    this.#selectedPhaseIndex = fallback.index;
    if (changed) this.resetScroll();
    return fallback;
  }

  private phaseFor(run: WorkflowSnapshot | undefined): WorkflowPhase | undefined {
    return run ? this.resolvePhase(run) : undefined;
  }

  private selectedAgent(run: WorkflowSnapshot | undefined): WorkflowAgentRecord | undefined {
    if (!run) return undefined;
    const phase = this.phaseFor(run);
    return this.phaseAgents(run, phase).find((agent) => agent.index === this.#selectedAgentIndex);
  }

  private selectRun(delta: number, runs: readonly WorkflowSnapshot[]): void {
    if (!runs.length) return;
    const index = runs.findIndex((run) => run.runId === this.#selectedRunId);
    const next = runs[clampDashboard(index + delta, 0, runs.length - 1)];
    if (!next || next.runId === this.#selectedRunId) return;
    this.#selectedRunId = next.runId;
    this.#selectedPhaseIndex = undefined;
    this.#selectedAgentIndex = undefined;
    this.#pane = this.#layout?.kind === "narrow" ? "list" : "overview";
    this.resetScroll();
  }

  private selectPhase(delta: number, run: WorkflowSnapshot | undefined): void {
    if (!run?.phases.length) return;
    const index = run.phases.findIndex((phase) => phase.index === this.#selectedPhaseIndex);
    const next = run.phases[clampDashboard(index + delta, 0, run.phases.length - 1)];
    if (!next || next.index === this.#selectedPhaseIndex) return;
    this.#selectedPhaseIndex = next.index;
    this.#selectedAgentIndex = undefined;
    if (this.#pane === "agent") this.#pane = "overview";
    this.resetScroll();
  }

  private selectAgent(run: WorkflowSnapshot | undefined): void {
    if (!run) return;
    const agents = this.phaseAgents(run, this.phaseFor(run));
    if (!agents.length) return;
    const index = agents.findIndex((agent) => agent.index === this.#selectedAgentIndex);
    this.#selectedAgentIndex = agents[(index + 1 + agents.length) % agents.length]!.index;
    this.resetScroll();
    this.refreshAgentVisibility(run);
  }

  private cycleAgentFilter(run: WorkflowSnapshot | undefined): void {
    const current = AGENT_FILTERS.indexOf(this.#agentFilter);
    this.#agentFilter = AGENT_FILTERS[(current + 1) % AGENT_FILTERS.length]!;
    const before = this.#selectedAgentIndex;
    this.syncSelections(run);
    if (before !== this.#selectedAgentIndex || this.#pane === "agent") {
      if (!this.selectedAgent(run)) this.#pane = "overview";
      this.resetScroll();
    }
  }

  private openSelectedPane(run: WorkflowSnapshot | undefined): void {
    if (!run) return;
    if (this.#layout?.kind === "narrow" && this.#pane === "list") {
      this.#pane = "overview";
      this.resetScroll();
      this.refreshAgentVisibility(run);
      return;
    }
    if (this.selectedAgent(run)) {
      this.#pane = "agent";
      this.resetScroll();
      this.refreshAgentVisibility(run);
    }
  }

  /** Applied in place: the live manager is called directly and the overlay stays mounted. */
  private pauseOrResume(run: WorkflowSnapshot | undefined): void {
    if (!run || workflowIsTerminal(run.status) || this.#pane === "agent" || (this.#layout?.kind === "narrow" && this.#pane === "list")) return;
    const runId = run.runId;
    const pausing = run.status !== "paused";
    this.#notice = `${pausing ? "Pausing" : "Resuming"} ${sanitizeInline(run.name)}…`;
    const call = pausing ? this.manager.pause(runId) : this.manager.resume(runId);
    void call.catch((error: unknown) => {
      this.#notice = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    });
  }

  /**
   * Restarting an agent starts a new replacement run; that replacement
   * becomes selected in place once it starts, without tearing down or
   * reopening the dashboard.
   */
  private restartAgent(run: WorkflowSnapshot | undefined): void {
    if (!this.agentActionsVisible(run)) return;
    const agent = this.selectedAgent(run);
    if (!run || agent?.callIndex === undefined) return;
    const agentName = sanitizeInline(agent.name);
    const agentIndex = agent.index;
    this.#notice = `Restarting ${agentName}…`;
    void this.manager.restartAgent(run.runId, agentIndex)
      .then((restarted) => {
        const replacementRunId = restarted.snapshot.runId;
        this.#selectedRunId = replacementRunId;
        this.#selectionRunId = replacementRunId;
        this.#selectedPhaseIndex = undefined;
        this.#selectedAgentIndex = undefined;
        this.#pane = this.#layout?.kind === "narrow" ? "list" : "overview";
        this.resetScroll();
        this.#notice = `Restarted ${agentName} as ${sanitizeText(replacementRunId)}`;
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        this.#notice = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
  }

  private requestAgentCancel(run: WorkflowSnapshot | undefined): void {
    if (!this.canCancelAgent(run)) return;
    const agent = this.selectedAgent(run);
    if (!run || !agent) return;
    this.#confirmCancel = { type: "agent", runId: run.runId, agentIndex: agent.index, confirmKey: "x" };
    this.#renderedConfirmationTarget = cancelTargetKey(this.#confirmCancel);
  }

  private canCancelAgent(run: WorkflowSnapshot | undefined): boolean {
    const agent = this.agentCancelActionable(run);
    const rendered = this.#renderedAgentCancel;
    return !!agent
      && !!rendered
      && rendered.runId === run?.runId
      && rendered.agentIndex === agent.index;
  }

  private agentCancelActionable(run: WorkflowSnapshot | undefined): WorkflowAgentRecord | undefined {
    const agent = this.selectedAgent(run);
    return this.agentActionsVisible(run) && isCancellableAgent(agent) ? agent : undefined;
  }

  private agentActionsVisible(run: WorkflowSnapshot | undefined): boolean {
    const currentRows = dashboardOverlayRows(this.tui.terminal?.rows ?? 0, this.fullscreen());
    const currentColumns = this.tui.terminal?.columns;
    if (currentRows !== this.#lastRenderRows || (currentColumns && currentColumns !== this.#lastRenderWidth)) return false;
    const agent = this.selectedAgent(run);
    const phase = this.phaseFor(run);
    const visible = this.#visibleAgent;
    return !!run && !!agent && !!visible
      && visible.runId === run.runId
      && visible.phaseIndex === phase?.index
      && visible.agentIndex === agent.index;
  }

  private markVisibleAgent(
    run: WorkflowSnapshot,
    phase: WorkflowPhase | undefined,
    agent: WorkflowAgentRecord,
  ): void {
    this.#visibleAgent = {
      runId: run.runId,
      phaseIndex: phase?.index,
      agentIndex: agent.index,
    };
  }

  private refreshAgentVisibility(run: WorkflowSnapshot | undefined): void {
    if (!run || !this.#layout || this.isCompactGeometry() || this.#lastRenderWidth < 4) return;
    if (this.#pane === "agent") {
      const agent = this.selectedAgent(run);
      if (agent) this.markVisibleAgent(run, this.phaseFor(run), agent);
      return;
    }
    if (this.#pane === "list") {
      this.#visibleAgent = undefined;
      return;
    }
    const frame = createDashboardFrame(this.theme, this.#lastRenderWidth, this.#focused);
    if (this.#layout.kind === "wide") {
      const { right } = frame.columns(this.#layout.railWidth);
      this.workflowOverviewViewport(run, this.#layout.contentRows, Math.max(1, right - 1));
    } else if (this.#layout.kind === "medium") {
      this.workflowOverviewViewport(run, this.#layout.detailRows, Math.max(1, frame.innerWidth - 1));
    } else {
      this.workflowOverviewViewport(run, this.#layout.contentRows, Math.max(1, frame.innerWidth - 1));
    }
  }

  private refreshRenderedControls(run: WorkflowSnapshot | undefined): void {
    if (!run || !this.#layout || this.isCompactGeometry() || this.#lastRenderWidth < 4 || this.#confirmCancel || this.#notice) return;
    this.#renderedAgentCancel = undefined;
    this.#renderedRunCancelId = undefined;
    this.renderHint(createDashboardFrame(this.theme, this.#lastRenderWidth, this.#focused), run);
  }

  private requestRunCancel(run: WorkflowSnapshot | undefined): void {
    if (!run || workflowIsTerminal(run.status) || this.#renderedRunCancelId !== run.runId) return;
    this.#confirmCancel = { type: "run", runId: run.runId, confirmKey: "X" };
    this.#renderedConfirmationTarget = cancelTargetKey(this.#confirmCancel);
  }

  private confirmCancel(target: CancelTarget, selected: WorkflowSnapshot | undefined): void {
    if (!this.#runs.some((candidate) => candidate.runId === target.runId)) {
      this.#notice = "The selected workflow is no longer retained.";
      this.tui.requestRender();
      return;
    }
    let run: WorkflowSnapshot | undefined;
    if (selected?.runId === target.runId) run = selected;
    else {
      try { run = this.manager.check(target.runId); }
      catch { /* the target may have been evicted while confirmation was armed */ }
    }
    if (!run) {
      this.#notice = "The selected workflow is no longer retained.";
      this.tui.requestRender();
      return;
    }
    if (target.type === "run") {
      if (workflowIsTerminal(run.status)) {
        this.#notice = "The selected workflow is already finished.";
        this.tui.requestRender();
        return;
      }
      this.#notice = `Cancelling ${sanitizeInline(run.name)}…`;
      void this.manager.cancel(target.runId, "Cancelled from /workflows dashboard").catch((error: unknown) => {
        this.#notice = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
      this.tui.requestRender();
      return;
    }

    const visibleAgents = this.phaseAgents(run, this.phaseFor(run));
    const agent = visibleAgents.find((candidate) => candidate.index === target.agentIndex);
    if (this.#selectedRunId !== target.runId || this.#selectedAgentIndex !== target.agentIndex) {
      this.#notice = "The selected agent changed; cancellation was dismissed.";
      this.tui.requestRender();
      return;
    }
    if (!this.agentActionsVisible(run)) {
      this.#notice = "The selected agent is not visible; cancellation was dismissed.";
      this.tui.requestRender();
      return;
    }
    if (!isCancellableAgent(agent)) {
      this.#notice = "The selected agent is no longer cancellable.";
      this.tui.requestRender();
      return;
    }
    this.#notice = `Cancelling ${sanitizeInline(agent.name)}…`;
    void this.manager.cancelAgent(target.runId, target.agentIndex, "Workflow agent cancelled from /workflows dashboard").catch((error: unknown) => {
      this.#notice = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    });
    this.tui.requestRender();
  }

  /* ── scrolling ────────────────────────────────────────────────────────── */

  private resetScroll(): void {
    this.#scroll = 0;
    this.#scrollKey = undefined;
    this.#followTail = true;
    this.#resultRows = 0;
    this.#resultTotal = 0;
  }

  private maxScroll(): number {
    return Math.max(0, this.#resultTotal - this.#resultRows);
  }

  private scrollResult(delta: number): void {
    this.scrollTo(this.#scroll + delta);
  }

  private scrollTo(offset: number): void {
    const max = this.maxScroll();
    this.#scroll = clampDashboard(offset, 0, max);
    // An explicit top request must unpin even when the detail body has not
    // rendered once yet and therefore still reports a zero-height viewport.
    this.#followTail = offset !== 0 && this.#scroll >= max;
  }

  private pageStep(): number {
    return Math.max(1, this.#resultRows - 1);
  }

  private halfPageStep(): number {
    return Math.max(1, Math.floor(this.#resultRows / 2));
  }

  private renderScrollableBody(body: string[], rows: number, key: string, width: number): string[] {
    const viewportRows = Math.max(0, rows - 1);
    this.#resultRows = viewportRows;
    this.#resultTotal = body.length;
    if (this.#scrollKey !== key) {
      const explicitlyUnpinned = !this.#followTail;
      this.#scrollKey = key;
      this.#scroll = 0;
      this.#followTail = !explicitlyUnpinned;
    }
    const max = this.maxScroll();
    this.#scroll = this.#followTail ? max : clampDashboard(this.#scroll, 0, max);
    const start = this.#scroll;
    const end = Math.min(body.length, start + viewportRows);
    const range = viewportRows ? `${start + 1}–${end}` : "0";
    // Matches /subagents' `── label ──` divider so the two panels share one
    // scroll-label grammar instead of a plain themed text row.
    const label = dashboardScrollRule(this.theme, `Detail ${range}/${body.length} · Shift+↑↓/PgUp/PgDn · Ctrl+U/D · g/G`, width);
    return [label, ...body.slice(start, end)];
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */

  private renderWide(
    frame: DashboardFrame,
    layout: DashboardLayout,
    runs: WorkflowSnapshot[],
    collection: DashboardCollection<WorkflowSnapshot, WorkflowDashboardGroup>,
    chosen: WorkflowSnapshot | undefined,
  ): string[] {
    const { left, right } = frame.columns(layout.railWidth);
    const view = dashboardCollectionViewport(collection, this.#selectedRunId, layout.contentRows, (run) => run.runId);
    const rail = this.renderRunRail(runs, view, chosen, layout.contentRows, Math.max(1, left - 1));
    const detail = this.renderInspector(chosen, layout.contentRows, Math.max(1, right - 1));
    const lines = [
      this.renderHeader(frame, runs),
      frame.splitTop(this.listTitle(runs, view), this.detailTitle(chosen), layout.railWidth),
    ];
    for (let index = 0; index < layout.contentRows; index++) {
      lines.push(frame.splitRow(` ${rail[index] ?? ""}`, ` ${detail[index] ?? ""}`, layout.railWidth));
    }
    lines.push(frame.splitBottom(layout.railWidth), this.renderHint(frame, chosen));
    return lines;
  }

  private renderMedium(
    frame: DashboardFrame,
    layout: DashboardLayout,
    runs: WorkflowSnapshot[],
    collection: DashboardCollection<WorkflowSnapshot, WorkflowDashboardGroup>,
    chosen: WorkflowSnapshot | undefined,
  ): string[] {
    const view = dashboardCollectionViewport(collection, this.#selectedRunId, layout.listRows, (run) => run.runId);
    const lines = [this.renderHeader(frame, runs), frame.top(this.listTitle(runs, view))];
    for (const row of this.renderRunList(runs, view, chosen, layout.listRows, frame.innerWidth)) lines.push(frame.row(row));
    lines.push(frame.divider(this.detailTitle(chosen)));
    for (const row of this.renderInspector(chosen, layout.detailRows, Math.max(1, frame.innerWidth - 1))) lines.push(frame.row(` ${row}`));
    lines.push(frame.bottom(), this.renderHint(frame, chosen));
    return lines;
  }

  private renderNarrow(
    frame: DashboardFrame,
    layout: DashboardLayout,
    runs: WorkflowSnapshot[],
    collection: DashboardCollection<WorkflowSnapshot, WorkflowDashboardGroup>,
    chosen: WorkflowSnapshot | undefined,
  ): string[] {
    const view = dashboardCollectionViewport(collection, this.#selectedRunId, layout.contentRows, (run) => run.runId);
    const detail = this.#pane !== "list" && chosen;
    const lines = [
      this.renderHeader(frame, runs),
      frame.top(detail ? this.detailTitle(chosen) : this.listTitle(runs, view)),
    ];
    const body = detail
      ? this.renderInspector(chosen, layout.contentRows, Math.max(1, frame.innerWidth - 1)).map((row) => ` ${row}`)
      : this.renderRunList(runs, view, chosen, layout.contentRows, frame.innerWidth);
    for (const row of fitDashboardRows(body, layout.contentRows)) lines.push(frame.row(row));
    lines.push(frame.bottom(), this.renderHint(frame, chosen));
    return lines;
  }

  private renderCompact(rows: number, count: number, frame: DashboardFrame): string[] {
    const header = frame.header(
      this.theme.fg("accent", this.theme.bold("Workflow runs")),
      this.theme.fg("muted", `${count} run${count === 1 ? "" : "s"}`),
    );
    if (rows <= 1) return [truncateWorkflowDashboardLine("Esc close", frame.innerWidth + 2)];
    if (rows === 2) return [header, frame.hint("Esc close")];
    if (rows === 3) return [header, frame.row(this.theme.fg("dim", "  Resize to inspect workflows.")), frame.hint("Esc close")];
    if (rows === 4) return [header, frame.top("runs"), frame.bottom(), frame.hint("Esc close")];
    return [
      header,
      frame.top("runs"),
      frame.row(this.theme.fg("dim", "  Screen too short for dashboard detail.")),
      frame.bottom(),
      frame.hint("Esc close"),
    ].slice(0, rows);
  }

  /** `?` cheatsheet: a grouped legend for whichever of list/overview/agent is active. */
  private renderHelp(frame: DashboardFrame, layout: DashboardLayout, runs: WorkflowSnapshot[]): string[] {
    const narrowList = layout.kind === "narrow" && this.#pane === "list";
    return [
      this.renderHeader(frame, runs),
      ...renderDashboardHelp(this.theme, frame, "help", this.helpGroups(narrowList, this.#pane === "agent"), layout.contentRows),
      frame.hint(`? or ${dashboardCancelKeyLabel(this.keybindings)} close help`),
    ];
  }

  private helpGroups(narrowList: boolean, agentPane: boolean): DashboardKeyGroup[] {
    const confirm = dashboardConfirmKeyLabel(this.keybindings);
    const cancel = dashboardCancelKeyLabel(this.keybindings);
    if (narrowList) {
      return [
        { title: "Navigate", entries: [["↑↓ / j k", "select run"], [confirm, "open overview"]] },
        { title: "Actions", entries: [["X", "cancel a live run (press twice)"]] },
        { title: "Panel", entries: [[cancel, "close"], ["?", "close this help"]] },
      ];
    }
    if (agentPane) {
      return [
        { title: "Navigate", entries: [["h / ←", "back to overview"]] },
        { title: "Actions", entries: [
          ["x", "cancel this agent (press twice)"],
          ["X", "cancel the run (press twice)"],
          ["r", "restart this agent"],
          ["t / Ctrl+T", "toggle compact/full tool display"],
        ] },
        { title: "Scroll", entries: [
          ["Shift+↑↓ / PgUp/PgDn", "scroll result"],
          ["Ctrl+U/D", "half-page scroll"],
          ["g / G", "top / bottom"],
        ] },
        { title: "Panel", entries: [[cancel, "back / close"], ["?", "close this help"]] },
      ];
    }
    return [
      { title: "Navigate", entries: [
        ["↑↓ / j k", "select run"],
        ["←→ / h l", "select phase"],
        ["Tab", "select agent"],
        [confirm, "inspect agent"],
      ] },
      { title: "Actions", entries: [
        ["p", "pause / resume the run"],
        ["r", "restart the selected agent"],
        ["x", "cancel the selected agent (press twice)"],
        ["X", "cancel the run (press twice)"],
        ["f", "cycle the agent filter"],
      ] },
      { title: "Scroll", entries: [
        ["Shift+↑↓ / PgUp/PgDn", "scroll result"],
        ["Ctrl+U/D", "half-page scroll"],
        ["g / G", "top / bottom"],
      ] },
      { title: "Panel", entries: [[cancel, "back / close"], ["?", "close this help"]] },
    ];
  }

  private renderHeader(frame: DashboardFrame, runs: WorkflowSnapshot[]): string {
    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    return frame.header(
      this.theme.fg("accent", this.theme.bold("Workflow runs")),
      this.theme.fg("muted", `${runs.length} run${runs.length === 1 ? "" : "s"}${active ? ` · ${active} active` : ""}`),
    );
  }

  private listTitle(runs: WorkflowSnapshot[], view: WorkflowListViewport): string {
    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    const clipped = `${view.clippedBefore ? "↑" : ""}${view.clippedAfter ? "↓" : ""}`;
    return `runs · ${active} active / ${runs.length}${clipped ? ` ${clipped}` : ""}`;
  }

  private detailTitle(run: WorkflowSnapshot | undefined): string {
    if (!run) return "inspector";
    if (this.#pane === "agent") {
      // The tool-display mode also lives in the terse footer hint, but that
      // hint truncates first under width pressure; the title survives longer.
      const agent = this.selectedAgent(run);
      return agent ? `agent · ${sanitizeInline(agent.name)} · ${agent.state} · ${this.#toolDisplay}` : "agent";
    }
    const phase = this.phaseFor(run);
    const progress = phase ? workflowPhaseProgress(run, phase.index) : undefined;
    return phase ? `workflow · phase ${progress?.label ?? "waiting"} · filter ${this.#agentFilter}` : "workflow";
  }

  private renderRunRail(runs: WorkflowSnapshot[], view: WorkflowListViewport, chosen: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!runs.length) return fitDashboardRows([this.theme.fg("muted", "No workflow runs in this session.")], rows);
    return fitDashboardRows(view.rows.map((row) => row.kind === "item"
      ? this.renderRun(row.item, row.item.runId === chosen?.runId, width, true)
      : this.renderCollectionRow(row, width)), rows);
  }

  private renderRunList(runs: WorkflowSnapshot[], view: WorkflowListViewport, chosen: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!runs.length) return fitDashboardRows([this.theme.fg("muted", "  No workflow runs in this session.")], rows);
    return fitDashboardRows(view.rows.map((row) => row.kind === "item"
      ? this.renderRun(row.item, row.item.runId === chosen?.runId, width)
      : this.renderCollectionRow(row, width)), rows);
  }

  private renderCollectionRow(
    row: Exclude<DashboardCollectionRow<WorkflowSnapshot, WorkflowDashboardGroup>, { kind: "item" }>,
    width: number,
  ): string {
    return row.kind === "section"
      ? dashboardSectionRow(this.theme, row.label, row.count, width)
      : dashboardFoldRow(this.theme, row.label, row.hidden, width);
  }

  private renderRun(run: WorkflowSnapshot, selected: boolean, width: number, rail = false): string {
    const status = workflowStatusMeta(run);
    const marker = dashboardSelectionMarker(this.theme, selected);
    const name = selected ? this.theme.fg("accent", sanitizeInline(run.name)) : this.theme.fg("text", sanitizeInline(run.name));
    const identity = ` ${marker} ${this.theme.fg(status.color, status.glyph)} ${name}`;
    const summary = workflowDashboardSummary(run, this.#now());
    const phase = workflowPhaseProgress(run).label;
    // A blocked question is not a lifecycle state, so the run keeps its own
    // status and carries the aggregate marker beside it, in words and a glyph.
    const needInput = workflowNeedsInput(run);
    const progress = rail ? "" : `phase ${phase} · `;
    const decoration = this.theme.fg(dashboardSummaryColor(summary), summary.text)
      + this.theme.fg("muted", ` · ${formatElapsed(run, this.#now())}`);
    const questions = needInput ? `${this.theme.fg("warning", `? ${needInput} need input`)} · ` : "";
    const right = `${questions}${this.theme.fg("muted", progress)}${this.theme.fg(status.color, workflowRunStatusLabel(run))} `;
    return alignDashboardSummaryRow(
      identity,
      decoration,
      right,
      width,
    );
  }

  private renderInspector(run: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!run) {
      this.#resultRows = 0;
      this.#resultTotal = 0;
      return fitDashboardRows([this.theme.fg("dim", "Select a workflow to inspect phases, agents, and results.")], rows);
    }
    return this.#pane === "agent" ? this.agentInspectorViewport(run, rows, width) : this.workflowOverviewViewport(run, rows, width);
  }

  private renderQuestionPreview(interaction: NonNullable<WorkflowAgentRecord["waitingOn"]>, width: number): string[] {
    const elapsed = formatDurationLabel(Math.max(0, this.#now() - interaction.createdAt));
    const target = interaction.target === "peer"
      ? `peer ${sanitizeInline(interaction.targetName ?? "agent")}`
      : "parent orchestrator";
    const next = interaction.target === "peer"
      ? `Next · no human action required; waiting for ${target}`
      : "Next · parent thread: subagent_answer; do not steer";
    return [
      truncateWorkflowDashboardLine(this.theme.fg("warning", `Question · ${sanitizeInline(interaction.question)}`), width),
      truncateWorkflowDashboardLine(this.theme.fg("muted", `Route · ${sanitizeInline(interaction.sourceName)} → ${target} · waiting ${elapsed}`), width),
      truncateWorkflowDashboardLine(this.theme.fg("text", next), width),
    ];
  }

  private renderProviderWaitPreview(agent: WorkflowAgentRecord, width: number): string[] {
    const wait = agent.providerWait;
    if (!wait) return [];
    const remaining = Math.max(0, wait.retryAt - this.#now());
    const retryLabel = remaining < 60_000
      ? `${Math.max(1, Math.round(remaining / 1_000))}s`
      : `${Math.round(remaining / 60_000)}m`;
    const window = sanitizeInline(wait.scope ?? wait.kind);
    const kind = wait.scope ? ` · ${sanitizeInline(wait.kind)}` : "";
    return [
      truncateWorkflowDashboardLine(this.theme.fg("warning", `Provider wait · ${sanitizeInline(agent.name)} · ${sanitizeInline(wait.provider)} · window ${window}${kind}`), width),
      truncateWorkflowDashboardLine(this.theme.fg("muted", `Retry · ${retryLabel} · attempt ${wait.attempt}/${wait.maxAttempts} · automatic; no human action required`), width),
    ];
  }

  private renderRunStatePreview(run: WorkflowSnapshot, width: number): string[] {
    const question = [...run.agents].reverse().find((agent) => agent.waitingOn)?.waitingOn;
    if (question) return this.renderQuestionPreview(question, width);

    const summary = workflowDashboardSummary(run, this.#now());
    const line = (color: Parameters<Theme["fg"]>[0], value: string) =>
      truncateWorkflowDashboardLine(this.theme.fg(color, value), width);
    if (summary.kind === "failure") {
      const failed = [...run.agents].reverse().find((agent) => agent.state === "failed" && agent.callIndex !== undefined);
      const recovery = failed
        ? `select ${sanitizeInline(failed.name)}, then press r to restart that agent`
        : "no run restart action is available here; inspect the failed agent or result";
      return [line("error", `Error · ${summary.text}`), line("text", `Recovery · ${recovery}`)];
    }
    if (run.status === "paused") {
      return [line("warning", `Paused · ${summary.text}`), line("text", "Next · press p to resume; human action is required")];
    }
    const providerWait = [...run.agents].reverse().find((agent) => agent.state === "waiting" && agent.providerWait);
    if (providerWait) return this.renderProviderWaitPreview(providerWait, width);
    if (run.status === "pending" || run.agents.some((agent) => agent.state === "queued")) {
      return [
        line("warning", `Waiting · ${summary.text}`),
        line("muted", "Next · automatic dispatch; no human action required"),
      ];
    }
    if (run.status === "running") {
      return [line("accent", `Latest · ${summary.text}`), line("muted", "Next · monitor here or press p to pause")];
    }
    if (run.status === "completed") {
      const prefix = "Result · ";
      const suffix = " · no action · inspect here";
      const previewWidth = Math.max(1, width - prefix.length - suffix.length);
      const preview = truncateToWidth(summary.text, previewWidth, "…");
      return [line("success", `${prefix}${preview}${suffix}`)];
    }
    return [
      line("muted", `State · ${summary.text}`),
      line("muted", "Recovery · no run restart action is available here; inspect an agent for available actions"),
    ];
  }

  private renderAgentStatePreview(agent: WorkflowAgentRecord, width: number): string[] {
    if (agent.waitingOn) return this.renderQuestionPreview(agent.waitingOn, width);
    const summary = workflowAgentDashboardSummary(agent, this.#now());
    const line = (color: Parameters<Theme["fg"]>[0], value: string) =>
      truncateWorkflowDashboardLine(this.theme.fg(color, value), width);
    if (summary.kind === "failure") {
      const recovery = agent.callIndex === undefined
        ? "no restart action is available for this agent"
        : "press r to restart this agent";
      return [line("error", `Error · ${summary.text}`), line("text", `Recovery · ${recovery}`)];
    }
    if (agent.state === "waiting" && agent.providerWait) return this.renderProviderWaitPreview(agent, width);
    if (agent.state === "queued") {
      return [
        line("warning", `Waiting · ${summary.text}`),
        line("muted", "Next · automatic dispatch; no human action required"),
      ];
    }
    if (agent.state === "running") {
      return [line("accent", `Latest · ${summary.text}`), line("muted", "Next · monitor here; no human action required")];
    }
    if (agent.state === "completed") {
      const next = agent.callIndex === undefined
        ? "no human action required"
        : "no human action required; press r only to start a replacement run";
      return [line("success", `Result · ${summary.text}`), line("muted", `Next · ${next}`)];
    }
    const recovery = agent.callIndex === undefined
      ? "no recovery action is available for this agent"
      : "press r to restart this agent";
    return [line("muted", `State · ${summary.text}`), line("muted", `Recovery · ${recovery}`)];
  }

  private workflowOverviewViewport(run: WorkflowSnapshot, rows: number, width: number): string[] {
    this.#resultRows = 0;
    this.#resultTotal = 0;
    const phase = this.phaseFor(run);
    const allAgents = this.allPhaseAgents(run, phase);
    const agents = this.phaseAgents(run, phase);
    const usageSnapshot = aggregateWorkflowUsage(run);
    const usage = formatUsage(usageSnapshot);
    const budget = formatWorkflowBudget(run, usageSnapshot);
    const status = workflowStatusMeta(run);
    const progress = workflowPhaseProgress(run);
    const lines: string[] = [
      `${this.theme.fg("accent", this.theme.bold(sanitizeInline(run.name) || "Workflow"))} ${this.theme.fg(status.color, `· ${shortId(sanitizeText(run.runId))} · ${status.glyph} ${run.status}${run.status === "completed" ? ` · task ${run.taskOutcome ?? "unspecified"}` : ""}`)} ${this.theme.fg("dim", `· ${formatElapsed(run, this.#now())}`)}`,
      ...this.renderRunStatePreview(run, width),
      phase
        ? this.renderPhase(run, phase)
        : this.theme.fg("dim", progress.waiting ? "Phase · waiting for the first phase" : "Phase · no phases recorded"),
      this.theme.fg("dim", boundedInline(run.description, 2_000) || "(no workflow description)"),
    ];
    if (phase?.description) lines.push(this.theme.fg("muted", `Phase context · ${boundedInline(phase.description, 2_000)}`));
    if (run.convergence) {
      const meta = workflowConvergenceMeta(run.convergence);
      lines.push(this.theme.fg(meta.color, `Convergence · ${meta.glyph} ${boundedInline(formatWorkflowConvergence(run.convergence), 1_000)}`));
    }
    if (usage) lines.push(this.theme.fg("dim", `Usage · ${usage}`));
    if (budget) lines.push(this.theme.fg("dim", `Budget · ${budget}`));
    if (run.approval) lines.push(this.theme.fg("muted", `Approval · ${run.approval}`));
    if (run.definitionFingerprint) lines.push(this.theme.fg("muted", `Provenance · definition ${shortId(run.definitionFingerprint)}`));
    for (const warning of run.warnings?.slice(0, 2) ?? []) lines.push(this.theme.fg("warning", `⚠ ${boundedInline(warning, 1_000)}`));
    const settledInteractions = (run.interactions ?? [])
      .filter((interaction) => interaction.state !== "pending" && interaction.state !== "answering")
      .slice(-3);
    if (settledInteractions.length) {
      lines.push(this.theme.fg("muted", `Questions · ${settledInteractions.length} recent settled`));
      for (const interaction of settledInteractions) {
        lines.push(this.theme.fg("dim", `· ${boundedInline(interaction.sourceName, 500)} → ${boundedInline(formatWorkflowInteraction(interaction, this.#now()), MAX_ACTIVITY_CHARS)}`));
      }
    }
    const activity = (run.logs ?? []).slice(-3);
    if (activity.length) {
      lines.push(this.theme.fg("muted", `Activity · ${activity.length} recent log${activity.length === 1 ? "" : "s"}`));
      for (const log of activity) lines.push(this.theme.fg("dim", `· ${boundedInline(log.message, MAX_ACTIVITY_CHARS)}`));
    }
    lines.push(this.theme.fg("muted", `Agents · ${agents.length}/${allAgents.length} shown · filter ${this.#agentFilter} · Tab select · ${dashboardConfirmKeyLabel(this.keybindings)} inspect`));

    if (!agents.length) {
      const noAgents = this.theme.fg("dim", allAgents.length ? "No agents match this filter." : "No agents in this phase yet.");
      if (allAgents.length || (run.result === undefined && phase?.result === undefined && !run.logs?.length)) {
        lines.push(noAgents);
        return fitDashboardRows(lines, rows);
      }

      // A standalone workflow can have enough run metadata to consume every
      // overview row. Keep a label plus one body row for the result, and move
      // the metadata that does not fit into the same scrollable body.
      const metadata = [...lines, noAgents, this.theme.fg("muted", "Workflow result")];
      const pinnedRows = Math.min(metadata.length, Math.max(0, rows - MIN_SCROLLABLE_DETAIL_ROWS));
      const body = [
        ...metadata.slice(pinnedRows),
        ...this.workflowResultBody(run, phase, width),
      ];
      const viewport = this.renderScrollableBody(
        body,
        rows - pinnedRows,
        `workflow:${run.runId}:${phase?.index ?? "none"}`,
        width,
      );
      return fitDashboardRows([...metadata.slice(0, pinnedRows), ...viewport], rows);
    }

    const room = Math.max(1, rows - lines.length);
    const selectedPosition = agents.findIndex((agent) => agent.index === this.#selectedAgentIndex);
    const view = dashboardListViewport(agents, selectedPosition < 0 ? 0 : selectedPosition, room);
    for (const agent of view.items) lines.push(this.renderAgentRow(agent, agent.index === this.#selectedAgentIndex));
    const rendered = fitDashboardRows(lines, rows);
    const selectedOffset = view.items.findIndex((agent) => agent.index === this.#selectedAgentIndex);
    const selectedLine = lines.length - view.items.length + selectedOffset;
    if (selectedOffset >= 0 && selectedLine < rendered.length) {
      this.markVisibleAgent(run, phase, this.selectedAgent(run)!);
    }
    return rendered;
  }

  private workflowResultBody(run: WorkflowSnapshot, phase: WorkflowPhase | undefined, width: number): string[] {
    const logs = run.logs?.slice(-8).map((log) => this.theme.fg("muted", `· ${boundedInline(log.message, 2_000)}`)) ?? [];
    const result = this.renderBoundedResult(run, phase, undefined, width);
    return logs.length ? [this.theme.fg("muted", "Activity"), ...logs, ...result] : result;
  }

  private agentInspectorViewport(run: WorkflowSnapshot, rows: number, width: number): string[] {
    const phase = this.phaseFor(run);
    const agent = this.selectedAgent(run);
    if (!agent) {
      this.#pane = "overview";
      return this.workflowOverviewViewport(run, rows, width);
    }
    this.markVisibleAgent(run, phase, agent);

    const status = traceStatusMeta(agent.state, this.#now());
    const route = agent.harness || agent.model ? `${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}` : "route pending";
    const usage = formatUsage(agent.usage);
    const policy = `${agent.access}${agent.profile ? ` · profile ${boundedInline(agent.profile, 500)}` : ""}${agent.independent ? " · independent" : ""}`;
    const metadata: string[] = [
      `${this.theme.fg("accent", this.theme.bold(boundedInline(agent.name, 1_000)))} ${this.theme.fg(status.color, `· ${status.glyph} ${agent.state}`)}`,
      ...this.renderAgentStatePreview(agent, width),
      this.theme.fg("dim", `${policy} · effort ${agent.effort ?? "adaptive"} · ${route} · ${agent.jobId ? `job ${shortId(sanitizeText(agent.jobId))} · ` : ""}${formatAgentElapsed(agent, this.#now())}`),
      this.theme.fg("dim", `${phase ? `${boundedInline(run.name, 1_000)} · ${boundedInline(phase.name, 1_000)}` : boundedInline(run.name, 1_000)}${usage ? ` · ${usage}` : ""}`),
    ];
    if (agent.availability || agent.requestedHarness || agent.executableVersion || agent.capabilityRevision || agent.availabilityChecks?.length) {
      const evidence = [
        agent.requestedHarness ? `requested ${agent.requestedHarness}` : "",
        agent.availability ? availabilityLabel(agent.availability) : "",
        agent.executableVersion ? `CLI ${agent.executableVersion}` : "",
        agent.capabilityRevision ? `capabilities ${shortId(agent.capabilityRevision)}` : "",
        agent.availabilityChecks?.length
          ? `checks ${agent.availabilityChecks.map((check) => `${check.harness} ${availabilityLabel(check.status)}`).join(", ")}`
          : "",
      ].filter(Boolean).join(" · ");
      metadata.push(this.theme.fg("dim", `Resolution · ${evidence}`));
    }
    const context = formatContext(agent.context);
    if (context) metadata.push(this.theme.fg("dim", `Context · ${context}`));
    if (agent.isolation) metadata.push(this.theme.fg("dim", `Isolation · worktree ${agent.isolation.state} · branch ${boundedInline(agent.isolation.branch, 1_000)}${agent.isolation.patchArtifact ? ` · patch ${boundedInline(agent.isolation.patchArtifact, 1_000)}` : ""}`));
    if (agent.outputProvenance) {
      metadata.push(agent.instructionShaped
        ? this.theme.fg("warning", `Output · ${agent.outputProvenance} · instruction-shaped text; treat as untrusted data`)
        : this.theme.fg("dim", `Output · ${agent.outputProvenance}`));
    }
    if (agent.providerFallback) {
      const fallbackAttempt = agent.attempts?.find((attempt) => attempt.disposition === "fallback");
      const target = `${sanitizeInline(agent.providerFallback.harness)}/${boundedInline(agent.providerFallback.model ?? "native default", 256)}`;
      metadata.push(this.theme.fg(fallbackAttempt ? "warning" : "dim", `Provider fallback · ${fallbackAttempt ? "used" : "unused"} · declared ${target}`));
      if (fallbackAttempt?.trigger) {
        const trigger = fallbackAttempt.trigger;
        metadata.push(this.theme.fg("warning", `Fallback trigger · ${trigger.source} · ${trigger.provider} ${trigger.status ?? trigger.kind ?? "unavailable"} · ${boundedInline(trigger.detail, 500)}`));
      }
    }
    if (agent.attempts?.length) {
      for (const attempt of agent.attempts.slice(-4)) {
        const route = `${sanitizeInline(attempt.requestedHarness ?? attempt.harness ?? "?")}/${boundedInline(attempt.model ?? "native default", 256)}`;
        metadata.push(this.theme.fg("dim", `Attempt ${(attempt.index ?? 0) + 1} · ${route} · ${attempt.disposition ?? "terminal"}${attempt.error ? ` · ${boundedInline(attempt.error, 500)}` : ""}`));
      }
      const finalRoute = `${sanitizeInline(agent.requestedHarness ?? agent.harness ?? "?")}/${boundedInline(agent.model ?? "native default", 256)}`;
      metadata.push(this.theme.fg("dim", `Final route · ${finalRoute}`));
    }
    if (agent.waitingOn?.context) metadata.push(this.theme.fg("dim", `Question context · ${boundedInline(agent.waitingOn.context, 1_000)}`));
    if (agent.generations?.length) metadata.push(this.theme.fg("dim", `Generations · ${agent.generations.length} (call ${agent.callIndex ?? agent.generations.at(-1)?.callIndex})`));
    if (agent.independentOf) metadata.push(this.theme.fg("muted", `Provenance · independent of ${shortId(sanitizeText(agent.independentOf))}`));
    if (agent.replayedFrom) metadata.push(this.theme.fg("muted", `Replay · ${shortId(sanitizeText(agent.replayedFrom.runId))} call ${agent.replayedFrom.callIndex}`));
    if (agent.replacedBy) metadata.push(this.theme.fg("muted", `Replacement · ${shortId(sanitizeText(agent.replacedBy.replacementRunId))} · ${boundedInline(agent.replacedBy.reason, 1_000)}`));
    if (agent.truncated) metadata.push(this.theme.fg("warning", "Output · bounded transcript omitted older content"));

    // Keep the operator's most important recovery context visible while the
    // bounded result body follows its tail. Omitted metadata and the full
    // bounded sections remain scrollable, so g/G and page navigation reach
    // every part.
    if (agent.prompt) metadata.push(this.theme.fg("muted", `Prompt · ${boundedInline(agent.prompt, 2_000)}`));

    const pinnedRows = Math.min(metadata.length, Math.max(0, rows - MIN_SCROLLABLE_DETAIL_ROWS));
    const pinned = metadata.slice(0, pinnedRows);
    const omittedMetadata = metadata.length > pinnedRows
      ? [this.theme.fg("muted", "Metadata"), ...metadata.slice(pinnedRows)]
      : [];
    const body = [...omittedMetadata, ...this.agentDetailBody(run, phase, agent, width)];
    const resultRows = this.renderScrollableBody(body, rows - pinned.length, `agent:${run.runId}:${phase?.index ?? "none"}:${agent.index}`, width);
    return fitDashboardRows([...pinned, ...resultRows], rows);
  }

  private agentDetailBody(run: WorkflowSnapshot, phase: WorkflowPhase | undefined, agent: WorkflowAgentRecord, width: number): string[] {
    const signature = detailSignature(run, phase, agent);
    const key = `agent:${run.runId}:${phase?.index ?? "none"}:${agent.index}:${width}:${this.#toolDisplay}:${signature}`;
    const cached = this.#detailCache.get(key);
    if (cached) return cached;

    const body: string[] = [];
    const errorRaw = sanitizeText(agent.error ?? phase?.error ?? run.error ?? "");
    if (errorRaw.trim()) {
      const error = boundedHeadTailText(errorRaw, MAX_ERROR_CHARS, "error");
      appendBoundedSection(body, this.theme, "Error", renderPrefixedRows(this.theme, "", error, "error", width), 12);
    }
    if (agent.prompt) {
      const prompt = boundedHeadTailText(sanitizeText(agent.prompt), MAX_PROMPT_CHARS, "prompt");
      appendBoundedSection(body, this.theme, "Prompt", renderPrefixedRows(this.theme, this.theme.fg("accent", "> "), prompt, "userMessageText", width), 48);
    }
    if (agent.liveThinking?.trim()) {
      // Tool lifecycle detail already lives in the Transcript section below; keep this
      // section to semantic live-thinking progress so it isn't duplicated here.
      const thinking = boundedHeadTailText(sanitizeText(agent.liveThinking), MAX_ACTIVITY_CHARS, "activity");
      const activity = renderPrefixedRows(this.theme, this.theme.fg("dim", "~ "), thinking, "muted", width);
      appendBoundedSection(body, this.theme, "Activity", activity, 16);
    }
    if (agent.structured !== undefined) {
      const raw = serializeResult(agent.structured);
      const text = boundedHeadTailText(raw, MAX_STRUCTURED_CHARS, "structured result");
      const structured = this.renderMarkdownLines(`\`\`\`json\n${text}\n\`\`\``, width);
      if (text.length < raw.length) structured.push(this.theme.fg("muted", "… structured result truncated to 4 KiB"));
      const heading = agent.structuredTransport ? `Structured result (${agent.structuredTransport})` : "Structured result";
      appendBoundedSection(body, this.theme, heading, structured, 72);
    }
    if (agent.generations?.length) {
      const rows = agent.generations.map((generation) => {
        const status = traceStatusMeta(generation.state, this.#now());
        const prompt = generation.prompt ? ` · ${boundedInline(generation.prompt, 200)}` : "";
        const detail = generation.error ? ` · ${boundedInline(generation.error, 200)}` : "";
        return this.theme.fg(status.color, `${status.glyph} generation ${generation.index} · call ${generation.callIndex} · ${generation.state}${prompt}${detail}`);
      });
      appendBoundedSection(body, this.theme, "Generations", rows, 16);
    }
    appendBoundedSection(body, this.theme, agent.transcript?.length ? "Transcript" : "Result", this.renderBoundedResult(run, phase, agent, width), 160);
    const finalAssistant = [...(agent.transcript ?? [])].reverse().find((entry) => entry.kind === "assistant")?.text;
    if (agent.transcript?.length && typeof agent.output === "string" && agent.output && agent.output !== finalAssistant) {
      const final = boundedHeadTailText(sanitizeText(agent.output), MAX_FINAL_RESULT_CHARS, "final result");
      appendBoundedSection(body, this.theme, "Final result", this.renderMarkdownLines(final, width), 80);
    }

    const bounded = boundRenderedRows(body, MAX_RESULT_ROWS, this.theme, "detail rows");
    this.#detailCache.set(key, bounded);
    if (this.#detailCache.size > 24) this.#detailCache.delete(this.#detailCache.keys().next().value as string);
    return bounded;
  }

  private renderPhase(run: WorkflowSnapshot, phase: WorkflowPhase): string {
    const progress = workflowPhaseProgress(run, phase.index);
    if (run.plannedPhaseCount !== undefined && run.currentPhase === null) {
      return `${this.theme.fg("accent", `Phase ${progress.label}`)} ${this.theme.fg("dim", "no current phase · ←→")}`;
    }
    const status = traceStatusMeta(phase.status, this.#now());
    return `${this.theme.fg("accent", `Phase ${progress.label}`)} ${this.theme.fg(status.color, `${status.glyph} ${boundedInline(phase.name, 1_000)}`)} ${this.theme.fg("dim", `· ${phase.status} · ←→`)}`;
  }

  private renderAgentRow(agent: WorkflowAgentRecord, selected: boolean): string {
    // A routed-question wait is not the agent's lifecycle state: mark it with
    // its own glyph and words so it never reads as ordinary queueing.
    const status = agent.waitingOn ? { glyph: "?", color: "warning" as const } : traceStatusMeta(agent.state, this.#now());
    const marker = dashboardNestedSelectionMarker(this.theme, selected);
    const label = selected ? this.theme.fg("accent", boundedInline(agent.name, 1_000)) : this.theme.fg("text", boundedInline(agent.name, 1_000));
    const summary = workflowAgentDashboardSummary(agent, this.#now());
    const route = agent.harness || agent.model ? `${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}` : "route pending";
    const usage = formatUsage(agent.usage);
    const warning = agent.instructionShaped ? " · ⚠ instruction-like output" : "";
    return `${marker} ${this.theme.fg(status.color, status.glyph)} ${label} ${this.theme.fg("dim", "·")} ${this.theme.fg(dashboardSummaryColor(summary), summary.text)} ${this.theme.fg("dim", `· ${agent.access}${agent.profile ? ` · profile ${boundedInline(agent.profile, 500)}` : ""}${agent.independent ? " · independent" : ""} · ${route} · effort ${agent.effort ?? "adaptive"} · ${formatAgentElapsed(agent, this.#now())}${usage ? ` · ${usage}` : ""}${warning}`)}`;
  }

  private allPhaseAgents(run: WorkflowSnapshot, phase: WorkflowPhase | undefined): WorkflowAgentRecord[] {
    if (!phase) return [];
    const indices = new Set(phase.agents);
    return run.agents.filter((agent) => indices.has(agent.index) || agent.phase === phase.index);
  }

  private phaseAgents(run: WorkflowSnapshot, phase: WorkflowPhase | undefined): WorkflowAgentRecord[] {
    return this.allPhaseAgents(run, phase).filter((agent) => matchesAgentFilter(agent, this.#agentFilter));
  }

  private renderBoundedResult(run: WorkflowSnapshot, phase: WorkflowPhase | undefined, agent: WorkflowAgentRecord | undefined, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const signature = detailSignature(run, phase, agent);
    const key = `result:${run.runId}:${phase?.index ?? "none"}:${agent?.index ?? "workflow"}:${safeWidth}:${this.#toolDisplay}:${signature}`;
    const cached = this.#detailCache.get(key);
    if (cached) return cached;

    const transcript = agent?.transcript?.length ? agent.transcript : undefined;
    let rows: string[] = [];
    let truncated = false;
    if (transcript) {
      const traces = new Map((agent?.tools ?? []).map((tool) => [tool.id, tool]));
      const parts = boundedTranscriptParts(transcript, MAX_RESULT_CHARS);
      // Pair every tool event by id across the whole bounded window up front, not
      // just within one adjacent run, so a call interrupted by an assistant/user/
      // thinking entry still resolves to exactly one call instead of a running
      // group plus a separate completed group for the same id.
      const { pairs } = pairToolEntries(
        parts.map((part) => part.entry).filter((entry): entry is ToolEntry => entry?.kind === "tool"),
      );
      const emitted = new Set<string>();
      let runIds: string[] = [];
      const flushToolRun = () => {
        if (!runIds.length) return;
        const calls = runIds.map((id) => pairs.get(id)!);
        if (this.#toolDisplay === "compact") {
          const states = calls.map(({ call, result }) => toolCallState(call, result, traces.get(call.toolId)));
          rows.push(renderToolGroupRow(summarizeToolCalls(states), this.theme, safeWidth));
        } else {
          for (const { call, result } of calls) {
            const snapshot = resolveToolRenderSnapshot(
              `${run.runId}:${agent?.index ?? "workflow"}:${call.toolId}`,
              "",
              call,
              result,
              traces.get(call.toolId),
            );
            rows.push(...renderPiTool(snapshot, safeWidth));
          }
        }
        runIds = [];
      };
      for (const part of parts) {
        const { entry, text } = part;
        if (!entry) {
          flushToolRun();
          rows.push(this.theme.fg("muted", text));
          continue;
        }
        if (entry.kind === "tool") {
          if (isTranscriptTruncationEntry(entry)) {
            flushToolRun();
            rows.push(this.theme.fg("muted", entry.text ?? text));
            continue;
          }
          if (!emitted.has(entry.toolId)) {
            emitted.add(entry.toolId);
            runIds.push(entry.toolId);
          }
          continue;
        }
        flushToolRun();
        if (!text.trim()) continue;
        if (entry.kind === "assistant") rows.push(...this.renderMarkdownLines(text, safeWidth));
        else if (entry.kind === "user") rows.push(...renderPrefixedRows(this.theme, this.theme.fg("accent", "> "), text, "userMessageText", safeWidth));
        else rows.push(...renderPrefixedRows(this.theme, this.theme.fg("dim", "~ "), text, "muted", safeWidth));
      }
      flushToolRun();
    } else {
      const value = [agent?.output, agent?.preview, phase?.result, run.result].find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
      if (value === undefined) {
        rows = [this.theme.fg("dim", run.status === "running" || run.status === "paused" || run.status === "pending" ? "(no result yet)" : "(no result)")];
      } else {
        const structured = typeof value !== "string";
        const raw = serializeResult(value);
        const text = boundedHeadTailText(raw, MAX_RESULT_CHARS, structured ? "structured result" : "result");
        truncated = text.length < raw.length;
        rows = this.renderMarkdownLines(structured ? `\`\`\`json\n${text}\n\`\`\`` : text, safeWidth);
      }
    }

    if (truncated) rows.push(this.theme.fg("muted", "… result truncated to 16 KiB"));
    rows = boundRenderedRows(rows, MAX_RESULT_ROWS, this.theme, "rendered rows");
    const bounded = rows.length ? rows : [" "];
    this.#detailCache.set(key, bounded);
    if (this.#detailCache.size > 24) this.#detailCache.delete(this.#detailCache.keys().next().value as string);
    return bounded;
  }

  private renderMarkdownLines(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    try {
      const rendered = this.#renderMarkdown(text, safeWidth).map((line) => truncateToWidth(line, safeWidth, ""));
      return boundRenderedRows(rendered, MAX_RESULT_ROWS, this.theme, "Markdown rows");
    } catch {
      return boundRenderedRows(renderWorkflowMarkdown(text, safeWidth), MAX_RESULT_ROWS, this.theme, "Markdown rows");
    }
  }

  private renderHint(frame: DashboardFrame, run: WorkflowSnapshot | undefined): string {
    const back = `· ${dashboardCancelKeyLabel(this.keybindings)} ${this.backHint()}`;
    if (this.#confirmCancel) {
      const target = this.#confirmCancel;
      const selectedRun = this.#runs.find((candidate) => candidate.runId === target.runId);
      const label = target.type === "agent"
        ? selectedRun?.agents.find((agent) => agent.index === target.agentIndex)?.name ?? "agent"
        : selectedRun?.name ?? "workflow";
      const marker = `Press ${target.confirmKey} again to confirm`;
      const candidates = [
        [`Cancel ${sanitizeInline(label)}? ${marker}`, "· any key dismisses"],
        [`Cancel? ${marker}`, "· any key"],
        [marker, "· any key"],
      ] as const;
      const { rendered, confirmed } = renderDashboardConfirmHint(frame, marker, candidates, "Cancellation pending", back);
      if (confirmed) this.#renderedConfirmationTarget = cancelTargetKey(target);
      return rendered;
    }
    if (this.#notice) return frame.hint(`! ${boundedInline(this.#notice, 2_000)}`, back);

    const confirm = dashboardConfirmKeyLabel(this.keybindings);
    const agent = this.selectedAgent(run);
    const live = !!run && !workflowIsTerminal(run.status);
    const agentVisible = this.agentActionsVisible(run);
    const agentActionable = this.agentCancelActionable(run);
    const shortActions = frame.innerWidth < 60;
    const agentCancelLabel = shortActions ? "x cancel" : "x cancel agent";
    const runCancelLabel = shortActions ? "X cancel" : "X cancel run";
    if (this.#layout?.kind === "narrow" && this.#pane === "list") {
      const navigation = shortActions ? "↑↓/jk" : "↑↓/jk select";
      const actions = [live ? runCancelLabel : "", navigation, `${confirm} open`, "? help"].filter(Boolean).join(" · ");
      const rendered = frame.hint(actions, back);
      if (live && rendered.includes(runCancelLabel)) this.#renderedRunCancelId = run?.runId;
      return rendered;
    }
    const actions = this.#pane === "agent"
      ? [
        agentActionable ? agentCancelLabel : "",
        live ? runCancelLabel : "",
        agentVisible && agent?.callIndex !== undefined ? "r restart agent" : "",
        `t ${this.#toolDisplay === "compact" ? "full" : "compact"}`,
        "h/← overview",
        "Shift+↑↓/Pg scroll · Ctrl+U/D · g/G",
        "? help",
      ]
      : [
        agentActionable ? agentCancelLabel : "",
        live ? runCancelLabel : "",
        live ? `p ${run?.status === "paused" ? "resume" : "pause"}` : "",
        agentVisible && agent?.callIndex !== undefined ? "r restart agent" : "",
        this.#layout?.kind === "narrow" && this.#pane === "list" ? `↑↓/jk select · ${confirm} open` : `↑↓/jk run · ←→/hl phase · Tab agent · ${confirm} inspect · f filter`,
        "Shift+↑↓/Pg scroll · Ctrl+U/D · g/G",
        "? help",
      ];
    const rendered = frame.hint(actions.filter(Boolean).join(" · "), back);
    if (agentActionable && rendered.includes(agentCancelLabel)) {
      this.#renderedAgentCancel = { runId: run!.runId, agentIndex: agent!.index };
    }
    if (live && rendered.includes(runCancelLabel)) this.#renderedRunCancelId = run!.runId;
    return rendered;
  }

  private backHint(): string {
    if (this.#pane === "agent") return "back";
    if (this.#layout?.kind === "narrow" && this.#pane === "overview") return "back";
    return "close";
  }

}

function cancelTargetKey(target: CancelTarget): string {
  return target.type === "run"
    ? `run:${target.runId}`
    : `agent:${target.runId}:${target.agentIndex}`;
}

type WorkflowListViewport = DashboardCollectionViewport<WorkflowSnapshot, WorkflowDashboardGroup>;

function workflowDashboardCollection(
  runs: readonly WorkflowSnapshot[],
): DashboardCollection<WorkflowSnapshot, WorkflowDashboardGroup> {
  return groupDashboardCollection(runs, WORKFLOW_DASHBOARD_GROUPS, (run) => {
    if (workflowNeedsInput(run)) return "input";
    if (run.status === "pending" || run.status === "running" || run.status === "paused") return "active";
    if (run.status === "failed" || (run.status === "completed" && run.taskOutcome === "unsuccessful")) return "failed";
    return "finished";
  });
}

function workflowRunStatusLabel(run: WorkflowSnapshot): string {
  const providerWait = [...run.agents].reverse().find((agent) => agent.state === "waiting" && agent.providerWait)?.providerWait;
  if (providerWait) {
    return `${run.status} · waiting for ${sanitizeInline(providerWait.provider)} ${sanitizeInline(providerWait.kind)}`;
  }
  const outcome = run.status === "completed" && run.taskOutcome ? ` · ${run.taskOutcome}` : "";
  return `${run.status}${outcome}`;
}

function defaultWorkflow(runs: readonly WorkflowSnapshot[]): WorkflowSnapshot {
  return runs.find((run) => run.status === "running" || run.status === "paused")
    ?? runs.find((run) => run.status === "pending")
    ?? runs.reduce((latest, run) => run.timestamps.createdAt >= latest.timestamps.createdAt ? run : latest);
}

export async function openWorkflowsDashboard(ctx: Pick<ExtensionContext, "mode" | "ui">, manager: WorkflowsDashboardManager): Promise<void> {
  if (ctx.mode !== "tui") {
    const runs = manager.list();
    const message = runs.length
      ? runs.map((run) => `${sanitizeInline(run.runId)} ${run.status} ${sanitizeInline(run.name)}`).join("\n")
      : "No workflow runs in this session.";
    ctx.ui.notify(message, "info");
    return;
  }

  // Actions other than close are applied in place by the overlay itself
  // against the live manager, so a single mount handles the whole session.
  await ctx.ui.custom<WorkflowsDashboardAction>(
    (tui, theme, keybindings, done) => createWorkflowsDashboardOverlay(tui, theme, keybindings, manager, done),
    { overlay: true, overlayOptions: { width: "100%", minWidth: 40, maxHeight: "100%", anchor: "center" } },
  );
}

function matchesAgentFilter(agent: WorkflowAgentRecord, filter: AgentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return agent.state === "queued" || agent.state === "running" || agent.state === "waiting";
  if (filter === "failed") return agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted";
  return agent.state === "completed";
}

function isCancellableAgent(agent: WorkflowAgentRecord | undefined): agent is WorkflowAgentRecord {
  if (!agent) return false;
  if (agent.state === "waiting") return true;
  return (agent.state === "queued" || agent.state === "running")
    && typeof agent.jobId === "string"
    && agent.jobId.trim().length > 0;
}

function formatAgentElapsed(agent: WorkflowAgentRecord, now: number): string {
  return formatDurationLabel((agent.timestamps.endedAt ?? now) - (agent.timestamps.startedAt ?? agent.timestamps.createdAt));
}

function formatElapsed(run: WorkflowSnapshot, now: number): string {
  return formatDurationLabel((run.timestamps.endedAt ?? now) - (run.timestamps.startedAt ?? run.timestamps.createdAt));
}
