import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
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
  dashboardInfoRule,
  dashboardScrollRule,
  dashboardSectionRow,
  dashboardSelectionMarker,
  dashboardSubmitKeyLabel,
  dashboardSummaryColor,
  dashboardViewportLabel,
  fitDashboardRows,
  formatDurationLabel,
  isFullscreenTui,
  dashboardOverlayRows,
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
export {
  DASHBOARD_CHROME_ROWS,
  DASHBOARD_COMPACT_ROWS,
  DASHBOARD_MEDIUM_MIN_WIDTH,
  DASHBOARD_SPLIT_MIN_ROWS,
  DASHBOARD_WIDE_MIN_WIDTH,
  dashboardLayout,
  isFullscreenTui,
} from "../dashboard-style.ts";
import { isTerminal } from "../../src/manager.ts";
import { formatSpendBudget } from "../../src/budget.ts";
import {
  formatContext,
  formatEffort,
  formatElapsed,
  formatUsage,
  interactionWaitLabel,
  jobDashboardSummary,
  pendingInteraction,
  sanitizeInline,
  sanitizeText,
  shortId,
  statusMeta,
} from "./render.ts";
import {
  buildTranscript,
  renderAssistantMarkdown,
  takeoverPolicy,
  transcriptSignature,
} from "./transcript.ts";
import { DEFAULT_TOOL_DISPLAY, type ToolDisplayMode } from "../tool-summary.ts";
import type { JobSnapshot, SendBehavior } from "../../src/types.ts";
import {
  availabilityLabel,
  formatHarnessAvailabilityReport,
  type HarnessActivation,
} from "../../src/harness-availability.ts";

/*
 * `/subagents` is one panel with three explicit focus layers. Job-list focus moves
 * among jobs, job-detail focus reads and scrolls the normalized transcript, and
 * composer focus answers, steers, or queues a follow-up. The panel
 * takes the whole screen when Pi runs its fullscreen TUI and keeps Pi's 80%
 * overlay otherwise, so overlay geometry stays percentage-based and survives
 * resize. Layout adapts to the terminal it is given — see `dashboardLayout`.
 */

/** The manager surface the panel needs. `JobManager` satisfies it structurally. */
export interface SubagentsDashboardManager {
  list(): JobSnapshot[];
  subscribe(listener: (job: JobSnapshot) => void): () => void;
  send(id: string, message: string, behavior?: SendBehavior): Promise<JobSnapshot>;
  cancel(id: string, reason?: string): Promise<JobSnapshot>;
  /** Resolves one pending routed question. Deliberately not `send`: it settles a provider tool call, not a user turn. */
  answerInteraction?(requestId: string, answer: string, route?: "orchestrator-model" | "human"): unknown;
  /** Global concurrent-job budget, when the manager reports one. */
  readonly concurrency?: number;
}

/** State story for the selected direct job. Routine route and usage rows follow it. */
function directJobStatePreview(
  job: JobSnapshot,
  now: number,
  theme: Theme,
  width: number,
  canAnswerInline: boolean,
): string[] {
  const line = (color: Parameters<Theme["fg"]>[0], value: string) =>
    truncate(theme.fg(color, value), width);
  const interaction = pendingInteraction(job);

  if (interaction) {
    const elapsed = formatDurationLabel(now - interaction.createdAt);
    const target = interaction.target.kind === "agent"
      ? `peer ${sanitizeInline(interaction.target.label ?? shortId(interaction.target.jobId ?? "peer"))}`
      : interaction.humanVisible ? "you" : "parent orchestrator";
    const owner = interaction.workflow
      ? ` · workflow ${sanitizeInline(interaction.workflow.label)} ${shortId(sanitizeText(interaction.workflow.runId))}`
      : "";
    let next: string;
    if (interaction.workflow) {
      next = `Next · /workflows: supervise ${sanitizeInline(interaction.workflow.label)}; no answer or steer here`;
    } else if (interaction.target.kind === "agent") {
      next = `Next · no human action required; waiting for ${target}`;
    } else if (interaction.humanVisible) {
      next = canAnswerInline
        ? "Next · press a to answer inline"
        : "Next · inline answering is unavailable in this session";
    } else {
      next = "Next · parent thread: subagent_answer; do not steer";
      if (visibleWidth(next) > width) next = "Next · parent: subagent_answer; do not steer";
    }
    const rows = [
      line("warning", `Question · ${sanitizeInline(interaction.question)}`),
      line("muted", `Route · ${sanitizeInline(interaction.sourceName)} → ${target} · waiting ${elapsed}${owner}`),
    ];
    rows.push(line("text", next));
    if (interaction.context) rows.push(line("dim", `Context · ${sanitizeInline(interaction.context)}`));
    return rows;
  }

  const summary = jobDashboardSummary(job);
  const workflowDestination = job.workflow
    ? `supervise ${sanitizeInline(job.workflow.label)} in /workflows`
    : undefined;
  if (summary.kind === "failure") {
    const recovery = workflowDestination
      ?? (!takeoverPolicy(job).reusable
        ? "no recovery action is available in this pane"
        : isTerminal(job.status) ? "press f to follow up" : "press s to steer");
    return [
      line("error", `Error · ${summary.text}`),
      line("text", `Recovery · ${recovery}`),
    ];
  }
  if (job.status === "queued") {
    return [
      line("warning", `Waiting · ${summary.text}`),
      line("muted", `Next · ${workflowDestination ?? "automatic dispatch; no human action required"}`),
    ];
  }
  if (job.status === "running") {
    if (!workflowDestination && width >= 40) {
      const prefix = "Latest · ";
      const suffix = " · Next · s steer";
      const previewWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
      const preview = truncateToWidth(summary.text, previewWidth, "…");
      return [line("accent", `${prefix}${preview}${suffix}`)];
    }
    return [
      line("accent", `Latest · ${summary.text}`),
      line("muted", `Next · ${workflowDestination ?? "monitor here or press s to steer"}`),
    ];
  }
  if (job.status === "completed") {
    return [
      line("success", `Result · ${summary.text}`),
      line("muted", `Next · ${workflowDestination ?? "press f to follow up if more work is needed"}`),
    ];
  }

  const recovery = workflowDestination
    ?? (takeoverPolicy(job).reusable ? "continue in this inspector" : "no recovery action is available in this pane");
  return [
    line("muted", `State · ${summary.text}`),
    line("muted", `Next · ${recovery}`),
  ];
}

export interface DashboardOverlayOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  renderMarkdown?: (text: string, width: number) => string[];
  /** Job selected when the panel opens; falls back to the most useful active or recent job. */
  focusJobId?: string;
  /** Compatibility entry point used by {@link openSubagentTakeover}. */
  mode?: DashboardMode;
  /** Forces the fullscreen height policy; defaults to Pi's renderer mode. */
  fullscreen?: boolean;
  /** Latest bounded startup/status discovery snapshot. */
  availability?: HarnessActivation[];
}

export type DashboardMode = "browse" | "takeover" | "answer";
type DraftOwner = { jobId: string; composer: "answer" | "steer" | "follow-up"; requestId?: string };
type TakeoverComposer = Exclude<DraftOwner["composer"], "answer">;
export type SubagentsDashboardFocus =
  | { kind: "job-list" }
  | { kind: "job-detail" }
  | { kind: "composer"; composer: "answer" | "steer" | "follow-up" };
export type { DashboardLayout, DashboardLayoutKind } from "../dashboard-style.ts";

type JobDashboardGroup = "input" | "working" | "waiting" | "failed" | "finished";

function takeoverComposer(behavior: SendBehavior): TakeoverComposer {
  return behavior === "followUp" ? "follow-up" : "steer";
}

const JOB_DASHBOARD_GROUPS = [
  { key: "input", label: "Needs input" },
  { key: "working", label: "Working" },
  { key: "waiting", label: "Queued or waiting" },
  { key: "failed", label: "Failed" },
  { key: "finished", label: "Finished", foldLabel: "finished" },
] as const satisfies readonly DashboardCollectionGroupDefinition<JobDashboardGroup>[];

export function createDashboardOverlay(
  tui: Pick<TUI, "requestRender" | "terminal">,
  theme: Theme,
  keybindings: KeybindingsManager,
  manager: SubagentsDashboardManager,
  done: (value: null) => void,
  options: DashboardOverlayOptions = {},
): DashboardOverlay {
  return new DashboardOverlay(tui, theme, keybindings, manager, done, options);
}

class DashboardOverlay implements Focusable {
  #focused = false;
  #finished = false;
  #focus: SubagentsDashboardFocus;
  /** Selection is held by job id so list growth, eviction, and reordering cannot move it. */
  #selectedId: string | undefined;
  /** Scroll offset in lines from the top of the selected job's transcript. */
  #scroll = 0;
  #scrollJobId: string | undefined;
  /** Live jobs are most useful pinned to their latest output; any upward scroll unpins. */
  #followTail = true;
  /** One display preference per overlay instance; survives job/pane changes, not resets. */
  #toolDisplay: ToolDisplayMode = DEFAULT_TOOL_DISPLAY;
  #transcriptRows = 0;
  #transcriptTotal = 0;
  /** Job id armed for cancellation; a second `x` confirms, any other key disarms. */
  #confirmCancelId: string | undefined;
  /** `?` cheatsheet toggle; browse-only, never intercepts takeover composer input. */
  #showHelp = false;
  /** Routine telemetry is opt-in; state and recovery remain visible without it. */
  #showInfo = false;
  #notice = "";
  #behavior: SendBehavior | undefined;
  /** Identity that owns the preserved draft; a draft never crosses jobs or composer kinds. */
  #draftOwner: DraftOwner | undefined;
  #pendingSend: { jobId: string; draft: string; inputRevision: number } | undefined;
  /** Exact job/request identity the answer composer may resolve. */
  #answerIdentity: { jobId: string; requestId: string } | undefined;
  #inputRevision = 0;
  #input = new Input();
  #jobs: JobSnapshot[] | undefined;
  #layout: DashboardLayout | undefined;
  /** The destructive controls that were present in the last rendered hint. */
  #renderedCancelId: string | undefined;
  #renderedConfirmationId: string | undefined;
  #transcriptCache: { key: string; lines: string[] } | undefined;
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
  readonly #availability: HarnessActivation[] | undefined;
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly manager: SubagentsDashboardManager;
  private readonly done: (value: null) => void;

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    keybindings: KeybindingsManager,
    manager: SubagentsDashboardManager,
    done: (value: null) => void,
    options: DashboardOverlayOptions,
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
    this.#renderMarkdown = options.renderMarkdown ?? renderMarkdown;
    this.#forceFullscreen = options.fullscreen;
    this.#availability = options.availability;
    this.#selectedId = options.focusJobId;
    this.#focus = options.mode === "takeover"
      ? { kind: "composer", composer: "steer" }
      : options.mode === "answer"
        ? { kind: "composer", composer: "answer" }
        : { kind: "job-list" };
    this.#unsubscribe = manager.subscribe(() => {
      // Manager snapshots are immutable projections, but bounded fields can
      // change without changing their length. Drop the rendered transcript
      // cache on every lifecycle/output event before coalescing the repaint.
      this.invalidate();
      this.invalidateSoon();
    });
    this.#input.onSubmit = (raw) => this.submit(raw);
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value && this.composing();
  }

  render(width: number): string[] {
    width = Math.max(0, width);
    this.#layout = undefined;
    this.#renderedCancelId = undefined;
    this.#renderedConfirmationId = undefined;
    const jobs = this.manager.list();
    this.#jobs = jobs;
    const collection = jobDashboardCollection(jobs);
    const chosen = this.syncSelection(collection.items);
    if (chosen && this.#focus.kind === "composer" && this.#focus.composer !== "answer" && !this.#draftOwner) {
      const policy = takeoverPolicy(chosen);
      const composer = takeoverComposer(policy.behavior);
      this.#focus = { kind: "composer", composer };
      this.#behavior = policy.behavior;
      this.bindDraft({ jobId: chosen.id, composer });
    }
    this.syncTicker(jobs);

    const rows = dashboardOverlayRows(this.tui.terminal?.rows ?? 0, this.fullscreen());
    if (!rows) {
      this.resetCompactHierarchy();
      return [];
    }
    if (width < 4) {
      this.resetCompactHierarchy();
      return [truncate(`Subagents ${jobs.length}`, width)];
    }

    const frame = createDashboardFrame(this.theme, width, this.#focused);
    if (rows < DASHBOARD_COMPACT_ROWS) {
      this.resetCompactHierarchy();
      return this.renderCompact(rows, jobs, frame, width);
    }

    const layout = dashboardLayout(width, rows);
    this.#layout = layout;
    if (this.#showHelp) return this.renderHelp(frame, layout, jobs);
    if (layout.kind === "wide") return this.renderWide(frame, layout, jobs, collection, chosen);
    if (layout.kind === "medium") return this.renderMedium(frame, layout, jobs, collection, chosen);
    return this.renderNarrow(frame, layout, jobs, collection, chosen);
  }

  invalidate(): void {
    this.#transcriptCache = undefined;
    this.#input.invalidate();
  }

  dispose(): void {
    this.#finished = true;
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    const jobs = this.manager.list();
    this.#jobs = jobs;
    const orderedJobs = jobDashboardCollection(jobs).items;
    this.syncSelection(orderedJobs);
    // Both the cancel arm and the notice are answers to the previous keystroke.
    const compact = this.isCompactGeometry();
    const armed = compact ? undefined : this.#confirmCancelId;
    this.#confirmCancelId = undefined;
    this.#notice = "";
    const job = this.currentJob(orderedJobs);
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
      if (
        data === "x" &&
        armed === job?.id &&
        this.#renderedConfirmationId === armed &&
        this.cancelableJob(job)
      ) {
        this.requestCancel(job, armed);
        this.tui.requestRender();
        return;
      }
      this.#notice = "Cancellation dismissed.";
      this.tui.requestRender();
      return;
    }

    const composing = this.composing();

    // The cheatsheet is a browse-only modal: `?` never reaches the takeover
    // composer, and while shown, `?` or cancel dismiss it without touching
    // pane, scroll, selection, or tool-display state.
    if (this.#showHelp) {
      if (cancel || data === "?") this.#showHelp = false;
      this.tui.requestRender();
      return;
    }

    if (cancel) {
      if (this.composing()) this.leaveComposer();
      else if (this.#focus.kind === "job-detail") {
        this.#focus = { kind: "job-list" };
      }
      else return this.finish();
      this.tui.requestRender();
      return;
    }

    if (!composing && data === "?") {
      this.#showHelp = true;
      this.tui.requestRender();
      return;
    }

    if (!composing && data === "i") {
      this.#showInfo = !this.#showInfo;
      this.tui.requestRender();
      return;
    }

    const confirm = this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter);
    const forward = confirm || matchesKey(data, Key.right) || matchesKey(data, "l");
    const back = matchesKey(data, Key.left) || matchesKey(data, "h");
    if (composing) {
      // Route the host's configured input-submit binding explicitly; the
      // bundled Input component otherwise consults its own TUI keybinding
      // singleton. Printable navigation keys, including `?`, must remain
      // ordinary composer text here.
      if (matchesKey(data, Key.shift(Key.up))) this.scroll(-1);
      else if (matchesKey(data, Key.shift(Key.down))) this.scroll(1);
      else if (matchesKey(data, Key.ctrl("t"))) this.toggleToolDisplay();
      else if (this.keybindings.matches(data, "tui.input.submit") || matchesKey(data, Key.enter)) this.submit(this.#input.getValue());
      else {
        this.#inputRevision++;
        this.#input.handleInput(data);
      }
    }
    else if (this.#focus.kind === "job-list") {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selectJob(-1, orderedJobs);
      else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selectJob(1, orderedJobs);
      else if (forward) {
        if (job) {
          this.#focus = { kind: "job-detail" };
        }
      }
      else if (matchesKey(data, "s") && this.steerControlVisible(job)) this.enterComposer(job, "steer");
      else if (matchesKey(data, "f") && this.followUpControlVisible(job)) this.enterComposer(job, "followUp");
      else if (matchesKey(data, "a") && job && pendingInteraction(job)) this.enterAnswer(job);
      else if (matchesKey(data, "x") && this.cancelControlVisible(job)) this.requestCancel(job, undefined);
      else if (matchesKey(data, "t") || matchesKey(data, Key.ctrl("t"))) this.toggleToolDisplay();
    }
    else if (matchesKey(data, Key.up) || matchesKey(data, "k") || matchesKey(data, Key.shift(Key.up))) this.scroll(-1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j") || matchesKey(data, Key.shift(Key.down))) this.scroll(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll(-this.pageStep());
    else if (matchesKey(data, Key.pageDown)) this.scroll(this.pageStep());
    else if (matchesKey(data, Key.ctrl("u"))) this.scroll(-this.halfPageStep());
    else if (matchesKey(data, Key.ctrl("d"))) this.scroll(this.halfPageStep());
    else if (matchesKey(data, "g")) this.scrollTo(0);
    else if (matchesKey(data, Key.shift("g"))) this.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (back) {
      this.#focus = { kind: "job-list" };
    }
    else if (matchesKey(data, "s") && this.steerControlVisible(job)) this.enterComposer(job, "steer");
    else if (matchesKey(data, "f") && this.followUpControlVisible(job)) this.enterComposer(job, "followUp");
    // `a` reaches the composer only for a human-owned question; on a
    // model-owned one it explains who owes the answer instead of doing nothing.
    else if (matchesKey(data, "a") && !this.composing() && job && pendingInteraction(job)) this.enterAnswer(job);
    else if (matchesKey(data, "x") && this.cancelControlVisible(job)) this.requestCancel(job, undefined);
    else if (matchesKey(data, "t") || matchesKey(data, Key.ctrl("t"))) this.toggleToolDisplay();
    this.tui.requestRender();
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  private finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
    this.done(null);
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

  /** Coalesces a burst of manager events into a single render. */
  private invalidateSoon(): void {
    if (this.#finished || this.#coalesce !== undefined) return;
    const timer = this.#setTimeout(() => {
      this.#coalesce = undefined;
      if (!this.#finished) this.tui.requestRender();
    }, 50);
    timer.unref?.();
    this.#coalesce = timer;
  }

  /** Elapsed times only move while something is running, so the ticker only runs then. */
  private syncTicker(jobs: JobSnapshot[]): void {
    const active = jobs.some((job) => !isTerminal(job.status));
    if (active && this.#ticker === undefined && !this.#finished) {
      const timer = this.#setInterval(() => {
        if (!this.#finished) this.tui.requestRender();
      }, 1000);
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
    this.#focus = { kind: "job-list" };
    this.#behavior = undefined;
    this.#answerIdentity = undefined;
    this.#confirmCancelId = undefined;
    this.#renderedCancelId = undefined;
    this.#renderedConfirmationId = undefined;
    this.#showHelp = false;
    this.#notice = "";
    this.#inputRevision++;
    this.#input.setValue("");
    this.#input.focused = false;
    this.resetScroll();
  }

  /* ── selection and actions ─────────────────────────────────────────────── */

  private syncSelection(jobs: readonly JobSnapshot[]): JobSnapshot | undefined {
    if (!jobs.length) {
      this.#selectedId = undefined;
      if (this.composing()) this.leaveComposer();
      return undefined;
    }
    const chosen = jobs.find((job) => job.id === this.#selectedId) ?? defaultJob(jobs);
    if (chosen.id !== this.#selectedId) {
      // The previous selection was evicted (or this is the first render): start clean.
      this.#selectedId = chosen.id;
      if (this.composing()) this.leaveComposer();
      this.resetScroll();
    }
    return chosen;
  }

  private currentJob(jobs: readonly JobSnapshot[]): JobSnapshot | undefined {
    return jobs.find((job) => job.id === this.#selectedId);
  }

  private selectJob(delta: number, jobs: readonly JobSnapshot[]): void {
    if (!jobs.length) return;
    const index = jobs.findIndex((job) => job.id === this.#selectedId);
    const next = jobs[clampDashboard(index + delta, 0, jobs.length - 1)];
    if (!next || next.id === this.#selectedId) return;
    this.#selectedId = next.id;
    this.resetScroll();
  }

  private toggleToolDisplay(): void {
    this.#toolDisplay = this.#toolDisplay === "compact" ? "full" : "compact";
    this.invalidate();
  }

  private enterComposer(job: JobSnapshot | undefined, behavior: SendBehavior): void {
    if (!job) return;
    const policy = takeoverPolicy(job);
    if (!policy.reusable) {
      this.#notice = policy.restriction ?? "This native session is read-only.";
      return;
    }
    const composer = takeoverComposer(behavior);
    this.bindDraft({ jobId: job.id, composer });
    this.#focus = { kind: "composer", composer };
    this.#behavior = behavior;
    this.#input.focused = this.#focused;
  }

  private leaveComposer(): void {
    this.#focus = { kind: "job-detail" };
    this.#behavior = undefined;
    this.#answerIdentity = undefined;
    this.#input.focused = false;
  }

  /** True while a composer owns keyboard input, for either steering or answering. */
  private composing(): boolean {
    return this.#focus.kind === "composer";
  }

  /**
   * Opens the inline answer composer for a human-owned question. Model-owned
   * questions stay read-only here: their answer belongs to the parent thread,
   * which is woken with its own `subagent_answer` call.
   */
  private enterAnswer(job: JobSnapshot | undefined): void {
    const interaction = job && pendingInteraction(job);
    if (!job || !interaction) return;
    if (!interaction.humanVisible || interaction.target.kind !== "orchestrator") {
      this.#notice = "This question is routed to the orchestrator; it answers from the parent thread.";
      return;
    }
    if (!this.manager.answerInteraction) {
      this.#notice = "This session cannot answer routed questions.";
      return;
    }
    this.bindDraft({ jobId: job.id, composer: "answer", requestId: interaction.requestId });
    this.#focus = { kind: "composer", composer: "answer" };
    this.#behavior = undefined;
    this.#answerIdentity = { jobId: job.id, requestId: interaction.requestId };
    this.#input.focused = this.#focused;
  }

  private bindDraft(owner: DraftOwner): void {
    const current = this.#draftOwner;
    if (!current
      || current.jobId !== owner.jobId
      || current.composer !== owner.composer
      || current.requestId !== owner.requestId) {
      this.#inputRevision++;
      this.#input.setValue("");
    }
    this.#draftOwner = owner;
  }

  private submit(raw: string): void {
    if (!this.composing()) return;
    const message = raw.trim();
    if (!message) return;
    if (this.#focus.kind === "composer" && this.#focus.composer === "answer") return this.submitAnswer(message, raw);
    if (this.#pendingSend) {
      this.#notice = "Previous message is still being sent; keep editing and try again when it settles.";
      this.tui.requestRender();
      return;
    }
    const job = this.currentJob(this.#jobs ?? this.manager.list());
    if (!job) return;
    if (pendingInteraction(job)) {
      this.#notice = "This job is waiting on a routed question. Your draft is unchanged; answer through the displayed route.";
      this.tui.requestRender();
      return;
    }
    const policy = takeoverPolicy(job);
    if (!policy.reusable) {
      this.#notice = policy.restriction ?? "This native session is read-only.";
      this.tui.requestRender();
      return;
    }
    const draft = raw;
    this.#input.setValue("");
    this.#followTail = true;
    this.#pendingSend = { jobId: job.id, draft, inputRevision: this.#inputRevision };
    void this.manager.send(job.id, message, this.#behavior ?? policy.behavior)
      .then(() => {
        this.#pendingSend = undefined;
      })
      .catch((error: unknown) => {
        const pending = this.#pendingSend;
        this.#pendingSend = undefined;
        // Restore only the rejected request's draft, only on the same job, and
        // only when the operator has not started a newer draft while in flight.
        if (
          pending &&
          this.#selectedId === pending.jobId &&
          this.#inputRevision === pending.inputRevision &&
          this.#input.getValue() === ""
        ) this.#input.setValue(pending.draft);
        this.#notice = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
  }

  /**
   * Resolves the pinned question in place. Late, duplicate, expired, and
   * dismissed requests fail in the manager, so the composer surfaces that
   * message and keeps the draft instead of silently dropping the answer.
   */
  private submitAnswer(answer: string, raw: string): void {
    const identity = this.#answerIdentity;
    const answerInteraction = this.manager.answerInteraction;
    if (!identity || !answerInteraction) return;
    const job = this.currentJob(this.manager.list());
    const interaction = job && pendingInteraction(job);
    if (
      !job
      || job.id !== identity.jobId
      || !interaction
      || interaction.requestId !== identity.requestId
      || !interaction.humanVisible
      || interaction.target.kind !== "orchestrator"
    ) {
      this.#notice = "This routed question changed or closed. Your draft is unchanged; go back before answering the current question.";
      this.tui.requestRender();
      return;
    }
    try {
      answerInteraction.call(this.manager, identity.requestId, answer, "human");
      this.#input.setValue("");
      this.#notice = "Answer delivered; the subagent resumed.";
      this.leaveComposer();
    } catch (error) {
      this.#notice = error instanceof Error ? error.message : String(error);
      this.#input.setValue(raw);
    }
    this.tui.requestRender();
  }

  private requestCancel(job: JobSnapshot | undefined, armed: string | undefined): void {
    if (!this.cancelableJob(job)) return;
    if (armed !== job.id) {
      if (!this.cancelControlVisible(job)) return;
      this.#confirmCancelId = job.id;
      // The host normally renders immediately after requestRender. Retain the
      // already-visible control for a same-turn confirmation before that paint;
      // a later render clears or replaces this exact state.
      this.#renderedConfirmationId = job.id;
      return;
    }
    if (this.#renderedConfirmationId !== job.id) {
      this.#notice = "Cancellation dismissed.";
      return;
    }
    this.#notice = `Cancelling ${sanitizeInline(job.name)}…`;
    void this.manager.cancel(job.id, "Cancelled from /subagents dashboard").catch((error: unknown) => {
      this.#notice = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    });
  }

  /* ── scrolling ─────────────────────────────────────────────────────────── */

  private resetScroll(): void {
    this.#scroll = 0;
    this.#scrollJobId = this.#selectedId;
    this.#followTail = true;
    this.#transcriptRows = 0;
    this.#transcriptTotal = 0;
  }

  private maxScroll(): number {
    return Math.max(0, this.#transcriptTotal - this.#transcriptRows);
  }

  private scroll(delta: number): void {
    this.scrollTo(this.#scroll + delta);
  }

  private scrollTo(offset: number): void {
    const max = this.maxScroll();
    this.#scroll = clampDashboard(offset, 0, max);
    // Keep an explicit top request unpinned even before the first detail
    // render has established a non-zero transcript viewport.
    this.#followTail = offset !== 0 && this.#scroll >= max;
  }

  private halfPageStep(): number {
    return Math.max(1, Math.floor(this.#transcriptRows / 2));
  }

  private pageStep(): number {
    return Math.max(1, this.#transcriptRows - 1);
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */

  private renderWide(
    frame: DashboardFrame,
    layout: DashboardLayout,
    jobs: JobSnapshot[],
    collection: DashboardCollection<JobSnapshot, JobDashboardGroup>,
    chosen: JobSnapshot | undefined,
  ): string[] {
    const { left, right } = frame.columns(layout.railWidth);
    const view = dashboardCollectionViewport(collection, this.#selectedId, layout.contentRows, (job) => job.id);
    const rail = this.renderRail(jobs, view, chosen, layout.contentRows, Math.max(1, left - 1));
    const detail = this.renderInspector(chosen, layout.contentRows, Math.max(1, right - 1));
    const lines = [
      this.renderHeader(frame, jobs),
      frame.splitTop(this.listTitle(jobs, view), this.detailTitle(chosen), layout.railWidth),
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
    jobs: JobSnapshot[],
    collection: DashboardCollection<JobSnapshot, JobDashboardGroup>,
    chosen: JobSnapshot | undefined,
  ): string[] {
    const view = dashboardCollectionViewport(collection, this.#selectedId, layout.listRows, (job) => job.id);
    const lines = [this.renderHeader(frame, jobs), frame.top(this.listTitle(jobs, view))];
    for (const row of this.renderList(jobs, view, chosen, layout.listRows, frame.innerWidth)) {
      lines.push(frame.row(row));
    }
    lines.push(frame.divider(this.detailTitle(chosen)));
    for (const row of this.renderInspector(chosen, layout.detailRows, Math.max(1, frame.innerWidth - 1))) {
      lines.push(frame.row(` ${row}`));
    }
    lines.push(frame.bottom(), this.renderHint(frame, chosen));
    return lines;
  }

  private renderNarrow(
    frame: DashboardFrame,
    layout: DashboardLayout,
    jobs: JobSnapshot[],
    collection: DashboardCollection<JobSnapshot, JobDashboardGroup>,
    chosen: JobSnapshot | undefined,
  ): string[] {
    const detail = this.#focus.kind !== "job-list" && chosen;
    const view = dashboardCollectionViewport(collection, this.#selectedId, layout.contentRows, (job) => job.id);
    // At the eight-row floor, question supervision needs five inspector rows.
    // Keep the panel and footer geometry; the session summary yields its row.
    const expandQuestionDetail = detail && layout.contentRows === 4 && pendingInteraction(chosen);
    const bodyRows = layout.contentRows + (expandQuestionDetail ? 1 : 0);
    const lines = expandQuestionDetail ? [] : [this.renderHeader(frame, jobs)];
    lines.push(frame.top(detail ? this.detailTitle(chosen) : this.listTitle(jobs, view)));
    const body = detail
      ? this.renderInspector(chosen, bodyRows, Math.max(1, frame.innerWidth - 1)).map((row) => ` ${row}`)
      : this.renderList(jobs, view, chosen, bodyRows, frame.innerWidth);
    for (const row of body) lines.push(frame.row(row));
    lines.push(frame.bottom(), this.renderHint(frame, chosen));
    return lines;
  }

  private renderCompact(rows: number, jobs: JobSnapshot[], frame: DashboardFrame, width: number): string[] {
    const header = this.renderHeader(frame, jobs);
    if (rows <= 1) return [truncate("Esc close", width)];
    if (rows === 2) return [header, frame.hint("Esc close")];
    if (rows === 3) return [header, frame.row(this.theme.fg("dim", "  Screen too short — resize to supervise jobs.")), frame.hint("Esc close")];
    if (rows === 4) return [header, frame.top("jobs"), frame.bottom(), frame.hint("Esc close")];
    return [
      header,
      frame.top("jobs"),
      frame.row(this.theme.fg("dim", "  Screen too short — resize to supervise jobs.")),
      frame.bottom(),
      frame.hint("Esc close"),
    ];
  }

  /** `?` cheatsheet: a grouped legend for whichever pane is currently active. */
  private renderHelp(frame: DashboardFrame, layout: DashboardLayout, jobs: JobSnapshot[]): string[] {
    const listFocused = this.#focus.kind === "job-list";
    return [
      this.renderHeader(frame, jobs),
      ...renderDashboardHelp(this.theme, frame, "help", this.helpGroups(listFocused), layout.contentRows),
      frame.hint(`? or ${dashboardCancelKeyLabel(this.keybindings)} close help`),
    ];
  }

  private helpGroups(listFocused: boolean): DashboardKeyGroup[] {
    const confirm = dashboardConfirmKeyLabel(this.keybindings);
    const cancel = dashboardCancelKeyLabel(this.keybindings);
    if (listFocused) {
      return [
        { title: "Navigate", entries: [["↑↓ / j k", "select job"], [`${confirm} / →`, "inspect job"]] },
        { title: "Actions", entries: [
          ["s", "steer a running job"],
          ["f", "queue a follow-up on a finished job"],
          ["a", "answer a question your own /subagent job asked"],
          ["x", "cancel a live job (press twice)"],
        ] },
        { title: "Panel", entries: [[cancel, "close"], ["?", "close this help"]] },
      ];
    }
    return [
      { title: "Navigate", entries: [["↑↓ / j k", "scroll detail"], ["←", "back to jobs"]] },
      { title: "Actions", entries: [
        ["s", "steer a running job"],
        ["f", "queue a follow-up on a finished job"],
        ["a", "answer a question your own /subagent job asked"],
        ["x", "cancel a live job (press twice)"],
        ["t / Ctrl+T", "toggle compact/full tool display"],
        ["i", "show / hide routine info"],
      ] },
      { title: "Scroll", entries: [
        ["Shift+↑↓", "scroll transcript"],
        ["PgUp/PgDn", "page (wide/medium)"],
        ["Ctrl+U/D", "half-page scroll"],
        ["g / G", "top / bottom"],
      ] },
      { title: "Panel", entries: [[cancel, "back / close"], ["?", "close this help"]] },
    ];
  }

  private renderHeader(frame: DashboardFrame, jobs: JobSnapshot[]): string {
    const active = jobs.filter((job) => job.status === "running").length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const capacity = this.manager.concurrency ?? 4;
    const needInput = jobs.filter((job) => pendingInteraction(job)).length;
    const failed = jobs.filter((job) => job.status === "failed").length;
    const attention = [
      needInput ? `${needInput} need input` : "",
      active ? `${active} active` : "",
      failed ? `${failed} failed` : "",
    ].filter(Boolean);
    const routine = [
      `${jobs.length} retained`,
      `${active}/${capacity} slots`,
      queued ? `${queued} queued` : "",
    ].filter(Boolean);
    const availability = formatDashboardAvailability(this.#availability);
    const routeFallback = dashboardAvailabilityFallback(this.#availability);
    const candidates = [
      ["Native subagents", ...attention, ...routine, availability],
      ["Native subagents", ...attention, ...routine, routeFallback],
      ["Native subagents", ...attention, routeFallback],
      ["Subagents", ...attention, routeFallback],
      [...attention, routeFallback],
      ["Subagents", ...attention],
      attention,
      ...attention.slice(0, -1).map((_, index) => attention.slice(0, attention.length - index - 1)),
      ...attention.slice(0, -1).map((_, index) => ["Subagents", ...attention.slice(0, attention.length - index - 1)]),
      ["Subagents", `${jobs.length} jobs`],
    ].map((parts) => parts.filter(Boolean).join(" · "));
    const availableWidth = Math.max(0, frame.innerWidth - 2);
    const text = candidates.find((candidate) => visibleWidth(candidate) <= availableWidth)
      ?? candidates.at(-1)
      ?? "Subagents";
    return frame.header(
      this.theme.fg("accent", this.theme.bold(text)),
      "",
    );
  }

  private listTitle(jobs: JobSnapshot[], view: JobListViewport): string {
    const running = jobs.filter((job) => job.status === "running").length;
    const capacity = this.manager.concurrency ?? 4;
    const clipped = `${view.clippedBefore ? "↑" : ""}${view.clippedAfter ? "↓" : ""}`;
    const focus = this.#focus.kind === "job-list" ? "▸ " : "";
    return `${focus}jobs · ${Math.min(running, capacity)}/${capacity} slots${clipped ? ` ${clipped}` : ""}`;
  }

  private detailTitle(job: JobSnapshot | undefined): string {
    // The tool-display mode also lives in the terse footer hint, but that hint
    // truncates first under width pressure; the title survives longer.
    if (!job) return "detail";
    if (this.#focus.kind === "composer" && this.#focus.composer === "answer") return `▸ answer · ${shortId(sanitizeText(job.id))} · ${this.#toolDisplay}`;
    if (this.#focus.kind !== "composer") {
      const interaction = pendingInteraction(job);
      const marker = this.#focus.kind === "job-detail" ? "▸ " : "";
      return `${marker}detail · ${shortId(sanitizeText(job.id))} · ${interaction ? interactionWaitLabel(interaction) : job.status} · ${this.#toolDisplay}`;
    }
    return `▸ composer · ${this.#focus.composer} · ${shortId(sanitizeText(job.id))} · ${this.#toolDisplay}`;
  }

  private renderRail(
    jobs: JobSnapshot[],
    view: JobListViewport,
    chosen: JobSnapshot | undefined,
    rows: number,
    width: number,
  ): string[] {
    if (!jobs.length) return this.renderEmptyJobs(rows, false);
    const lines = view.rows.map((row) => {
      if (row.kind !== "item") return this.renderCollectionRow(row, width);
      const job = row.item;
      const status = pendingInteraction(job) ? { glyph: "?", color: "warning" as const } : statusMeta(job.status, this.#now());
      const selected = job.id === chosen?.id;
      const marker = dashboardSelectionMarker(this.theme, selected);
      const name = sanitizeInline(job.name);
      const identity = `${marker} ${this.theme.fg(status.color, status.glyph)} ${this.theme.fg(selected ? "accent" : "text", name)}`;
      const summary = jobDashboardSummary(job);
      const decoration = this.theme.fg(dashboardSummaryColor(summary), summary.text)
        + this.theme.fg("muted", ` · ${formatElapsed(job, this.#now())}`);
      const owner = job.workflow ? `${this.theme.fg("muted", "workflow · ")}` : "";
      const right = `${owner}${this.theme.fg(status.color, job.status)}`;
      return alignDashboardSummaryRow(
        identity,
        decoration,
        right,
        width,
      );
    });
    return fitDashboardRows(lines, rows);
  }

  private renderList(
    jobs: JobSnapshot[],
    view: JobListViewport,
    chosen: JobSnapshot | undefined,
    rows: number,
    width: number,
  ): string[] {
    if (!jobs.length) return this.renderEmptyJobs(rows, true);
    return fitDashboardRows(view.rows.map((row) => row.kind === "item"
      ? this.renderJob(row.item, row.item.id === chosen?.id, width)
      : this.renderCollectionRow(row, width)), rows);
  }

  private renderCollectionRow(
    row: Exclude<DashboardCollectionRow<JobSnapshot, JobDashboardGroup>, { kind: "item" }>,
    width: number,
  ): string {
    return row.kind === "section"
      ? dashboardSectionRow(this.theme, row.label, row.count, width)
      : dashboardFoldRow(this.theme, row.label, row.hidden, width);
  }

  private renderEmptyJobs(rows: number, indented: boolean): string[] {
    const prefix = indented ? "  " : "";
    return fitDashboardRows([
      this.theme.fg("muted", `${prefix}No jobs in this session.`),
      this.theme.fg("dim", `${prefix}/subagent <task> starts one.`),
    ], rows);
  }

  private renderJob(job: JobSnapshot, selected: boolean, width: number): string {
    const interaction = pendingInteraction(job);
    const status = interaction ? { glyph: "?", color: "warning" as const } : statusMeta(job.status, this.#now());
    const marker = dashboardSelectionMarker(this.theme, selected);
    const name = this.theme.fg(selected ? "accent" : "text", sanitizeInline(job.name));
    const identity = ` ${marker} ${this.theme.fg(status.color, status.glyph)} ${name}`;
    const summary = jobDashboardSummary(job);
    // Stable policy metadata belongs in the inspector. Ownership and lifecycle
    // wording own the right edge; route and elapsed yield with the summary.
    const decoration = this.theme.fg(dashboardSummaryColor(summary), summary.text)
      + this.theme.fg(
        "muted",
        ` · ${sanitizeInline(job.harness)} · ${formatElapsed(job, this.#now())}`,
      );
    const owner = job.workflow ? `${this.theme.fg("muted", "workflow · ")}` : "";
    const right = `${owner}${this.theme.fg(status.color, job.status)} `;
    return alignDashboardSummaryRow(
      identity,
      decoration,
      right,
      width,
    );
  }

  /** Job detail plus, in takeover mode, the composer. Always exactly `rows` lines. */
  private renderInspector(job: JobSnapshot | undefined, rows: number, width: number): string[] {
    if (!job) {
      return fitDashboardRows([this.theme.fg("dim", "Select a job to inspect its route, usage, and transcript.")], rows);
    }
    const composer = this.composing() ? this.renderComposer(job, width) : [];
    const bodyRows = Math.max(0, rows - composer.length);
    return [...fitDashboardRows(this.renderDetail(job, bodyRows, width), bodyRows), ...composer].slice(0, rows);
  }

  private renderComposer(job: JobSnapshot, width: number): string[] {
    if (this.#focus.kind === "composer" && this.#focus.composer === "answer") {
      const rule = dashboardScrollRule(this.theme, `answer · ${dashboardSubmitKeyLabel(this.keybindings)} sends`, width);
      return [rule, this.#input.render(Math.max(1, width))[0] ?? ""];
    }
    const policy = takeoverPolicy(job);
    const behavior = this.#behavior ?? policy.behavior;
    const label = policy.reusable
      ? `${behavior === "followUp" ? "follow-up" : "steer"} · ${dashboardSubmitKeyLabel(this.keybindings)} sends`
      : "read-only session";
    const rule = dashboardScrollRule(this.theme, label, width);
    if (!policy.reusable) {
      return [rule, truncate(this.theme.fg("warning", `! ${policy.restriction ?? "read-only"}`), width)];
    }
    return [rule, this.#input.render(Math.max(1, width))[0] ?? ""];
  }

  /**
   * Detail rows in priority order. The name and live status always render, a
   * failure error is pinned above transcript content and never dropped to make
   * room, and the remaining metadata gives way to the transcript when rows run out.
   */
  private renderDetail(job: JobSnapshot, rows: number, width: number): string[] {
    const now = this.#now();
    const status = statusMeta(job.status, now);
    const identity = [this.renderTitle(job, width)];
    const generation = job.generation ? ` · turn ${job.generation + 1}` : "";
    const statusLine = truncate(
      `${this.theme.fg(status.color, `${status.glyph} ${job.status}`)}${this.theme.fg("dim", ` · ${formatElapsed(job, now)}${generation}`)}`,
      width,
    );
    const statePreview = directJobStatePreview(
      job,
      now,
      this.theme,
      width,
      !!this.manager.answerInteraction,
    );
    identity.push(statusLine);
    const pinned = [...statePreview];
    if (job.answeringInteraction) {
      pinned.push(truncate(this.theme.fg("muted", `↩ answering ${sanitizeInline(job.answeringInteraction.sourceName)}`), width));
    }

    const info: string[] = [];
    const task = sanitizeInline(job.task);
    info.push(truncate(this.theme.fg("dim", `Task · ${task || "(no task description)"}`), width));
    const route = [
      job.access,
      job.profile ? `profile ${sanitizeInline(job.profile)}` : "",
      job.independent ? "independent" : "",
      `effort ${formatEffort(job.effort)}`,
      `${sanitizeInline(job.harness)}/${sanitizeInline(job.model)}`,
      job.capabilities?.auto ? "auto-routed" : "",
    ].filter(Boolean).join(" · ");
    info.push(truncate(this.theme.fg("muted", `Route · ${route}`), width));
    const meter = [formatUsage(job.usage), `budget ${formatSpendBudget(job.budget, job.usage, job.harness)}`, formatContext(job.context), job.backendSessionId ? `session ${shortId(job.backendSessionId)}` : ""]
      .filter(Boolean).join(" · ");
    if (meter) info.push(truncate(this.theme.fg("dim", `Usage · ${meter}`), width));
    if (job.capabilities || job.requires?.length) {
      const capability = [
        job.capabilities?.auto ? "auto-routed" : "explicit route",
        job.requires?.length ? `required ${job.requires.map(sanitizeInline).join(", ")}` : "",
        job.capabilities?.matched.length ? `matched ${job.capabilities.matched.map(sanitizeInline).join(", ")}` : "",
        job.capabilities?.revision ? `revision ${shortId(job.capabilities.revision)}` : "",
      ].filter(Boolean).join(" · ");
      info.push(truncate(this.theme.fg("dim", `Capabilities · ${capability}`), width));
    }
    if (job.peer) info.push(truncate(this.theme.fg("muted", `Provenance · session peer of ${shortId(sanitizeText(job.peer.sourceSessionId))}`), width));
    if (job.independentOf) info.push(truncate(this.theme.fg("muted", `Provenance · independent of ${shortId(sanitizeText(job.independentOf))}`), width));
    if (job.workflow) {
      const phase = job.workflow.phase ? ` · ${sanitizeInline(job.workflow.phase)}` : "";
      info.push(truncate(this.theme.fg("muted", `Ownership · workflow ${shortId(sanitizeText(job.workflow.runId))} · ${sanitizeInline(job.workflow.label)}${phase} · supervise in /workflows`), width));
    }
    if (job.status === "queued") info.push(truncate(this.theme.fg("dim", `Queue · ${this.queueNote()}`), width));
    for (const warning of (job.warnings ?? []).slice(-2)) {
      pinned.push(truncate(this.theme.fg("warning", `!  ${sanitizeInline(warning)}`), width));
    }
    if (job.truncated) pinned.push(truncate(this.theme.fg("warning", "!  bounded output truncated — earliest lines dropped"), width));

    // Tool activity lives in the transcript's Pi-style execution shells. Keeping
    // a second recent-tools list here duplicates the same calls and steals rows
    // from the more legible call/result presentation below.

    // Full Pi tool shells can need a call row plus a result row. Let routine
    // metadata yield that second transcript row when full detail is selected.
    const minimumTranscriptRows = this.#toolDisplay === "full" ? 2 : 1;
    const disclosed = [dashboardInfoRule(this.theme, this.#showInfo, width)];
    const headBudget = Math.max(0, rows - 1 - minimumTranscriptRows);
    const visiblePinned = pinned.slice(0, headBudget);
    const remainingHeadRows = headBudget - visiblePinned.length;
    const visibleIdentity = identity.slice(0, Math.max(0, remainingHeadRows - disclosed.length));
    const visibleDisclosure = disclosed.slice(0, Math.max(0, remainingHeadRows - visibleIdentity.length));
    const head = [...visiblePinned, ...visibleIdentity, ...visibleDisclosure];

    const transcript = this.#showInfo ? [...info, ...this.transcript(job, width)] : this.transcript(job, width);
    const transcriptRows = Math.max(0, rows - head.length - 1);
    if (this.#scrollJobId !== job.id) this.resetScroll();
    this.#transcriptRows = transcriptRows;
    this.#transcriptTotal = transcript.length;
    const max = this.maxScroll();
    this.#scroll = this.#followTail ? max : clampDashboard(this.#scroll, 0, max);
    const start = this.#scroll;
    const end = Math.min(transcript.length, start + transcriptRows);
    const label = dashboardViewportLabel(
      this.#showInfo ? "detail" : "transcript",
      start,
      end,
      transcript.length,
      this.#followTail,
      !isTerminal(job.status),
    );
    head.push(dashboardScrollRule(this.theme, label, width));
    for (const line of transcript.slice(start, end)) head.push(truncate(line, width, ""));
    return head;
  }

  /** The job name owns the title line; the id is only appended when it genuinely fits. */
  private renderTitle(job: JobSnapshot, width: number): string {
    const name = sanitizeInline(job.name) || "(unnamed)";
    const clipped = truncateToWidth(name, Math.max(1, width));
    const suffix = ` · ${shortId(sanitizeText(job.id))}`;
    const rendered = this.theme.fg("accent", this.theme.bold(clipped));
    return visibleWidth(clipped) + visibleWidth(suffix) <= width
      ? rendered + this.theme.fg("dim", suffix)
      : rendered;
  }

  private queueNote(): string {
    const queued = (this.#jobs ?? []).filter((item) => item.status === "queued").length;
    const capacity = this.manager.concurrency ?? 4;
    return `${queued} queued · ${capacity} slots`;
  }

  /** Wrapping and Markdown are the expensive part; they only rerun when the job or width moves. */
  private transcript(job: JobSnapshot, width: number): string[] {
    const key = `${transcriptSignature(job)}@${width}@${this.#toolDisplay}`;
    if (this.#transcriptCache?.key === key) return this.#transcriptCache.lines;
    const lines = buildTranscript(job, width, this.theme, { renderMarkdown: this.#renderMarkdown, toolDisplay: this.#toolDisplay });
    this.#transcriptCache = { key, lines };
    return lines;
  }

  private renderHint(frame: DashboardFrame, job: JobSnapshot | undefined): string {
    const back = this.#focus.kind !== "job-list";
    const right = `· ${dashboardCancelKeyLabel(this.keybindings)} ${back ? "back" : "close"}`;
    if (this.#confirmCancelId) {
      const name = sanitizeInline(this.#jobs?.find((item) => item.id === this.#confirmCancelId)?.name ?? "job");
      const marker = "Press x again to confirm";
      const candidates = [
        [`Cancel ${name}? ${marker}`, "· any other key keeps it running"],
        [`Cancel ${name}? ${marker}`, "· any key dismisses"],
        [`Cancel? ${marker}`, "· any key"],
        [marker, "· any key"],
      ] as const;
      const { rendered, confirmed } = renderDashboardConfirmHint(frame, marker, candidates, "Cancellation pending", right);
      if (confirmed) this.#renderedConfirmationId = this.#confirmCancelId;
      return rendered;
    }
    if (this.#notice) return frame.hint(`! ${sanitizeInline(this.#notice)}`, right);
    const rendered = frame.hint(this.controls(frame, job), right);
    if (this.cancelableJob(job) && rendered.includes("x cancel")) this.#renderedCancelId = job.id;
    return rendered;
  }

  private controls(frame: DashboardFrame, job: JobSnapshot | undefined): string {
    const scroll = "Shift+↑↓ scroll";
    const toolToggle = `t ${this.#toolDisplay === "compact" ? "full" : "compact"}`;
    const infoToggle = `i ${this.#showInfo ? "hide info" : "info"}`;
    if (this.#focus.kind === "composer" && this.#focus.composer === "answer") {
      return `${dashboardSubmitKeyLabel(this.keybindings)} answer · ${dashboardCancelKeyLabel(this.keybindings)} back · ${scroll}`;
    }
    if (this.#focus.kind === "composer") {
      const behavior = job ? (this.#behavior ?? takeoverPolicy(job).behavior) : "steer";
      const submit = dashboardSubmitKeyLabel(this.keybindings);
      return `${submit} ${behavior === "followUp" ? "queue follow-up" : "steer"} · Ctrl+T ${this.#toolDisplay === "compact" ? "full" : "compact"} · ${scroll}`;
    }
    const confirm = dashboardConfirmKeyLabel(this.keybindings);
    const live = job && !isTerminal(job.status);
    // The hint mirrors the same predicate the keys use, so a parked caller
    // never advertises a takeover its own handler refuses.
    const sendable = this.takeoverControlVisible(job);
    if (this.#focus.kind === "job-list") {
      const navigation = frame.innerWidth < 60 ? "↑↓/jk" : "↑↓/jk select";
      return [
        live ? "x cancel" : "",
        navigation,
        `${confirm}/→ inspect`,
        this.answerControlVisible(job) ? "a answer" : "",
        sendable && live ? "s steer" : "",
        sendable && !live ? "f follow-up" : "",
        toolToggle,
        infoToggle,
        "? help",
      ].filter(Boolean).join(" · ");
    }
    return [
      live ? "x cancel" : "",
      "↑↓/jk scroll",
      this.answerControlVisible(job) ? "a answer" : "",
      sendable && live ? "s steer" : "",
      sendable && !live ? "f follow-up" : "",
      toolToggle,
      infoToggle,
      `${scroll} · Ctrl+U/D · g/G`,
      "? help",
    ].filter(Boolean).join(" · ");
  }

  private takeoverControlVisible(job: JobSnapshot | undefined): boolean {
    return !this.composing()
      && this.#focus.kind !== "composer"
      && !!job
      // A parked caller is waiting on a provider tool result: a steer or
      // follow-up would start a competing user turn, so those controls are
      // withdrawn until the question settles. Cancellation stays available.
      && !pendingInteraction(job)
      && takeoverPolicy(job).reusable;
  }

  private answerControlVisible(job: JobSnapshot | undefined): boolean {
    if (this.#focus.kind === "composer" || !job || !this.manager.answerInteraction) return false;
    const interaction = pendingInteraction(job);
    return !!interaction && !!interaction.humanVisible && interaction.target.kind === "orchestrator";
  }

  private steerControlVisible(job: JobSnapshot | undefined): boolean {
    return this.takeoverControlVisible(job) && !isTerminal(job!.status);
  }

  private followUpControlVisible(job: JobSnapshot | undefined): boolean {
    return this.takeoverControlVisible(job) && isTerminal(job!.status);
  }

  private cancelControlVisible(job: JobSnapshot | undefined): boolean {
    return this.cancelableJob(job)
      && this.#renderedCancelId === job.id;
  }

  private cancelableJob(job: JobSnapshot | undefined): job is JobSnapshot {
    return !this.composing()
      && this.#layout !== undefined
      && !!job
      && !isTerminal(job.status);
  }

}

type JobListViewport = DashboardCollectionViewport<JobSnapshot, JobDashboardGroup>;

function jobDashboardCollection(jobs: readonly JobSnapshot[]): DashboardCollection<JobSnapshot, JobDashboardGroup> {
  return groupDashboardCollection(jobs, JOB_DASHBOARD_GROUPS, (job) => {
    if (pendingInteraction(job)) return "input";
    if (job.status === "running") return "working";
    if (job.status === "queued") return "waiting";
    if (job.status === "failed") return "failed";
    return "finished";
  });
}

/** Opening on a finished job while others are live buries the useful state; prefer live work. */
function defaultJob(jobs: readonly JobSnapshot[]): JobSnapshot {
  const running = jobs.find((job) => job.status === "running");
  if (running) return running;
  const queued = jobs.find((job) => job.status === "queued");
  if (queued) return queued;
  return jobs.reduce((latest, job) =>
    (job.endedAt ?? job.createdAt) >= (latest.endedAt ?? latest.createdAt) ? job : latest);
}

export async function openSubagentsDashboard(
  ctx: ExtensionCommandContext,
  manager: SubagentsDashboardManager,
  options: { focusJobId?: string; mode?: DashboardMode; availability?: HarnessActivation[] } = {},
): Promise<void> {
  if (ctx.mode !== "tui") {
    const jobs = manager.list();
    const availability = options.availability
      ? `${formatHarnessAvailabilityReport(options.availability, Date.now())}\n\n`
      : "";
    ctx.ui.notify(`${availability}${jobs.length ? jobs.map(statusLine).join("\n") : "No subagent jobs in this session."}`, "info");
    return;
  }
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      createDashboardOverlay(tui, theme, keybindings, manager, done, {
        focusJobId: options.focusJobId,
        mode: options.mode,
        availability: options.availability,
      }),
    {
      overlay: true,
      // Percentage geometry so a resize re-lays out; the panel itself decides how
      // many of those rows to use, which keeps the fullscreen and regular
      // budgets in one place instead of split across the host and the component.
      overlayOptions: { width: "100%", minWidth: 40, maxHeight: "100%", anchor: "center" },
    },
  );
}

/** Compact, non-color-only route state used in the dashboard header. */
export function formatDashboardAvailability(activations: HarnessActivation[] | undefined): string {
  if (!activations?.length) return "routes status unknown";
  return activations.map((activation) => {
    const state = activation.enabled ? availabilityLabel(activation.availability.status) : "disabled by user";
    return `${activation.harness} ${state}`;
  }).join(" · ");
}

function dashboardAvailabilityFallback(activations: HarnessActivation[] | undefined): string {
  if (!activations?.length) return "routes status unknown";
  if (activations.some((activation) =>
    !activation.enabled || !["ready", "unknown"].includes(activation.availability.status)
  )) return "routes abnormal";
  return activations.some((activation) => activation.availability.status === "unknown")
    ? "routes status unknown"
    : "";
}

export function renderMarkdown(text: string, width: number): string[] {
  return renderAssistantMarkdown(text, width);
}

export function truncateDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function truncate(value: string, width: number, ellipsis = "…"): string {
  return truncateToWidth(value, Math.max(0, width), ellipsis);
}

function statusLine(job: JobSnapshot): string {
  return `${job.id} ${job.status} ${job.name} [${job.access}${job.independent ? "; independent" : ""}; ${job.harness}/${job.model}; effort ${formatEffort(job.effort)}; budget ${formatSpendBudget(job.budget, job.usage, job.harness)}]`;
}

export { DashboardOverlay };
