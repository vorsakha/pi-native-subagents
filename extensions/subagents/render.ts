import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isTerminal } from "../../src/manager.ts";
import type { JobSnapshot, JobStatus, SendBehavior, ToolTrace, Usage } from "../../src/types.ts";

/** Hard rendered-line budgets so no tool call/result can spam the transcript. */
export const MAX_COLLAPSED_LINES = 10;
export const MAX_EXPANDED_LINES = 36;

const MAX_TOOLS_COLLAPSED = 1;
const MAX_TOOLS_EXPANDED = 8;
const MAX_TAIL_COLLAPSED = 3;
const MAX_TAIL_EXPANDED = 16;
const MAX_LIST_JOBS_COLLAPSED = 8;
const MAX_LIST_JOBS_EXPANDED = 20;
export const DASHBOARD_POINTER = "/subagents";

/** A fixed set of pre-rendered lines. Truncates (never wraps) so line counts stay exact regardless of width. */
class Lines implements Component {
  private readonly lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    return this.lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
  invalidate(): void {}
}

export function linesComponent(lines: string[]): Component {
  return new Lines(lines.length ? lines : [""]);
}

const ESCAPE_SEQUENCE =
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\u001B]*(?:\u001B\\)|.)/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function sanitizeText(value: string): string {
  return value
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\t/g, "    ")
    .replace(CONTROL_CHARS, "");
}

export function sanitizeInline(value: string): string {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatElapsed(job: Pick<JobSnapshot, "createdAt" | "startedAt" | "endedAt">, now: number): string {
  const elapsed = Math.max(0, (job.endedAt ?? now) - (job.startedAt ?? job.createdAt));
  const seconds = Math.floor(elapsed / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: Usage): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns}t`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

type StatusColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const ACTIVE_PULSE_FRAME_MS = 200;
const ACTIVE_PULSE_FRAMES: ReadonlyArray<{ glyph: string; color: StatusColor }> = [
  { glyph: " ", color: "dim" },
  { glyph: "·", color: "dim" },
  { glyph: "•", color: "muted" },
  { glyph: "●", color: "accent" },
  { glyph: "●", color: "accent" },
  { glyph: "•", color: "muted" },
  { glyph: "·", color: "dim" },
  { glyph: " ", color: "dim" },
];

/** Frame-driven fade for active jobs. Uses width-stable glyph/color steps instead of unreliable ANSI blink. */
export function statusMeta(status: JobStatus, now?: number): { glyph: string; color: StatusColor } {
  switch (status) {
    case "running": return now === undefined
      ? { glyph: "●", color: "accent" }
      : ACTIVE_PULSE_FRAMES[Math.floor(now / ACTIVE_PULSE_FRAME_MS) % ACTIVE_PULSE_FRAMES.length]!;
    case "completed": return { glyph: "✓", color: "success" };
    case "failed": return { glyph: "×", color: "error" };
    case "cancelled": return { glyph: "■", color: "warning" };
    default: return { glyph: "○", color: "muted" };
  }
}

function toolLine(theme: Theme, tool: ToolTrace, indent = ""): string {
  const glyph = tool.status === "running" ? "…" : tool.status === "failed" ? "×" : "✓";
  const summary = tool.summary ? `: ${sanitizeInline(tool.summary)}` : "";
  return theme.fg("muted", `${indent}${glyph} ${sanitizeInline(tool.name)}${summary}`);
}

function sectionLine(theme: Theme, label: string, value: string, color: "text" | "toolOutput" | "dim" | "muted" | "error" = "dim"): string {
  return theme.fg("muted", `${label.padEnd(9)} `) + theme.fg(color, value);
}

/**
 * Clamp a candidate line list to a hard budget, leaving room for a hidden-count note when
 * trimmed. The note only reports how much was cut — the footer is the single `/subagents`
 * affordance, so the note never repeats it.
 */
function clampLines(theme: Theme, lines: string[], budget: number, omittedNote?: string): string[] {
  if (lines.length <= budget) return lines;
  const kept = lines.slice(0, Math.max(0, budget - 1));
  const hidden = lines.length - kept.length;
  const note = omittedNote ?? `… ${hidden} more line${hidden === 1 ? "" : "s"} hidden`;
  kept.push(theme.fg("dim", note));
  return kept;
}

/** Show the tail of a streaming/partial preview — the most recent activity is what's live. */
function tailPreview(lines: string[], budget: number): { shown: string[]; omitted: number } {
  const shown = lines.slice(-budget);
  return { shown, omitted: lines.length - shown.length };
}

/**
 * Show a settled preview that prioritizes the conclusion: the run's beginning for orientation
 * and its end for the actual outcome, with a single omission separator between them when the
 * full output doesn't fit the budget. At very small budgets, only the head is shown.
 */
function headTailPreview(lines: string[], budget: number): { shown: string[]; omitted: number } {
  if (lines.length <= budget) return { shown: lines, omitted: 0 };
  if (budget <= 1) return { shown: lines.slice(0, budget), omitted: lines.length - budget };
  const headCount = Math.max(1, Math.ceil((budget - 1) / 2));
  const tailCount = Math.max(0, budget - 1 - headCount);
  const head = lines.slice(0, headCount);
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
  const omitted = lines.length - head.length - tail.length;
  const separator = `⋯ ${omitted} line${omitted === 1 ? "" : "s"} omitted ⋯`;
  return { shown: [...head, separator, ...tail], omitted: 0 };
}

export interface JobCardOptions {
  expanded: boolean;
  now: number;
  /** Extra line rendered above the job header, e.g. a send/cancel confirmation. */
  lead?: string;
  /** Whether this render is a streaming update rather than the settled tool result. */
  isPartial?: boolean;
  /** Configured expand-key hint text (e.g. from Pi's `keyHint("app.tools.expand", ...)`), supplied by the live renderer. */
  expandHint?: string;
}

export function buildJobCardLines(job: JobSnapshot, theme: Theme, options: JobCardOptions): string[] {
  const { expanded, now } = options;
  const budget = expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES;
  const status = statusMeta(job.status, now);
  const lines: string[] = [];

  if (options.lead) lines.push(options.lead);

  const header = `${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", theme.bold(sanitizeInline(job.role)))} ${theme.fg("dim", shortId(sanitizeText(job.id)))} ${theme.fg("dim", `· ${sanitizeInline(job.backend)}/${sanitizeInline(job.model)} · ${job.status} · ${formatElapsed(job, now)}`)}`;
  lines.push(header);

  const task = sanitizeInline(job.task);
  if (task) lines.push(sectionLine(theme, "Task", task));
  if (job.workflow) {
    const phase = job.workflow.phase ? ` · ${sanitizeInline(job.workflow.phase)}` : "";
    lines.push(sectionLine(theme, "Workflow", `${shortId(sanitizeText(job.workflow.runId))} · ${sanitizeInline(job.workflow.label)}${phase}`, "muted"));
  }

  if (job.error) {
    const errorLines = sanitizeText(job.error).split("\n").map(sanitizeInline).filter(Boolean);
    const maxErrorLines = expanded ? 3 : 1;
    for (const [index, line] of errorLines.slice(0, maxErrorLines).entries()) {
      lines.push(sectionLine(theme, index ? "" : "Error", line, "error"));
    }
  }

  // Outcome precedes implementation noise: the conclusion is what users need from a thread card.
  if (job.output) {
    const outputLines = sanitizeText(job.output).split("\n").map((line) => line.trimEnd());
    const maxTail = expanded ? MAX_TAIL_EXPANDED : MAX_TAIL_COLLAPSED;
    const preview = options.isPartial ? tailPreview(outputLines, maxTail) : headTailPreview(outputLines, maxTail);
    const label = isTerminal(job.status) ? "Result" : "Latest";
    for (const [index, line] of preview.shown.entries()) {
      lines.push(sectionLine(theme, index ? "" : label, line || " ", "toolOutput"));
    }
    if (preview.omitted > 0 || job.truncated) {
      lines.push(sectionLine(theme, "", job.truncated ? "(subagent output truncated)" : `… ${preview.omitted} earlier line${preview.omitted === 1 ? "" : "s"}`, "muted"));
    }
  }

  const maxTools = expanded ? MAX_TOOLS_EXPANDED : MAX_TOOLS_COLLAPSED;
  if (job.tools.length) {
    const shown = job.tools.slice(-maxTools);
    if (expanded) {
      lines.push(theme.fg("muted", "Activity"));
      for (const tool of shown) lines.push(toolLine(theme, tool, "  "));
      const omitted = job.tools.length - shown.length;
      if (omitted > 0) lines.push(theme.fg("muted", `  +${omitted} earlier tool call${omitted === 1 ? "" : "s"}`));
    } else {
      lines.push(sectionLine(theme, "Activity", toolLine(theme, shown[0]!), "muted"));
    }
  } else if (!job.output && job.status === "queued") {
    lines.push(sectionLine(theme, "Activity", "waiting for a worker slot", "dim"));
  } else if (!job.output && job.status === "running") {
    lines.push(sectionLine(theme, "Activity", "waiting for the first response", "dim"));
  } else if (!job.output && isTerminal(job.status)) {
    lines.push(sectionLine(theme, "Result", "(no assistant text)", "dim"));
  }

  const usage = formatUsage(job.usage);
  if (usage) lines.push(sectionLine(theme, "Usage", usage, "dim"));

  const footer = theme.fg("dim", expanded
    ? `full bounded output: ${DASHBOARD_POINTER}`
    : options.isPartial
      ? "updating…"
      : options.expandHint
        ? `${options.expandHint} · ${DASHBOARD_POINTER}`
        : DASHBOARD_POINTER);
  const content = clampLines(theme, lines, Math.max(1, budget - 1));
  return [...content, footer].slice(0, budget);
}

export function renderJobCard(job: JobSnapshot, theme: Theme, options: JobCardOptions): Component {
  return linesComponent(buildJobCardLines(job, theme, options));
}

function jobRow(job: JobSnapshot, theme: Theme, now: number): string {
  const status = statusMeta(job.status, now);
  return `${theme.fg(status.color, status.glyph)} ${theme.fg("dim", job.status.padEnd(9))} ${theme.fg("toolTitle", shortId(sanitizeText(job.id)))} ${sanitizeInline(job.role)} ${theme.fg("dim", `· ${sanitizeInline(job.backend)}/${sanitizeInline(job.model)} · ${formatElapsed(job, now)}`)}`;
}

export function renderJobListCard(jobs: JobSnapshot[], theme: Theme, options: { expanded: boolean; now: number }): Component {
  const budget = options.expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES;
  if (!jobs.length) return linesComponent([theme.fg("muted", "No subagent jobs in this session.")]);

  const running = jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const finished = jobs.length - running;
  const lines: string[] = [theme.fg("toolTitle", theme.bold(`${jobs.length} job${jobs.length === 1 ? "" : "s"}`)) + theme.fg("dim", ` · ${running} active · ${finished} finished`)];

  const maxRows = options.expanded ? MAX_LIST_JOBS_EXPANDED : MAX_LIST_JOBS_COLLAPSED;
  const shown = jobs.slice(0, maxRows);
  for (const job of shown) lines.push(jobRow(job, theme, options.now));
  const omitted = jobs.length - shown.length;
  // This is the list card's only /subagents mention (it has no separate footer), so the
  // generic clampLines() hidden-count note below must never repeat it.
  if (omitted > 0) lines.push(theme.fg("muted", `+${omitted} more job${omitted === 1 ? "" : "s"} — see ${DASHBOARD_POINTER}`));

  return linesComponent(clampLines(theme, lines, budget));
}

export function truncatePreview(value: string, maxLength = 80): string {
  const inline = sanitizeInline(value);
  return inline.length > maxLength ? `${inline.slice(0, maxLength)}…` : inline;
}

/** Restrained icon + title vocabulary shared by every `subagent_*` call/result renderer. */
export type ToolCallTitle = "Spawn" | "Inspect" | "Wait" | "Steer" | "Follow up" | "Cancel" | "List" | "Run";

const TOOL_CALL_ICON: Record<ToolCallTitle, string> = {
  Spawn: "→",
  Inspect: "◎",
  Wait: "…",
  Steer: "↝",
  "Follow up": "+",
  Cancel: "×",
  List: "≡",
  Run: "▶",
};

export function renderToolCallLine(theme: Theme, title: ToolCallTitle, accent: string, detail?: string): Component {
  const label = `${TOOL_CALL_ICON[title]} ${title}`;
  const parts = [theme.fg("toolTitle", theme.bold(label)), theme.fg("accent", sanitizeInline(accent))];
  if (detail) parts.push(theme.fg("dim", sanitizeInline(detail)));
  return linesComponent([parts.join(" ")]);
}

export function sendBehaviorLabel(behavior: SendBehavior): string {
  return behavior === "followUp" ? "follow-up" : "steer";
}

export { isTerminal };
