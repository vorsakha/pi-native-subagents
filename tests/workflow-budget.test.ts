import test from "node:test";
import assert from "node:assert/strict";
import { workflowBudgetMetrics } from "../src/workflows/budget.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

test("calculates workflow budget usage with bounded remaining values", () => {
  const snapshot = {
    budget: { maxAgents: 4, maxConcurrency: 2, maxTokens: 100, maxTurns: 5, maxCost: 1 },
    agents: [{ state: "completed" }, { state: "running" }, { state: "queued" }],
  } as Pick<WorkflowSnapshot, "budget" | "agents">;
  const usage = { input: 60, output: 25, cost: 1.25, turns: 6 };

  assert.deepEqual(workflowBudgetMetrics(snapshot, usage), [
    { key: "agents", used: 3, limit: 4, remaining: 1, reached: false, supported: true },
    { key: "concurrency", used: 2, limit: 2, remaining: 0, reached: true, supported: true },
    { key: "tokens", used: 85, limit: 100, remaining: 15, reached: false, supported: true },
    { key: "turns", used: 6, limit: 5, remaining: 0, reached: true, supported: true },
    { key: "cost", used: 1.25, limit: 1, remaining: 0, reached: true, supported: true },
  ]);
});
