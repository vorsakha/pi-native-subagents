import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import { createWorkflowArtifacts } from "../src/workflows/artifacts.ts";
import {
  applyWorkflowRetention,
  DEFAULT_WORKFLOW_RETAINED_RUNS,
  listWorkflowProtectedWorktrees,
  listWorkflowRunRetentionRecords,
  openWorkflowSessionLease,
  planWorkflowRetention,
} from "../src/workflows/retention.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

function snapshot(overrides: Partial<Omit<WorkflowSnapshot, "runId" | "artifactDir">> = {}): Omit<WorkflowSnapshot, "runId" | "artifactDir"> {
  const now = overrides.timestamps?.updatedAt ?? Date.now();
  return {
    sessionId: "session-a",
    name: "retention fixture",
    description: "",
    background: false,
    status: "completed",
    timestamps: { createdAt: now, updatedAt: now },
    currentPhase: null,
    phases: [],
    agents: [],
    ...overrides,
  };
}

async function fixture() {
  const parent = await tempDir("workflow-retention");
  return { root: join(parent, "workflows") };
}

async function makeRun(root: string, overrides: Partial<Omit<WorkflowSnapshot, "runId" | "artifactDir">> = {}) {
  return createWorkflowArtifacts(root, {
    script: "export default 1;\n",
    args: {},
    snapshot: snapshot(overrides),
  });
}

test("recovers an interrupted retention lock with only a temporary owner record", { timeout: 2_000 }, async () => {
  const { root } = await fixture();
  const stateDirectory = `${root}.runtime`;
  const lockPath = join(stateDirectory, ".retention.lock");
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, ".owner.json.deadcafe.tmp"), JSON.stringify({
    pid: 2_147_483_647,
    token: "interrupted-owner",
    createdAt: Date.now(),
  }), "utf8");

  const lease = await openWorkflowSessionLease(root, "replacement-session");
  try {
    assert.ok(!(await readdir(stateDirectory)).includes(".retention.lock"));
  } finally {
    await lease.close();
  }
});

test("recovers a retention lock whose reused owner pid predates this boot", { timeout: 2_000 }, async () => {
  const { root } = await fixture();
  const stateDirectory = `${root}.runtime`;
  const lockPath = join(stateDirectory, ".retention.lock");
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    token: "previous-boot-owner",
    createdAt: 1,
  }), "utf8");

  const lease = await openWorkflowSessionLease(root, "replacement-session");
  try {
    assert.ok(!(await readdir(stateDirectory)).includes(".retention.lock"));
  } finally {
    await lease.close();
  }
});

test("bounds repeated eligible terminal runs to maxRuns and stays bounded on repeated passes", async () => {
  const { root } = await fixture();
  const maxRuns = 5;
  const runIds: string[] = [];
  for (let index = 0; index < maxRuns + 5; index++) {
    const created = await makeRun(root, { timestamps: { createdAt: index, updatedAt: index } });
    runIds.push(created.runId);
  }
  for (let pass = 0; pass < 3; pass++) {
    const report = await applyWorkflowRetention(root, { maxRuns });
    assert.deepEqual(report.failed, []);
    const remaining = await readdir(root);
    assert.equal(remaining.length, maxRuns, `pass ${pass} stays bounded`);
  }
  const remaining = new Set(await readdir(root));
  const newestExpected = new Set(runIds.slice(-maxRuns));
  assert.deepEqual(remaining, newestExpected);
});

test("never reclaims active runs: fresh checkpoints, protected ids, and old-but-fresh runs all survive", async () => {
  const { root } = await fixture();
  const now = 1_000_000;
  const fresh = await makeRun(root, { status: "running", timestamps: { createdAt: now, updatedAt: now } });
  const staleAfterMs = 10_000;
  const stale = await makeRun(root, { status: "running", timestamps: { createdAt: 0, updatedAt: 0 } });
  const protectedById = await makeRun(root, { status: "completed", timestamps: { createdAt: 0, updatedAt: 0 } });
  // Pad past the retained window so position alone would otherwise reclaim every run above.
  for (let index = 0; index < DEFAULT_WORKFLOW_RETAINED_RUNS; index++) {
    await makeRun(root, { status: "completed", timestamps: { createdAt: now + index + 1, updatedAt: now + index + 1 } });
  }

  const report = await applyWorkflowRetention(root, {
    maxRuns: DEFAULT_WORKFLOW_RETAINED_RUNS,
    staleAfterMs,
    now,
    protectRunIds: [protectedById.runId],
  });

  assert.ok(!report.removed.includes(fresh.runId), "a fresh running checkpoint is never reclaimed");
  assert.ok(!report.removed.includes(protectedById.runId), "an explicitly protected run is never reclaimed regardless of position");
  assert.ok(report.removed.includes(stale.runId), "a running checkpoint stale beyond the window is reclaimable");
});

test("a live unrecorded worktree is inventory state active, not an ended-run orphan", async () => {
  const { root } = await fixture();
  const live = await makeRun(root, { status: "running", timestamps: { createdAt: 0, updatedAt: 0 } });
  await mkdir(join(live.artifactDir, "worktrees", "agent-3"), { recursive: true });

  const records = await listWorkflowRunRetentionRecords(root);
  assert.equal(records[0]?.worktrees.length, 1);
  const [worktree] = records[0]!.worktrees;
  assert.equal(worktree!.state, "active");
  assert.equal(worktree!.unrecorded, true);
  assert.equal(worktree!.error, undefined);

  const report = await applyWorkflowRetention(root, { maxRuns: 0, staleAfterMs: 0 });
  assert.ok(!report.removed.includes(live.runId), "a live worktree protects its active run");
});

test("preserved, orphaned, and unrecorded worktrees block reclamation; removing them unblocks it", async () => {
  const { root } = await fixture();
  const now = 1_000_000;
  const preserved = await makeRun(root, {
    status: "completed",
    timestamps: { createdAt: 0, updatedAt: 0 },
    agents: [{
      index: 0, name: "worker", access: "full", independent: false, phase: 0,
      state: "completed", timestamps: { createdAt: 0, updatedAt: 0 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      isolation: { type: "worktree", state: "preserved", branch: `pi-workflow/wf_x/0`, changed: true, patchArtifact: "agent-0.patch" },
    }],
  });
  const orphaned = await makeRun(root, {
    status: "failed",
    timestamps: { createdAt: 0, updatedAt: 0 },
    agents: [{
      index: 0, name: "worker", access: "full", independent: false, phase: 0,
      state: "failed", timestamps: { createdAt: 0, updatedAt: 0 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      isolation: { type: "worktree", state: "orphaned", branch: `pi-workflow/wf_y/0`, changed: true, error: "crashed" },
    }],
  });
  // Crash before finalization recorded any isolation: only the on-disk checkout exists.
  const unrecorded = await makeRun(root, { status: "aborted", timestamps: { createdAt: 0, updatedAt: 0 } });
  await mkdir(join(unrecorded.artifactDir, "worktrees", "agent-0"), { recursive: true });

  for (let index = 0; index < DEFAULT_WORKFLOW_RETAINED_RUNS; index++) {
    await makeRun(root, { status: "completed", timestamps: { createdAt: now + index + 1, updatedAt: now + index + 1 } });
  }

  const first = await applyWorkflowRetention(root, { maxRuns: DEFAULT_WORKFLOW_RETAINED_RUNS, now });
  assert.deepEqual(
    [preserved.runId, orphaned.runId, unrecorded.runId].filter((id) => first.removed.includes(id)),
    [],
    "runs with any preserved, orphaned, or unrecorded worktree survive even when oldest",
  );

  // Clear every protecting worktree, matching what reclamation leaves behind: isolation "removed" and no worktrees/ directory.
  const cleared = await createWorkflowArtifacts(root, {
    script: "export default 1;\n",
    args: {},
    snapshot: {
      ...snapshot({ status: "completed", timestamps: { createdAt: 0, updatedAt: 0 } }),
      agents: [{
        index: 0, name: "worker", access: "full", independent: false, phase: 0,
        state: "completed", timestamps: { createdAt: 0, updatedAt: 0 },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        isolation: { type: "worktree", state: "removed", branch: `pi-workflow/wf_z/0`, changed: false },
      }],
    },
  });
  const second = await applyWorkflowRetention(root, { maxRuns: DEFAULT_WORKFLOW_RETAINED_RUNS, now });
  assert.ok(second.removed.includes(cleared.runId), "a run whose worktrees are all removed, with no worktrees/ directory, is reclaimable");
});

test("lists protected worktrees with run id, agent index, state, branch, path, patch, and error", async () => {
  const { root } = await fixture();
  const created = await makeRun(root, {
    agents: [{
      index: 2, name: "worker", access: "full", independent: false, phase: 0,
      state: "failed", timestamps: { createdAt: 0, updatedAt: 0 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      isolation: { type: "worktree", state: "orphaned", branch: "pi-workflow/wf_x/2", changed: true, error: "boom" },
    }],
  });
  const worktrees = await listWorkflowProtectedWorktrees(root);
  assert.equal(worktrees.length, 1);
  const [entry] = worktrees;
  assert.equal(entry!.runId, created.runId);
  assert.equal(entry!.agentIndex, 2);
  assert.equal(entry!.state, "orphaned");
  assert.equal(entry!.branch, "pi-workflow/wf_x/2");
  assert.match(entry!.worktreePath, /agent-2$/);
  assert.equal(entry!.error, "boom");
  assert.equal(entry!.unrecorded, false);
});

test("leaves unreadable and non-run directories untouched and reports them as failures", async () => {
  const { root } = await fixture();
  await mkdir(root, { recursive: true });
  const corrupt = join(root, "wf_deadcafe");
  await mkdir(corrupt, { recursive: true });
  await writeFile(join(corrupt, "workflow.json"), "{ not json", "utf8");
  const notARun = join(root, "not-a-run-id");
  await mkdir(notARun, { recursive: true });

  const records = await listWorkflowRunRetentionRecords(root);
  assert.equal(records.length, 1, "only wf_-prefixed directories are treated as runs");
  assert.equal(records[0]!.readable, false);

  const { remove } = planWorkflowRetention(records, { maxRuns: 0 });
  assert.deepEqual(remove, [], "an unreadable run is never planned for removal, even outside the window");

  const report = await applyWorkflowRetention(root, { maxRuns: 0 });
  assert.ok(report.failed.some((failure) => failure.runId === "wf_deadcafe"), "an unreadable run is reported to the retention caller");
  assert.deepEqual((await readdir(root)).sort(), ["not-a-run-id", "wf_deadcafe"]);
});

test("a non-ENOENT worktree scan failure keeps the run and is reported", async () => {
  const { root } = await fixture();
  const run = await makeRun(root, { timestamps: { createdAt: 0, updatedAt: 0 } });
  await writeFile(join(run.artifactDir, "worktrees"), "not a directory", "utf8");

  const records = await listWorkflowRunRetentionRecords(root);
  assert.match(records[0]?.scanError ?? "", /worktrees|ENOTDIR|directory/i);
  await assert.rejects(listWorkflowProtectedWorktrees(root), /Could not inspect protected worktrees/);
  const report = await applyWorkflowRetention(root, { maxRuns: 0 });
  assert.ok(!report.removed.includes(run.runId), "a failed worktree scan cannot fail open into deletion");
  assert.ok(report.failed.some((failure) => failure.runId === run.runId), "the scan failure is reported with its run ID");
  assert.ok((await readdir(root)).includes(run.runId));
});

test("an unknown entry under worktrees keeps the run and is reported", async () => {
  const { root } = await fixture();
  const run = await makeRun(root, { timestamps: { createdAt: 0, updatedAt: 0 } });
  await mkdir(join(run.artifactDir, "worktrees", "unexpected-checkout"), { recursive: true });

  const records = await listWorkflowRunRetentionRecords(root);
  assert.match(records[0]?.scanError ?? "", /unexpected-checkout/);
  const report = await applyWorkflowRetention(root, { maxRuns: 0 });
  assert.ok(!report.removed.includes(run.runId), "an unrecognized checkout cannot fail open into deletion");
  assert.ok(report.failed.some((failure) => failure.runId === run.runId));
  assert.ok((await readdir(root)).includes(run.runId));
});

test("a live session lease protects an old terminal run across retention passes", async () => {
  const { root } = await fixture();
  const held = await makeRun(root, { timestamps: { createdAt: 0, updatedAt: 0 } });
  const alsoHeld = await makeRun(root, { timestamps: { createdAt: 0, updatedAt: 0 } });
  const lease = await openWorkflowSessionLease(root, "open-session");
  try {
    await Promise.all([lease.claim([held.runId]), lease.claim([alsoHeld.runId])]);
    const report = await applyWorkflowRetention(root, { maxRuns: 0 });
    assert.ok(!report.removed.includes(held.runId), "a claimed run survives even outside the retained window");
    assert.ok(!report.removed.includes(alsoHeld.runId), "concurrent claims do not overwrite one another");
    assert.ok((await readdir(root)).includes(held.runId));
  } finally {
    await lease.close();
  }
  const afterClose = await applyWorkflowRetention(root, { maxRuns: 0 });
  assert.ok(afterClose.removed.includes(held.runId), "closing the session lease releases the run for retention");
});
