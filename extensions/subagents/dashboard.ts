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
  dashboardScrollRule,
  dashboardSectionRow,
  dashboardSelectionMarker,
  dashboardSubmitKeyLabel,
  dashboardSummaryColor,
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
 * `/subagents` is one panel with three modes. Browse mode selects a job and reads
 * its normalized transcript; takeover mode keeps the same selection and scroll
 * position and adds a composer for steering or queuing a follow-up; answer mode
 * reuses that composer to resolve one routed question a job is parked on. The panel
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
  /** Panel mode on open. `takeover` is used by {@link openSubagentTakeover}. */
  mode?: DashboardMode;
  /** Forces the fullscreen height policy; defaults to Pi's renderer mode. */
  fullscreen?: boolean;
  /** Latest bounded startup/status discovery snapshot. */
  availability?: HarnessActivation[];
}

export type DashboardMode = "browse" | "takeover" | "answer";
export type { DashboardLayout, DashboardLayoutKind } from "../dashboard-style.ts";

type JobDashboardGroup = "input" | "working" | "waiting" | "failed" | "finished";

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
  #mode: DashboardMode;
  /** Selection is held by job id so list growth, eviction, and reordering cannot move it. */
  #selectedId: string | undefined;
  /** Single-pane drill-down state; only consulted by the `narrow` layout. */
  #pane: "list" | "detail" = "list";
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
  #notice = "";
  #behavior: SendBehavior | undefined;
  #pendingSend: { jobId: string; draft: string; inputRevision: number } | undefined;
  /** Request ID the answer composer is bound to, so a changed question cannot be answered by a stale draft. */
  #answerRequestId: string | undefined;
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
    this.#mode = options.mode ?? "browse";
    if (this.#mode === "takeover") this.#pane = "detail";
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
      return this.renderCompact(rows, jobs.length, frame, width);
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

    const takeover = this.composing();

    // The cheatsheet is a browse-only modal: `?` never reaches the takeover
    // composer, and while shown, `?` or cancel dismiss it without touching
    // pane, scroll, selection, or tool-display state.
    if (this.#showHelp) {
      if (cancel || data === "?") this.#showHelp = false;
      this.tui.requestRender();
      return;
    }

    if (cancel) {
      if (this.composing()) this.leaveTakeover();
      else if (this.#layout?.kind === "narrow" && this.#pane === "detail") {
        this.#pane = "list";
        this.resetScroll();
      }
      else return this.finish();
      this.tui.requestRender();
      return;
    }

    if (!takeover && data === "?") {
      this.#showHelp = true;
      this.tui.requestRender();
      return;
    }

    const narrowList = this.#layout?.kind === "narrow" && this.#pane === "list";
    if (takeover) {
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
    else if (narrowList) {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selectJob(-1, orderedJobs);
      else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selectJob(1, orderedJobs);
      else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
        if (job) {
          this.#pane = "detail";
          this.resetScroll();
        }
      }
      else if (matchesKey(data, "x") && this.cancelControlVisible(job)) this.requestCancel(job, undefined);
      else if (matchesKey(data, "t") || matchesKey(data, Key.ctrl("t"))) this.toggleToolDisplay();
    }
    else if (matchesKey(data, Key.shift(Key.up))) this.scroll(-1);
    else if (matchesKey(data, Key.shift(Key.down))) this.scroll(1);
    else if (!this.composing() && this.#layout?.kind !== "narrow" && matchesKey(data, Key.pageUp)) this.scroll(-this.pageStep());
    else if (!this.composing() && this.#layout?.kind !== "narrow" && matchesKey(data, Key.pageDown)) this.scroll(this.pageStep());
    else if (matchesKey(data, Key.ctrl("u"))) this.scroll(-this.halfPageStep());
    else if (matchesKey(data, Key.ctrl("d"))) this.scroll(this.halfPageStep());
    else if (matchesKey(data, "g")) this.scrollTo(0);
    else if (matchesKey(data, Key.shift("g"))) this.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selectJob(-1, orderedJobs);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selectJob(1, orderedJobs);
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      if (this.takeoverControlVisible(job)) this.enterTakeover(job);
    }
    else if (matchesKey(data, "s") && this.steerControlVisible(job)) this.enterTakeover(job, "steer");
    else if (matchesKey(data, "f") && this.followUpControlVisible(job)) this.enterTakeover(job, "followUp");
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
    this.#mode = "browse";
    this.#pane = "list";
    this.#behavior = undefined;
    this.#answerRequestId = undefined;
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
      if (this.composing()) this.leaveTakeover();
      return undefined;
    }
    const chosen = jobs.find((job) => job.id === this.#selectedId) ?? defaultJob(jobs);
    if (chosen.id !== this.#selectedId) {
      // The previous selection was evicted (or this is the first render): start clean.
      this.#selectedId = chosen.id;
      if (this.composing()) this.leaveTakeover();
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

  private enterTakeover(job: JobSnapshot | undefined, behavior?: SendBehavior): void {
    if (!job) return;
    const policy = takeoverPolicy(job);
    if (!policy.reusable) {
      this.#notice = policy.restriction ?? "This native session is read-only.";
      return;
    }
    this.#mode = "takeover";
    this.#pane = "detail";
    this.#behavior = behavior;
    this.#input.focused = this.#focused;
  }

  private leaveTakeover(): void {
    this.#mode = "browse";
    this.#behavior = undefined;
    this.#answerRequestId = undefined;
    this.#input.focused = false;
  }

  /** True while a composer owns keyboard input, for either steering or answering. */
  private composing(): boolean {
    return this.#mode !== "browse";
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
    this.#mode = "answer";
    this.#pane = "detail";
    this.#behavior = undefined;
    this.#answerRequestId = interaction.requestId;
    this.#input.focused = this.#focused;
  }

  private submit(raw: string): void {
    if (!this.composing()) return;
    const message = raw.trim();
    if (!message) return;
    if (this.#mode === "answer") return this.submitAnswer(message, raw);
    if (this.#pendingSend) {
      this.#notice = "Previous message is still being sent; keep editing and try again when it settles.";
      this.tui.requestRender();
      return;
    }
    const job = this.currentJob(this.#jobs ?? this.manager.list());
    if (!job) return;
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
    const requestId = this.#answerRequestId;
    const answerInteraction = this.manager.answerInteraction;
    if (!requestId || !answerInteraction) return;
    try {
      answerInteraction.call(this.manager, requestId, answer, "human");
      this.#input.setValue("");
      this.#notice = "Answer delivered; the subagent resumed.";
      this.leaveTakeover();
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
    const detail = this.#pane === "detail" && chosen;
    const view = dashboardCollectionViewport(collection, this.#selectedId, layout.contentRows, (job) => job.id);
    const lines = [
      this.renderHeader(frame, jobs),
      frame.top(detail ? this.detailTitle(chosen) : this.listTitle(jobs, view)),
    ];
    const body = detail
      ? this.renderInspector(chosen, layout.contentRows, Math.max(1, frame.innerWidth - 1)).map((row) => ` ${row}`)
      : this.renderList(jobs, view, chosen, layout.contentRows, frame.innerWidth);
    for (const row of body) lines.push(frame.row(row));
    lines.push(frame.bottom(), this.renderHint(frame, chosen));
    return lines;
  }

  private renderCompact(rows: number, count: number, frame: DashboardFrame, width: number): string[] {
    const header = frame.header(
      this.theme.fg("accent", this.theme.bold("Native subagents")),
      this.theme.fg("muted", `${count} job${count === 1 ? "" : "s"}`),
    );
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
    const narrowList = layout.kind === "narrow" && this.#pane === "list";
    return [
      this.renderHeader(frame, jobs),
      ...renderDashboardHelp(this.theme, frame, "help", this.helpGroups(narrowList), layout.contentRows),
      frame.hint(`? or ${dashboardCancelKeyLabel(this.keybindings)} close help`),
    ];
  }

  private helpGroups(narrowList: boolean): DashboardKeyGroup[] {
    const confirm = dashboardConfirmKeyLabel(this.keybindings);
    const cancel = dashboardCancelKeyLabel(this.keybindings);
    if (narrowList) {
      return [
        { title: "Navigate", entries: [["↑↓ / j k", "select job"], [confirm, "open detail"]] },
        { title: "Actions", entries: [["x", "cancel a live job (press twice)"]] },
        { title: "Panel", entries: [[cancel, "close"], ["?", "close this help"]] },
      ];
    }
    return [
      { title: "Navigate", entries: [["↑↓ / j k", "select job"], [confirm, "open takeover"]] },
      { title: "Actions", entries: [
        ["s", "steer a running job"],
        ["f", "queue a follow-up on a finished job"],
        ["a", "answer a question your own /subagent job asked"],
        ["x", "cancel a live job (press twice)"],
        ["t / Ctrl+T", "toggle compact/full tool display"],
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
    const running = jobs.filter((job) => job.status === "running").length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const capacity = this.manager.concurrency ?? 4;
    const needInput = jobs.filter((job) => pendingInteraction(job)).length;
    const summary = [
      `${running}/${capacity} running`,
      queued ? `${queued} queued` : "",
      needInput ? `${needInput} need input` : "",
      `${jobs.length} retained`,
    ].filter(Boolean).join(" · ");
    const availability = formatDashboardAvailability(this.#availability);
    return frame.header(
      this.theme.fg("accent", this.theme.bold(`Native subagents${availability ? ` · ${availability}` : ""}`)),
      this.theme.fg("muted", summary),
    );
  }

  private listTitle(jobs: JobSnapshot[], view: JobListViewport): string {
    const running = jobs.filter((job) => job.status === "running").length;
    const capacity = this.manager.concurrency ?? 4;
    const clipped = `${view.clippedBefore ? "↑" : ""}${view.clippedAfter ? "↓" : ""}`;
    const focus = this.#mode === "browse" ? "▸ " : "";
    return `${focus}jobs · ${Math.min(running, capacity)}/${capacity} slots${clipped ? ` ${clipped}` : ""}`;
  }

  private detailTitle(job: JobSnapshot | undefined): string {
    // The tool-display mode also lives in the terse footer hint, but that hint
    // truncates first under width pressure; the title survives longer.
    if (!job) return "detail";
    if (this.#mode === "answer") return `▸ answer · ${shortId(sanitizeText(job.id))} · ${this.#toolDisplay}`;
    if (this.#mode !== "takeover") {
      const interaction = pendingInteraction(job);
      return `detail · ${shortId(sanitizeText(job.id))} · ${interaction ? interactionWaitLabel(interaction) : job.status} · ${this.#toolDisplay}`;
    }
    const policy = takeoverPolicy(job);
    const behavior = this.#behavior ?? policy.behavior;
    return `▸ takeover · ${behavior === "followUp" ? "follow-up" : "steer"} · ${shortId(sanitizeText(job.id))} · ${this.#toolDisplay}`;
  }

  private renderRail(
    jobs: JobSnapshot[],
    view: JobListViewport,
    chosen: JobSnapshot | undefined,
    rows: number,
    width: number,
  ): string[] {
    if (!jobs.length) return fitDashboardRows([this.theme.fg("muted", "No jobs in this session.")], rows);
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
    if (!jobs.length) return fitDashboardRows([this.theme.fg("muted", "  No jobs in this session.")], rows);
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
    const bodyRows = Math.max(1, rows - composer.length);
    return [...fitDashboardRows(this.renderDetail(job, bodyRows, width), bodyRows), ...composer].slice(0, rows);
  }

  private renderComposer(job: JobSnapshot, width: number): string[] {
    if (this.#mode === "answer") {
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
    const pinned = [this.renderTitle(job, width)];
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
    if (pendingInteraction(job)) pinned.push(...statePreview, statusLine);
    else pinned.push(statusLine, ...statePreview);
    if (job.answeringInteraction) {
      pinned.push(truncate(this.theme.fg("muted", `↩ answering ${sanitizeInline(job.answeringInteraction.sourceName)}`), width));
    }

    const optional: string[] = [];
    const task = sanitizeInline(job.task);
    optional.push(truncate(this.theme.fg("dim", `task  ${task || "(no task description)"}`), width));
    const route = [
      job.access,
      job.profile ? `profile ${sanitizeInline(job.profile)}` : "",
      job.independent ? "independent" : "",
      `effort ${formatEffort(job.effort)}`,
      `${sanitizeInline(job.harness)}/${sanitizeInline(job.model)}`,
      job.capabilities?.auto ? "auto-routed" : "",
    ].filter(Boolean).join(" · ");
    optional.push(truncate(this.theme.fg("muted", `route ${route}`), width));
    const meter = [formatUsage(job.usage), `budget ${formatSpendBudget(job.budget, job.usage, job.harness)}`, formatContext(job.context), job.backendSessionId ? `session ${shortId(job.backendSessionId)}` : ""]
      .filter(Boolean).join(" · ");
    if (meter) optional.push(truncate(this.theme.fg("dim", `usage ${meter}`), width));
    if (job.workflow) {
      const phase = job.workflow.phase ? ` · ${sanitizeInline(job.workflow.phase)}` : "";
      optional.push(truncate(this.theme.fg("muted", `flow  ${shortId(sanitizeText(job.workflow.runId))} · ${sanitizeInline(job.workflow.label)}${phase}`), width));
    }
    if (job.status === "queued") optional.push(truncate(this.theme.fg("dim", `queue ${this.queueNote()}`), width));
    for (const warning of (job.warnings ?? []).slice(-2)) {
      optional.push(truncate(this.theme.fg("warning", `!  ${sanitizeInline(warning)}`), width));
    }
    if (job.truncated) optional.push(truncate(this.theme.fg("warning", "!  bounded output truncated — earliest lines dropped"), width));

    // Tool activity lives in the transcript's Pi-style execution shells. Keeping
    // a second recent-tools list here duplicates the same calls and steals rows
    // from the more legible call/result presentation below.

    // Full Pi tool shells can need a call row plus a result row. Let routine
    // metadata yield that second transcript row when full detail is selected.
    const minimumTranscriptRows = this.#toolDisplay === "full" ? 2 : 1;
    const budget = Math.max(0, rows - pinned.length - 1 - minimumTranscriptRows);
    const head = [...pinned, ...optional.slice(0, budget)];
    if (rows <= head.length + 1) return head.slice(0, rows);

    const transcript = this.transcript(job, width);
    const transcriptRows = Math.max(0, rows - head.length - 1);
    if (this.#scrollJobId !== job.id) this.resetScroll();
    this.#transcriptRows = transcriptRows;
    this.#transcriptTotal = transcript.length;
    const max = this.maxScroll();
    this.#scroll = this.#followTail ? max : clampDashboard(this.#scroll, 0, max);
    const start = this.#scroll;
    const end = Math.min(transcript.length, start + transcriptRows);
    const range = transcriptRows ? `${start + 1}–${end}` : "0";
    const label = `transcript ${range}/${transcript.length}${this.#followTail ? " · live" : ""}`;
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
    const back = this.composing() || (this.#layout?.kind === "narrow" && this.#pane === "detail");
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
    if (this.#mode === "answer") {
      return `${dashboardSubmitKeyLabel(this.keybindings)} answer · ${dashboardCancelKeyLabel(this.keybindings)} back · ${scroll}`;
    }
    if (this.#mode === "takeover") {
      const behavior = job ? (this.#behavior ?? takeoverPolicy(job).behavior) : "steer";
      const submit = dashboardSubmitKeyLabel(this.keybindings);
      return `${submit} ${behavior === "followUp" ? "queue follow-up" : "steer"} · Ctrl+T ${this.#toolDisplay === "compact" ? "full" : "compact"} · ${scroll}`;
    }
    const confirm = dashboardConfirmKeyLabel(this.keybindings);
    const live = job && !isTerminal(job.status);
    // The hint mirrors the same predicate the keys use, so a parked caller
    // never advertises a takeover its own handler refuses.
    const sendable = this.takeoverControlVisible(job);
    if (this.#layout?.kind === "narrow" && this.#pane === "list") {
      const navigation = frame.innerWidth < 60 ? "↑↓/jk" : "↑↓/jk select";
      return [live ? "x cancel" : "", navigation, `${confirm} open`, "? help"].filter(Boolean).join(" · ");
    }
    return [
      live ? "x cancel" : "",
      "↑↓/jk select",
      this.answerControlVisible(job) ? "a answer" : "",
      sendable ? `${confirm} takeover` : "",
      sendable && live ? "s steer" : "",
      sendable && !live ? "f follow-up" : "",
      toolToggle,
      `${scroll} · Ctrl+U/D · g/G`,
      "? help",
    ].filter(Boolean).join(" · ");
  }

  private takeoverControlVisible(job: JobSnapshot | undefined): boolean {
    return !this.composing()
      && !(this.#layout?.kind === "narrow" && this.#pane === "list")
      && !!job
      // A parked caller is waiting on a provider tool result: a steer or
      // follow-up would start a competing user turn, so those controls are
      // withdrawn until the question settles. Cancellation stays available.
      && !pendingInteraction(job)
      && takeoverPolicy(job).reusable;
  }

  private answerControlVisible(job: JobSnapshot | undefined): boolean {
    if (this.composing() || !job || !this.manager.answerInteraction) return false;
    if (this.#layout?.kind === "narrow" && this.#pane === "list") return false;
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
