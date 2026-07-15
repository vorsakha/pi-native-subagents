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
  RoleDefinition,
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

const routes: RoleDefinition["routes"] = {
  pi: { model: "pi-model", thinking: "medium", effort: "medium" },
  claude: { model: "claude-model", thinking: "medium", effort: "medium" },
  codex: { model: "codex-model", thinking: "medium", effort: "medium" },
};

const worker: RoleDefinition = {
  name: "worker",
  description: "write-capable worker",
  access: "full",
  defaultBackend: "codex",
  nestedAgents: ["reviewer"],
  piTools: ["read", "write", "bash"],
  claudeTools: ["Read", "Write", "Bash"],
  routes,
  systemPrompt: "worker system prompt",
  filePath: "worker.md",
};

const reviewer: RoleDefinition = {
  name: "reviewer",
  description: "read-only reviewer",
  access: "readOnly",
  defaultBackend: "codex",
  nestedAgents: [],
  piTools: ["read", "grep", "write", "bash"],
  claudeTools: ["Read", "Glob", "Write", "Bash"],
  routes,
  systemPrompt: "reviewer system prompt",
  filePath: "reviewer.md",
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
    roles: new Map([[worker.name, worker], [reviewer.name, reviewer]]),
    concurrency,
  });
  const workflows = new WorkflowManager({ jobs, artifactRoot });
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

test("runs sequential and parallel agents through one JobManager and its global cap", async () => {
  const f = await fixture(2);
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const first = await agent("seq-1", { role: "worker" });
        const second = await agent("seq-2:" + first.output, { role: "worker" });
        const batch = await parallel(["par-1", "par-2", "par-3", "par-4"].map(
          (prompt) => () => agent(prompt, { role: "worker" })
        ), 4);
        return { first: first.output, second: second.output, batch: batch.map((item) => item.output) };
      }
    `));

    await waitFor(() => f.backend.requests.length === 1, "first sequential agent");
    assert.equal(f.backend.requests[0]?.task, "seq-1");
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

test("preserves reviewer read-only role policy in the backend request", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => agent("audit", { role: "reviewer" });`,
    ));
    await waitFor(() => f.backend.requests.length === 1, "reviewer backend request");
    const request = f.backend.requests[0]!;
    assert.equal(request.role, "reviewer");
    assert.equal(request.systemPrompt, "reviewer system prompt");
    assert.equal(request.policy.access, "readOnly");
    assert.deepEqual(request.policy.codexSandbox, { type: "readOnly", networkAccess: false });
    assert.deepEqual(request.policy.piTools, ["read", "grep"]);
    assert.deepEqual(request.policy.claudeTools, ["Read", "Glob"]);
    assert.equal(request.policy.approvalPolicy, "never");
    f.backend.completeTask("audit", "clean");
    assert.equal((await started.completion).status, "completed");
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
      const reviewed = await agent("inspect " + input.subject, { role: "reviewer", label: "security" });
      phase("Summarize");
      return { accepted: reviewed.ok, report: reviewed.output, subject: input.subject };
    }
  `;
  try {
    const started = await f.workflows.start(f.request(script, { args: { subject: "change" } }));
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
      "args.json", "result.json", "script.js", "workflow.json",
    ]);
    assert.equal(await readFile(join(final.artifactDir, "script.js"), "utf8"), script);
    assert.deepEqual(JSON.parse(await readFile(join(final.artifactDir, "args.json"), "utf8")), { subject: "change" });
    assert.deepEqual(JSON.parse(await readFile(join(final.artifactDir, "result.json"), "utf8")), final.result);
    const persisted = JSON.parse(await readFile(join(final.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
    assert.equal(persisted.status, "completed");
    assert.deepEqual(persisted.result, final.result);
    assert.equal(persisted.agents[0]?.output, "looks good");
  } finally {
    await f.cleanup();
  }
});

test("returns agent failure as workflow data so scripts can branch and recover", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const primary = await agent("primary", { role: "worker" });
        if (!primary.ok) {
          const recovery = await agent("recover:" + primary.error, { role: "worker" });
          return { recovered: recovery.ok, output: recovery.output, primaryError: primary.error };
        }
        return { recovered: false, output: primary.output };
      }
    `));
    await waitFor(() => f.backend.requests.length === 1, "primary agent");
    f.backend.failTask("primary", "provider unavailable");
    await waitFor(() => f.backend.requests.length === 2, "recovery agent");
    f.backend.completeTask("recover:provider unavailable", "fallback result");

    const final = await started.completion;
    assert.equal(final.status, "completed");
    assert.deepEqual(final.agents.map((agent) => agent.state), ["failed", "completed"]);
    assert.equal(final.agents[0]?.error, "provider unavailable");
    assert.deepEqual(final.result, {
      recovered: true,
      output: "fallback result",
      primaryError: "provider unavailable",
    });
  } finally {
    await f.cleanup();
  }
});

test("returns an immediate background-style start snapshot and a separate completion handle", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => agent("background work", { role: "worker" });`,
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
        () => agent("running member", { role: "worker" }),
        () => agent("queued member", { role: "worker" })
      ], 2)
    `));
    await waitFor(() => f.jobs.list().length === 2, "running and queued workflow jobs");
    await waitFor(() => f.backend.requests.length === 1, "running workflow job");
    const before = f.jobs.list();
    assert.deepEqual(before.map((job) => job.status).sort(), ["queued", "running"]);

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

test("fails a workflow when its sandbox timeout expires", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => new Promise(() => {});`,
      { timeoutMs: 1 },
    ));
    const final = await started.completion;
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /timed out after 1000 ms/i);
    const persisted = JSON.parse(await readFile(join(final.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
    assert.equal(persisted.status, "failed");
    assert.match(persisted.error ?? "", /timed out/i);
  } finally {
    await f.cleanup();
  }
});

test("shutdown aborts active workflows, cancels their jobs, and closes new starts", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => agent("shutdown member", { role: "worker" });`,
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
        sessionId: "restored-session",
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
          label: "stale member",
          role: "worker",
          phase: 0,
          state: "running",
          timestamps: { createdAt: old, updatedAt: old, startedAt: old },
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, turns: 6 },
        }],
      },
    });

    await f.workflows.initialize();
    const restored = f.workflows.check(created.runId);
    assert.equal(restored.status, "aborted");
    assert.equal(restored.phases[0]?.status, "aborted");
    assert.equal(restored.agents[0]?.state, "aborted");
    assert.match(restored.error ?? "", /stale/i);
    assert.equal(f.workflows.list().length, 1);
    const persisted = JSON.parse(await readFile(join(created.artifactDir, "workflow.json"), "utf8")) as WorkflowSnapshot;
    assert.equal(persisted.status, "aborted");
    assert.equal(persisted.agents[0]?.state, "aborted");
  } finally {
    await f.cleanup();
  }
});

test("attaches workflow ownership metadata to every JobManager job", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        phase("Review");
        return agent("owned job", { role: "reviewer", label: "security review" });
      }
    `));
    await waitFor(() => f.jobs.list().length === 1, "owned workflow job");
    const job = f.jobs.list()[0]!;
    assert.deepEqual(job.workflow, {
      runId: started.snapshot.runId,
      agentIndex: 0,
      label: "security review",
      phase: "Review",
    });
    f.backend.completeTask("owned job", "owned output");
    const final = await started.completion;
    assert.equal(final.agents[0]?.jobId, job.id);
    assert.equal(final.agents[0]?.label, "security review");
    assert.equal(final.agents[0]?.phase, 0);
  } finally {
    await f.cleanup();
  }
});

test("rejects completion with unawaited agent calls and waits for cancellation", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        void agent("forgotten", { role: "worker" });
        return "premature";
      }
    `));
    await waitFor(() => f.backend.requests.length === 1, "unawaited member to start");
    const final = await started.completion;
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /returned before 1 agent call settled/i);
    assert.equal(final.agents[0]?.state, "cancelled");
    assert.equal(f.backend.cancels.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("final artifact failure returns a structured failed snapshot instead of rejecting", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(
      `export default async () => agent("persist", { role: "worker" });`,
      { background: true },
    ));
    await waitFor(() => f.backend.requests.length === 1, "member before artifact removal");
    await rm(started.snapshot.artifactDir, { recursive: true, force: true });
    f.backend.completeTask("persist", "done");
    const final = await started.completion;
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /artifact persistence failed/i);
  } finally {
    await f.cleanup();
  }
});

test("fails workflows that exceed the retained unique phase limit", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        for (let index = 0; index < 65; index++) phase("phase-" + index);
        return "unreachable";
      }
    `));
    const final = await started.completion;
    assert.equal(final.status, "failed");
    assert.match(final.error ?? "", /phase limit exceeded \(64\)/i);
    assert.equal(final.phases.length, 64);
  } finally {
    await f.cleanup();
  }
});

test("implicit and assigned agent phases become running while their agents run", async () => {
  const f = await fixture(2);
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => parallel([
        () => agent("implicit", { role: "worker" }),
        () => agent("assigned", { role: "worker", phase: "Audit" })
      ], 2)
    `));
    await waitFor(() => f.backend.requests.length === 2, "implicit and assigned phases");
    const live = f.workflows.check(started.snapshot.runId);
    assert.deepEqual(live.phases.map((phase) => [phase.name, phase.status]), [
      ["Agents", "running"],
      ["Audit", "running"],
    ]);
    f.backend.completeTask("implicit");
    f.backend.completeTask("assigned");
    assert.equal((await started.completion).status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("aggregates usage across all workflow agents", async () => {
  const f = await fixture();
  try {
    const started = await f.workflows.start(f.request(`
      export default async () => {
        const one = await agent("usage one", { role: "worker" });
        const two = await agent("usage two", { role: "worker" });
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
  } finally {
    await f.cleanup();
  }
});
