import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflowSandbox, type WorkflowSandboxOptions } from "../src/workflows/sandbox.ts";

async function fixture(
  source: string,
  overrides: Partial<WorkflowSandboxOptions> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-sandbox-"));
  const controller = new AbortController();
  const phases: string[] = [];
  const logs: string[] = [];
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
    onMeta: () => {},
    onPhase: (title) => phases.push(title),
    onLog: (message) => logs.push(message),
    ...overrides,
  };
  return { cwd, controller, phases, logs, options };
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
    await assert.rejects(runWorkflowSandbox(f.options), /meta callback failed/);
  } finally { await cleanup(f.cwd); }
});

test("explains that workflow helpers are globals when the callback context is misused", async () => {
  const f = await fixture(`export default async ({ phase }) => phase("wrong shape")`, { args: null });
  try {
    await assert.rejects(runWorkflowSandbox(f.options), /Workflow helpers are globals.*phase\(\)/i);
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
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ ok: false, output: "", error: "aborted" });
      }, { once: true });
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

  const startedTasks = await fixture(`export default async () => parallel([Promise.resolve("already started")])`);
  try {
    await assert.rejects(runWorkflowSandbox(startedTasks.options), /parallel\(\) requires deferred functions.*\(\) => agent/i);
  } finally { await cleanup(startedTasks.cwd); }

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
