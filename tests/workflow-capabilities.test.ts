import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityService } from "../src/capability-service.ts";
import { JobManager } from "../src/manager.ts";
import { DiscoverableBackend, tempDir } from "./helpers.ts";
import { WorkflowManager } from "../src/workflows/manager.ts";

async function fixture() {
  const parent = await tempDir("workflow-capabilities");
  const cwd = join(parent, "cwd");
  await mkdir(cwd);
  const artifactRoot = join(parent, "artifacts");
  const codex = new DiscoverableBackend("codex", []);
  const claude = new DiscoverableBackend("claude", [{ kind: "tool", name: "lint", effect: "inspect" }]);
  const pi = new DiscoverableBackend("pi", []);
  const jobs = new JobManager({ backends: [codex, claude, pi] });
  const router = new CapabilityService({ backends: [codex, claude, pi], fingerprint: () => "stable" });
  const workflows = new WorkflowManager({ jobs, artifactRoot, sessionId: "session-1", router });
  return {
    parent, cwd, codex, claude, pi, jobs, workflows,
    request(script: string, overrides: Partial<Parameters<WorkflowManager["start"]>[0]> = {}) {
      return { sessionId: "session-1", name: "capability workflow", script, cwd, trusted: true, defaultHarness: "codex" as const, ...overrides };
    },
    async cleanup() {
      await workflows.shutdown(200).catch(() => undefined);
      await jobs.shutdown(200).catch(() => undefined);
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test("workflow agent() with harness auto and requires routes to the harness that provides the capability", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => agent("lint the workspace", { name: "linter", harness: "auto", requires: ["tool:lint"] });
    `));
    const final = await started.completion;
    assert.equal(final.status, "completed");
    const agentRecord = final.agents[0]!;
    assert.equal(agentRecord.state, "completed");
    assert.equal(f.claude.requests.length, 1, "the capable harness receives the dispatched job");
    assert.equal(f.codex.requests.length, 0);
    const job = f.jobs.check(agentRecord.jobId!);
    assert.deepEqual(job.requires, ["claude:tool:lint"], "the workflow job records the live-normalized capability ID");
    assert.deepEqual(job.capabilities?.matched, ["claude:tool:lint"]);
    assert.equal(job.capabilities?.auto, true);
  } finally {
    await f.cleanup();
  }
});

test("workflow agent() with an explicit harness that cannot satisfy requires fails that call without dispatching", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => agent("lint the workspace", { name: "linter", harness: "codex", requires: ["tool:lint"] });
    `));
    const final = await started.completion;
    const outcome = final.result as { ok: boolean; error?: string };
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /Selected harness cannot satisfy the required capabilities: tool:lint/);
    assert.equal(f.codex.requests.length, 0, "an unsatisfied capability route never reaches the backend");
  } finally {
    await f.cleanup();
  }
});

test("workflow agent() with requires but no router configured fails that call instead of silently ignoring requires", async () => {
  const parent = await tempDir("workflow-capabilities-norouter");
  const cwd = join(parent, "cwd");
  await mkdir(cwd);
  const codex = new DiscoverableBackend("codex", []);
  const jobs = new JobManager({ backends: [codex] });
  const workflows = new WorkflowManager({ jobs, artifactRoot: join(parent, "artifacts"), sessionId: "session-1" });
  try {
    const started = await workflows.start({
      sessionId: "session-1", name: "no router", cwd, trusted: true, defaultHarness: "codex",
      script: `export default async () => agent("needs a capability", { harness: "codex", requires: ["tool:lint"] });`,
    });
    const final = await started.completion;
    const outcome = final.result as { ok: boolean; error?: string };
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /Capability requirements are unavailable in this session/);
  } finally {
    await workflows.shutdown(200).catch(() => undefined);
    await jobs.shutdown(200).catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
