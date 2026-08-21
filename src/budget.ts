import type { HarnessName, Usage } from "./types.ts";

export interface SpendBudget {
  maxTokens?: number;
  maxCost?: number;
  maxTurns?: number;
}

export type SpendMetric = "tokens" | "cost" | "turns";

export interface SpendBudgetMetric {
  key: SpendMetric;
  used: number;
  limit: number;
  reached: boolean;
  supported: boolean;
}

export function spendMetricSupport(harness: HarnessName): Readonly<Record<SpendMetric, boolean>> {
  return { tokens: true, cost: harness !== "codex", turns: true };
}

export function validateSpendBudget(budget: SpendBudget | undefined, label = "Budget"): SpendBudget | undefined {
  if (budget === undefined) return undefined;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new Error(`${label} must be an object`);
  const integer = (name: "maxTokens" | "maxTurns", maximum: number) => {
    const value = budget[name];
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${label} ${name} must be an integer from 1 to ${maximum}`);
    }
    return value;
  };
  const maxCost = budget.maxCost;
  if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 10_000)) {
    throw new Error(`${label} maxCost must be a positive number no greater than 10000`);
  }
  const normalized = {
    maxTokens: integer("maxTokens", 100_000_000),
    maxCost,
    maxTurns: integer("maxTurns", 10_000),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

export function assertSupportedSpendBudget(budget: SpendBudget | undefined, harness: HarnessName): void {
  if (budget?.maxCost !== undefined && !spendMetricSupport(harness).cost) {
    throw new Error(`Budget maxCost is unsupported by the ${harness} route because it does not report cost`);
  }
}

export function spendBudgetMetrics(
  budget: SpendBudget | undefined,
  usage: Pick<Usage, "input" | "output" | "cost" | "turns">,
  harness: HarnessName,
): SpendBudgetMetric[] {
  if (!budget) return [];
  const support = spendMetricSupport(harness);
  const values = [
    ["tokens", usage.input + usage.output, budget.maxTokens],
    ["cost", usage.cost, budget.maxCost],
    ["turns", usage.turns, budget.maxTurns],
  ] as const;
  return values.flatMap(([key, used, limit]) => limit === undefined ? [] : [{
    key,
    used: Math.max(0, used),
    limit,
    reached: used >= limit,
    supported: support[key],
  }]);
}

export function reachedSpendWarning(metric: SpendBudgetMetric, scope = "Budget"): string | undefined {
  if (!metric.supported || !metric.reached) return undefined;
  const used = metric.key === "cost" ? `$${metric.used.toFixed(4)}` : String(metric.used);
  const limit = metric.key === "cost" ? `$${metric.limit.toFixed(4)}` : String(metric.limit);
  return `${scope} ${metric.key} limit reached (${used}/${limit}); later dispatches are blocked`;
}

export function firstReachedSpendWarning(
  budget: SpendBudget | undefined,
  usage: Pick<Usage, "input" | "output" | "cost" | "turns">,
  harness: HarnessName,
  scope = "Budget",
): string | undefined {
  return spendBudgetMetrics(budget, usage, harness).map((metric) => reachedSpendWarning(metric, scope)).find(Boolean);
}

export function formatSpendBudget(
  budget: SpendBudget | undefined,
  usage: Pick<Usage, "input" | "output" | "cost" | "turns">,
  harness: HarnessName,
): string {
  if (!budget) return "open";
  return spendBudgetMetrics(budget, usage, harness).map((metric) => {
    if (!metric.supported) return `${metric.key} unsupported`;
    const used = metric.key === "cost" ? `$${metric.used.toFixed(4)}` : String(metric.used);
    const limit = metric.key === "cost" ? `$${metric.limit.toFixed(4)}` : String(metric.limit);
    return `${metric.key} ${used}/${limit}${metric.reached ? " reached" : ""}`;
  }).join(" · ") || "open";
}
