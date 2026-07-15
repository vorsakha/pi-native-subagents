import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ClaudeBackend } from "../src/backends/claude.ts";
import { PiRpcBackend } from "../src/backends/pi-rpc.ts";
import { CodexAppServerBackend } from "../src/backends/codex.ts";
import { MAX_OUTPUT_BYTES } from "../src/reducer.ts";
import type { BackendEvent, BackendName, BackendRequest } from "../src/types.ts";

const execFileAsync = promisify(execFile);

const PI_FIXTURE = `#!/usr/bin/env node
import fs from "node:fs";
if (process.env.ARG_FILE) fs.writeFileSync(process.env.ARG_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.ENV_FILE) fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({ openai: process.env.OPENAI_API_KEY, codex: process.env.CODEX_API_KEY }));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\\n");
    if (at < 0) break;
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    const value = JSON.parse(line);
    if (process.env.MODE === "hang") continue;
    if (value.id) process.stdout.write(JSON.stringify({ type: "response", id: value.id, command: value.type, success: true }) + "\\n");
    if (value.type === "prompt" && process.env.MODE === "complete") complete("PI_OK");
    if (value.type === "prompt" && process.env.MODE === "assistant_error") assistantEnd("error", "model exploded");
    if (value.type === "prompt" && process.env.MODE === "assistant_aborted") assistantEnd("aborted", "request aborted");
    if (value.type === "prompt" && process.env.MODE === "stream_error") {
      process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "error", error: { stopReason: "error", errorMessage: "stream exploded" } } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
    if (value.type === "prompt" && process.env.MODE === "extension_error") {
      process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: "fixture-extension", error: { message: "extension exploded" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
    if (value.type === "prompt" && process.env.MODE === "retry_error") {
      process.stdout.write(JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "retries exhausted" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
    if (value.type === "prompt" && process.env.MODE === "malformed") process.stdout.write("{not-json}\\n");
    if (value.type === "steer" || value.type === "follow_up") complete(value.message);
  }
});
function complete(text) {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: {}, stopReason: "stop" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
}
function assistantEnd(stopReason, errorMessage) {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: {}, stopReason, errorMessage } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
}
setInterval(() => {}, 1000);
`;

const CODEX_FIXTURE = `#!/usr/bin/env node
import fs from "node:fs";
let buffer = "";
let turns = 0;
process.stdin.setEncoding("utf8");
if (process.env.MODE === "exit") process.exit(7);
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\\n");
    if (at < 0) break;
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    const value = JSON.parse(line);
    if (!value.id || process.env.MODE === "hang") continue;
    if (value.method === "initialize") reply(value.id, {});
    else if (value.method === "account/read") reply(value.id, { account: { type: "chatgpt" } });
    else if (value.method === "thread/start") {
      if (process.env.THREAD_PARAM_FILE) fs.writeFileSync(process.env.THREAD_PARAM_FILE, JSON.stringify(value.params));
      reply(value.id, { modelProvider: "openai", thread: { id: "thread-1", modelProvider: process.env.THREAD_PROVIDER || "openai" } });
    }
    else if (value.method === "turn/start") {
      if (process.env.PARAM_FILE) fs.appendFileSync(process.env.PARAM_FILE, JSON.stringify(value.params) + "\\n");
      const number = ++turns; const id = "turn-" + number;
      reply(value.id, { turn: { id } });
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: number === 1 ? "FIRST" : "SECOND" } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id, status: "completed" } } }) + "\\n");
      }, 40);
    } else if (value.method === "turn/steer") reply(value.id, { turnId: "turn-1" });
    else reply(value.id, {});
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
setInterval(() => {}, 1000);
`;

async function fixture(source: string): Promise<{ dir: string; command: string }> {
  const dir = await mkdtemp(join(tmpdir(), "native-subagents-backend-"));
  const command = join(dir, "fixture.mjs");
  await writeFile(command, source);
  await chmod(command, 0o755);
  return { dir, command };
}

function request(backend: BackendName, cwd: string, env: NodeJS.ProcessEnv): BackendRequest {
  return {
    jobId: `job-${backend}`, role: "worker", task: "fixture task", systemPrompt: "fixture system", cwd, env,
    signal: new AbortController().signal,
    policy: {
      backend, access: "readOnly", model: "fixture-model", thinking: "low", effort: "low",
      piTools: [], claudeTools: [], approvalPolicy: "never",
      codexSandbox: { type: "readOnly", networkAccess: false },
      nestedAgents: [], depth: 1, maxDepth: 2,
    },
  };
}

function terminal(events: BackendEvent[]): BackendEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") return event;
  }
  return undefined;
}

test("Pi RPC uses a persistent native session and accepts steering", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "args.json");
  const envFile = join(fake.dir, "env.json");
  const events: BackendEvent[] = [];
  try {
    const backend = new PiRpcBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 });
    const run = await backend.start(request("pi", fake.dir, {
      ...process.env, MODE: "wait", ARG_FILE: argFile, ENV_FILE: envFile,
      OPENAI_API_KEY: "must-not-leak", CODEX_API_KEY: "must-not-leak",
    }), (event) => events.push(event));
    await run.send("STEERED", "steer");
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "STEERED" });
    const args = JSON.parse(await readFile(argFile, "utf8")) as string[];
    assert.equal(args.includes("--no-session"), false);
    assert.equal(args.includes("--approve"), true);
    assert.equal(args.includes("--no-extensions"), true);
    assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {});
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi RPC startup abort tears down a child before returning a run", async () => {
  const fake = await fixture(PI_FIXTURE);
  const controller = new AbortController();
  const events: BackendEvent[] = [];
  try {
    const startup = new PiRpcBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 })
      .start({ ...request("pi", fake.dir, { ...process.env, MODE: "hang" }), signal: controller.signal }, (event) => events.push(event));
    controller.abort(new Error("cancel startup"));
    await assert.rejects(startup, /cancel startup/);
    assert.equal(terminal(events)?.type, "cancelled");
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("standalone top-level Pi lifecycle exits zero instead of unsettled-await code 13", async () => {
  const fake = await fixture(PI_FIXTURE);
  const runner = join(fake.dir, "runner.mjs");
  const backendUrl = pathToFileURL(join(process.cwd(), "src/backends/pi-rpc.ts")).href;
  try {
    await writeFile(runner, `
      import { PiRpcBackend } from ${JSON.stringify(backendUrl)};
      const request = JSON.parse(process.env.REQUEST);
      request.env = { ...process.env, MODE: "complete" };
      request.signal = new AbortController().signal;
      const run = await new PiRpcBackend(process.env.FIXTURE, { requestTimeoutMs: 500, runTimeoutMs: 2000 }).start(request, () => {});
      await run.completed;
      await run.close();
      process.stdout.write("DONE\\n");
    `);
    const childRequest = request("pi", fake.dir, {});
    const { stdout } = await execFileAsync(process.execPath, [runner], {
      env: { ...process.env, FIXTURE: fake.command, REQUEST: JSON.stringify(childRequest) },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(stdout, "DONE\n");
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi RPC maps assistant, stream, extension, and exhausted-retry errors at settlement", async (t) => {
  const cases = [
    ["assistant_error", "failed", /model exploded/],
    ["assistant_aborted", "cancelled", /request aborted/],
    ["stream_error", "failed", /stream exploded/],
    ["extension_error", "failed", /extension exploded/],
    ["retry_error", "failed", /retries exhausted/],
    ["malformed", "failed", /framing failed.*invalid JSON object/],
  ] as const;
  for (const [mode, expectedType, expectedMessage] of cases) {
    await t.test(mode, async () => {
      const fake = await fixture(PI_FIXTURE);
      const events: BackendEvent[] = [];
      try {
        const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 })
          .start(request("pi", fake.dir, { ...process.env, MODE: mode }), (event) => events.push(event));
        await run.completed;
        const event = terminal(events) as Extract<BackendEvent, { type: "failed" | "cancelled" }>;
        assert.equal(event.type, expectedType);
        assert.match(event.type === "failed" ? event.error : event.reason ?? "", expectedMessage);
        await run.close();
      } finally { await rm(fake.dir, { recursive: true, force: true }); }
    });
  }
});

test("Claude emits live text/message events and bounds accumulated multi-turn output", async () => {
  const huge = "x".repeat(MAX_OUTPUT_BYTES);
  let capturedOptions: Record<string, unknown> | undefined;
  let verifiedEnv: NodeJS.ProcessEnv | undefined;
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "live" } } };
    yield { type: "assistant", message: { content: [{ type: "text", text: "message" }] } };
    yield { type: "system", subtype: "permission_denied", tool_use_id: "denied-write", tool_name: "Write" };
    yield { type: "result", subtype: "success", result: huge, usage: {}, total_cost_usd: 0, num_turns: 1 };
    yield { type: "result", subtype: "success", result: huge, usage: {}, total_cost_usd: 0, num_turns: 1 };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const backend = new ClaudeBackend("fixture-claude", {
    verifyAuth: async (_command, _cwd, env) => { verifiedEnv = env; },
    queryFn: ((input: { options?: Record<string, unknown> }) => { capturedOptions = input.options; return stream; }) as never,
    runTimeoutMs: 2_000,
  });
  const claudeRequest = request("claude", process.cwd(), {
    ...process.env,
    KEEP_GENERIC: "yes",
    ANTHROPIC_BASE_URL: "https://gateway.invalid",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_ACCESS_KEY_ID: "must-not-leak",
  });
  const run = await backend.start(claudeRequest, (event) => events.push(event));
  await run.send("second turn", "followUp");
  await run.completed;
  const final = terminal(events) as Extract<BackendEvent, { type: "completed" }>;
  assert.equal(capturedOptions?.includePartialMessages, true);
  const childEnv = capturedOptions?.env as NodeJS.ProcessEnv;
  for (const env of [verifiedEnv, childEnv]) {
    assert.equal(env?.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env?.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(env?.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env?.KEEP_GENERIC, "yes");
  }
  assert.ok(events.some((event) => event.type === "text_delta" && event.text === "live"));
  assert.ok(events.some((event) => event.type === "message" && event.text === "message"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.id === "denied-write" && event.error));
  assert.ok(Buffer.byteLength(final.output ?? "") <= MAX_OUTPUT_BYTES);
  assert.match(final.output ?? "", /Earlier output truncated/);
  await run.close();
});

test("Claude startup forwards cancellation to subscription auth verification", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const backend = new ClaudeBackend("fixture-claude", {
    verifyAuth: async (_command, _cwd, _env, signal) => {
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    queryFn: (() => assert.fail("query must not start after auth cancellation")) as never,
  });
  const startup = backend.start({ ...request("claude", process.cwd(), process.env), signal: controller.signal }, () => undefined);
  controller.abort(new Error("startup cancelled"));
  await assert.rejects(startup, /startup cancelled/);
  assert.equal(observedSignal, controller.signal);
});

test("Claude synchronous SDK startup failure leaves no live timeout", async () => {
  const backend = new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => { throw new Error("SDK startup failed"); }) as never,
    runTimeoutMs: 20,
  });
  await assert.rejects(backend.start(request("claude", process.cwd(), process.env), () => undefined), /SDK startup failed/);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
});

test("Claude fails closed if a read-only CLI init exposes mutating tools", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: ["Read", "Write"] };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    runTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const event = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(event.type, "failed");
  assert.match(event.error, /read-only initialization exposed mutating tools: Write/);
  await run.close();
});

test("Pi RPC hard timeout settles and teardown remains awaitable", async () => {
  const fake = await fixture(PI_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 40 })
      .start(request("pi", fake.dir, { ...process.env, MODE: "hang" }), (event) => events.push(event));
    await run.completed;
    assert.match((terminal(events) as { error: string }).error, /run timed out after 40ms/);
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex queues a native follow-up turn before settling", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  const paramFile = join(fake.dir, "turn-params.jsonl");
  const threadParamFile = join(fake.dir, "thread-params.json");
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "normal", PARAM_FILE: paramFile, THREAD_PARAM_FILE: threadParamFile }), (event) => events.push(event));
    // send() waits for asynchronous app-server initialization instead of
    // exposing an initialization race to callers.
    await run.send("FOLLOW", "followUp");
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "FIRST\n\nSECOND" });
    const turns = (await readFile(paramFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(turns.length, 2);
    assert.equal(JSON.parse(await readFile(threadParamFile, "utf8")).modelProvider, "openai");
    for (const params of turns) {
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.cwd, fake.dir);
    }
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex rejects a conflicting provider returned by thread/start", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, THREAD_PROVIDER: "custom" }), (event) => events.push(event));
    await run.completed;
    assert.match((terminal(events) as { error: string }).error, /did not retain.*openai.*custom/);
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex startup timeout and early exit both settle clearly", async (t) => {
  for (const mode of ["hang", "exit"] as const) {
    await t.test(mode, async () => {
      const fake = await fixture(CODEX_FIXTURE);
      const events: BackendEvent[] = [];
      try {
        const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 150, runTimeoutMs: 400 })
          .start(request("codex", fake.dir, { ...process.env, MODE: mode }), (event) => events.push(event));
        await run.completed;
        const event = terminal(events) as { type: string; error: string };
        assert.equal(event.type, "failed");
        assert.match(event.error, mode === "hang" ? /request timed out: initialize/ : /exited \(7\)|process exited \(7\)/);
        await run.close();
      } finally { await rm(fake.dir, { recursive: true, force: true }); }
    });
  }
});
