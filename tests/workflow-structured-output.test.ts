import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityService } from "../src/capability-service.ts";
import { JobManager } from "../src/manager.ts";
import type { StructuredOutputSupport } from "../src/types.ts";
import { ControlledBackend, DiscoverableBackend, tempDir, waitFor } from "./helpers.ts";
import { readWorkflowRunSummary } from "../src/workflows/artifacts.ts";
import { WorkflowManager } from "../src/workflows/manager.ts";

const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

async function fixture(options: { claudeSupport?: StructuredOutputSupport } = {}) {
  const parent = await tempDir("workflow-structured-output");
  const cwd = join(parent, "cwd");
  await mkdir(cwd);
  const artifactRoot = join(parent, "artifacts");
  const codex = new ControlledBackend("codex");
  const claude = new ControlledBackend("claude");
  const jobs = new JobManager({ backends: [codex, claude], concurrency: 4 });
  const claudeProbe = new DiscoverableBackend("claude", [], options.claudeSupport ? { structuredSupport: options.claudeSupport } : {});
  const codexProbe = new DiscoverableBackend("codex", []);
  const router = new CapabilityService({ backends: [claudeProbe, codexProbe], fingerprint: () => "stable" });
  const workflows = new WorkflowManager({ jobs, artifactRoot, sessionId: "session-1", router });
  return {
    parent, cwd, artifactRoot, codex, claude, jobs, workflows, claudeProbe, codexProbe, router,
    request(script: string, overrides: Partial<Parameters<WorkflowManager["start"]>[0]> = {}) {
      return { sessionId: "session-1", name: "structured workflow", script, cwd, trusted: true, defaultHarness: "codex" as const, ...overrides };
    },
    async cleanup() {
      await workflows.shutdown(200).catch(() => undefined);
      await jobs.shutdown(200).catch(() => undefined);
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test("native transport: a supported runtime skips prompt scaffolding, sends the schema as policy, and validates the terminal payload", async () => {
  const f = await fixture({ claudeSupport: { supported: true, mechanism: "fixture:json_schema" } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const writer = await agent("summarize the release", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
        return writer.structured;
      }
    `));
    await waitFor(() => f.claude.requests.length === 1, "claude agent dispatched");
    const request = f.claude.requests[0]!;
    assert.equal(request.task, "summarize the release", "native transport sends the caller prompt with no JSON-schema scaffolding");
    assert.deepEqual(request.policy.structuredOutput, { schema: SCHEMA });
    assert.equal(f.claudeProbe.structuredOutputSupportCalls.length, 1);

    f.claude.complete(request.jobId, "here is the summary", undefined, { ok: true });
    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.deepEqual(final.result, { ok: true });
    assert.deepEqual(final.agents[0]?.structured, { ok: true });
    assert.equal(final.agents[0]?.structuredTransport, "native");
  } finally { await f.cleanup(); }
});

test("native transport: an invalid native payload fails clearly and clears the record's structured field", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => agent("summarize", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
    `));
    await waitFor(() => f.claude.requests.length === 1, "claude agent dispatched");
    const request = f.claude.requests[0]!;
    f.claude.complete(request.jobId, "summary text", undefined, { ok: "not-a-boolean" });
    const final = await started.completion;
    const outcome = final.result as { ok: boolean; error?: string };
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /did not match/);
    assert.equal(final.agents[0]?.state, "failed");
    assert.equal(final.agents[0]?.structured, undefined);
    assert.equal(final.agents[0]?.structuredTransport, "native");
  } finally { await f.cleanup(); }
});

test("native transport: a missing terminal structured result fails clearly instead of silently parsing narrative text", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => agent("summarize", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
    `));
    await waitFor(() => f.claude.requests.length === 1, "claude agent dispatched");
    const request = f.claude.requests[0]!;
    // Output text happens to be schema-valid JSON, but no native `structured` payload was reported.
    f.claude.complete(request.jobId, `{"ok":true}`);
    const final = await started.completion;
    const outcome = final.result as { ok: boolean; error?: string };
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /reported no terminal structured result/);
    assert.equal(final.agents[0]?.structured, undefined, "the schema-shaped narrative text is never accepted as the structured result");
  } finally { await f.cleanup(); }
});

test("portable fallback: an unsupported runtime keeps the prompt/parse/validate path unchanged", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const writer = await agent("summarize", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
        return writer.structured;
      }
    `));
    await waitFor(() => f.claude.requests.length === 1, "claude agent dispatched");
    const request = f.claude.requests[0]!;
    assert.match(request.task, /Return ONLY valid JSON matching this JSON Schema/, "portable transport keeps the scaffolded prompt");
    assert.equal(request.policy.structuredOutput, undefined);

    f.claude.complete(request.jobId, `{"ok":true}`);
    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.deepEqual(final.result, { ok: true });
    assert.equal(final.agents[0]?.structuredTransport, "portable");
  } finally { await f.cleanup(); }
});

test("policy isolation: structured-output selection never changes tool/sandbox/approval policy, and the probe is only consulted when a schema is requested", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const plain = await agent("no schema here", { name: "plain", harness: "claude", access: "readOnly" });
        const structured = await agent("with schema", { name: "structured", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
        return { plain, structured };
      }
    `));
    await waitFor(() => f.claude.requests.length === 1, "schemaless agent dispatched first");
    const plainRequest = f.claude.requests[0]!;
    assert.equal(plainRequest.policy.structuredOutput, undefined);
    f.claude.complete(plainRequest.jobId, "plain text");

    await waitFor(() => f.claude.requests.length === 2, "schema-bearing agent dispatched second");
    const structuredRequest = f.claude.requests[1]!;
    assert.deepEqual(structuredRequest.policy.access, "readOnly");
    assert.deepEqual(structuredRequest.policy.codexSandbox, { type: "readOnly", networkAccess: false });
    assert.deepEqual(structuredRequest.policy.claudeTools, ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    assert.equal(structuredRequest.policy.approvalPolicy, "never");
    f.claude.complete(structuredRequest.jobId, "structured text", undefined, { ok: true });

    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.equal(
      f.claudeProbe.structuredOutputSupportCalls.length,
      1,
      "the probe is never consulted for a call that never requests a schema",
    );
  } finally { await f.cleanup(); }
});

test("policy isolation: one harness reporting native support never enables it for a call that routes to a different harness", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => agent("summarize", { name: "writer", harness: "codex", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
    `));
    await waitFor(() => f.codex.requests.length === 1, "codex agent dispatched");
    const request = f.codex.requests[0]!;
    assert.equal(request.policy.structuredOutput, undefined, "codex never receives a native structured-output policy from claude's support");
    assert.match(request.task, /Return ONLY valid JSON matching this JSON Schema/);
    f.codex.complete(request.jobId, `{"ok":true}`);
    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.equal(f.claude.requests.length, 0);
  } finally { await f.cleanup(); }
});

test("persistence: structured and structuredTransport round-trip through the durable workflow summary", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => agent("summarize", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
    `));
    await waitFor(() => f.claude.requests.length === 1, "claude agent dispatched");
    const request = f.claude.requests[0]!;
    f.claude.complete(request.jobId, "summary", undefined, { ok: true });
    const final = await started.completion;

    const persisted = await readWorkflowRunSummary(f.artifactRoot, final.runId);
    assert.deepEqual(persisted?.agents[0]?.structured, { ok: true });
    assert.equal(persisted?.agents[0]?.structuredTransport, "native");
  } finally { await f.cleanup(); }
});

test("replay: a native run's structured result and transport replay unchanged under a runtime that now reports unsupported", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  let other: WorkflowManager | undefined;
  try {
    const script = `export default async () => agent("summarize", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });`;
    const source = await f.workflows.start(f.request(script));
    await waitFor(() => f.claude.requests.length === 1, "native source agent dispatched");
    const request = f.claude.requests[0]!;
    f.claude.complete(request.jobId, "summary", undefined, { ok: true });
    const sourceFinal = await source.completion;
    assert.equal(sourceFinal.status, "completed");

    // A different manager backed by a router that now reports the runtime as unsupported.
    const downgradedRouter = new CapabilityService({
      backends: [new DiscoverableBackend("claude", []), new DiscoverableBackend("codex", [])],
      fingerprint: () => "stable",
    });
    other = new WorkflowManager({ jobs: f.jobs, artifactRoot: f.artifactRoot, sessionId: "session-2", router: downgradedRouter });
    const resumed = await other.start(f.request(script, { sessionId: "session-2", resumeFromRunId: sourceFinal.runId }));
    const final = await resumed.completion;

    assert.equal(final.status, "completed");
    assert.equal(final.replay?.sourceRunId, sourceFinal.runId);
    assert.deepEqual(final.agents[0]?.structured, { ok: true });
    assert.equal(final.agents[0]?.structuredTransport, "native", "the replayed record still reports the transport its source run actually used");
    assert.equal(f.claude.requests.length, 1, "the matched call replays without dispatch, so the now-unsupported runtime is never probed for it");
  } finally {
    await other?.shutdown(200).catch(() => undefined);
    await f.cleanup();
  }
});

test("followUp provenance: a schemaless original agent() call is not retroactively relabeled by a later schema-bearing portable followUp()", async () => {
  const f = await fixture();
  let other: WorkflowManager | undefined;
  try {
    const script = `
      export default async () => {
        const writer = await agent("draft", { name: "writer", harness: "claude", access: "readOnly" });
        const revised = await followUp(writer.jobId, "revise", { schema: ${JSON.stringify(SCHEMA)} });
        return { writer, revised };
      }
    `;
    const started = await f.workflows.start(f.request(script));
    await waitFor(() => f.claude.requests.length === 1, "schemaless agent dispatched");
    const request = f.claude.requests[0]!;
    assert.equal(request.policy.structuredOutput, undefined);
    f.claude.complete(request.jobId, "draft text");

    await waitFor(() => f.claude.sends.length === 1, "portable follow-up reaches the retained session");
    assert.equal(f.claude.sends[0]?.id, request.jobId);
    assert.equal(f.claude.sends[0]?.behavior, "followUp");
    assert.match(f.claude.sends[0]?.message ?? "", /Return ONLY valid JSON matching this JSON Schema/, "the portable follow-up still scaffolds the prompt with the schema");
    f.claude.complete(request.jobId, JSON.stringify({ ok: true }));

    const final = await started.completion;
    assert.equal(final.status, "completed");
    const generations = final.agents[0]?.generations;
    assert.equal(generations?.length, 2, "the original agent() call and the followUp() call each produce a generation");
    assert.equal(
      generations?.[0]?.structuredTransport,
      undefined,
      "generation 0 (the schemaless agent() call) must stay unlabeled, not inherit the follow-up's portable transport",
    );
    assert.equal(generations?.[1]?.structuredTransport, "portable", "generation 1 (the followUp() call) is the one that actually used the portable transport");
    assert.equal(final.agents[0]?.structuredTransport, "portable", "the record's current transport still reflects the latest call");

    const persisted = await readWorkflowRunSummary(f.artifactRoot, final.runId);
    assert.equal(persisted?.agents[0]?.generations?.[0]?.structuredTransport, undefined, "the persisted run summary preserves the same per-generation provenance");
    assert.equal(persisted?.agents[0]?.generations?.[1]?.structuredTransport, "portable");

    // Replay must reproduce the same per-generation provenance from the durable journal.
    other = new WorkflowManager({ jobs: f.jobs, artifactRoot: f.artifactRoot, sessionId: "session-2", router: f.router });
    const resumed = await other.start(f.request(script, { sessionId: "session-2", resumeFromRunId: final.runId }));
    const replayedFinal = await resumed.completion;
    assert.equal(replayedFinal.status, "completed");
    assert.equal(replayedFinal.replay?.sourceRunId, final.runId);
    const replayedGenerations = replayedFinal.agents[0]?.generations;
    assert.equal(replayedGenerations?.[0]?.structuredTransport, undefined, "replay must not resurrect the mislabeled provenance either");
    assert.equal(replayedGenerations?.[1]?.structuredTransport, "portable");
    assert.equal(f.claude.requests.length, 1, "both calls replay from the journal without re-dispatching");
  } finally {
    await other?.shutdown(200).catch(() => undefined);
    await f.cleanup();
  }
});

test("followUp provenance: a schema-bearing portable agent() call is not retroactively relabeled by a later schemaless followUp()", async () => {
  const f = await fixture();
  let other: WorkflowManager | undefined;
  try {
    const script = `
      export default async () => {
        const writer = await agent("draft", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
        const revised = await followUp(writer.jobId, "revise");
        return { writer, revised };
      }
    `;
    const started = await f.workflows.start(f.request(script));
    await waitFor(() => f.claude.requests.length === 1, "portable schema agent dispatched");
    const request = f.claude.requests[0]!;
    assert.match(request.task, /Return ONLY valid JSON matching this JSON Schema/, "the schema-bearing agent() call scaffolds the prompt");
    f.claude.complete(request.jobId, JSON.stringify({ ok: true }));

    await waitFor(() => f.claude.sends.length === 1, "schemaless follow-up reaches the retained session");
    assert.equal(f.claude.sends[0]?.id, request.jobId);
    assert.equal(f.claude.sends[0]?.behavior, "followUp");
    assert.equal(f.claude.sends[0]?.message, "revise", "a schemaless follow-up sends the caller prompt unscaffolded");
    f.claude.complete(request.jobId, "revised text");

    const final = await started.completion;
    assert.equal(final.status, "completed");
    const generations = final.agents[0]?.generations;
    assert.equal(generations?.length, 2, "the original agent() call and the followUp() call each produce a generation");
    assert.equal(generations?.[0]?.structuredTransport, "portable", "generation 0 (the schema-bearing agent() call) stays portable");
    assert.equal(generations?.[1]?.structuredTransport, undefined, "generation 1 (the schemaless followUp() call) has no transport");
    assert.equal(final.agents[0]?.structuredTransport, undefined, "the record's current transport reflects the latest (schemaless) call, not the original");

    const persisted = await readWorkflowRunSummary(f.artifactRoot, final.runId);
    assert.equal(persisted?.agents[0]?.generations?.[0]?.structuredTransport, "portable");
    assert.equal(persisted?.agents[0]?.generations?.[1]?.structuredTransport, undefined);
    assert.equal(persisted?.agents[0]?.structuredTransport, undefined, "the persisted record mirrors the schemaless latest call, not the original schema-bearing one");

    // Replay must reproduce the same per-generation provenance from the durable journal.
    other = new WorkflowManager({ jobs: f.jobs, artifactRoot: f.artifactRoot, sessionId: "session-2", router: f.router });
    const resumed = await other.start(f.request(script, { sessionId: "session-2", resumeFromRunId: final.runId }));
    const replayedFinal = await resumed.completion;
    assert.equal(replayedFinal.status, "completed");
    assert.equal(replayedFinal.replay?.sourceRunId, final.runId);
    const replayedGenerations = replayedFinal.agents[0]?.generations;
    assert.equal(replayedGenerations?.[0]?.structuredTransport, "portable", "replay preserves the original generation's portable transport");
    assert.equal(replayedGenerations?.[1]?.structuredTransport, undefined, "replay must not resurrect the mislabeled schemaless generation as portable");
    assert.equal(replayedFinal.agents[0]?.structuredTransport, undefined, "the replayed record's current transport also reflects the schemaless latest call");
    assert.equal(f.claude.requests.length, 1, "both calls replay from the journal without re-dispatching");
  } finally {
    await other?.shutdown(200).catch(() => undefined);
    await f.cleanup();
  }
});

test("followUp on a native lineage: the same schema is reused validated, and a different schema fails clearly before dispatch", async () => {
  const f = await fixture({ claudeSupport: { supported: true } });
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const writer = await agent("draft", { name: "writer", harness: "claude", access: "readOnly", schema: ${JSON.stringify(SCHEMA)} });
        const mismatch = await followUp(writer.jobId, "revise", { schema: { type: "object", required: ["different"], properties: { different: { type: "string" } } } });
        if (!mismatch.ok) {
          const reused = await followUp(writer.jobId, "revise again", { schema: ${JSON.stringify(SCHEMA)} });
          return { mismatch, reused };
        }
        return { mismatch };
      }
    `));
    await waitFor(() => f.claude.requests.length === 1, "claude agent dispatched");
    const request = f.claude.requests[0]!;
    f.claude.complete(request.jobId, "draft text", undefined, { ok: true });

    await waitFor(() => f.claude.sends.length === 1, "the reused-schema follow-up reaches the retained session");
    assert.deepEqual(f.claude.sends[0], { id: request.jobId, message: "revise again", behavior: "followUp" });
    f.claude.complete(request.jobId, "revised text", undefined, { ok: false });

    const final = await started.completion;
    assert.equal(final.status, "completed");
    const result = final.result as { mismatch: { ok: boolean; error?: string }; reused: { ok: boolean; structured?: unknown } };
    assert.equal(result.mismatch.ok, false);
    assert.match(result.mismatch.error ?? "", /cannot change the schema of a native structured lineage/);
    assert.equal(result.reused.ok, true);
    assert.deepEqual(result.reused.structured, { ok: false });
    assert.equal(f.claude.sends.length, 1, "the mismatched schema follow-up never dispatches a turn to the retained session");
  } finally { await f.cleanup(); }
});

const CONVERGE_NATIVE_SCRIPT = `
  export default async () => converge({
    maxRounds: 2,
    implement: { prompt: "implement", options: { name: "implementer" } },
    review: { prompt: "review", options: { name: "reviewer", harness: "claude" } },
  });
`;

test("converge keeps a native review lineage schema-bound across rounds and never approves on an invalid payload", async () => {
  const f = await fixture({ claudeSupport: { supported: true, mechanism: "fixture:json_schema" } });
  try {
    const started = await f.workflows.start(f.request(CONVERGE_NATIVE_SCRIPT));
    await waitFor(() => f.codex.requests.length === 1, "implementer dispatched");
    f.codex.complete(f.codex.starts[0]!, "implementation v1");

    await waitFor(() => f.claude.requests.length === 1, "reviewer dispatched");
    const reviewRequest = f.claude.requests[0]!;
    assert.equal(reviewRequest.task, "review", "the native transport sends no JSON scaffolding");
    const schema = (reviewRequest.policy.structuredOutput as { schema: Record<string, unknown> }).schema;
    assert.deepEqual(schema.required, ["verdict", "summary", "findings"], "converge always binds the review schema");
    f.claude.complete(reviewRequest.jobId, "reviewed", undefined, {
      verdict: "request_changes",
      summary: "one blocker remains",
      findings: [{ id: "F1", severity: "blocker", body: "guard the null case" }],
    });

    await waitFor(() => f.codex.sends.length === 1, "fix follow-up dispatched");
    f.codex.complete(f.codex.starts[0]!, "implementation v2");

    // The retained native session stays bound to its agent() schema: converge
    // repeats the identical schema on every re-review rather than replacing it.
    await waitFor(() => f.claude.sends.length === 1, "re-review follow-up reuses the retained native session");
    f.claude.complete(reviewRequest.jobId, "reviewed", undefined, { verdict: "approve", summary: 42, findings: [] });

    const final = await started.completion;
    assert.equal(final.status, "completed");
    const result = final.result as { ok: boolean; outcome: string; stoppingReason: string };
    assert.equal(result.ok, false, "an invalid structured payload is never an implicit approval");
    assert.equal(result.outcome, "failed");
    assert.match(result.stoppingReason, /review call failed: .*did not match/);
    assert.equal(final.convergence?.state, "failed");
    assert.deepEqual(final.convergence?.rounds.map((round) => round.verdict), ["request_changes"]);
  } finally { await f.cleanup(); }
});
