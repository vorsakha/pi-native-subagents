import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/manager.ts";
import type {
  Backend,
  BackendEvent,
  BackendRequest,
  BackendRun,
  ProfileDefinition,
  Usage,
} from "../src/types.ts";
import { createWorkflowArtifacts } from "../src/workflows/artifacts.ts";
import {
  aggregateWorkflowUsage,
  WorkflowManager,
} from "../src/workflows/manager.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

interface FakeRun {
  request: BackendRequest;
  emit: (event: BackendEvent) => void;
  settle: () => void;
  settled: boolean;
}

class ControlledBackend implements Backend {
  readonly name = "codex" as const;
  readonly requests: BackendRequest[] = [];
  readonly cancels: Array<{ jobId: string; reason?: string }> = [];
  readonly runs = new Map<string, FakeRun>();
  active = 0;
  maxActive = 0;

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.requests.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    let finish!: () => void;
    const run: FakeRun = {
      request,
      emit,
      settled: false,
      settle: () => {
        if (run.settled) return;
        run.settled = true;
        this.active--;
        finish();
      },
    };
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    this.runs.set(request.jobId, run);
    return {
      completed,
      async send() {},
      cancel: async (reason) => {
        this.cancels.push({ jobId: request.jobId, reason });
        emit({ type: "cancelled", reason });
        run.settle();
      },
      async close() {},
    };
  }

  requestForTask(task: string): BackendRequest | undefined {
    return this.requests.find((request) => request.task === task);
  }

  activeRuns(): FakeRun[] {
    return [...this.runs.values()].filter((run) => !run.settled);
  }

  completeTask(task: string, output = `${task} output`, usage?: Partial<Usage>): void {
    const request = this.requestForTask(task);
    assert.ok(request, `backend did not start task ${task}`);
    const run = this.runs.get(request.jobId);
    assert.ok(run && !run.settled, `task ${task} is not active`);
    if (usage) run.emit({ type: "usage", usage });
    run.emit({ type: "completed", output });
    run.settle();
  }

  failTask(task: string, error: string): void {
    const request = this.requestForTask(task);
    assert.ok(request, `backend did not start task ${task}`);
    const run = this.runs.get(request.jobId);
    assert.ok(run && !run.settled, `task ${task} is not active`);
    run.emit({ type: "failed", error });
    run.settle();
  }
}

const reviewer: ProfileDefinition = {
  name: "reviewer",
  description: "human-authored audit profile",
  access: "readOnly",
  backend: "codex",
  systemPrompt: "reviewer system prompt",
  filePath: "reviewer.md",
  origin: "global",
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(concurrency = 4) {
  const parent = await mkdtemp(join(tmpdir(), "workflow-manager-"));
  const cwd = join(parent, "cwd");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  const artifactRoot = join(parent, "artifacts");
  const backend = new ControlledBackend();
  const jobs = new JobManager({
    backends: [backend],
    profiles: new Map([[reviewer.name, reviewer]]),
    concurrency,
  });
  const workflows = new WorkflowManager({ jobs, artifactRoot, sessionId: "session-1" });
  return {
    parent,
    cwd,
    artifactRoot,
    backend,
    jobs,
    workflows,
    request(script: string, overrides: Partial<Parameters<WorkflowManager["start"]>[0]> = {}) {
      return {
        sessionId: "session-1",
        name: "test workflow",
        script,
        cwd,
        trusted: true,
        ...overrides,
      };
    },
    async cleanup() {
      await workflows.shutdown(200).catch(() => undefined);
      await jobs.shutdown(200).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test("rejects untrusted workflows before creating artifact storage", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.workflows.start(f.request("export default async () => 'no';", { trusted: false })),
      /untrusted/i,
    );
    await assert.rejects(stat(f.artifactRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.deepEqual(f.workflows.list(), []);
  } finally {
    await f.cleanup();
  }
});

test("rejects every legacy workflow agent option without spawning jobs", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const results = [];
        for (const options of [
          { role: "worker" },
          { agent: "reviewer" },
          { tier: "quality" },
          { modelProfile: "codex" },
        ]) results.push(await agent("legacy call", options));
        return results;
      }
    `));
    const final = await started.completion;
    const results = final.result as Array<{ ok: boolean; error?: string }>;
    assert.equal(final.status, "completed");
    assert.equal(results.length, 4);
    assert.ok(results.every((result) => !result.ok && /Legacy workflow/.test(result.error ?? "")));
    assert.equal(f.backend.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("runs sequential and parallel agents through one JobManager and its global cap", async () => {
  const f = await fixture(2);
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const first = await agent("seq-1");
        const second = await agent("seq-2:" + first.output, { name: "worker" });
        const batch = await parallel(["par-1", "par-2", "par-3", "par-4"].map(
          (prompt) => () => agent(prompt, { name: "worker" })
        ), 4);
        return { first: first.output, second: second.output, batch: batch.map((item) => item.output) };
      }
    `));

    await waitFor(() => f.backend.requests.length === 1, "first sequential agent");
    assert.equal(f.backend.requests[0]?.task, "seq-1");
    assert.equal(f.backend.requests[0]?.policy.effort, undefined, "workflow agents default to provider-adaptive effort");
    f.backend.completeTask("seq-1", "one");
    await waitFor(() => f.backend.requests.length === 2, "second sequential agent");
    assert.equal(f.backend.requests[1]?.task, "seq-2:one");
    f.backend.completeTask("seq-2:one", "two");

    await waitFor(() => f.jobs.list().length === 6, "all parallel jobs to be enqueued");
    await waitFor(() => f.backend.requests.length === 4, "parallel work up to the global cap");
    assert.equal(f.backend.active, 2);
    assert.equal(f.backend.maxActive, 2);
    for (const run of f.backend.activeRuns()) {
      f.backend.completeTask(run.request.task, run.request.task.toUpperCase());
    }
    await waitFor(() => f.backend.requests.length === 6, "queued parallel work to start");
    for (const run of f.backend.activeRuns()) {
      f.backend.completeTask(run.request.task, run.request.task.toUpperCase());
    }

    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.equal(f.backend.maxActive, 2);
    assert.equal(f.jobs.list().length, 6);
    assert.deepEqual(final.result, {
      first: "one",
      second: "two",
      batch: ["PAR-1", "PAR-2", "PAR-3", "PAR-4"],
    });
  } finally {
    await f.cleanup();
  }
});

test("workflow agent options preserve generic read-only/profile policy in the backend request", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const reviewed = await agent("audit", {
          name: "reviewer", access: "readOnly", profile: "reviewer",
          effort: "high",
          schema: { type: "object", required: ["clean"], properties: { clean: { type: "boolean" } } }
        });
        return reviewed.structured;
      }
    `));
    await waitFor(() => f.backend.requests.length === 1, "reviewer backend request");
    const request = f.backend.requests[0]!;
    assert.equal(request.name, "reviewer");
    assert.match(request.systemPrompt, /isolated, task-driven subagent[\s\S]*reviewer system prompt/);
    assert.equal(request.policy.access, "readOnly");
    assert.deepEqual(request.policy.codexSandbox, { type: "readOnly", networkAccess: false });
    assert.deepEqual(request.policy.piTools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(request.policy.claudeTools, ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    assert.equal(request.policy.approvalPolicy, "never");
    assert.equal(request.policy.effort, "high");
    const run = f.backend.runs.get(request.jobId)!;
    run.emit({ type: "tool_start", id: "read-1", name: "read", summary: "src/policy.ts" });
    const projected = f.workflows.check(started.snapshot.runId).agents[0]!;
    assert.equal(projected.prompt, "audit", "workflow receipts preserve the caller prompt without schema scaffolding");
    assert.equal(projected.effort, "high");
    assert.deepEqual(projected.tools, [{ id: "read-1", name: "read", summary: "src/policy.ts", status: "running" }]);
    run.emit({ type: "tool_end", id: "read-1", name: "read", output: "ok" });
    f.backend.completeTask(request.task, `{"clean":true}`);
    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.deepEqual(final.result, { clean: true });
    assert.deepEqual(final.agents[0]?.structured, { clean: true });
    assert.equal(final.agents[0]?.prompt, "audit");
    assert.equal(final.agents[0]?.effort, "high");
    assert.equal(final.agents[0]?.tools?.at(-1)?.status, "completed");

    const malformed = await f.workflows.start(f.request(`
      export default async () => agent("invalid schema", { name: "reviewer", access: "readOnly", profile: "reviewer", schema: { type: "nonsense" } });
    `));
    const malformedFinal = await malformed.completion;
    assert.equal((malformedFinal.result as { ok: boolean }).ok, false);
    assert.match((malformedFinal.result as { error: string }).error, /bounded JSON Schema/);
    assert.equal(f.backend.requests.length, 1, "invalid schemas fail before dispatch");

    const mismatch = await f.workflows.start(f.request(`
      export default async () => agent("schema mismatch", {
        name: "reviewer", access: "readOnly", profile: "reviewer",
        schema: { type: "object", required: ["clean"], properties: { clean: { type: "boolean" } } }
      });
    `));
    await waitFor(() => f.backend.requests.length === 2, "schema mismatch agent");
    const mismatchRequest = f.backend.requests[1]!;
    f.backend.completeTask(mismatchRequest.task, `{"clean":"no"}`);
    await mismatch.completion;
    const mismatchAgent = f.workflows.check(mismatch.snapshot.runId).agents[0]!;
    assert.equal(mismatchAgent.state, "failed", "workflow validation failure outranks the backend's completed state");
    assert.match(mismatchAgent.error ?? "", /did not match/);

    const crossProvider = await f.workflows.start(f.request(`
      export default async () => agent("challenge parent", { name: "adversary", access: "readOnly", independent: true });
    `, { parentProvider: "claude" }));
    await waitFor(() => f.backend.requests.length === 3, "cross-provider workflow adversary");
    const adversaryRequest = f.backend.requests[2]!;
    assert.equal(adversaryRequest.name, "adversary");
    assert.equal(adversaryRequest.policy.backend, "codex", "independent Claude-parent workflow agent routes to Codex");
    f.backend.completeTask(adversaryRequest.task, "independent review");
    assert.equal((await crossProvider.completion).status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("records phases, results, and final workflow artifacts", async () => {
  const f = await fixture();
  const script = `
    export const meta = { name: "release review", description: "two-phase review" };
    export default async (input) => {
      phase("Inspect");
      const reviewed = await agent("inspect " + input.subject, { label: "security", access: "readOnly", independent: true, profile: "reviewer" });
      phase("Summarize");
      return { accepted: reviewed.ok, report: reviewed.output, subject: input.subject };
    }
  `;
  try {
    const started = await f.workflows.start(f.request(script, { args: { subject: "change" }, parentProvider: "claude" }));
    await waitFor(() => f.backend.requests.length === 1, "phase agent");
    f.backend.completeTask("inspect change", "looks good");
    const final = await started.completion;

    assert.equal(final.status, "completed");
    assert.equal(final.name, "release review");
    assert.equal(final.description, "two-phase review");
    assert.deepEqual(final.phases.map((phase) => ({
      name: phase.name,
      status: phase.status,
      agents: phase.agents,
    })), [
      { name: "Inspect", status: "completed", agents: [0] },
      { name: "Summarize", status: "completed", agents: [] },
    ]);
    assert.deepEqual(final.result, { accepted: true, report: "looks good", subject: "change" });
    assert.deepEqual((await readdir(final.artifactDir)).sort(), [
      "args.json", "report.md", "result.json", "script.js", "transcripts.json", "workflow.json",
    ]);
    assert.equal(await readFile(join(final.artifactDir, "script.js"), "utf8"), script);
    assert.deepEqual(JSON.parse(await readFile(join(final.artifactDir, "args.json"), "utf8")), { subject: "change" });
    assert.deepEqual(JSON.parse(await readFile(join(final.artifactDir, "result.json"), "utf8")), final.result);
    const persisted = JSON.parse(await readFile(join(final.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
    assert.equal(persisted.status, "completed");
    assert.deepEqual(persisted.result, final.result);
    assert.equal(persisted.agents[0]?.output, "looks good");
    assert.equal(persisted.agents[0]?.prompt, "inspect change");
    assert.equal(persisted.agents[0]?.liveThinking, undefined, "live-only supervision state is not persisted");
    const transcripts = JSON.parse(await readFile(join(final.artifactDir, "transcripts.json"), "utf8"));
    assert.equal(transcripts["0"].at(-1).kind, "assistant");
    const report = await readFile(join(final.artifactDir, "report.md"), "utf8");
    assert.match(report, /# release review[\s\S]*looks good/);
    assert.match(report, /- Independent: yes/);
  } finally {
    await f.cleanup();
  }
});

test("returns an immediate background-style start snapshot and a separate completion handle", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => agent("background work", { name: "worker" });`,
      { background: true },
    ));
    assert.equal(started.snapshot.background, true);
    assert.equal(started.snapshot.status, "running");
    let settled = false;
    void started.completion.then(() => { settled = true; });
    await waitFor(() => f.backend.requests.length === 1, "background agent to start");
    await tick();
    assert.equal(settled, false);
    assert.equal(f.workflows.check(started.snapshot.runId).status, "running");
    assert.equal(f.workflows.check(started.snapshot.runId).agents[0]?.state, "running");

    f.backend.completeTask("background work", "done");
    assert.equal((await started.completion).status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("cancels both running and queued workflow jobs", async () => {
  const f = await fixture(1);
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => parallel([
        () => agent("running member", { name: "worker" }),
        () => agent("queued member", { name: "worker" })
      ], 2)
    `));
    await waitFor(() => f.jobs.list().length === 2, "running and queued workflow jobs");
    await waitFor(() => f.backend.requests.length === 1, "running workflow job");
    const before = f.jobs.list();
    assert.deepEqual(before.map((job) => job.status).sort(), ["queued", "running"]);

    const queuedAgent = f.workflows.check(started.snapshot.runId).agents.find((agent) => agent.state === "queued")!;
    const afterAgentCancel = await f.workflows.cancelAgent(started.snapshot.runId, queuedAgent.index, "stop queued member");
    assert.equal(afterAgentCancel.agents[queuedAgent.index]?.state, "cancelled");

    const final = await f.workflows.cancel(started.snapshot.runId, "stop workflow");
    assert.equal(final.status, "aborted");
    assert.equal(final.error, "stop workflow");
    assert.deepEqual(final.agents.map((agent) => agent.state), ["cancelled", "cancelled"]);
    assert.deepEqual(f.jobs.list().map((job) => job.status), ["cancelled", "cancelled"]);
    assert.equal(f.backend.cancels.length, 1);
    assert.equal(f.backend.cancels[0]?.jobId, before.find((job) => job.status === "running")?.id);
  } finally {
    await f.cleanup();
  }
});

test("shutdown aborts active workflows, cancels their jobs, and closes new starts", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => agent("shutdown member", { name: "worker" });`,
      { background: true },
    ));
    await waitFor(() => f.backend.requests.length === 1, "active workflow member");
    await f.workflows.shutdown(500);

    const final = await started.completion;
    assert.equal(final.status, "aborted");
    assert.equal(final.error, "Session shutdown");
    assert.equal(final.agents[0]?.state, "cancelled");
    assert.equal(f.jobs.list()[0]?.status, "cancelled");
    assert.equal(f.backend.cancels.length, 1);
    await assert.rejects(
      f.workflows.start(f.request(`export default async () => "late";`)),
      /closed/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("restores persisted running summaries as durably aborted stale workflows", async () => {
  const f = await fixture();
  const old = Date.now() - 60_000;
  try {
    const created = await createWorkflowArtifacts(f.artifactRoot, {
      script: `export default async () => "never resumed";`,
      args: null,
      snapshot: {
        sessionId: "session-1",
        name: "stale workflow",
        description: "",
        background: true,
        status: "running",
        timestamps: { createdAt: old, updatedAt: old, startedAt: old },
        currentPhase: 0,
        phases: [{
          index: 0,
          name: "Work",
          status: "running",
          timestamps: { createdAt: old, updatedAt: old, startedAt: old },
          agents: [0],
        }],
        agents: [{
          index: 0,
          name: "stale member",
          access: "full",
          independent: false,
          phase: 0,
          state: "running",
          timestamps: { createdAt: old, updatedAt: old, startedAt: old },
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, turns: 6 },
        }],
      },
    });

    const foreign = await createWorkflowArtifacts(f.artifactRoot, {
      script: `export default async () => "private to another session";`,
      args: null,
      snapshot: {
        sessionId: "another-session",
        name: "foreign workflow",
        description: "must not be listed",
        background: true,
        status: "running",
        timestamps: { createdAt: old, updatedAt: old, startedAt: old },
        currentPhase: null,
        phases: [],
        agents: [],
      },
    });

    await f.workflows.initialize();
    const restored = f.workflows.check(created.runId);
    assert.equal(restored.status, "aborted");
    assert.equal(restored.phases[0]?.status, "aborted");
    assert.equal(restored.agents[0]?.state, "aborted");
    assert.match(restored.error ?? "", /stale/i);
    assert.equal(f.workflows.list().length, 1);
    assert.throws(() => f.workflows.check(foreign.runId), /Unknown workflow/, "workflow history is scoped to the active Pi session");
    const foreignPersisted = JSON.parse(await readFile(join(foreign.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
    assert.equal(foreignPersisted.status, "running", "initializing this session does not abort another session's active workflow");
    const persisted = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
    assert.equal(persisted.status, "aborted");
    assert.equal(persisted.agents[0]?.state, "aborted");
  } finally {
    await f.cleanup();
  }
});

test("aggregates usage across all workflow agents", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const one = await agent("usage one", { name: "worker" });
        const two = await agent("usage two", { name: "worker" });
        return [one.ok, two.ok];
      }
    `));
    await waitFor(() => f.backend.requests.length === 1, "first usage agent");
    f.backend.completeTask("usage one", "one", {
      input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: 1.25, turns: 1,
    });
    await waitFor(() => f.backend.requests.length === 2, "second usage agent");
    f.backend.completeTask("usage two", "two", {
      input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: 2.5, turns: 2,
    });

    const final = await started.completion;
    assert.deepEqual(final.agents.map((agent) => agent.usage), [
      { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: 1.25, turns: 1 },
      { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: 2.5, turns: 2 },
    ]);
    assert.deepEqual(aggregateWorkflowUsage(final), {
      input: 13,
      output: 16,
      cacheRead: 22,
      cacheWrite: 26,
      cost: 3.75,
      turns: 3,
    });
    assert.equal(final.status, "completed");
    assert.equal(final.error, undefined);
  } finally {
    await f.cleanup();
  }
});
