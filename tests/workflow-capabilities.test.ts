import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityService } from "../src/capability-service.ts";
import { JobManager } from "../src/manager.ts";
import { availabilityFixture, ControlledBackend, DiscoverableBackend, ImmediateBackend, ScriptedHarnessAvailability, StaticWorkflowCheckout, tempDir, waitFor } from "./helpers.ts";
import { WorkflowManager } from "../src/workflows/manager.ts";
import { loadWorkflowJournal } from "../src/workflows/artifacts.ts";

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

test("replayed follow-up continuation retains and revalidates the original capability requirements", async () => {
  const parent = await tempDir("workflow-capability-continuation");
  const cwd = join(parent, "cwd");
  await mkdir(cwd);
  const artifactRoot = join(parent, "artifacts");
  const codex = new ImmediateBackend("codex");
  const claude = new ControlledBackend("claude");
  const jobs = new JobManager({ backends: [codex, claude] });
  const codexProbe = new DiscoverableBackend("codex", []);
  const claudeProbe = new DiscoverableBackend("claude", [{ kind: "tool", name: "lint", effect: "inspect" }]);
  const router = new CapabilityService({ backends: [codexProbe, claudeProbe], fingerprint: () => "stable" });
  const availability = new ScriptedHarnessAvailability({
    codex: availabilityFixture("codex"),
    claude: availabilityFixture("claude"),
  });
  const workflows = new WorkflowManager({
    jobs,
    artifactRoot,
    sessionId: "session-1",
    router,
    availability,
    checkout: new StaticWorkflowCheckout(),
  });
  const script = `export default async () => {
    const first = await agent("lint first", {
      harness: "claude",
      access: "readOnly",
      requires: ["tool:lint"],
      continuationFallback: { harness: "codex" }
    });
    return followUp(first.jobId, "lint follow-up");
  };`;
  try {
    const sourceRun = await workflows.start({
      sessionId: "session-1", name: "capability continuation", script, cwd, trusted: true, defaultHarness: "codex",
    });
    await claude.waitForStart();
    const lineage = claude.starts[0]!;
    claude.complete(lineage, "initial lint");
    await claude.waitForSend();
    claude.emit(lineage, { type: "message", text: "follow-up progress" });
    claude.fail(lineage, "quota", { provider: "claude", kind: "quota", authoritative: true, detail: "quota after progress" });
    const source = await sourceRun.completion;
    assert.equal(codex.requests.length, 0, "the live continuation keeps the capability requirement");

    const journalPath = join(source.artifactDir, "journal.jsonl");
    const records = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { callIndex: number; state: string });
    const handoffIndex = records.findIndex((record) => record.callIndex === 1 && record.state === "handoff");
    assert.ok(handoffIndex >= 0);
    await writeFile(journalPath, `${records.slice(0, handoffIndex + 1).map((record) => JSON.stringify(record)).join("\n")}\n`);

    const replayed = await workflows.start({
      sessionId: "session-1", name: "capability continuation", script, cwd, trusted: true, defaultHarness: "codex", resumeFromRunId: source.runId,
    });
    const final = await replayed.completion;
    assert.equal((final.result as { ok: boolean }).ok, false);
    assert.match((final.result as { error?: string }).error ?? "", /required capabilities: tool:lint/);
    assert.deepEqual(final.agents[0]?.requires, ["tool:lint"]);
    assert.equal(codex.requests.length, 0, "replay never dispatches a replacement without the original capability ceiling");
  } finally {
    await workflows.shutdown(200).catch(() => undefined);
    await jobs.shutdown(200).catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("queued continuation revalidates readiness and capabilities at scheduler admission", async () => {
  for (const stale of ["readiness", "capability"] as const) {
    const parent = await tempDir(`workflow-continuation-admission-${stale}`);
    const cwd = join(parent, "cwd");
    await mkdir(cwd);
    const artifactRoot = join(parent, "artifacts");
    const codex = new ControlledBackend("codex");
    const claude = new ControlledBackend("claude");
    const jobs = new JobManager({ backends: [codex, claude], concurrency: 1 });
    const lint = [{ kind: "tool" as const, name: "lint", effect: "inspect" as const }];
    const codexProbe = new DiscoverableBackend("codex", lint);
    const claudeProbe = new DiscoverableBackend("claude", lint);
    const router = new CapabilityService({ backends: [codexProbe, claudeProbe], fingerprint: () => "stable" });
    const availability = new ScriptedHarnessAvailability({
      codex: availabilityFixture("codex"),
      claude: availabilityFixture("claude"),
    });
    const workflows = new WorkflowManager({
      jobs,
      artifactRoot,
      sessionId: "session-1",
      router,
      availability,
      checkout: new StaticWorkflowCheckout(),
    });
    try {
      const started = await workflows.start({
        sessionId: "session-1",
        name: `${stale} admission`,
        cwd,
        trusted: true,
        defaultHarness: "codex",
        script: `export default async () => agent("queued policy proof", {
          harness: "claude", access: "readOnly", requires: ["tool:lint"],
          continuationFallback: { harness: "codex" }
        });`,
      });
      await claude.waitForStart();
      const primary = claude.starts[0]!;
      const blocker = jobs.spawn({ name: "direct blocker", task: "hold slot", cwd, trusted: true, harness: "codex" });
      claude.emit(primary, { type: "message", text: "progress" });
      claude.fail(primary, "quota", { provider: "claude", kind: "quota", authoritative: true, detail: "quota after progress" });
      await codex.waitForStart();
      assert.equal(codex.starts[0], blocker.id);
      await waitFor(() => jobs.list().some((job) => job.workflow?.runId === started.snapshot.runId && job.status === "queued"), "queued replacement");

      if (stale === "readiness") {
        availability.states.set("codex", availabilityFixture("codex", { ready: false, authenticated: false }));
      } else {
        codexProbe.setCapabilities([]);
      }
      codex.complete(blocker.id, "release");

      const final = await started.completion;
      const outcome = final.result as { ok: boolean; error?: string };
      assert.equal(outcome.ok, false);
      assert.match(outcome.error ?? "", stale === "readiness" ? /codex.*unauthenticated|not ready|login/i : /required capabilities: tool:lint/i);
      assert.equal(codex.requests.length, 1, `${stale} proof fails before replacement backend startup`);
      assert.equal(final.agents[0]?.continuation?.state, "failed");
    } finally {
      await workflows.shutdown(200).catch(() => undefined);
      await jobs.shutdown(200).catch(() => undefined);
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

test("a workflow agent revalidates the resolved harness at dispatch and records its availability as journal evidence", async () => {
  const parent = await tempDir("workflow-availability");
  const cwd = join(parent, "cwd");
  await mkdir(cwd);
  const artifactRoot = join(parent, "artifacts");
  const codex = new DiscoverableBackend("codex", []);
  const claude = new DiscoverableBackend("claude", [{ kind: "tool", name: "lint", effect: "inspect" }]);
  const jobs = new JobManager({ backends: [codex, claude] });
  const router = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
  // Claude is installed but not logged in; codex is ready; pi is absent here.
  const availability = new ScriptedHarnessAvailability({
    claude: { authenticated: false, ready: false, detail: "Claude Code is not logged in" },
    codex: { version: "1.2.3" },
  });
  const workflows = new WorkflowManager({ jobs, artifactRoot, sessionId: "session-1", router, availability });
  try {
    // Explicit unauthenticated harness fails closed without dispatch and never reroutes.
    const explicit = await workflows.start({
      sessionId: "session-1", name: "explicit", cwd, trusted: true, defaultHarness: "codex",
      script: `export default async () => agent("do the thing", { name: "worker", harness: "claude" });`,
    });
    const explicitFinal = await explicit.completion;
    assert.equal((explicitFinal.result as { ok: boolean }).ok, false);
    const explicitAgent = explicitFinal.agents[0]!;
    assert.equal(explicitAgent.state, "failed");
    assert.equal(explicitAgent.requestedHarness, "claude");
    assert.equal(explicitAgent.availability, "unauthenticated");
    assert.equal(claude.requests.length, 0, "a fail-closed explicit route never reaches the backend");
    const explicitJournal = await loadWorkflowJournal(artifactRoot, explicitFinal.runId);
    const failedRoute = explicitJournal.map((record) => record.route).find((route) => route?.availability);
    assert.equal(failedRoute?.requestedHarness, "claude");
    assert.equal(failedRoute?.availability, "unauthenticated");

    // harness:auto excludes the unauthenticated claude and dispatches to ready codex.
    const auto = await workflows.start({
      sessionId: "session-1", name: "auto", cwd, trusted: true, defaultHarness: "codex",
      script: `export default async () => agent("do the thing", { name: "worker", harness: "auto" });`,
    });
    const autoFinal = await auto.completion;
    assert.equal(autoFinal.status, "completed");
    const autoAgent = autoFinal.agents[0]!;
    assert.equal(autoAgent.harness, "codex", "auto routes to the one ready harness");
    assert.equal(autoAgent.requestedHarness, "auto");
    assert.equal(autoAgent.availability, "ready", "the resolved auto route records its observed availability");
    assert.equal(autoAgent.executableVersion, "1.2.3");
    assert.match(autoAgent.capabilityRevision ?? "", /^sha256:/, "the selected live capability catalog is fingerprinted");
    assert.deepEqual(autoAgent.availabilityChecks?.map((check) => [check.harness, check.status]), [
      ["claude", "unauthenticated"],
      ["codex", "ready"],
    ]);
    assert.equal(claude.requests.length, 0);
    assert.equal(codex.requests.length, 1);
    const autoJournal = await loadWorkflowJournal(artifactRoot, autoFinal.runId);
    const resolvedRoute = autoJournal.map((record) => record.route).find((route) => route?.availability === "ready");
    assert.equal(resolvedRoute?.requestedHarness, "auto");
    assert.equal(resolvedRoute?.harness, "codex");
    assert.equal(resolvedRoute?.executableVersion, "1.2.3");
    assert.match(resolvedRoute?.capabilityRevision ?? "", /^sha256:/);
    assert.deepEqual(resolvedRoute?.availabilityChecks?.map((check) => [check.harness, check.status]), [
      ["claude", "unauthenticated"],
      ["codex", "ready"],
    ]);

    // When every auto candidate becomes unavailable, the failed journal route
    // still carries normalized evidence for each exclusion.
    availability.states.set("codex", availabilityFixture("codex", {
      authenticated: false,
      ready: false,
      detail: "Codex is not logged in",
    }));
    const failedAuto = await workflows.start({
      sessionId: "session-1", name: "auto failure", cwd, trusted: true, defaultHarness: "codex",
      script: `export default async () => agent("do the thing", { name: "worker", harness: "auto" });`,
    });
    const failedAutoFinal = await failedAuto.completion;
    assert.equal((failedAutoFinal.result as { ok: boolean }).ok, false);
    const failedAutoJournal = await loadWorkflowJournal(artifactRoot, failedAutoFinal.runId);
    const failedAutoRoute = failedAutoJournal.map((record) => record.route).find((route) => route?.availabilityChecks?.length);
    assert.deepEqual(failedAutoRoute?.availabilityChecks?.map((check) => [check.harness, check.status]), [
      ["claude", "unauthenticated"],
      ["codex", "unauthenticated"],
    ]);
  } finally {
    await workflows.shutdown(200).catch(() => undefined);
    await jobs.shutdown(200).catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("providerFallback uses only authoritative explicit-route readiness states and revalidates the target", async () => {
  for (const [status, eligible] of [
    ["missing", true],
    ["unauthenticated", true],
    ["incompatible", true],
    ["unknown", false],
    ["unhealthy", false],
  ] as const) {
    const parent = await tempDir(`workflow-fallback-${status}`);
    const cwd = join(parent, "cwd");
    await mkdir(cwd);
    const artifactRoot = join(parent, "artifacts");
    const codex = new DiscoverableBackend("codex", []);
    const claude = new DiscoverableBackend("claude", []);
    const jobs = new JobManager({ backends: [codex, claude] });
    const router = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
    const availability = new ScriptedHarnessAvailability({
      claude: { harness: "claude", status, detected: status !== "missing", ready: false, reason: status, checkedAt: 1_000 },
      codex: availabilityFixture("codex", { version: "2.0.0" }),
    });
    const workflows = new WorkflowManager({ jobs, artifactRoot, sessionId: "session-1", router, availability });
    try {
      const started = await workflows.start({
        sessionId: "session-1",
        name: `fallback ${status}`,
        cwd,
        trusted: true,
        defaultHarness: "codex",
        script: `export default async () => agent("do the thing", { harness: "claude", providerFallback: { harness: "codex" } });`,
      });
      const final = await started.completion;
      assert.equal(codex.requests.length, eligible ? 1 : 0, status);
      assert.equal(claude.requests.length, 0, status);
      assert.equal(final.agents[0]?.attempts?.[0]?.trigger?.status, eligible ? status : undefined, status);
      if (eligible) {
        assert.equal(final.agents[0]?.harness, "codex");
        assert.equal(final.agents[0]?.availability, "ready");
        assert.deepEqual(availability.asked.map((entry) => entry.harness), ["claude", "codex"]);
      }
    } finally {
      await workflows.shutdown(200).catch(() => undefined);
      await jobs.shutdown(200).catch(() => undefined);
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
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
