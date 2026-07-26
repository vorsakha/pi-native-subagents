import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendWorkflowJournal,
  createWorkflowArtifacts,
  loadWorkflowJournal,
} from "../src/workflows/artifacts.ts";
import {
  replayableJournalPrefix,
  workflowCallFingerprint,
  workflowDefinitionFingerprint,
} from "../src/workflows/journal.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 };

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workflow-journal-"));
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

test("journal loading keeps a durable valid prefix and replay stops at the first failed call", async () => {
  const f = await fixture();
  const first = workflowCallFingerprint("first", { access: "readOnly" });
  const second = workflowCallFingerprint("second", {});
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
    await appendFile(join(f.created.artifactDir, "journal.jsonl"), "{partial crash tail", "utf8");

    const records = await loadWorkflowJournal(f.root, f.created.runId);
    assert.equal(records.length, 4, "an unterminated crash tail is ignored");
    assert.deepEqual(replayableJournalPrefix(records), [{
      callIndex: 0,
      fingerprint: first,
      result: { ok: true, output: "done", jobId: "job-old", usage },
      route: { jobId: "job-old", harness: "codex", model: "review-model" },
    }]);
  } finally {
    await f.cleanup();
  }
});
