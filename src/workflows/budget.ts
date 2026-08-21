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
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): WorkflowBudgetMetric[] {
  const budget = snapshot.budget;
  if (!budget) return [];
  const activeAgents = snapshot.agents.filter((agent) => agent.state === "queued" || agent.state === "running").length;
  const tokens = usage.input + usage.output;
  const agentTokens = snapshot.agents.reduce((maximum, agent) => Math.max(maximum, agent.usage?.input + agent.usage?.output || 0), 0);
  return [
    metric("agents", snapshot.agents.length, budget.maxAgents),
    metric("concurrency", activeAgents, budget.maxConcurrency),
    metric("tokens", tokens, budget.maxTokens),
    metric("agentTokens", agentTokens, budget.maxTokensPerAgent),
    metric("turns", usage.turns, budget.maxTurns),
    metric("cost", usage.cost, budget.maxCost, !snapshot.agents.some((agent) => agent.harness === "codex")),
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
  snapshot: Pick<WorkflowSnapshot, "budget" | "agents">,
  usage: Pick<WorkflowUsage, "input" | "output" | "cost" | "turns">,
): string | undefined {
  const metrics = workflowBudgetMetrics(snapshot, usage);
  return metrics.length ? metrics.map(metricText).join(" · ") : "open";
}
