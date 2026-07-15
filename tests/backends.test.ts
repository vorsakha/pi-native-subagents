import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBackend } from "../src/backends/claude.ts";
import { PiRpcBackend } from "../src/backends/pi-rpc.ts";
import { CodexAppServerBackend } from "../src/backends/codex.ts";
import { MAX_OUTPUT_BYTES } from "../src/reducer.ts";
import type { BackendEvent, BackendName, BackendRequest } from "../src/types.ts";

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
    if (value.type === "prompt" && process.env.MODE === "complete") complete(value.message.startsWith("Task:") ? "PI_OK" : value.message);
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

test("Pi RPC keeps a persistent native session and reopens a completed turn", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "args.json");
  const envFile = join(fake.dir, "env.json");
  const events: BackendEvent[] = [];
  try {
    const backend = new PiRpcBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 });
    const run = await backend.start(request("pi", fake.dir, {
      ...process.env, MODE: "complete", ARG_FILE: argFile, ENV_FILE: envFile,
      OPENAI_API_KEY: "must-not-leak", CODEX_API_KEY: "must-not-leak",
    }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "PI_OK" });
    await run.send("SECOND", "followUp");
    const deadline = Date.now() + 1_000;
    while (events.filter((event) => event.type === "completed").length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(terminal(events), { type: "completed", output: "SECOND" });
    const args = JSON.parse(await readFile(argFile, "utf8")) as string[];
    assert.equal(args.includes("--no-session"), false);
    assert.equal(args.includes("--approve"), true);
    assert.equal(args.includes("--no-extensions"), true);
    assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {});
    await run.close();
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

test("Claude emits live events and reopens a completed subscription session", async () => {
  const huge = "x".repeat(MAX_OUTPUT_BYTES);
  let capturedOptions: Record<string, unknown> | undefined;
  let verifiedEnv: NodeJS.ProcessEnv | undefined;
  let releaseSecond!: () => void;
  const secondTurn = new Promise<void>((resolve) => { releaseSecond = resolve; });
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "live thought" } } };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "live" } } };
    yield { type: "assistant", message: { content: [{ type: "thinking", thinking: "final thought" }, { type: "text", text: "message" }] } };
    yield { type: "system", subtype: "permission_denied", tool_use_id: "denied-write", tool_name: "Write" };
    yield { type: "result", subtype: "success", result: huge, usage: {}, total_cost_usd: 0, num_turns: 1 };
    await secondTurn;
    yield { type: "assistant", message: { content: [{ type: "text", text: "second message" }] } };
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
  await run.completed;
  await run.send("second turn", "followUp");
  releaseSecond();
  const deadline = Date.now() + 1_000;
  while (events.filter((event) => event.type === "completed").length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
  assert.ok(events.some((event) => event.type === "thinking_delta" && event.text === "live thought"));
  assert.ok(events.some((event) => event.type === "thinking_message" && event.text === "final thought"));
  assert.ok(events.some((event) => event.type === "user_message" && event.text === "second turn"));
  assert.ok(events.some((event) => event.type === "message" && event.text === "message"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.id === "denied-write" && event.error));
  assert.ok(Buffer.byteLength(final.output ?? "") <= MAX_OUTPUT_BYTES);
  assert.equal(events.filter((event) => event.type === "completed").length, 2);
  await run.close();
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

test("Codex reuses its native thread for queued and post-settlement follow-ups", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  const paramFile = join(fake.dir, "turn-params.jsonl");
  const threadParamFile = join(fake.dir, "thread-params.json");
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 500, runTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "normal", PARAM_FILE: paramFile, THREAD_PARAM_FILE: threadParamFile }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "FIRST" });
    await run.send("FOLLOW", "followUp");
    const deadline = Date.now() + 1_000;
    while (events.filter((event) => event.type === "completed").length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(terminal(events), { type: "completed", output: "SECOND" });
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
