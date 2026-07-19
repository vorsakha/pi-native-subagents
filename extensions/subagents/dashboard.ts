import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, type KeybindingsManager, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminal, JobManager } from "../../src/manager.ts";
import { formatEffort, sanitizeInline, sanitizeText, statusMeta } from "./render.ts";
import { openSubagentTakeover } from "./takeover.ts";
import type { JobSnapshot, SendBehavior } from "../../src/types.ts";

type DashboardAction =
  | { type: "steer" | "followUp" | "cancel" | "takeover"; jobId: string }
  | { type: "close" };

type DashboardManager = Pick<JobManager, "list">;

interface DashboardOverlayOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  renderMarkdown?: (text: string, width: number) => string[];
}

export function createDashboardOverlay(
  tui: Pick<TUI, "requestRender" | "terminal">,
  theme: Theme,
  keybindings: KeybindingsManager,
  manager: DashboardManager,
  done: (action: DashboardAction) => void,
  options: DashboardOverlayOptions = {},
) {
  return new DashboardOverlay(tui, theme, keybindings, manager, done, options);
}

class DashboardOverlay {
  focused = false;
  #selected = 0;
  #finished = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #now: () => number;
  #clearInterval: typeof clearInterval;
  #renderMarkdown: (text: string, width: number) => string[];
  /** Scroll offset (in lines) into the selected job's full transcript. */
  #scroll = 0;
  /** Job the current scroll offset applies to; scroll resets when the selection moves to a different job. */
  #scrollJobId: string | undefined;
  /** Visible transcript rows and total transcript lines from the last render, used to size Page Up/Down steps and clamp scroll. */
  #transcriptRows = 0;
  #transcriptTotal = 0;
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly manager: DashboardManager;
  private readonly done: (action: DashboardAction) => void;

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    keybindings: KeybindingsManager,
    manager: DashboardManager,
    done: (action: DashboardAction) => void,
    options: DashboardOverlayOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.manager = manager;
    this.done = done;
    this.#now = options.now ?? Date.now;
    this.#clearInterval = options.clearInterval ?? clearInterval;
    this.#renderMarkdown = options.renderMarkdown ?? renderMarkdown;
    const schedule = options.setInterval ?? setInterval;
    this.#timer = schedule(() => {
      if (!this.#finished) this.tui.requestRender();
    }, 500);
  }

  render(width: number): string[] {
    width = Math.max(0, width);
    const jobs = this.manager.list();
    const maxHeight = Math.max(0, Math.floor(this.tui.terminal.rows * 0.9));
    if (!maxHeight || width < 4) return maxHeight ? [truncate(`Subagents ${jobs.length}`, width)] : [];
    this.#selected = jobs.length ? Math.max(0, Math.min(this.#selected, jobs.length - 1)) : 0;
    const chosen = jobs[this.#selected];
    const borderColor = this.focused ? "borderAccent" : "borderMuted";
    const glyphs = this.focused
      ? { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", horizontal: "═", vertical: "║", separatorLeft: "╠", separatorRight: "╣" }
      : { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│", separatorLeft: "├", separatorRight: "┤" };
    const border = (text: string) => this.theme.fg(borderColor, text);
    const innerWidth = width - 4;
    const pad = (text: string) => text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
    const row = (text: string) => border(`${glyphs.vertical} `) + pad(truncate(text, innerWidth)) + border(` ${glyphs.vertical}`);
    const separator = () => border(glyphs.separatorLeft + glyphs.horizontal.repeat(width - 2) + glyphs.separatorRight);
    const top = () => border(glyphs.topLeft + glyphs.horizontal.repeat(width - 2) + glyphs.topRight);
    const bottom = () => border(glyphs.bottomLeft + glyphs.horizontal.repeat(width - 2) + glyphs.bottomRight);
    if (maxHeight < 9) return this.renderCompact(maxHeight, top, bottom, row);
    const lines = [border(glyphs.topLeft + glyphs.horizontal.repeat(width - 2) + glyphs.topRight)];

    const focus = this.theme.bg("selectedBg", this.theme.bold(this.theme.fg(this.focused ? "accent" : "muted", " DASHBOARD ")));
    const count = this.theme.fg("dim", `${jobs.length} job${jobs.length === 1 ? "" : "s"}`);
    lines.push(row(this.theme.fg("accent", this.theme.bold("Native Subagents")) + " " + focus + " " + count));
    lines.push(row(this.theme.fg("dim", "↑↓/jk select · Shift+↑↓/Pg scroll · s steer · f follow-up · x cancel")));
    lines.push(separator());

    const contentRows = maxHeight - 8;
    const listRows = jobs.length ? Math.min(jobs.length, Math.max(1, Math.floor(contentRows / 2))) : 1;
    const detailRows = contentRows - listRows;
    if (!jobs.length) lines.push(row(this.theme.fg("muted", "No jobs in this session.")));
    else for (const { job, index } of this.listViewport(jobs, listRows)) lines.push(row(this.renderJob(job, index === this.#selected)));

    lines.push(separator());
    for (const detail of this.detailViewport(chosen, detailRows, innerWidth)) lines.push(row(detail));

    lines.push(separator());
    const actionHint = chosen && !isTerminal(chosen.status)
      ? chosen.workflow ? " · x cancel" : " · s steer · f follow-up · x cancel"
      : "";
    lines.push(row(this.theme.fg("dim", `Enter takeover · Esc close${actionHint}`)));
    lines.push(bottom());
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.#finished = true;
    this.stopTimer();
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    const jobs = this.manager.list();
    if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) return this.finish({ type: "close" });
    if (matchesKey(data, Key.shift(Key.up))) this.scrollTranscript(-1);
    else if (matchesKey(data, Key.shift(Key.down))) this.scrollTranscript(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollTranscript(-Math.max(1, this.#transcriptRows - 1));
    else if (matchesKey(data, Key.pageDown)) this.scrollTranscript(Math.max(1, this.#transcriptRows - 1));
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const job = jobs[this.#selected];
      if (job) return this.finish({ type: "takeover", jobId: job.id });
    }
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selectJob(Math.max(0, this.#selected - 1), jobs);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selectJob(Math.min(Math.max(0, jobs.length - 1), this.#selected + 1), jobs);
    else {
      const job = jobs[this.#selected];
      if (job && !job.workflow && !isTerminal(job.status) && matchesKey(data, "s")) return this.finish({ type: "steer", jobId: job.id });
      if (job && !job.workflow && !isTerminal(job.status) && matchesKey(data, "f")) return this.finish({ type: "followUp", jobId: job.id });
      if (job && !isTerminal(job.status) && matchesKey(data, "x")) return this.finish({ type: "cancel", jobId: job.id });
    }
    this.tui.requestRender();
  }

  private finish(action: DashboardAction): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stopTimer();
    this.done(action);
  }

  private stopTimer(): void {
    if (this.#timer) {
      this.#clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  private renderJob(job: JobSnapshot, selected: boolean): string {
    const status = statusMeta(job.status, this.#now());
    const marker = selected ? this.theme.fg("accent", "›") : " ";
    const owner = job.workflow ? ` · wf:${sanitizeInline(job.workflow.label)}` : "";
    const profile = job.profile ? ` · profile ${sanitizeInline(job.profile)}` : "";
    const independent = job.independent ? " · independent" : "";
    const label = `${status.glyph} ${job.status.padEnd(9)} ${shortId(sanitizeText(job.id))} ${sanitizeInline(job.name)} · ${job.access}${profile}${independent} · effort ${formatEffort(job.effort)} · ${sanitizeInline(job.backend)}/${sanitizeInline(job.model)}${owner} · ${formatElapsed(job, this.#now())}`;
    return marker + " " + this.theme.fg(status.color, label);
  }

  private renderCompact(maxHeight: number, top: () => string, bottom: () => string, row: (text: string) => string): string[] {
    if (maxHeight === 1) return [truncate("Subagents", visibleWidth(top()))];
    if (maxHeight === 2) return [top(), bottom()];
    if (maxHeight === 3) return [top(), row(this.theme.fg("accent", "Native Subagents")), bottom()];
    return [top(), row(this.theme.fg("accent", "Native Subagents")), row(this.theme.fg("dim", "Esc close")), bottom()];
  }

  private listViewport(jobs: JobSnapshot[], rows: number): Array<{ job: JobSnapshot; index: number }> {
    const start = Math.max(0, Math.min(this.#selected - Math.floor(rows / 2), jobs.length - rows));
    return jobs.slice(start, start + rows).map((job, offset) => ({ job, index: start + offset }));
  }

  private detailViewport(chosen: JobSnapshot | undefined, rows: number, width: number): string[] {
    if (!chosen) return [this.theme.fg("dim", "Select a job to view its detail.")].slice(0, rows);
    if (this.#scrollJobId !== chosen.id) {
      this.#scrollJobId = chosen.id;
      this.#scroll = 0;
    }
    const status = statusMeta(chosen.status, this.#now());
    const lines = [
      this.theme.fg("accent", this.theme.bold(`${sanitizeInline(chosen.name)} · ${shortId(sanitizeText(chosen.id))}`)) + this.theme.fg("dim", ` · ${chosen.access}${chosen.profile ? ` · profile ${sanitizeInline(chosen.profile)}` : ""}${chosen.independent ? " · independent" : ""} · effort ${formatEffort(chosen.effort)} · ${sanitizeInline(chosen.backend)}/${sanitizeInline(chosen.model)}`),
      this.theme.fg(status.color, `${status.glyph} ${chosen.status}`) + this.theme.fg("dim", ` · ${formatElapsed(chosen, this.#now())}`),
      this.theme.fg("dim", sanitizeInline(chosen.task) || "(no task description)"),
    ];
    if (chosen.workflow) {
      const phase = chosen.workflow.phase ? ` · ${sanitizeInline(chosen.workflow.phase)}` : "";
      lines.push(this.theme.fg("muted", `Workflow ${shortId(chosen.workflow.runId)} · ${sanitizeInline(chosen.workflow.label)}${phase}`));
    }
    // Always reserve a label and at least one transcript row, so every bounded output is reachable.
    if (chosen.error && lines.length < rows - 2) lines.push(this.theme.fg("error", sanitizeInline(chosen.error)));
    const toolRows = Math.max(0, Math.min(2, rows - lines.length - 2));
    for (const tool of chosen.tools.slice(-toolRows)) {
      const glyph = tool.status === "running" ? "…" : tool.status === "failed" ? "×" : "✓";
      lines.push(this.theme.fg("muted", `${glyph} ${sanitizeInline(tool.name)}${tool.summary ? `: ${sanitizeInline(tool.summary)}` : ""}`));
    }

    const transcript = chosen.output
      ? this.#renderMarkdown(chosen.output, Math.max(1, width)).map((line) => truncate(line, width, ""))
      : [this.theme.fg("dim", "(no assistant text yet)")];
    const transcriptRows = Math.max(0, rows - lines.length - 1);
    this.#transcriptRows = transcriptRows;
    this.#transcriptTotal = transcript.length;
    const maxScroll = Math.max(0, transcript.length - transcriptRows);
    this.#scroll = Math.max(0, Math.min(this.#scroll, maxScroll));
    const start = this.#scroll;
    const end = Math.min(transcript.length, start + transcriptRows);
    lines.push(this.theme.fg("dim", `Transcript ${transcriptRows ? `${start + 1}–${end}` : "0"}/${transcript.length} · Shift+↑↓/PgUp/PgDn`));
    lines.push(...transcript.slice(start, end));
    return lines.slice(0, rows);
  }

  private selectJob(index: number, jobs: JobSnapshot[]): void {
    if (index === this.#selected) return;
    this.#selected = index;
    this.#scroll = 0;
    this.#scrollJobId = jobs[index]?.id;
  }

  private scrollTranscript(delta: number): void {
    const maxScroll = Math.max(0, this.#transcriptTotal - this.#transcriptRows);
    this.#scroll = Math.max(0, Math.min(this.#scroll + delta, maxScroll));
  }

}

export async function openSubagentsDashboard(ctx: ExtensionCommandContext, manager: JobManager): Promise<void> {
  if (ctx.mode !== "tui") {
    const jobs = manager.list();
    ctx.ui.notify(jobs.length ? jobs.map(statusLine).join("\n") : "No subagent jobs in this session.", "info");
    return;
  }

  for (;;) {
    const action = await ctx.ui.custom<DashboardAction>((tui, theme, keybindings, done) => createDashboardOverlay(tui, theme, keybindings, manager, done), {
      overlay: true,
      overlayOptions: { width: "90%", minWidth: 60, maxHeight: "90%", anchor: "center", margin: 1 },
    });
    if (!action || action.type === "close") return;
    if (action.type === "cancel") {
      await manager.cancel(action.jobId, "Cancelled from /subagents dashboard");
      continue;
    }
    if (action.type === "takeover") {
      await openSubagentTakeover(ctx, manager, action.jobId);
      continue;
    }
    const behavior: SendBehavior = action.type;
    const message = await ctx.ui.editor(`${action.type === "steer" ? "Steer" : "Queue follow-up for"} ${shortId(action.jobId)}`, "");
    if (message?.trim()) {
      try { await manager.send(action.jobId, message, behavior); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  }
}

function shortId(id: string): string { return id.slice(0, 8); }
function formatElapsed(job: JobSnapshot, now: number): string {
  const elapsed = Math.max(0, (job.endedAt ?? now) - (job.startedAt ?? job.createdAt));
  const seconds = Math.floor(elapsed / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
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
function statusLine(job: JobSnapshot): string { return `${job.id} ${job.status} ${job.name} [${job.access}${job.independent ? "; independent" : ""}; ${job.backend}/${job.model}; effort ${formatEffort(job.effort)}]`; }
