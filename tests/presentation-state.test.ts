import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import { createNativeSubagentsStatePublisher } from "../extensions/subagents/state-publisher.ts";
import {
  MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES,
  MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS,
  MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS,
  MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS,
  MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES,
  MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS,
  MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS,
  MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS,
  NATIVE_SUBAGENTS_PRODUCER_NAME,
  NATIVE_SUBAGENTS_STATE_EVENT_V1,
  NATIVE_SUBAGENTS_STATE_V1_LIMITS,
  NativeSubagentsStateV1Schema,
  fingerprintNativeSubagentsStateV1,
  projectNativeSubagentsStateV1,
  validateNativeSubagentsStateV1,
  type NativeSubagentsProjectionOptionsV1,
  type NativeSubagentsStateV1,
} from "../src/presentation-state.ts";
import type { JobSnapshot } from "../src/types.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";
import {
  ControlledBackend,
  FailingWorkflowRegistration,
  ImmediateBackend,
  context,
  fakePi,
  interactionSnapshot,
  jobSnapshot,
  readyProviderStatusReader,
  tempDir,
  tick,
  waitFor,
  workflowSnapshotFixture,
} from "./helpers.ts";

const PRIVATE = "PRIVATE_CANARY_DO_NOT_PUBLISH";
const UNLABELED_STDERR_OUTPUT = "PRIVATE_CANARY_WITHOUT_TRIGGER_WORDS";
const UNLABELED_PROVIDER_MESSAGE = "REMOTE_FAILURE_CANARY_8472";
const RAW_RESULT_CANARY = "DELIVERED_RELEASE_SUMMARY_CANARY_9284";
const projectionOptions: NativeSubagentsProjectionOptionsV1 = {
  producerVersion: "0.1.0",
  instanceId: "runtime-1",
  sequence: 1,
  emittedAt: 9_000,
  cause: "startup",
  sessionId: "session-1",
  lifecycle: "active",
};

function project(jobs: JobSnapshot[], workflows: WorkflowSnapshot[]): NativeSubagentsStateV1 {
  return projectNativeSubagentsStateV1(jobs, workflows, projectionOptions);
}

test("V1 presentation strings reject unsafe input while projection sanitizes manager text", () => {
  const projected = project([jobSnapshot({
    id: "job-\u001b[31mred",
    name: "worker\u001b]0;owned\u0007 safe\u202E",
    model: "model \uD800safe",
  })], []);
  assert.equal(validateNativeSubagentsStateV1(projected), true);
  assert.equal(projected.jobs[0]!.id, "job-red");
  assert.equal(projected.jobs[0]!.name, "worker safe");
  assert.equal(projected.jobs[0]!.route.model, "model safe");

  const boundary = project([jobSnapshot({ name: `${"x".repeat(159)} suffix` })], []);
  assert.equal(boundary.jobs[0]!.name, "x".repeat(159));
  assert.equal(validateNativeSubagentsStateV1(boundary), true, "truncation cannot leave schema-invalid trailing whitespace");

  const valid = project([jobSnapshot({ id: "job-safe", status: "queued" })], []);
  const cases: Array<{ label: string; mutate(state: NativeSubagentsStateV1): void }> = [
    { label: "ESC identifier", mutate: (state) => { state.jobs[0]!.id = "job-\u001b[31mred"; } },
    { label: "OSC name", mutate: (state) => { state.jobs[0]!.name = "worker\u001b]0;owned\u0007"; } },
    { label: "C1 CSI model", mutate: (state) => { state.jobs[0]!.route.model = "model\u009B31m"; } },
    { label: "bidi summary", mutate: (state) => { state.jobs[0]!.waitingSummary = "waiting \u202Ehidden"; } },
    { label: "invalid surrogate", mutate: (state) => { state.session.id = "session-\uD800"; } },
    { label: "unnormalized whitespace", mutate: (state) => { state.jobs[0]!.waitingSummary = "two  spaces"; } },
  ];
  for (const entry of cases) {
    const candidate = structuredClone(valid);
    entry.mutate(candidate);
    assert.equal(Check(NativeSubagentsStateV1Schema, candidate), false, entry.label);
    assert.equal(validateNativeSubagentsStateV1(candidate), false, entry.label);
  }
});

test("V1 provider-wait summaries allow only known providers and valid retry metadata", () => {
  const waiting = workflowSnapshotFixture("provider-wait", "running");
  const agent = waiting.agents[1]!;
  agent.state = "waiting";
  agent.providerWait = {
    provider: "claude",
    kind: "quota",
    detail: PRIVATE,
    retryAt: 10_000,
    attempt: 2,
    maxAttempts: 4,
  };
  assert.equal(
    project([], [waiting]).workflows[0]!.agents[0]!.waitingSummary,
    "Waiting to retry claude at 10000; attempt 2 of 4.",
  );

  const invalidValues: Array<{ field: string; value: unknown }> = [
    { field: "provider", value: "PrivateTokenABC123" },
    { field: "retryAt", value: Number.NaN },
    { field: "retryAt", value: -1 },
    { field: "retryAt", value: Number.POSITIVE_INFINITY },
    { field: "attempt", value: "2" },
    { field: "attempt", value: -1 },
    { field: "maxAttempts", value: Number.NaN },
    { field: "maxAttempts", value: 1 },
  ];
  for (const { field, value } of invalidValues) {
    const restored = structuredClone(waiting);
    Object.assign(restored.agents[1]!.providerWait!, { [field]: value });
    const state = project([], [restored]);
    const publicAgent = state.workflows[0]!.agents.find((candidate) => candidate.index === 1)!;
    assert.equal(publicAgent.waitingSummary, "Waiting to retry a provider.", field);
    assert.equal(validateNativeSubagentsStateV1(state), true, field);
    assert.equal(JSON.stringify(state).includes("PrivateTokenABC123"), false, field);
  }
});

test("V1 projection has the exact bounded allowlist, relationships, ordering, usage, and private summaries", () => {
  const queued = jobSnapshot({
    id: "job-z",
    name: `queued\u001b[31m${"n".repeat(200)}`,
    status: "queued",
    createdAt: 8_000,
    startedAt: undefined,
    interaction: interactionSnapshot({ question: PRIVATE, context: PRIVATE, answer: PRIVATE }),
    task: PRIVATE,
    cwd: `/private/${PRIVATE}`,
    output: PRIVATE,
    structured: { secret: PRIVATE },
    error: undefined,
    tools: [{ id: PRIVATE, name: PRIVATE, status: "running" }],
    transcript: [{ kind: "assistant", text: PRIVATE }],
    liveThinking: PRIVATE,
    queuedMessages: [{ text: PRIVATE, behavior: "steer" }],
    backendSessionId: PRIVATE,
    sessionFile: `/private/${PRIVATE}`,
  });
  const failed = jobSnapshot({
    id: "job-a",
    name: "failed",
    status: "failed",
    createdAt: 1_000,
    endedAt: 7_000,
    error: UNLABELED_STDERR_OUTPUT,
    workflow: { runId: "run-1", agentIndex: 0, label: PRIVATE, phase: "build" },
    independentOf: "job-z",
    usage: { input: 8, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.2, turns: 1 },
  });
  const completed = jobSnapshot({
    id: "job-result",
    name: "completed",
    status: "completed",
    createdAt: 2_000,
    endedAt: 6_500,
    output: RAW_RESULT_CANARY,
  });
  const hostileResult = jobSnapshot({
    id: "job-hostile-result",
    name: "hostile result",
    status: "completed",
    createdAt: 2_000,
    endedAt: 6_000,
    output: `Result saved at /private/${PRIVATE} with {"toolData":"${PRIVATE}"}`,
  });
  const workflow = workflowSnapshotFixture("run-1", "running");
  workflow.timestamps.updatedAt = 6_000;
  workflow.description = PRIVATE;
  workflow.logs = [{ index: 0, message: PRIVATE, at: 1 }];
  workflow.result = { secret: PRIVATE };
  workflow.artifactDir = `/private/${PRIVATE}`;
  workflow.interactions = [{
    ordinal: 0,
    requestId: "request-1",
    target: "peer",
    sourceAgentIndex: 1,
    sourceName: PRIVATE,
    targetAgentIndex: 0,
    targetName: PRIVATE,
    question: PRIVATE,
    context: PRIVATE,
    answer: PRIVATE,
    error: PRIVATE,
    state: "answered",
    createdAt: 1,
  }];
  workflow.replay = { sourceRunId: "run-source", matchedCalls: 1 };
  workflow.replacementOf = {
    sourceRunId: "run-old",
    sourceAgentIndex: 4,
    sourceState: "failed",
    reason: PRIVATE,
  };
  workflow.phases[0]!.status = "failed";
  workflow.phases[0]!.error = UNLABELED_STDERR_OUTPUT;
  workflow.agents[0]!.preview = "Prepared the bounded release summary.";
  const agent = workflow.agents[0]!;
  agent.logicalJobId = "logical-1";
  agent.independentOf = "job-z";
  agent.replayedFrom = { runId: "run-source", callIndex: 3 };
  agent.replacedBy = { replacementRunId: "run-next", reason: PRIVATE, at: 2 };
  agent.continuation = {
    state: "running",
    fromHarness: "claude",
    toHarness: "codex",
    failedJobId: "job-old",
    replacementJobId: "job-new",
    checkpointAt: 3,
    checkoutDigest: PRIVATE,
    trigger: { source: "continuation", provider: "claude", kind: "quota", detail: PRIVATE },
    warning: PRIVATE,
  };
  agent.objective = PRIVATE;
  agent.prompt = PRIVATE;
  agent.output = PRIVATE;
  agent.structured = { secret: PRIVATE };
  agent.preview = PRIVATE;
  agent.transcript = [{ kind: "assistant", text: PRIVATE }];
  agent.error = UNLABELED_PROVIDER_MESSAGE;
  agent.state = "failed";

  const state = project([hostileResult, failed, queued, completed], [workflow]);
  assert.equal(validateNativeSubagentsStateV1(state), true);
  assert.deepEqual(Object.keys(state), [
    "schemaVersion", "producer", "sequence", "emittedAt", "cause", "session", "truncation", "jobs", "workflows",
  ]);
  assert.deepEqual(state.producer, { name: NATIVE_SUBAGENTS_PRODUCER_NAME, version: "0.1.0", instanceId: "runtime-1" });
  assert.deepEqual(state.jobs.map((job) => job.id), ["job-z", "job-a", "job-result", "job-hostile-result"]);
  assert.equal(state.jobs[0]!.status, "queued", "JobManager status is preserved while waiting");
  assert.equal(state.jobs[0]!.waitingSummary, "Waiting for host input.");
  assert.equal(state.jobs[0]!.name.length, MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS);
  assert.deepEqual(Object.keys(state.jobs[1]!), [
    "id", "name", "kind", "status", "generation", "timestamps", "route", "relationships", "usage", "errorSummary",
  ]);
  assert.deepEqual(state.jobs[1]!.relationships, {
    workflow: { runId: "run-1", agentIndex: 0, phase: "build" },
    independentOfJobId: "job-z",
  });
  assert.equal(state.jobs[1]!.errorSummary, "Job failed.");
  assert.equal(state.jobs[2]!.resultSummary, "Job completed.");
  assert.equal(state.jobs[3]!.resultSummary, "Job completed.");

  const publicWorkflow = state.workflows[0]!;
  assert.deepEqual(publicWorkflow.relationships, {
    replayedFrom: { runId: "run-source" },
    replacementOf: { runId: "run-old", agentIndex: 4 },
  });
  assert.deepEqual(publicWorkflow.usage, { input: 300, output: 60, cacheRead: 10, cacheWrite: 0, cost: 0.03, turns: 3 });
  assert.deepEqual(publicWorkflow.agents[0]!.relationships, {
  });
  assert.equal(publicWorkflow.agents[0]!.phaseIndex, 0);
  assert.equal(publicWorkflow.agents[0]!.jobId, "tests-job-0002");
  assert.deepEqual(publicWorkflow.agents[1]!.relationships, {
    independentOfJobId: "job-z",
    replayedFrom: { runId: "run-source", callIndex: 3 },
    replacedBy: { runId: "run-next" },
    continuation: { fromJobId: "job-old", toJobId: "job-new" },
  });
  assert.equal(publicWorkflow.agents[1]!.phaseIndex, 0);
  assert.equal(publicWorkflow.agents[1]!.jobId, "review-job-0001");
  assert.equal(publicWorkflow.agents[1]!.logicalJobId, "logical-1");
  assert.equal(publicWorkflow.agents[1]!.errorSummary, "Workflow agent failed because provider quota is unavailable.");
  assert.deepEqual(publicWorkflow.phases[0]!.agentIndexes, [0, 1]);
  assert.deepEqual(Object.keys(publicWorkflow.phases[0]!), ["index", "name", "status", "timestamps", "agentIndexes"]);
  assert.equal(state.truncation.summariesTruncated, 0);
  const serializedState = JSON.stringify(state);
  for (const canary of [PRIVATE, UNLABELED_STDERR_OUTPUT, UNLABELED_PROVIDER_MESSAGE, RAW_RESULT_CANARY]) {
    assert.equal(serializedState.includes(canary), false);
  }

  const completedWorkflow = workflowSnapshotFixture("run-result", "completed");
  completedWorkflow.taskOutcome = "successful";
  completedWorkflow.agents[0]!.state = "completed";
  completedWorkflow.agents[0]!.preview = RAW_RESULT_CANARY;
  const completedWorkflowState = project([], [completedWorkflow]).workflows[0]!;
  assert.equal(completedWorkflowState.resultSummary, "Workflow completed successfully.");
  assert.equal(completedWorkflowState.agents[0]!.resultSummary, "Workflow agent completed.");
  assert.equal(JSON.stringify(completedWorkflowState).includes(RAW_RESULT_CANARY), false);

  const invalidVersion = structuredClone(state) as unknown as { schemaVersion: number };
  invalidVersion.schemaVersion = 2;
  assert.equal(validateNativeSubagentsStateV1(invalidVersion), false);
  const unknown = structuredClone(state) as NativeSubagentsStateV1 & { task?: string };
  unknown.task = PRIVATE;
  assert.equal(validateNativeSubagentsStateV1(unknown), false);
  const phaseSummary = structuredClone(state) as NativeSubagentsStateV1;
  Object.assign(phaseSummary.workflows[0]!.phases[0]!, { errorSummary: "not allowed" });
  assert.equal(validateNativeSubagentsStateV1(phaseSummary), false);
  const nonFinite = structuredClone(state);
  nonFinite.jobs[1]!.usage!.cost = Number.POSITIVE_INFINITY;
  assert.equal(validateNativeSubagentsStateV1(nonFinite), false);
  const invalidEnum = structuredClone(state);
  (invalidEnum.jobs[0] as { status: string }).status = "waiting";
  assert.equal(validateNativeSubagentsStateV1(invalidEnum), false);
  const invalidReplayRelationship = structuredClone(state);
  invalidReplayRelationship.workflows[0]!.relationships.replayedFrom!.runId =
    "r".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS + 1);
  assert.equal(validateNativeSubagentsStateV1(invalidReplayRelationship), false);
  const overlong = structuredClone(state);
  overlong.jobs[0]!.id = "i".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS + 1);
  assert.equal(validateNativeSubagentsStateV1(overlong), false);
  overlong.jobs[0]!.id = "job-z";
  overlong.jobs[0]!.name = "n".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS + 1);
  assert.equal(validateNativeSubagentsStateV1(overlong), false);
  overlong.jobs[0]!.name = "queued";
  overlong.jobs[0]!.waitingSummary = "s".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS + 1);
  assert.equal(validateNativeSubagentsStateV1(overlong), false);
  const tooMany = structuredClone(state);
  tooMany.jobs = Array.from({ length: MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS + 1 }, (_, index) => ({
    ...structuredClone(state.jobs[0]!),
    id: `job-${index}`,
  }));
  assert.equal(validateNativeSubagentsStateV1(tooMany), false);
  const tooManyNested = structuredClone(state);
  tooManyNested.workflows[0]!.agents = Array.from(
    { length: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS + 1 },
    (_, index) => ({ ...structuredClone(state.workflows[0]!.agents[0]!), index }),
  );
  assert.equal(validateNativeSubagentsStateV1(tooManyNested), false);
  tooManyNested.workflows[0]!.agents = [];
  tooManyNested.workflows[0]!.phases = Array.from(
    { length: MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES + 1 },
    (_, index) => ({ ...structuredClone(state.workflows[0]!.phases[0]!), index }),
  );
  assert.equal(validateNativeSubagentsStateV1(tooManyNested), false);

  const oversized: NativeSubagentsStateV1 = {
    ...structuredClone(state),
    jobs: [],
    workflows: Array.from({ length: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS }, (_, workflowIndex) => ({
      ...structuredClone(publicWorkflow),
      id: `large-${workflowIndex}`,
      phases: [],
      agents: Array.from({ length: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS }, (_, agentIndex) => ({
        ...structuredClone(publicWorkflow.agents[0]!),
        index: agentIndex,
        jobId: `job-${workflowIndex}-${agentIndex}`,
        errorSummary: "s".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS),
      })),
    })),
  };
  assert.equal(Check(NativeSubagentsStateV1Schema, oversized), true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES);
  assert.equal(validateNativeSubagentsStateV1(oversized), false);
});

test("V1 limits and deterministic truncation remove low-priority summaries and records with accurate counters", () => {
  assert.deepEqual(NATIVE_SUBAGENTS_STATE_V1_LIMITS, {
    jobs: 100,
    workflows: 64,
    workflowAgents: 32,
    phases: 64,
    idChars: 200,
    nameChars: 160,
    summaryChars: 2_000,
    serializedBytes: 512 * 1024,
    maximumNumber: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS, 100);
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS, 64);
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS, 32);
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES, 64);
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS, 200);
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS, 2_000);
  assert.equal(MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES, 512 * 1024);

  const jobs = Array.from({ length: 101 }, (_, index) => jobSnapshot({
    id: `job-${String(index).padStart(3, "0")}`,
    status: index === 100 ? "running" : "completed",
    createdAt: index,
    endedAt: index === 100 ? undefined : index,
  }));
  const workflows = Array.from({ length: 65 }, (_, workflowIndex) => {
    const workflow = workflowSnapshotFixture(`run-${String(workflowIndex).padStart(3, "0")}`, "failed");
    workflow.timestamps = { createdAt: workflowIndex, updatedAt: workflowIndex, endedAt: workflowIndex };
    workflow.error = `failure-${workflowIndex}-${"x".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS)}`;
    const template = workflow.agents[0]!;
    workflow.agents = Array.from({ length: workflowIndex === 64 ? 33 : 32 }, (_, agentIndex) => ({
      ...structuredClone(template),
      index: agentIndex,
      name: `agent-${agentIndex}-${"n".repeat(150)}`,
      state: "failed" as const,
      error: `failure-${workflowIndex}-${agentIndex}-${"e".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS)}`,
      model: "m".repeat(300),
      jobId: `${workflow.runId}-${agentIndex}-${"i".repeat(220)}`,
      logicalJobId: `${workflow.runId}-${agentIndex}-${"l".repeat(220)}`,
      timestamps: { createdAt: workflowIndex, updatedAt: workflowIndex, endedAt: workflowIndex },
    }));
    const phase = workflow.phases[0]!;
    workflow.phases = Array.from({ length: workflowIndex === 64 ? 65 : 1 }, (_, phaseIndex) => ({
      ...structuredClone(phase),
      index: phaseIndex,
      name: `phase-${phaseIndex}`,
      status: "failed" as const,
      error: `phase-failure-${"p".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS)}`,
      agents: workflow.agents.map((agent) => agent.index),
      timestamps: { createdAt: workflowIndex, updatedAt: workflowIndex, endedAt: workflowIndex },
    }));
    return workflow;
  });

  const state = project(jobs, workflows);
  const reversed = project([...jobs].reverse(), [...workflows].reverse());
  assert.deepEqual(reversed, state);
  assert.equal(validateNativeSubagentsStateV1(state), true);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES);
  assert.equal(state.jobs[0]!.id, "job-100", "nonterminal records outrank newer terminal records");
  assert.equal(state.truncation.jobsOmitted, jobs.length - state.jobs.length);
  assert.equal(state.truncation.workflowsOmitted, workflows.length - state.workflows.length);
  assert.equal(
    state.truncation.workflowAgentsOmitted,
    state.workflows.reduce((total, retained) => {
      const source = workflows.find((workflow) => workflow.runId === retained.id)!;
      return total + source.agents.length - retained.agents.length;
    }, 0),
  );
  assert.equal(
    state.truncation.phasesOmitted,
    state.workflows.reduce((total, retained) => {
      const source = workflows.find((workflow) => workflow.runId === retained.id)!;
      return total + source.phases.length - retained.phases.length;
    }, 0),
  );
  assert.equal(
    state.truncation.summariesTruncated,
    state.workflows.reduce((total, workflow) => total + 1 + workflow.agents.length, 0)
      + state.jobs.filter((job) => job.status === "completed" && job.resultSummary === undefined).length,
  );
  assert.ok(state.workflows.length < MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS, "the byte ceiling omits actual records");
  assert.ok(state.workflows.every((workflow) => workflow.agents.length <= MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS));
  assert.ok(state.workflows.every((workflow) => workflow.phases.length <= MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES));
});

test("V1 byte pressure preserves numeric agent priority within a bounded runtime", () => {
  const longId = (prefix: string, fill: string) => `${prefix}-${fill.repeat(220)}`;
  const workflows = Array.from({ length: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS }, (_, workflowIndex) => {
    const workflow = workflowSnapshotFixture(`pressure-${String(workflowIndex).padStart(2, "0")}`, "running");
    workflow.timestamps = { createdAt: 1_000, updatedAt: 2_000, startedAt: 1_000 };
    const template = workflow.agents[0]!;
    workflow.agents = Array.from({ length: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS }, (_, agentIndex) => ({
      ...structuredClone(template),
      index: agentIndex,
      name: "n".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS),
      state: "failed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 2_000, startedAt: 1_000, endedAt: 2_000 },
      jobId: longId(`job-${workflowIndex}-${agentIndex}`, "j"),
      logicalJobId: longId(`logical-${workflowIndex}-${agentIndex}`, "l"),
      model: "m".repeat(MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS),
      independentOf: longId(`independent-${workflowIndex}-${agentIndex}`, "i"),
      replayedFrom: { runId: longId(`replay-${workflowIndex}-${agentIndex}`, "r"), callIndex: agentIndex },
      replacedBy: { replacementRunId: longId(`replacement-${workflowIndex}-${agentIndex}`, "b"), reason: PRIVATE, at: 2_000 },
      continuation: {
        state: "running" as const,
        fromHarness: "claude" as const,
        toHarness: "codex" as const,
        failedJobId: longId(`failed-${workflowIndex}-${agentIndex}`, "f"),
        replacementJobId: longId(`next-${workflowIndex}-${agentIndex}`, "q"),
        checkpointAt: 2_000,
        checkoutDigest: PRIVATE,
        trigger: { source: "continuation" as const, provider: "claude" as const, kind: "quota" as const, detail: PRIVATE },
        warning: PRIVATE,
      },
    }));
    const phase = workflow.phases[0]!;
    workflow.phases = Array.from({ length: MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES }, (_, phaseIndex) => ({
      ...structuredClone(phase),
      index: phaseIndex,
      name: "p",
      status: "running" as const,
      agents: [],
      timestamps: { createdAt: 0, updatedAt: 0 },
    }));
    return workflow;
  });

  const startedAt = performance.now();
  const state = project([], workflows);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(validateNativeSubagentsStateV1(state), true);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES);
  assert.equal(state.workflows.length, MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS);
  assert.ok(state.truncation.workflowAgentsOmitted > 0, "the fixture must exercise record omission");
  assert.equal(
    state.truncation.workflowAgentsOmitted,
    workflows.length * MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS
      - state.workflows.reduce((total, workflow) => total + workflow.agents.length, 0),
  );
  assert.ok(state.workflows.some(
    (workflow) => workflow.agents.length > 0
      && workflow.agents.length < MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS,
  ));
  for (const workflow of state.workflows) {
    assert.deepEqual(
      workflow.agents.map(({ index }) => index),
      Array.from({ length: workflow.agents.length }, (_, index) => index),
      `${workflow.id} retains the lowest numeric indexes`,
    );
  }
  assert.ok(elapsedMs < 10_000, `bounded pressure projection took ${elapsedMs.toFixed(1)}ms`);
});

test("publisher rebuilds authoritative lists, suppresses only true public no-ops, validates, sequences, and isolates failures", async () => {
  let jobs: JobSnapshot[] = [];
  let jobLists = 0;
  let workflowLists = 0;
  let now = 100;
  const states: NativeSubagentsStateV1[] = [];
  const diagnostics: string[] = [];
  const publisher = createNativeSubagentsStatePublisher({
    sessionId: "session",
    instanceId: "instance",
    producerVersion: "test",
    now: () => now++,
    listJobs: () => { jobLists++; return jobs; },
    listWorkflows: () => { workflowLists++; return []; },
    emit: (_event, state) => states.push(state),
    reportError: (message) => diagnostics.push(message),
  });

  publisher.start();
  assert.deepEqual(states.map((state) => [state.sequence, state.cause]), [[1, "startup"]]);
  publisher.changed();
  await tick();
  assert.equal(states.length, 1);
  assert.equal(jobLists, 2);
  assert.equal(workflowLists, 2);

  jobs = [jobSnapshot({ id: "job-1", output: PRIVATE })];
  publisher.changed();
  await tick();
  assert.deepEqual(states.map((state) => state.sequence), [1, 2]);
  jobs = [jobSnapshot({ id: "job-1", output: `${PRIVATE}-changed` })];
  publisher.changed();
  await tick();
  assert.equal(states.length, 2, "excluded raw output does not change public state");
  jobs[0]!.usage.input = 4;
  publisher.changed();
  await tick();
  assert.deepEqual(states.map((state) => state.sequence), [1, 2, 3]);

  jobs[0]!.usage.input = Number.NaN;
  publisher.changed();
  await tick();
  assert.equal(states.length, 3);
  assert.deepEqual(diagnostics, ["Native subagents state projection failed (TypeError)."]);
  jobs[0]!.usage.input = 5;
  publisher.changed();
  await tick();
  publisher.suspend();
  publisher.stop(jobs, []);
  assert.deepEqual(states.map((state) => [state.sequence, state.cause, state.session.lifecycle]), [
    [1, "startup", "active"],
    [2, "update", "active"],
    [3, "update", "active"],
    [4, "update", "active"],
    [5, "shutdown", "closed"],
  ]);

  const metadataOnly = structuredClone(states[4]!);
  metadataOnly.sequence++;
  metadataOnly.emittedAt++;
  metadataOnly.cause = "startup";
  assert.equal(fingerprintNativeSubagentsStateV1(metadataOnly), fingerprintNativeSubagentsStateV1(states[4]!));
  metadataOnly.workflows = [];
  metadataOnly.jobs[0]!.timestamps.startedAt!++;
  assert.notEqual(fingerprintNativeSubagentsStateV1(metadataOnly), fingerprintNativeSubagentsStateV1(states[4]!));

  const hostileError = new Error("provider details");
  hostileError.name = "PrivateTokenABC123";
  const hostileDiagnostics: string[] = [];
  createNativeSubagentsStatePublisher({
    sessionId: "hostile-session",
    listJobs: () => { throw hostileError; },
    listWorkflows: () => [],
    emit: () => assert.fail("invalid projection must not emit"),
    reportError: (message) => hostileDiagnostics.push(message),
  }).start();
  assert.equal(hostileDiagnostics[0], "Native subagents state projection failed (Error).");
  assert.equal(hostileDiagnostics[0]!.includes("PrivateTokenABC123"), false);
  assert.ok(hostileDiagnostics[0]!.length < 100);
});

test("extension lifecycle publishes restored startup, workflow-only terminal updates, and final shutdown across reloads", async (t) => {
  const root = await tempDir("presentation-lifecycle");
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "runs");
  const profileRoot = join(root, "profiles");
  const eventBus = createEventBus();
  const states: NativeSubagentsStateV1[] = [];
  const originalConsoleError = console.error;
  t.after(() => { console.error = originalConsoleError; });
  console.error = () => undefined;
  const removeThrowingListener = eventBus.on(NATIVE_SUBAGENTS_STATE_EVENT_V1, () => {
    throw new Error("consumer failed");
  });
  eventBus.on(NATIVE_SUBAGENTS_STATE_EVENT_V1, (value) => {
    states.push(value as NativeSubagentsStateV1);
  });

  const first = fakePi({ eventBus });
  const backend = new ControlledBackend("pi");
  const registry = {};
  registerNativeSubagents(first.api, {
    registry,
    legacyRoot: false,
    backends: [backend],
    workflowArtifactRoot: artifactRoot,
    globalProfilesDir: profileRoot,
    providerStatus: readyProviderStatusReader(),
  });
  const session = context({ sessionId: "presentation-session", cwd: root });
  first.handlers.get("session_start")?.({}, session.ctx);
  await waitFor(() => states.length === 1, "startup snapshot after workflow initialization");
  assert.equal(states[0]!.cause, "startup");
  assert.deepEqual(states[0]!.jobs, []);

  const spawned = await first.tools.get("subagent_spawn").execute(
    "direct",
    { task: "direct work" },
    undefined,
    undefined,
    session.ctx,
  );
  await backend.waitForStart();
  await waitFor(
    () => states.at(-1)?.jobs.some((job) => job.id === spawned.details.job.id && job.status === "running") === true,
    "running job update",
  );
  const jobsBeforeWorkflow = structuredClone(states.at(-1)!.jobs);
  const beforeWorkflow = states.length;
  const workflowPromise = first.tools.get("workflow").execute(
    "workflow",
    {
      name: "restored workflow",
      script: `export default async () => "persisted result"`,
    },
    undefined,
    undefined,
    session.ctx,
  );
  const completedWorkflow = await workflowPromise;
  await waitFor(
    () => states.slice(beforeWorkflow).some((state) => state.workflows.some(
      (workflow) => workflow.id === completedWorkflow.details.workflow.runId && workflow.status === "completed",
    )),
    "workflow-only terminal update",
  );
  const workflowOnlyUpdate = states.slice(beforeWorkflow).find((state) => state.workflows.some(
    (workflow) => workflow.id === completedWorkflow.details.workflow.runId && workflow.status === "completed",
  ))!;
  assert.equal(workflowOnlyUpdate.cause, "update", "terminal workflow state is published before shutdown");
  assert.deepEqual(workflowOnlyUpdate.jobs, jobsBeforeWorkflow, "workflow onSnapshot publishes without a job update");
  const beforeShutdown = states.length;
  await first.handlers.get("session_shutdown")?.();
  assert.equal(states.length, beforeShutdown + 1);
  assert.equal(states.at(-1)!.cause, "shutdown");
  assert.equal(states.at(-1)!.session.lifecycle, "closed");
  assert.equal(states.at(-1)!.jobs.find((job) => job.id === spawned.details.job.id)?.status, "cancelled");
  assert.equal(
    states.at(-1)!.workflows.some((workflow) => workflow.id === completedWorkflow.details.workflow.runId),
    true,
  );
  const firstInstance = states[0]!.producer.instanceId;
  removeThrowingListener();
  console.error = originalConsoleError;

  const second = fakePi({ eventBus });
  registerNativeSubagents(second.api, {
    registry,
    legacyRoot: false,
    backends: [new ImmediateBackend("pi")],
    workflowArtifactRoot: artifactRoot,
    globalProfilesDir: profileRoot,
    providerStatus: readyProviderStatusReader(),
  });
  const beforeReload = states.length;
  second.handlers.get("session_start")?.({}, context({ sessionId: "presentation-session", cwd: root }).ctx);
  await waitFor(() => states.length > beforeReload, "reload startup snapshot");
  assert.equal(states.at(-1)!.sequence, 1);
  assert.equal(states.at(-1)!.cause, "startup");
  assert.notEqual(states.at(-1)!.producer.instanceId, firstInstance);
  assert.equal(
    states.at(-1)!.workflows.some((workflow) => workflow.id === completedWorkflow.details.workflow.runId),
    true,
  );
  await second.handlers.get("session_shutdown")?.();

  const producerFirstBus = createEventBus();
  const producerFirst = fakePi({ eventBus: producerFirstBus });
  registerNativeSubagents(producerFirst.api, {
    registry: {},
    legacyRoot: false,
    backends: [new ImmediateBackend("pi")],
    workflowArtifactRoot: join(root, "producer-first-runs"),
    globalProfilesDir: profileRoot,
    providerStatus: readyProviderStatusReader(),
  });
  const producerFirstStates: NativeSubagentsStateV1[] = [];
  producerFirstBus.on(NATIVE_SUBAGENTS_STATE_EVENT_V1, (value) => {
    producerFirstStates.push(value as NativeSubagentsStateV1);
  });
  producerFirst.handlers.get("session_start")?.({}, context({ sessionId: "producer-first", cwd: root }).ctx);
  await waitFor(() => producerFirstStates.length === 1, "producer-first startup snapshot");
  assert.equal(producerFirstStates[0]!.cause, "startup");
  assert.equal(producerFirstStates[0]!.sequence, 1);
  await producerFirst.handlers.get("session_shutdown")?.();
  for (const state of [...states, ...producerFirstStates]) {
    assert.equal(validateNativeSubagentsStateV1(state), true);
  }
});

test("shutdown releases every resource when workflow shutdown and final reads fail", async (t) => {
  const root = await tempDir("presentation-shutdown-failure");
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = {};
  const workflows = new FailingWorkflowRegistration();
  const backend = new ControlledBackend("pi");
  const first = fakePi();
  const published: unknown[] = [];
  first.eventBus.on(NATIVE_SUBAGENTS_STATE_EVENT_V1, (value) => { published.push(value); });
  registerNativeSubagents(first.api, {
    registry,
    legacyRoot: false,
    backends: [backend],
    workflowArtifactRoot: join(root, "unused-runs"),
    globalProfilesDir: join(root, "profiles"),
    providerStatus: readyProviderStatusReader(),
    workflowRegistrationFactory: workflows.factory,
  });
  const session = context({ sessionId: "failing-shutdown", cwd: root });
  first.handlers.get("session_start")?.({}, session.ctx);
  const spawned = await first.tools.get("subagent_spawn").execute(
    "shutdown-job",
    { task: "remain active until shutdown" },
    undefined,
    undefined,
    session.ctx,
  );
  await backend.waitForStart();

  await assert.rejects(
    first.handlers.get("session_shutdown")?.(),
    (error) => error === workflows.shutdownError,
  );
  assert.deepEqual(backend.cancels, [{ jobId: spawned.details.job.id, reason: "Session shutdown" }]);
  assert.equal(workflows.sessionShutdowns, 1);
  assert.equal(workflows.sessionCloses, 1, "workflow close is attempted even after final reads fail");
  assert.ok(published.every(validateNativeSubagentsStateV1));
  assert.equal(
    published.some((value) => (value as NativeSubagentsStateV1).cause === "shutdown"),
    false,
    "a failed final read cannot fabricate an authoritative closed snapshot",
  );

  const replacement = fakePi();
  assert.doesNotThrow(() => registerNativeSubagents(replacement.api, {
    registry,
    legacyRoot: false,
    backends: [new ImmediateBackend("pi")],
    workflowArtifactRoot: join(root, "replacement-runs"),
    globalProfilesDir: join(root, "replacement-profiles"),
    providerStatus: readyProviderStatusReader(),
  }), "a throwing workflow close cannot retain the install claim");
  await replacement.handlers.get("session_shutdown")?.();
});
