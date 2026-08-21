import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { aggregateWorkflowUsage } from "../../src/workflows/manager.ts";
import { formatWorkflowBudget, workflowBudgetMetrics } from "../../src/workflows/budget.ts";
import type {
  WorkflowAgentRecord,
  WorkflowPhase,
  WorkflowSnapshot,
} from "../../src/workflows/types.ts";
import {
  formatUsage,
  linesComponent,
  renderToolCallLine,
  sanitizeInline,
  sanitizeText,
  shortId,
  traceResultLine,
  traceResultLines,
  traceStatusMeta,
  type TraceStatusColor,
} from "../subagents/render.ts";

/** Hard budgets for workflow tool results, including their footer. */
export const MAX_COLLAPSED_LINES = 10;
export const MAX_EXPANDED_LINES = 36;
export const WORKFLOWS_POINTER = "/workflows";

const MAX_RESULT_CHARS = 16_384;
const MAX_PHASES_EXPANDED = 6;
const MAX_AGENTS_EXPANDED = 8;
const MAX_SPINE_GLYPHS = 7;

/** Width of the aligned `Label   value` gutter shared by every card group. */
const GUTTER_WIDTH = 8;
const GROUP_INDENT = " ".repeat(GUTTER_WIDTH + 1);

export function workflowStatusMeta(snapshot: Pick<WorkflowSnapshot, "status" | "taskOutcome">): { glyph: string; color: TraceStatusColor } {
  return snapshot.status === "completed" && snapshot.taskOutcome === "unsuccessful"
    ? { glyph: "!", color: "warning" }
    : traceStatusMeta(snapshot.status);
}

function taskOutcomeLabel(snapshot: Pick<WorkflowSnapshot, "status" | "taskOutcome">): string {
  return snapshot.status === "completed" ? ` · task ${snapshot.taskOutcome ?? "unspecified"}` : "";
}

function isRunningState(status: WorkflowSnapshot["status"]): boolean {
  return status === "running" || status === "paused" || status === "pending";
}

export interface WorkflowCardOptions {
  expanded: boolean;
  isPartial?: boolean;
  expandHint?: string;
  standalone?: boolean;
  now: number;
}

function formatElapsed(snapshot: WorkflowSnapshot, now: number): string {
  const timestamps = snapshot.timestamps;
  const elapsed = Math.max(0, (timestamps.endedAt ?? now) - (timestamps.startedAt ?? timestamps.createdAt));
  const seconds = Math.floor(elapsed / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Left-aligns a group label to the shared gutter width so every value column lines up. */
function group(theme: Theme, label: string, value: string): string {
  return `${theme.fg("dim", label.padEnd(GUTTER_WIDTH))} ${value}`;
}

function boundedResult(value: unknown): { text: string; truncated: boolean } {
  if (value === undefined || value === null || value === "") return { text: "", truncated: false };
  let raw: string;
  if (typeof value === "string") raw = value;
  else {
    try {
      const serialized = JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? String(nested) : nested, 2);
      raw = serialized === undefined ? String(value) : serialized;
    } catch {
      try { raw = String(value); }
      catch { raw = "[unrenderable result]"; }
    }
  }
  const truncated = raw.length > MAX_RESULT_CHARS;
  return { text: sanitizeText(raw.slice(0, MAX_RESULT_CHARS)), truncated };
}

function previewLines(value: unknown, limit: number, tail: boolean): string[] {
  const bounded = boundedResult(value);
  if (!bounded.text) return [];
  const all = bounded.text.split("\n").map((line) => line.trimEnd());
  if (all.length <= limit && !bounded.truncated) return all;
  const shown = tail ? all.slice(-limit) : headTail(all, limit);
  const omitted = Math.max(0, all.length - shown.filter((line) => !line.startsWith("⋯ ")).length);
  if (bounded.truncated && shown.length) shown[shown.length - 1] = `${shown.at(-1)} …`;
  else if (tail && omitted > 0) shown.unshift(`⋯ ${omitted} earlier line${omitted === 1 ? "" : "s"}`);
  return shown.slice(-limit);
}

function headTail(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines;
  if (limit <= 1) return lines.slice(0, limit);
  const headCount = Math.max(1, Math.ceil((limit - 1) / 2));
  const tailCount = Math.max(0, limit - headCount - 1);
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    `⋯ ${omitted} line${omitted === 1 ? "" : "s"} omitted ⋯`,
    ...(tailCount ? lines.slice(lines.length - tailCount) : []),
  ];
}

function finalPreview(snapshot: WorkflowSnapshot): unknown {
  if (snapshot.result !== undefined) return snapshot.result;
  const last = [...snapshot.agents].reverse().find((agent) => agent.output !== undefined || agent.preview);
  return last?.output ?? last?.preview;
}

/** Most recently active agent, or the last agent recorded once every agent has settled. */
function focusedAgent(snapshot: WorkflowSnapshot): WorkflowAgentRecord | undefined {
  return [...snapshot.agents].reverse().find((agent) => agent.state === "queued" || agent.state === "running")
    ?? snapshot.agents.at(-1);
}

function agentActivity(agent: WorkflowAgentRecord): string {
  if (typeof agent.preview === "string" && agent.preview) return sanitizeInline(agent.preview);
  switch (agent.state) {
    case "queued": return "queued";
    case "running": return "running";
    case "completed": return "done";
    default: return agent.state;
  }
}

function latestValue(snapshot: WorkflowSnapshot, theme: Theme, now: number): string | undefined {
  const agent = focusedAgent(snapshot);
  if (!agent) return undefined;
  const status = traceStatusMeta(agent.state, now);
  return `${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(agent.name))} ${theme.fg("dim", "—")} ${theme.fg("muted", agentActivity(agent))}`;
}

/** Position of the current phase within the phases array, defaulting to the most recent phase. */
function currentPhaseIndex(snapshot: WorkflowSnapshot): number {
  if (!snapshot.phases.length) return -1;
  const found = snapshot.phases.findIndex((phase) => phase.index === snapshot.currentPhase);
  return found >= 0 ? found : snapshot.phases.length - 1;
}

/** Bounded phase spine: a window of glyphs centered on the current phase, with `⋯` markers when phases are hidden. */
function phaseSpine(phases: WorkflowPhase[], currentIndex: number, theme: Theme, now: number): string {
  const glyphAt = (index: number) => {
    const meta = traceStatusMeta(phases[index]!.status, now);
    return theme.fg(meta.color, meta.glyph);
  };
  if (phases.length <= MAX_SPINE_GLYPHS) {
    return phases.map((_, index) => glyphAt(index)).join(theme.fg("dim", "─"));
  }
  const radius = Math.floor((MAX_SPINE_GLYPHS - 1) / 2);
  let start = Math.max(0, currentIndex - radius);
  const end = Math.min(phases.length - 1, start + MAX_SPINE_GLYPHS - 1);
  start = Math.max(0, end - MAX_SPINE_GLYPHS + 1);
  const segments: string[] = [];
  if (start > 0) segments.push(theme.fg("dim", "⋯"));
  for (let index = start; index <= end; index++) segments.push(glyphAt(index));
  if (end < phases.length - 1) segments.push(theme.fg("dim", "⋯"));
  return segments.join(theme.fg("dim", "─"));
}

function phaseGroupValue(snapshot: WorkflowSnapshot, theme: Theme, now: number): string {
  if (!snapshot.phases.length) return theme.fg("dim", "waiting for the first phase");
  const currentIndex = currentPhaseIndex(snapshot);
  const phase = snapshot.phases[currentIndex]!;
  const spine = phaseSpine(snapshot.phases, currentIndex, theme, now);
  const fraction = theme.fg("dim", `${currentIndex + 1}/${snapshot.phases.length}`);
  const name = theme.fg("toolTitle", sanitizeInline(phase.name));
  return `${spine}  ${fraction} ${name} ${theme.fg("dim", `· ${phase.status}`)}`;
}

function phaseRow(phase: WorkflowPhase, isCurrent: boolean, theme: Theme, now: number): string {
  const status = traceStatusMeta(phase.status, now);
  const marker = isCurrent ? theme.fg("accent", "›") : " ";
  return `${GROUP_INDENT}${marker} ${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(phase.name))} ${theme.fg("dim", `· ${phase.status} · ${countLabel(phase.agents.length, "agent")}`)}`;
}

/** Bounded roster of individual phase rows, windowed around the current phase. */
function phaseRosterLines(snapshot: WorkflowSnapshot, theme: Theme, now: number): string[] {
  const total = snapshot.phases.length;
  if (total <= 1) return [];
  const currentIndex = currentPhaseIndex(snapshot);
  const radius = Math.floor((MAX_PHASES_EXPANDED - 1) / 2);
  let start = Math.max(0, currentIndex - radius);
  const end = Math.min(total - 1, start + MAX_PHASES_EXPANDED - 1);
  start = Math.max(0, end - MAX_PHASES_EXPANDED + 1);
  const lines: string[] = [];
  if (start > 0) lines.push(`${GROUP_INDENT}${theme.fg("muted", `⋯ ${start} earlier phase${start === 1 ? "" : "s"}`)}`);
  for (let index = start; index <= end; index++) lines.push(phaseRow(snapshot.phases[index]!, index === currentIndex, theme, now));
  const hiddenAfter = total - 1 - end;
  if (hiddenAfter > 0) lines.push(`${GROUP_INDENT}${theme.fg("muted", `⋯ ${hiddenAfter} more phase${hiddenAfter === 1 ? "" : "s"}`)}`);
  return lines;
}

interface AgentCounts { total: number; queued: number; running: number; done: number; failed: number }

function agentCounts(agents: WorkflowAgentRecord[]): AgentCounts {
  return agents.reduce<AgentCounts>((acc, agent) => {
    acc.total += 1;
    if (agent.state === "queued") acc.queued += 1;
    else if (agent.state === "running") acc.running += 1;
    else if (agent.state === "completed") acc.done += 1;
    else acc.failed += 1; // failed, cancelled, aborted
    return acc;
  }, { total: 0, queued: 0, running: 0, done: 0, failed: 0 });
}

/** Rollup of total/running/done/failed agent counts — no policy or model noise. */
function agentRollupValue(snapshot: WorkflowSnapshot, theme: Theme): string {
  if (!snapshot.agents.length) return theme.fg("dim", "none started");
  const counts = agentCounts(snapshot.agents);
  const parts = [theme.fg("text", String(counts.total))];
  if (counts.queued) parts.push(theme.fg("muted", `○${counts.queued} queued`));
  if (counts.running) parts.push(theme.fg("accent", `●${counts.running} running`));
  if (counts.done) parts.push(theme.fg("success", `✓${counts.done} done`));
  if (counts.failed) parts.push(theme.fg("error", `×${counts.failed} failed`));
  return parts.join(theme.fg("dim", " · "));
}

function agentRow(agent: WorkflowAgentRecord, theme: Theme, now: number): string {
  const status = traceStatusMeta(agent.state, now);
  const route = agent.harness || agent.model
    ? ` · ${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}`
    : "";
  const profile = agent.profile ? ` · profile ${sanitizeInline(agent.profile)}` : "";
  const independent = agent.independent ? " · independent" : "";
  const warning = agent.instructionShaped ? " · ⚠ instruction-like output" : "";
  const isolation = agent.isolation ? ` · worktree ${agent.isolation.state}` : "";
  return `${GROUP_INDENT}${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(agent.name))} ${theme.fg("dim", `${agent.access}${profile}${independent} · ${agent.state}${route} · effort ${agent.effort ?? "adaptive"}${isolation}${warning}`)}`;
}

/** Live preview of the currently active agent, rendered as an indented `↳` continuation. */
function agentPreviewLines(snapshot: WorkflowSnapshot, theme: Theme): string[] {
  const agent = focusedAgent(snapshot);
  if (!agent || (agent.state !== "running" && agent.state !== "queued")) return [];
  if (typeof agent.preview !== "string" || !agent.preview) return [];
  return previewLines(agent.preview, 2, true).map((line) => `${GROUP_INDENT}${theme.fg("dim", "↳")} ${theme.fg("toolOutput", line)}`);
}

function clampContent(theme: Theme, lines: string[], budget: number): string[] {
  if (lines.length <= budget) return lines;
  const kept = lines.slice(0, Math.max(0, budget - 1));
  const hidden = lines.length - kept.length;
  kept.push(theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"} hidden`));
  return kept;
}

function headerLine(snapshot: WorkflowSnapshot, theme: Theme, now: number): string {
  const status = workflowStatusMeta(snapshot);
  const mode = snapshot.background ? "bg" : "fg";
  const failed = snapshot.agents.filter((agent) => agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted").length;
  const warnings = snapshot.warnings?.length ?? 0;
  const abnormal: string[] = [];
  if (warnings) abnormal.push(theme.fg("warning", `⚠${warnings}`));
  if (failed) abnormal.push(theme.fg("error", `×${failed}`));
  const abnormalText = abnormal.length ? ` ${abnormal.join(" ")}` : "";
  const tail = theme.fg("dim", ` · ${formatElapsed(snapshot, now)} · ${mode} · ${shortId(sanitizeText(snapshot.runId))}`);
  return `${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", theme.bold(sanitizeInline(snapshot.name) || "Workflow"))} ${theme.fg(status.color, `· ${snapshot.status}${taskOutcomeLabel(snapshot)}`)}${abnormalText}${tail}`;
}

/** Rolls the workflow's budget metrics into a short health phrase for the collapsed `Usage` group. */
function budgetHealth(
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents">,
  usage: Parameters<typeof workflowBudgetMetrics>[1],
): { text: string; abnormal: boolean } {
  const metrics = workflowBudgetMetrics(snapshot, usage);
  if (!metrics.length) return { text: "budget open", abnormal: false };
  const reached = metrics.filter((metric) => metric.supported && metric.reached).map((metric) => metric.key);
  return reached.length
    ? { text: `budget reached (${reached.join(", ")})`, abnormal: true }
    : { text: "budget ok", abnormal: false };
}

export function buildWorkflowCardLines(
  snapshot: WorkflowSnapshot,
  theme: Theme,
  options: WorkflowCardOptions,
): string[] {
  const budget = options.expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES;
  const lines: string[] = [headerLine(snapshot, theme, options.now)];

  const description = sanitizeInline(snapshot.description);
  if (options.expanded && description) lines.push(theme.fg("dim", description));
  for (const warning of snapshot.warnings?.slice(0, options.expanded ? 3 : 1) ?? []) lines.push(theme.fg("warning", `⚠ ${sanitizeInline(warning)}`));

  // Phases: bounded spine plus an authoritative current/total fraction; roster rows expand only.
  lines.push(group(theme, "Phases", phaseGroupValue(snapshot, theme, options.now)));
  if (options.expanded) for (const line of phaseRosterLines(snapshot, theme, options.now)) lines.push(line);

  // Agents: collapsed is always a rollup of counts; roster rows and the live preview expand only.
  lines.push(group(theme, "Agents", agentRollupValue(snapshot, theme)));
  if (options.expanded) {
    const roster = snapshot.agents.slice(-MAX_AGENTS_EXPANDED);
    const hiddenBefore = snapshot.agents.length - roster.length;
    if (hiddenBefore > 0) lines.push(`${GROUP_INDENT}${theme.fg("muted", `⋯ ${hiddenBefore} earlier agent${hiddenBefore === 1 ? "" : "s"}`)}`);
    for (const agent of roster) lines.push(agentRow(agent, theme, options.now));
    for (const line of agentPreviewLines(snapshot, theme)) lines.push(line);
  }

  if (options.expanded && snapshot.logs?.length) {
    const shown = snapshot.logs.slice(-3);
    lines.push(group(theme, "Log", theme.fg("muted", sanitizeInline(shown[0]!.message))));
    for (const entry of shown.slice(1)) lines.push(`${GROUP_INDENT}${theme.fg("muted", sanitizeInline(entry.message))}`);
  }

  // Settled cards report the final Result; running/partial cards identify the focused agent and its activity.
  const settled = !options.isPartial && !isRunningState(snapshot.status);
  if (settled) {
    const rendered = previewLines(finalPreview(snapshot), options.expanded ? 8 : 2, false);
    if (rendered.length) {
      lines.push(group(theme, "Result", theme.fg("toolOutput", rendered[0]!)));
      for (const line of rendered.slice(1)) lines.push(`${GROUP_INDENT}${theme.fg("toolOutput", line)}`);
    } else {
      lines.push(group(theme, "Result", theme.fg("dim", "(no result)")));
    }
  } else {
    lines.push(group(theme, "Latest", latestValue(snapshot, theme, options.now) ?? theme.fg("dim", "waiting for the first agent")));
  }

  const usageSnapshot = aggregateWorkflowUsage(snapshot);
  const usageText = formatUsage(usageSnapshot);
  const health = budgetHealth(snapshot, usageSnapshot);
  if (options.expanded) {
    if (usageText) lines.push(group(theme, "Usage", theme.fg("dim", usageText)));
    lines.push(group(theme, "Budget", theme.fg(health.abnormal ? "warning" : "dim", formatWorkflowBudget(snapshot, usageSnapshot)!)));
  } else {
    const value = [usageText, theme.fg(health.abnormal ? "warning" : "dim", health.text)].filter(Boolean).join(theme.fg("dim", " · "));
    lines.push(group(theme, "Usage", value));
  }

  if (snapshot.error) {
    const errorLines = sanitizeText(snapshot.error).split("\n").map(sanitizeInline).filter(Boolean);
    for (const error of errorLines.slice(0, options.expanded ? 3 : 1)) lines.push(theme.fg("error", error));
  }

  const footerText = options.expanded
    ? `full bounded result: ${WORKFLOWS_POINTER}`
    : options.expandHint
      ? `${sanitizeInline(options.expandHint)} · ${WORKFLOWS_POINTER}`
      : WORKFLOWS_POINTER;
  const content = clampContent(theme, lines, Math.max(0, budget - 1));
  return [...content, theme.fg("dim", footerText)].slice(0, budget);
}

export function renderWorkflowCard(
  snapshot: WorkflowSnapshot,
  theme: Theme,
  options: WorkflowCardOptions,
): Component {
  return linesComponent(traceResultLines(theme, buildWorkflowCardLines(snapshot, theme, options), options.standalone));
}

export function renderWorkflowFailure(text: string, theme: Theme): Component {
  return linesComponent([traceResultLine(theme, "×", text, "error")]);
}

export function renderWorkflowCall(
  name: string,
  description: string,
  background: boolean,
  theme: Theme,
): Component {
  const title = sanitizeInline(name) || "Workflow";
  const detail = [background ? "background" : "foreground", sanitizeInline(description)].filter(Boolean).join(" · ");
  return renderToolCallLine(theme, "Workflow", title, detail);
}
