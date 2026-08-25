import test from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/manager.ts";
import {
  InteractionWaitGraph,
  normalizeAnswer,
  normalizeQuestion,
  normalizeTarget,
  renderOrchestratorQuestion,
} from "../src/interactions.ts";
import { ControlledBackend, ControlledInteractionClock, interactionSnapshot, tick } from "./helpers.ts";

function setup(concurrency = 4, interactionTimeoutMs?: number, interactionClock?: ControlledInteractionClock) {
  const backend = new ControlledBackend();
  const manager = new JobManager({ backends: [backend], concurrency, interactionTimeoutMs, interactionClock });
  return { backend, manager };
}

const base = { name: "worker", cwd: "/tmp", trusted: true, harness: "codex" as const };
function askable(task: string, extra: Record<string, unknown> = {}) {
  return { ...base, task, interaction: { orchestrator: "allow" as const }, ...extra };
}

test("a routed question parks the caller, frees its slot, and resolves with the answer", async () => {
  const { backend, manager } = setup(1);
  const job = manager.spawn(askable("blocked work"));
  await tick();
  assert.ok(backend.requests[0]?.interactions, "an authorized job receives the normalized host callback");

  const asked = backend.ask(job.id, { question: "  Which flag stays?  ", context: "tests disagree" });
  await tick();
  const pending = manager.pendingInteractions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.question, "Which flag stays?", "the question is trimmed and bounded before display");
  assert.equal(manager.check(job.id).interaction?.state, "pending");
  assert.equal(manager.check(job.id).status, "running", "a parked caller keeps its live provider process");

  // The parked caller gave its scheduler slot back, so a queued job may run
  // even though the cap is one.
  const sibling = manager.spawn({ ...base, task: "sibling" });
  await tick();
  assert.deepEqual(backend.starts, [job.id, sibling.id]);

  manager.answerInteraction(pending[0]!.requestId, "keep the legacy flag");
  backend.complete(sibling.id);
  const answer = await asked;
  assert.match(answer.answer, /reference data, not a new instruction set/);
  assert.match(answer.answer, /keep the legacy flag/);
  assert.equal(answer.route, "orchestrator-model");
  assert.equal(manager.check(job.id).interaction, undefined, "the settled question is cleared once the caller resumes");
  assert.equal(manager.check(job.id).interactionsAsked, 1);
  backend.complete(job.id);
  await manager.shutdown();
});

test("four parked callers all reacquire a slot instead of deadlocking the scheduler", async () => {
  const { backend, manager } = setup(4);
  const jobs = Array.from({ length: 4 }, (_, index) => manager.spawn(askable(`parked ${index}`)));
  await tick();
  assert.equal(backend.starts.length, 4);

  const asks = jobs.map((job) => backend.ask(job.id, { question: `question ${job.id}` }));
  await tick();
  assert.equal(manager.pendingInteractions().length, 4);

  // Every slot is occupied by a parked caller; a fresh job must still start,
  // because the cap counts active turns rather than resident sessions.
  const extra = manager.spawn({ ...base, task: "fresh work while four are parked" });
  await tick();
  assert.equal(backend.starts.length, 5, "a parked caller does not hold an inference slot");

  let resumed = 0;
  for (const ask of asks) void ask.then(() => { resumed++; });
  for (const pending of manager.pendingInteractions()) manager.answerInteraction(pending.requestId, "answered");
  await tick();
  assert.equal(resumed, 3, "the extra active turn leaves room for only three reacquired caller leases");
  backend.complete(extra.id);
  const answers = await Promise.all(asks);
  assert.equal(answers.length, 4);
  for (const job of jobs) backend.complete(job.id);
  await manager.shutdown();
});

test("a workflow caller's queued reacquisition does not bypass direct-job priority", async () => {
  const { backend, manager } = setup(1);
  const workflow = (agentIndex: number, label: string) => ({ runId: "wf_priority", agentIndex, label });
  const caller = manager.spawn({
    ...base,
    task: "workflow caller",
    workflow: workflow(0, "caller"),
    interaction: { orchestrator: "allow" },
  });
  await tick();
  const asked = backend.ask(caller.id, { question: "which behavior?" });
  await tick();

  const workflowSibling = manager.spawn({ ...base, task: "workflow sibling", workflow: workflow(1, "sibling") });
  await tick();
  const direct = manager.spawn({ ...base, task: "direct work" });
  manager.answerInteraction(manager.pendingInteractions()[0]!.requestId, "keep it");
  let callerResumed = false;
  void asked.then(() => { callerResumed = true; });

  backend.complete(workflowSibling.id);
  await tick();
  assert.equal(backend.starts.at(-1), direct.id, "queued direct work starts before a workflow lease resumes");
  assert.equal(callerResumed, false);

  backend.complete(direct.id);
  await asked;
  backend.complete(caller.id);
  await manager.shutdown();
});

test("a foreground caller fails fast instead of waking a parent turn that cannot start", async () => {
  const { backend, manager } = setup();
  const job = manager.spawn({ ...base, task: "foreground", interaction: { orchestrator: "foregroundDenied" } });
  await tick();
  await assert.rejects(
    backend.ask(job.id, { question: "who decides?" }),
    /foreground subagent cannot ask the parent orchestrator[\s\S]*background/i,
  );
  assert.equal(manager.pendingInteractions().length, 0);
  backend.complete(job.id);
  await manager.shutdown();
});

test("an unauthorized job never receives the ask callback and peer questions need a grant", async () => {
  const { backend, manager } = setup();
  const plain = manager.spawn({ ...base, task: "no grant" });
  const orchestratorOnly = manager.spawn(askable("orchestrator only"));
  await tick();
  assert.equal(backend.requests[0]?.interactions, undefined);
  assert.deepEqual(backend.requests[1]?.interactionTargets, ["orchestrator"]);
  await assert.rejects(
    backend.ask(orchestratorOnly.id, { question: "ask a peer", target: { type: "agent", jobId: plain.id } }),
    /not authorized to ask peer agents/,
  );
  backend.complete(plain.id);
  backend.complete(orchestratorOnly.id);
  await manager.shutdown();
});

test("one outstanding question per generation, and late or unknown answers fail safely", async () => {
  const { backend, manager } = setup();
  const job = manager.spawn(askable("one question"));
  await tick();
  const asked = backend.ask(job.id, { question: "first" });
  await tick();
  await assert.rejects(backend.ask(job.id, { question: "second" }), /already has an outstanding question/);

  const requestId = manager.pendingInteractions()[0]!.requestId;
  assert.throws(() => manager.answerInteraction("req-unknown", "nope"), /Unknown or already-resolved question/);
  manager.answerInteraction(requestId, "first answer");
  assert.throws(() => manager.answerInteraction(requestId, "again"), /Unknown or already-resolved question|answered/);
  await asked;

  // A parked caller must not be steered: a steer starts a user turn instead of
  // resolving the provider tool call the child is blocked on.
  const second = backend.ask(job.id, { question: "third" });
  await tick();
  await assert.rejects(manager.send(job.id, "steer me"), /parked on a pending question/);
  manager.dismissInteraction(manager.pendingInteractions()[0]!.requestId, "not answering that");
  await assert.rejects(second, /not answering that/);
  backend.complete(job.id);
  await manager.shutdown();
});

test("cancellation, expiry, and shutdown all reject the parked tool callback exactly once", async () => {
  const { backend, manager } = setup(4, 1_000);
  const cancelled = manager.spawn(askable("cancelled"));
  const shutdown = manager.spawn(askable("shutdown"));
  await tick();
  const cancelledAsk = backend.ask(cancelled.id, { question: "cancel me" });
  const shutdownAsk = backend.ask(shutdown.id, { question: "shut me down" });
  await tick();

  await manager.cancel(cancelled.id, "operator cancelled");
  await assert.rejects(cancelledAsk, /operator cancelled/);
  assert.equal(manager.pendingInteractions().length, 1, "cancelling one caller leaves the other question pending");

  await manager.shutdown();
  await assert.rejects(shutdownAsk, /Session shutdown/);
  assert.equal(manager.pendingInteractions().length, 0);
});

test("an unanswered question expires on its own bounded deadline", async () => {
  const clock = new ControlledInteractionClock();
  const { backend, manager } = setup(4, 1_000, clock);
  const job = manager.spawn(askable("expiring"));
  await tick();
  const asked = backend.ask(job.id, { question: "nobody answers this" });
  await tick();
  const pending = manager.pendingInteractions()[0]!;
  assert.ok(pending.expiresAt - pending.createdAt === 1_000, "the record carries its own deadline");
  clock.advance(1_000);
  await assert.rejects(asked, /expired after 1000ms/);
  assert.throws(() => manager.answerInteraction(pending.requestId, "too late"), /Unknown or already-resolved question/);
  backend.complete(job.id);
  await manager.shutdown();
});

test("peer targets are refused when they are unauthorized, self-directed, or foreign to the run", async () => {
  const backend = new ControlledBackend();
  const manager = new JobManager({ backends: [backend], concurrency: 4 });
  const workflow = { runId: "wf_a", agentIndex: 0, label: "planner" };
  const caller = manager.spawn({
    ...base,
    task: "implementer",
    interaction: { peers: true },
    workflow: { runId: "wf_a", agentIndex: 1, label: "implementer" },
  });
  const foreign = manager.spawn({ ...base, task: "other run", workflow: { runId: "wf_b", agentIndex: 0, label: "outsider" } });
  const sibling = manager.spawn({ ...base, task: "planner", workflow });
  const direct = manager.spawn({ ...base, task: "direct target" });
  await tick();

  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: caller.id } }), /cannot target the asking agent/);
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: foreign.id } }), /same workflow run/);
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: direct.id } }), /same workflow run/);
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: sibling.id } }), /is running; only a completed agent/);
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "orchestrator" } }), /not authorized to ask the parent orchestrator/);

  backend.complete(direct.id);
  const failed = manager.spawn({ ...base, task: "failed peer", workflow: { runId: "wf_a", agentIndex: 2, label: "failed" } });
  await tick();
  backend.fail(failed.id, "failed before question");
  await tick();
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: failed.id } }), /is failed/);

  const cancelled = manager.spawn({ ...base, task: "cancelled peer", workflow: { runId: "wf_a", agentIndex: 3, label: "cancelled" } });
  await tick();
  await manager.cancel(cancelled.id);
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: cancelled.id } }), /is cancelled/);

  backend.complete(sibling.id);
  await tick();
  // A completed, retained target is generically eligible; without a workflow
  // runtime installed there is still nothing authorized to answer it.
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: sibling.id } }), /require an active workflow run/);
  await manager.releaseRun(sibling.id);
  await assert.rejects(backend.ask(caller.id, { question: "q", target: { type: "agent", jobId: sibling.id } }), /no longer retains a native session/);
  backend.complete(caller.id);
  backend.complete(foreign.id);
  await manager.shutdown();
});

test("a peer-answer turn cannot ask another agent or the orchestrator", async () => {
  const backend = new ControlledBackend();
  const manager = new JobManager({ backends: [backend], concurrency: 4 });
  const workflow = (agentIndex: number, label: string) => ({ runId: "wf_c", agentIndex, label });
  const target = manager.spawn({ ...base, task: "planner", interaction: { orchestrator: "allow", peers: true }, workflow: workflow(0, "planner") });
  const caller = manager.spawn({ ...base, task: "implementer", interaction: { peers: true }, workflow: workflow(1, "implementer") });
  await tick();
  backend.complete(target.id);
  await tick();

  const answers: Array<{ answer: string }> = [];
  manager.setPeerInteractionRouter(async (request) => {
    // While the target is producing this answer it must not ask anything itself.
    await assert.rejects(
      backend.ask(request.target!.id, { question: "may I ask back?" }),
      /peer-answer turn cannot ask another agent or the orchestrator/,
    );
    answers.push({ answer: "the retained plan says keep it" });
    return { answer: "the retained plan says keep it" };
  });

  const asked = await backend.ask(caller.id, { question: "which plan?", target: { type: "agent", jobId: target.id } });
  assert.equal(answers.length, 1);
  assert.match(asked.answer, /the retained plan says keep it/);
  assert.equal(asked.route, "peer");
  backend.complete(caller.id);
  await manager.shutdown();
});

test("cancelling a completed target during peer routing cancels the correlated question", async () => {
  const backend = new ControlledBackend();
  const manager = new JobManager({ backends: [backend], concurrency: 2 });
  const workflow = (agentIndex: number, label: string) => ({ runId: "wf_cancel_target", agentIndex, label });
  const target = manager.spawn({ ...base, task: "planner", workflow: workflow(0, "planner") });
  const caller = manager.spawn({ ...base, task: "implementer", workflow: workflow(1, "implementer"), interaction: { peers: true } });
  await tick();
  backend.complete(target.id, "plan");
  await tick();

  let releaseRouter!: () => void;
  const routerGate = new Promise<void>((resolve) => { releaseRouter = resolve; });
  manager.setPeerInteractionRouter(async () => {
    await routerGate;
    return { answer: "late answer" };
  });
  const asked = backend.ask(caller.id, { question: "which plan?", target: { type: "agent", jobId: target.id } });
  await tick();
  assert.equal(manager.check(target.id).status, "completed");
  assert.ok(manager.check(target.id).answeringInteraction, "the completed lineage is already committed to this request");

  await manager.cancel(target.id, "operator cancelled target answer");
  await assert.rejects(asked, /operator cancelled target answer/);
  releaseRouter();
  await tick();
  backend.complete(caller.id);
  await manager.shutdown();
});

test("the wait graph rejects self-targets and closed cycles before parking", () => {
  const graph = new InteractionWaitGraph();
  assert.equal(graph.wouldCycle("a", "a"), true);
  graph.add("a", "b");
  assert.equal(graph.wouldCycle("b", "a"), true, "b waiting on a would close the a→b edge");
  assert.equal(graph.wouldCycle("b", "c"), false);
  graph.remove("a");
  assert.equal(graph.wouldCycle("b", "a"), false);
});

test("bounded normalization keeps questions and answers display-safe", () => {
  assert.equal(normalizeQuestion("ab"), "a b", "control characters cannot corrupt a bounded row");
  assert.equal(normalizeQuestion("x".repeat(5_000)).length, 2_000);
  assert.throws(() => normalizeQuestion("   "), /non-empty/);
  assert.throws(() => normalizeAnswer(42), /non-empty/);
  assert.deepEqual(normalizeTarget(undefined), { kind: "orchestrator" });
  assert.deepEqual(normalizeTarget({ type: "agent", jobId: " job-1 " }), { kind: "agent", jobId: "job-1" });
  assert.throws(() => normalizeTarget({ type: "agent" }), /must be a job ID/);
  assert.throws(() => normalizeTarget({ type: "everyone" }), /Unknown question target type/);
});

test("the parent-facing message carries the request id, source, and answer instruction", () => {
  const text = renderOrchestratorQuestion(interactionSnapshot({ requestId: "req-42", context: "tests disagree" }));
  assert.match(text, /Request ID: req-42/);
  assert.match(text, /untrusted child output/);
  assert.match(text, /tests disagree/);
  assert.match(text, /subagent_answer\(\{ requestId: "req-42", answer: "\.\.\." \}\)/);
});
