import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  alignDashboardRow,
  createDashboardFrame,
  dashboardOverlayRows,
} from "../dashboard-style.ts";
import { isTerminal } from "../../src/manager.ts";
import {
  formatContext,
  formatEffort,
  formatElapsed,
  formatUsage,
  sanitizeInline,
  sanitizeText,
  shortId,
  statusMeta,
} from "./render.ts";
import { buildTranscript, takeoverPolicy, transcriptSignature } from "./transcript.ts";
import type { JobSnapshot, SendBehavior } from "../../src/types.ts";

/*
 * `/subagents` is one panel with two modes. Browse mode selects a job and reads
 * its normalized transcript; takeover mode keeps the same selection and scroll
 * position and adds a composer for steering or queuing a follow-up. The panel
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
  /** Global concurrent-job budget, when the manager reports one. */
  readonly concurrency?: number;
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
}

export type DashboardMode = "browse" | "takeover";
export type DashboardLayoutKind = "wide" | "medium" | "narrow";

/** A wide terminal earns a jobs rail beside the inspector; a medium one stacks them. */
export const DASHBOARD_WIDE_MIN_WIDTH = 96;
export const DASHBOARD_MEDIUM_MIN_WIDTH = 64;
/** Content rows below which the panel drops to a single-pane drill-down. */
export const DASHBOARD_SPLIT_MIN_ROWS = 10;
/** Panel rows below which only a summary fits. */
const DASHBOARD_COMPACT_ROWS = 6;
/** Chrome around the content area: header, top border, bottom border, hint. */
const DASHBOARD_CHROME_ROWS = 4;

export interface DashboardLayout {
  kind: DashboardLayoutKind;
  /** Total lines the panel renders. Never exceeds the overlay's height budget. */
  height: number;
  /** Rows between the top and bottom borders. */
  contentRows: number;
  /** Visible width of the jobs rail. `wide` only. */
  railWidth: number;
  /** Rows above the detail divider. `medium` only. */
  listRows: number;
  /** Rows given to the inspector. */
  detailRows: number;
}

export function dashboardLayout(width: number, rows: number): DashboardLayout {
  const height = Math.max(0, rows);
  const contentRows = Math.max(1, height - DASHBOARD_CHROME_ROWS);
  const innerWidth = Math.max(0, width - 2);
  if (width >= DASHBOARD_WIDE_MIN_WIDTH && contentRows >= DASHBOARD_SPLIT_MIN_ROWS) {
    const railWidth = Math.max(26, Math.min(44, Math.round(innerWidth * 0.32)));
    return { kind: "wide", height, contentRows, railWidth, listRows: contentRows, detailRows: contentRows };
  }
  if (width >= DASHBOARD_MEDIUM_MIN_WIDTH && contentRows >= DASHBOARD_SPLIT_MIN_ROWS) {
    // The list keeps a scannable head; the detail pane gets everything else.
    const listRows = Math.max(2, Math.min(6, Math.floor((contentRows - 1) * 0.3)));
    return { kind: "medium", height, contentRows, railWidth: 0, listRows, detailRows: Math.max(1, contentRows - 1 - listRows) };
  }
  return { kind: "narrow", height, contentRows, railWidth: 0, listRows: contentRows, detailRows: contentRows };
}

/** Pi 0.81+ reports its renderer mode; older hosts only ever render the regular main screen. */
export function isFullscreenTui(tui: unknown): boolean {
  return (tui as { mode?: unknown } | undefined)?.mode === "fullscreen";
}

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
  #transcriptRows = 0;
  #transcriptTotal = 0;
  /** Job id armed for cancellation; a second `x` confirms, any other key disarms. */
  #confirmCancelId: string | undefined;
  #notice = "";
  #behavior: SendBehavior | undefined;
  #pendingSend: { jobId: string; draft: string; inputRevision: number } | undefined;
  #inputRevision = 0;
  #input = new Input();
  #jobs: JobSnapshot[] | undefined;
  #layout: DashboardLayout | undefined;
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
    this.#input.focused = value && this.#mode === "takeover";
  }

  render(width: number): string[] {
    width = Math.max(0, width);
    const jobs = this.manager.list();
    this.#jobs = jobs;
    const chosen = this.syncSelection(jobs);
    this.syncTicker(jobs);

    const rows = dashboardOverlayRows(this.tui.terminal?.rows ?? 0, this.fullscreen());
    if (!rows) return [];
    if (width < 4) return [truncate(`Subagents ${jobs.length}`, width)];

    const frame = createDashboardFrame(this.theme, width, this.#focused);
    if (rows < DASHBOARD_COMPACT_ROWS) return this.renderCompact(rows, jobs.length, frame, width);

    const layout = dashboardLayout(width, rows);
    this.#layout = layout;
    if (layout.kind === "wide") return this.renderWide(frame, layout, jobs, chosen);
    if (layout.kind === "medium") return this.renderMedium(frame, layout, jobs, chosen);
    return this.renderNarrow(frame, layout, jobs, chosen);
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
    const jobs = this.#jobs ?? this.manager.list();
    // Both the cancel arm and the notice are answers to the previous keystroke.
    const armed = this.#confirmCancelId;
    this.#confirmCancelId = undefined;
    this.#notice = "";
    const job = this.currentJob(jobs);
    const drillDown = this.#layout?.kind === "narrow";

    if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
      if (armed) this.#notice = "Cancellation dismissed.";
      else if (this.#mode === "takeover") this.leaveTakeover();
      else if (drillDown && this.#pane === "detail") this.#pane = "list";
      else return this.finish();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.shift(Key.up))) this.scroll(-1);
    else if (matchesKey(data, Key.shift(Key.down))) this.scroll(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll(-this.pageStep());
    else if (matchesKey(data, Key.pageDown)) this.scroll(this.pageStep());
    else if (this.#mode !== "takeover" && matchesKey(data, Key.ctrl("u"))) this.scroll(-this.halfPageStep());
    else if (this.#mode !== "takeover" && matchesKey(data, Key.ctrl("d"))) this.scroll(this.halfPageStep());
    else if (this.#mode !== "takeover" && matchesKey(data, "g")) this.scrollTo(0);
    else if (this.#mode !== "takeover" && matchesKey(data, Key.shift("g"))) this.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (this.#mode === "takeover") {
      // Route the host's configured input-submit binding explicitly; the
      // bundled Input component otherwise consults its own TUI keybinding
      // singleton. Printable navigation keys must remain ordinary text here.
      if (this.keybindings.matches(data, "tui.input.submit") || matchesKey(data, Key.enter)) this.submit(this.#input.getValue());
      else {
        this.#inputRevision++;
        this.#input.handleInput(data);
      }
    }
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selectJob(-1, jobs);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selectJob(1, jobs);
    else if (drillDown && (matchesKey(data, Key.left) || matchesKey(data, "h"))) this.#pane = "list";
    else if (drillDown && this.#pane === "list" && (matchesKey(data, Key.right) || matchesKey(data, "l"))) this.#pane = "detail";
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      if (drillDown && this.#pane === "list") this.#pane = "detail";
      else this.enterTakeover(job);
    }
    else if (matchesKey(data, "s")) this.enterTakeover(job, "steer");
    else if (matchesKey(data, "f")) this.enterTakeover(job, "followUp");
    else if (matchesKey(data, "x")) this.requestCancel(job, armed);
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

  /* ── selection and actions ─────────────────────────────────────────────── */

  private syncSelection(jobs: JobSnapshot[]): JobSnapshot | undefined {
    if (!jobs.length) {
      this.#selectedId = undefined;
      if (this.#mode === "takeover") this.leaveTakeover();
      return undefined;
    }
    const chosen = jobs.find((job) => job.id === this.#selectedId) ?? defaultJob(jobs);
    if (chosen.id !== this.#selectedId) {
      // The previous selection was evicted (or this is the first render): start clean.
      this.#selectedId = chosen.id;
      if (this.#mode === "takeover") this.leaveTakeover();
      this.resetScroll();
    }
    return chosen;
  }

  private currentJob(jobs: JobSnapshot[]): JobSnapshot | undefined {
    return jobs.find((job) => job.id === this.#selectedId);
  }

  private selectJob(delta: number, jobs: JobSnapshot[]): void {
    if (!jobs.length) return;
    const index = jobs.findIndex((job) => job.id === this.#selectedId);
    const next = jobs[clamp(index + delta, 0, jobs.length - 1)];
    if (!next || next.id === this.#selectedId) return;
    this.#selectedId = next.id;
    this.resetScroll();
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
    this.#input.focused = false;
  }

  private submit(raw: string): void {
    const message = raw.trim();
    if (!message) return;
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

  private requestCancel(job: JobSnapshot | undefined, armed: string | undefined): void {
    if (!job || isTerminal(job.status)) return;
    if (armed !== job.id) {
      this.#confirmCancelId = job.id;
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
    this.#scroll = clamp(offset, 0, max);
    this.#followTail = this.#scroll >= max;
  }

  private pageStep(): number {
    return Math.max(1, this.#transcriptRows - 1);
  }

  private halfPageStep(): number {
    return Math.max(1, Math.floor(this.#transcriptRows / 2));
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */

  private renderWide(
    frame: DashboardFrame,
    layout: DashboardLayout,
    jobs: JobSnapshot[],
    chosen: JobSnapshot | undefined,
  ): string[] {
    const { left, right } = frame.columns(layout.railWidth);
    const view = listViewport(jobs, this.selectedIndex(jobs), layout.contentRows);
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
    chosen: JobSnapshot | undefined,
  ): string[] {
    const view = listViewport(jobs, this.selectedIndex(jobs), layout.listRows);
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
    chosen: JobSnapshot | undefined,
  ): string[] {
    const detail = this.#pane === "detail" && chosen;
    const view = listViewport(jobs, this.selectedIndex(jobs), layout.contentRows);
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
    if (rows <= 1) return [truncate("Subagents", width)];
    if (rows === 2) return [header, frame.hint("Esc close")];
    if (rows === 3) return [header, frame.top("jobs"), frame.bottom()];
    if (rows === 4) return [header, frame.top("jobs"), frame.bottom(), frame.hint("Esc close")];
    return [
      header,
      frame.top("jobs"),
      frame.row(this.theme.fg("dim", "  Screen too short — resize to supervise jobs.")),
      frame.bottom(),
      frame.hint("Esc close"),
    ];
  }

  private renderHeader(frame: DashboardFrame, jobs: JobSnapshot[]): string {
    const running = jobs.filter((job) => job.status === "running").length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const capacity = this.manager.concurrency ?? 4;
    const summary = [
      `${running}/${capacity} running`,
      queued ? `${queued} queued` : "",
      `${jobs.length} retained`,
    ].filter(Boolean).join(" · ");
    return frame.header(
      this.theme.fg("accent", this.theme.bold("Native subagents")),
      this.theme.fg("muted", summary),
    );
  }

  private listTitle(jobs: JobSnapshot[], view: ListViewport): string {
    const running = jobs.filter((job) => job.status === "running").length;
    const capacity = this.manager.concurrency ?? 4;
    const clipped = `${view.start > 0 ? "↑" : ""}${view.end < jobs.length ? "↓" : ""}`;
    const focus = this.#mode === "browse" ? "▸ " : "";
    return `${focus}jobs · ${Math.min(running, capacity)}/${capacity} slots${clipped ? ` ${clipped}` : ""}`;
  }

  private detailTitle(job: JobSnapshot | undefined): string {
    if (!job) return "detail";
    if (this.#mode !== "takeover") return `detail · ${shortId(sanitizeText(job.id))} · ${job.status}`;
    const policy = takeoverPolicy(job);
    const behavior = this.#behavior ?? policy.behavior;
    return `▸ takeover · ${behavior === "followUp" ? "follow-up" : "steer"} · ${shortId(sanitizeText(job.id))}`;
  }

  private renderRail(
    jobs: JobSnapshot[],
    view: ListViewport,
    chosen: JobSnapshot | undefined,
    rows: number,
    width: number,
  ): string[] {
    if (!jobs.length) return fit([this.theme.fg("muted", "No jobs in this session.")], rows);
    const lines = view.items.map((job) => {
      const status = statusMeta(job.status, this.#now());
      const selected = job.id === chosen?.id;
      const marker = selected ? this.theme.fg("accent", "❯") : " ";
      const name = sanitizeInline(job.name);
      const left = `${marker} ${this.theme.fg(status.color, status.glyph)} ${this.theme.fg(selected ? "accent" : "text", name)}`;
      const right = this.theme.fg("muted", formatElapsed(job, this.#now()));
      return alignDashboardRow(left, right, width);
    });
    return fit(lines, rows);
  }

  private renderList(
    jobs: JobSnapshot[],
    view: ListViewport,
    chosen: JobSnapshot | undefined,
    rows: number,
    width: number,
  ): string[] {
    if (!jobs.length) return fit([this.theme.fg("muted", "  No jobs in this session.")], rows);
    return fit(view.items.map((job) => this.renderJob(job, job.id === chosen?.id, width)), rows);
  }

  private renderJob(job: JobSnapshot, selected: boolean, width: number): string {
    const status = statusMeta(job.status, this.#now());
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const name = this.theme.fg(selected ? "accent" : "text", sanitizeInline(job.name));
    const left = ` ${marker} ${this.theme.fg(status.color, status.glyph)} ${name} ${this.theme.fg("dim", shortId(sanitizeText(job.id)))}`;
    const owner = job.workflow ? " · workflow" : "";
    // Stable policy metadata belongs in the inspector. Keep the row's right
    // side compact so the job name survives narrow terminals.
    const right =
      this.theme.fg(
        "muted",
        `${sanitizeInline(job.harness)}${owner} · ${formatElapsed(job, this.#now())}`,
      ) + ` · ${this.theme.fg(status.color, job.status)} `;
    return alignDashboardRow(left, right, width);
  }

  /** Job detail plus, in takeover mode, the composer. Always exactly `rows` lines. */
  private renderInspector(job: JobSnapshot | undefined, rows: number, width: number): string[] {
    if (!job) {
      return fit([this.theme.fg("dim", "Select a job to inspect its route, usage, and transcript.")], rows);
    }
    const composer = this.#mode === "takeover" ? this.renderComposer(job, width) : [];
    const bodyRows = Math.max(1, rows - composer.length);
    return [...fit(this.renderDetail(job, bodyRows, width), bodyRows), ...composer].slice(0, rows);
  }

  private renderComposer(job: JobSnapshot, width: number): string[] {
    const policy = takeoverPolicy(job);
    const behavior = this.#behavior ?? policy.behavior;
    const label = policy.reusable
      ? `${behavior === "followUp" ? "follow-up" : "steer"} · Enter sends`
      : "read-only session";
    const rule = this.theme.fg("dim", truncate(`── ${label} ${"─".repeat(Math.max(0, width))}`, width, ""));
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
    const queueNote = job.status === "queued" ? this.queueNote(job) : "";
    const generation = job.generation ? ` · turn ${job.generation + 1}` : "";
    pinned.push(truncate(
      `${this.theme.fg(status.color, `${status.glyph} ${job.status}`)}${this.theme.fg("dim", ` · ${formatElapsed(job, now)}${generation}${queueNote}`)}`,
      width,
    ));
    if (job.error) {
      for (const line of sanitizeText(job.error).split("\n").map(sanitizeInline).filter(Boolean).slice(0, 3)) {
        pinned.push(truncate(this.theme.fg("error", `× ${line}`), width));
      }
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
    const meter = [formatUsage(job.usage), formatContext(job.context), job.backendSessionId ? `session ${shortId(job.backendSessionId)}` : ""]
      .filter(Boolean).join(" · ");
    if (meter) optional.push(truncate(this.theme.fg("dim", `usage ${meter}`), width));
    if (job.workflow) {
      const phase = job.workflow.phase ? ` · ${sanitizeInline(job.workflow.phase)}` : "";
      optional.push(truncate(this.theme.fg("muted", `flow  ${shortId(sanitizeText(job.workflow.runId))} · ${sanitizeInline(job.workflow.label)}${phase}`), width));
    }
    for (const warning of (job.warnings ?? []).slice(-2)) {
      optional.push(truncate(this.theme.fg("warning", `!  ${sanitizeInline(warning)}`), width));
    }
    if (job.truncated) optional.push(truncate(this.theme.fg("warning", "!  bounded output truncated — earliest lines dropped"), width));

    // Tool activity lives in the transcript's Pi-style execution shells. Keeping
    // a second recent-tools list here duplicates the same calls and steals rows
    // from the more legible call/result presentation below.

    // Reserve the transcript label plus one transcript row before spending rows on metadata.
    const budget = Math.max(0, rows - pinned.length - 2);
    const head = [...pinned, ...optional.slice(0, budget)];
    if (rows <= head.length + 1) return head.slice(0, rows);

    const transcript = this.transcript(job, width);
    const transcriptRows = Math.max(0, rows - head.length - 1);
    if (this.#scrollJobId !== job.id) this.resetScroll();
    this.#transcriptRows = transcriptRows;
    this.#transcriptTotal = transcript.length;
    const max = this.maxScroll();
    this.#scroll = this.#followTail ? max : clamp(this.#scroll, 0, max);
    const start = this.#scroll;
    const end = Math.min(transcript.length, start + transcriptRows);
    const range = transcriptRows ? `${start + 1}–${end}` : "0";
    const label = `transcript ${range}/${transcript.length}${this.#followTail ? " · live" : ""}`;
    head.push(this.theme.fg("dim", truncate(`── ${label} ${"─".repeat(Math.max(0, width))}`, width, "")));
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

  private queueNote(_job: JobSnapshot): string {
    const queued = (this.#jobs ?? []).filter((item) => item.status === "queued").length;
    const capacity = this.manager.concurrency ?? 4;
    return ` · waiting for slot · ${queued} queued · ${capacity} slots`;
  }

  /** Wrapping and Markdown are the expensive part; they only rerun when the job or width moves. */
  private transcript(job: JobSnapshot, width: number): string[] {
    const key = `${transcriptSignature(job)}@${width}`;
    if (this.#transcriptCache?.key === key) return this.#transcriptCache.lines;
    const lines = buildTranscript(job, width, this.theme, { renderMarkdown: this.#renderMarkdown });
    this.#transcriptCache = { key, lines };
    return lines;
  }

  private renderHint(frame: DashboardFrame, job: JobSnapshot | undefined): string {
    const back = this.#mode === "takeover" || (this.#layout?.kind === "narrow" && this.#pane === "detail");
    const right = `· Esc ${back ? "back" : "close"}`;
    if (this.#confirmCancelId) {
      const name = sanitizeInline(this.#jobs?.find((item) => item.id === this.#confirmCancelId)?.name ?? "job");
      return frame.hint(`Cancel ${name}? Press x again to confirm`, "· any other key keeps it running");
    }
    if (this.#notice) return frame.hint(`! ${sanitizeInline(this.#notice)}`, right);
    return frame.hint(this.controls(job), right);
  }

  private controls(job: JobSnapshot | undefined): string {
    const scroll = "Shift+↑↓ scroll";
    if (this.#mode === "takeover") {
      const behavior = job ? (this.#behavior ?? takeoverPolicy(job).behavior) : "steer";
      return `Enter ${behavior === "followUp" ? "queue follow-up" : "steer"} · ${scroll}`;
    }
    const live = job && !isTerminal(job.status);
    const sendable = job && takeoverPolicy(job).reusable;
    if (this.#layout?.kind === "narrow" && this.#pane === "list") {
      return `↑↓/jk select · Enter open${live ? " · x cancel" : ""}`;
    }
    return [
      "↑↓/jk select",
      sendable ? "Enter takeover" : "",
      sendable && live ? "s steer" : "",
      sendable && !live ? "f follow-up" : "",
      live ? "x cancel" : "",
      `${scroll} · Ctrl+U/D · g/G`,
    ].filter(Boolean).join(" · ");
  }

  private selectedIndex(jobs: JobSnapshot[]): number {
    const index = jobs.findIndex((job) => job.id === this.#selectedId);
    return index < 0 ? 0 : index;
  }
}

type DashboardFrame = ReturnType<typeof createDashboardFrame>;

interface ListViewport {
  items: JobSnapshot[];
  start: number;
  end: number;
}

function listViewport(jobs: JobSnapshot[], selected: number, rows: number): ListViewport {
  const size = Math.max(0, Math.min(rows, jobs.length));
  const start = clamp(selected - Math.floor(size / 2), 0, Math.max(0, jobs.length - size));
  return { items: jobs.slice(start, start + size), start, end: start + size };
}

/** Opening on a finished job while others are live buries the useful state; prefer live work. */
function defaultJob(jobs: JobSnapshot[]): JobSnapshot {
  const running = jobs.find((job) => job.status === "running");
  if (running) return running;
  const queued = jobs.find((job) => job.status === "queued");
  if (queued) return queued;
  return jobs.reduce((latest, job) =>
    (job.endedAt ?? job.createdAt) >= (latest.endedAt ?? latest.createdAt) ? job : latest);
}

function fit(lines: string[], rows: number): string[] {
  const bounded = lines.slice(0, Math.max(0, rows));
  while (bounded.length < rows) bounded.push("");
  return bounded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export async function openSubagentsDashboard(
  ctx: ExtensionCommandContext,
  manager: SubagentsDashboardManager,
  options: { focusJobId?: string; mode?: DashboardMode } = {},
): Promise<void> {
  if (ctx.mode !== "tui") {
    const jobs = manager.list();
    ctx.ui.notify(jobs.length ? jobs.map(statusLine).join("\n") : "No subagent jobs in this session.", "info");
    return;
  }
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      createDashboardOverlay(tui, theme, keybindings, manager, done, {
        focusJobId: options.focusJobId,
        mode: options.mode,
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

export function renderMarkdown(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return new Markdown(sanitizeText(text), 0, 0, getMarkdownTheme())
    .render(safeWidth)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

export function truncateDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function truncate(value: string, width: number, ellipsis = "…"): string {
  return truncateToWidth(value, Math.max(0, width), ellipsis);
}

function statusLine(job: JobSnapshot): string {
  return `${job.id} ${job.status} ${job.name} [${job.access}${job.independent ? "; independent" : ""}; ${job.harness}/${job.model}; effort ${formatEffort(job.effort)}]`;
}

export { DashboardOverlay };
