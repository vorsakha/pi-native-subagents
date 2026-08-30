import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdvisorRegistry, FileAdvisorStore, relativePathEscapesRoot } from "../src/advisors.ts";
import { JobManager } from "../src/manager.ts";
import {
  ControlledBackend,
  MemoryAdvisorStore,
  ScriptedAdvisorRouter,
  delay,
  tempDir,
  waitFor,
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
  assert.equal(registry.get(threadId, "SEC", true).id, opened.id, "aliases are stable and case-normalized within a thread");
  assert.throws(() => registry.get("other-thread", opened.id, true), /different parent thread/);

  const consultation = registry.consult({
    threadId,
    advisorId: "sec",
    question: "Does this boundary fail closed?",
    sender: "orchestrator",
    trusted: true,
  });
  await backend.waitForStart();
  const request = backend.requests[0]!;
  assert.equal(request.policy.access, "readOnly");
  assert.deepEqual(jobs.checkAdvisorJob(request.jobId, opened.id).advisor, { advisorId: opened.id, threadId });
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
  const snapshot = registry.get(threadId, opened.id, true);
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.usage.input, 20);
  assert.equal(snapshot.ledger[0]?.sender, "orchestrator");
  assert.equal("continuation" in snapshot, false, "native continuation references never enter public snapshots");
  assert.equal(router.calls.length, 2, "the immutable route is revalidated immediately before dispatch");
  await registry.shutdown();
  await jobs.shutdown();
});

test("advisor dispatch rechecks trust and generic job controls cannot reach advisor-owned jobs", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  assert.throws(() => registry.list(threadId, false), /untrusted projects/);
  assert.throws(() => registry.get(threadId, opened.id, false), /untrusted projects/);
  await assert.rejects(registry.close(threadId, opened.id, false), /untrusted projects/);
  await assert.rejects(registry.reset(threadId, opened.id, false), /untrusted projects/);
  await assert.rejects(registry.hibernate(threadId, opened.id, false), /untrusted projects/);
  assert.equal(registry.get(threadId, opened.id, true).state, "defined", "untrusted lifecycle calls cannot mutate the roster");
  await assert.rejects(
    registry.consult({
      threadId,
      advisorId: opened.id,
      question: "run from an untrusted context",
      sender: "orchestrator",
      trusted: false,
    }),
    /untrusted projects/,
  );
  assert.equal(backend.starts.length, 0);

  const events: string[] = [];
  const unsubscribe = jobs.subscribe((job) => events.push(job.id));
  const consultation = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "inspect the ownership boundary",
    sender: "human",
    trusted: true,
  });
  await backend.waitForStart();
  const jobId = backend.starts[0]!;
  assert.deepEqual(jobs.list(), [], "advisor jobs are omitted from the generic roster");
  assert.deepEqual(events, [], "advisor snapshots are not published to generic subscribers");
  assert.throws(() => jobs.check(jobId), /advisor-owned jobs/);
  await assert.rejects(jobs.wait(jobId), /advisor-owned jobs/);
  await assert.rejects(jobs.send(jobId, "steer around the registry"), /advisor-owned jobs/);
  await assert.rejects(jobs.cancel(jobId), /advisor-owned jobs/);
  await assert.rejects(jobs.releaseRun(jobId), /advisor-owned jobs/);

  backend.emitContinuation(jobId, "codex-owned");
  backend.complete(jobId, "registry-only");
  assert.equal((await consultation).ok, true);
  unsubscribe();
  await registry.shutdown();
  await jobs.shutdown();
});

test("advisor launch-time gates fail before provider dispatch without corrupting resting state", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const result = await registry.consult({
    threadId,
    advisorId: opened.id,
    question: "must be gated",
    sender: "workflow",
    trusted: true,
    dispatchGate: () => "Workflow token budget reached before launch",
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /budget reached before launch/i);
  assert.equal(backend.starts.length, 0);
  assert.equal(registry.get(threadId, opened.id, true).state, "defined");
  await registry.shutdown();
  await jobs.shutdown();
});

test("failed advisor results report queue delay without including provider runtime", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const { backend, jobs, registry } = setup();
  try {
    const opened = await openSecurity(registry);
    const consultation = registry.consult({
      threadId,
      advisorId: opened.id,
      question: "fail after a long provider turn",
      sender: "human",
      trusted: true,
    });
    await backend.waitForStart();
    now = 6_000;
    backend.fail(backend.starts[0]!, "provider failed after runtime");
    const result = await consultation;
    assert.equal(result.ok, false);
    assert.equal(result.queuedMs, 0);
  } finally {
    Date.now = originalNow;
    await registry.shutdown();
    await jobs.shutdown();
  }
});

test("advisor consultations serialize, accumulate usage, enforce the cumulative budget, and reuse one native session", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "first", sender: "human", trusted: true });
  const second = registry.consult({ threadId, advisorId: opened.id, question: "second", sender: "workflow", trusted: true });
  await backend.waitForStart();
  assert.equal(backend.starts.length, 1);
  assert.equal(registry.get(threadId, opened.id, true).queued, 1);
  const jobId = backend.starts[0]!;
  backend.emitContinuation(jobId, "codex-serialized");
  backend.complete(jobId, "one", { input: 40, output: 10, turns: 1 });
  assert.equal((await first).ok, true);
  await backend.waitForSend();
  assert.equal(backend.starts.length, 1, "the second consultation retains the native session");
  backend.complete(jobId, "two", { input: 30, output: 5, turns: 1 });
  assert.equal((await second).ok, true);
  const snapshot = registry.get(threadId, opened.id, true);
  assert.equal(snapshot.generation, 2);
  assert.deepEqual(snapshot.usage, { input: 70, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 });
  assert.equal(snapshot.ledger.length, 2);
  await assert.rejects(
    registry.consult({ threadId, advisorId: opened.id, question: "over budget", sender: "human", trusted: true }),
    /tokens limit reached/i,
  );
  assert.equal(backend.sends.length, 1);
  await registry.shutdown();
  await jobs.shutdown();
});

test("cancelling a middle queued consultation cannot release the preceding serialization barrier", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "first", sender: "human", trusted: true });
  await backend.waitForStart();
  const jobId = backend.starts[0]!;
  const middleController = new AbortController();
  const middle = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "cancel while queued",
    sender: "human",
    trusted: true,
    signal: middleController.signal,
  });
  const last = registry.consult({ threadId, advisorId: opened.id, question: "last", sender: "human", trusted: true });
  middleController.abort(new Error("cancel middle"));
  await assert.rejects(middle, /cancel/i);
  await delay(5);
  assert.equal(backend.sends.length, 0);
  assert.equal(backend.closes.includes(jobId), false, "later work cannot touch the still-active native run");
  assert.equal(registry.get(threadId, opened.id, true).state, "consulting");

  backend.emitContinuation(jobId, "serialized-cancel");
  backend.complete(jobId, "first answer", { input: 5, output: 1, turns: 1 });
  assert.equal((await first).ok, true);
  await backend.waitForSend();
  backend.complete(jobId, "last answer", { input: 3, output: 1, turns: 1 });
  assert.equal((await last).ok, true);
  assert.equal(backend.starts.length, 1);
  await registry.shutdown();
  await jobs.shutdown();
});

test("closing deletes advisor identity so aliases and roster capacity are reusable immediately", async () => {
  const { jobs, registry } = setup();
  for (let index = 0; index < 16; index++) {
    const opened = await openSecurity(registry);
    const closed = await registry.close(threadId, opened.id, true);
    assert.equal(closed.state, "closed");
    assert.equal(registry.list(threadId, true).length, 0);
  }
  const reopened = await openSecurity(registry);
  assert.equal(registry.get(threadId, "sec", true).id, reopened.id);
  await registry.close(threadId, reopened.id, true);
  await registry.shutdown();
  await jobs.shutdown();
});

test("idle advisors release provider resources and lazily resume only their recorded native continuation", async () => {
  const { backend, jobs, registry } = setup({ idleMs: 15 });
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "remember this", sender: "human", trusted: true });
  await backend.waitForStart();
  const firstJob = backend.starts[0]!;
  backend.emitContinuation(firstJob, "codex-hibernate");
  backend.complete(firstJob, "remembered", { input: 12, output: 3, turns: 1 });
  await first;
  await delay(40);
  assert.equal(registry.get(threadId, opened.id, true).state, "hibernated");
  assert.ok(backend.closes.includes(firstJob), "idle hibernation closes the resident provider process");

  const resumed = registry.consult({ threadId, advisorId: opened.id, question: "what did I say?", sender: "human", trusted: true });
  await backend.waitForStart(2);
  const request = backend.requests[1]!;
  assert.deepEqual(request.continuation, {
    harness: "codex",
    threadId: "codex-hibernate",
    sessionFile: "/private/codex-hibernate.jsonl",
  });
  assert.deepEqual(request.providerUsageBaseline, { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  assert.equal(jobs.checkAdvisorJob(request.jobId, opened.id).generation, 1);
  backend.emitContinuation(request.jobId, "codex-hibernate");
  backend.complete(request.jobId, "remember this");
  assert.equal((await resumed).ok, true);
  await registry.shutdown();
  await jobs.shutdown();
});

test("reset starts a fresh provider usage lineage without erasing cumulative advisor spend", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const oldLineage = registry.consult({ threadId, advisorId: opened.id, question: "old lineage", sender: "human", trusted: true });
  await backend.waitForStart();
  backend.emitContinuation(backend.starts[0]!, "codex-old-lineage");
  backend.complete(backend.starts[0]!, "old", { input: 30, output: 5, turns: 1 });
  await oldLineage;
  await registry.reset(threadId, opened.id, true);

  const fresh = registry.consult({ threadId, advisorId: opened.id, question: "fresh lineage", sender: "human", trusted: true });
  await backend.waitForStart(2);
  const freshJob = backend.starts[1]!;
  assert.equal(backend.requests[1]?.providerUsageBaseline, undefined, "a reset never seeds fresh provider counters with lifetime spend");
  backend.emitContinuation(freshJob, "codex-fresh-lineage");
  backend.complete(freshJob, "fresh", { input: 8, output: 2, turns: 1 });
  await fresh;
  await registry.hibernate(threadId, opened.id, true);

  const resumed = registry.consult({ threadId, advisorId: opened.id, question: "resume fresh", sender: "human", trusted: true });
  await backend.waitForStart(3);
  const resumedRequest = backend.requests[2]!;
  assert.deepEqual(resumedRequest.providerUsageBaseline, {
    input: 8, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1,
  });
  assert.deepEqual(jobs.checkAdvisorJob(resumedRequest.jobId, opened.id).usage, {
    input: 38, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2,
  }, "the JobManager still enforces cumulative advisor spend across reset");
  backend.emitContinuation(resumedRequest.jobId, "codex-fresh-lineage");
  backend.complete(resumedRequest.jobId, "resumed", { input: 1, output: 1, turns: 1 });
  await resumed;
  await registry.shutdown();
  await jobs.shutdown();
});

test("missing or failed continuation becomes explicitly unavailable until retry or lineage reset", async () => {
  const store = new MemoryAdvisorStore();
  const firstRuntime = setup({ store });
  const opened = await openSecurity(firstRuntime.registry);
  const first = firstRuntime.registry.consult({ threadId, advisorId: opened.id, question: "answer once", sender: "human", trusted: true });
  await firstRuntime.backend.waitForStart();
  firstRuntime.backend.complete(firstRuntime.backend.starts[0]!, "answer without continuation", { input: 7, output: 2, turns: 1 });
  assert.equal((await first).ok, true, "the completed answer remains usable");
  assert.ok(firstRuntime.backend.closes.includes(firstRuntime.backend.starts[0]!), "an unusable continuation-free native run is released immediately");
  assert.equal(firstRuntime.registry.get(threadId, opened.id, true).state, "unavailable");
  await assert.rejects(
    firstRuntime.registry.consult({ threadId, advisorId: opened.id, question: "again", sender: "human", trusted: true }),
    /reset or close/i,
  );
  const reset = await firstRuntime.registry.reset(threadId, opened.id, true);
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
  const first = registry.consult({ threadId, advisorId: opened.id, question: "establish lineage", sender: "human", trusted: true });
  await backend.waitForStart();
  const firstJob = backend.starts[0]!;
  backend.emitContinuation(firstJob, "codex-retry");
  backend.complete(firstJob, "established");
  await first;
  await registry.hibernate(threadId, opened.id, true);

  router.error = new Error("capability disappeared");
  const failed = await registry.consult({ threadId, advisorId: opened.id, question: "retry later", sender: "human", trusted: true });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /capability disappeared/);
  assert.equal(registry.get(threadId, opened.id, true).state, "unavailable");
  assert.equal(registry.get(threadId, opened.id, true).lineage, 0);

  router.error = undefined;
  const retry = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "retry same lineage",
    sender: "human",
    trusted: true,
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
  assert.equal(registry.get(threadId, opened.id, true).lineage, 0);
  await registry.shutdown();
  await jobs.shutdown();
});

test("an unavailable retry cannot clear its recovery gate before cumulative budget admission", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "establish budgeted lineage", sender: "human", trusted: true });
  await backend.waitForStart();
  const jobId = backend.starts[0]!;
  backend.emitContinuation(jobId, "budgeted-retry-thread");
  backend.complete(jobId, "established", { input: 20, turns: 1 });
  await first;

  const failed = registry.consult({ threadId, advisorId: opened.id, question: "consume the remaining budget", sender: "human", trusted: true });
  await waitFor(() => backend.sends.length === 1, "retained advisor follow-up");
  backend.emit(jobId, { type: "usage", usage: { input: 60 } });
  backend.fail(jobId, "provider failure at the immutable budget");
  assert.equal((await failed).ok, false);
  const unavailable = registry.get(threadId, opened.id, true);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.usage.input, 80);

  await assert.rejects(registry.consult({
    threadId,
    advisorId: opened.id,
    question: "explicit retry cannot pass budget admission",
    sender: "human",
    trusted: true,
    retryUnavailable: true,
  }), /budget.*tokens limit/i);
  const afterBudgetRejection = registry.get(threadId, opened.id, true);
  assert.equal(afterBudgetRejection.state, "unavailable");
  assert.equal(afterBudgetRejection.error, unavailable.error);
  await assert.rejects(registry.consult({
    threadId,
    advisorId: opened.id,
    question: "retry gate remains explicit",
    sender: "human",
    trusted: true,
  }), /retryUnavailable/);
  await registry.shutdown();
  await jobs.shutdown();
});

test("a failed resumed Codex turn advances the same-lineage provider baseline exactly once", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "establish the native lineage",
    sender: "human",
    trusted: true,
  });
  await backend.waitForStart();
  const firstJob = backend.starts[0]!;
  backend.emitContinuation(firstJob, "codex-failed-turn-baseline");
  backend.complete(firstJob, "established", { input: 10, output: 2, turns: 1 });
  await first;

  const failed = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "fail after provider usage",
    sender: "human",
    trusted: true,
  });
  await backend.waitForSend();
  backend.emit(firstJob, { type: "usage", usage: { input: 5, output: 1, turns: 1 } });
  backend.fail(firstJob, "provider failed after accounting usage");
  assert.equal((await failed).ok, false);

  const retried = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "retry the recorded lineage",
    sender: "human",
    trusted: true,
    retryUnavailable: true,
  });
  await backend.waitForStart(2);
  const retryRequest = backend.requests[1]!;
  assert.deepEqual(retryRequest.providerUsageBaseline, {
    input: 15, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2,
  });
  backend.emitContinuation(retryRequest.jobId, "codex-failed-turn-baseline");
  backend.complete(retryRequest.jobId, "recovered", { input: 2, output: 1, turns: 1 });
  assert.equal((await retried).ok, true);
  await registry.shutdown();
  await jobs.shutdown();
});

test("restoration preserves the unavailable retry gate and its redacted public error", async () => {
  const store = new MemoryAdvisorStore();
  const first = setup({ store });
  const opened = await openSecurity(first.registry);
  const initial = first.registry.consult({
    threadId,
    advisorId: opened.id,
    question: "establish restorable lineage",
    sender: "human",
    trusted: true,
  });
  await first.backend.waitForStart();
  first.backend.emitContinuation(first.backend.starts[0]!, "persisted-retry-secret");
  first.backend.complete(first.backend.starts[0]!, "established");
  await initial;
  await first.registry.hibernate(threadId, opened.id, true);
  first.router.error = new Error("failed /private/persisted-retry-secret.jsonl for persisted-retry-secret");
  assert.equal((await first.registry.consult({
    threadId,
    advisorId: opened.id,
    question: "persist unavailable",
    sender: "human",
    trusted: true,
  })).ok, false);
  await first.registry.shutdown();
  await first.jobs.shutdown();

  const restored = setup({ store });
  await restored.registry.initialize();
  const snapshot = restored.registry.get(threadId, opened.id, true);
  assert.equal(snapshot.state, "unavailable");
  assert.doesNotMatch(snapshot.error ?? "", /persisted-retry-secret|\/private\/persisted-retry-secret\.jsonl/);
  await assert.rejects(restored.registry.consult({
    threadId,
    advisorId: opened.id,
    question: "cannot bypass after restore",
    sender: "human",
    trusted: true,
  }), /retryUnavailable/);
  assert.equal(restored.backend.starts.length, 0);
  await restored.registry.shutdown();
  await restored.jobs.shutdown();
});

test("resume failures preserve exact lineage, redact private identities, and keep retry admission explicit", async () => {
  const { backend, jobs, registry, router } = setup();
  const opened = await openSecurity(registry);
  const first = registry.consult({ threadId, advisorId: opened.id, question: "establish private lineage", sender: "human", trusted: true });
  await backend.waitForStart();
  const firstJob = backend.starts[0]!;
  backend.emitContinuation(firstJob, "codex-recorded-secret");
  backend.complete(firstJob, "established");
  await first;
  await registry.hibernate(threadId, opened.id, true);

  router.error = new Error("cannot resume codex-recorded-secret at /private/codex-recorded-secret.jsonl");
  const failed = await registry.consult({
    threadId,
    advisorId: opened.id,
    question: "route failure",
    sender: "human",
    trusted: true,
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.error ?? "", /codex-recorded-secret|\/private\/codex-recorded-secret\.jsonl/);
  const unavailable = registry.get(threadId, opened.id, true);
  assert.equal(unavailable.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable.ledger), /codex-recorded-secret|\/private\/codex-recorded-secret\.jsonl/);

  router.error = undefined;
  const aborted = new AbortController();
  aborted.abort(new Error("cancel before admission"));
  await assert.rejects(registry.consult({
    threadId,
    advisorId: opened.id,
    question: "cancelled retry",
    sender: "human",
    trusted: true,
    retryUnavailable: true,
    signal: aborted.signal,
  }), /cancel before admission/);
  const afterAbort = registry.get(threadId, opened.id, true);
  assert.equal(afterAbort.state, "unavailable", "cancelled admission cannot clear the unavailable recovery gate");
  assert.equal(afterAbort.error, unavailable.error);
  assert.equal(afterAbort.generation, unavailable.generation);
  await assert.rejects(registry.consult({
    threadId,
    advisorId: opened.id,
    question: "retry flag remains required",
    sender: "human",
    trusted: true,
  }), /retryUnavailable/);

  const drifted = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "provider identity drift",
    sender: "human",
    trusted: true,
    retryUnavailable: true,
  });
  await backend.waitForStart(2);
  backend.emitContinuation(backend.starts[1]!, "codex-replacement-secret");
  backend.complete(backend.starts[1]!, "wrong lineage");
  const driftedResult = await drifted;
  assert.equal(driftedResult.ok, false);
  assert.match(driftedResult.error ?? "", /different native advisor identity/);
  assert.doesNotMatch(JSON.stringify(registry.get(threadId, opened.id, true)), /codex-(?:recorded|replacement)-secret/);
  assert.ok(backend.closes.includes(backend.starts[1]!), "a rejected provider lineage releases its retained native run");

  const recovered = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "resume the recorded lineage",
    sender: "human",
    trusted: true,
    retryUnavailable: true,
  });
  await backend.waitForStart(3);
  const recoveryRequest = backend.requests[2]!;
  assert.deepEqual(recoveryRequest.continuation, {
    harness: "codex",
    threadId: "codex-recorded-secret",
    sessionFile: "/private/codex-recorded-secret.jsonl",
  });
  backend.emitContinuation(recoveryRequest.jobId, "codex-recorded-secret");
  backend.complete(recoveryRequest.jobId, "same lineage");
  assert.equal((await recovered).ok, true);
  await registry.shutdown();
  await jobs.shutdown();
});

test("first-generation provider failures redact every newly reported native reference", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  const consultation = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "fail after reporting a private identity",
    sender: "human",
    trusted: true,
  });
  await backend.waitForStart();
  const jobId = backend.starts[0]!;
  backend.emitContinuation(jobId, "first-generation-private-id");
  backend.fail(jobId, "provider failed first-generation-private-id at /private/first-generation-private-id.jsonl");
  const result = await consultation;
  const publicState = JSON.stringify({ result, snapshot: registry.get(threadId, opened.id, true) });
  assert.equal(result.ok, false);
  assert.doesNotMatch(publicState, /first-generation-private-id|\/private\/first-generation-private-id\.jsonl/);
  assert.ok(backend.closes.includes(jobId), "failed native advisor runs are released before their job handle is dropped");
  await registry.shutdown();
  await jobs.shutdown();
});

test("workflow advisor turns remain in the workflow scheduler lane behind direct work", async () => {
  const backend = new ControlledBackend("codex");
  const jobs = new JobManager({ backends: [backend], concurrency: 1 });
  const registry = new AdvisorRegistry({
    jobs,
    store: new MemoryAdvisorStore(),
    router: new ScriptedAdvisorRouter("codex", ["codex:skill:security"]),
    threadId,
    projectRoot: process.cwd(),
  });
  const opened = await openSecurity(registry);
  const blocker = jobs.spawn({ task: "active direct blocker", cwd: process.cwd(), trusted: true, harness: "codex" });
  await backend.waitForStart();

  const advisor = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "queued workflow advice",
    sender: "workflow",
    trusted: true,
    workflow: { runId: "wf_priority", callIndex: 0 },
  });
  await waitFor(() => registry.get(threadId, opened.id, true).state === "consulting", "advisor consultation admission");
  const direct = jobs.spawn({ task: "later direct work", cwd: process.cwd(), trusted: true, harness: "codex" });

  backend.complete(blocker.id);
  await backend.waitForStart(2);
  assert.equal(backend.starts[1], direct.id, "direct work wins the next global slot");
  backend.complete(direct.id);
  await backend.waitForStart(3);
  const advisorJob = backend.starts[2]!;
  assert.deepEqual(jobs.checkAdvisorJob(advisorJob, opened.id).advisor, {
    advisorId: opened.id,
    threadId,
    workflow: { runId: "wf_priority", callIndex: 0 },
  });
  backend.emitContinuation(advisorJob, "workflow-advisor-thread");
  backend.complete(advisorJob, "advice");
  assert.equal((await advisor).ok, true);
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
      trusted: true,
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
    const snapshot = restored.get(threadId, opened.id, true);
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

test("restoration rejects malformed bounded records and ambiguous advisor identities", async () => {
  const store = new MemoryAdvisorStore();
  const first = setup({ store });
  const opened = await openSecurity(first.registry);
  const consultation = first.registry.consult({
    threadId,
    advisorId: opened.id,
    question: "create a bounded ledger entry",
    sender: "human",
    trusted: true,
  });
  await first.backend.waitForStart();
  first.backend.emitContinuation(first.backend.starts[0]!, "validation-thread");
  first.backend.complete(first.backend.starts[0]!, "bounded answer");
  await consultation;
  await first.registry.open({
    threadId,
    name: "Privacy",
    aliases: ["private-review"],
    description: "Review persisted privacy constraints",
    cwd: process.cwd(),
    trusted: true,
    harness: "codex",
  });
  await first.registry.shutdown();
  await first.jobs.shutdown();
  const valid = structuredClone(store.records.get(threadId)!);

  const expectInvalid = async (mutate: (records: typeof valid) => void) => {
    const records = structuredClone(valid);
    mutate(records);
    store.records.set(threadId, records);
    const runtime = setup({ store });
    await assert.rejects(runtime.registry.initialize(), /Invalid advisor state/);
    await runtime.jobs.shutdown();
  };
  await expectInvalid((records) => { records[0]!.ledger[0]!.output = "x".repeat(4_001); });
  await expectInvalid((records) => { records[0]!.updatedAt = -1; });
  await expectInvalid((records) => { records[0]!.name = "x".repeat(161); });
  await expectInvalid((records) => { records[1]!.aliases = [...records[1]!.aliases, records[0]!.aliases[0]!]; });
});

test("malformed stored continuations preserve the advisor roster as explicitly unavailable", async () => {
  const root = await tempDir("advisor-invalid-continuation");
  const store = new FileAdvisorStore(root);
  const first = setup();
  try {
    const registry = new AdvisorRegistry({
      jobs: first.jobs,
      store,
      router: first.router,
      threadId,
      projectRoot: process.cwd(),
    });
    const opened = await openSecurity(registry);
    const consulted = registry.consult({
      threadId,
      advisorId: opened.id,
      question: "persist stable identity",
      sender: "human",
      trusted: true,
    });
    await first.backend.waitForStart();
    first.backend.emitContinuation(first.backend.starts[0]!, "stored-valid-thread");
    first.backend.complete(first.backend.starts[0]!, "preserved answer", { input: 9, output: 2, turns: 1 });
    await consulted;
    await registry.shutdown();

    const [file] = await readdir(root);
    assert.ok(file);
    const path = join(root, file);
    const payload = JSON.parse(await readFile(path, "utf8")) as { advisors: Array<Record<string, unknown>> };
    payload.advisors[0]!.continuation = { harness: "claude", sessionId: 7 };
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });

    const restoredBackend = new ControlledBackend("codex");
    const restoredJobs = new JobManager({ backends: [restoredBackend] });
    const restored = new AdvisorRegistry({
      jobs: restoredJobs,
      store,
      router: new ScriptedAdvisorRouter("codex", ["codex:skill:security"]),
      threadId,
      projectRoot: process.cwd(),
    });
    await restored.initialize();
    const snapshot = restored.get(threadId, opened.id, true);
    assert.equal(snapshot.id, opened.id);
    assert.equal(snapshot.state, "unavailable");
    assert.match(snapshot.error ?? "", /continuation is invalid.*reset or close/i);
    assert.equal(snapshot.generation, 1);
    assert.equal(snapshot.usage.input, 9);
    assert.equal(snapshot.ledger[0]?.output, "preserved answer");
    assert.equal(restoredBackend.starts.length, 0);
    const reset = await restored.reset(threadId, opened.id, true);
    assert.equal(reset.id, opened.id);
    assert.equal(reset.state, "defined");
    assert.equal(reset.lineage, 1);
    assert.equal(reset.usage.input, 9);
    await restored.shutdown();
    await restoredJobs.shutdown();
  } finally {
    await first.jobs.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("restoration preserves a changed cwd as unavailable and rejects symlink replacement outside the project", async () => {
  const project = await tempDir("advisor-project");
  const outside = await tempDir("advisor-outside");
  const advisorCwd = join(project, "review");
  const store = new MemoryAdvisorStore();
  await mkdir(advisorCwd);
  try {
    const firstBackend = new ControlledBackend("codex");
    const firstJobs = new JobManager({ backends: [firstBackend] });
    const first = new AdvisorRegistry({
      jobs: firstJobs,
      store,
      router: new ScriptedAdvisorRouter("codex"),
      threadId,
      projectRoot: project,
    });
    const opened = await first.open({
      threadId,
      name: "Contained",
      description: "Review cwd containment",
      cwd: advisorCwd,
      trusted: true,
      harness: "codex",
    });
    await first.shutdown();
    await firstJobs.shutdown();

    await rm(advisorCwd, { recursive: true });
    await symlink(outside, advisorCwd, "dir");
    const restoredBackend = new ControlledBackend("codex");
    const restoredJobs = new JobManager({ backends: [restoredBackend] });
    const restored = new AdvisorRegistry({
      jobs: restoredJobs,
      store,
      router: new ScriptedAdvisorRouter("codex"),
      threadId,
      projectRoot: project,
    });
    await restored.initialize();
    const snapshot = restored.get(threadId, opened.id, true);
    assert.equal(snapshot.state, "unavailable");
    assert.match(snapshot.error ?? "", /cwd.*changed|trusted project directory/i);
    await assert.rejects(
      restored.consult({
        threadId,
        advisorId: opened.id,
        question: "must not dispatch",
        sender: "human",
        trusted: true,
      }),
      /cwd.*changed|trusted project directory/i,
    );
    assert.equal(restoredBackend.starts.length, 0);
    await restored.shutdown();
    await restoredJobs.shutdown();
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("restored advisors trim only profile boundaries and preserve internal whitespace", async () => {
  const store = new MemoryAdvisorStore();
  const first = setup({ store });
  first.router.resolution = {
    harness: "codex",
    requires: [],
    effort: "high",
    profileBinding: { name: "security  audit", systemPrompt: "ORIGINAL IMMUTABLE PROFILE" },
  };
  const opened = await first.registry.open({
    threadId,
    name: "Profiled",
    description: "Use one fixed specialist profile",
    cwd: process.cwd(),
    trusted: true,
    harness: "codex",
    profile: "  security  audit  ",
  });
  assert.equal(opened.policy.profile, "security  audit");
  assert.equal(opened.policy.effort, "high");
  const initial = first.registry.consult({
    threadId,
    advisorId: opened.id,
    question: "first profile check",
    sender: "human",
    trusted: true,
  });
  await first.backend.waitForStart();
  assert.match(first.backend.requests[0]!.systemPrompt, /ORIGINAL IMMUTABLE PROFILE/);
  first.backend.emitContinuation(first.backend.starts[0]!, "profile-thread");
  first.backend.complete(first.backend.starts[0]!, "first");
  await initial;
  await first.registry.shutdown();
  await first.jobs.shutdown();

  const restored = setup({ store });
  restored.router.resolution = {
    harness: "codex",
    requires: [],
    effort: "low",
    profileBinding: { name: "security  audit", systemPrompt: "MUTATED PROFILE" },
  };
  await restored.registry.initialize();
  const resumed = restored.registry.consult({
    threadId,
    advisorId: opened.id,
    question: "second profile check",
    sender: "human",
    trusted: true,
  });
  await restored.backend.waitForStart();
  const request = restored.backend.requests[0]!;
  assert.equal(request.policy.effort, "high");
  assert.match(request.systemPrompt, /ORIGINAL IMMUTABLE PROFILE/);
  assert.doesNotMatch(request.systemPrompt, /MUTATED PROFILE/);
  restored.backend.emitContinuation(request.jobId, "profile-thread");
  restored.backend.complete(request.jobId, "second");
  assert.equal((await resumed).ok, true);
  await restored.registry.shutdown();
  await restored.jobs.shutdown();
});

test("Windows cross-volume relative paths fail advisor cwd containment", () => {
  assert.equal(relativePathEscapesRoot("D:\\outside", "win32"), true);
  assert.equal(relativePathEscapesRoot("review\\nested", "win32"), false);
  assert.equal(relativePathEscapesRoot("..\\outside", "win32"), true);
});

test("advisor private persistence rejects symlinked roots and state files", async () => {
  const base = await tempDir("advisor-symlink-store");
  const redirected = await tempDir("advisor-symlink-target");
  try {
    const linkedRoot = join(base, "linked-root");
    await symlink(redirected, linkedRoot, "dir");
    await assert.rejects(new FileAdvisorStore(linkedRoot).save(threadId, []), /private directory|symbolic link|ELOOP|ENOTDIR/i);

    const privateBase = join(base, "agent-dir");
    await mkdir(privateBase);
    await symlink(redirected, join(privateBase, "native-subagents"), "dir");
    const nested = new FileAdvisorStore(join(privateBase, "native-subagents", "advisors"), privateBase);
    await assert.rejects(nested.save(threadId, []), /private directory|symbolic link|ELOOP|ENOTDIR/i);
    assert.deepEqual(await readdir(redirected), [], "a symlinked private-root ancestor cannot receive advisor state");

    const portableBase = join(base, "portable-agent-dir");
    await mkdir(portableBase);
    const portableRoot = join(portableBase, "native-subagents", "advisors");
    const portable = new FileAdvisorStore(portableRoot, portableBase, { descriptorAnchoring: false });
    await portable.save(threadId, []);
    assert.deepEqual(await portable.load(threadId), [], "platforms without descriptor paths retain private-store functionality");
    await symlink(redirected, join(portableBase, "native-subagents"), "dir");
    await portable.save(threadId, []);
    assert.deepEqual(await portable.load(threadId), []);
    assert.deepEqual(await readdir(redirected), [], "portable storage never traverses replaceable nested components");

    const root = join(base, "private");
    const store = new FileAdvisorStore(root);
    await store.save(threadId, []);
    const [stateName] = await readdir(root);
    assert.ok(stateName);
    const statePath = join(root, stateName);
    const target = join(redirected, "tracked-looking.json");
    await writeFile(target, "do not overwrite", "utf8");
    await rm(statePath);
    await symlink(target, statePath);
    await assert.rejects(store.load(threadId), /symbolic link|regular file|ELOOP/i);
    await assert.rejects(store.save(threadId, []), /regular file/);
    assert.equal(await readFile(target, "utf8"), "do not overwrite");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(redirected, { recursive: true, force: true });
  }
});

test("advisor persistence rejects a valid roster whose UTF-8 encoding cannot be restored", async () => {
  const base = await tempDir("advisor-store-size");
  const memory = new MemoryAdvisorStore();
  const runtime = setup({ store: memory });
  try {
    await openSecurity(runtime.registry);
    const source = memory.records.get(threadId)?.[0];
    assert.ok(source);
    const records = Array.from({ length: 16 }, (_, advisorIndex) => ({
      ...structuredClone(source),
      id: `adv_${advisorIndex.toString(16).padStart(32, "0")}`,
      name: `Advisor ${advisorIndex}`,
      aliases: [`advisor ${advisorIndex}`],
      ledger: Array.from({ length: 32 }, (_, entryIndex) => ({
        index: entryIndex,
        lineage: 0,
        generation: entryIndex + 1,
        sender: "human" as const,
        question: "😀".repeat(1_000),
        context: "😀".repeat(1_000),
        state: "completed" as const,
        output: "😀".repeat(2_000),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
        startedAt: source.createdAt + entryIndex,
        endedAt: source.createdAt + entryIndex,
      })),
    }));
    const fileStore = new FileAdvisorStore(join(base, "advisors"), base);
    await assert.rejects(fileStore.save(threadId, records), /state exceeds 4194304 bytes/i);
    assert.deepEqual(await readdir(base), [], "an oversized unrestorable roster is rejected before filesystem mutation");
  } finally {
    await runtime.registry.shutdown();
    await runtime.jobs.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("concurrent advisor opens reserve aliases and capacity atomically and roll back failed persistence", async () => {
  const duplicate = setup();
  let releaseRoute!: () => void;
  duplicate.router.barrier = new Promise<void>((resolve) => { releaseRoute = resolve; });
  const first = openSecurity(duplicate.registry);
  await waitFor(() => duplicate.router.calls.length === 1, "first advisor route");
  const second = openSecurity(duplicate.registry);
  releaseRoute();
  const duplicateResults = await Promise.allSettled([first, second]);
  assert.deepEqual(duplicateResults.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(duplicate.registry.list(threadId, true).length, 1);
  await duplicate.registry.shutdown();
  await duplicate.jobs.shutdown();

  const capacity = setup();
  for (let index = 0; index < 15; index++) {
    await capacity.registry.open({
      threadId,
      name: `Advisor ${index}`,
      description: "capacity fixture",
      cwd: process.cwd(),
      trusted: true,
      harness: "codex",
    });
  }
  let releaseCapacity!: () => void;
  capacity.router.barrier = new Promise<void>((resolve) => { releaseCapacity = resolve; });
  const sixteenth = capacity.registry.open({
    threadId, name: "Advisor 15", description: "capacity fixture", cwd: process.cwd(), trusted: true, harness: "codex",
  });
  await waitFor(() => capacity.router.calls.length === 16, "sixteenth advisor route");
  const seventeenth = capacity.registry.open({
    threadId, name: "Advisor 16", description: "capacity fixture", cwd: process.cwd(), trusted: true, harness: "codex",
  });
  releaseCapacity();
  const capacityResults = await Promise.allSettled([sixteenth, seventeenth]);
  assert.deepEqual(capacityResults.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(capacity.registry.list(threadId, true).length, 16);
  await capacity.registry.shutdown();
  await capacity.jobs.shutdown();

  const rollback = setup();
  rollback.store.saveError = new Error("persistence failed");
  await assert.rejects(openSecurity(rollback.registry), /persistence failed/);
  assert.deepEqual(rollback.registry.list(threadId, true), []);
  rollback.store.saveError = undefined;
  assert.equal((await openSecurity(rollback.registry)).aliases.includes("sec"), true);
  await rollback.registry.shutdown();
  await rollback.jobs.shutdown();
});

test("advisor lifecycle transitions exclude new consultation admission while native release is pending", async () => {
  for (const transition of ["reset", "hibernate", "close"] as const) {
    const { backend, jobs, registry } = setup();
    const opened = await openSecurity(registry);
    const initial = registry.consult({ threadId, advisorId: opened.id, question: "retain", sender: "human", trusted: true });
    await backend.waitForStart();
    const jobId = backend.starts[0]!;
    backend.emitContinuation(jobId, `codex-${transition}`);
    backend.complete(jobId, "retained", { input: 2, output: 1, turns: 1 });
    await initial;
    let releaseClose!: () => void;
    backend.closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const lifecycle = registry[transition](threadId, opened.id, true);
    await waitFor(() => backend.closes.includes(jobId), `${transition} native release`);
    await assert.rejects(
      registry.consult({ threadId, advisorId: opened.id, question: "race release", sender: "human", trusted: true }),
      new RegExp(`${transition} is in progress`),
    );
    assert.equal(backend.starts.length, 1);
    releaseClose();
    await lifecycle;
    await registry.shutdown();
    await jobs.shutdown();
  }
});

test("shutdown waits for restoration before persisting the durable roster", async () => {
  const store = new MemoryAdvisorStore();
  const first = setup({ store });
  const opened = await openSecurity(first.registry);
  await first.registry.shutdown();
  await first.jobs.shutdown();

  let releaseLoad!: () => void;
  store.loadBarrier = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const restored = setup({ store });
  const initializing = restored.registry.initialize();
  let shutdownFinished = false;
  const shutdown = restored.registry.shutdown().then(() => { shutdownFinished = true; });
  await delay(5);
  assert.equal(shutdownFinished, false);
  assert.equal(store.records.get(threadId)?.length, 1, "shutdown cannot overwrite a pending restored roster with an empty snapshot");
  releaseLoad();
  await Promise.all([initializing, shutdown]);
  assert.equal(restored.registry.get(threadId, opened.id, true).id, opened.id);
  assert.equal(store.records.get(threadId)?.[0]?.id, opened.id);
  await restored.jobs.shutdown();
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
      trusted: true,
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
    trusted: true,
    signal: activeController.signal,
  });
  await backend.waitForStart();
  const queuedControllers = Array.from({ length: 8 }, () => new AbortController());
  const queued = queuedControllers.map((controller, index) => registry.consult({
    threadId,
    advisorId: opened.id,
    question: `queued ${index}`,
    sender: "human",
    trusted: true,
    signal: controller.signal,
  }));
  await assert.rejects(
    registry.consult({ threadId, advisorId: opened.id, question: "ninth queued", sender: "human", trusted: true }),
    /queue is full/,
  );
  assert.equal(registry.get(threadId, opened.id, true).queued, 8);
  for (const controller of queuedControllers) controller.abort(new Error("test cleanup"));
  activeController.abort(new Error("test cleanup"));
  await Promise.allSettled([active, ...queued]);
  await registry.shutdown();
  await jobs.shutdown();
});

test("cancellation and shutdown keep serialization until native teardown and usage settlement finish", async () => {
  const { backend, jobs, registry } = setup();
  const opened = await openSecurity(registry);
  let releaseCancellation!: () => void;
  backend.cancelBarrier = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  const controller = new AbortController();
  const active = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "active cancellation",
    sender: "human",
    trusted: true,
    signal: controller.signal,
  });
  await backend.waitForStart();
  const jobId = backend.starts[0]!;
  const queued = registry.consult({
    threadId,
    advisorId: opened.id,
    question: "must not overlap teardown",
    sender: "workflow",
    trusted: true,
  });
  const queuedSettled = queued.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

  controller.abort(new Error("cancel active advisor"));
  await delay(5);
  assert.equal(backend.cancels.length, 1);
  assert.equal(backend.sends.length, 0, "the queued consultation cannot reuse a cancelling native session");
  backend.emit(jobId, { type: "usage", usage: { input: 13, output: 2, turns: 1 } });
  let shutdownFinished = false;
  const shutdown = registry.shutdown().then(() => { shutdownFinished = true; });
  await delay(5);
  assert.equal(shutdownFinished, false, "shutdown waits for the consultation tail and native cancellation");
  assert.equal(backend.starts.length, 1);

  releaseCancellation();
  const result = await active;
  await shutdown;
  await queuedSettled;
  assert.equal(result.ok, false);
  assert.equal(backend.starts.length, 1, "no replacement lineage starts during cancellation settlement");
  const snapshot = registry.get(threadId, opened.id, true);
  assert.deepEqual(snapshot.usage, { input: 13, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  assert.equal(snapshot.ledger.at(-1)?.state, "cancelled");
  assert.deepEqual(snapshot.ledger.at(-1)?.usage, snapshot.usage);
  await jobs.shutdown();
});
