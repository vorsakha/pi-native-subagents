import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { claimWorkflowDatabase } from "../src/workflows/state.ts";
import { tempDir, withTimeout, workflowRuntimeOptions } from "./helpers.ts";
import { runWorkflowSandbox } from "../src/workflows/sandbox.ts";

// This exercises the real Durable scheduler, SQLite, QuickJS, WorkflowManager, and JobManager.
// Native execution uses ControlledBackend; no provider process reattachment is claimed.
test("SIGKILL recovery keeps completed results and never redispatches an interrupted native call", { timeout: 20_000 }, async () => {
  const directory = await tempDir("durable-crash");
  const fixture = join(import.meta.dirname, "fixtures", "workflow-crash.ts");
  const first = spawn(process.execPath, [fixture, "run", directory], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  first.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = once(first, "exit");
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      let output = "";
      first.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("READY\n")) resolve(); });
      first.once("exit", () => reject(new Error(errors || "Crash worker exited before native dispatch")));
    }), "Durable crash checkpoint", 10_000);
    first.kill("SIGKILL");
    await exited;
    const recovered = spawn(process.execPath, [fixture, "recover", directory], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let recoveryErrors = "";
    recovered.stdout.on("data", (chunk) => { output += String(chunk); });
    recovered.stderr.on("data", (chunk) => { recoveryErrors += String(chunk); });
    try {
      const [code] = await withTimeout(once(recovered, "exit"), "Durable recovery", 10_000);
      assert.equal(code, 0, recoveryErrors);
      const result = JSON.parse(output.trim()) as {
        status: string;
        agents: string[];
        usage: { input: number; output: number; turns: number };
        result: { done: { ok: boolean }; interrupted: { ok: boolean; error: string }; after: { ok: boolean } };
      };
      assert.equal(result.status, "completed");
      assert.equal(result.agents.length, 3, "recovery retains both earlier agent records and the new call");
      assert.equal(result.usage.input, 7, "completed native spend survives a crash before the debounce checkpoint");
      assert.equal(result.usage.output, 3);
      assert.equal(result.usage.turns, 1);
      assert.equal(result.result.done.ok, true);
      assert.equal(result.result.interrupted.ok, false);
      assert.match(result.result.interrupted.error, /interrupted.*may have partially run/i);
      assert.equal(result.result.after.ok, true);
      assert.deepEqual((await readFile(join(directory, "calls"), "utf8")).trim().split("\n"), ["done", "interrupted", "after"]);
    } finally { recovered.kill("SIGKILL"); }
  } finally { first.kill("SIGKILL"); }
});

test("host admission bounds direct sandbox tool calls that bypass the workflow helpers", async () => {
  const cwd = await tempDir("durable-admission");
  let dispatched = 0;
  const options = workflowRuntimeOptions(cwd, `export default async () => {
    for (let index = 0; index < 601; index++) {
      try { await tools.workflow_agent({ operation: "agent", prompt: "invalid ordinal", options: {}, callIndex: 31 }); }
      catch {}
    }
  }`, {
    onAgent: async () => { dispatched++; return { ok: true, output: "unexpected" }; },
  });
  await assert.rejects(runWorkflowSandbox(options), /600 host-call limit/);
  assert.equal(dispatched, 0);
  options.source = `export default async () => tools.workflow_runner({ code: "return 1" });`;
  await assert.rejects(runWorkflowSandbox(options), /cannot start nested workflows/);
});

test("one live owner schedules a private database while passive inspection dispatches nothing", async () => {
  const cwd = await tempDir("durable-owner");
  const database = join(cwd, "runtime.sqlite");
  const controller = new AbortController();
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  let dispatches = 0;
  const options = workflowRuntimeOptions(cwd, `export default async () => agent("wait")`, {
    database, signal: controller.signal,
    onAgent: async (_prompt, _options, signal) => {
      dispatches++;
      started();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, output: "", error: "aborted" }), { once: true }));
    },
  });
  const running = runWorkflowSandbox(options);
  try {
    await active;
    await assert.rejects(runWorkflowSandbox({ ...options, signal: new AbortController().signal }), /live owner/);
    const db = new DatabaseSync(database, { readOnly: true });
    const before = db.prepare("SELECT * FROM tasks ORDER BY id").all();
    const reader = spawn(process.execPath, ["--input-type=module", "-e", `
      import { inspectWorkflowExecution } from ${JSON.stringify(new URL("../src/workflows/runtime.ts", import.meta.url).href)};
      import { readWorkflowState } from ${JSON.stringify(new URL("../src/workflows/state.ts", import.meta.url).href)};
      await readWorkflowState(${JSON.stringify(database)});
      const state = await inspectWorkflowExecution(${JSON.stringify(database)});
      if (!state.pending) throw new Error("Missing active workflow");
    `], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    reader.stderr.on("data", (chunk) => { errors += String(chunk); });
    try {
      const [code] = await withTimeout(once(reader, "exit"), "Passive reader");
      assert.equal(code, 0, errors);
      assert.deepEqual(db.prepare("SELECT * FROM tasks ORDER BY id").all(), before,
        "cross-process inspection must leave committed task records unchanged");
    } finally { reader.kill("SIGKILL"); db.close(); }
    const { inspectWorkflowExecution } = await import("../src/workflows/runtime.ts");
    assert.equal((await inspectWorkflowExecution(database)).pending, true);
    assert.equal(dispatches, 1, "passive inspection must not enable another scheduler");
  } finally {
    controller.abort();
    await assert.rejects(running, (error: Error) => error.name === "AbortError");
  }
});

test("script console output stays private when reporting a workflow failure", async () => {
  const cwd = await tempDir("durable-private-error");
  const options = workflowRuntimeOptions(cwd, `export default async () => {
    console.log("PRIVATE_SCRIPT_OUTPUT");
    throw new Error("expected failure");
  }`);
  await assert.rejects(runWorkflowSandbox(options), (error: Error) => {
    assert.equal(error.message, "expected failure");
    assert.doesNotMatch(error.message, /PRIVATE_SCRIPT_OUTPUT/);
    return true;
  });
});


test("unawaited helper and direct native calls cannot commit success", async () => {
  const cwd = await tempDir("durable-unawaited");
  for (const call of [
    'agent("forgotten")',
    'tools.workflow_agent({ operation: "agent", prompt: "forgotten", options: {}, callIndex: 0 })',
  ]) {
    let dispatched = 0;
    let cancelled = 0;
    await assert.rejects(runWorkflowSandbox(workflowRuntimeOptions(cwd,
      `export default async () => { void ${call}; return "success"; }`, {
        onAgent: async (_prompt, _options, signal) => {
          dispatched++;
          return new Promise((resolve) => {
            const abort = () => { cancelled++; resolve({ ok: false, output: "", error: "cancelled" }); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
        },
      })), /await every|returned before/i);
    assert.equal(cancelled, dispatched, "every dispatched call settles cancellation before close returns");
  }
});

test("owner publication recovers residue and never replaces a live lease", async () => {
  const cwd = await tempDir("durable-owner-publication");
  const database = join(cwd, "runtime.sqlite");
  const owner = join(cwd, "runtime.owner");
  const pending = `${owner}.pending`;
  await writeFile(owner, "");
  await writeFile(pending, '{"pid":');
  const release = await claimWorkflowDatabase(database);
  const published = await readFile(owner, "utf8");
  assert.equal(JSON.parse(published).pid, process.pid);
  await assert.rejects(readFile(pending), { code: "ENOENT" });
  await assert.rejects(claimWorkflowDatabase(database), /live owner/);
  assert.equal(await readFile(owner, "utf8"), published);
  await release();
  const reacquired = await claimWorkflowDatabase(database);
  await reacquired();
});

test("destructured module exports retain metadata at the host boundary", async () => {
  const cwd = await tempDir("durable-meta-bindings");
  for (const declaration of [
    'const { meta } = { meta: { name: "binding" } }',
    'const [{ nested: { meta = { name: "binding" } } }] = [{ nested: {} }]',
    'const [unused, ...meta] = [0, "binding"]',
    'const { unused, ...meta } = { unused: 0, name: "binding" }',
  ]) {
    let observed: unknown;
    const result = await runWorkflowSandbox(workflowRuntimeOptions(cwd,
      `export ${declaration}; export default async () => meta;`, {
        onMeta: (meta) => { observed = meta; },
      }));
    assert.deepEqual(result.meta, observed);
    assert.deepEqual(result.result, observed);
    assert.ok(observed, "metadata must reach the host");
  }
});
