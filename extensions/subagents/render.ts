import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isTerminal } from "../../src/manager.ts";
import { formatSpendBudget } from "../../src/budget.ts";
import type { PeerSessionSummary } from "../../src/session-peers.ts";
import type { ContextSnapshot, JobSnapshot, JobStatus, SendBehavior, Usage } from "../../src/types.ts";

/*
 * Trace grammar shared by every direct tool and by the workflow renderers:
 *
 *   ⌁ <call row>      opens the group and carries the task text
 *   │ <result row>    every result line rides the continuation rail
 *
 * Cards prioritize status, policy, outcome, recent activity, informational usage,
 * and end with a single dashboard-pointer footer. `subagent_spawn` owns the live
 * card; check/wait/send/cancel collapse to one-line receipts so the transcript is
 * never duplicated. Output is sanitized before Pi renders it as Markdown, and
 * cards are pinned to job id + generation so retained-session follow-ups do not
 * rewrite historical rows. Colors come from the active theme; status is always
 * carried by a glyph or word as well, never by color alone.
 */

/** Hard rendered-line budgets so no tool call/result can spam the transcript. */
export const MAX_COLLAPSED_LINES = 10;
export const MAX_EXPANDED_LINES = 36;

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

/** Render no transcript rows. Used for lifecycle mechanics already reflected by a live parent card. */
export function emptyComponent(): Component {
  return new Lines([]);
}

export const TRACE_GROUP = "⌁";
const TRACE_RAIL = "│";
const TRACE_INDENT = "     ";

export function traceResultLine(
  theme: Theme,
  glyph: string,
  text: string,
  color: "accent" | "success" | "warning" | "error" | "muted" | "dim" = "muted",
): string {
  return `${theme.fg("dim", TRACE_RAIL)}${TRACE_INDENT}${theme.fg(color, glyph)} ${theme.fg("muted", sanitizeInline(text))}`;
}

export function traceResultLines(theme: Theme, lines: string[], standalone = false): string[] {
  return lines.map((line, index) => {
    const prefix = standalone && index === 0
      ? theme.fg("accent", TRACE_GROUP)
      : theme.fg("dim", TRACE_RAIL);
    return `${prefix}${TRACE_INDENT}${line}`;
  });
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

/** Chars kept from the tail of a live activity preview before sanitizing, so a large
 *  in-flight `liveThinking` buffer never costs a full sanitize pass every render frame. */
const ACTIVITY_PREVIEW_CHARS = 160;

/** Bound-then-sanitize tail preview of live semantic progress for a single card line. */
function activityPreview(value: string): string {
  const trimmed = value.length > ACTIVITY_PREVIEW_CHARS ? `…${value.slice(-ACTIVITY_PREVIEW_CHARS)}` : value;
  return sanitizeInline(trimmed);
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

export function formatEffort(effort: JobSnapshot["effort"]): string {
  return effort ?? "adaptive";
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

export function formatContext(context?: ContextSnapshot): string {
  if (!context) return "";
  const serving = context.servingModel ? ` · serving ${sanitizeInline(context.servingModel)}` : "";
  if (context.tokens === undefined) {
    if (context.window === undefined && !serving) return "";
    const occupancy = context.window ? `unknown/${formatTokens(context.window)}` : "unknown";
    return `context ${occupancy}${serving}`;
  }
  const occupancy = context.window ? `${formatTokens(context.tokens)}/${formatTokens(context.window)}` : formatTokens(context.tokens);
  return `context ${occupancy}${serving}`;
}

export type TraceStatusColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

/** Shared width-stable status vocabulary for subagents and workflows. */
export function traceStatusMeta(status: string, now?: number): { glyph: string; color: TraceStatusColor } {
  switch (status) {
    case "running": return { glyph: "●", color: "accent" };
    case "paused": return { glyph: "Ⅱ", color: "warning" };
    case "completed": return { glyph: "✓", color: "success" };
    case "failed": return { glyph: "×", color: "error" };
    case "cancelled":
    case "aborted": return { glyph: "■", color: "warning" };
    default: return { glyph: "○", color: "muted" };
  }
}

export function statusMeta(status: JobStatus, now?: number): { glyph: string; color: TraceStatusColor } {
  return traceStatusMeta(status, now);
}

/**
 * Whether a status needs to stand out against the rest of a card — holds and failures, not
 * routine progress. Used by workflow cards, where several statuses (header, phase rows, agent
 * rows) sit on one card and would otherwise compete for the eye: routine glyphs (running,
 * completed, queued) get demoted to quiet, and only genuinely abnormal states keep their full
 * accent color. Direct subagent cards render a single job's status via `statusMeta` and don't
 * need this demotion.
 */
export function isAttentionStatus(color: TraceStatusColor): boolean {
  return color === "warning" || color === "error";
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
  /** Display-only lifecycle label. The underlying job status still controls color and terminal behavior. */
  statusLabel?: string;
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

  const profile = job.profile ? ` · profile ${sanitizeInline(job.profile)}` : "";
  const independent = job.independent ? " · independent" : "";
  const peerMarker = job.peer ? " · peer" : "";
  const statusLabel = sanitizeInline(options.statusLabel ?? job.status);
  const header = `${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", theme.bold(sanitizeInline(job.name)))} ${theme.fg("dim", `${shortId(sanitizeText(job.id))} · ${statusLabel} · ${formatElapsed(job, now)}`)}`;
  const policy = theme.fg("dim", `${job.access}${profile}${independent}${peerMarker} · effort ${formatEffort(job.effort)} · ${sanitizeInline(job.harness)}/${sanitizeInline(job.model)}`);
  lines.push(header, policy);

  const task = sanitizeInline(job.task);
  if (options.expanded && task) lines.push(sectionLine(theme, "Task", task));
  if (job.workflow) {
    const phase = job.workflow.phase ? ` · ${sanitizeInline(job.workflow.phase)}` : "";
    lines.push(sectionLine(theme, "Workflow", `${shortId(sanitizeText(job.workflow.runId))} · ${sanitizeInline(job.workflow.label)}${phase}`, "muted"));
  }
  if (job.peer) {
    const label = job.peer.sourceName ? sanitizeInline(job.peer.sourceName) : shortId(sanitizeText(job.peer.sourceSessionId));
    lines.push(sectionLine(theme, "Peer", `forked from ${label} (${sanitizeInline(job.peer.sourceCwd)})`, "muted"));
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

  // Activity prioritizes current semantic progress over tool mechanics: live thinking beats
  // the latest assistant output (already shown above) beats a minimal operational indicator.
  // Full tool lifecycle detail lives only in the transcript/dashboard, never duplicated here.
  if (!isTerminal(job.status)) {
    const thinking = activityPreview(job.liveThinking);
    if (thinking) {
      lines.push(sectionLine(theme, "Activity", thinking, "dim"));
    } else if (!job.output) {
      const runningTool = [...job.tools].reverse().find((tool) => tool.status === "running");
      if (runningTool) {
        lines.push(sectionLine(theme, "Activity", `running ${sanitizeInline(runningTool.name)}`, "dim"));
      } else if (job.status === "queued") {
        lines.push(sectionLine(theme, "Activity", "waiting for an agent slot", "dim"));
      } else if (job.status === "running") {
        lines.push(sectionLine(theme, "Activity", "waiting for the first response", "dim"));
      }
    }
  } else if (!job.output) {
    lines.push(sectionLine(theme, "Result", "(no assistant text)", "dim"));
  }

  const usage = formatUsage(job.usage);
  if (usage) lines.push(sectionLine(theme, "Usage", usage, "dim"));
  lines.push(sectionLine(theme, "Budget", formatSpendBudget(job.budget, job.usage, job.harness), "dim"));
  const context = formatContext(job.context);
  if (context) lines.push(sectionLine(theme, "Context", context, "dim"));

  const footer = theme.fg("dim", expanded
    ? `full bounded output: ${DASHBOARD_POINTER}`
    : options.expandHint
      ? `${options.expandHint} · ${DASHBOARD_POINTER}`
      : DASHBOARD_POINTER);
  const content = clampLines(theme, lines, Math.max(1, budget - 1));
  return [...content, footer].slice(0, budget);
}

export function renderJobCard(job: JobSnapshot, theme: Theme, options: JobCardOptions & { standalone?: boolean }): Component {
  return linesComponent(traceResultLines(theme, buildJobCardLines(job, theme, options), options.standalone));
}

/** Compact acknowledgement for operations already identified by their call row. */
export function renderJobReceipt(job: JobSnapshot, theme: Theme, options: { action: string; now: number; standalone?: boolean }): Component {
  const status = statusMeta(job.status, options.now);
  const elapsed = formatElapsed(job, options.now);
  const line = `${theme.fg(status.color, status.glyph)} ${theme.fg("muted", sanitizeInline(`${options.action} · ${elapsed}`))}`;
  return linesComponent(traceResultLines(theme, [line], options.standalone));
}

function jobRow(job: JobSnapshot, theme: Theme, now: number): string {
  const status = statusMeta(job.status, now);
  const peerMarker = job.peer ? " · peer" : "";
  return `${theme.fg(status.color, status.glyph)} ${theme.fg("dim", job.status.padEnd(9))} ${theme.fg("toolTitle", shortId(sanitizeText(job.id)))} ${sanitizeInline(job.name)} ${theme.fg("dim", `· ${job.access}${job.independent ? " · independent" : ""}${peerMarker} · effort ${formatEffort(job.effort)} · ${sanitizeInline(job.harness)}/${sanitizeInline(job.model)} · ${formatElapsed(job, now)}`)}`;
}

export function renderJobListCard(jobs: JobSnapshot[], theme: Theme, options: { expanded: boolean; now: number }): Component {
  const budget = options.expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES;
  if (!jobs.length) return linesComponent([traceResultLine(theme, "○", "No subagent jobs in this session.", "muted")]);

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

  return linesComponent(traceResultLines(theme, clampLines(theme, lines, budget)));
}

const MAX_LIST_PEERS_COLLAPSED = 8;
const MAX_LIST_PEERS_EXPANDED = 20;

function peerRow(peer: PeerSessionSummary, theme: Theme): string {
  const name = peer.name ? sanitizeInline(peer.name) : "(unnamed)";
  return `${theme.fg("toolTitle", shortId(peer.sessionId))} ${theme.fg("accent", name)} ${theme.fg("dim", `· ${sanitizeInline(peer.cwd)} · ${peer.messageCount} msg`)}`;
}

export function renderPeerListCard(peers: PeerSessionSummary[], theme: Theme, options: { expanded: boolean }): Component {
  if (!peers.length) return linesComponent([traceResultLine(theme, "○", "No other saved sessions available to fork.", "muted")]);
  const budget = options.expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES;
  const maxRows = options.expanded ? MAX_LIST_PEERS_EXPANDED : MAX_LIST_PEERS_COLLAPSED;
  const shown = peers.slice(0, maxRows);
  const lines = [
    theme.fg("toolTitle", theme.bold(`${peers.length} peer${peers.length === 1 ? "" : "s"}`)),
    ...shown.map((peer) => peerRow(peer, theme)),
  ];
  const omitted = peers.length - shown.length;
  if (omitted > 0) lines.push(theme.fg("muted", `+${omitted} more — refine with query`));
  return linesComponent(traceResultLines(theme, clampLines(theme, lines, budget)));
}

export function truncatePreview(value: string, maxLength = 80): string {
  const inline = sanitizeInline(value);
  return inline.length > maxLength ? `${inline.slice(0, maxLength)}…` : inline;
}

/** Restrained icon + title vocabulary shared by every `subagent_*` call/result renderer. */
export type ToolCallTitle = "Spawn" | "Inspect" | "Wait" | "Steer" | "Follow up" | "Cancel" | "List" | "Run" | "Workflow" | "Fork";

const TOOL_CALL_ICON: Record<ToolCallTitle, string> = {
  Spawn: "◇",
  Inspect: "◌",
  Wait: "·",
  Steer: "↝",
  "Follow up": "+",
  Cancel: "×",
  List: "≡",
  Run: "◆",
  Workflow: "◆",
  Fork: "»",
};

export function renderToolCallLine(theme: Theme, title: ToolCallTitle, accent: string, detail?: string): Component {
  const prefix = theme.fg("accent", TRACE_GROUP);
  const glyph = theme.fg("muted", TOOL_CALL_ICON[title]);
  const label = theme.fg("toolTitle", theme.bold(title.toLowerCase()));
  const parts = [`${prefix}  ${glyph} ${label}`, theme.fg("accent", sanitizeInline(accent))];
  if (detail) parts.push(theme.fg("dim", sanitizeInline(detail)));
  return linesComponent([parts.join(" ")]);
}

export function sendBehaviorLabel(behavior: SendBehavior): string {
  return behavior === "followUp" ? "follow-up" : "steer";
}

export { isTerminal };
