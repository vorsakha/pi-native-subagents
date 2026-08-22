import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { isTerminal, type JobManager } from "../../src/manager.ts";
import type { JobSnapshot } from "../../src/types.ts";
import { formatContext, formatEffort, formatUsage, sanitizeInline, shortId, statusMeta } from "./render.ts";
import { openSubagentsDashboard, type SubagentsDashboardManager } from "./dashboard.ts";
import { buildTranscript } from "./transcript.ts";
import { DEFAULT_TOOL_DISPLAY, type ToolDisplayMode } from "../tool-summary.ts";

interface TakeoverManager extends Pick<JobManager, "check" | "send" | "cancel" | "subscribe"> {}

class TakeoverView implements Focusable {
  readonly #tui: Pick<TUI, "requestRender" | "terminal">;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #manager: TakeoverManager;
  readonly #jobId: string;
  readonly #done: (value: null) => void;
  #focused = false;
  #closed = false;
  #scrollFromBottom = 0;
  #viewportRows = 1;
  #transcriptRows = 0;
  #notice = "";
  #toolDisplay: ToolDisplayMode = DEFAULT_TOOL_DISPLAY;
  #renderTimer?: NodeJS.Timeout;
  #ticker: NodeJS.Timeout;
  #unsubscribe: () => void;
  #input = new Input();

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    keybindings: KeybindingsManager,
    manager: TakeoverManager,
    jobId: string,
    done: (value: null) => void,
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#manager = manager;
    this.#jobId = jobId;
    this.#done = done;
    this.#unsubscribe = manager.subscribe((job) => {
      if (job.id !== jobId || this.#closed || this.#renderTimer) return;
      this.#renderTimer = setTimeout(() => {
        this.#renderTimer = undefined;
        if (!this.#closed) this.#tui.requestRender();
      }, 50);
      this.#renderTimer.unref();
    });
    this.#ticker = setInterval(() => this.#tui.requestRender(), 500);
    this.#ticker.unref();
    this.#input.onSubmit = (raw) => {
      const message = raw.trim();
      if (!message) return;
      let job: JobSnapshot;
      try { job = this.#manager.check(this.#jobId); }
      catch { return; }
      if (job.workflow) {
        this.#notice = "Workflow-owned agents are read-only here; inspect or cancel them from /workflows.";
        this.#tui.requestRender();
        return;
      }
      if (job.status === "failed" || job.status === "cancelled") {
        this.#notice = `This native session cannot continue after ${job.status}.`;
        this.#tui.requestRender();
        return;
      }
      this.#input.setValue("");
      this.#scrollFromBottom = 0;
      void this.#manager.send(this.#jobId, message, job.status === "completed" ? "followUp" : "steer").catch((error) => {
        this.#notice = error instanceof Error ? error.message : String(error);
        this.#tui.requestRender();
      });
    };
  }

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    let job: JobSnapshot;
    try { job = this.#manager.check(this.#jobId); }
    catch { return [this.#theme.fg("error", "Subagent is no longer tracked")]; }

    const border = this.#theme.fg(this.focused ? "borderAccent" : "borderMuted", "─".repeat(width));
    const status = statusMeta(job.status, Date.now());
    const usage = formatUsage(job.usage);
    const owner = job.workflow ? ` · workflow ${sanitizeInline(job.workflow.label)}` : "";
    const header = `${this.#theme.fg(status.color, status.glyph)} ${this.#theme.fg("accent", this.#theme.bold(`${sanitizeInline(job.name)} · ${shortId(job.id)}`))}${this.#theme.fg("dim", ` · ${job.status} · ${sanitizeInline(job.harness)}/${sanitizeInline(job.model)}${owner}`)}`;
    const meta = [job.access, job.profile ? `profile ${job.profile}` : "", job.independent ? "independent" : "", `effort ${formatEffort(job.effort)}`, usage, formatContext(job.context), job.backendSessionId ? `session ${shortId(job.backendSessionId)}` : ""].filter(Boolean).join(" · ");
    const transcript = buildTranscript(job, width, this.#theme, { toolDisplay: this.#toolDisplay });
    const terminalRows = Math.max(1, this.#tui.terminal.rows || 24);
    const reusable = !job.workflow && job.status !== "failed" && job.status !== "cancelled";
    const inputRows = reusable ? Math.max(1, this.#input.render(width).length) : 1;
    // Keep every emitted line inside the host overlay's maxHeight. The old
    // `Math.max(4, ...)` viewport floor produced terminalRows + 1 lines and
    // clipped the bottom border in fullscreen mode.
    this.#viewportRows = Math.max(0, terminalRows - 7 - inputRows);
    this.#transcriptRows = transcript.length;
    const maxOffset = Math.max(0, transcript.length - this.#viewportRows);
    this.#scrollFromBottom = Math.min(this.#scrollFromBottom, maxOffset);
    const end = transcript.length - this.#scrollFromBottom;
    const visible = transcript.slice(Math.max(0, end - this.#viewportRows), end);
    const body = [...visible];
    while (body.length < this.#viewportRows) body.unshift("");

    const lines = [
      border,
      truncateToWidth(header, width, "…"),
      truncateToWidth(this.#theme.fg("dim", `${meta || "live transcript"}${this.#scrollFromBottom ? ` · ${this.#scrollFromBottom} lines below` : ""}`), width, "…"),
      border,
      ...body.map((line) => truncateToWidth(line, width, "…")),
      border,
    ];
    if (!reusable) lines.push(this.#theme.fg("dim", job.workflow
      ? "Workflow-owned agent — read-only transcript; use /workflows for supervision"
      : "Session unavailable — read-only transcript"));
    else lines.push(...this.#input.render(width));
    if (this.#notice) lines.push(truncateToWidth(this.#theme.fg("warning", this.#notice), width, "…"));
    else lines.push(truncateToWidth(this.#theme.fg("dim", `${job.status === "completed" ? "Enter follow-up" : "Enter steer"} · Ctrl+T ${this.#toolDisplay === "compact" ? "full" : "compact"} · Shift+↑↓/Pg scroll · Esc close`), width, "…"));
    lines.push(border);
    return lines.slice(0, terminalRows);
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, Key.escape) || this.#keybindings.matches(data, "tui.select.cancel") || this.#keybindings.matches(data, "app.interrupt")) {
      this.close();
      return;
    }
    if (this.#keybindings.matches(data, "app.clear")) {
      const job = this.#manager.check(this.#jobId);
      if (!isTerminal(job.status)) void this.#manager.cancel(this.#jobId, "Cancelled from takeover");
      return;
    }
    if (matchesKey(data, Key.shift(Key.up))) this.scroll(4);
    else if (matchesKey(data, Key.shift(Key.down))) this.scroll(-4);
    else if (matchesKey(data, Key.pageUp)) this.scroll(this.#viewportRows - 1);
    else if (matchesKey(data, Key.pageDown)) this.scroll(-(this.#viewportRows - 1));
    else if (matchesKey(data, Key.ctrl("t"))) {
      this.#toolDisplay = this.#toolDisplay === "compact" ? "full" : "compact";
    }
    else if (this.#keybindings.matches(data, "tui.input.submit") || matchesKey(data, Key.enter)) this.#input.onSubmit?.(this.#input.getValue());
    else {
      const job = this.#manager.check(this.#jobId);
      if (!job.workflow && job.status !== "failed" && job.status !== "cancelled") this.#input.handleInput(data);
    }
    this.#tui.requestRender();
  }

  invalidate(): void { this.#input.invalidate(); }
  dispose(): void { this.cleanup(); }

  private scroll(delta: number): void {
    this.#scrollFromBottom = Math.max(0, Math.min(Math.max(0, this.#transcriptRows - this.#viewportRows), this.#scrollFromBottom + delta));
  }

  private close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cleanup();
    this.#done(null);
  }

  private cleanup(): void {
    clearInterval(this.#ticker);
    this.#unsubscribe();
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    this.#renderTimer = undefined;
  }
}

export async function openSubagentTakeover(
  ctx: ExtensionCommandContext,
  manager: TakeoverManager & { list?: SubagentsDashboardManager["list"]; concurrency?: number },
  jobId: string,
): Promise<void> {
  // Preserve the historical non-TUI no-op and structural manager contract for
  // deep-import callers. Real JobManager instances take the new stateful route;
  // narrow test/host doubles retain the legacy view as a compatibility fallback.
  if (ctx.mode !== "tui") return;
  if (typeof manager.list === "function") {
    await openSubagentsDashboard(ctx, manager as SubagentsDashboardManager, { focusJobId: jobId, mode: "takeover" });
    return;
  }
  await ctx.ui.custom<null>((tui, theme, keybindings, done) => new TakeoverView(tui, theme, keybindings, manager, jobId, done), {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
  });
}

export { TakeoverView, buildTranscript };
