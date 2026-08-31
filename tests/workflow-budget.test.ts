import test from "node:test";
import assert from "node:assert/strict";
import { formatWorkflowBudget, workflowBudgetHealth, workflowBudgetMetrics } from "../src/workflows/budget.ts";
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

test("agentTokens tolerates agents with missing or partial usage", () => {
  const snapshot = {
    budget: { maxTokensPerAgent: 100 },
    agents: [
      { state: "completed", usage: undefined },
      { state: "completed", usage: { input: 40 } },
      { state: "completed", usage: { output: 30 } },
    ],
  } as unknown as Pick<WorkflowSnapshot, "budget" | "agents">;

  const [agentTokens] = workflowBudgetMetrics(snapshot, { input: 0, output: 0, cost: 0, turns: 0 });
  assert.equal(agentTokens?.key, "agentTokens");
  assert.equal(agentTokens?.used, 40, "the partial-input agent's contribution is not collapsed to 0");
});

test("formatWorkflowBudget always returns a string, never undefined, for an open budget", () => {
  const open: string = formatWorkflowBudget({ budget: undefined, agents: [] }, { input: 0, output: 0, cost: 0, turns: 0 });
  assert.equal(open, "open");
});

test("workflowBudgetHealth reports open for an unset budget", () => {
  const health = workflowBudgetHealth({ budget: undefined, agents: [] }, { input: 0, output: 0, cost: 0, turns: 0 });
  assert.deepEqual(health, { text: "budget open", abnormal: false });
});

test("workflowBudgetHealth names an unsupported explicit metric and marks it abnormal instead of reporting budget ok", () => {
  const snapshot = {
    budget: { maxCost: 1 },
    agents: [{ state: "completed", harness: "codex" }],
  } as Pick<WorkflowSnapshot, "budget" | "agents">;
  const health = workflowBudgetHealth(snapshot, { input: 0, output: 0, cost: 0.01, turns: 1 });
  assert.match(health.text, /cost unsupported/);
  assert.equal(health.abnormal, true, "an unsupported explicit metric is never presented as budget ok");
  assert.doesNotMatch(health.text, /\bbudget ok\b/);
});

test("workflowBudgetHealth treats maxConcurrency saturation as normal scheduling, not exhaustion or a warning", () => {
  const snapshot = {
    budget: { maxConcurrency: 2 },
    agents: [{ state: "running" }, { state: "running" }, { state: "queued" }],
  } as Pick<WorkflowSnapshot, "budget" | "agents">;
  const health = workflowBudgetHealth(snapshot, { input: 0, output: 0, cost: 0, turns: 0 });
  assert.deepEqual(health, { text: "budget ok", abnormal: false });
});

test("workflowBudgetHealth distinctly names hard call and spend exhaustion as abnormal", () => {
  const agentsExhausted = {
    budget: { maxAgents: 2 },
    agents: [{ state: "completed" }, { state: "completed" }],
  } as Pick<WorkflowSnapshot, "budget" | "agents">;
  assert.deepEqual(
    workflowBudgetHealth(agentsExhausted, { input: 0, output: 0, cost: 0, turns: 0 }),
    { text: "budget reached (agents)", abnormal: true },
  );

  const spendExhausted = {
    budget: { maxTokens: 10, maxTurns: 2, maxCost: 1 },
    agents: [{ state: "completed" }],
  } as Pick<WorkflowSnapshot, "budget" | "agents">;
  assert.deepEqual(
    workflowBudgetHealth(spendExhausted, { input: 8, output: 5, cost: 1.5, turns: 3 }),
    { text: "budget reached (tokens, turns, cost)", abnormal: true },
  );
});

test("advisor turns contribute to workflow call, concurrency, per-call token, and route accounting", () => {
  const snapshot = {
    budget: { maxAgents: 2, maxConcurrency: 1, maxTokensPerAgent: 10, maxCost: 1 },
    agents: [],
    advisorConsultations: [{
      state: "running",
      harness: "codex",
      usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    }],
  } as unknown as Pick<WorkflowSnapshot, "budget" | "agents" | "advisorConsultations">;

  assert.deepEqual(workflowBudgetMetrics(snapshot, { input: 8, output: 4, cost: 0, turns: 1 }), [
    { key: "agents", used: 1, limit: 2, remaining: 1, reached: false, supported: true },
    { key: "concurrency", used: 1, limit: 1, remaining: 0, reached: true, supported: true },
    { key: "agentTokens", used: 12, limit: 10, remaining: 0, reached: true, supported: true },
    { key: "cost", used: 0, limit: 1, remaining: 1, reached: false, supported: false },
  ]);
  assert.deepEqual(
    workflowBudgetHealth(snapshot, { input: 8, output: 4, cost: 0, turns: 1 }),
    { text: "budget reached (agentTokens) · cost unsupported", abnormal: true },
  );
});
