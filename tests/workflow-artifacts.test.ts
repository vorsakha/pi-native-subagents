import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers.ts";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkpointWorkflow,
  createWorkflowArtifacts,
  loadWorkflowSummaries,
  writeWorkflowReport,
  writeWorkflowResult,
} from "../src/workflows/artifacts.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

function snapshot(sessionId: string, now = Date.now()): Omit<WorkflowSnapshot, "runId" | "artifactDir"> {
  return {
    sessionId,
    name: "Review change",
    description: "Run independent review agents",
    background: true,
    status: "running",
    timestamps: { createdAt: now, startedAt: now, updatedAt: now },
    currentPhase: 0,
    phases: [{
      index: 0,
      name: "review",
      status: "running",
      timestamps: { createdAt: now, startedAt: now, updatedAt: now },
      agents: [0],
    }],
    agents: [{
      index: 0,
      name: "security",
      access: "readOnly",
      profile: "reviewer",
      independent: false,
      phase: 0,
      jobId: "job-1",
      state: "running",
      timestamps: { createdAt: now, startedAt: now, updatedAt: now },
      harness: "codex",
      model: "review-model",
      preview: "working",
      transcript: [
        { kind: "user", text: "inspect" },
        { kind: "tool", phase: "start", toolId: "read-1", name: "read", args: { path: "src/index.ts" } },
        { kind: "tool", phase: "end", toolId: "read-1", name: "read", result: { content: [{ type: "text", text: "source" }], isError: false } },
        { kind: "assistant", text: "working" },
      ],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    }],
  };
}

async function fixture() {
  const parent = await tempDir("workflow-artifacts");
  return { root: join(parent, "workflows-equivalent") };
}

test("creates private workflow artifacts and redacts environment/auth values", async () => {
  const { root } = await fixture();
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => 'ok';\n",
    args: {
      topic: "safe",
      env: { OPENAI_API_KEY: "must-not-persist" },
      authorization: "Bearer must-not-persist",
      nested: { apiKey: "must-not-persist" },
    },
    snapshot: snapshot("session-a"),
  });

  assert.match(created.runId, /^wf_[a-f0-9]+$/);
  assert.equal(created.artifactDir, join(root, created.runId));
  assert.deepEqual((await readdir(created.artifactDir)).sort(), [
    "args.json", "journal.jsonl", "result.json", "script.js", "transcripts.json", "workflow.json",
  ]);
  const persisted = await readFile(join(created.artifactDir, "args.json"), "utf8");
  assert.match(persisted, /safe/);
  assert.doesNotMatch(persisted, /must-not-persist|OPENAI_API_KEY|authorization|apiKey/);

  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(created.artifactDir)).mode & 0o777, 0o700);
    for (const name of await readdir(created.artifactDir)) {
      assert.equal((await stat(join(created.artifactDir, name))).mode & 0o777, 0o600);
    }
  }
});

test("checkpoints and result writes remain atomic under concurrent updates", async () => {
  const { root } = await fixture();
  const created = await createWorkflowArtifacts(root, {
    script: "export default 1;\n",
    args: {},
    snapshot: snapshot("session-a"),
  });

  await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const next: WorkflowSnapshot = {
      ...created,
      description: `checkpoint-${index}`,
      timestamps: { ...created.timestamps, updatedAt: created.timestamps.updatedAt + index + 1 },
    };
    await checkpointWorkflow(root, next);
    await writeWorkflowResult(root, created.runId, { index });
  }));

  const workflow = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
  const result = JSON.parse(await readFile(join(created.artifactDir, "result.json"), "utf8")) as { index: number };
  assert.match(workflow.description, /^checkpoint-\d+$/);
  assert.equal(typeof result.index, "number");
  assert.deepEqual((await readdir(created.artifactDir)).filter((name) => name.includes(".tmp")), []);
});

test("loads session summaries, ignores corrupt files, and durably aborts stale runs", async () => {
  const { root } = await fixture();
  const old = 1_000;
  const first = await createWorkflowArtifacts(root, {
    script: "export default 1;\n",
    args: {},
    snapshot: snapshot("session-a", old),
  });
  await createWorkflowArtifacts(root, {
    script: "export default 2;\n",
    args: {},
    snapshot: snapshot("session-b", old),
  });
  const corruptDir = join(root, "wf_corrupt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(corruptDir, { recursive: true }));
  await writeFile(join(corruptDir, "workflow.json"), "{ definitely not json", { mode: 0o600 });

  const summaries = await loadWorkflowSummaries(root, {
    sessionId: "session-a",
    now: 10_000,
    staleAfterMs: 5_000,
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.runId, first.runId);
  assert.equal(summaries[0]!.status, "aborted");
  assert.equal(summaries[0]!.agents[0]!.state, "aborted");
  assert.equal(summaries[0]!.phases[0]!.status, "aborted");
  assert.equal(summaries[0]!.timestamps.endedAt, 10_000);

  const saved = JSON.parse(await readFile(join(first.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
  assert.equal(saved.status, "aborted");
  const transcript = summaries[0]?.agents[0]?.transcript ?? [];
  assert.equal(transcript.at(-1)?.kind, "assistant");
  const toolEntries = transcript.filter((entry) => entry.kind === "tool");
  assert.deepEqual(toolEntries.map((entry) => entry.phase), ["start", "end"]);
  assert.equal(toolEntries[0]?.args?.path, "src/index.ts");
  assert.equal(toolEntries[1]?.result?.content[0]?.text, "source");
});

test("no-resume loading aborts paused future checkpoints plus queued agents and pending phases", async () => {
  const { root } = await fixture();
  const future = 99_999_999;
  const input = snapshot("future-session", future);
  input.plannedPhaseCount = 1;
  input.status = "paused";
  input.timestamps.pausedAt = future;
  input.phases[0]!.status = "pending";
  input.agents[0]!.state = "queued";
  input.agents[0]!.waitingOn = {
    ordinal: 0,
    requestId: "req-stale",
    target: "orchestrator",
    sourceAgentIndex: 0,
    sourceName: "security",
    question: "Which policy applies?",
    state: "pending",
    createdAt: future,
  };
  input.agents[0]!.answering = { requestId: "req-other", sourceName: "planner" };
  input.interactions = [input.agents[0]!.waitingOn];
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => null;\n",
    args: {},
    snapshot: input,
  });
  const loaded = await loadWorkflowSummaries(root, {
    sessionId: "future-session",
    now: 1,
    staleAfterMs: 0,
  });
  assert.equal(loaded[0]?.runId, created.runId);
  assert.equal(loaded[0]?.status, "aborted");
  assert.equal(loaded[0]?.phases[0]?.status, "aborted");
  assert.equal(loaded[0]?.agents[0]?.state, "aborted");
  assert.equal(loaded[0]?.agents[0]?.waitingOn, undefined, "a restored run cannot keep advertising an unanswerable question");
  assert.equal(loaded[0]?.agents[0]?.answering, undefined);
  assert.equal(loaded[0]?.interactions?.[0]?.state, "cancelled", "the durable audit trail records how the stale wait ended");
  assert.equal(loaded[0]?.interactions?.[0]?.answeredAt, 1);
  assert.equal(loaded[0]?.plannedPhaseCount, 1, "the declared total survives stale restoration");
});

test("stale declared restoration aborts the active phase and preserves future phases across reload and report", async () => {
  const { root } = await fixture();
  const old = 1_000;
  const input = snapshot("declared-stale", old);
  const template = input.phases[0]!;
  input.plannedPhaseCount = 4;
  input.currentPhase = 20;
  input.phases = [
    { ...template, index: 10, name: "Prepare", status: "completed", agents: [] },
    { ...template, index: 20, name: "Active", status: "running", agents: [0] },
    { ...template, index: 30, name: "Verify", status: "pending", agents: [] },
    { ...template, index: 40, name: "Publish", status: "pending", agents: [] },
  ];
  input.agents[0]!.phase = 20;
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => null;\n",
    args: {},
    snapshot: input,
  });

  const [restored] = await loadWorkflowSummaries(root, {
    sessionId: "declared-stale",
    now: 10_000,
    staleAfterMs: 5_000,
  });
  assert.ok(restored);
  assert.equal(restored.status, "aborted");
  assert.equal(restored.plannedPhaseCount, 4);
  assert.equal(restored.currentPhase, 20);
  assert.deepEqual(restored.phases.map((phase) => [phase.name, phase.status]), [
    ["Prepare", "completed"], ["Active", "aborted"], ["Verify", "pending"], ["Publish", "pending"],
  ]);

  const saved = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
  assert.equal(saved.plannedPhaseCount, 4);
  assert.equal(saved.currentPhase, 20);
  assert.deepEqual(saved.phases.map((phase) => phase.status), ["completed", "aborted", "pending", "pending"]);

  await writeWorkflowReport(root, restored);
  const report = await readFile(join(created.artifactDir, "report.md"), "utf8");
  assert.match(report, /- Active: aborted/);
  assert.match(report, /- Verify: pending/);
  assert.match(report, /- Publish: pending/);

  const [reloaded] = await loadWorkflowSummaries(root, { sessionId: "declared-stale", now: 11_000, staleAfterMs: 5_000 });
  assert.ok(reloaded);
  assert.equal(reloaded.plannedPhaseCount, 4);
  assert.equal(reloaded.currentPhase, 20);
  assert.deepEqual(reloaded.phases.map((phase) => phase.status), ["completed", "aborted", "pending", "pending"]);
});

test("stale declared restoration with no activation keeps every planned phase pending", async () => {
  const { root } = await fixture();
  const old = 1_000;
  const input = snapshot("declared-no-activation", old);
  const template = input.phases[0]!;
  input.plannedPhaseCount = 3;
  input.currentPhase = null;
  input.phases = [
    { ...template, index: 10, name: "Prepare", status: "pending", agents: [] },
    { ...template, index: 20, name: "Verify", status: "pending", agents: [] },
    { ...template, index: 30, name: "Publish", status: "pending", agents: [] },
  ];
  input.agents = [];
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => null;\n",
    args: {},
    snapshot: input,
  });

  const [restored] = await loadWorkflowSummaries(root, {
    sessionId: "declared-no-activation",
    now: 10_000,
    staleAfterMs: 5_000,
  });
  assert.ok(restored);
  assert.equal(restored.status, "aborted");
  assert.equal(restored.plannedPhaseCount, 3);
  assert.equal(restored.currentPhase, null);
  assert.deepEqual(restored.phases.map((phase) => phase.status), ["pending", "pending", "pending"]);

  const saved = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
  assert.equal(saved.plannedPhaseCount, 3);
  assert.equal(saved.currentPhase, null);
  assert.deepEqual(saved.phases.map((phase) => phase.status), ["pending", "pending", "pending"]);

  await writeWorkflowReport(root, restored);
  const report = await readFile(join(created.artifactDir, "report.md"), "utf8");
  assert.match(report, /- Prepare: pending/);
  assert.match(report, /- Verify: pending/);
  assert.match(report, /- Publish: pending/);

  const [reloaded] = await loadWorkflowSummaries(root, { sessionId: "declared-no-activation", now: 11_000, staleAfterMs: 5_000 });
  assert.ok(reloaded);
  assert.equal(reloaded.plannedPhaseCount, 3);
  assert.equal(reloaded.currentPhase, null);
  assert.deepEqual(reloaded.phases.map((phase) => phase.status), ["pending", "pending", "pending"]);
});

test("persists declared phase totals and rejects inconsistent declared snapshots", async () => {
  const { root } = await fixture();
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => null;\n",
    args: {},
    snapshot: { ...snapshot("planned-session"), plannedPhaseCount: 1 },
  });
  const loaded = await loadWorkflowSummaries(root, { sessionId: "planned-session" });
  assert.equal(loaded[0]?.plannedPhaseCount, 1);

  const persisted = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
  persisted.plannedPhaseCount = 2;
  await writeFile(join(created.artifactDir, "workflow.json"), JSON.stringify(persisted), { mode: 0o600 });
  assert.deepEqual(await loadWorkflowSummaries(root, { sessionId: "planned-session" }), [], "a count/phase mismatch is not restored");
});

test("loads old completed snapshots and derives task outcome from the authoritative result artifact", async () => {
  const { root } = await fixture();
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => ({ ok: false });\n",
    args: {},
    snapshot: snapshot("legacy-outcome"),
  });
  const legacy: WorkflowSnapshot = {
    ...created,
    status: "completed",
    result: { truncated: true, preview: "top-level ok field omitted from bounded summary" },
    timestamps: { ...created.timestamps, endedAt: Date.now() },
  };
  delete legacy.taskOutcome;
  await checkpointWorkflow(root, legacy);
  await writeWorkflowResult(root, created.runId, { ok: false, detail: "authoritative" });

  const [loaded] = await loadWorkflowSummaries(root, { sessionId: "legacy-outcome" });
  assert.equal(loaded?.status, "completed");
  assert.equal(loaded?.taskOutcome, "unsuccessful");
});

test("durable reports include task outcome only for completed workflows", async () => {
  const { root } = await fixture();
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => ({ ok: false });\n",
    args: {},
    snapshot: snapshot("report-outcome"),
  });

  await writeWorkflowReport(root, { ...created, status: "completed", taskOutcome: "unsuccessful", result: { ok: false } });
  assert.match(await readFile(join(created.artifactDir, "report.md"), "utf8"), /Task outcome: \*\*unsuccessful\*\*/);

  for (const status of ["failed", "aborted"] as const) {
    await writeWorkflowReport(root, { ...created, status, taskOutcome: "unsuccessful", result: { ok: false } });
    const report = await readFile(join(created.artifactDir, "report.md"), "utf8");
    assert.doesNotMatch(report, /Task outcome:/, `${status} report omits task outcome`);
  }
});
