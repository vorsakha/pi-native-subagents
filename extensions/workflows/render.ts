import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { aggregateWorkflowUsage } from "../../src/workflows/manager.ts";
import { formatWorkflowBudget, workflowBudgetHealth } from "../../src/workflows/budget.ts";
import type {
  WorkflowAgentRecord,
  WorkflowPhase,
  WorkflowSnapshot,
} from "../../src/workflows/types.ts";
import {
  formatUsage,
  isAttentionStatus,
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

/** Quiets a routine status glyph's color so it doesn't compete with the phase spine or a
 *  selected row; failure/warning states keep their full color so they still stand out. */
function demoteUnlessAttention(meta: { glyph: string; color: TraceStatusColor }): { glyph: string; color: TraceStatusColor } {
  return isAttentionStatus(meta.color) ? meta : { glyph: meta.glyph, color: "dim" };
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
  return [...snapshot.agents].reverse().find((agent) => agent.state === "queued" || agent.state === "running" || agent.state === "waiting")
    ?? snapshot.agents.at(-1);
}

/** Bounded, credential-free summary of a live provider wait: reason, remaining time, attempt count. */
function formatProviderWait(agent: WorkflowAgentRecord, now: number): string | undefined {
  const wait = agent.providerWait;
  if (!wait) return undefined;
  const remaining = Math.max(0, wait.retryAt - now);
  const retryLabel = remaining < 60_000 ? `${Math.max(1, Math.round(remaining / 1_000))}s` : `${Math.round(remaining / 60_000)}m`;
  return `waiting for ${sanitizeInline(wait.provider)} ${sanitizeInline(wait.kind)} · retry in ${retryLabel} · attempt ${wait.attempt}/${wait.maxAttempts}`;
}

/** Quiet fallback copy for an agent with no semantic preview yet — avoids restating "running",
 *  which the header and phase spine already convey. */
function agentActivity(agent: WorkflowAgentRecord, now: number): string {
  if (agent.state === "waiting") return formatProviderWait(agent, now) ?? "waiting for provider";
  if (typeof agent.preview === "string" && agent.preview) return sanitizeInline(agent.preview);
  switch (agent.state) {
    case "queued": return "waiting to start";
    case "running": return "in progress";
    case "completed": return "done";
    default: return agent.state;
  }
}

/** The focused agent's name plus its activity — no status glyph, since the header and phase
 *  spine already carry the workflow's running state. */
function latestValue(snapshot: WorkflowSnapshot, theme: Theme, now: number): string | undefined {
  const agent = focusedAgent(snapshot);
  if (!agent) return undefined;
  return `${theme.fg("toolTitle", sanitizeInline(agent.name))} ${theme.fg("dim", "·")} ${theme.fg("muted", agentActivity(agent, now))}`;
}

export interface WorkflowPhaseProgress {
  currentIndex: number;
  phaseIndex: number;
  phase?: WorkflowPhase;
  position: number;
  total?: number;
  label: string;
  waiting: boolean;
  noPhases: boolean;
}

function terminalStatus(status: WorkflowSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/** Shared phase position and denominator semantics for cards and the workflow dashboard. */
export function workflowPhaseProgress(snapshot: WorkflowSnapshot, selectedPhaseIndex?: number): WorkflowPhaseProgress {
  const currentIndex = snapshot.currentPhase === null
    ? -1
    : snapshot.phases.findIndex((phase) => phase.index === snapshot.currentPhase);
  const selectedIndex = selectedPhaseIndex === undefined
    ? -1
    : snapshot.phases.findIndex((phase) => phase.index === selectedPhaseIndex);
  const terminal = terminalStatus(snapshot.status);
  const declared = snapshot.plannedPhaseCount !== undefined;
  const noPhases = snapshot.phases.length === 0;
  const phaseIndex = selectedIndex >= 0
    ? selectedIndex
    : currentIndex >= 0
      ? currentIndex
      : !declared && terminal && snapshot.phases.length
        ? snapshot.phases.length - 1
        : -1;
  const phase = phaseIndex >= 0 ? snapshot.phases[phaseIndex] : undefined;
  const position = declared
    ? currentIndex < 0
      ? 0
      : selectedIndex >= 0
        ? selectedIndex + 1
        : currentIndex + 1
    : terminal && snapshot.phases.length
      ? selectedIndex >= 0 ? selectedIndex + 1 : snapshot.phases.length
      : phaseIndex >= 0 ? phaseIndex + 1 : 0;
  const total = declared
    ? snapshot.plannedPhaseCount
    : terminal && snapshot.phases.length
      ? snapshot.phases.length
      : undefined;
  const waiting = !terminal && position === 0 && !declared;
  const label = noPhases
    ? terminal ? "no phases" : "waiting"
    : waiting
      ? "waiting"
      : `${position}/${total ?? "?"}`;
  return { currentIndex, phaseIndex, phase, position, total, label, waiting, noPhases };
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
  const progress = workflowPhaseProgress(snapshot);
  if (progress.noPhases) {
    // Before the real phase spine exists, the workflow's own status glyph is the one
    // meaningful live indicator in this slot rather than a bare neutral placeholder.
    const status = traceStatusMeta(snapshot.status, now);
    const glyph = theme.fg(status.color, status.glyph);
    const text = theme.fg("dim", progress.waiting ? "waiting for the first phase" : "no phases recorded");
    return `${glyph} ${text}`;
  }
  const spineIndex = progress.phaseIndex >= 0 ? progress.phaseIndex : 0;
  const spine = phaseSpine(snapshot.phases, spineIndex, theme, now);
  const fraction = theme.fg("dim", progress.label);
  if (!progress.phase) return `${spine}  ${fraction} ${theme.fg("dim", "not started")}`;
  const name = theme.fg("toolTitle", sanitizeInline(progress.phase.name));
  return `${spine}  ${fraction} ${name} ${theme.fg("dim", `· ${progress.phase.status}`)}`;
}

function phaseRow(phase: WorkflowPhase, isCurrent: boolean, theme: Theme, now: number): string {
  const status = traceStatusMeta(phase.status, now);
  // Current selection is its own attention signal (the `›` marker), so a routine glyph there
  // stays undemoted too — only failure/warning states and the current row keep full color.
  const shown = isCurrent ? status : demoteUnlessAttention(status);
  const marker = isCurrent ? theme.fg("accent", "›") : " ";
  return `${GROUP_INDENT}${marker} ${theme.fg(shown.color, shown.glyph)} ${theme.fg("toolTitle", sanitizeInline(phase.name))} ${theme.fg("dim", `· ${phase.status} · ${countLabel(phase.agents.length, "agent")}`)}`;
}

/** Bounded roster of individual phase rows, windowed around the current phase. */
function phaseRosterLines(snapshot: WorkflowSnapshot, theme: Theme, now: number): string[] {
  const total = snapshot.phases.length;
  if (total <= 1) return [];
  const progress = workflowPhaseProgress(snapshot);
  const currentIndex = progress.currentIndex >= 0
    ? progress.currentIndex
    : snapshot.plannedPhaseCount === undefined
      ? progress.phaseIndex
      : -1;
  const radius = Math.floor((MAX_PHASES_EXPANDED - 1) / 2);
  let start = Math.max(0, (currentIndex >= 0 ? currentIndex : 0) - radius);
  const end = Math.min(total - 1, start + MAX_PHASES_EXPANDED - 1);
  start = Math.max(0, end - MAX_PHASES_EXPANDED + 1);
  const lines: string[] = [];
  if (start > 0) lines.push(`${GROUP_INDENT}${theme.fg("muted", `⋯ ${start} earlier phase${start === 1 ? "" : "s"}`)}`);
  for (let index = start; index <= end; index++) lines.push(phaseRow(snapshot.phases[index]!, index === currentIndex, theme, now));
  const hiddenAfter = total - 1 - end;
  if (hiddenAfter > 0) lines.push(`${GROUP_INDENT}${theme.fg("muted", `⋯ ${hiddenAfter} more phase${hiddenAfter === 1 ? "" : "s"}`)}`);
  return lines;
}

interface AgentCounts { total: number; queued: number; running: number; waiting: number; done: number; failed: number }

function agentCounts(agents: WorkflowAgentRecord[]): AgentCounts {
  return agents.reduce<AgentCounts>((acc, agent) => {
    acc.total += 1;
    if (agent.state === "queued") acc.queued += 1;
    else if (agent.state === "running") acc.running += 1;
    else if (agent.state === "waiting") acc.waiting += 1;
    else if (agent.state === "completed") acc.done += 1;
    else acc.failed += 1; // failed, cancelled, aborted
    return acc;
  }, { total: 0, queued: 0, running: 0, waiting: 0, done: 0, failed: 0 });
}

/** Compact wording for a roster that's entirely in one state, so it doesn't repeat the
 *  total plus that same total's count (e.g. "3 total, 3 running"). */
function singleStateSummary(counts: AgentCounts, theme: Theme): string | undefined {
  if (counts.running === counts.total) return theme.fg("text", `${counts.total} active`);
  if (counts.done === counts.total) return theme.fg("muted", `${counts.total} done`);
  if (counts.queued === counts.total) return theme.fg("muted", `${counts.total} queued`);
  if (counts.waiting === counts.total) return theme.fg("warning", `${counts.total} waiting`);
  if (counts.failed === counts.total) return theme.fg("error", `${counts.total} failed`);
  return undefined;
}

/** Rollup of total/running/done/failed agent counts — no policy or model noise, and no
 *  per-state glyphs (the counts and words already carry the state, without color-only cues). */
function agentRollupValue(snapshot: WorkflowSnapshot, theme: Theme): string {
  if (!snapshot.agents.length) return theme.fg("dim", "none started");
  const counts = agentCounts(snapshot.agents);
  const single = singleStateSummary(counts, theme);
  if (single) return single;
  const parts = [theme.fg("text", String(counts.total))];
  if (counts.queued) parts.push(theme.fg("muted", `${counts.queued} queued`));
  if (counts.running) parts.push(theme.fg("muted", `${counts.running} running`));
  if (counts.waiting) parts.push(theme.fg("warning", `${counts.waiting} waiting`));
  if (counts.done) parts.push(theme.fg("dim", `${counts.done} done`));
  if (counts.failed) parts.push(theme.fg("error", `${counts.failed} failed`));
  return parts.join(theme.fg("dim", " · "));
}

function agentRow(agent: WorkflowAgentRecord, theme: Theme, now: number): string {
  const status = demoteUnlessAttention(traceStatusMeta(agent.state, now));
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

/** Same neutral marker as the `⌁ workflow` call row, used for the header's routine states so
 *  it doesn't add a second bright accent dot next to the phase spine below it. */
const WORKFLOW_MARKER = "◆";

function headerLine(snapshot: WorkflowSnapshot, theme: Theme, now: number): string {
  const status = workflowStatusMeta(snapshot);
  // The header carries the one explicit overall status: a full-color glyph and label when the
  // run needs attention (paused, failed, aborted, unsuccessful), and a quiet neutral marker
  // with dim status text otherwise — routine progress belongs to the phase spine, not here.
  const attention = isAttentionStatus(status.color);
  const marker = attention ? theme.fg(status.color, status.glyph) : theme.fg("muted", WORKFLOW_MARKER);
  const statusColor: TraceStatusColor = attention ? status.color : "dim";
  const mode = snapshot.background ? "bg" : "fg";
  const failed = snapshot.agents.filter((agent) => agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted").length;
  const warnings = snapshot.warnings?.length ?? 0;
  const abnormal: string[] = [];
  if (warnings) abnormal.push(theme.fg("warning", `⚠${warnings}`));
  if (failed) abnormal.push(theme.fg("error", `×${failed}`));
  const abnormalText = abnormal.length ? ` ${abnormal.join(" ")}` : "";
  const tail = theme.fg("dim", ` · ${formatElapsed(snapshot, now)} · ${mode} · ${shortId(sanitizeText(snapshot.runId))}`);
  return `${marker} ${theme.fg("toolTitle", theme.bold(sanitizeInline(snapshot.name) || "Workflow"))} ${theme.fg(statusColor, `· ${snapshot.status}${taskOutcomeLabel(snapshot)}`)}${abnormalText}${tail}`;
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
  const health = workflowBudgetHealth(snapshot, usageSnapshot);
  if (options.expanded) {
    if (usageText) lines.push(group(theme, "Usage", theme.fg("dim", usageText)));
    lines.push(group(theme, "Budget", theme.fg(health.abnormal ? "warning" : "dim", formatWorkflowBudget(snapshot, usageSnapshot))));
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
