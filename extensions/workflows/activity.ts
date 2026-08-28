import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { workflowIsTerminal } from "../../src/workflows/manager.ts";
import type { WorkflowAgentRecord, WorkflowSnapshot, WorkflowStatus } from "../../src/workflows/types.ts";
import { sanitizeInline } from "../subagents/render.ts";
import { formatWorkflowInteraction, workflowNeedsInput, workflowPhaseProgress } from "./render.ts";

const MAX_ACTIVITY_CHARS = 180;

export interface WorkflowActivityRow {
  readonly runId: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly phase: string;
  readonly state: string;
  readonly route?: string;
  readonly activity?: string;
  readonly attention: boolean;
  readonly terminal: boolean;
}

export interface WorkflowActivitySnapshot {
  readonly rows: readonly WorkflowActivityRow[];
  readonly active: number;
  readonly attention: number;
  /** Terminal rows waiting for the final result delivery callback. */
  readonly finishing: number;
  /** Changes only when row content changes, not as time passes. */
  readonly key: string;
}

export interface WorkflowActivityRenderOptions {
  /** Direct-job context retained in the shared session widget. */
  context?: string;
  /** Keyboard hint for the existing workflow supervision surface. */
  openHint?: string;
}

function bounded(value: string | undefined, max = MAX_ACTIVITY_CHARS): string | undefined {
  const clean = value ? sanitizeInline(value) : "";
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function activeAgent(agent: WorkflowAgentRecord): boolean {
  return agent.state === "queued" || agent.state === "running" || agent.state === "waiting" || !!agent.waitingOn || !!agent.answering;
}

function focusedAgent(snapshot: WorkflowSnapshot): WorkflowAgentRecord | undefined {
  return [...snapshot.agents].reverse().find(activeAgent) ?? snapshot.agents.at(-1);
}

function phaseLabel(snapshot: WorkflowSnapshot): string {
  const progress = workflowPhaseProgress(snapshot);
  if (progress.phase) {
    const name = bounded(progress.phase.name, 100) ?? "phase";
    return `${name} ${progress.label}`;
  }
  if (progress.waiting) return "waiting for phase";
  return progress.noPhases ? "no phase" : progress.label;
}

function routeLabel(agent: WorkflowAgentRecord | undefined): string | undefined {
  if (!agent) return undefined;
  const fallback = agent.attempts?.find((attempt) => attempt.disposition === "fallback");
  if (fallback) {
    const requested = bounded(agent.requestedHarness ?? fallback.requestedHarness ?? fallback.harness) ?? "primary";
    const effective = bounded(agent.harness ?? fallback.harness) ?? "fallback";
    const model = bounded(agent.model ?? fallback.model);
    return `${requested} → ${effective}${model ? `/${model}` : ""} (fallback)`;
  }
  const harness = bounded(agent.harness ?? agent.requestedHarness);
  const model = bounded(agent.model);
  if (harness && model) return `${harness}/${model}`;
  return harness ?? model;
}

function providerWaitLabel(agent: WorkflowAgentRecord, now: number): string | undefined {
  const wait = agent.providerWait;
  if (!wait) return undefined;
  const remaining = Math.max(0, wait.retryAt - now);
  const retry = remaining < 60_000
    ? `${Math.max(1, Math.round(remaining / 1_000))}s`
    : `${Math.round(remaining / 60_000)}m`;
  return `waiting for ${sanitizeInline(wait.provider)} ${sanitizeInline(wait.kind)} · retry in ${retry} · attempt ${wait.attempt}/${wait.maxAttempts}`;
}

function activityLabel(snapshot: WorkflowSnapshot, agent: WorkflowAgentRecord | undefined, now: number): string | undefined {
  if (agent?.waitingOn) return bounded(formatWorkflowInteraction(agent.waitingOn, now));
  if (agent?.answering) return bounded(`answering peer question from ${agent.answering.sourceName}`);
  if (agent) {
    const providerWait = providerWaitLabel(agent, now);
    if (providerWait) return bounded(providerWait);
    if (agent.preview) return bounded(agent.preview);
  }
  const latestLog = snapshot.logs?.at(-1)?.message;
  if (latestLog) return bounded(latestLog);
  if (!agent) return snapshot.status === "pending" ? "waiting to start" : snapshot.status === "running" ? "starting" : undefined;
  switch (agent.state) {
    case "queued": return "waiting to start";
    case "running": return "in progress";
    case "waiting": return "waiting for provider";
    case "completed": return snapshot.taskOutcome ? `task ${snapshot.taskOutcome}` : "done";
    default: return agent.state;
  }
}

function stateLabel(snapshot: WorkflowSnapshot, agent: WorkflowAgentRecord | undefined): string {
  if (workflowNeedsInput(snapshot)) return "needs input";
  if (snapshot.status === "running" && agent?.state === "queued") return "queued";
  if (snapshot.status === "running" && agent?.state === "waiting") return "waiting";
  if (snapshot.status === "completed" && snapshot.taskOutcome === "unsuccessful") return "unsuccessful";
  return snapshot.status;
}

function needsAttention(snapshot: WorkflowSnapshot, agent: WorkflowAgentRecord | undefined): boolean {
  return workflowNeedsInput(snapshot) > 0
    || snapshot.status === "paused"
    || snapshot.status === "failed"
    || snapshot.status === "aborted"
    || snapshot.taskOutcome === "unsuccessful"
    || agent?.state === "failed"
    || agent?.state === "cancelled"
    || agent?.state === "aborted";
}

/** Converts a durable snapshot to the small, credential-free row shown above the editor. */
export function workflowActivityRow(snapshot: WorkflowSnapshot, now = Date.now()): WorkflowActivityRow {
  const agent = focusedAgent(snapshot);
  return {
    runId: snapshot.runId,
    name: bounded(snapshot.name, 120) ?? "workflow",
    status: snapshot.status,
    phase: phaseLabel(snapshot),
    state: stateLabel(snapshot, agent),
    route: routeLabel(agent),
    activity: activityLabel(snapshot, agent, now),
    attention: needsAttention(snapshot, agent),
    terminal: workflowIsTerminal(snapshot.status),
  };
}

/**
 * Session-owned workflow activity state. A Map deliberately preserves the first
 * insertion position when a run publishes later lifecycle snapshots.
 */
export class WorkflowActivityStore {
  readonly #runs = new Map<string, WorkflowSnapshot>();
  readonly #delivered = new Set<string>();

  observe(snapshot: WorkflowSnapshot): boolean {
    if (this.#delivered.has(snapshot.runId)) return false;
    const previous = this.#runs.get(snapshot.runId);
    if (previous && previous.timestamps.updatedAt > snapshot.timestamps.updatedAt) return false;
    this.#runs.set(snapshot.runId, snapshot);
    return previous !== snapshot;
  }

  /** Removes a row only after its existing result delivery path has completed. */
  markDelivered(runId: string): boolean {
    this.#delivered.add(runId);
    return this.#runs.delete(runId);
  }

  reset(): void {
    this.#runs.clear();
    this.#delivered.clear();
  }

  snapshot(now = Date.now()): WorkflowActivitySnapshot {
    const rows = [...this.#runs.values()].map((run) => workflowActivityRow(run, now));
    const active = rows.filter((row) => !row.terminal).length;
    const attention = rows.filter((row) => row.attention).length;
    const finishing = rows.filter((row) => row.terminal).length;
    const key = JSON.stringify(rows.map((row) => [
      row.runId,
      row.name,
      row.status,
      row.phase,
      row.state,
      row.route,
      row.activity,
      row.attention,
      row.terminal,
    ]));
    return { rows, active, attention, finishing, key };
  }
}

type RowField = "phase" | "state" | "route" | "activity";

function rowText(row: WorkflowActivityRow, marker: string, fields: readonly RowField[]): string {
  const values = fields.map((field) => row[field]).filter((value): value is string => !!value);
  return `${marker} ${row.name}${values.length ? ` · ${values.join(" · ")}` : ""}`;
}

function styledRow(
  row: WorkflowActivityRow,
  marker: string,
  fields: readonly RowField[],
  theme: Theme,
  overrides: Partial<Record<RowField, string>> = {},
): string {
  const values = fields
    .map((field) => {
      const value = overrides[field] ?? row[field];
      if (!value) return undefined;
      const color = field === "state" ? row.attention ? "warning" : "dim" : field === "phase" ? "muted" : "dim";
      return theme.fg(color, value);
    })
    .filter((value): value is string => value !== undefined);
  const details = values.length ? ` ${values.join(theme.fg("dim", " · "))}` : "";
  return `${theme.fg("dim", marker)} ${theme.fg("toolTitle", row.name)}${details}`;
}

function narrowRow(row: WorkflowActivityRow, marker: string, theme: Theme, width: number): string {
  const prefix = `${marker} `;
  const suffix = ` · ${row.state}`;
  const nameWidth = width - visibleWidth(prefix) - visibleWidth(suffix);
  if (nameWidth > 0) {
    const name = truncateToWidth(row.name, nameWidth, "");
    return `${theme.fg("dim", marker)} ${theme.fg("toolTitle", name)}${theme.fg(row.attention ? "warning" : "dim", suffix)}`;
  }
  return truncateToWidth(`${theme.fg("dim", marker)} ${theme.fg(row.attention ? "warning" : "dim", row.state)}`, width, "");
}

function renderRow(row: WorkflowActivityRow, index: number, total: number, theme: Theme, width: number): string {
  const marker = index === total - 1 ? "└─" : "├─";
  const candidates: readonly (readonly RowField[])[] = [
    ["phase", "state", "route", "activity"],
    ["phase", "state", "route"],
    ["phase", "state"],
    ["state"],
    [],
  ];
  for (const fields of candidates) {
    if (visibleWidth(rowText(row, marker, fields)) <= width) return styledRow(row, marker, fields, theme);
  }
  const compactFields: readonly RowField[] = ["phase", "state", "route"];
  const compact = rowText(row, marker, compactFields);
  if (row.activity && visibleWidth(compact) <= width) {
    const activityWidth = width - visibleWidth(compact) - visibleWidth(" · ");
    if (activityWidth >= 8) {
      const activity = truncateToWidth(row.activity, activityWidth, "…");
      return styledRow(row, marker, [...compactFields, "activity"], theme, { activity });
    }
  }
  return narrowRow(row, marker, theme, width);
}

function summary(snapshot: WorkflowActivitySnapshot): string {
  const parts = [`${snapshot.active} active`];
  if (snapshot.finishing) parts.push(`${snapshot.finishing} finishing`);
  if (snapshot.attention) parts.push(`${snapshot.attention} need attention`);
  return parts.join(" · ");
}

/** Renders the one session-level workflow widget, with context dropped from right to left. */
export function renderWorkflowActivity(
  snapshot: WorkflowActivitySnapshot,
  theme: Theme,
  width: number,
  options: WorkflowActivityRenderOptions = {},
): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  if (!safeWidth || !snapshot.rows.length) return [];
  const context = options.context ? ` · ${sanitizeInline(options.context)}` : "";
  const hint = options.openHint ? ` · ${sanitizeInline(options.openHint)}` : "";
  const header = `${theme.fg("accent", "◆")} ${theme.fg("toolTitle", "Workflows")}${theme.fg("dim", ` · ${summary(snapshot)}${context} · /workflows${hint}`)}`;
  return [
    truncateToWidth(header, safeWidth, ""),
    ...snapshot.rows.map((row, index) => renderRow(row, index, snapshot.rows.length, theme, safeWidth)),
  ];
}
