import type { WorkflowBudgetPolicy, WorkflowSnapshot, WorkflowUsage } from "./types.ts";

export interface WorkflowBudgetMetric {
  key: "agents" | "concurrency" | "tokens" | "agentTokens" | "turns" | "cost";
  used: number;
  limit: number;
  remaining: number;
  reached: boolean;
  supported: boolean;
}

function metric(key: WorkflowBudgetMetric["key"], used: number, limit: number | undefined, supported = true): WorkflowBudgetMetric | undefined {
  if (limit === undefined) return undefined;
  return {
    key,
    used: Math.max(0, used),
    limit,
    remaining: Math.max(0, limit - used),
    reached: used >= limit,
    supported,
  };
}

export function workflowBudgetMetrics(
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents" | "advisorConsultations">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): WorkflowBudgetMetric[] {
  const budget = snapshot.budget;
  if (!budget) return [];
  const advisors = snapshot.advisorConsultations ?? [];
  const activeAgents = snapshot.agents.filter((agent) => agent.state === "queued" || agent.state === "running").length
    + advisors.filter((advisor) => advisor.state === "queued" || advisor.state === "running").length;
  const tokens = usage.input + usage.output;
  // Legacy or partially persisted agent records may omit usage or individual
  // usage fields; fold each missing field to 0 instead of collapsing the
  // whole agent's contribution to 0 when only one field is present.
  const agentTokens = [...snapshot.agents, ...advisors]
    .reduce((maximum, agent) => Math.max(maximum, (agent.usage?.input ?? 0) + (agent.usage?.output ?? 0)), 0);
  const calls = snapshot.agents.reduce((total, agent) => total + Math.max(1, agent.generations?.length ?? 0), 0) + advisors.length;
  return [
    metric("agents", calls, budget.maxAgents),
    metric("concurrency", activeAgents, budget.maxConcurrency),
    metric("tokens", tokens, budget.maxTokens),
    metric("agentTokens", agentTokens, budget.maxTokensPerAgent),
    metric("turns", usage.turns, budget.maxTurns),
    metric("cost", usage.cost, budget.maxCost, ![...snapshot.agents, ...advisors].some((agent) => agent.harness === "codex")),
  ].filter((value): value is WorkflowBudgetMetric => value !== undefined);
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function metricText(value: WorkflowBudgetMetric): string {
  if (!value.supported) return `${value.key} unsupported`;
  if (value.key === "cost") {
    return `cost $${value.used.toFixed(4)}/$${value.limit.toFixed(4)} (${value.reached ? "reached" : `$${value.remaining.toFixed(4)} remaining`})`;
  }
  const label = value.key === "agentTokens" ? "agent tokens" : value.key;
  return `${label} ${numberText(value.used)}/${numberText(value.limit)} (${value.reached ? "reached" : `${numberText(value.remaining)} remaining`})`;
}

export function formatWorkflowBudget(
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents" | "advisorConsultations">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): string {
  const metrics = workflowBudgetMetrics(snapshot, usage);
  return metrics.length ? metrics.map(metricText).join(" · ") : "open";
}

export interface WorkflowBudgetHealth {
  text: string;
  abnormal: boolean;
}

/**
 * Reaching maxConcurrency is temporary scheduling saturation, not spend or
 * call exhaustion: queued agents resume as soon as a slot frees up, so it
 * never counts toward the "reached" set that marks a card abnormal.
 */
const SATURATION_METRIC_KEYS: ReadonlySet<WorkflowBudgetMetric["key"]> = new Set(["concurrency"]);

/**
 * Single semantic summary shared by the collapsed and expanded workflow
 * cards, so both surfaces agree on what counts as reached, unsupported, or
 * merely saturated. An unsupported explicit metric (e.g. Codex maxCost) is
 * always named and marked abnormal rather than silently reported "ok".
 */
export function workflowBudgetHealth(
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents" | "advisorConsultations">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): WorkflowBudgetHealth {
  const metrics = workflowBudgetMetrics(snapshot, usage);
  if (!metrics.length) return { text: "budget open", abnormal: false };
  const exhausted = metrics.filter((metric) => metric.supported && metric.reached && !SATURATION_METRIC_KEYS.has(metric.key)).map((metric) => metric.key);
  const unsupported = metrics.filter((metric) => !metric.supported).map((metric) => metric.key);
  const parts: string[] = [];
  if (exhausted.length) parts.push(`reached (${exhausted.join(", ")})`);
  if (unsupported.length) parts.push(unsupported.map((key) => `${key} unsupported`).join(", "));
  return parts.length ? { text: `budget ${parts.join(" · ")}`, abnormal: true } : { text: "budget ok", abnormal: false };
}
