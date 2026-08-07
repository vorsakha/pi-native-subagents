import test from "node:test";
import assert from "node:assert/strict";
import { delay, tempDir } from "./helpers.ts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeBackend } from "../src/backends/claude.ts";
import { PiRpcBackend } from "../src/backends/pi-rpc.ts";
import { CodexAppServerBackend } from "../src/backends/codex.ts";
import { MAX_OUTPUT_BYTES } from "../src/reducer.ts";
import type { BackendEvent, HarnessName, BackendRequest } from "../src/types.ts";

const PI_FIXTURE = `#!/usr/bin/env node
import fs from "node:fs";
if (process.env.ARG_FILE) fs.writeFileSync(process.env.ARG_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.ENV_FILE) fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({
  openai: process.env.OPENAI_API_KEY,
  codex: process.env.CODEX_API_KEY,
  ...(process.env.PI_NATIVE_SUBAGENTS_PARENT_THREAD_FILE ? { parentThread: JSON.parse(fs.readFileSync(process.env.PI_NATIVE_SUBAGENTS_PARENT_THREAD_FILE, "utf8")) } : {}),
}));
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
    if (value.id) {
      let data;
      if (value.type === "get_state") data = { model: { provider: "fixture", id: "fixture-model" } };
      if (value.type === "get_available_models") data = { models: process.env.MODE === "unauthenticated" ? [] : [{ provider: "fixture", id: "fixture-model" }] };
      if (value.type === "get_commands") data = { commands: [{ name: "review", source: "skill" }] };
      process.stdout.write(JSON.stringify({ type: "response", id: value.id, command: value.type, success: true, data }) + "\\n");
    }
    if (value.type === "prompt" && process.env.MODE === "complete") complete(value.message.startsWith("Task:") ? "PI_OK" : value.message);
    if (value.type === "prompt" && process.env.MODE === "activity") {
      for (const delay of [80, 160, 240]) setTimeout(() => process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "." } }) + "\\n"), delay);
      setTimeout(() => complete("ACTIVE"), 320);
    }
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
    if (value.id === "server-tool-1" && !value.method) {
      if (process.env.TOOL_RESULT_FILE) fs.writeFileSync(process.env.TOOL_RESULT_FILE, JSON.stringify(value.result));
      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "CONTEXT_OK" } } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }) + "\\n");
    }
    else if (value.method === "initialize") {
      if (process.env.INIT_PARAM_FILE) fs.writeFileSync(process.env.INIT_PARAM_FILE, JSON.stringify(value.params));
      reply(value.id, {});
    }
    else if (value.method === "account/read") reply(value.id, { account: { type: "chatgpt" } });
    else if (value.method === "thread/start") {
      if (process.env.THREAD_PARAM_FILE) fs.writeFileSync(process.env.THREAD_PARAM_FILE, JSON.stringify(value.params));
      reply(value.id, { modelProvider: "openai", thread: { id: "thread-1", modelProvider: process.env.THREAD_PROVIDER || "openai" } });
    }
    else if (value.method === "turn/start") {
      if (process.env.PARAM_FILE) fs.appendFileSync(process.env.PARAM_FILE, JSON.stringify(value.params) + "\\n");
      const number = ++turns; const id = "turn-" + number;
      reply(value.id, { turn: { id } });
      if (process.env.MODE === "usage") {
        const params = { tokenUsage: {
          total: { inputTokens: 104685, outputTokens: 106, cachedInputTokens: 102144, cacheWriteInputTokens: 0 },
          last: { inputTokens: 104685, outputTokens: 106, cachedInputTokens: 102144, totalTokens: 104791 },
          modelContextWindow: 258400,
        } };
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params }) + "\\n");
      }
      if (process.env.MODE === "dynamic-tool") {
        process.stdout.write(JSON.stringify({ id: "server-tool-1", method: "item/tool/call", params: { threadId: "thread-1", turnId: id, callId: "call-1", tool: "parent_thread_context", arguments: { query: "decision" } } }) + "\\n");
      }
      if (process.env.MODE === "activity") {
        for (const delay of [80, 160, 240]) setTimeout(() => process.stdout.write(JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { delta: "." } }) + "\\n"), delay);
      }
      if (process.env.MODE !== "silent" && process.env.MODE !== "dynamic-tool") setTimeout(() => {
        process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: number === 1 ? "FIRST" : "SECOND" } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id, status: "completed" } } }) + "\\n");
      }, process.env.MODE === "activity" ? 320 : 40);
    } else if (value.method === "turn/steer") reply(value.id, { turnId: "turn-1" });
    else reply(value.id, {});
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
setInterval(() => {}, 1000);
`;

async function fixture(source: string): Promise<{ dir: string; command: string }> {
  const dir = await tempDir("native-subagents-backend");
  const command = join(dir, "fixture.mjs");
  await writeFile(command, source);
  await chmod(command, 0o755);
  return { dir, command };
}

function request(harness: HarnessName, cwd: string, env: NodeJS.ProcessEnv): BackendRequest {
  return {
    jobId: `job-${harness}`, name: "worker", task: "fixture task", systemPrompt: "fixture system", cwd, env,
    signal: new AbortController().signal,
    policy: {
      harness, access: "readOnly", customization: "isolated", model: "fixture-model", thinking: "low",
      piTools: [], claudeTools: [], approvalPolicy: "never",
      codexSandbox: { type: "readOnly", networkAccess: false },
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

test("Codex usage separates cached input, ignores duplicate totals, and reports current context", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "usage" }), (event) => events.push(event));
    await run.completed;
    const usage = events.filter((event): event is Extract<BackendEvent, { type: "usage" }> => event.type === "usage")
      .reduce((total, event) => ({
        input: total.input + (event.usage.input ?? 0),
        output: total.output + (event.usage.output ?? 0),
        cacheRead: total.cacheRead + (event.usage.cacheRead ?? 0),
      }), { input: 0, output: 0, cacheRead: 0 });
    assert.deepEqual(usage, { input: 2_541, output: 106, cacheRead: 102_144 });
    assert.deepEqual(events.filter((event): event is Extract<BackendEvent, { type: "context" }> => event.type === "context").at(-1)?.context, {
      tokens: 104_791, window: 258_400, servingModel: "fixture-model",
    });
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("native harness watchdogs allow active turns beyond one inactivity window", async (t) => {
  await t.test("pi", async () => {
    const fake = await fixture(PI_FIXTURE);
    const events: BackendEvent[] = [];
    try {
      const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 250 })
        .start(request("pi", fake.dir, { ...process.env, MODE: "activity" }), (event) => events.push(event));
      await run.completed;
      assert.deepEqual(terminal(events), { type: "completed", output: "ACTIVE" });
      await run.close();
    } finally { await rm(fake.dir, { recursive: true, force: true }); }
  });

  await t.test("claude", async () => {
    async function* messages() {
      yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "active-claude", tools: [] };
      for (let index = 0; index < 3; index++) {
        await delay(80);
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "." } } };
      }
      await delay(40);
      yield { type: "result", subtype: "success", result: "ACTIVE", usage: {}, total_cost_usd: 0, num_turns: 1 };
    }
    const stream = Object.assign(messages(), { close() {} });
    const events: BackendEvent[] = [];
    const run = await new ClaudeBackend("fixture-claude", {
      verifyAuth: async () => undefined,
      queryFn: (() => stream) as never,
      inactivityTimeoutMs: 250,
    }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "ACTIVE" });
    await run.close();
  });

  await t.test("codex", async () => {
    const fake = await fixture(CODEX_FIXTURE);
    const events: BackendEvent[] = [];
    try {
      const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 250 })
        .start(request("codex", fake.dir, { ...process.env, MODE: "activity" }), (event) => events.push(event));
      await run.completed;
      assert.deepEqual(terminal(events), { type: "completed", output: "FIRST" });
      await run.close();
    } finally { await rm(fake.dir, { recursive: true, force: true }); }
  });
});

test("silent native turns fail through the inactivity watchdog", async (t) => {
  await t.test("pi", async () => {
    const fake = await fixture(PI_FIXTURE);
    const events: BackendEvent[] = [];
    try {
      const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 60 })
        .start(request("pi", fake.dir, { ...process.env, MODE: "silent" }), (event) => events.push(event));
      await run.completed;
      assert.match((terminal(events) as Extract<BackendEvent, { type: "failed" }>).error, /no activity for 60ms/);
      await run.close();
    } finally { await rm(fake.dir, { recursive: true, force: true }); }
  });

  await t.test("codex", async () => {
    const fake = await fixture(CODEX_FIXTURE);
    const events: BackendEvent[] = [];
    try {
      const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 60 })
        .start(request("codex", fake.dir, { ...process.env, MODE: "silent" }), (event) => events.push(event));
      await run.completed;
      assert.match((terminal(events) as Extract<BackendEvent, { type: "failed" }>).error, /no activity for 60ms/);
      await run.close();
    } finally { await rm(fake.dir, { recursive: true, force: true }); }
  });
});

test("Pi RPC keeps a persistent native session and reopens a completed turn", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "args.json");
  const envFile = join(fake.dir, "env.json");
  const events: BackendEvent[] = [];
  try {
    const backend = new PiRpcBackend(fake.command, { requestTimeoutMs: 20_000, inactivityTimeoutMs: 20_000 });
    const piRequest = request("pi", fake.dir, {
      ...process.env, MODE: "complete", ARG_FILE: argFile, ENV_FILE: envFile,
      OPENAI_API_KEY: "pi-provider-key", CODEX_API_KEY: "pi-provider-token",
    });
    delete piRequest.policy.model;
    const run = await backend.start(piRequest, (event) => events.push(event));
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
    assert.equal(args.includes("--model"), false, "Pi uses its native default when no model is requested");
    assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {
      openai: "pi-provider-key",
      codex: "pi-provider-token",
    }, "Pi inherits provider configuration instead of applying a native-harness subscription policy");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi RPC loads only the targeted parent-thread extension alongside the read-only tool set", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "parent-args.json");
  const envFile = join(fake.dir, "parent-env.json");
  const events: BackendEvent[] = [];
  try {
    const piRequest = request("pi", fake.dir, { ...process.env, MODE: "complete", ARG_FILE: argFile, ENV_FILE: envFile });
    piRequest.policy.piTools = ["read", "parent_thread_context"];
    piRequest.parentThread = {
      capturedAt: 1_000,
      totalMessages: 1,
      truncated: false,
      messages: [{ role: "assistant", text: "Use a pull-based tool." }],
    };
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 20_000, inactivityTimeoutMs: 20_000 })
      .start(piRequest, (event) => events.push(event));
    await run.completed;
    const args = JSON.parse(await readFile(argFile, "utf8")) as string[];
    assert.equal(args.includes("--no-extensions"), true, "normal extension discovery remains disabled in read-only mode");
    assert.equal(args.includes("--extension"), true, "the narrow child extension is loaded explicitly");
    assert.equal(args[args.indexOf("--tools") + 1], "read,parent_thread_context");
    const childEnv = JSON.parse(await readFile(envFile, "utf8"));
    assert.equal(childEnv.parentThread.messages[0].text, "Use a pull-based tool.");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi RPC resumes a forked session and sends a peer question verbatim", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "peer-args.json");
  const events: BackendEvent[] = [];
  try {
    const peerRequest = request("pi", fake.dir, { ...process.env, MODE: "complete", ARG_FILE: argFile });
    peerRequest.resumeSessionFile = "/sessions/forked-peer.jsonl";
    peerRequest.rawInitialMessage = true;
    peerRequest.task = "What decision did this thread reach?";
    peerRequest.policy.piTools = [];
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 20_000, inactivityTimeoutMs: 20_000 })
      .start(peerRequest, (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: peerRequest.task });
    const args = JSON.parse(await readFile(argFile, "utf8")) as string[];
    assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", peerRequest.resumeSessionFile]);
    assert.ok(args.includes("--no-tools"), "clarification peers start without child tools");
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
        const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 20_000, inactivityTimeoutMs: 20_000 })
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

test("Pi capability discovery marks an unavailable selected model before auto routing", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "probe-args.json");
  try {
    const result = await new PiRpcBackend(fake.command, { requestTimeoutMs: 2_000 }).discover({
      cwd: fake.dir,
      access: "readOnly",
      customization: "native",
      model: "fixture/fixture-model",
      env: { ...process.env, MODE: "unauthenticated", ARG_FILE: argFile },
      signal: new AbortController().signal,
      refresh: true,
    });
    assert.equal(result.sources.find((source) => source.source === "pi-model")?.health, "unavailable");
    assert.match(result.warnings?.[0] ?? "", /selected model fixture\/fixture-model is not available/);
    const args = JSON.parse(await readFile(argFile, "utf8")) as string[];
    assert.equal(args[args.indexOf("--model") + 1], "fixture/fixture-model");
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Claude capability discovery performs auth preflight before opening an SDK session", async () => {
  let queried = false;
  const backend = new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => { throw new Error("authentication_failed"); },
    queryFn: (() => { queried = true; throw new Error("query must not run after auth failure"); }) as never,
  });
  await assert.rejects(
    backend.discover({
      cwd: process.cwd(),
      access: "readOnly",
      customization: "native",
      env: process.env,
      signal: new AbortController().signal,
      refresh: true,
    }),
    /authentication_failed/,
  );
  assert.equal(queried, false, "auth failure is reported before SDK capability discovery");
});

test("Claude emits live events and reopens a completed subscription session", async () => {
  const huge = "x".repeat(MAX_OUTPUT_BYTES);
  let capturedOptions: Record<string, unknown> | undefined;
  let verifiedEnv: NodeJS.ProcessEnv | undefined;
  let releaseSecond!: () => void;
  const secondTurn = new Promise<void>((resolve) => { releaseSecond = resolve; });
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: ["mcp__parent_thread__parent_thread_context"] };
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
    inactivityTimeoutMs: 2_000,
  });
  const claudeRequest = request("claude", process.cwd(), {
    ...process.env,
    KEEP_GENERIC: "yes",
    ANTHROPIC_BASE_URL: "https://gateway.invalid",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_ACCESS_KEY_ID: "must-not-leak",
  });
  delete claudeRequest.policy.model;
  claudeRequest.parentThread = {
    capturedAt: 1_000,
    totalMessages: 1,
    truncated: false,
    messages: [{ role: "user", text: "parent context" }],
  };
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
  assert.equal(capturedOptions?.model, undefined, "Claude uses its native default when no model is requested");
  assert.equal(capturedOptions?.effort, undefined, "Claude effort is provider-adaptive unless explicitly requested");
  assert.ok((capturedOptions?.allowedTools as string[]).includes("mcp__parent_thread__parent_thread_context"));
  assert.ok((capturedOptions?.mcpServers as Record<string, unknown>).parent_thread, "Claude receives the in-process parent-thread MCP server");
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
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const event = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(event.type, "failed");
  assert.match(event.error, /read-only initialization exposed (?:mutating|forbidden) tools: Write/);
  await run.close();
});

test("Codex reuses its native thread for queued and post-settlement follow-ups", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  const paramFile = join(fake.dir, "turn-params.jsonl");
  const threadParamFile = join(fake.dir, "thread-params.json");
  try {
    const codexRequest = request("codex", fake.dir, { ...process.env, MODE: "normal", PARAM_FILE: paramFile, THREAD_PARAM_FILE: threadParamFile });
    delete codexRequest.policy.model;
    codexRequest.policy.effort = "high";
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 5_000 })
      .start(codexRequest, (event) => events.push(event));
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
    const threadParams = JSON.parse(await readFile(threadParamFile, "utf8"));
    assert.equal(threadParams.modelProvider, "openai");
    assert.equal(threadParams.model, undefined, "Codex uses its native default when no model is requested");
    for (const params of turns) {
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.cwd, fake.dir);
      assert.equal(params.effort, "high", "explicit Codex effort is forwarded");
    }
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex exposes parent_thread_context as a client-hosted dynamic tool", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const threadParamFile = join(fake.dir, "thread-params.json");
  const initParamFile = join(fake.dir, "init-params.json");
  const toolResultFile = join(fake.dir, "tool-result.json");
  const events: BackendEvent[] = [];
  try {
    const codexRequest = request("codex", fake.dir, {
      ...process.env,
      MODE: "dynamic-tool",
      THREAD_PARAM_FILE: threadParamFile,
      INIT_PARAM_FILE: initParamFile,
      TOOL_RESULT_FILE: toolResultFile,
    });
    codexRequest.parentThread = {
      capturedAt: 1_000,
      totalMessages: 1,
      truncated: false,
      messages: [{ role: "assistant", text: "The decision was pull-based access." }],
    };
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 5_000 })
      .start(codexRequest, (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "CONTEXT_OK" });
    const initParams = JSON.parse(await readFile(initParamFile, "utf8"));
    assert.equal(initParams.capabilities.experimentalApi, true);
    const threadParams = JSON.parse(await readFile(threadParamFile, "utf8"));
    assert.equal(threadParams.dynamicTools[0].name, "parent_thread_context");
    const toolResult = JSON.parse(await readFile(toolResultFile, "utf8"));
    assert.equal(toolResult.success, true);
    assert.match(toolResult.contentItems[0].text, /pull-based access/);
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex startup timeout and early exit both settle clearly", async (t) => {
  for (const mode of ["hang", "exit"] as const) {
    await t.test(mode, async () => {
      const fake = await fixture(CODEX_FIXTURE);
      const events: BackendEvent[] = [];
      try {
        const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: mode === "hang" ? 250 : 5_000, inactivityTimeoutMs: 6_000 })
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
