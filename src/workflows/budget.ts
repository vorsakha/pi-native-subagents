import type { WorkflowBudgetPolicy, WorkflowSnapshot, WorkflowUsage } from "./types.ts";

export interface WorkflowBudgetMetric {
  key: "agents" | "concurrency" | "tokens" | "turns" | "cost";
  used: number;
  limit: number;
  remaining: number;
}

function metric(key: WorkflowBudgetMetric["key"], used: number, limit: number | undefined): WorkflowBudgetMetric | undefined {
  if (limit === undefined) return undefined;
  return {
    key,
    used: Math.max(0, used),
    limit,
    remaining: Math.max(0, limit - used),
  };
}

export function workflowBudgetMetrics(
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): WorkflowBudgetMetric[] {
  const budget = snapshot.budget;
  if (!budget) return [];
  const activeAgents = snapshot.agents.filter((agent) => agent.state === "queued" || agent.state === "running").length;
  const tokens = usage.input + usage.output;
  return [
    metric("agents", snapshot.agents.length, budget.maxAgents),
    metric("concurrency", activeAgents, budget.maxConcurrency),
    metric("tokens", tokens, budget.maxTokens),
    metric("turns", usage.turns, budget.maxTurns),
    metric("cost", usage.cost, budget.maxCost),
  ].filter((value): value is WorkflowBudgetMetric => value !== undefined);
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function metricText(value: WorkflowBudgetMetric): string {
  if (value.key === "cost") {
    return `cost $${value.used.toFixed(4)}/$${value.limit.toFixed(4)} (${value.remaining > 0 ? `$${value.remaining.toFixed(4)} remaining` : "0 remaining"})`;
  }
  return `${value.key} ${numberText(value.used)}/${numberText(value.limit)} (${numberText(value.remaining)} remaining)`;
}

export function formatWorkflowBudget(
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): string | undefined {
  const metrics = workflowBudgetMetrics(snapshot, usage);
  return metrics.length ? metrics.map(metricText).join(" · ") : undefined;
}
