import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  alignDashboardRow,
  createDashboardFrame,
  DASHBOARD_COMPACT_ROWS,
  dashboardLayout,
  dashboardOverlayRows,
  isFullscreenTui,
} from "../dashboard-style.ts";
import type { DashboardLayout } from "../dashboard-style.ts";
import { aggregateWorkflowUsage, workflowIsTerminal } from "../../src/workflows/manager.ts";
import { formatWorkflowBudget } from "../../src/workflows/budget.ts";
import type {
  WorkflowAgentRecord,
  WorkflowPhase,
  WorkflowSnapshot,
} from "../../src/workflows/types.ts";
import { formatContext, formatUsage, sanitizeInline, sanitizeText, shortId, traceStatusMeta } from "../subagents/render.ts";
import { workflowPhaseProgress, workflowStatusMeta } from "./render.ts";
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

export type WorkflowsDashboardAction =
  | { type: "cancel"; runId: string }
  | { type: "cancelAgent"; runId: string; agentIndex: number }
  | { type: "pause"; runId: string }
  | { type: "resume"; runId: string }
  | { type: "restartAgent"; runId: string; agentIndex: number }
  | { type: "close" };

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
  #resultRows = 0;
  #resultTotal = 0;
  #confirmCancel: CancelTarget | undefined;
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
    this.#runs = runs;
    this.syncTicker(runs);
    const chosen = this.resolveSelectedRun(runs);
    if (chosen) this.#runs = runs.map((candidate) => candidate.runId === chosen.runId ? chosen : candidate);
    this.syncSelections(chosen);

    if (width < 4) {
      this.resetCompactHierarchy();
      return [truncateWorkflowDashboardLine(`Workflows ${runs.length}`, width)];
    }

    const frame = createDashboardFrame(this.theme, width, this.#focused);
    if (rows < DASHBOARD_COMPACT_ROWS) {
      this.resetCompactHierarchy();
      return fit(this.renderCompact(rows, runs.length, frame), rows);
    }

    const layout = dashboardLayout(width, rows);
    this.#layout = layout;
    if (layout.kind === "wide") return fit(this.renderWide(frame, layout, runs, chosen), rows);
    if (layout.kind === "medium") return fit(this.renderMedium(frame, layout, runs, chosen), rows);
    return fit(this.renderNarrow(frame, layout, runs, chosen), rows);
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
    this.#runs = runs;
    const run = this.resolveSelectedRun(runs);
    if (run) this.#runs = runs.map((candidate) => candidate.runId === run.runId ? run : candidate);
    this.syncSelections(run);

    const compact = this.isCompactGeometry();
    const armed = compact ? undefined : this.#confirmCancel;
    this.#confirmCancel = undefined;
    this.#notice = "";
    const cancel = matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel");

    if (compact) {
      this.resetCompactHierarchy();
      if (cancel) this.finish({ type: "close" });
      else this.tui.requestRender();
      return;
    }

    // A clipped one-line summary has no interactive pane. Keep the global
    // close binding available, but do not route pane actions through hidden
    // layout state while the panel is below its interactive width.
    if (!this.#layout) {
      this.resetCompactHierarchy();
      if (cancel) this.finish({ type: "close" });
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
        this.finish({ type: "close" });
        return;
      }
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
    else if (!agentPane && (matchesKey(data, Key.up) || matchesKey(data, "k"))) this.selectRun(-1, runs);
    else if (!agentPane && (matchesKey(data, Key.down) || matchesKey(data, "j"))) this.selectRun(1, runs);
    else if (overviewControls && (matchesKey(data, Key.left) || matchesKey(data, "h"))) this.selectPhase(-1, run);
    else if (overviewControls && (matchesKey(data, Key.right) || matchesKey(data, "l"))) this.selectPhase(1, run);
    else if (overviewControls && data === "\t") this.selectAgent(run);
    else if (overviewControls && matchesKey(data, "f")) this.cycleAgentFilter(run);
    else if (!agentPane && (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))) this.openSelectedPane(run);
    else if (overviewControls && matchesKey(data, "p")) this.pauseOrResume(run);
    else if (matchesKey(data, "r")) this.restartAgent(run);
    else if (matchesKey(data, "x")) this.requestAgentCancel(run);
    else if (data === "X" || matchesKey(data, Key.shift("x"))) this.requestRunCancel(run);

    this.tui.requestRender();
  }

  private finish(action: WorkflowsDashboardAction): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
    this.done(action);
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
    this.#notice = "";
    this.resetScroll();
  }

  /* ── selection and actions ───────────────────────────────────────────── */

  private resolveSelectedRun(runs: WorkflowSnapshot[]): WorkflowSnapshot | undefined {
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

  private selectRun(delta: number, runs: WorkflowSnapshot[]): void {
    if (!runs.length) return;
    const index = runs.findIndex((run) => run.runId === this.#selectedRunId);
    const next = runs[clamp(index + delta, 0, runs.length - 1)];
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
    const next = run.phases[clamp(index + delta, 0, run.phases.length - 1)];
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

  private pauseOrResume(run: WorkflowSnapshot | undefined): void {
    if (!run || workflowIsTerminal(run.status) || this.#pane === "agent" || (this.#layout?.kind === "narrow" && this.#pane === "list")) return;
    this.finish({ type: run.status === "paused" ? "resume" : "pause", runId: run.runId });
  }

  private restartAgent(run: WorkflowSnapshot | undefined): void {
    if (!this.agentActionsVisible(run)) return;
    const agent = this.selectedAgent(run);
    if (!run || agent?.callIndex === undefined) return;
    this.finish({ type: "restartAgent", runId: run.runId, agentIndex: agent.index });
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
      this.finish({ type: "cancel", runId: target.runId });
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
    this.finish({ type: "cancelAgent", runId: target.runId, agentIndex: target.agentIndex });
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
    this.#scroll = clamp(offset, 0, max);
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

  private renderScrollableBody(body: string[], rows: number, key: string): string[] {
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
    this.#scroll = this.#followTail ? max : clamp(this.#scroll, 0, max);
    const start = this.#scroll;
    const end = Math.min(body.length, start + viewportRows);
    const range = viewportRows ? `${start + 1}–${end}` : "0";
    const label = this.theme.fg("dim", `Detail ${range}/${body.length} · Shift+↑↓/PgUp/PgDn · Ctrl+U/D · g/G`);
    return [label, ...body.slice(start, end)];
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */

  private renderWide(
    frame: DashboardFrame,
    layout: DashboardLayout,
    runs: WorkflowSnapshot[],
    chosen: WorkflowSnapshot | undefined,
  ): string[] {
    const { left, right } = frame.columns(layout.railWidth);
    const view = listViewport(runs, this.selectedRunPosition(runs), layout.contentRows);
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
    chosen: WorkflowSnapshot | undefined,
  ): string[] {
    const view = listViewport(runs, this.selectedRunPosition(runs), layout.listRows);
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
    chosen: WorkflowSnapshot | undefined,
  ): string[] {
    const view = listViewport(runs, this.selectedRunPosition(runs), layout.contentRows);
    const detail = this.#pane !== "list" && chosen;
    const lines = [
      this.renderHeader(frame, runs),
      frame.top(detail ? this.detailTitle(chosen) : this.listTitle(runs, view)),
    ];
    const body = detail
      ? this.renderInspector(chosen, layout.contentRows, Math.max(1, frame.innerWidth - 1)).map((row) => ` ${row}`)
      : this.renderRunList(runs, view, chosen, layout.contentRows, frame.innerWidth);
    for (const row of fit(body, layout.contentRows)) lines.push(frame.row(row));
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

  private renderHeader(frame: DashboardFrame, runs: WorkflowSnapshot[]): string {
    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    return frame.header(
      this.theme.fg("accent", this.theme.bold("Workflow runs")),
      this.theme.fg("muted", `${runs.length} run${runs.length === 1 ? "" : "s"}${active ? ` · ${active} active` : ""}`),
    );
  }

  private listTitle(runs: WorkflowSnapshot[], view: ListViewport<WorkflowSnapshot>): string {
    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    const clipped = `${view.start > 0 ? "↑" : ""}${view.end < runs.length ? "↓" : ""}`;
    return `runs · ${active} active / ${runs.length}${clipped ? ` ${clipped}` : ""}`;
  }

  private detailTitle(run: WorkflowSnapshot | undefined): string {
    if (!run) return "inspector";
    if (this.#pane === "agent") {
      const agent = this.selectedAgent(run);
      return agent ? `agent · ${sanitizeInline(agent.name)} · ${agent.state}` : "agent";
    }
    const phase = this.phaseFor(run);
    const progress = phase ? workflowPhaseProgress(run, phase.index) : undefined;
    return phase ? `workflow · phase ${progress?.label ?? "waiting"} · filter ${this.#agentFilter}` : "workflow";
  }

  private renderRunRail(runs: WorkflowSnapshot[], view: ListViewport<WorkflowSnapshot>, chosen: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!runs.length) return fit([this.theme.fg("muted", "No workflow runs in this session.")], rows);
    return fit(view.items.map((run) => this.renderRun(run, run.runId === chosen?.runId, width)), rows);
  }

  private renderRunList(runs: WorkflowSnapshot[], view: ListViewport<WorkflowSnapshot>, chosen: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!runs.length) return fit([this.theme.fg("muted", "  No workflow runs in this session.")], rows);
    return fit(view.items.map((run) => this.renderRun(run, run.runId === chosen?.runId, width)), rows);
  }

  private renderRun(run: WorkflowSnapshot, selected: boolean, width: number): string {
    const status = workflowStatusMeta(run);
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const name = selected ? this.theme.fg("accent", sanitizeInline(run.name)) : this.theme.fg("text", sanitizeInline(run.name));
    const left = ` ${marker} ${this.theme.fg(status.color, status.glyph)} ${name} ${this.theme.fg("dim", shortId(sanitizeText(run.runId)))}`;
    const phase = workflowPhaseProgress(run).label;
    const outcome = run.status === "completed" && run.taskOutcome ? ` · ${run.taskOutcome}` : "";
    const right = `${this.theme.fg("muted", `phase ${phase} · ${formatElapsed(run, this.#now())}`)} · ${this.theme.fg(status.color, `${run.status}${outcome}`)} `;
    return alignDashboardRow(left, right, width);
  }

  private renderInspector(run: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!run) {
      this.#resultRows = 0;
      this.#resultTotal = 0;
      return fit([this.theme.fg("dim", "Select a workflow to inspect phases, agents, and results.")], rows);
    }
    return this.#pane === "agent" ? this.agentInspectorViewport(run, rows, width) : this.workflowOverviewViewport(run, rows, width);
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
      this.theme.fg("dim", boundedInline(run.description, 2_000) || "(no workflow description)"),
      phase
        ? this.renderPhase(run, phase)
        : this.theme.fg("dim", progress.waiting ? "Phase · waiting for the first phase" : "Phase · no phases recorded"),
    ];
    if (phase?.description) lines.push(this.theme.fg("muted", `Phase context · ${boundedInline(phase.description, 2_000)}`));
    if (usage) lines.push(this.theme.fg("dim", `Usage · ${usage}`));
    if (budget) lines.push(this.theme.fg("dim", `Budget · ${budget}`));
    if (run.approval) lines.push(this.theme.fg("muted", `Approval · ${run.approval}`));
    if (run.definitionFingerprint) lines.push(this.theme.fg("muted", `Provenance · definition ${shortId(run.definitionFingerprint)}`));
    for (const warning of run.warnings?.slice(0, 2) ?? []) lines.push(this.theme.fg("warning", `⚠ ${boundedInline(warning, 1_000)}`));
    if (run.error) lines.push(this.theme.fg("error", `× ${boundedInline(run.error, MAX_ERROR_CHARS)}`));
    const activity = (run.logs ?? []).slice(-3);
    if (activity.length) {
      lines.push(this.theme.fg("muted", `Activity · ${activity.length} recent log${activity.length === 1 ? "" : "s"}`));
      for (const log of activity) lines.push(this.theme.fg("dim", `· ${boundedInline(log.message, MAX_ACTIVITY_CHARS)}`));
    }
    lines.push(this.theme.fg("muted", `Agents · ${agents.length}/${allAgents.length} shown · filter ${this.#agentFilter} · Tab select · Enter inspect`));

    if (!agents.length) {
      const noAgents = this.theme.fg("dim", allAgents.length ? "No agents match this filter." : "No agents in this phase yet.");
      if (allAgents.length || (run.result === undefined && phase?.result === undefined && !run.logs?.length)) {
        lines.push(noAgents);
        return fit(lines, rows);
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
      );
      return fit([...metadata.slice(0, pinnedRows), ...viewport], rows);
    }

    const room = Math.max(1, rows - lines.length);
    const selectedPosition = agents.findIndex((agent) => agent.index === this.#selectedAgentIndex);
    const view = listViewport(agents, selectedPosition < 0 ? 0 : selectedPosition, room);
    for (const agent of view.items) lines.push(this.renderAgentRow(agent, agent.index === this.#selectedAgentIndex));
    const rendered = fit(lines, rows);
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
    const metadata: string[] = [
      `${this.theme.fg("accent", this.theme.bold(boundedInline(agent.name, 1_000)))} ${this.theme.fg(status.color, `· ${status.glyph} ${agent.state}`)} ${this.theme.fg("dim", `· ${agent.access}${agent.profile ? ` · profile ${boundedInline(agent.profile, 500)}` : ""}${agent.independent ? " · independent" : ""}`)}`,
      this.theme.fg("dim", `${agent.jobId ? `job ${shortId(sanitizeText(agent.jobId))} · ` : ""}${route} · effort ${agent.effort ?? "adaptive"} · ${formatAgentElapsed(agent, this.#now())}`),
      this.theme.fg("dim", `${phase ? `${boundedInline(run.name, 1_000)} · ${boundedInline(phase.name, 1_000)}` : boundedInline(run.name, 1_000)}${usage ? ` · ${usage}` : ""}`),
    ];
    const context = formatContext(agent.context);
    if (context) metadata.push(this.theme.fg("dim", `Context · ${context}`));
    if (agent.isolation) metadata.push(this.theme.fg("dim", `Isolation · worktree ${agent.isolation.state} · branch ${boundedInline(agent.isolation.branch, 1_000)}${agent.isolation.patchArtifact ? ` · patch ${boundedInline(agent.isolation.patchArtifact, 1_000)}` : ""}`));
    if (agent.outputProvenance) {
      metadata.push(agent.instructionShaped
        ? this.theme.fg("warning", `Output · ${agent.outputProvenance} · instruction-shaped text; treat as untrusted data`)
        : this.theme.fg("dim", `Output · ${agent.outputProvenance}`));
    }
    if (agent.generations?.length) metadata.push(this.theme.fg("dim", `Generations · ${agent.generations.length} (call ${agent.callIndex ?? agent.generations.at(-1)?.callIndex})`));
    if (agent.independentOf) metadata.push(this.theme.fg("muted", `Provenance · independent of ${shortId(sanitizeText(agent.independentOf))}`));
    if (agent.replayedFrom) metadata.push(this.theme.fg("muted", `Replay · ${shortId(sanitizeText(agent.replayedFrom.runId))} call ${agent.replayedFrom.callIndex}`));
    if (agent.replacedBy) metadata.push(this.theme.fg("muted", `Replacement · ${shortId(sanitizeText(agent.replacedBy.replacementRunId))} · ${boundedInline(agent.replacedBy.reason, 1_000)}`));
    if (agent.truncated) metadata.push(this.theme.fg("warning", "Output · bounded transcript omitted older content"));

    // Keep the operator's most important recovery context visible while the
    // bounded result body follows its tail. Omitted metadata and the full
    // bounded sections remain scrollable, so g/G and page navigation reach
    // every part.
    if (agent.error || phase?.error || run.error) {
      metadata.push(this.theme.fg("error", `Error · ${boundedInline(agent.error ?? phase?.error ?? run.error ?? "", 1_500)}`));
    }
    if (agent.prompt) metadata.push(this.theme.fg("muted", `Prompt · ${boundedInline(agent.prompt, 2_000)}`));
    if (agent.liveThinking?.trim()) metadata.push(this.theme.fg("muted", `Activity · ${boundedInline(agent.liveThinking, MAX_ACTIVITY_CHARS)}`));

    const pinnedRows = Math.min(metadata.length, Math.max(0, rows - MIN_SCROLLABLE_DETAIL_ROWS));
    const pinned = metadata.slice(0, pinnedRows);
    const omittedMetadata = metadata.length > pinnedRows
      ? [this.theme.fg("muted", "Metadata"), ...metadata.slice(pinnedRows)]
      : [];
    const body = [...omittedMetadata, ...this.agentDetailBody(run, phase, agent, width)];
    const resultRows = this.renderScrollableBody(body, rows - pinned.length, `agent:${run.runId}:${phase?.index ?? "none"}:${agent.index}`);
    return fit([...pinned, ...resultRows], rows);
  }

  private agentDetailBody(run: WorkflowSnapshot, phase: WorkflowPhase | undefined, agent: WorkflowAgentRecord, width: number): string[] {
    const signature = detailSignature(run, phase, agent);
    const key = `agent:${run.runId}:${phase?.index ?? "none"}:${agent.index}:${width}:${signature}`;
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
      appendBoundedSection(body, this.theme, "Structured result", structured, 72);
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
    const status = traceStatusMeta(agent.state, this.#now());
    const marker = selected ? this.theme.fg("accent", "›") : " ";
    const label = selected ? this.theme.fg("accent", boundedInline(agent.name, 1_000)) : this.theme.fg("text", boundedInline(agent.name, 1_000));
    const route = agent.harness || agent.model ? `${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}` : "route pending";
    const usage = formatUsage(agent.usage);
    const warning = agent.instructionShaped ? " · ⚠ instruction-like output" : "";
    return `${marker} ${this.theme.fg(status.color, status.glyph)} ${label} ${this.theme.fg("dim", `· ${agent.access}${agent.profile ? ` · profile ${boundedInline(agent.profile, 500)}` : ""}${agent.independent ? " · independent" : ""} · ${route} · effort ${agent.effort ?? "adaptive"} · ${formatAgentElapsed(agent, this.#now())}${usage ? ` · ${usage}` : ""}${warning}`)}`;
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
    const key = `result:${run.runId}:${phase?.index ?? "none"}:${agent?.index ?? "workflow"}:${safeWidth}:${signature}`;
    const cached = this.#detailCache.get(key);
    if (cached) return cached;

    const transcript = agent?.transcript?.length ? agent.transcript : undefined;
    let rows: string[] = [];
    let truncated = false;
    if (transcript) {
      for (const { entry, text } of boundedTranscriptParts(transcript, MAX_RESULT_CHARS)) {
        if (!entry) {
          rows.push(this.theme.fg("muted", text));
          continue;
        }
        if (!text.trim()) continue;
        if (entry.kind === "assistant") rows.push(...this.renderMarkdownLines(text, safeWidth));
        else if (entry.kind === "user") rows.push(...renderPrefixedRows(this.theme, this.theme.fg("accent", "> "), text, "userMessageText", safeWidth));
        else if (entry.kind === "thinking") rows.push(...renderPrefixedRows(this.theme, this.theme.fg("dim", "~ "), text, "muted", safeWidth));
        else {
          const prefix = entry.error ? this.theme.fg("error", "× ") : this.theme.fg("muted", "→ ");
          rows.push(...renderPrefixedRows(this.theme, prefix, text, entry.error ? "error" : "muted", safeWidth));
        }
      }
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
      for (const [text, hintRight] of candidates) {
        const rendered = frame.hint(text, hintRight);
        if (rendered.includes(marker)) {
          this.#renderedConfirmationTarget = cancelTargetKey(target);
          return rendered;
        }
      }
      return frame.hint("Cancellation pending", `· Esc ${this.backHint()}`);
    }
    if (this.#notice) return frame.hint(`! ${boundedInline(this.#notice, 2_000)}`, `· Esc ${this.backHint()}`);

    const agent = this.selectedAgent(run);
    const live = !!run && !workflowIsTerminal(run.status);
    const agentVisible = this.agentActionsVisible(run);
    const agentActionable = this.agentCancelActionable(run);
    const shortActions = frame.innerWidth < 60;
    const agentCancelLabel = shortActions ? "x cancel" : "x cancel agent";
    const runCancelLabel = shortActions ? "X cancel" : "X cancel run";
    if (this.#layout?.kind === "narrow" && this.#pane === "list") {
      const navigation = shortActions ? "↑↓/jk" : "↑↓/jk select";
      const actions = [live ? runCancelLabel : "", navigation, "Enter open"].filter(Boolean).join(" · ");
      const rendered = frame.hint(actions, `· Esc ${this.backHint()}`);
      if (live && rendered.includes(runCancelLabel)) this.#renderedRunCancelId = run?.runId;
      return rendered;
    }
    const actions = this.#pane === "agent"
      ? [
        agentActionable ? agentCancelLabel : "",
        live ? runCancelLabel : "",
        agentVisible && agent?.callIndex !== undefined ? "r restart agent" : "",
        "h/← overview",
        "Shift+↑↓/Pg scroll · Ctrl+U/D · g/G",
      ]
      : [
        agentActionable ? agentCancelLabel : "",
        live ? runCancelLabel : "",
        live ? `p ${run?.status === "paused" ? "resume" : "pause"}` : "",
        agentVisible && agent?.callIndex !== undefined ? "r restart agent" : "",
        this.#layout?.kind === "narrow" && this.#pane === "list" ? "↑↓/jk select · Enter open" : "↑↓/jk run · ←→/hl phase · Tab agent · Enter inspect · f filter",
        "Shift+↑↓/Pg scroll · Ctrl+U/D · g/G",
      ];
    const rendered = frame.hint(actions.filter(Boolean).join(" · "), `· Esc ${this.backHint()}`);
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

  private selectedRunPosition(runs: WorkflowSnapshot[]): number {
    const index = runs.findIndex((run) => run.runId === this.#selectedRunId);
    return index < 0 ? 0 : index;
  }
}

type DashboardFrame = ReturnType<typeof createDashboardFrame>;

function cancelTargetKey(target: CancelTarget): string {
  return target.type === "run"
    ? `run:${target.runId}`
    : `agent:${target.runId}:${target.agentIndex}`;
}

interface ListViewport<T> {
  items: readonly T[];
  start: number;
  end: number;
}

function listViewport<T>(items: readonly T[], selected: number, rows: number): ListViewport<T> {
  const size = Math.max(0, Math.min(rows, items.length));
  const start = clamp(selected - Math.floor(size / 2), 0, Math.max(0, items.length - size));
  return { items: items.slice(start, start + size), start, end: start + size };
}

function defaultWorkflow(runs: WorkflowSnapshot[]): WorkflowSnapshot {
  return runs.find((run) => run.status === "running" || run.status === "paused")
    ?? runs.find((run) => run.status === "pending")
    ?? runs.reduce((latest, run) => run.timestamps.createdAt >= latest.timestamps.createdAt ? run : latest);
}

function fit(lines: string[], rows: number): string[] {
  const bounded = lines.slice(0, Math.max(0, rows));
  while (bounded.length < rows) bounded.push("");
  return bounded;
}

export async function openWorkflowsDashboard(ctx: ExtensionCommandContext, manager: WorkflowsDashboardManager): Promise<void> {
  if (ctx.mode !== "tui") {
    const runs = manager.list();
    const message = runs.length
      ? runs.map((run) => `${sanitizeInline(run.runId)} ${run.status} ${sanitizeInline(run.name)}`).join("\n")
      : "No workflow runs in this session.";
    ctx.ui.notify(message, "info");
    return;
  }

  let focusRunId: string | undefined;
  for (;;) {
    const action = await ctx.ui.custom<WorkflowsDashboardAction>(
      (tui, theme, keybindings, done) => createWorkflowsDashboardOverlay(tui, theme, keybindings, manager, (next) => {
        if (next.type !== "close") focusRunId = next.runId;
        done(next);
      }, { focusRunId }),
      { overlay: true, overlayOptions: { width: "100%", minWidth: 40, maxHeight: "100%", anchor: "center" } },
    );
    if (!action || action.type === "close") return;
    try {
      if (action.type === "cancelAgent") await manager.cancelAgent(action.runId, action.agentIndex, "Workflow agent cancelled from /workflows dashboard");
      else if (action.type === "pause") await manager.pause(action.runId);
      else if (action.type === "resume") await manager.resume(action.runId);
      else if (action.type === "restartAgent") {
        const restarted = await manager.restartAgent(action.runId, action.agentIndex);
        focusRunId = restarted.snapshot.runId;
        ctx.ui.notify(`Restarted as ${restarted.snapshot.runId}`, "info");
      } else await manager.cancel(action.runId, "Cancelled from /workflows dashboard");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

function matchesAgentFilter(agent: WorkflowAgentRecord, filter: AgentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return agent.state === "queued" || agent.state === "running";
  if (filter === "failed") return agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted";
  return agent.state === "completed";
}

function isCancellableAgent(agent: WorkflowAgentRecord | undefined): agent is WorkflowAgentRecord {
  return !!agent
    && (agent.state === "queued" || agent.state === "running")
    && typeof agent.jobId === "string"
    && agent.jobId.trim().length > 0;
}

function formatAgentElapsed(agent: WorkflowAgentRecord, now: number): string {
  const elapsed = Math.max(0, (agent.timestamps.endedAt ?? now) - (agent.timestamps.startedAt ?? agent.timestamps.createdAt));
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatElapsed(run: WorkflowSnapshot, now: number): string {
  const elapsed = Math.max(0, (run.timestamps.endedAt ?? now) - (run.timestamps.startedAt ?? run.timestamps.createdAt));
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
