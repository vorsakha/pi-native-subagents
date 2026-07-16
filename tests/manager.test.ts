import test from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/manager.ts";
import type { Backend, BackendEvent, BackendRequest, BackendRun, RoleDefinition } from "../src/types.ts";

class FakeBackend implements Backend {
  readonly name = "codex" as const;
  active = 0;
  maxActive = 0;
  starts: string[] = [];
  cancels: string[] = [];
  sends: Array<{ id: string; message: string; behavior: string }> = [];
  readonly runs = new Map<string, { emit: (event: BackendEvent) => void; resolve: () => void }>();

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.starts.push(request.jobId);
    let resolve!: () => void;
    const completed = new Promise<void>((done) => { resolve = () => { this.active--; done(); }; });
    this.runs.set(request.jobId, { emit, resolve });
    return {
      completed,
      send: async (message, behavior = "steer") => { this.sends.push({ id: request.jobId, message, behavior }); },
      cancel: async (reason) => { this.cancels.push(request.jobId); emit({ type: "cancelled", reason }); resolve(); },
      close: async () => undefined,
    };
  }

  complete(id: string, output = "ok"): void {
    const run = this.runs.get(id)!;
    run.emit({ type: "completed", output });
    run.resolve();
  }
}

const role: RoleDefinition = {
  name: "worker", description: "", access: "full", defaultBackend: "codex", nestedAgents: [],
  piTools: [], claudeTools: [], systemPrompt: "worker", filePath: "worker.md",
  routes: {
    pi: { model: "p", thinking: "medium", effort: "medium" },
    claude: { model: "c", thinking: "medium", effort: "medium" },
    codex: { model: "x", thinking: "medium", effort: "medium" },
  },
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(concurrency = 4) {
  const backend = new FakeBackend();
  const manager = new JobManager({ backends: [backend], roles: new Map([[role.name, role]]), concurrency });
  return { backend, manager };
}
function request(n: number) { return { role: "worker", task: `task ${n}`, cwd: "/tmp", trusted: true, backend: "codex" as const }; }

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
  assert.deepEqual(backend.cancels, [running.id]);
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
  const manager = new JobManager({ backends: [backend], roles: new Map([[role.name, role]]) });
  const job = manager.spawn(request(1));
  await tick();
  const final = await manager.cancel(job.id, "race cancellation");
  assert.equal(final.status, "cancelled");
  assert.equal(startupAborted, true);
  await manager.shutdown();
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
  const manager = new JobManager({ backends: [backend], roles: new Map([[role.name, role]]) });
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
  const manager = new JobManager({ backends: [backend], roles: new Map([[role.name, role]]) });
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
  const manager = new JobManager({ backends: [backend], roles: new Map([[role.name, role]]) });
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
  const manager = new JobManager({ backends: [backend], roles: new Map([[role.name, role]]) });
  const job = manager.spawn(request(1));
  await tick();
  await assert.rejects(manager.cancel(job.id), /teardown broke/);
  assert.equal(manager.check(job.id).status, "failed");
  assert.match(manager.check(job.id).error ?? "", /Backend cancellation failed: teardown broke/);
  await manager.shutdown(5);
});

test("manager forwards steering and emits automatic lifecycle observations", async () => {
  const { backend, manager } = setup(1);
  const observed: string[] = [];
  const unsubscribe = manager.subscribe((job, event) => observed.push(`${job.status}:${event.type}`));
  const job = manager.spawn(request(1));
  await tick();
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
  unsubscribe();
  await manager.shutdown();
});

test("manager rejects unknown roles, untrusted execution, and empty tasks", () => {
  const { manager } = setup();
  assert.throws(() => manager.spawn({ ...request(1), role: "missing" }), /Unknown/);
  assert.throws(() => manager.spawn({ ...request(1), trusted: false }), /untrusted/);
  assert.throws(() => manager.spawn({ ...request(1), task: " " }), /empty/);
});
