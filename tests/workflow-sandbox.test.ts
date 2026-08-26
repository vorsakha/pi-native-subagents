import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { runWorkflowSandbox, type WorkflowConvergenceProgress, type WorkflowSandboxOptions } from "../src/workflows/sandbox.ts";

async function fixture(
  source: string,
  overrides: Partial<WorkflowSandboxOptions> = {},
) {
  const cwd = await tempDir("workflow-sandbox");
  const controller = new AbortController();
  const phases: string[] = [];
  const logs: string[] = [];
  const convergence: WorkflowConvergenceProgress[] = [];
  const options: WorkflowSandboxOptions = {
    source,
    args: { value: 7 },
    cwd,
    signal: controller.signal,
    onAgent: async (prompt, agentOptions) => ({
      ok: true,
      output: `${prompt}:${String(agentOptions.tag ?? "")}`,
      jobId: "job-1",
    }),
    onFollowUp: async (jobId, prompt, followUpOptions) => ({
      ok: true,
      output: `${jobId}:${prompt}:${String(followUpOptions.tag ?? "")}`,
      jobId,
    }),
    onMeta: () => {},
    onPhase: (title) => phases.push(title),
    onPhaseCapacity: (titles) => new Set([...phases, ...titles]).size <= 64
      ? { ok: true }
      : { ok: false, reason: "the run has fewer than two workflow phase slots left, so another implement/review round cannot start" },
    onLog: (message) => logs.push(message),
    onConvergence: (progress) => convergence.push(progress),
    ...overrides,
  };
  return { cwd, controller, phases, logs, convergence, options };
}

async function cleanup(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
}

test("runs sequential agent calls and exposes args through globals and arguments", async () => {
  const f = await fixture(`
    export const meta = { name: "sequential" };
    export default async function (input, emitPhase, callAgent) {
      emitPhase("first");
      const one = await callAgent("one", { tag: input.value });
      const two = await agent(one.output, { tag: args.value + 1 });
      phase("last");
      return { one, two, inputValue: input.value };
    }
  `);
  try {
    const value = await runWorkflowSandbox(f.options);
    assert.deepEqual(value, {
      meta: { name: "sequential" },
      result: {
        one: { ok: true, output: "one:7", jobId: "job-1" },
        two: { ok: true, output: "one:7:8", jobId: "job-1" },
        inputValue: 7,
      },
    });
    assert.deepEqual(f.phases, ["first", "last"]);
  } finally { await cleanup(f.cwd); }
});

test("pipelines items without a stage barrier and emits bounded progress logs", async () => {
  const events: string[] = [];
  const callIndices: number[] = [];
  const f = await fixture(`
    export default async () => {
      log("pipeline started");
      const values = await pipeline(
        ["fast", "slow"],
        async (item) => agent("stage-1:" + item),
        async (previous, original, index) => {
          log("stage-2:" + original + ":" + index);
          return agent("stage-2:" + original + ":" + previous.output);
        },
      );
      log("pipeline finished");
      return values.map((value) => value.output);
    }
  `, {
    onAgent: async (prompt, _options, _signal, callIndex) => {
      callIndices.push(callIndex);
      events.push(`start:${prompt}`);
      if (prompt === "stage-1:slow") await new Promise((resolve) => setTimeout(resolve, 50));
      events.push(`end:${prompt}`);
      return { ok: true, output: prompt, jobId: `job-${events.length}` };
    },
  });
  try {
    const value = await runWorkflowSandbox(f.options);
    assert.deepEqual(value.result, [
      "stage-2:fast:stage-1:fast",
      "stage-2:slow:stage-1:slow",
    ]);
    assert.ok(
      events.indexOf("start:stage-2:fast:stage-1:fast") < events.indexOf("end:stage-1:slow"),
      "a fast item advances to its next stage before slower items finish the prior stage",
    );
    assert.deepEqual(callIndices, [0, 1, 2, 3], "sandbox invocation ordinals are explicit and contiguous");
    assert.deepEqual(f.logs, ["pipeline started", "stage-2:fast:0", "stage-2:slow:1", "pipeline finished"]);
  } finally { await cleanup(f.cwd); }
});

test("pipeline drops an item to null when one of its stages throws", async () => {
  const f = await fixture(`
    export default async () => pipeline(
      ["keep", "drop"],
      (item) => item,
      (value) => {
        if (value === "drop") throw new Error("drop this item");
        return value.toUpperCase();
      },
      () => "unreachable for dropped items",
    );
  `);
  try {
    assert.deepEqual((await runWorkflowSandbox(f.options)).result, ["unreachable for dropped items", null]);
  } finally { await cleanup(f.cwd); }
});

test("aborts a running workflow and aborts in-flight agent work", async () => {
  let agentAborted = false;
  let markAgentStarted!: () => void;
  const agentStarted = new Promise<void>((resolve) => { markAgentStarted = resolve; });
  const f = await fixture(`export default async () => agent("wait", {})`, {
    onAgent: async (_prompt, _options, signal) => new Promise((resolve) => {
      markAgentStarted();
      signal.addEventListener("abort", () => {
        agentAborted = true;
        resolve({ ok: false, output: "", error: "aborted" });
      }, { once: true });
    }),
  });
  try {
    const running = runWorkflowSandbox(f.options);
    await agentStarted;
    f.controller.abort();
    await assert.rejects(running, (error: Error) => error.name === "AbortError");
    assert.equal(agentAborted, true);
  } finally { await cleanup(f.cwd); }

  let markStuckStarted!: () => void;
  const stuckStarted = new Promise<void>((resolve) => { markStuckStarted = resolve; });
  const stuck = await fixture(`export default async () => agent("stuck", {})`, {
    onAgent: async () => new Promise(() => { markStuckStarted(); }),
  });
  try {
    const running = runWorkflowSandbox(stuck.options);
    await stuckStarted;
    const startedAt = Date.now();
    stuck.controller.abort();
    await assert.rejects(running, (error: Error) => error.name === "AbortError");
    assert.ok(Date.now() - startedAt < 1_500, "stuck agent drain must remain bounded");
  } finally { await cleanup(stuck.cwd); }
});

test("terminates the child when a host progress callback fails", async () => {
  const f = await fixture(`
    export const meta = { name: "callback-failure" };
    export default async () => new Promise(() => {});
  `, {
    onMeta: () => { throw new Error("meta callback failed"); },
  });
  try {
    await assert.rejects(runWorkflowSandbox(f.options));
  } finally { await cleanup(f.cwd); }
});

test("has no overall deadline and runs until explicitly aborted", async () => {
  const f = await fixture(`export default async () => new Promise(() => {})`);
  try {
    const running = runWorkflowSandbox(f.options);
    const state = await Promise.race([
      running.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("running"), 75)),
    ]);
    assert.equal(state, "running");
    f.controller.abort();
    await assert.rejects(running, (error: Error) => error.name === "AbortError");
  } finally { await cleanup(f.cwd); }
});

test("rejects workflows that return before all agent calls are awaited", async () => {
  let aborted = false;
  const f = await fixture(`
    export default async () => {
      void agent("forgotten", {});
      return "premature";
    }
  `, {
    onAgent: async (_prompt, _options, signal) => new Promise((resolve) => {
      const onAbort = () => {
        aborted = true;
        resolve({ ok: false, output: "", error: "aborted" });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  try {
    await assert.rejects(runWorkflowSandbox(f.options), /returned before 1 agent call settled/i);
    assert.equal(aborted, true);
  } finally { await cleanup(f.cwd); }
});

test("accepts Davis-sized source and args even when their combined init frame exceeds 512 KiB", async () => {
  const largeArgs = "y".repeat(200 * 1024);
  const largeSource = `/*${"x".repeat(400 * 1024)}*/\nexport default async () => args.length`;
  const f = await fixture(largeSource, { args: largeArgs });
  try {
    const value = await runWorkflowSandbox(f.options);
    assert.equal(value.result, largeArgs.length);
  } finally { await cleanup(f.cwd); }
});

test("enforces payload, call, phase, and parallel limits", async () => {
  const source = await fixture("x".repeat(512 * 1024 + 1));
  try { await assert.rejects(runWorkflowSandbox(source.options), /source.*512 KiB/i); }
  finally { await cleanup(source.cwd); }

  const args = await fixture(`export default async () => null`, { args: "x".repeat(256 * 1024) });
  try { await assert.rejects(runWorkflowSandbox(args.options), /args.*256 KiB/i); }
  finally { await cleanup(args.cwd); }

  const result = await fixture(`export default async () => "x".repeat(1024 * 1024)`);
  try { await assert.rejects(runWorkflowSandbox(result.options), /result.*1 MiB/i); }
  finally { await cleanup(result.cwd); }

  const ipc = await fixture(`export default async () => agent("x".repeat(512 * 1024), {})`);
  try {
    const value = await runWorkflowSandbox(ipc.options);
    assert.match((value.result as { error: string }).error, /512 KiB IPC/i);
  } finally { await cleanup(ipc.cwd); }
  const phases = await fixture(`
    export default async () => {
      for (let index = 0; index < 129; index++) phase("phase-" + index);
      return "unreachable";
    }
  `);
  try { await assert.rejects(runWorkflowSandbox(phases.options), /phase event limit exceeded \(128\)/i); }
  finally { await cleanup(phases.cwd); }

  const logs = await fixture(`
    export default async () => {
      for (let index = 0; index < 257; index++) log("log-" + index);
      return "unreachable";
    }
  `);
  try { await assert.rejects(runWorkflowSandbox(logs.options), /log event limit exceeded \(256\)/i); }
  finally { await cleanup(logs.cwd); }

  const oversizedLog = await fixture(`export default async () => log("x".repeat(4096))`);
  try { await assert.rejects(runWorkflowSandbox(oversizedLog.options), /log message exceeds the 4 KiB limit/i); }
  finally { await cleanup(oversizedLog.cwd); }

  let calls = 0;
  const agents = await fixture(`
    export default async () => {
      const values = [];
      for (let index = 0; index < 33; index++) values.push(await agent(String(index), {}));
      return values;
    }
  `, {
    onAgent: async (prompt) => { calls++; return { ok: true, output: prompt }; },
  });
  try {
    const value = await runWorkflowSandbox(agents.options);
    assert.equal(calls, 32);
    const values = value.result as Array<{ ok: boolean; error?: string }>;
    assert.equal(values[31]?.ok, true);
    assert.deepEqual(values[32], { ok: false, output: "", error: "Agent call limit exceeded (32)" });
  } finally { await cleanup(agents.cwd); }

  for (const concurrency of [0, 5]) {
    const parallel = await fixture(`export default async () => parallel([() => 1], ${concurrency})`);
    try { await assert.rejects(runWorkflowSandbox(parallel.options), /concurrency.*1.*4/i); }
    finally { await cleanup(parallel.cwd); }
  }

  const noStages = await fixture(`export default async () => pipeline([1])`);
  try { await assert.rejects(runWorkflowSandbox(noStages.options), /one or more stage functions/i); }
  finally { await cleanup(noStages.cwd); }

  const tooManyItems = await fixture(`export default async () => pipeline(Array.from({ length: 4097 }, (_, index) => index), (item) => item)`);
  try { await assert.rejects(runWorkflowSandbox(tooManyItems.options), /at most 4096 items/i); }
  finally { await cleanup(tooManyItems.cwd); }
});

test("forbids nondeterministic time and random APIs used by replayable workflows", async () => {
  const f = await fixture(`
    export default async () => {
      const failures = [];
      for (const operation of [
        () => Date.now(),
        () => new Date(),
        () => Math.random(),
      ]) {
        try { operation(); failures.push("allowed"); }
        catch (error) { failures.push(error.message); }
      }
      return { failures, explicitDate: new Date(0).toISOString(), parsed: Date.parse("1970-01-01T00:00:00.000Z") };
    }
  `);
  try {
    const result = await runWorkflowSandbox(f.options);
    assert.deepEqual(result.result, {
      failures: [
        "Date.now() is not available in deterministic workflows",
        "new Date() is not available in deterministic workflows; pass an explicit value",
        "Math.random() is not available in deterministic workflows",
      ],
      explicitDate: "1970-01-01T00:00:00.000Z",
      parsed: 0,
    });
  } finally {
    await cleanup(f.cwd);
  }
});

test("rejects imports and denies require, process, global, filesystem, and network capabilities", async () => {
  const cases = [
    [`import fs from "node:fs"; export default async () => fs`, /import.*not allowed/i],
    [`export default async () => require("node:fs")`, /require.*not available|not defined/i],
    [`export default async () => process.version`, /process.*not available|not defined/i],
    [`export default async () => global.process`, /global.*not available|not defined/i],
    [`export default async () => module.exports`, /module.*not available|not defined/i],
    [`export default async () => fetch("https://example.com")`, /fetch.*not defined/i],
    [`export default async () => (() => {}).constructor("return process")()`, /code generation.*disallowed/i],
  ] as const;
  for (const [source, pattern] of cases) {
    const f = await fixture(source);
    try { await assert.rejects(runWorkflowSandbox(f.options), pattern); }
    finally { await cleanup(f.cwd); }
  }
});

const REQUEST_CHANGES = {
  verdict: "request_changes",
  summary: "one blocker remains",
  findings: [{ id: "F1", severity: "blocker", body: "guard the null case", filePath: "src/a.ts", startLine: 12 }],
};
const APPROVE = { verdict: "approve", summary: "all findings resolved", findings: [] };

/** Sandbox-only convergence fixture: reviews are replayed in order, one per review call. */
async function convergeFixture(script: string, reviews: unknown[]) {
  const agentCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const followUps: Array<{ jobId: string; prompt: string; options: Record<string, unknown> }> = [];
  let reviewCall = 0;
  const nextReview = () => reviews[Math.min(reviewCall++, reviews.length - 1)];
  return fixture(script, {
    onAgent: async (prompt, options) => {
      agentCalls.push({ prompt, options });
      return options.schema
        ? { ok: true, output: "reviewed", jobId: "job-reviewer", structured: nextReview() }
        : { ok: true, output: "implemented", jobId: "job-implementer" };
    },
    onFollowUp: async (jobId, prompt, options) => {
      followUps.push({ jobId, prompt, options });
      return jobId === "job-reviewer"
        ? { ok: true, output: "reviewed", jobId, structured: nextReview() }
        : { ok: true, output: "fixed", jobId };
    },
  }).then((f) => ({ ...f, agentCalls, followUps }));
}

const CONVERGE_SCRIPT = (options = "") => `
  export default async () => converge({
    maxRounds: 3,
    implement: { prompt: "implement it", options: { name: "implementer" } },
    review: { prompt: "review it", options: { name: "reviewer" } },
    ${options}
  });
`;

test("converge reuses both retained sessions across fix rounds and reports bounded progress", async () => {
  const f = await convergeFixture(CONVERGE_SCRIPT("independentReview: true,"), [REQUEST_CHANGES, APPROVE]);
  try {
    const value = await runWorkflowSandbox(f.options);
    const result = value.result as {
      ok: boolean; outcome: string; roundsAttempted: number; implementerJobId: string; reviewerJobId: string;
      rounds: Array<{ round: number; verdict: string; actionableCount: number; fingerprint: string }>;
    };
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "approved");
    assert.equal(result.roundsAttempted, 2);
    assert.equal(result.implementerJobId, "job-implementer");
    assert.equal(result.reviewerJobId, "job-reviewer");
    assert.deepEqual(result.rounds.map((round) => [round.round, round.verdict, round.actionableCount]), [
      [1, "request_changes", 1],
      [2, "approve", 0],
    ]);

    assert.equal(f.agentCalls.length, 2, "only the first round starts fresh children");
    assert.equal(f.agentCalls[1]?.options.access, "readOnly", "the reviewer is always read-only");
    assert.equal(f.agentCalls[1]?.options.independentOf, "job-implementer");
    assert.ok(f.agentCalls[1]?.options.schema, "every review is schema-validated");
    assert.deepEqual(f.followUps.map((call) => call.jobId), ["job-implementer", "job-reviewer"]);
    assert.match(f.followUps[0]!.prompt, /\[blocker\] F1 \(src\/a\.ts:12\): guard the null case/);
    assert.ok(!f.followUps[0]!.prompt.includes("implement it"), "only bounded review evidence goes back to the implementer");
    assert.deepEqual(f.followUps[1]!.options, { schema: f.agentCalls[1]!.options.schema }, "portable re-reviews repeat the same schema");
    assert.deepEqual(f.phases, ["implement 1", "review 1", "fix 1", "review 2"]);

    const terminal = f.convergence.at(-1)!;
    assert.equal(terminal.state, "approved");
    assert.equal(terminal.verdict, "approve");
    assert.equal(terminal.round, 2);
    assert.equal(terminal.maxRounds, 3);
    assert.match(terminal.stoppingReason ?? "", /approved in round 2/);
    assert.ok(f.convergence.some((entry) => entry.state === "running"), "progress is reported while the loop runs");
  } finally { await cleanup(f.cwd); }
});

test("converge never turns missing, malformed, or unactionable review structure into approval", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [undefined, /no structured verdict object/],
    [{ verdict: "approve" }, /summary must be a non-empty string/],
    [{ verdict: "looks-good", summary: "fine", findings: [] }, /verdict must be approve/],
    [{ verdict: "request_changes", summary: "s", findings: [] }, /without reporting an actionable finding/],
    [{ verdict: "request_changes", summary: "s", findings: [{ id: "F1", severity: "blocker", body: "a" }, { id: "F1", severity: "issue", body: "b" }] }, /ids must be unique/],
    [{ verdict: "request_changes", summary: "s", findings: [{ id: "F1", severity: "nit", body: "a" }] }, /unknown severity/],
    [{ verdict: "request_changes", summary: "s", findings: [{ id: "S1", severity: "suggestion", body: "a" }] }, /all suggestions/],
    [{ verdict: "approve", summary: "s", findings: [{ id: "F1", severity: "issue", body: "still broken" }] }, /approved while still reporting 1 actionable finding/],
  ];
  for (const [structured, pattern] of cases) {
    const f = await convergeFixture(CONVERGE_SCRIPT(), [structured]);
    try {
      const result = (await runWorkflowSandbox(f.options)).result as { ok: boolean; outcome: string; stoppingReason: string };
      assert.equal(result.ok, false, `${JSON.stringify(structured)} must not approve`);
      assert.equal(result.outcome, "failed");
      assert.match(result.stoppingReason, pattern);
    } finally { await cleanup(f.cwd); }
  }

  const approvalWithAdvisorySuggestion = {
    verdict: "approve",
    summary: "looks good",
    findings: [{ id: "S1", severity: "suggestion", body: "rename the helper" }],
  };
  const advisory = await convergeFixture(CONVERGE_SCRIPT(), [approvalWithAdvisorySuggestion]);
  try {
    const result = (await runWorkflowSandbox(advisory.options)).result as { outcome: string };
    assert.equal(result.outcome, "approved", "a suggestion stays advisory under the default policy");
  } finally { await cleanup(advisory.cwd); }

  const optedInSuggestion = await convergeFixture(CONVERGE_SCRIPT("includeSuggestions: true,"), [approvalWithAdvisorySuggestion]);
  try {
    const result = (await runWorkflowSandbox(optedInSuggestion.options)).result as { outcome: string; stoppingReason: string };
    assert.equal(result.outcome, "failed");
    assert.match(result.stoppingReason, /approved while still reporting 1 actionable finding/);
  } finally { await cleanup(optedInSuggestion.cwd); }
});

test("converge keeps every actionable finding in the bounded fix evidence", async () => {
  const findings = Array.from({ length: 32 }, (_, index) => ({
    id: `F${String(index + 1).padStart(2, "0")}`,
    severity: "issue",
    body: `finding ${index + 1} ${"x".repeat(3_900)}`,
    filePath: `src/${"nested/".repeat(80)}file-${index + 1}.ts`,
    startLine: index + 1,
  }));
  const f = await convergeFixture(CONVERGE_SCRIPT(), [{ verdict: "request_changes", summary: "many findings", findings }, APPROVE]);
  try {
    await runWorkflowSandbox(f.options);
    const prompt = f.followUps[0]!.prompt;
    assert.ok(prompt.length <= 8192, "fix evidence stays inside its documented prompt bound");
    for (const [index, finding] of findings.entries()) {
      assert.match(prompt, new RegExp(`\\[issue\\] ${finding.id}.*finding ${index + 1}`), `${finding.id} retains its actionable body`);
    }
  } finally { await cleanup(f.cwd); }
});

test("converge stops a stalled loop by default and honours an explicit stall tolerance", async () => {
  const repeated = [REQUEST_CHANGES, REQUEST_CHANGES, REQUEST_CHANGES];
  const stalled = await convergeFixture(CONVERGE_SCRIPT(), repeated);
  try {
    const result = (await runWorkflowSandbox(stalled.options)).result as { outcome: string; roundsAttempted: number; rounds: Array<{ fingerprint: string }>; stoppingReason: string };
    assert.equal(result.outcome, "stalled");
    assert.equal(result.roundsAttempted, 2);
    assert.equal(result.rounds[0]!.fingerprint, result.rounds[1]!.fingerprint, "the repeated finding set keeps its fingerprint");
    assert.match(result.stoppingReason, /repeated the same 1 unresolved finding/);
  } finally { await cleanup(stalled.cwd); }

  const tolerant = await convergeFixture(CONVERGE_SCRIPT("stallTolerance: 1,"), repeated);
  try {
    const result = (await runWorkflowSandbox(tolerant.options)).result as { outcome: string; roundsAttempted: number; finalReview: { verdict: string } };
    assert.equal(result.outcome, "stalled", "one tolerated repeat buys exactly one more round");
    assert.equal(result.roundsAttempted, 3);
    assert.equal(result.finalReview.verdict, "request_changes", "the last review is preserved as evidence");
  } finally { await cleanup(tolerant.cwd); }

  const bounded = await convergeFixture(`
    export default async () => converge({ maxRounds: 2, implement: "implement it", review: "review it" });
  `, [REQUEST_CHANGES, { ...REQUEST_CHANGES, findings: [{ id: "F2", severity: "issue", body: "another problem" }] }]);
  try {
    const result = (await runWorkflowSandbox(bounded.options)).result as { ok: boolean; outcome: string; roundsAttempted: number; stoppingReason: string; finalReview: { findings: Array<{ id: string }> } };
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "limit-reached", "progressing rounds still stop at the configured maximum");
    assert.equal(result.roundsAttempted, 2);
    assert.match(result.stoppingReason, /maximum of 2 round\(s\)/);
    assert.deepEqual(result.finalReview.findings.map((finding) => finding.id), ["F2"]);
  } finally { await cleanup(bounded.cwd); }
});

test("converge counts suggestions only when the workflow opts in", async () => {
  const review = {
    verdict: "request_changes",
    summary: "one blocker and one suggestion",
    findings: [
      { id: "F1", severity: "blocker", body: "guard the null case" },
      { id: "S1", severity: "suggestion", body: "rename the helper" },
    ],
  };
  const strict = await convergeFixture(CONVERGE_SCRIPT(), [review, APPROVE]);
  try {
    const result = (await runWorkflowSandbox(strict.options)).result as { rounds: Array<{ actionableCount: number }> };
    assert.equal(result.rounds[0]!.actionableCount, 1);
    assert.ok(!strict.followUps[0]!.prompt.includes("rename the helper"), "advisory suggestions stay out of the fix prompt");
  } finally { await cleanup(strict.cwd); }

  const inclusive = await convergeFixture(CONVERGE_SCRIPT("includeSuggestions: true,"), [review, APPROVE]);
  try {
    const result = (await runWorkflowSandbox(inclusive.options)).result as { rounds: Array<{ actionableCount: number }> };
    assert.equal(result.rounds[0]!.actionableCount, 2);
    assert.match(inclusive.followUps[0]!.prompt, /rename the helper/);
  } finally { await cleanup(inclusive.cwd); }
});

test("converge validates its contract before dispatching any call", async () => {
  const cases: Array<[string, RegExp]> = [
    [`converge()`, /requires an options object/],
    [`converge({ implement: "a", review: "b", maxRounds: 0 })`, /maxRounds must be an integer from 1 to 16/],
    [`converge({ implement: "a", review: "b", maxRounds: 17 })`, /maxRounds must be an integer from 1 to 16/],
    [`converge({ implement: "", review: "b" })`, /implement requires a non-empty prompt/],
    [`converge({ implement: "a", review: { prompt: "b", options: { access: "full" } } })`, /reviewers are always access/],
    [`converge({ implement: "a", review: { prompt: "b", options: { schema: { type: "object" } } } })`, /do not pass a review schema/],
    [`converge({ implement: { prompt: "a", options: { isolation: "worktree" } }, review: "b" })`, /cannot use isolation/],
    [`converge({ implement: "a", review: { prompt: "b", options: { phase: "distinct review" } } })`, /review options cannot set phase/],
    [`converge({ implement: "a", review: "b", stallTolerance: 9 })`, /stallTolerance must be an integer from 0 to 4/],
  ];
  for (const [expression, pattern] of cases) {
    const f = await convergeFixture(`export default async () => ${expression};`, [APPROVE]);
    try {
      await assert.rejects(runWorkflowSandbox(f.options), pattern, expression);
      assert.equal(f.agentCalls.length, 0, `${expression} must be rejected before dispatch`);
      assert.deepEqual(f.phases, []);
    } finally { await cleanup(f.cwd); }
  }
});

test("converge stops with limit-reached when the run cannot fund another round", async () => {
  const f = await convergeFixture(`
    export default async () => {
      for (let index = 0; index < 28; index++) await agent("burn " + index, { name: "burn" });
      return converge({
        maxRounds: 4,
        implement: "implement it",
        review: "review it",
      });
    }
  `, [REQUEST_CHANGES, { ...REQUEST_CHANGES, findings: [{ id: "F9", severity: "issue", body: "a different problem" }] }]);
  try {
    const result = (await runWorkflowSandbox(f.options)).result as { outcome: string; roundsAttempted: number; stoppingReason: string; finalReview: { verdict: string } };
    assert.equal(result.outcome, "limit-reached");
    assert.equal(result.roundsAttempted, 2, "two rounds fit in the four remaining agent calls");
    assert.match(result.stoppingReason, /fewer than two agent calls left/);
    assert.equal(result.finalReview.verdict, "request_changes", "the last review survives the limit");
  } finally { await cleanup(f.cwd); }
});

test("converge preflights the configured call budget before starting a fix without its review", async () => {
  const f = await convergeFixture(CONVERGE_SCRIPT(), [REQUEST_CHANGES]);
  f.options.maxAgentCalls = 3;
  try {
    const result = (await runWorkflowSandbox(f.options)).result as { outcome: string; roundsAttempted: number; stoppingReason: string };
    assert.equal(result.outcome, "limit-reached");
    assert.equal(result.roundsAttempted, 1);
    assert.match(result.stoppingReason, /fewer than two agent calls left/);
    assert.deepEqual(f.followUps, [], "the implementer is not mutated when no matching review call can fit");
  } finally { await cleanup(f.cwd); }
});

test("converge preflights the manager's 64 unique-phase cap", async () => {
  const f = await convergeFixture(`
    export default async () => {
      for (let index = 0; index < 63; index++) phase("prior " + index);
      return converge({ maxRounds: 2, implement: "implement", review: "review" });
    };
  `, [APPROVE]);
  try {
    const result = (await runWorkflowSandbox(f.options)).result as { outcome: string; roundsAttempted: number; stoppingReason: string };
    assert.equal(result.outcome, "limit-reached");
    assert.equal(result.roundsAttempted, 0);
    assert.match(result.stoppingReason, /fewer than two workflow phase slots left/);
    assert.deepEqual(f.agentCalls, [], "phase exhaustion is detected before the mutating implementation call");
    assert.equal(f.phases.length, 63);
  } finally { await cleanup(f.cwd); }
});

test("converge reports a budget-refused call as limit-reached rather than a failure", async () => {
  const f = await fixture(CONVERGE_SCRIPT(), {
    onAgent: async (_prompt, options) => options.schema
      ? { ok: true, output: "reviewed", jobId: "job-reviewer", structured: REQUEST_CHANGES }
      : { ok: true, output: "implemented", jobId: "job-implementer" },
    onFollowUp: async () => ({ ok: false, output: "", error: "Workflow token budget exhausted (10/10)", limit: "budget" as const }),
  });
  try {
    const result = (await runWorkflowSandbox(f.options)).result as { outcome: string; stoppingReason: string; finalReview: { verdict: string } };
    assert.equal(result.outcome, "limit-reached");
    assert.match(result.stoppingReason, /token budget exhausted/);
    assert.equal(result.finalReview.verdict, "request_changes");
  } finally { await cleanup(f.cwd); }
});
