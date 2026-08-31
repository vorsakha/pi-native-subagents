import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  WorkflowAgentRecord,
  WorkflowAgentState,
  WorkflowPhase,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowTaskOutcome,
} from "../src/workflows/types.ts";
import { renderWorkflowActivity, WorkflowActivityStore } from "../extensions/workflows/activity.ts";
import { theme } from "./helpers.ts";

interface WorkflowFixtureOptions {
  runId: string;
  name: string;
  updatedAt?: number;
  status?: WorkflowStatus;
  agentState?: WorkflowAgentState;
  phaseName?: string;
  preview?: string;
  taskOutcome?: WorkflowTaskOutcome;
}

function workflowFixture(options: WorkflowFixtureOptions): WorkflowSnapshot {
  const status = options.status ?? "running";
  const agentState = options.agentState ?? (status === "completed" ? "completed" : status === "failed" ? "failed" : "running");
  const updatedAt = options.updatedAt ?? 1;
  const timestamps = { createdAt: 1, updatedAt, startedAt: 1 };
  const phase: WorkflowPhase = {
    index: 0,
    name: options.phaseName ?? "implementing",
    status,
    timestamps,
    agents: [0],
  };
  const agent: WorkflowAgentRecord = {
    index: 0,
    name: "builder",
    access: "readOnly",
    independent: false,
    phase: 0,
    state: agentState,
    timestamps,
    harness: "pi",
    model: "pi-model",
    effort: "medium",
    preview: options.preview,
    activity: options.preview ? { kind: "responding", at: updatedAt } : undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
  return {
    runId: options.runId,
    sessionId: "session",
    name: options.name,
    description: "",
    background: true,
    status,
    ...(options.taskOutcome ? { taskOutcome: options.taskOutcome } : {}),
    timestamps,
    currentPhase: 0,
    phases: [phase],
    plannedPhaseCount: 1,
    agents: [agent],
    artifactDir: "/private/workflows",
  };
}

test("concurrent workflow insertion is aggregated once and lifecycle updates preserve row order", () => {
  const store = new WorkflowActivityStore();
  store.observe(workflowFixture({ runId: "wf_a", name: "first", updatedAt: 1 }));
  store.observe(workflowFixture({ runId: "wf_b", name: "second", updatedAt: 1 }));
  store.observe(workflowFixture({ runId: "wf_a", name: "first revised", updatedAt: 2, phaseName: "reviewing" }));
  store.observe(workflowFixture({ runId: "wf_a", name: "stale first", updatedAt: 1 }));

  const activity = store.snapshot(10);
  assert.deepEqual(activity.rows.map((row) => row.runId), ["wf_a", "wf_b"]);
  assert.equal(activity.rows.length, 2);
  assert.equal(activity.rows[0]?.name, "first revised");
  assert.equal(activity.rows[0]?.phase, "reviewing 1/1");
  assert.equal(activity.active, 2);
});

test("completed workflows remain until delivery, then leave without disturbing active rows", () => {
  const store = new WorkflowActivityStore();
  store.observe(workflowFixture({ runId: "wf_done", name: "done", updatedAt: 1 }));
  store.observe(workflowFixture({ runId: "wf_live", name: "live", updatedAt: 1 }));
  store.observe(workflowFixture({ runId: "wf_done", name: "done", updatedAt: 2, status: "completed", agentState: "completed", taskOutcome: "successful" }));

  let activity = store.snapshot(10);
  assert.deepEqual(activity.rows.map((row) => row.runId), ["wf_done", "wf_live"]);
  assert.equal(activity.finishing, 1);
  assert.equal(activity.active, 1);

  assert.equal(store.markDelivered("wf_done"), true);
  assert.equal(store.markDelivered("wf_done"), false);
  store.observe(workflowFixture({ runId: "wf_done", name: "late terminal update", updatedAt: 3, status: "completed", agentState: "completed" }));
  activity = store.snapshot(10);
  assert.deepEqual(activity.rows.map((row) => row.runId), ["wf_live"]);
  assert.equal(activity.active, 1);
  assert.equal(activity.finishing, 0);
});

test("reset clears old session identity and permits the next session to reuse its state", () => {
  const store = new WorkflowActivityStore();
  store.observe(workflowFixture({ runId: "wf_old", name: "old" }));
  store.reset();
  assert.deepEqual(store.snapshot().rows, []);

  store.observe(workflowFixture({ runId: "wf_old", name: "new session" }));
  assert.deepEqual(store.snapshot().rows.map((row) => row.name), ["new session"]);
});

test("workflow activity keeps textual status and never exceeds narrow terminal widths", () => {
  const store = new WorkflowActivityStore();
  store.observe(workflowFixture({
    runId: "wf_narrow",
    name: "a deliberately long workflow name",
    phaseName: "availability discovery",
    preview: "checking the selected route and gathering useful live activity",
  }));
  const activity = store.snapshot(10);
  const wide = renderWorkflowActivity(activity, theme, 200, { openHint: "Ctrl+Shift+F" }).join("\n");
  assert.match(wide, /Workflows · 1 active/);
  assert.match(wide, /a deliberately long workflow name/);
  assert.match(wide, /availability discovery 1\/1/);
  assert.match(wide, /running/);
  assert.match(wide, /pi\/pi-model/);
  assert.match(wide, /Drafting response/);
  assert.match(wide, /\/workflows/);
  assert.match(wide, /Ctrl\+Shift\+F/);

  for (const width of [1, 2, 4, 8, 12, 20, 40, 80]) {
    for (const line of renderWorkflowActivity(activity, theme, width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${line}`);
    }
  }
});

test("workflow editor rows show a retained peer answer ahead of other run activity", () => {
  const run = workflowFixture({ runId: "wf_peer_answer", name: "peer answer" });
  const active = run.agents[0]!;
  active.state = "completed";
  active.activity = undefined;
  active.answering = { requestId: "peer-1", sourceAgentIndex: 1, sourceName: "reviewer" };
  run.agents.push({
    ...run.agents[0]!,
    index: 1,
    name: "provider wait",
    state: "waiting",
    answering: undefined,
    providerWait: { provider: "codex", kind: "quota", detail: "limit", retryAt: 66_000, attempt: 1, maxAttempts: 3 },
  });

  const store = new WorkflowActivityStore();
  store.observe(run);
  const snapshot = store.snapshot(6_000);
  assert.equal(snapshot.rows[0]?.activity, "answering peer question from reviewer");
  assert.match(renderWorkflowActivity(snapshot, theme, 160).join("\n"), /answering peer question from reviewer/);
  assert.doesNotMatch(renderWorkflowActivity(snapshot, theme, 160).join("\n"), /waiting for codex quota/);
});
