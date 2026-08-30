import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers.ts";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appendWorkflowJournal,
  createWorkflowArtifacts,
  loadWorkflowJournal,
} from "../src/workflows/artifacts.ts";
import {
  replayableJournalCalls,
  replayableJournalHandoffs,
  replayableJournalInteractions,
  workflowCallFingerprint,
  workflowDefinitionFingerprint,
  workflowInteractionFingerprint,
  workflowReplayReferenceKey,
} from "../src/workflows/journal.ts";
import type { WorkflowJournalRecord } from "../src/workflows/types.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 };

async function fixture() {
  const parent = await tempDir("workflow-journal");
  const root = join(parent, "artifacts");
  const now = Date.now();
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => null;",
    args: null,
    snapshot: {
      sessionId: "journal-session",
      name: "journal",
      description: "",
      background: false,
      status: "aborted",
      timestamps: { createdAt: now, updatedAt: now, startedAt: now, endedAt: now },
      currentPhase: null,
      phases: [],
      agents: [],
      definitionFingerprint: "sha256:" + "a".repeat(64),
      journalArtifact: "journal.jsonl",
    },
  });
  return { parent, root, created, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

test("workflow fingerprints are canonical and bind definitions to execution context", () => {
  assert.equal(
    workflowCallFingerprint("inspect", { schema: { required: ["ok"], type: "object" }, access: "readOnly" }),
    workflowCallFingerprint("inspect", { access: "readOnly", schema: { type: "object", required: ["ok"] } }),
  );
  assert.notEqual(workflowCallFingerprint("inspect", {}), workflowCallFingerprint("review", {}));
  const first = workflowDefinitionFingerprint({ script: "export default 1", argsJson: "null", cwd: "/one", defaultHarness: "codex" });
  const second = workflowDefinitionFingerprint({ script: "export default 1", argsJson: "null", cwd: "/two", defaultHarness: "codex" });
  assert.notEqual(first, second);
});

test("journal loading replays valid completed calls independently across a failed parallel lane", async () => {
  const f = await fixture();
  const first = workflowCallFingerprint("first", { access: "readOnly" });
  const second = workflowCallFingerprint("second", {});
  const third = workflowCallFingerprint("third", { access: "readOnly" });
  try {
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 0, callIndex: 0, fingerprint: first, state: "started", at: 1,
    });
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 1, callIndex: 0, fingerprint: first, state: "completed", at: 2,
      agentIndex: 0,
      result: { ok: true, output: "done", jobId: "job-old", usage },
      route: { jobId: "job-old", harness: "codex", model: "review-model" },
    });
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 2, callIndex: 1, fingerprint: second, state: "started", at: 3,
    });
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 3, callIndex: 1, fingerprint: second, state: "failed", at: 4,
      result: { ok: false, output: "", error: "interrupted" },
    });
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 4, callIndex: 2, fingerprint: third, state: "started", at: 5,
    });
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 5, callIndex: 2, fingerprint: third, state: "completed", at: 6,
      agentIndex: 2,
      result: { ok: true, output: "later", jobId: "job-later", usage },
      route: { jobId: "job-later", harness: "claude", model: "review-model" },
    });
    await appendFile(join(f.created.artifactDir, "journal.jsonl"), "{partial crash tail", "utf8");

    const records = await loadWorkflowJournal(f.root, f.created.runId);
    assert.equal(records.length, 6, "an unterminated crash tail is ignored");
    assert.deepEqual(replayableJournalCalls(records), [{
      callIndex: 0,
      fingerprint: first,
      kind: "agent",
      agentIndex: 0,
      result: { ok: true, output: "done", jobId: "job-old", usage },
      route: { jobId: "job-old", harness: "codex", model: "review-model" },
    }, {
      callIndex: 2,
      fingerprint: third,
      kind: "agent",
      agentIndex: 2,
      result: { ok: true, output: "later", jobId: "job-later", usage },
      route: { jobId: "job-later", harness: "claude", model: "review-model" },
    }]);
  } finally {
    await f.cleanup();
  }
});

test("continuation handoff replay requires a matching progressed-primary checkpoint", () => {
  const fingerprint = workflowCallFingerprint("continue safely", {
    harness: "claude",
    continuationFallback: { harness: "codex" },
  });
  const trigger = {
    source: "continuation" as const,
    provider: "claude" as const,
    kind: "quota" as const,
    retryAt: 10_000,
    detail: "authoritative quota",
  };
  const target = { harness: "codex" as const, model: "replacement-model" };
  const attemptUsage = { ...usage };
  const cumulativeUsage = { ...usage, input: 6, output: 8, turns: 3 };
  const route = {
    jobId: "failed-job",
    logicalJobId: "logical-job",
    harness: "claude" as const,
    requestedHarness: "claude" as const,
    model: "primary-model",
    status: "failed" as const,
    error: "quota",
    continuationFallback: target,
  };
  const started: WorkflowJournalRecord = {
    version: 1, sequence: 0, callIndex: 0, fingerprint, kind: "agent", state: "started", at: 1,
  };
  const progressed: WorkflowJournalRecord = {
    version: 1, sequence: 1, callIndex: 0, fingerprint, kind: "agent", state: "progressed", at: 2,
    agentIndex: 0,
    route,
    continuationProgress: {
      agentIndex: 0,
      logicalJobId: "logical-job",
      failedJobId: "failed-job",
      target,
      trigger,
      attemptUsage,
      usage: cumulativeUsage,
    },
  };
  const handoff: WorkflowJournalRecord = {
    version: 1, sequence: 2, callIndex: 0, fingerprint, kind: "agent", state: "handoff", at: 3,
    agentIndex: 0,
    route: {
      ...route,
      continuation: {
        state: "handoff",
        fromHarness: "claude",
        toHarness: "codex",
        failedJobId: "failed-job",
        checkpointAt: 3,
        checkoutDigest: `sha256:${"b".repeat(64)}`,
        trigger,
        warning: "continuation warning",
      },
    },
    continuation: {
      agentIndex: 0,
      logicalJobId: "logical-job",
      failedJobId: "failed-job",
      phase: "build",
      objective: "finish the change",
      handoffPrompt: "inspect existing state and continue",
      checkout: {
        cwd: "/repo",
        root: "/repo",
        gitDir: "/repo/.git",
        head: "a".repeat(40),
        headRef: "refs/heads/main",
        changedPaths: 1,
        digest: `sha256:${"b".repeat(64)}`,
      },
      target,
      trigger,
      attemptUsage,
      usage: cumulativeUsage,
    },
  };

  assert.equal(replayableJournalHandoffs([started, progressed, handoff]).length, 1);
  assert.deepEqual(replayableJournalHandoffs([started, handoff]), [], "a handoff cannot replace its missing progress proof");
  assert.match(
    replayableJournalCalls([started, handoff])[0]?.result.error ?? "",
    /lacks a matching progressed-primary checkpoint/,
    "missing proof becomes a terminal replay refusal instead of a fresh primary dispatch",
  );

  const inconsistent = [
    (record: WorkflowJournalRecord) => {
      record.continuation!.failedJobId = "different-failed-job";
      record.route!.jobId = "different-failed-job";
      record.route!.continuation!.failedJobId = "different-failed-job";
    },
    (record: WorkflowJournalRecord) => { record.route!.model = "different-primary-route"; },
    (record: WorkflowJournalRecord) => {
      record.continuation!.trigger.detail = "different trigger";
      record.route!.continuation!.trigger.detail = "different trigger";
    },
    (record: WorkflowJournalRecord) => { record.continuation!.usage.input += 1; },
  ];
  for (const mutate of inconsistent) {
    const changed = structuredClone(handoff);
    mutate(changed);
    assert.deepEqual(replayableJournalHandoffs([started, progressed, changed]), []);
    const refused = replayableJournalCalls([started, progressed, changed]);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.result.progressed, true);
    assert.match(refused[0]?.result.error ?? "", /stopped before a safe continuation handoff/);
  }

  const completed: WorkflowJournalRecord = {
    version: 1, sequence: 3, callIndex: 0, fingerprint, kind: "agent", state: "completed", at: 4,
    agentIndex: 0,
    result: { ok: true, output: "replacement complete", jobId: "logical-job", usage: cumulativeUsage },
    route: {
      ...route,
      jobId: "replacement-job",
      logicalJobId: "logical-job",
      harness: "codex",
      model: "replacement-model",
      status: "completed",
      error: undefined,
      continuation: {
        ...handoff.route!.continuation!,
        state: "completed",
        replacementJobId: "replacement-job",
      },
    },
  };
  const accepted = replayableJournalCalls([started, progressed, handoff, completed])[0]!;
  assert.equal(accepted.result.ok, true);
  assert.deepEqual(accepted.continuationProof?.handoff, handoff.continuation);

  const copiedProgress = { ...structuredClone(progressed), replayProof: true as const };
  const copiedHandoff = { ...structuredClone(handoff), replayProof: true as const };
  assert.deepEqual(
    replayableJournalHandoffs([started, copiedProgress, copiedHandoff]),
    [],
    "copied replay provenance never grants live replacement authority",
  );
  const interruptedProofReplay = replayableJournalCalls([started, copiedProgress, copiedHandoff])[0]!;
  assert.equal(interruptedProofReplay.result.ok, false);
  assert.equal(interruptedProofReplay.result.progressed, true);
  assert.match(interruptedProofReplay.result.error ?? "", /copied proof cannot authorize another replacement/);
  assert.equal(
    replayableJournalCalls([started, copiedProgress, copiedHandoff, completed])[0]?.result.ok,
    true,
    "the copied chain remains valid evidence when its terminal record is durable",
  );

  const duplicateProgress = { ...structuredClone(progressed), sequence: 2 };
  const inconsistentAfterProgress = replayableJournalCalls([started, progressed, duplicateProgress]);
  assert.equal(inconsistentAfterProgress.length, 1);
  assert.equal(inconsistentAfterProgress[0]?.result.ok, false);
  assert.equal(inconsistentAfterProgress[0]?.result.progressed, true);
  assert.deepEqual(replayableJournalHandoffs([started, progressed, duplicateProgress]), []);

  const duplicateTerminal = { ...structuredClone(completed), sequence: 4 };
  const inconsistentAfterCompletion = replayableJournalCalls([started, progressed, handoff, completed, duplicateTerminal]);
  assert.equal(inconsistentAfterCompletion.length, 1);
  assert.equal(inconsistentAfterCompletion[0]?.result.ok, false);
  assert.equal(inconsistentAfterCompletion[0]?.result.progressed, true);
  assert.deepEqual(replayableJournalHandoffs([started, progressed, handoff, completed, duplicateTerminal]), []);

  const replayedTerminal = structuredClone(completed);
  replayedTerminal.replayedFrom = { runId: "source-run", callIndex: 0 };
  const terminalOnly = [started, replayedTerminal];
  const unprovedReplay = replayableJournalCalls(terminalOnly)[0]!;
  assert.equal(unprovedReplay.result.ok, false);
  assert.equal(unprovedReplay.result.progressed, true);
  assert.match(unprovedReplay.result.error ?? "", /validated replay provenance/);

  const validated = new Map([[workflowReplayReferenceKey(replayedTerminal.replayedFrom), accepted]]);
  assert.equal(replayableJournalCalls(terminalOnly, validated)[0]?.result.ok, true);

  const mismatchedReplay = structuredClone(replayedTerminal);
  mismatchedReplay.result!.output = "different replay output";
  const refusedMismatch = replayableJournalCalls([started, mismatchedReplay], validated)[0]!;
  assert.equal(refusedMismatch.result.ok, false);
  assert.equal(refusedMismatch.result.progressed, true);

  const missingHandoff = replayableJournalCalls([started, progressed, completed]);
  assert.equal(missingHandoff[0]?.result.ok, false);
  assert.equal(missingHandoff[0]?.result.progressed, true);

  for (const mutate of [
    (record: WorkflowJournalRecord) => { record.route!.continuation!.checkpointAt += 1; },
    (record: WorkflowJournalRecord) => { record.route!.continuation!.replacementJobId = "other-replacement"; },
    (record: WorkflowJournalRecord) => { record.route!.jobId = "other-replacement"; },
    (record: WorkflowJournalRecord) => { record.route!.harness = "claude"; },
  ]) {
    const changed = structuredClone(completed);
    mutate(changed);
    const refused = replayableJournalCalls([started, progressed, handoff, changed]);
    assert.equal(refused[0]?.result.ok, false);
    assert.equal(refused[0]?.result.progressed, true);
    assert.deepEqual(replayableJournalHandoffs([started, progressed, handoff, changed]), []);
  }
});

test("peer-question journals require lineage provenance from started through settlement", async () => {
  const f = await fixture();
  const question = workflowInteractionFingerprint({ question: "Which flag stays?", context: "fixtures disagree" });
  const target = workflowCallFingerprint("plan", { name: "planner" });
  const detail = {
    sourceAgentIndex: 1,
    sourceGeneration: 0,
    targetAgentIndex: 0,
    targetJobId: "planner-job",
    targetCallFingerprint: target,
  };
  try {
    await assert.rejects(
      appendWorkflowJournal(f.root, f.created.runId, {
        version: 1, sequence: 0, callIndex: 0, fingerprint: question, kind: "peerQuestion", state: "started", at: 1,
      }),
      /Invalid workflow journal record/,
      "a crash record without source and target identity is not durable replay evidence",
    );
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 0, callIndex: 0, fingerprint: question, kind: "peerQuestion", state: "started", at: 1,
      agentIndex: 1,
      interaction: detail,
    });
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 1, callIndex: 0, fingerprint: question, kind: "peerQuestion", state: "completed", at: 2,
      agentIndex: 1,
      result: { ok: true, output: "keep the legacy flag", usage },
      interaction: { ...detail, targetGeneration: 1, route: "peer" },
    });
    // A second interaction has only a started record and must never replay.
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 2, callIndex: 1, fingerprint: workflowInteractionFingerprint({ question: "unfinished" }), kind: "peerQuestion", state: "started", at: 3,
      agentIndex: 1,
      interaction: detail,
    });

    const records = await loadWorkflowJournal(f.root, f.created.runId);
    assert.deepEqual(replayableJournalInteractions(records), [{
      ordinal: 0,
      questionFingerprint: question,
      detail: { ...detail, targetGeneration: 1, route: "peer" },
      answer: "keep the legacy flag",
      usage,
    }]);
    assert.deepEqual(replayableJournalCalls(records), [], "interaction ordinals never enter the sandbox call replay stream");
  } finally {
    await f.cleanup();
  }
});

test("route evidence additively records requested harness and normalized availability, and rejects an invalid state", async () => {
  const f = await fixture();
  const fingerprint = workflowCallFingerprint("resolve", { access: "readOnly" });
  try {
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 0, callIndex: 0, fingerprint, state: "started", at: 1,
    });
    // A resolved route carries the requested harness and observed availability
    // alongside the resolved harness, so replay can explain the decision.
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 1, callIndex: 0, fingerprint, state: "completed", at: 2, agentIndex: 0,
      result: { ok: true, output: "done", jobId: "job-1", usage },
      route: {
        jobId: "job-1",
        requestedHarness: "auto",
        harness: "claude",
        availability: "ready",
        executableVersion: "1.2.3",
        capabilityRevision: "sha256:fixture",
        availabilityChecks: [
          { harness: "claude", status: "ready", executableVersion: "1.2.3" },
          { harness: "codex", status: "unauthenticated" },
        ],
        model: "review-model",
      },
    });

    const records = await loadWorkflowJournal(f.root, f.created.runId);
    assert.equal(records.length, 2);
    assert.deepEqual(replayableJournalCalls(records)[0]!.route, {
      jobId: "job-1",
      requestedHarness: "auto",
      harness: "claude",
      availability: "ready",
      executableVersion: "1.2.3",
      capabilityRevision: "sha256:fixture",
      availabilityChecks: [
        { harness: "claude", status: "ready", executableVersion: "1.2.3" },
        { harness: "codex", status: "unauthenticated" },
      ],
      model: "review-model",
    });

    // A legacy route without the additive fields is still accepted unchanged.
    await appendWorkflowJournal(f.root, f.created.runId, {
      version: 1, sequence: 2, callIndex: 1, fingerprint: workflowCallFingerprint("legacy", {}), state: "completed", at: 3, agentIndex: 1,
      result: { ok: true, output: "legacy", jobId: "job-2", usage },
      route: { jobId: "job-2", harness: "codex" },
    });

    // An out-of-range availability value is rejected before it can corrupt the journal.
    await assert.rejects(
      appendWorkflowJournal(f.root, f.created.runId, {
        version: 1, sequence: 3, callIndex: 2, fingerprint: workflowCallFingerprint("bad", {}), state: "completed", at: 4, agentIndex: 2,
        result: { ok: true, output: "bad", jobId: "job-3", usage },
        route: { jobId: "job-3", harness: "claude", availability: "definitely-not-a-state" as never },
      }),
      /Invalid workflow journal record/,
    );
  } finally {
    await f.cleanup();
  }
});
