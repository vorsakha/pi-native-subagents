import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { aggregateWorkflowUsage } from "../../src/workflows/manager.ts";
import { formatWorkflowBudget, workflowBudgetHealth } from "../../src/workflows/budget.ts";
import { formatDurationLabel, type DashboardSummary } from "../dashboard-style.ts";
import type {
  WorkflowAgentRecord,
  WorkflowConvergence,
  WorkflowInteractionSummary,
  WorkflowPhase,
  WorkflowSnapshot,
} from "../../src/workflows/types.ts";
import {
  formatEffort,
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
import { formatAgentActivity } from "./current-activity.ts";

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

/**
 * Distinct glyph and word per convergence state, so the terminal outcome is
 * readable without color: approved, blocked, stalled, limit-reached, failed,
 * and a running loop never share a marker.
 */
export function workflowConvergenceMeta(convergence: Pick<WorkflowConvergence, "state">): { glyph: string; color: TraceStatusColor } {
  switch (convergence.state) {
    case "approved": return { glyph: "✓", color: "success" };
    case "blocked": return { glyph: "⊘", color: "warning" };
    case "stalled": return { glyph: "≡", color: "warning" };
    case "limit-reached": return { glyph: "⊣", color: "warning" };
    case "failed": return { glyph: "×", color: "error" };
    default: return { glyph: "●", color: "accent" };
  }
}

/** Round position, state, latest verdict, actionable count, and stopping reason in one bounded line. */
export function formatWorkflowConvergence(convergence: WorkflowConvergence, reasonChars = 200): string {
  const parts: string[] = [];
  if (convergence.name) parts.push(sanitizeInline(convergence.name));
  parts.push(`round ${convergence.round}/${convergence.maxRounds}`, convergence.state);
  if (convergence.verdict) parts.push(`verdict ${convergence.verdict}`);
  if (convergence.actionableCount !== undefined) parts.push(countLabel(convergence.actionableCount, "actionable finding"));
  if (convergence.stoppingReason) parts.push(sanitizeInline(convergence.stoppingReason).slice(0, reasonChars));
  return parts.join(" · ");
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

function summaryPreview(value: unknown): string {
  const text = boundedResult(value).text;
  return text.split("\n").map(sanitizeInline).find(Boolean) ?? "";
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

/**
 * Bounded wait vocabulary for a routed question, kept distinct from a
 * provider-quota wait, scheduler queueing, and a user pause: it names who owes
 * the answer, how long the agent has been blocked, and the question itself.
 */
export function formatWorkflowInteraction(interaction: WorkflowInteractionSummary, now: number): string {
  const who = interaction.target === "orchestrator"
    ? "needs orchestrator"
    : `waiting for ${sanitizeInline(interaction.targetName ?? "peer")}`;
  const elapsed = formatDurationLabel(Math.max(0, (interaction.answeredAt ?? now) - interaction.createdAt));
  const state = interaction.state === "pending" || interaction.state === "answering"
    ? interaction.state === "answering" ? "answering" : "unanswered"
    : interaction.state;
  return `${who} · ${elapsed} · ${state} · ${sanitizeInline(interaction.question)}`;
}

/** Per-agent interaction wait, or the peer answer this agent is producing. */
export function workflowAgentInteraction(agent: WorkflowAgentRecord, now: number): string | undefined {
  if (agent.waitingOn) return formatWorkflowInteraction(agent.waitingOn, now);
  return agent.answering ? `answering peer question from ${sanitizeInline(agent.answering.sourceName)}` : undefined;
}

/** Agents currently blocked on a routed question; drives the `N need input` marker. */
export function workflowNeedsInput(snapshot: Pick<WorkflowSnapshot, "agents">): number {
  return snapshot.agents.filter((agent) => agent.waitingOn).length;
}

function activeAgentSummary(agent: WorkflowAgentRecord, now: number): DashboardSummary | undefined {
  if (agent.state !== "running") return undefined;
  return { kind: "activity", text: formatAgentActivity(agent.activity, now) };
}

/** Operator-first semantic summary for one workflow agent row. */
export function workflowAgentDashboardSummary(agent: WorkflowAgentRecord, now: number): DashboardSummary {
  if (agent.waitingOn) {
    return { kind: "input", text: formatWorkflowInteraction(agent.waitingOn, now) };
  }
  if (agent.state === "waiting" && agent.answering) {
    return {
      kind: "activity",
      text: `answering peer question from ${sanitizeInline(agent.answering.sourceName)}`,
    };
  }

  if (agent.state === "waiting") {
    return { kind: "wait", text: formatProviderWait(agent, now) ?? "waiting for provider" };
  }
  if (agent.error || agent.state === "failed") {
    return { kind: "failure", text: summaryPreview(agent.error) || "Agent failed" };
  }
  if (agent.answering) {
    return {
      kind: "activity",
      text: `answering peer question from ${sanitizeInline(agent.answering.sourceName)}`,
    };
  }
  if (agent.state === "queued") {
    return { kind: "wait", text: "queued for workflow dispatch" };
  }
  const active = activeAgentSummary(agent, now);
  if (active) return active;
  if (agent.state === "completed") {
    const result = summaryPreview(agent.output) || summaryPreview(agent.preview);
    return { kind: "result", text: result || "completed without a result preview" };
  }
  return { kind: "lifecycle", text: agent.state };
}

function latestActiveWorkflowSummary(snapshot: WorkflowSnapshot, now: number): { at: number; text: string; agentName?: string } | undefined {
  const hasExplicitWait = snapshot.agents.some((agent) => agent.state === "queued" || agent.state === "waiting");
  let latest: { at: number; text: string; agentName?: string } | undefined;

  for (const agent of snapshot.agents) {
    if (!agent.activity) continue;
    const summary = activeAgentSummary(agent, now);
    if (!summary) continue;
    const candidate = {
      at: agent.activity.at,
      text: summary.text,
      agentName: agent.name,
    };
    if (!latest || candidate.at > latest.at) latest = candidate;
  }
  if (!latest && !hasExplicitWait) {
    latest = snapshot.logs?.reduce<{ at: number; text: string } | undefined>((current, log) => {
      const text = sanitizeInline(log.message);
      if (!text || (current && current.at > log.at)) return current;
      return { at: log.at, text };
    }, undefined);
  }
  if (!latest) {
    const agent = [...snapshot.agents].reverse().find((candidate) => candidate.state === "running");
    const fallback = agent ? activeAgentSummary(agent, now) : undefined;
    if (fallback) latest = { at: -1, text: fallback.text };
  }
  if (latest && snapshot.agents.filter((agent) => agent.state === "running").length > 1) {
    if (latest.agentName) latest.text = `${sanitizeInline(latest.agentName)}: ${latest.text}`;
  }
  return latest;
}

/** Operator-first semantic summary for a workflow run dashboard row. */
export function workflowDashboardSummary(snapshot: WorkflowSnapshot, now: number): DashboardSummary {
  const waiting = [...snapshot.agents].reverse().find((agent) => agent.waitingOn)?.waitingOn;
  if (waiting) {
    const count = workflowNeedsInput(snapshot);
    return {
      kind: "input",
      text: `${count} need input: ${formatWorkflowInteraction(waiting, now)}`,
    };
  }

  const answering = [...snapshot.agents].reverse().find((agent) => agent.answering);
  const providerWait = [...snapshot.agents].reverse().find((agent) => agent.state === "waiting" && agent.providerWait);
  if (answering && providerWait) return workflowAgentDashboardSummary(answering, now);
  if (providerWait) {
    return {
      kind: "wait",
      text: `${sanitizeInline(providerWait.name)}: ${formatProviderWait(providerWait, now)}`,
    };
  }

  const failedAgent = [...snapshot.agents].reverse().find((agent) => agent.state === "failed");
  const failedPhase = [...snapshot.phases].reverse().find((phase) => phase.status === "failed");
  const activeFailure = snapshot.status === "pending" || snapshot.status === "running" || snapshot.status === "paused";
  if (snapshot.error || snapshot.status === "failed" || (activeFailure && (failedAgent || failedPhase))) {
    const fallback = failedAgent
      ? `${sanitizeInline(failedAgent.name)} failed`
      : failedPhase
        ? `${sanitizeInline(failedPhase.name)} phase failed`
        : "Workflow failed";
    return {
      kind: "failure",
      text: summaryPreview(snapshot.error ?? failedAgent?.error ?? failedPhase?.error) || fallback,
    };
  }
  if (answering) return workflowAgentDashboardSummary(answering, now);
  if (snapshot.status === "pending" || snapshot.agents.some((agent) => agent.state === "queued")) {
    return { kind: "wait", text: "queued for workflow dispatch" };
  }
  if (snapshot.status === "running") {
    const activity = latestActiveWorkflowSummary(snapshot, now);
    if (activity) return { kind: "activity", text: activity.text };
  }

  if (snapshot.status === "paused") {
    return { kind: "wait", text: "paused by operator" };
  }

  if (snapshot.status === "completed") {
    const latestAgent = [...snapshot.agents].reverse().find((agent) => agent.state === "completed");
    const result = summaryPreview(snapshot.result)
      || summaryPreview(latestAgent?.output)
      || summaryPreview(latestAgent?.preview);
    const outcome = snapshot.taskOutcome && snapshot.taskOutcome !== "unspecified"
      ? `task ${snapshot.taskOutcome}`
      : "";
    return {
      kind: "result",
      text: [outcome, result || "completed without a result preview"].filter(Boolean).join(": "),
    };
  }
  return { kind: "lifecycle", text: snapshot.status };
}

/** Quiet fallback copy for an agent with no semantic preview yet — avoids restating "running",
 *  which the header and phase spine already convey. */
function agentActivity(agent: WorkflowAgentRecord, now: number): string {
  const interaction = workflowAgentInteraction(agent, now);
  if (interaction) return interaction;
  if (agent.state === "waiting") return formatProviderWait(agent, now) ?? "waiting for provider";
  switch (agent.state) {
    case "queued": return "waiting to start";
    case "running": return formatAgentActivity(agent.activity, now);
    case "completed": return "done";
    default: return agent.state;
  }
}

/** The focused agent's name, routing, and activity — no status glyph, since the header and phase
 *  spine already carry the workflow's running state. */
function latestValue(snapshot: WorkflowSnapshot, theme: Theme, now: number): string | undefined {
  const agent = focusedAgent(snapshot);
  if (!agent) return undefined;
  return `${theme.fg("toolTitle", sanitizeInline(agent.name))}${theme.fg("dim", `(${sanitizeInline(agent.model ?? "default")}·${formatEffort(agent.effort)})`)} ${theme.fg("dim", "·")} ${theme.fg("muted", agentActivity(agent, now))}`;
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
  const continuationAttempt = agent.attempts?.find((attempt) => attempt.disposition === "continuation");
  const fallbackAttempt = agent.attempts?.find((attempt) => attempt.disposition === "fallback");
  const routeLabel = continuationAttempt
    ? `${sanitizeInline(continuationAttempt.requestedHarness ?? continuationAttempt.harness ?? "primary")} → ${sanitizeInline(agent.harness ?? "replacement")} (continued)`
    : fallbackAttempt
    ? `${sanitizeInline(fallbackAttempt.requestedHarness ?? fallbackAttempt.harness ?? "primary")} → ${sanitizeInline(agent.harness ?? "fallback")} (fallback)`
    : agent.harness || agent.model
      ? `${sanitizeInline(agent.harness ?? "harness")}/${sanitizeInline(agent.model ?? "model")}`
      : undefined;
  const route = routeLabel
    ? ` · ${routeLabel}`
    : "";
  const profile = agent.profile ? ` · profile ${sanitizeInline(agent.profile)}` : "";
  const independent = agent.independent ? " · independent" : "";
  const warning = agent.instructionShaped ? " · ⚠ instruction-like output" : "";
  const isolation = agent.isolation ? ` · worktree ${agent.isolation.state}` : "";
  return `${GROUP_INDENT}${theme.fg(status.color, status.glyph)} ${theme.fg("toolTitle", sanitizeInline(agent.name))} ${theme.fg("dim", `${agent.access}${profile}${independent} · ${agent.state}${route} · effort ${agent.effort ?? "adaptive"}${isolation}${warning}`)}`;
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

  // Convergence: one line whenever the run drove a bounded implement/review loop.
  if (snapshot.convergence) {
    const meta = workflowConvergenceMeta(snapshot.convergence);
    lines.push(group(theme, "Rounds", `${theme.fg(meta.color, meta.glyph)} ${theme.fg(isAttentionStatus(meta.color) ? meta.color : "muted", formatWorkflowConvergence(snapshot.convergence, options.expanded ? 200 : 80))}`));
  }

  // Agents: collapsed is always a rollup of counts; roster rows expand only.
  const needInput = workflowNeedsInput(snapshot);
  lines.push(group(theme, "Agents", agentRollupValue(snapshot, theme)
    + (needInput ? theme.fg("warning", ` · ? ${needInput} need input`) : "")));
  if (options.expanded) {
    const roster = snapshot.agents.slice(-MAX_AGENTS_EXPANDED);
    const hiddenBefore = snapshot.agents.length - roster.length;
    if (hiddenBefore > 0) lines.push(`${GROUP_INDENT}${theme.fg("muted", `⋯ ${hiddenBefore} earlier agent${hiddenBefore === 1 ? "" : "s"}`)}`);
    for (const agent of roster) lines.push(agentRow(agent, theme, options.now));
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
