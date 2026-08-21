import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { aggregateWorkflowUsage } from "../../src/workflows/manager.ts";
import { formatWorkflowBudget } from "../../src/workflows/budget.ts";
import type {
  WorkflowAgentRecord,
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

export function workflowStatusMeta(snapshot: Pick<WorkflowSnapshot, "status" | "taskOutcome">): { glyph: string; color: TraceStatusColor } {
  return snapshot.status === "completed" && snapshot.taskOutcome === "unsuccessful"
    ? { glyph: "!", color: "warning" }
    : traceStatusMeta(snapshot.status);
}

function taskOutcomeLabel(snapshot: Pick<WorkflowSnapshot, "status" | "taskOutcome">): string {
  return snapshot.status === "completed" ? ` · task ${snapshot.taskOutcome ?? "unspecified"}` : "";
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

function activePreview(snapshot: WorkflowSnapshot): unknown {
  const active = [...snapshot.agents].reverse().find((agent) => agent.preview || agent.output !== undefined);
  return active?.preview || active?.output;
}

function finalPreview(snapshot: WorkflowSnapshot): unknown {
  if (snapshot.result !== undefined) return snapshot.result;
  const last = [...snapshot.agents].reverse().find((agent) => agent.output !== undefined || agent.preview);
  return last?.output ?? last?.preview;
}

function phaseSummary(snapshot: WorkflowSnapshot, theme: Theme, now: number): string {
  if (!snapshot.phases.length) return theme.fg("dim", "Phases · waiting for the first phase");
  const phase = snapshot.phases.find((candidate) => candidate.index === snapshot.currentPhase)
    ?? snapshot.phases.at(-1)!;
  const status = traceStatusMeta(phase.status, now);
  const position = Math.max(1, snapshot.phases.findIndex((candidate) => candidate.index === phase.index) + 1);
  return `${theme.fg("dim", `Phase ${position}/${snapshot.phases.length}`)} ${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(phase.name))} ${theme.fg("dim", phase.status)}`;
}

function agentSummary(snapshot: WorkflowSnapshot, theme: Theme): string {
  if (!snapshot.agents.length) return theme.fg("dim", "Agents · none started");
  const active = snapshot.agents.filter((agent) => agent.state === "queued" || agent.state === "running").length;
  const failed = snapshot.agents.filter((agent) => agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted").length;
  return theme.fg("dim", `Agents · ${snapshot.agents.length} total · ${active} active${failed ? ` · ${failed} stopped` : ""}`);
}

function phaseLine(snapshot: WorkflowSnapshot, index: number, theme: Theme, now: number): string {
  const phase = snapshot.phases[index]!;
  const status = traceStatusMeta(phase.status, now);
  const current = phase.index === snapshot.currentPhase ? theme.fg("accent", "›") : " ";
  return `${current} ${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(phase.name))} ${theme.fg("dim", `· ${phase.status} · ${countLabel(phase.agents.length, "agent")}`)}`;
}

function agentLine(agent: WorkflowAgentRecord, theme: Theme, now: number): string {
  const status = traceStatusMeta(agent.state, now);
  const route = agent.harness || agent.model
    ? ` · ${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}`
    : "";
  const profile = agent.profile ? ` · profile ${sanitizeInline(agent.profile)}` : "";
  const independent = agent.independent ? " · independent" : "";
  const warning = agent.instructionShaped ? " · ⚠ instruction-like output" : "";
  const isolation = agent.isolation ? ` · worktree ${agent.isolation.state}` : "";
  return `  ${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(agent.name))} ${theme.fg("dim", `${agent.access}${profile}${independent} · ${agent.state}${route} · effort ${agent.effort ?? "adaptive"}${isolation}${warning}`)}`;
}

function clampContent(theme: Theme, lines: string[], budget: number): string[] {
  if (lines.length <= budget) return lines;
  const kept = lines.slice(0, Math.max(0, budget - 1));
  const hidden = lines.length - kept.length;
  kept.push(theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"} hidden`));
  return kept;
}

export function buildWorkflowCardLines(
  snapshot: WorkflowSnapshot,
  theme: Theme,
  options: WorkflowCardOptions,
): string[] {
  const budget = options.expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES;
  const status = workflowStatusMeta(snapshot);
  const mode = snapshot.background ? "background" : "foreground";
  const lines: string[] = [
    `${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", theme.bold(sanitizeInline(snapshot.name) || "Workflow"))} ${theme.fg("dim", shortId(sanitizeText(snapshot.runId)))} ${theme.fg(status.color, `· ${snapshot.status}${taskOutcomeLabel(snapshot)}`)} ${theme.fg("dim", `· ${mode} · ${formatElapsed(snapshot, options.now)}`)}`,
  ];

  const description = sanitizeInline(snapshot.description);
  if (options.expanded && description) lines.push(theme.fg("dim", description));
  for (const warning of snapshot.warnings?.slice(0, options.expanded ? 3 : 1) ?? []) lines.push(theme.fg("warning", `⚠ ${sanitizeInline(warning)}`));
  lines.push(phaseSummary(snapshot, theme, options.now));

  if (options.expanded) {
    const phases = snapshot.phases.slice(0, MAX_PHASES_EXPANDED);
    for (let index = 0; index < phases.length; index++) lines.push(phaseLine(snapshot, index, theme, options.now));
    if (snapshot.phases.length > phases.length) lines.push(theme.fg("muted", `  +${snapshot.phases.length - phases.length} more phases`));
  }

  if (options.expanded) lines.push(agentSummary(snapshot, theme));
  const collapsedAgent = [...snapshot.agents].reverse().find((agent) => agent.state === "queued" || agent.state === "running")
    ?? snapshot.agents.at(-1);
  const agents = options.expanded
    ? snapshot.agents.slice(-MAX_AGENTS_EXPANDED)
    : collapsedAgent ? [collapsedAgent] : [];
  for (const agent of agents) lines.push(agentLine(agent, theme, options.now));
  if (options.expanded && snapshot.agents.length > agents.length) {
    lines.push(theme.fg("muted", `  +${snapshot.agents.length - agents.length} earlier agents`));
  }

  const logs = snapshot.logs?.slice(options.expanded ? -3 : -1) ?? [];
  for (const entry of logs) {
    lines.push(theme.fg("muted", `Log · ${sanitizeInline(entry.message)}`));
  }

  const usageSnapshot = aggregateWorkflowUsage(snapshot);
  const usage = formatUsage(usageSnapshot);
  if (usage) lines.push(theme.fg("dim", `Usage · ${usage}`));
  const budgetLine = formatWorkflowBudget(snapshot, usageSnapshot);
  if (budgetLine) lines.push(theme.fg("dim", `Budget · ${budgetLine}`));

  if (snapshot.error) {
    const errorLines = sanitizeText(snapshot.error).split("\n").map(sanitizeInline).filter(Boolean);
    for (const error of errorLines.slice(0, options.expanded ? 3 : 1)) lines.push(theme.fg("error", error));
  }

  const preview = options.isPartial ? activePreview(snapshot) : finalPreview(snapshot);
  const renderedPreview = previewLines(preview, options.expanded ? 8 : 2, Boolean(options.isPartial));
  if (renderedPreview.length) {
    if (options.expanded) lines.push(theme.fg("dim", options.isPartial ? "Latest result" : "Result preview"));
    for (const line of renderedPreview) lines.push(theme.fg("toolOutput", line));
  } else {
    lines.push(theme.fg("dim", options.isPartial || snapshot.status === "running" || snapshot.status === "paused" || snapshot.status === "pending"
      ? "(no result yet)"
      : "(no result)"));
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
