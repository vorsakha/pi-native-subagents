import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdvisorRegistry, FileAdvisorStore } from "../src/advisors.ts";
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
  backend.complete(firstJob, "remembered");
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
  assert.equal(jobs.checkAdvisorJob(request.jobId, opened.id).generation, 1);
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
  const first = firstRuntime.registry.consult({ threadId, advisorId: opened.id, question: "answer once", sender: "human", trusted: true });
  await firstRuntime.backend.waitForStart();
  firstRuntime.backend.complete(firstRuntime.backend.starts[0]!, "answer without continuation", { input: 7, output: 2, turns: 1 });
  assert.equal((await first).ok, true, "the completed answer remains usable");
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
    payload.advisors[0]!.continuation = { harness: "claude", sessionId: "wrong-harness-private-id" };
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
    await rm(join(portableBase, "native-subagents"), { recursive: true });
    await symlink(redirected, join(portableBase, "native-subagents"), "dir");
    await assert.rejects(portable.save(threadId, []), /private directory|identity changed/i);

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
