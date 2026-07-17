import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { aggregateWorkflowUsage, workflowIsTerminal } from "../../src/workflows/manager.ts";
import type {
  WorkflowAgentRecord,
  WorkflowAgentState,
  WorkflowPhase,
  WorkflowSnapshot,
  WorkflowStatus,
} from "../../src/workflows/types.ts";
import { formatUsage, sanitizeInline, sanitizeText, shortId } from "../subagents/render.ts";

const MAX_RESULT_CHARS = 16_384;
const MAX_RESULT_ROWS = 400;

export type WorkflowsDashboardAction =
  | { type: "cancel"; runId: string }
  | { type: "close" };

export interface WorkflowsDashboardManager {
  list(): WorkflowSnapshot[];
  check(runId: string): WorkflowSnapshot;
  cancel(runId: string, reason?: string): Promise<WorkflowSnapshot>;
  subscribe(listener: (snapshot: WorkflowSnapshot) => void): () => void;
}

export interface WorkflowsDashboardOverlayOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  renderMarkdown?: (text: string, width: number) => string[];
}

type StatusColor = "accent" | "success" | "warning" | "error" | "muted";

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

export class WorkflowsDashboardOverlay {
  focused = false;
  #selectedRun = 0;
  #selectedPhase = 0;
  #selectedAgent = 0;
  #selectionRunId: string | undefined;
  #scroll = 0;
  #scrollKey: string | undefined;
  #resultRows = 0;
  #resultTotal = 0;
  #finished = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #now: () => number;
  readonly #clearInterval: typeof clearInterval;
  readonly #renderMarkdown: (text: string, width: number) => string[];
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
    this.#clearInterval = options.clearInterval ?? clearInterval;
    this.#renderMarkdown = options.renderMarkdown ?? renderWorkflowMarkdown;
    const schedule = options.setInterval ?? setInterval;
    this.#timer = schedule(() => {
      if (!this.#finished) this.tui.requestRender();
    }, 500);
    this.#unsubscribe = manager.subscribe(() => {
      if (!this.#finished) this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    width = Math.max(0, width);
    const runs = this.manager.list();
    const terminalRows = Math.max(0, this.tui.terminal?.rows ?? 24);
    const maxHeight = Math.max(0, Math.floor(terminalRows * 0.9));
    if (!maxHeight) return [];
    if (width < 4) return [truncateWorkflowDashboardLine(`Workflows ${runs.length}`, width)];

    this.#selectedRun = runs.length ? clamp(this.#selectedRun, 0, runs.length - 1) : 0;
    let chosen = runs[this.#selectedRun];
    if (chosen) {
      try { chosen = this.manager.check(chosen.runId); }
      catch { /* list snapshot is still useful if a run was evicted between calls */ }
    }
    this.syncSelections(chosen);

    const borderColor = this.focused ? "borderAccent" : "borderMuted";
    const glyphs = this.focused
      ? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", sl: "╠", sr: "╣" }
      : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", sl: "├", sr: "┤" };
    const border = (text: string) => this.theme.fg(borderColor, text);
    const innerWidth = Math.max(0, width - 4);
    const pad = (text: string) => text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
    const row = (text: string) => border(`${glyphs.v} `) + pad(truncateWorkflowDashboardLine(text, innerWidth)) + border(` ${glyphs.v}`);
    const top = () => border(glyphs.tl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.tr);
    const bottom = () => border(glyphs.bl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.br);
    const separator = () => border(glyphs.sl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.sr);

    if (maxHeight < 10) return this.renderCompact(maxHeight, runs.length, top, bottom, row);

    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    const focus = this.theme.bg("selectedBg", this.theme.bold(this.theme.fg(this.focused ? "accent" : "muted", " RUNS ")));
    const lines = [
      top(),
      row(`${this.theme.fg("accent", this.theme.bold("Workflow Runs"))} ${focus} ${this.theme.fg("dim", `${runs.length} total · ${active} active`)}`),
      row(this.theme.fg("dim", "↑↓/jk run · ←→/hl phase · Tab agent · Shift+↑↓/Pg scroll")),
      separator(),
    ];

    const contentRows = Math.max(2, maxHeight - 8);
    const listRows = runs.length ? Math.min(runs.length, Math.max(1, Math.floor(contentRows / 3))) : 1;
    const detailRows = Math.max(1, contentRows - listRows);
    if (!runs.length) lines.push(row(this.theme.fg("muted", "No workflow runs in this session.")));
    else {
      for (const { run, index } of this.listViewport(runs, listRows)) {
        lines.push(row(this.renderRun(run, index === this.#selectedRun)));
      }
    }
    lines.push(separator());
    for (const detail of this.detailViewport(chosen, detailRows, innerWidth)) lines.push(row(detail));
    lines.push(separator());
    const action = chosen && !workflowIsTerminal(chosen.status) ? " · x cancel run" : "";
    lines.push(row(this.theme.fg("dim", `Esc close${action}`)));
    lines.push(bottom());
    return lines.slice(0, maxHeight);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    const runs = this.manager.list();
    if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ type: "close" });
      return;
    }

    if (matchesKey(data, Key.shift(Key.up))) this.scrollResult(-1);
    else if (matchesKey(data, Key.shift(Key.down))) this.scrollResult(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollResult(-Math.max(1, this.#resultRows - 1));
    else if (matchesKey(data, Key.pageDown)) this.scrollResult(Math.max(1, this.#resultRows - 1));
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selectRun(this.#selectedRun - 1, runs);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selectRun(this.#selectedRun + 1, runs);
    else if (matchesKey(data, Key.left) || matchesKey(data, "h")) this.selectPhase(-1, runs[this.#selectedRun]);
    else if (matchesKey(data, Key.right) || matchesKey(data, "l")) this.selectPhase(1, runs[this.#selectedRun]);
    else if (data === "\t") this.selectAgent(runs[this.#selectedRun]);
    else if (matchesKey(data, "x")) {
      const run = runs[this.#selectedRun];
      if (run && !workflowIsTerminal(run.status)) {
        this.finish({ type: "cancel", runId: run.runId });
        return;
      }
    }
    this.tui.requestRender();
  }

  private finish(action: WorkflowsDashboardAction): void {
    if (this.#finished) return;
    this.#finished = true;
    this.cleanup();
    this.done(action);
  }

  private cleanup(): void {
    if (this.#timer !== undefined) {
      this.#clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
    }
  }

  private syncSelections(run: WorkflowSnapshot | undefined): void {
    if (!run) {
      this.#selectionRunId = undefined;
      this.#selectedPhase = 0;
      this.#selectedAgent = 0;
      this.resetScroll();
      return;
    }
    if (this.#selectionRunId !== run.runId) {
      this.#selectionRunId = run.runId;
      const current = run.phases.findIndex((phase) => phase.index === run.currentPhase);
      this.#selectedPhase = current >= 0 ? current : Math.max(0, run.phases.length - 1);
      this.#selectedAgent = 0;
      this.resetScroll();
    }
    this.#selectedPhase = run.phases.length ? clamp(this.#selectedPhase, 0, run.phases.length - 1) : 0;
    const agents = this.phaseAgents(run, run.phases[this.#selectedPhase]);
    this.#selectedAgent = agents.length ? clamp(this.#selectedAgent, 0, agents.length - 1) : 0;
  }

  private renderCompact(
    maxHeight: number,
    count: number,
    top: () => string,
    bottom: () => string,
    row: (text: string) => string,
  ): string[] {
    if (maxHeight === 1) return [truncateWorkflowDashboardLine("Workflows", visibleWidth(top()))];
    if (maxHeight === 2) return [top(), bottom()];
    if (maxHeight === 3) return [top(), row(this.theme.fg("accent", "Workflow Runs")), bottom()];
    const middle = [
      row(`${this.theme.fg("accent", "Workflow Runs")} ${this.theme.fg("dim", `· ${count}`)}`),
      row(this.theme.fg("dim", "Esc close")),
    ];
    return [top(), ...middle.slice(0, Math.max(0, maxHeight - 2)), bottom()];
  }

  private listViewport(runs: WorkflowSnapshot[], rows: number): Array<{ run: WorkflowSnapshot; index: number }> {
    const start = Math.max(0, Math.min(this.#selectedRun - Math.floor(rows / 2), runs.length - rows));
    return runs.slice(start, start + rows).map((run, offset) => ({ run, index: start + offset }));
  }

  private renderRun(run: WorkflowSnapshot, selected: boolean): string {
    const status = statusMeta(run.status);
    const marker = selected ? this.theme.fg("accent", "›") : " ";
    const phase = run.currentPhase === null ? "waiting" : `${Math.min(run.phases.length, run.currentPhase + 1)}/${run.phases.length}`;
    const label = `${status.glyph} ${run.status.padEnd(9)} ${shortId(sanitizeText(run.runId))} ${sanitizeInline(run.name)} · phase ${phase} · ${formatElapsed(run, this.#now())}`;
    return `${marker} ${this.theme.fg(status.color, label)}`;
  }

  private detailViewport(run: WorkflowSnapshot | undefined, rows: number, width: number): string[] {
    if (!run) {
      this.#resultRows = 0;
      this.#resultTotal = 0;
      return [this.theme.fg("dim", "Start a workflow to inspect phases, agents, and results.")].slice(0, rows);
    }

    const phase = run.phases[this.#selectedPhase];
    const agents = this.phaseAgents(run, phase);
    const agent = agents[this.#selectedAgent];
    const status = statusMeta(run.status);
    const usage = formatUsage(aggregateWorkflowUsage(run));
    const lines: string[] = [
      `${this.theme.fg("accent", this.theme.bold(sanitizeInline(run.name) || "Workflow"))} ${this.theme.fg("dim", `· ${shortId(sanitizeText(run.runId))} · ${status.glyph} ${run.status} · ${formatElapsed(run, this.#now())}`)}`,
    ];
    if (rows >= 3) lines.push(this.theme.fg("dim", sanitizeInline(run.description) || "(no workflow description)"));
    if (phase && rows >= 4) lines.push(this.renderPhase(phase, run.phases.length));
    else if (rows >= 4) lines.push(this.theme.fg("dim", "Phase · waiting for the first phase"));
    if (agent && rows >= 5) lines.push(this.renderAgent(agent, agents.length));
    else if (rows >= 5) lines.push(this.theme.fg("dim", "Agent · none in this phase"));
    if (usage && rows >= 7) {
      const budget = run.budget;
      const limits = budget ? [budget.maxInputTokens && `↑≤${budget.maxInputTokens}`, budget.maxOutputTokens && `↓≤${budget.maxOutputTokens}`, budget.maxTurns && `${budget.maxTurns}t`, budget.maxCost !== undefined && `$${budget.maxCost.toFixed(2)}`].filter(Boolean).join("/") : "";
      lines.push(this.theme.fg("dim", `Usage · ${usage}${limits ? ` · budget ${limits}` : ""}`));
    }

    const error = sanitizeInline(agent?.error ?? phase?.error ?? run.error ?? "");
    if (error && lines.length < rows - 2) lines.push(this.theme.fg("error", error));

    const wrapped = this.renderBoundedResult(run, phase, agent, width);
    const resultRows = Math.max(0, rows - lines.length - 1);
    this.#resultRows = resultRows;
    this.#resultTotal = wrapped.length;
    const key = `${run.runId}:${phase?.index ?? "workflow"}:${agent?.index ?? "result"}`;
    if (key !== this.#scrollKey) {
      this.#scrollKey = key;
      this.#scroll = 0;
    }
    this.#scroll = clamp(this.#scroll, 0, Math.max(0, wrapped.length - resultRows));
    const start = this.#scroll;
    const end = Math.min(wrapped.length, start + resultRows);
    lines.push(this.theme.fg("dim", `Result ${resultRows ? `${start + 1}–${end}` : "0"}/${wrapped.length} · Shift+↑↓/PgUp/PgDn`));
    lines.push(...wrapped.slice(start, end));
    return lines.slice(0, rows);
  }

  private renderPhase(phase: WorkflowPhase, total: number): string {
    const status = statusMeta(phase.status);
    return `${this.theme.fg("accent", `Phase ${this.#selectedPhase + 1}/${total}`)} ${this.theme.fg(status.color, `${status.glyph} ${sanitizeInline(phase.name)}`)} ${this.theme.fg("dim", `· ${phase.status} · ←→`)}`;
  }

  private renderAgent(agent: WorkflowAgentRecord, total: number): string {
    const status = statusMeta(agent.state);
    const route = agent.backend || agent.model
      ? ` · ${sanitizeInline(agent.backend ?? "backend")}/${sanitizeInline(agent.model ?? "model")}`
      : "";
    return `${this.theme.fg("accent", `Agent ${this.#selectedAgent + 1}/${total}`)} ${this.theme.fg(status.color, `${status.glyph} ${sanitizeInline(agent.label || agent.role)}`)} ${this.theme.fg("dim", `· ${sanitizeInline(agent.role)} · ${agent.state}${route} · Tab`)}`;
  }

  private phaseAgents(run: WorkflowSnapshot, phase: WorkflowPhase | undefined): WorkflowAgentRecord[] {
    if (!phase) return [];
    const indices = new Set(phase.agents);
    return run.agents.filter((agent) => indices.has(agent.index) || agent.phase === phase.index);
  }

  private renderBoundedResult(
    run: WorkflowSnapshot,
    phase: WorkflowPhase | undefined,
    agent: WorkflowAgentRecord | undefined,
    width: number,
  ): string[] {
    const safeWidth = Math.max(1, width);
    const transcript = agent?.transcript?.length ? agent.transcript : undefined;
    let rows: string[] = [];
    let remaining = MAX_RESULT_CHARS;
    let truncated = false;

    if (transcript) {
      for (const entry of transcript) {
        if (remaining <= 0) { truncated = true; break; }
        const raw = entry.kind === "tool"
          ? `${entry.name}${entry.text ? ` · ${entry.text}` : ""}`
          : entry.text;
        const clean = sanitizeText(raw);
        const text = clean.slice(0, remaining);
        remaining -= text.length;
        if (text.length < clean.length) truncated = true;
        if (!text.trim()) continue;

        if (entry.kind === "assistant") {
          rows.push(...this.#renderMarkdown(text, safeWidth));
        } else if (entry.kind === "user") {
          rows.push(...renderPrefixedRows(this.theme, this.theme.fg("accent", "> "), text, "userMessageText", safeWidth));
        } else if (entry.kind === "thinking") {
          rows.push(...renderPrefixedRows(this.theme, this.theme.fg("dim", "~ "), text, "muted", safeWidth));
        } else {
          const prefix = entry.error ? this.theme.fg("error", "× ") : this.theme.fg("muted", "→ ");
          rows.push(...renderPrefixedRows(this.theme, prefix, text, entry.error ? "error" : "muted", safeWidth));
        }
      }
    } else {
      const value = [agent?.output, agent?.preview, phase?.result, run.result]
        .find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
      if (value === undefined) {
        rows = [this.theme.fg("dim", run.status === "running" || run.status === "pending" ? "(no result yet)" : "(no result)")];
      } else {
        const structured = typeof value !== "string";
        const raw = serializeResult(value);
        truncated = raw.length > MAX_RESULT_CHARS;
        const text = sanitizeText(raw.slice(0, MAX_RESULT_CHARS));
        rows = this.#renderMarkdown(structured ? `\`\`\`json\n${text}\n\`\`\`` : text, safeWidth);
      }
    }

    if (truncated) rows.push(this.theme.fg("muted", "… result truncated to 16 KiB"));
    if (rows.length > MAX_RESULT_ROWS) {
      const omitted = rows.length - MAX_RESULT_ROWS + 1;
      rows = [...rows.slice(0, MAX_RESULT_ROWS - 1), this.theme.fg("muted", `… ${omitted} rendered rows omitted`)];
    }
    return rows.length ? rows : [" "];
  }

  private selectRun(index: number, runs: WorkflowSnapshot[]): void {
    const next = runs.length ? clamp(index, 0, runs.length - 1) : 0;
    if (next === this.#selectedRun) return;
    this.#selectedRun = next;
    this.#selectionRunId = undefined;
    this.resetScroll();
  }

  private selectPhase(delta: number, run: WorkflowSnapshot | undefined): void {
    if (!run?.phases.length) return;
    this.#selectedPhase = clamp(this.#selectedPhase + delta, 0, run.phases.length - 1);
    this.#selectedAgent = 0;
    this.resetScroll();
  }

  private selectAgent(run: WorkflowSnapshot | undefined): void {
    if (!run) return;
    const agents = this.phaseAgents(run, run.phases[this.#selectedPhase]);
    if (!agents.length) return;
    this.#selectedAgent = (this.#selectedAgent + 1) % agents.length;
    this.resetScroll();
  }

  private scrollResult(delta: number): void {
    this.#scroll = clamp(this.#scroll + delta, 0, Math.max(0, this.#resultTotal - this.#resultRows));
  }

  private resetScroll(): void {
    this.#scroll = 0;
    this.#scrollKey = undefined;
  }
}

function serializeResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? String(nested) : nested, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    try { return String(value); }
    catch { return "[unrenderable result]"; }
  }
}

function renderPrefixedRows(
  theme: Theme,
  prefix: string,
  text: string,
  color: Parameters<Theme["fg"]>[0],
  width: number,
): string[] {
  const prefixWidth = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${theme.fg(color, line)}`);
}

export function renderWorkflowMarkdown(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return new Markdown(sanitizeText(text), 0, 0, getMarkdownTheme())
    .render(safeWidth)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

export async function openWorkflowsDashboard(
  ctx: ExtensionCommandContext,
  manager: WorkflowsDashboardManager,
): Promise<void> {
  if (ctx.mode !== "tui") {
    const runs = manager.list();
    const message = runs.length
      ? runs.map((run) => `${sanitizeInline(run.runId)} ${run.status} ${sanitizeInline(run.name)}`).join("\n")
      : "No workflow runs in this session.";
    ctx.ui.notify(message, "info");
    return;
  }

  for (;;) {
    const action = await ctx.ui.custom<WorkflowsDashboardAction>(
      (tui, theme, keybindings, done) => createWorkflowsDashboardOverlay(tui, theme, keybindings, manager, done),
      { overlay: true, overlayOptions: { width: "90%", minWidth: 60, maxHeight: "90%", anchor: "center", margin: 1 } },
    );
    if (!action || action.type === "close") return;
    try {
      await manager.cancel(action.runId, "Cancelled from /workflows dashboard");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

function statusMeta(status: WorkflowStatus | WorkflowAgentState): { glyph: string; color: StatusColor } {
  switch (status) {
    case "running": return { glyph: "●", color: "accent" };
    case "completed": return { glyph: "✓", color: "success" };
    case "failed": return { glyph: "×", color: "error" };
    case "cancelled":
    case "aborted": return { glyph: "■", color: "warning" };
    default: return { glyph: "○", color: "muted" };
  }
}

function formatElapsed(run: WorkflowSnapshot, now: number): string {
  const elapsed = Math.max(0, (run.timestamps.endedAt ?? now) - (run.timestamps.startedAt ?? run.timestamps.createdAt));
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function truncateWorkflowDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}
