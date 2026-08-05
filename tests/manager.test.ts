import test from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/manager.ts";
import type { Backend, BackendRun, JobSnapshot, ProfileDefinition } from "../src/types.ts";
import { ControlledBackend, tick } from "./helpers.ts";

function setup(concurrency = 4) {
  const backend = new ControlledBackend();
  const manager = new JobManager({ backends: [backend], concurrency });
  return { backend, manager };
}
function request(n: number) { return { name: "worker", task: `task ${n}`, cwd: "/tmp", trusted: true, harness: "codex" as const }; }

test("manager enforces concurrency cap four and pumps queued work", async () => {
  const { backend, manager } = setup(4);
  const jobs = Array.from({ length: 6 }, (_, index) => manager.spawn(request(index)));
  await tick();
  assert.equal(backend.starts.length, 4);
  assert.equal(backend.maxActive, 4);
  assert.equal(manager.check(jobs[4]!.id).status, "queued");
  backend.complete(jobs[0]!.id);
  await tick(); await tick();
  assert.equal(backend.starts.length, 5);
  for (const job of jobs.slice(1, 5)) backend.complete(job.id);
  await tick(); await tick();
  backend.complete(jobs[5]!.id);
  await manager.wait(jobs[5]!.id);
  await manager.shutdown();
});

test("direct jobs take the next free slot ahead of queued workflow fan-out", async () => {
  const { backend, manager } = setup(1);
  const blocker = manager.spawn(request(0));
  await tick();
  const workflow = { runId: "wf_fair", agentIndex: 0, label: "worker" };
  const firstWorkflow = manager.spawn({ ...request(1), workflow });
  const secondWorkflow = manager.spawn({ ...request(2), workflow: { ...workflow, agentIndex: 1 } });
  const interactive = manager.spawn(request(3));
  backend.complete(blocker.id);
  await tick(); await tick();
  assert.equal(backend.starts[1], interactive.id, "interactive work is not trapped behind the workflow queue");
  backend.complete(interactive.id);
  await tick(); await tick();
  backend.complete(firstWorkflow.id);
  await tick(); await tick();
  backend.complete(secondWorkflow.id);
  await manager.wait(secondWorkflow.id);
  await manager.shutdown();
});

test("completed native sessions live until session shutdown or oldest-terminal capacity eviction", async () => {
  const { backend, manager } = setup(4);
  const jobs = Array.from({ length: 100 }, (_, index) => manager.spawn(request(index)));
  const completed = new Set<string>();
  while (completed.size < jobs.length) {
    await tick();
    for (const id of backend.starts) {
      if (completed.has(id)) continue;
      backend.complete(id);
      completed.add(id);
    }
  }
  await Promise.all(jobs.map((job) => manager.wait(job.id)));
  assert.deepEqual(backend.closes, [], "completed native sessions remain open without an idle TTL");

  const replacement = manager.spawn(request(100));
  await tick();
  assert.throws(() => manager.check(jobs[0]!.id), /Unknown job/, "oldest terminal job is evicted at capacity");
  assert.deepEqual(backend.closes, [jobs[0]!.id], "capacity eviction closes the retained native session");
  backend.complete(replacement.id);
  await manager.wait(replacement.id);
  await manager.shutdown();
});

test("an evicted terminal job closes a native run that returns after eviction", async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let starts = 0;
  const closes: string[] = [];
  const backend: Backend = {
    name: "codex",
    async start(request, emit) {
      starts++;
      emit({ type: "completed", output: "early completion" });
      if (starts === 1) await startGate;
      return {
        completed: Promise.resolve(),
        async send() {},
        async cancel() {},
        async close() { closes.push(request.jobId); },
      };
    },
  };
  const manager = new JobManager({ backends: [backend], concurrency: 1 });
  const jobs = Array.from({ length: 100 }, (_, index) => manager.spawn(request(index)));
  const replacement = manager.spawn(request(100));
  assert.throws(() => manager.check(jobs[0]!.id), /Unknown job/);

  releaseStart();
  while (!closes.includes(jobs[0]!.id)) await tick();
  assert.deepEqual(closes, [jobs[0]!.id], "late native run is closed instead of orphaned");
  await manager.wait(replacement.id);
  await manager.shutdown();
});

test("manager forwards caller models and labels omitted models as native defaults", async () => {
  const backend = new ControlledBackend();
  const manager = new JobManager({ backends: [backend] });
  const selected = manager.spawn({ ...request(1), model: "configured-model" });
  const nativeDefault = manager.spawn(request(2));
  assert.equal(selected.model, "configured-model");
  assert.equal(nativeDefault.model, "default");
  await tick();
  assert.equal(backend.policies[0]?.model, "configured-model");
  assert.equal(backend.policies[1]?.model, undefined);
  backend.complete(selected.id);
  backend.complete(nativeDefault.id);
  await manager.shutdown();
});

test("independentOf routes against the producer job rather than the parent provider", async () => {
  const codex = new ControlledBackend("codex");
  const claude = new ControlledBackend("claude");
  const manager = new JobManager({ backends: [codex, claude] });
  const producer = manager.spawn({ ...request(1), harness: "claude" });
  const reviewer = manager.spawn({
    ...request(2), harness: undefined, parentProvider: "codex", independentOf: producer.id, access: "readOnly",
  });
  assert.equal(reviewer.harness, "codex", "reviewer differs from the Claude producer even though the parent is Codex");
  assert.equal(reviewer.independent, true);
  assert.equal(reviewer.independentOf, producer.id);
  assert.throws(
    () => manager.spawn({ ...request(3), harness: "claude", independentOf: producer.id }),
    /different from the referenced job claude/,
  );
  assert.throws(
    () => manager.spawn({ ...request(4), independentOf: "missing-job" }),
    /Unknown independence target job/,
  );
  const replayReviewer = manager.spawn({
    ...request(5), harness: undefined, independentOf: "prior-session-job", independentOfProvider: "claude",
  });
  assert.equal(replayReviewer.harness, "codex", "durable replay can preserve routing after the producer leaves JobManager");
  assert.equal(replayReviewer.independentOf, "prior-session-job");
  assert.throws(
    () => manager.spawn({ ...request(6), independentOfProvider: "claude" }),
    /requires independentOf/,
  );
  await tick();
  claude.complete(producer.id);
  codex.complete(reviewer.id);
  codex.complete(replayReviewer.id);
  await manager.shutdown();
});

test("snapshots preserve explicit effort and distinguish provider-adaptive defaults", async () => {
  const { backend, manager } = setup(2);
  const adaptive = manager.spawn(request(1));
  const explicit = manager.spawn({ ...request(2), effort: "high" });
  assert.equal(adaptive.effort, undefined);
  assert.equal(explicit.effort, "high");
  assert.equal(manager.check(explicit.id).effort, "high");
  await tick();
  backend.complete(adaptive.id);
  backend.complete(explicit.id);
  await Promise.all([manager.wait(adaptive.id), manager.wait(explicit.id)]);
  await manager.shutdown();
});

test("wait resolves terminal state and timeout returns current state", async () => {
  const { backend, manager } = setup(1);
  const job = manager.spawn(request(1));
  await tick();
  assert.equal((await manager.wait(job.id, { timeoutMs: 5 })).status, "running");
  backend.complete(job.id, "done");
  const final = await manager.wait(job.id);
  assert.equal(final.status, "completed");
  assert.equal(final.output, "done");
  await manager.shutdown();
});

test("cancel removes queued jobs and tears down running backend", async () => {
  const { backend, manager } = setup(1);
  let runningCancellationEvents = 0;
  manager.subscribe((job, event) => { if (event.type === "cancelled" && job.status === "cancelled") runningCancellationEvents++; });
  const running = manager.spawn(request(1));
  const queued = manager.spawn(request(2));
  await tick();
  assert.equal((await manager.cancel(queued.id)).status, "cancelled");
  assert.equal((await manager.cancel(running.id)).status, "cancelled");
  assert.deepEqual(backend.cancels.map((cancel) => cancel.jobId), [running.id]);
  assert.equal(runningCancellationEvents, 2); // one queued job and one running job, no backend duplicate
  await manager.shutdown();
});

test("cancellation aborts a pending backend start before returning", async () => {
  let startupAborted = false;
  const backend: Backend = {
    name: "codex",
    async start(request) {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => {
        startupAborted = true;
        reject(request.signal.reason);
      }, { once: true }));
      assert.fail("aborted startup must not return a run");
    },
  };
  const manager = new JobManager({ backends: [backend] });
  const job = manager.spawn(request(1));
  await tick();
  const final = await manager.cancel(job.id, "race cancellation");
  assert.equal(final.status, "cancelled");
  assert.equal(startupAborted, true);
  await manager.shutdown();
});

test("manager bounds harness startup and direct cancellation waits", async (t) => {
  await t.test("startup", async () => {
    const backend: Backend = {
      name: "codex",
      async start() { return new Promise<BackendRun>(() => {}); },
    };
    const manager = new JobManager({ backends: [backend], startupTimeoutMs: 20, operationTimeoutMs: 20 });
    const job = manager.spawn(request(1));
    const final = await manager.wait(job.id);
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /Harness startup timed out after 20ms/);
    await manager.shutdown(20);
  });

  await t.test("cancellation", async () => {
    let forceCloses = 0;
    const backend: Backend = {
      name: "codex",
      async start() {
        return {
          completed: new Promise<void>(() => {}),
          async send() {},
          async cancel() { await new Promise<void>(() => {}); },
          async close() {},
          async forceClose() { forceCloses++; },
        };
      },
    };
    const manager = new JobManager({ backends: [backend], startupTimeoutMs: 100, operationTimeoutMs: 20 });
    const job = manager.spawn(request(1));
    await tick();
    const final = await manager.cancel(job.id, "bounded cancel");
    assert.equal(final.status, "cancelled");
    assert.match(final.error ?? "", /deadline exceeded/);
    assert.equal(forceCloses, 1);
    await manager.shutdown(20);
  });
});

test("shutdown aborts delayed startup with no late run or resource resurrection", async () => {
  let startupAborted = false;
  let resourceCreated = false;
  const backend: Backend = {
    name: "codex",
    async start(request) {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => {
        startupAborted = true;
        reject(request.signal.reason);
      }, { once: true }));
      resourceCreated = true;
      assert.fail("startup continued after shutdown abort");
    },
  };
  const manager = new JobManager({ backends: [backend] });
  const job = manager.spawn(request(1));
  await tick();
  await manager.shutdown(100);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(startupAborted, true);
  assert.equal(resourceCreated, false);
  assert.equal(manager.check(job.id).status, "cancelled");
  assert.throws(() => manager.spawn(request(2)), /closed/);
});

test("shutdown deadline force-closes a backend whose cancellation hangs", async () => {
  let closeCalled = false;
  let forceCloseCalled = false;
  const backend: Backend = {
    name: "codex",
    async start(_request, emit) {
      let settle!: () => void;
      return {
        completed: new Promise<void>((resolve) => { settle = resolve; }),
        send: async () => undefined,
        cancel: async () => new Promise<void>(() => {}),
        close: async () => { closeCalled = true; },
        forceClose: async () => { forceCloseCalled = true; emit({ type: "cancelled", reason: "forced" }); settle(); },
      };
    },
  };
  const manager = new JobManager({ backends: [backend] });
  const job = manager.spawn(request(1));
  await tick();
  const started = Date.now();
  await manager.shutdown(20);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(closeCalled, false);
  assert.equal(forceCloseCalled, true);
  assert.equal(manager.check(job.id).status, "cancelled");
});

test("manager serializes send and cancel and publishes cancellation after teardown", async () => {
  let releaseSend!: () => void;
  let releaseCancel!: () => void;
  const order: string[] = [];
  const backend: Backend = {
    name: "codex",
    async start(_request, emit) {
      let finish!: () => void;
      return {
        completed: new Promise<void>((resolve) => { finish = resolve; }),
        async send() { order.push("send-start"); await new Promise<void>((resolve) => { releaseSend = resolve; }); order.push("send-end"); },
        async cancel(reason) {
          order.push("cancel-start");
          emit({ type: "cancelled", reason });
          await new Promise<void>((resolve) => { releaseCancel = resolve; });
          order.push("cancel-end");
          finish();
        },
        async close() {},
      };
    },
  };
  const manager = new JobManager({ backends: [backend] });
  const job = manager.spawn(request(1));
  await tick();
  const sending = manager.send(job.id, "in flight");
  await tick();
  const cancelling = manager.cancel(job.id, "serialized");
  assert.equal(manager.check(job.id).status, "running");
  releaseSend();
  await sending;
  await tick();
  assert.deepEqual(order, ["send-start", "send-end", "cancel-start"]);
  assert.equal(manager.check(job.id).status, "running");
  releaseCancel();
  assert.equal((await cancelling).status, "cancelled");
  assert.deepEqual(order, ["send-start", "send-end", "cancel-start", "cancel-end"]);
  await manager.shutdown();
});

test("manager terminalizes a job when backend cancellation rejects", async () => {
  const backend: Backend = {
    name: "codex",
    async start() {
      return {
        completed: new Promise<void>(() => {}),
        async send() {},
        async cancel() { throw new Error("teardown broke"); },
        async close() {},
      };
    },
  };
  const manager = new JobManager({ backends: [backend] });
  const job = manager.spawn(request(1));
  await tick();
  await assert.rejects(manager.cancel(job.id), /teardown broke/);
  assert.equal(manager.check(job.id).status, "failed");
  assert.match(manager.check(job.id).error ?? "", /Harness cancellation failed: teardown broke/);
  await manager.shutdown(5);
});

test("manager forwards steering and emits automatic lifecycle observations", async () => {
  const { backend, manager } = setup(1);
  const observed: string[] = [];
  const streamedSnapshots: JobSnapshot[] = [];
  const unsubscribe = manager.subscribe((job, event) => {
    observed.push(`${job.status}:${event.type}`);
    if (event.type === "started" || event.type === "text_delta" || event.type === "thinking_delta") streamedSnapshots.push(job);
  });
  const job = manager.spawn(request(1));
  await tick();
  backend.runs.get(job.id)!.emit({ type: "text_delta", text: "partial" });
  backend.runs.get(job.id)!.emit({ type: "thinking_delta", text: "thinking" });
  assert.equal(streamedSnapshots.length, 3);
  assert.equal(streamedSnapshots[1]!.transcript, streamedSnapshots[0]!.transcript, "observer projections reuse unchanged transcript clones across deltas");
  assert.equal(streamedSnapshots[2]!.tools, streamedSnapshots[1]!.tools, "observer projections reuse unchanged tool clones across deltas");
  await manager.send(job.id, "change course", "steer");
  assert.deepEqual(backend.sends, [{ id: job.id, message: "change course", behavior: "steer" }]);
  backend.complete(job.id, "done");
  await manager.wait(job.id);
  assert.ok(observed.includes("completed:completed"));
  const queued = await manager.send(job.id, "review the fixes", "followUp");
  assert.ok(queued.status === "queued" || queued.status === "running");
  await tick();
  assert.deepEqual(backend.sends.at(-1), { id: job.id, message: "review the fixes", behavior: "followUp" });
  backend.complete(job.id, "second result");
  const continued = await manager.wait(job.id);
  assert.equal(continued.status, "completed");
  assert.equal(continued.output, "second result");

  const workflowOwned = manager.spawn({
    ...request(2),
    workflow: { runId: "wf-test", agentIndex: 0, label: "implementation", phase: "Build" },
  });
  await assert.rejects(
    manager.send(workflowOwned.id, "override the workflow", "steer"),
    /workflow-owned agents are controlled by their workflow/,
  );
  await manager.cancel(workflowOwned.id);
  unsubscribe();
  await manager.shutdown();
});

test("manager rejects unknown explicit profiles, untrusted execution, and empty tasks", () => {
  const backend = new ControlledBackend();
  const audit: ProfileDefinition = { name: "audit", description: "", systemPrompt: "audit", filePath: "audit.md", origin: "global" };
  const manager = new JobManager({ backends: [backend], profiles: new Map([[audit.name, audit]]) });
  assert.throws(() => manager.spawn({ ...request(1), profile: "missing" }), /Unknown subagent profile/);
  assert.throws(() => manager.spawn({ ...request(1), profile: "  " }), /non-empty/);
  assert.throws(() => manager.spawn({ ...request(1), trusted: false }), /untrusted/);
  assert.throws(() => manager.spawn({ ...request(1), task: " " }), /empty/);
});
