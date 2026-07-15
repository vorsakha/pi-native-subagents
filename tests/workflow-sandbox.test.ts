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
  const options: WorkflowSandboxOptions = {
    source,
    args: { value: 7 },
    cwd,
    signal: controller.signal,
    timeoutMs: 2_000,
    onAgent: async (prompt, agentOptions) => ({
      ok: true,
      output: `${prompt}:${String(agentOptions.tag ?? "")}`,
      jobId: "job-1",
    }),
    onPhase: (title) => phases.push(title),
    ...overrides,
  };
  return { cwd, controller, phases, options };
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

test("parallel preserves order and caps active work at four", async () => {
  let active = 0;
  let maximum = 0;
  const f = await fixture(`
    export default async function () {
      return parallel(Array.from({ length: 12 }, (_, index) =>
        () => agent(String(index), {})), 4);
    }
  `, {
    onAgent: async (prompt) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return { ok: true, output: prompt };
    },
  });
  try {
    const value = await runWorkflowSandbox(f.options);
    assert.equal(maximum, 4);
    assert.deepEqual((value.result as Array<{ output: string }>).map((item) => item.output),
      Array.from({ length: 12 }, (_, index) => String(index)));
  } finally { await cleanup(f.cwd); }
});

test("returns agent failures as data instead of throwing", async () => {
  const f = await fixture(`export default async () => agent("bad", {})`, {
    onAgent: async () => { throw new Error("backend unavailable"); },
  });
  try {
    const value = await runWorkflowSandbox(f.options);
    assert.deepEqual(value.result, { ok: false, output: "", error: "backend unavailable" });
  } finally { await cleanup(f.cwd); }
});

test("reports syntax and runtime errors", async () => {
  const syntax = await fixture(`export default async function (`);
  try {
    await assert.rejects(runWorkflowSandbox(syntax.options), /syntax|unexpected/i);
  } finally { await cleanup(syntax.cwd); }

  const runtime = await fixture(`export default async () => { throw new Error("workflow boom") }`);
  try {
    await assert.rejects(runWorkflowSandbox(runtime.options), /workflow boom/);
  } finally { await cleanup(runtime.cwd); }
});

test("aborts a running workflow and aborts in-flight agent work", async () => {
  let agentAborted = false;
  const f = await fixture(`export default async () => agent("wait", {})`, {
    onAgent: async (_prompt, _options, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        agentAborted = true;
        resolve({ ok: false, output: "", error: "aborted" });
      }, { once: true });
    }),
  });
  try {
    const running = runWorkflowSandbox(f.options);
    setTimeout(() => f.controller.abort(), 30);
    await assert.rejects(running, (error: Error) => error.name === "AbortError");
    assert.equal(agentAborted, true);
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

test("times out a workflow that never settles", async () => {
  const f = await fixture(`export default async () => new Promise(() => {})`, { timeoutMs: 40 });
  try {
    await assert.rejects(runWorkflowSandbox(f.options), (error: Error) => error.name === "TimeoutError");
  } finally { await cleanup(f.cwd); }
});

test("rejects oversized source, arguments, results, and IPC agent requests", async () => {
  const source = await fixture("x".repeat(256 * 1024 + 1));
  try { await assert.rejects(runWorkflowSandbox(source.options), /source.*256 KiB/i); }
  finally { await cleanup(source.cwd); }

  const args = await fixture(`export default async () => null`, { args: "x".repeat(128 * 1024) });
  try { await assert.rejects(runWorkflowSandbox(args.options), /args.*128 KiB/i); }
  finally { await cleanup(args.cwd); }

  const result = await fixture(`export default async () => "x".repeat(1024 * 1024)`);
  try { await assert.rejects(runWorkflowSandbox(result.options), /result.*1 MiB/i); }
  finally { await cleanup(result.cwd); }

  const ipc = await fixture(`export default async () => agent("x".repeat(512 * 1024), {})`);
  try {
    const value = await runWorkflowSandbox(ipc.options);
    assert.match((value.result as { error: string }).error, /512 KiB IPC/i);
  } finally { await cleanup(ipc.cwd); }
});

test("bounds phase event cardinality", async () => {
  const f = await fixture(`
    export default async () => {
      for (let index = 0; index < 129; index++) phase("phase-" + index);
      return "unreachable";
    }
  `);
  try {
    await assert.rejects(runWorkflowSandbox(f.options), /phase event limit exceeded \(128\)/i);
  } finally { await cleanup(f.cwd); }
});

test("limits workflows to 32 agent calls", async () => {
  let calls = 0;
  const f = await fixture(`
    export default async () => {
      const values = [];
      for (let index = 0; index < 33; index++) values.push(await agent(String(index), {}));
      return values;
    }
  `, {
    onAgent: async (prompt) => { calls++; return { ok: true, output: prompt }; },
  });
  try {
    const value = await runWorkflowSandbox(f.options);
    assert.equal(calls, 32);
    const values = value.result as Array<{ ok: boolean; error?: string }>;
    assert.equal(values[31]?.ok, true);
    assert.deepEqual(values[32], { ok: false, output: "", error: "Agent call limit exceeded (32)" });
  } finally { await cleanup(f.cwd); }
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

test("validates parallel concurrency bounds", async () => {
  for (const concurrency of [0, 5]) {
    const f = await fixture(`export default async () => parallel([() => 1], ${concurrency})`);
    try { await assert.rejects(runWorkflowSandbox(f.options), /concurrency.*1.*4/i); }
    finally { await cleanup(f.cwd); }
  }
});
