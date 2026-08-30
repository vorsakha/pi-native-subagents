import test from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/manager.ts";
import type { Backend, BackendRun, JobSnapshot, ProfileDefinition } from "../src/types.ts";
import { ControlledBackend, ImmediateBackend, tick, withTimeout } from "./helpers.ts";

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

test("generic retention never evicts a registry-owned advisor run", async () => {
  const { backend, manager } = setup(1);
  const advisorId = "adv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const advisor = manager.spawn({
    ...request(-1),
    access: "readOnly",
    advisor: { advisorId, threadId: "thread-retention" },
  });
  await backend.waitForStart();
  backend.complete(advisor.id, "advisor ready");
  await manager.waitAdvisorJob(advisor.id, advisorId);

  for (let index = 0; index < 100; index++) {
    const job = manager.spawn(request(index));
    await backend.waitForStart(index + 2);
    backend.complete(job.id);
    await manager.wait(job.id);
  }

  assert.equal(manager.checkAdvisorJob(advisor.id, advisorId).status, "completed");
  assert.equal(backend.closes.includes(advisor.id), false, "unrelated churn cannot close the registry-owned native run");
  await manager.continueAdvisorJob(advisor.id, advisorId, "retained follow-up");
  await backend.waitForSend();
  backend.complete(advisor.id, "advisor continued");
  assert.equal((await manager.waitAdvisorJob(advisor.id, advisorId)).generation, 1);
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

test("spawn, check, and list snapshots cannot mutate the enforced budget", async () => {
  const { backend, manager } = setup(1);
  const spawned = manager.spawn({ ...request(1), budget: { maxTokens: 10, maxTurns: 3 } });
  spawned.budget!.maxTokens = 1;
  assert.equal(manager.check(spawned.id).budget?.maxTokens, 10, "spawn returns a cloned budget");

  const checked = manager.check(spawned.id);
  checked.budget!.maxTokens = 2;
  assert.equal(manager.check(spawned.id).budget?.maxTokens, 10, "check returns a cloned budget");

  const listed = manager.list().find((job) => job.id === spawned.id)!;
  listed.budget!.maxTokens = 3;
  assert.equal(manager.check(spawned.id).budget?.maxTokens, 10, "list returns cloned budgets");

  await tick();
  backend.complete(spawned.id, "within original budget", { input: 5, output: 1 });
  await manager.wait(spawned.id);
  const followUp = await manager.send(spawned.id, "allowed by enforced budget", "followUp");
  assert.equal(followUp.generation, 1);
  await tick();
  backend.complete(spawned.id, "done", { input: 1, output: 1 });
  await manager.shutdown();
});

test("job snapshots clone live activity without exposing manager state", async () => {
  const { backend, manager } = setup(1);
  const job = manager.spawn(request(1));
  await tick();
  backend.emit(job.id, { type: "tool_start", id: "read", name: "Read", args: { path: "/tmp/src/index.ts" }, at: 2_000 });
  const checked = manager.check(job.id);
  assert.deepEqual(checked.activity, { kind: "tool", at: 2_000, tool: "Read", state: "running", target: "src/index.ts" });
  if (checked.activity?.kind === "tool") checked.activity.target = "tampered";
  const unchanged = manager.check(job.id).activity;
  assert.equal(unchanged?.kind === "tool" ? unchanged.target : undefined, "src/index.ts");
  backend.complete(job.id, "done");
  assert.equal((await manager.wait(job.id)).activity, undefined);
  await manager.shutdown();
});

test("a synchronous completion subscriber can queue the next generation without cleanup clobbering it", async () => {
  const backend = new ImmediateBackend("codex", { echoSend: true });
  const manager = new JobManager({ backends: [backend], concurrency: 1 });
  const completedGenerations: number[] = [];
  let subscriberFollowUp: Promise<JobSnapshot> | undefined;
  manager.subscribe((snapshot, event) => {
    if (event.type !== "completed") return;
    completedGenerations.push(snapshot.generation);
    if (snapshot.generation === 0) subscriberFollowUp = manager.send(snapshot.id, "subscriber follow-up", "followUp");
  });

  const initial = manager.spawn(request(1));
  for (let index = 0; index < 20 && !subscriberFollowUp; index++) await tick();
  assert.ok(subscriberFollowUp, "subscriber observed the initial completion synchronously");
  const queued = await subscriberFollowUp;
  assert.equal(queued.generation, 1);
  for (let index = 0; index < 20 && manager.check(initial.id).status !== "completed"; index++) await tick();
  const final = manager.check(initial.id);
  assert.equal(final.generation, 1);
  assert.equal(final.status, "completed");
  assert.equal(final.output, "codex-subscriber follow-up");
  assert.deepEqual(completedGenerations, [0, 1], "generation zero cleanup emits no terminal event over generation one");
  assert.equal(backend.requests.length, 1, "the retained native session is reused");
  await manager.shutdown();
});

test("direct spend budgets are optional, cumulative, soft for active work, and block retained follow-ups", async () => {
  const { backend, manager } = setup(1);
  const open = manager.spawn(request(1));
  assert.equal(open.budget, undefined);
  await tick();
  backend.complete(open.id, "open", { input: 100, output: 100, cacheRead: 10_000, turns: 3 });
  await manager.wait(open.id);
  await manager.send(open.id, "still open");
  await tick();
  backend.complete(open.id, "open again", { input: 1, output: 1, turns: 1 });
  await manager.wait(open.id);

  const budgeted = manager.spawn({ ...request(2), budget: { maxTokens: 5, maxTurns: 1 } });
  await tick();
  backend.complete(budgeted.id, "natural success", { input: 5, output: 2, cacheRead: 1_000, turns: 1 });
  const final = await manager.wait(budgeted.id);
  assert.equal(final.status, "completed");
  assert.equal(final.output, "natural success");
  assert.match(final.warnings?.join("\n") ?? "", /tokens limit reached/);
  assert.match(final.warnings?.join("\n") ?? "", /turns limit reached/);
  await assert.rejects(manager.send(budgeted.id, "blocked"), /later dispatches are blocked/);
  assert.equal(backend.cancels.length, 0);
  await manager.shutdown();
});

test("running-generation follow-ups wait for settlement and recheck cumulative spend", async () => {
  const { backend, manager } = setup(2);

  const beforeObservation = manager.spawn({ ...request(1), budget: { maxTokens: 5 } });
  await tick();
  const heldBefore = manager.send(beforeObservation.id, "submitted before usage", "followUp");
  await tick();
  assert.equal(backend.sends.length, 0, "follow-up is held outside the active generation");
  backend.complete(beforeObservation.id, "done", { input: 5, output: 1 });
  await assert.rejects(heldBefore, /later dispatches are blocked/);

  const afterObservation = manager.spawn({ ...request(2), budget: { maxTurns: 1 } });
  await tick();
  backend.runs.get(afterObservation.id)!.emit({ type: "usage", usage: { turns: 1 } });
  await manager.send(afterObservation.id, "active steering stays allowed", "steer");
  const heldAfter = manager.send(afterObservation.id, "submitted after usage", "followUp");
  await tick();
  assert.deepEqual(backend.sends.map((send) => send.message), ["active steering stays allowed"]);
  backend.complete(afterObservation.id, "done");
  await assert.rejects(heldAfter, /later dispatches are blocked/);

  const underBudget = manager.spawn({ ...request(3), budget: { maxTokens: 10 } });
  await tick();
  const accepted = manager.send(underBudget.id, "next generation", "followUp");
  backend.complete(underBudget.id, "first", { input: 2, output: 1 });
  const queued = await accepted;
  assert.equal(queued.generation, 1);
  assert.ok(queued.status === "queued" || queued.status === "running");
  await tick();
  assert.ok(backend.sends.some((send) => send.message === "next generation" && send.behavior === "followUp"));
  backend.complete(underBudget.id, "second", { input: 2, output: 1 });
  await manager.wait(underBudget.id);
  await manager.shutdown();
});

test("direct reached warnings are keyed per metric and emitted once as usage changes", async () => {
  const backend = new ControlledBackend("claude");
  const manager = new JobManager({ backends: [backend] });
  const job = manager.spawn({ ...request(1), harness: "claude", budget: { maxTokens: 5, maxTurns: 2, maxCost: 1 } });
  await tick();
  const run = backend.runs.get(job.id)!;
  run.emit({ type: "usage", usage: { input: 5 } });
  run.emit({ type: "usage", usage: { input: 4, turns: 2 } });
  run.emit({ type: "usage", usage: { output: 10, turns: 3, cost: 1.5 } });
  backend.complete(job.id, "done", { output: 1, cost: 1 });
  const warnings = (await manager.wait(job.id)).warnings ?? [];
  for (const metric of ["tokens", "turns", "cost"]) {
    assert.equal(warnings.filter((warning) => warning.includes(`${metric} limit reached`)).length, 1);
  }
  await manager.shutdown();
});

test("rejects maxCost before dispatch when the selected route does not report cost", () => {
  const { backend, manager } = setup();
  assert.throws(() => manager.spawn({ ...request(1), budget: { maxCost: 1 } }), /maxCost is unsupported by the codex route/);
  assert.equal(backend.requests.length, 0);
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
  const job = manager.spawn({ ...request(1), speed: "fast" });
  assert.equal(job.speed, "fast");
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

test("cancellation aborts scheduler admission before backend startup", async () => {
  const { backend, manager } = setup(1);
  let reached!: () => void;
  const admissionReached = new Promise<void>((resolve) => { reached = resolve; });
  const job = manager.spawn({
    ...request(1),
    dispatchAdmission: async (signal) => {
      reached();
      return new Promise<undefined>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  await admissionReached;
  assert.equal(manager.check(job.id).status, "queued", "admission does not claim backend startup");
  const final = await manager.cancel(job.id, "cancel admission");
  assert.equal(final.status, "cancelled");
  assert.equal(backend.requests.length, 0, "cancelled admission never reaches the backend");
  await manager.shutdown();
});

test("scheduler admission is bounded by the aggregate startup deadline", async () => {
  const backend = new ControlledBackend("codex");
  const manager = new JobManager({ backends: [backend], startupTimeoutMs: 20 });
  let admissionAborted = false;
  const job = manager.spawn({
    ...request(1),
    dispatchAdmission: (signal) => new Promise<undefined>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        admissionAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const final = await manager.wait(job.id);
  assert.equal(final.status, "failed");
  assert.match(final.error ?? "", /Harness startup timed out after 20ms/);
  assert.equal(admissionAborted, true);
  assert.equal(backend.requests.length, 0, "timed-out admission never starts the backend");
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

test("strict workflow settlement bounds time already spent behind hanging cleanup", async () => {
  let emitFailure!: () => void;
  let settleCompleted!: () => void;
  let closeReached!: () => void;
  let forceCloses = 0;
  const closeStarted = new Promise<void>((resolve) => { closeReached = resolve; });
  const never = new Promise<void>(() => {});
  const backend: Backend = {
    name: "codex",
    async start(_request, emit) {
      emitFailure = () => emit({ type: "failed", error: "quota after progress" });
      return {
        completed: new Promise<void>((resolve) => { settleCompleted = resolve; }),
        async send() {},
        async cancel() {},
        async close() {
          closeReached();
          await never;
        },
        async forceClose() { forceCloses++; },
      };
    },
  };
  const manager = new JobManager({ backends: [backend], operationTimeoutMs: 20 });
  const job = manager.spawn({
    ...request(1),
    workflow: { runId: "wf_settlement_deadline", agentIndex: 0, label: "worker" },
  });
  await tick();
  emitFailure();
  settleCompleted();
  await withTimeout(closeStarted, "launch finalizer entered hanging close");

  await assert.rejects(
    withTimeout(manager.settleFailedWorkflowJob(job.id), "strict settlement", 250),
    /Harness force-close timed out after 20ms/,
  );
  assert.equal(forceCloses, 1, "strict settlement force-closes even while an earlier cleanup owns the queue");
  await withTimeout(manager.releaseRun(job.id), "release after bounded settlement", 100);
  await manager.shutdown(20);
});

test("strict workflow settlement propagates force-close proof failure without trapping workflow release", async () => {
  let fail!: () => void;
  let finish!: () => void;
  let closeReached!: () => void;
  const closeStarted = new Promise<void>((resolve) => { closeReached = resolve; });
  const backend: Backend = {
    name: "codex",
    async start(_request, emit) {
      fail = () => emit({ type: "failed", error: "quota after progress" });
      return {
        completed: new Promise<void>((resolve) => { finish = resolve; }),
        async send() {},
        async cancel() {},
        async close() { closeReached(); await new Promise<void>(() => {}); },
        async forceClose() { throw new Error("process descendants remain"); },
      };
    },
  };
  const manager = new JobManager({ backends: [backend], operationTimeoutMs: 20 });
  const job = manager.spawn({
    ...request(1),
    workflow: { runId: "wf_settlement_failure", agentIndex: 0, label: "worker" },
  });
  await tick();
  fail();
  finish();
  await withTimeout(closeStarted, "launch cleanup entered close");

  await assert.rejects(manager.settleFailedWorkflowJob(job.id), /process descendants remain/);
  await withTimeout(manager.releaseRun(job.id), "release after strict cleanup failure", 100);
  await manager.shutdown(20);
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
  const job = manager.spawn({ ...request(1), speed: "fast" });
  await tick();
  backend.runs.get(job.id)!.emit({ type: "text_delta", text: "partial" });
  backend.runs.get(job.id)!.emit({ type: "thinking_delta", text: "thinking" });
  assert.equal(streamedSnapshots.length, 3);
  assert.equal(streamedSnapshots[1]!.transcript, streamedSnapshots[0]!.transcript, "observer projections reuse unchanged transcript clones across deltas");
  assert.equal(streamedSnapshots[2]!.tools, streamedSnapshots[1]!.tools, "observer projections reuse unchanged tool clones across deltas");
  await manager.send(job.id, "change course", "steer");
  assert.deepEqual(backend.sends, [{ id: job.id, message: "change course", behavior: "steer" }]);
  backend.runs.get(job.id)!.emit({ type: "context", context: { tokens: 1_000, servingModel: "gen-0-model", effectiveSpeed: "fast" } });
  backend.complete(job.id, "done", { input: 3 });
  await manager.wait(job.id);
  assert.ok(observed.includes("completed:completed"));
  const queued = await manager.send(job.id, "review the fixes", "followUp");
  assert.ok(queued.status === "queued" || queued.status === "running");
  assert.equal(queued.context, undefined, "the retained generation boundary clears the prior generation's context before any new telemetry arrives, even if this generation never reports one");
  assert.equal(queued.speed, "fast", "requested speed is fixed across retained generations");
  await tick();
  assert.deepEqual(backend.sends.at(-1), { id: job.id, message: "review the fixes", behavior: "followUp" });
  backend.runs.get(job.id)!.emit({ type: "context", context: { tokens: 2_000, servingModel: "gen-1-model" } });
  backend.complete(job.id, "second result", { input: 2 });
  const continued = await manager.wait(job.id);
  assert.equal(continued.status, "completed");
  assert.equal(continued.output, "second result");
  assert.deepEqual(continued.context, { tokens: 2_000, servingModel: "gen-1-model" }, "a retained follow-up's context replaces the prior generation's gauge");
  assert.equal(continued.usage.input, 5, "usage accumulates across retained generations");
  assert.equal(continued.model, "default", "the configured job model is unaffected by runtime-reported serving models");

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

test("a follow-up's queued generation clears the prior generation's structured payload before any new terminal result arrives", async () => {
  const { backend, manager } = setup(1);
  const job = manager.spawn(request(1));
  await tick();
  backend.complete(job.id, "first result", undefined, { first: true });
  const first = await manager.wait(job.id);
  assert.deepEqual(first.structured, { first: true });

  const queued = await manager.send(job.id, "continue", "followUp");
  assert.equal(queued.structured, undefined, "the new generation's structured payload is unread until its own terminal result arrives");
  await tick();
  backend.complete(job.id, "second result");
  const second = await manager.wait(job.id);
  assert.equal(second.structured, undefined, "a generation that reports no structured payload leaves it absent rather than reusing the prior generation's");
  await manager.shutdown();
});

test("a retained follow-up starts with no progress evidence from the prior generation", async () => {
  const { backend, manager } = setup(1);
  const job = manager.spawn(request(1));
  await tick();
  backend.emit(job.id, { type: "message", text: "first generation progressed" });
  backend.complete(job.id, "first result");
  const first = await manager.wait(job.id);
  assert.equal(first.progressed, true);

  const queued = await manager.send(job.id, "continue", "followUp");
  assert.equal(queued.progressed, undefined);
  await tick();
  backend.fail(job.id, "quota before new-turn progress", {
    provider: "codex",
    kind: "quota",
    authoritative: true,
    detail: "current turn produced no activity",
  });
  const second = await manager.wait(job.id);
  assert.equal(second.progressed, undefined, "only activity from the failed generation can authorize continuation");
  await manager.shutdown();
});

test("continueWorkflowJob is the workflow-only follow-up path: it retains and reuses a completed job's session, accumulates usage, and releaseRun later closes it", async () => {
  const { backend, manager } = setup(1);
  const owned = manager.spawn({ ...request(1), workflow: { runId: "wf-1", agentIndex: 0, label: "planner" } });
  await tick();
  backend.complete(owned.id, "first output", { input: 3, output: 1 });
  const settled = await manager.wait(owned.id);
  assert.equal(settled.status, "completed");
  assert.deepEqual(backend.closes, [], "a completed workflow job's session stays retained instead of closing on completion");

  await assert.rejects(manager.send(owned.id, "direct override", "steer"), /workflow-owned agents are controlled by their workflow/);

  const continuing = manager.continueWorkflowJob(owned.id, "continue the plan");
  await tick();
  assert.deepEqual(backend.sends, [{ id: owned.id, message: "continue the plan", behavior: "followUp" }]);
  backend.complete(owned.id, "second output", { input: 2, output: 1 });
  const queued = await continuing;
  assert.ok(queued.status === "queued" || queued.status === "running");
  const final = await manager.wait(owned.id);
  assert.equal(final.output, "second output");
  assert.equal(final.usage.input, 5, "usage accumulates across generations instead of resetting per follow-up");

  await manager.releaseRun(owned.id);
  assert.deepEqual(backend.closes, [owned.id]);
  await manager.releaseRun(owned.id);
  assert.deepEqual(backend.closes, [owned.id], "releaseRun is idempotent");
  await assert.rejects(manager.continueWorkflowJob(owned.id, "too late"), /native session is no longer available/);

  await manager.shutdown();
});

test("continueWorkflowJob rejects direct jobs, unsettled jobs, and jobs whose retained budget is already exhausted", async () => {
  const { backend, manager } = setup(2);
  const direct = manager.spawn(request(1));
  await tick();
  backend.complete(direct.id, "direct output");
  await manager.wait(direct.id);
  await assert.rejects(manager.continueWorkflowJob(direct.id, "x"), /not workflow-owned/, "direct subagent jobs can never be continued as a workflow lineage");

  const owned = manager.spawn({ ...request(2), workflow: { runId: "wf-2", agentIndex: 0, label: "worker" } });
  await tick();
  await assert.rejects(manager.continueWorkflowJob(owned.id, "too early"), /job is running/);
  backend.complete(owned.id, "done");
  await manager.wait(owned.id);

  const budgeted = manager.spawn({
    ...request(3),
    workflow: { runId: "wf-2", agentIndex: 1, label: "budgeted" },
    budget: { maxTokens: 5 },
  });
  await tick();
  backend.complete(budgeted.id, "within budget", { input: 5, output: 0 });
  await manager.wait(budgeted.id);
  await assert.rejects(manager.continueWorkflowJob(budgeted.id, "blocked"), /later dispatches are blocked/);

  await manager.shutdown();
});

test("queued retained follow-ups cannot bypass the global scheduler", async () => {
  const { backend, manager } = setup(1);
  const first = manager.spawn(request(1));
  await tick();
  backend.complete(first.id, "first result");
  await manager.wait(first.id);

  const blocker = manager.spawn(request(2));
  await tick();
  const queued = await manager.send(first.id, "first follow-up", "followUp");
  assert.equal(queued.status, "queued");
  await assert.rejects(
    manager.send(first.id, "second follow-up", "followUp"),
    /waiting for an available slot/,
  );
  assert.deepEqual(backend.sends, []);

  backend.complete(blocker.id, "blocker result");
  await tick();
  assert.deepEqual(backend.sends, [{ id: first.id, message: "first follow-up", behavior: "followUp" }]);
  backend.complete(first.id, "follow-up result");
  assert.equal((await manager.wait(first.id)).output, "follow-up result");
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

test("manager never dispatches Fast from profile metadata alone", async () => {
  const backend = new ControlledBackend();
  const urgent: ProfileDefinition = {
    name: "urgent",
    description: "",
    harness: "codex",
    speed: "fast",
    systemPrompt: "urgent review",
    filePath: "urgent.md",
    origin: "global",
  };
  const manager = new JobManager({ backends: [backend], profiles: new Map([[urgent.name, urgent]]) });
  const profiled = manager.spawn({ ...request(1), profile: urgent.name });
  const authorized = manager.spawn({ ...request(2), profile: urgent.name, speed: "fast" });
  await tick();
  assert.equal(profiled.speed, "standard");
  assert.equal(authorized.speed, "fast");
  assert.deepEqual(backend.policies.map((policy) => policy.speed), ["standard", "fast"]);
  backend.complete(profiled.id);
  backend.complete(authorized.id);
  await manager.shutdown();
});
