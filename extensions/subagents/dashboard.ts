import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, type KeybindingsManager, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminal, JobManager } from "../../src/manager.ts";
import type { JobSnapshot, SendBehavior } from "../../src/types.ts";

type DashboardAction =
  | { type: "steer" | "followUp" | "cancel"; jobId: string }
  | { type: "close" };

type DashboardManager = Pick<JobManager, "list">;

interface DashboardOverlayOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
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
    lines.push(row(this.theme.fg("dim", "↑↓/j k select · s steer · f follow-up · x cancel")));
    lines.push(separator());

    const contentRows = maxHeight - 8;
    const listRows = jobs.length ? Math.min(jobs.length, Math.max(1, Math.floor(contentRows / 2))) : 1;
    const detailRows = contentRows - listRows;
    if (!jobs.length) lines.push(row(this.theme.fg("muted", "No jobs in this session.")));
    else for (const { job, index } of this.listViewport(jobs, listRows)) lines.push(row(this.renderJob(job, index === this.#selected)));

    lines.push(separator());
    for (const detail of this.detailViewport(chosen, detailRows)) lines.push(row(detail));

    lines.push(separator());
    const actionHint = chosen && !isTerminal(chosen.status) ? " · s steer · f follow-up · x cancel" : "";
    lines.push(row(this.theme.fg("dim", `Esc close${actionHint}`)));
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
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#selected = Math.max(0, this.#selected - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#selected = Math.min(Math.max(0, jobs.length - 1), this.#selected + 1);
    else {
      const job = jobs[this.#selected];
      if (job && !isTerminal(job.status) && matchesKey(data, "s")) return this.finish({ type: "steer", jobId: job.id });
      if (job && !isTerminal(job.status) && matchesKey(data, "f")) return this.finish({ type: "followUp", jobId: job.id });
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
    const status = this.status(job);
    const marker = selected ? this.theme.fg("accent", "›") : " ";
    const label = `${status.glyph} ${job.status.padEnd(9)} ${shortId(clean(job.id))} ${cleanInline(job.role)} · ${cleanInline(job.backend)}/${cleanInline(job.model)} · ${formatElapsed(job, this.#now())}`;
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

  private detailViewport(chosen: JobSnapshot | undefined, rows: number): string[] {
    if (!chosen) return [this.theme.fg("dim", "Select a job to view its detail.")].slice(0, rows);
    const status = this.status(chosen);
    const lines = [
      this.theme.fg("accent", this.theme.bold(`${clean(chosen.role)} · ${shortId(clean(chosen.id))}`)) + this.theme.fg("dim", ` · ${clean(chosen.backend)}/${clean(chosen.model)}`),
      this.theme.fg(status.color, `${status.glyph} ${chosen.status}`) + this.theme.fg("dim", ` · ${formatElapsed(chosen, this.#now())}`),
      this.theme.fg("dim", cleanInline(chosen.task) || "(no task description)"),
    ];
    if (chosen.error && lines.length < rows - 2) lines.push(this.theme.fg("error", cleanInline(chosen.error)));
    const toolRows = Math.max(0, Math.min(2, rows - lines.length - 2));
    const tools = chosen.tools.slice(-toolRows).map((tool) => {
      const glyph = tool.status === "running" ? "…" : tool.status === "failed" ? "×" : "✓";
      return this.theme.fg("muted", `${glyph} ${cleanInline(tool.name)}${tool.summary ? `: ${cleanInline(tool.summary)}` : ""}`);
    });
    const transcript = (chosen.output || "(no assistant text yet)").split("\n").slice(-2).map(clean);
    lines.push(...tools);
    if (rows > lines.length) lines.push(this.theme.fg("dim", `Transcript tail${transcript.length > 1 ? " · …" : ""}`));
    if (rows > lines.length) lines.push(...transcript.slice(-Math.max(1, rows - lines.length)));
    return lines.slice(0, rows);
  }

  private status(job: JobSnapshot): { glyph: string; color: "accent" | "success" | "warning" | "error" | "muted" } {
    switch (job.status) {
      case "running": return { glyph: "●", color: "accent" };
      case "completed": return { glyph: "✓", color: "success" };
      case "failed": return { glyph: "×", color: "error" };
      case "cancelled": return { glyph: "■", color: "warning" };
      default: return { glyph: "○", color: "muted" };
    }
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
    const behavior: SendBehavior = action.type;
    const message = await ctx.ui.editor(`${action.type === "steer" ? "Steer" : "Queue follow-up for"} ${shortId(action.jobId)}`, "");
    if (message?.trim()) {
      try { await manager.send(action.jobId, message, behavior); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  }
}

function shortId(id: string): string { return id.slice(0, 8); }
function clean(value: string): string {
  return value
    .replace(/\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\u001B]*(?:\u001B\\)|.)/g, "")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}
function cleanInline(value: string): string { return clean(value).replace(/\s+/g, " ").trim(); }
function formatElapsed(job: JobSnapshot, now: number): string {
  const elapsed = Math.max(0, (job.endedAt ?? now) - (job.startedAt ?? job.createdAt));
  const seconds = Math.floor(elapsed / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
export function truncateDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}
function truncate(value: string, width: number, ellipsis = "…"): string {
  return truncateToWidth(value, Math.max(0, width), ellipsis);
}
function statusLine(job: JobSnapshot): string { return `${job.id} ${job.status} ${job.role} [${job.backend}/${job.model}]`; }
