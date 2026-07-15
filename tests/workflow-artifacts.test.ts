import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointWorkflow,
  createWorkflowArtifacts,
  loadWorkflowSummaries,
  serializeWorkflowValue,
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
      label: "security",
      role: "reviewer",
      phase: 0,
      jobId: "job-1",
      state: "running",
      timestamps: { createdAt: now, startedAt: now, updatedAt: now },
      backend: "codex",
      model: "review-model",
      preview: "working",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    }],
  };
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workflow-artifacts-"));
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
    "args.json", "result.json", "script.js", "workflow.json",
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
});

test("large terminal checkpoints remain valid loadable workflow summaries", async () => {
  const { root } = await fixture();
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => null;\n",
    args: {},
    snapshot: snapshot("session-large"),
  });
  const large: WorkflowSnapshot = {
    ...created,
    status: "completed",
    timestamps: { ...created.timestamps, updatedAt: 5_000, endedAt: 5_000 },
    phases: Array.from({ length: 3_000 }, (_, index) => ({
      index,
      name: `phase-${index}`,
      status: "completed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 5_000, endedAt: 5_000 },
      agents: Array.from({ length: 100 }, (_, agentIndex) => agentIndex),
    })),
    agents: Array.from({ length: 32 }, (_, index) => ({
      index,
      label: `agent-${index}`,
      role: "worker",
      phase: 0,
      state: "completed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 5_000, endedAt: 5_000 },
      preview: "preview",
      output: `${index}:` + "x".repeat(50 * 1024),
      error: undefined,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    })),
    result: { summary: "r".repeat(256 * 1024) },
  };
  await checkpointWorkflow(root, large);
  const persisted = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
  assert.equal(persisted.runId, created.runId);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.agents.length, 32);
  assert.equal(persisted.phases.length, 64);
  assert.ok(persisted.phases.every((phase) => typeof phase === "object" && phase.agents.length <= 32));
  assert.ok(Buffer.byteLength(JSON.stringify(persisted)) < 512 * 1024);
  const loaded = await loadWorkflowSummaries(root, { sessionId: "session-large" });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.runId, created.runId);
});

test("no-resume loading aborts future checkpoints plus queued agents and pending phases", async () => {
  const { root } = await fixture();
  const future = 99_999_999;
  const input = snapshot("future-session", future);
  input.phases[0]!.status = "pending";
  input.agents[0]!.state = "queued";
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
});

test("bounded serialization handles cycles, depth, node count, and byte limits", () => {
  const value: Record<string, unknown> = {
    long: "🙂".repeat(1_000),
    secret: "must-not-persist",
    child: { child: { child: { child: true } } },
    many: Array.from({ length: 100 }, (_, index) => ({ index })),
  };
  value.self = value;

  const serialized = serializeWorkflowValue(value, {
    maxDepth: 2,
    maxNodes: 12,
    maxStringBytes: 24,
    maxTotalBytes: 300,
  });
  const json = JSON.stringify(serialized);
  assert.ok(Buffer.byteLength(json) <= 300);
  assert.doesNotMatch(json, /must-not-persist/);
  assert.match(json, /Circular|MaxDepth|MaxNodes|total bytes|truncated/i);
  assert.doesNotThrow(() => JSON.parse(json));
});
