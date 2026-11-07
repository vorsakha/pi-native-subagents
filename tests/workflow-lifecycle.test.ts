import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkflows } from "../extensions/workflows/index.ts";
import { JobManager } from "../src/manager.ts";
import { WorkflowManager } from "../src/workflows/manager.ts";
import { fakePi, ImmediateBackend, replaceableContext, tempDir, ticks } from "./helpers.ts";

for (const outcome of ["success", "failure"] as const) {
  test(`workflow restoration ignores a replaced context after ${outcome}`, async (t) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const restoring = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    t.mock.method(WorkflowManager.prototype, "initialize", () => restoring);
    const pi = fakePi();
    const jobs = new JobManager({ backends: [] });
    const session = replaceableContext({ hasUI: true });
    let initialized = 0;
    const workflows = registerWorkflows(pi.api, {
      artifactRoot: await tempDir("workflow-stale"),
      onInitialized: () => { initialized++; },
    });
    t.after(async () => {
      await workflows.sessionShutdown();
      workflows.sessionClosed();
      await jobs.shutdown();
    });

    workflows.sessionStart(session.ctx, jobs);
    session.invalidate();
    if (outcome === "success") resolve();
    else reject(new Error("restoration failed"));
    await ticks(3);

    assert.equal(initialized, 0, "a replaced runtime cannot publish startup state");
    assert.deepEqual(session.notifications, []);
    assert.equal(session.statuses.size, 0);
  });
}

test("active workflow restoration failures still notify and settle initialization", async (t) => {
  t.mock.method(WorkflowManager.prototype, "initialize", async () => { throw new Error("history unavailable"); });
  const pi = fakePi();
  const jobs = new JobManager({ backends: [] });
  const session = replaceableContext({ hasUI: true });
  let initialized = 0;
  const workflows = registerWorkflows(pi.api, {
    artifactRoot: await tempDir("workflow-restoration-error"),
    onInitialized: () => { initialized++; },
  });
  t.after(async () => {
    await workflows.sessionShutdown();
    workflows.sessionClosed();
    await jobs.shutdown();
  });

  workflows.sessionStart(session.ctx, jobs);
  await ticks(3);

  assert.equal(initialized, 1);
  assert.deepEqual(session.notifications, [
    { message: "Workflow history unavailable: history unavailable", type: "warning" },
  ]);
});

test("workflow restoration error reporting cannot reject its background task", async (t) => {
  t.mock.method(WorkflowManager.prototype, "initialize", async () => { throw new Error("history unavailable"); });
  const pi = fakePi();
  const jobs = new JobManager({ backends: [] });
  const session = replaceableContext({ hasUI: true });
  t.mock.method(session.ctx.ui, "notify", () => { throw new Error("UI unavailable"); });
  let initialized = 0;
  const workflows = registerWorkflows(pi.api, {
    artifactRoot: await tempDir("workflow-notification-error"),
    onInitialized: () => { initialized++; },
  });
  t.after(async () => {
    await workflows.sessionShutdown();
    workflows.sessionClosed();
    await jobs.shutdown();
  });

  workflows.sessionStart(session.ctx, jobs);
  await ticks(3);
  assert.equal(initialized, 1);
});

test("workflow shutdown releases its UI before awaiting manager cleanup", async (t) => {
  t.mock.method(WorkflowManager.prototype, "initialize", async () => {});
  const pi = fakePi();
  const jobs = new JobManager({ backends: [] });
  const session = replaceableContext({ hasUI: true });
  const workflows = registerWorkflows(pi.api, { artifactRoot: await tempDir("workflow-shutdown-ui") });
  workflows.sessionStart(session.ctx, jobs);
  await ticks(3);

  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const shutdown = t.mock.method(WorkflowManager.prototype, "shutdown", () => cleanup);
  const closing = workflows.sessionShutdown();
  session.invalidate();
  release();
  try {
    await assert.doesNotReject(closing);
    assert.equal(session.statuses.get("native-workflows"), undefined);
  } finally {
    workflows.sessionClosed();
    shutdown.mock.restore();
    await jobs.shutdown();
  }
});

test("an approval from a replaced workflow session cannot dispatch a mutation", async (t) => {
  const pi = fakePi();
  const backend = new ImmediateBackend("pi");
  const jobs = new JobManager({ backends: [backend] });
  let confirm!: (approved: boolean) => void;
  const approval = new Promise<boolean>((resolve) => { confirm = resolve; });
  let showConfirmation!: () => void;
  const confirming = new Promise<void>((resolve) => { showConfirmation = resolve; });
  const session = replaceableContext({
    hasUI: true,
    confirm: () => {
      showConfirmation();
      return approval;
    },
  });
  const workflows = registerWorkflows(pi.api, { artifactRoot: await tempDir("workflow-stale-approval") });
  t.after(async () => {
    confirm(false);
    await workflows.sessionShutdown();
    workflows.sessionClosed();
    await jobs.shutdown();
  });
  workflows.sessionStart(session.ctx, jobs);
  const result = pi.tools.get("workflow").execute("approval", {
    name: "stale approval",
    script: 'export default async () => agent("mutate", {})',
    approval: "onMutate",
  }, undefined, undefined, session.ctx);
  await confirming;
  session.invalidate();
  confirm(true);
  await result;

  assert.equal(backend.requests.length, 0, "an old confirmation must not authorize a new dispatch");
});
