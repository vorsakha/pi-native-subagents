import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { AdvisorRegistry, FileAdvisorStore } from "../src/advisors.ts";
import { JobManager } from "../src/manager.ts";
import {
  ControlledBackend,
  MemoryAdvisorStore,
  ScriptedAdvisorRouter,
  delay,
  tempDir,
} from "./helpers.ts";

const threadId = "thread-advisors";

function setup(options: { idleMs?: number; store?: MemoryAdvisorStore } = {}) {
  const backend = new ControlledBackend("codex");
  const jobs = new JobManager({ backends: [backend] });
  const store = options.store ?? new MemoryAdvisorStore();
  const router = new ScriptedAdvisorRouter("codex", ["codex:skill:security"]);
  const registry = new AdvisorRegistry({
    jobs,
    store,
    router,
    threadId,
    projectRoot: process.cwd(),
    idleMs: options.idleMs,
  });
  return { backend, jobs, store, router, registry };
}

async function openSecurity(registry: AdvisorRegistry) {
  return registry.open({
    threadId,
    name: "Security",
    aliases: ["sec"],
    description: "Review security boundaries and containment",
    cwd: process.cwd(),
    trusted: true,
    harness: "codex",
    requires: ["codex:skill:security"],
    budget: { maxTokens: 80 },
  });
}

test("advisor_open is turn-free and consultation policy is immutable, read-only, and delegation-free", async () => {
  const { backend, jobs, registry, router } = setup();
  const opened = await openSecurity(registry);
  assert.match(opened.id, /^adv_[a-f0-9]{32}$/);
  assert.equal(opened.state, "defined");
  assert.equal(backend.starts.length, 0, "opening resolves policy without starting a model turn");
  assert.equal(registry.get(threadId, "SEC").id, opened.id, "aliases are stable and case-normalized within a thread");
  assert.throws(() => registry.get("other-thread", opened.id), /different parent thread/);

  const consultation = registry.consult({
    threadId,
    advisorId: "sec",
    question: "Does this boundary fail closed?",
    sender: "orchestrator",
  });
  await backend.waitForStart();
  const request = backend.requests[0]!;
  assert.equal(request.policy.access, "readOnly");
  assert.deepEqual(jobs.check(request.jobId).advisor, { advisorId: opened.id, threadId });
  assert.equal(request.interactions, undefined);
  assert.ok(request.policy.piTools.every((tool) => !/subagent|workflow|advisor/i.test(tool)));
  assert.match(request.systemPrompt, /cannot delegate/i);
  assert.equal(request.policy.harness, "codex");
  assert.deepEqual(request.policy.requires, ["codex:skill:security"]);
  backend.emitContinuation(request.jobId, "codex-advisor-thread");
  backend.complete(request.jobId, "The boundary fails closed.", { input: 20, output: 5, turns: 1 });

  const result = await consultation;
  assert.equal(result.ok, true);
  assert.equal(result.generation, 1);
  assert.equal(result.output, "The boundary fails closed.");
  const snapshot = registry.get(threadId, opened.id);
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.usage.input, 20);
  assert.equal(snapshot.ledger[0]?.sender, "orchestrator");
  assert.equal("continuation" in snapshot, false, "native continuation references never enter public snapshots");
  assert.equal(router.calls.length, 2, "the immutable route is revalidated immediately before dispatch");
  await registry.shutdown();
  await jobs.shutdown();
});

test("advisor consultations serialize, accumulate usage, enforce the cumulative budget, and reuse one native session", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "first", sender: "human" });
  const second = registry.consult({ threadId, advisorId: opened.id, question: "second", sender: "workflow" });
  await backend.waitForStart();
  assert.equal(backend.starts.length, 1);
  assert.equal(registry.get(threadId, opened.id).queued, 1);
  const jobId = backend.starts[0]!;
  backend.emitContinuation(jobId, "codex-serialized");
  backend.complete(jobId, "one", { input: 40, output: 10, turns: 1 });
  assert.equal((await first).ok, true);
  await backend.waitForSend();
  assert.equal(backend.starts.length, 1, "the second consultation retains the native session");
  backend.complete(jobId, "two", { input: 30, output: 5, turns: 1 });
  assert.equal((await second).ok, true);
  const snapshot = registry.get(threadId, opened.id);
  assert.equal(snapshot.generation, 2);
  assert.deepEqual(snapshot.usage, { input: 70, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 });
  assert.equal(snapshot.ledger.length, 2);
  await assert.rejects(
    registry.consult({ threadId, advisorId: opened.id, question: "over budget", sender: "human" }),
    /tokens limit reached/i,
  );
  assert.equal(backend.sends.length, 1);
  await registry.shutdown();
  await jobs.shutdown();
});

test("idle advisors release provider resources and lazily resume only their recorded native continuation", async () => {
  const { backend, jobs, registry } = setup({ idleMs: 15 });
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "remember this", sender: "human" });
  await backend.waitForStart();
  const firstJob = backend.starts[0]!;
  backend.emitContinuation(firstJob, "codex-hibernate");
  backend.complete(firstJob, "remembered");
  await first;
  await delay(40);
  assert.equal(registry.get(threadId, opened.id).state, "hibernated");
  assert.ok(backend.closes.includes(firstJob), "idle hibernation closes the resident provider process");

  const resumed = registry.consult({ threadId, advisorId: opened.id, question: "what did I say?", sender: "human" });
  await backend.waitForStart(2);
  const request = backend.requests[1]!;
  assert.deepEqual(request.continuation, {
    harness: "codex",
    threadId: "codex-hibernate",
    sessionFile: "/private/codex-hibernate.jsonl",
  });
  assert.equal(jobs.check(request.jobId).generation, 1);
  backend.emitContinuation(request.jobId, "codex-hibernate");
  backend.complete(request.jobId, "remember this");
  assert.equal((await resumed).ok, true);
  await registry.shutdown();
  await jobs.shutdown();
});

test("missing or failed continuation becomes explicitly unavailable until retry or lineage reset", async () => {
  const store = new MemoryAdvisorStore();
  const firstRuntime = setup({ store });
  const opened = await openSecurity(firstRuntime.registry);
  const first = firstRuntime.registry.consult({ threadId, advisorId: opened.id, question: "answer once", sender: "human" });
  await firstRuntime.backend.waitForStart();
  firstRuntime.backend.complete(firstRuntime.backend.starts[0]!, "answer without continuation", { input: 7, output: 2, turns: 1 });
  assert.equal((await first).ok, true, "the completed answer remains usable");
  assert.equal(firstRuntime.registry.get(threadId, opened.id).state, "unavailable");
  await assert.rejects(
    firstRuntime.registry.consult({ threadId, advisorId: opened.id, question: "again", sender: "human" }),
    /reset or close/i,
  );
  const reset = await firstRuntime.registry.reset(threadId, opened.id);
  assert.equal(reset.id, opened.id, "reset preserves stable advisor identity");
  assert.equal(reset.lineage, 1);
  assert.equal(reset.generation, 0);
  assert.equal(reset.usage.turns, 1, "reset cannot erase cumulative spend");
  assert.equal(reset.usage.input, 7);
  assert.equal(reset.ledger.at(-1)?.state, "reset");
  await firstRuntime.registry.shutdown();
  await firstRuntime.jobs.shutdown();
});

test("route failure preserves identity and continuation for an explicit same-lineage retry", async () => {
  const { backend, jobs, registry, router } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "establish lineage", sender: "human" });
  await backend.waitForStart();
  const firstJob = backend.starts[0]!;
  backend.emitContinuation(firstJob, "codex-retry");
  backend.complete(firstJob, "established");
  await first;
  await registry.hibernate(threadId, opened.id);

  router.error = new Error("capability disappeared");
  const failed = await registry.consult({ threadId, advisorId: opened.id, question: "retry later", sender: "human" });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /capability disappeared/);
  assert.equal(registry.get(threadId, opened.id).state, "unavailable");
  assert.equal(registry.get(threadId, opened.id).lineage, 0);

  router.error = undefined;
  const retry = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "retry same lineage",
    sender: "human",
    retryUnavailable: true,
  });
  await backend.waitForStart(2);
  const request = backend.requests[1]!;
  assert.deepEqual(request.continuation, {
    harness: "codex",
    threadId: "codex-retry",
    sessionFile: "/private/codex-retry.jsonl",
  });
  backend.emitContinuation(request.jobId, "codex-retry");
  backend.complete(request.jobId, "recovered");
  assert.equal((await retry).ok, true);
  assert.equal(registry.get(threadId, opened.id).lineage, 0);
  await registry.shutdown();
  await jobs.shutdown();
});

test("thread rosters persist privately with typed continuations while public state remains bounded", async () => {
  const root = await tempDir("advisor-store");
  try {
    const store = new FileAdvisorStore(root);
    const runtime = setup();
    const registry = new AdvisorRegistry({
      jobs: runtime.jobs,
      store,
      router: runtime.router,
      threadId,
      projectRoot: process.cwd(),
    });
    const opened = await openSecurity(registry);
    const consultation = registry.consult({
      threadId,
      advisorId: opened.id,
      question: "persist me",
      context: "x".repeat(16 * 1024),
      sender: "workflow",
      workflow: { runId: "run-1", phase: "review", callIndex: 2 },
    });
    await runtime.backend.waitForStart();
    const jobId = runtime.backend.starts[0]!;
    runtime.backend.emitContinuation(jobId, "codex-private");
    runtime.backend.complete(jobId, "persisted", { turns: 1 });
    await consultation;
    await registry.shutdown();

    const [file] = await readdir(root);
    assert.ok(file);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(`${root}/${file}`)).mode & 0o777, 0o600);
    const stored = await readFile(`${root}/${file}`, "utf8");
    assert.match(stored, /codex-private/);
    assert.ok(!stored.includes("x".repeat(3_000)), "the ledger is bounded rather than storing the raw context packet");

    const restoredRuntime = setup();
    const restored = new AdvisorRegistry({
      jobs: restoredRuntime.jobs,
      store,
      router: restoredRuntime.router,
      threadId,
      projectRoot: process.cwd(),
    });
    await restored.initialize();
    const snapshot = restored.get(threadId, opened.id);
    assert.equal(snapshot.state, "hibernated");
    assert.equal(snapshot.generation, 1);
    assert.equal(snapshot.ledger[0]?.workflow?.runId, "run-1");
    assert.equal("continuation" in snapshot, false);
    await restored.shutdown();
    await restoredRuntime.jobs.shutdown();
    await runtime.jobs.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisor context and queue bounds fail before provider dispatch", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  await assert.rejects(
    registry.consult({
      threadId,
      advisorId: opened.id,
      question: "too much context",
      context: "x".repeat(16 * 1024 + 1),
      sender: "human",
    }),
    /exceeds 16384 bytes/,
  );
  assert.equal(backend.starts.length, 0);

  const activeController = new AbortController();
  const active = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "active",
    sender: "human",
    signal: activeController.signal,
  });
  await backend.waitForStart();
  const queuedControllers = Array.from({ length: 8 }, () => new AbortController());
  const queued = queuedControllers.map((controller, index) => registry.consult({
    threadId,
    advisorId: opened.id,
    question: `queued ${index}`,
    sender: "human",
    signal: controller.signal,
  }));
  await assert.rejects(
    registry.consult({ threadId, advisorId: opened.id, question: "ninth queued", sender: "human" }),
    /queue is full/,
  );
  assert.equal(registry.get(threadId, opened.id).queued, 8);
  for (const controller of queuedControllers) controller.abort(new Error("test cleanup"));
  activeController.abort(new Error("test cleanup"));
  await Promise.allSettled([active, ...queued]);
  await registry.shutdown();
  await jobs.shutdown();
});
