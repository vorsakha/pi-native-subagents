import test from "node:test";
import assert from "node:assert/strict";
import { delay, GatedManagedProcess, tempDir } from "./helpers.ts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeBackend, CLAUDE_SUBAGENT_ASK_TOOL, forbiddenInitTools } from "../src/backends/claude.ts";
import { PiRpcBackend } from "../src/backends/pi-rpc.ts";
import { CodexAppServerBackend, classifyCodexUnavailability, codexExitDiagnostic, normalizeCodexSpeed } from "../src/backends/codex.ts";
import { MAX_OUTPUT_BYTES } from "../src/reducer.ts";
import type { BackendEvent, BackendRun, HarnessName, BackendRequest } from "../src/types.ts";
import {
  SUBAGENT_ASK_TOOL_NAME,
  type InteractionAskInput,
  type InteractionHandler,
} from "../src/interactions.ts";
import { askThroughInteractionBridge, openInteractionBridge } from "../src/interaction-bridge.ts";

const PI_FIXTURE = `#!/usr/bin/env node
import fs from "node:fs";
if (process.env.ARG_FILE) fs.writeFileSync(process.env.ARG_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.ENV_FILE) fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({
  openai: process.env.OPENAI_API_KEY,
  codex: process.env.CODEX_API_KEY,
  ...(process.env.PI_NATIVE_SUBAGENTS_PARENT_THREAD_FILE ? { parentThread: JSON.parse(fs.readFileSync(process.env.PI_NATIVE_SUBAGENTS_PARENT_THREAD_FILE, "utf8")) } : {}),
  ask: {
    address: process.env.PI_NATIVE_SUBAGENTS_INTERACTION_ADDRESS ?? null,
    token: process.env.PI_NATIVE_SUBAGENTS_INTERACTION_TOKEN ?? null,
    targets: process.env.PI_NATIVE_SUBAGENTS_INTERACTION_TARGETS ?? null,
  },
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
    if (value.type === "prompt" && process.env.MODE === "tool-events") {
      process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/index.ts" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "source" }], details: { lineCount: 1 } }, isError: false }) + "\\n");
      complete("PI_TOOL_OK");
    }
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
    if (value.type === "prompt" && process.env.MODE === "serving-model") {
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "MODEL_OK" }], usage: { totalTokens: 4242 }, stopReason: "stop", model: "pi-requested-alias", responseModel: "pi-served-model" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
    if (value.type === "prompt" && process.env.MODE === "alias-only") {
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ALIAS_OK" }], usage: { totalTokens: 4242 }, stopReason: "stop", model: "pi-requested-alias" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
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
import { spawn } from "node:child_process";
let buffer = "";
let turns = 0;
process.stdin.setEncoding("utf8");
if (process.env.MODE === "exit") process.exit(7);
if (process.env.DESCENDANT_PID_FILE) {
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(descendant.pid));
}
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
      reply(value.id, { modelProvider: "openai", ...(process.env.THREAD_MODEL ? { model: process.env.THREAD_MODEL } : {}), ...(process.env.THREAD_SERVICE_TIER ? { serviceTier: process.env.THREAD_SERVICE_TIER } : {}), thread: { id: "thread-1", modelProvider: process.env.THREAD_PROVIDER || "openai" } });
    }
    else if (value.method === "turn/start") {
      if (process.env.PARAM_FILE) fs.appendFileSync(process.env.PARAM_FILE, JSON.stringify(value.params) + "\\n");
      if (process.env.STDERR_TEXT) process.stderr.write(process.env.STDERR_TEXT);
      if (process.env.MODE === "exit-turn-start-pending") process.exit(0);
      if (process.env.MODE === "reject-priority") {
        process.stdout.write(JSON.stringify({ id: value.id, error: { code: -32602, message: "priority service tier is unavailable for this model" } }) + "\\n");
        return;
      }
      const number = ++turns; const id = "turn-" + number;
      reply(value.id, { turn: { id } });
      if (process.env.SETTINGS_TIER) process.stdout.write(JSON.stringify({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: { serviceTier: process.env.SETTINGS_TIER } } }) + "\\n");
      if (process.env.MODE === "large-item" || process.env.MODE === "oversized") {
        // Unsolicited notification, not a response to any pending request.
        process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: {
          id: "command-1", type: "commandExecution", command: "big", aggregatedOutput: "x".repeat(1_100_000), status: "completed",
        } } }) + "\\n");
      }
      if (process.env.MODE === "usage") {
        const params = { threadId: "thread-1", turnId: id, tokenUsage: {
          total: { inputTokens: 104685, outputTokens: 106, cachedInputTokens: 102144, cacheWriteInputTokens: 0 },
          last: { inputTokens: 104685, outputTokens: 106, cachedInputTokens: 102144, totalTokens: 104791 },
          modelContextWindow: 258400,
        } };
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params }) + "\\n");
      }
      if (process.env.MODE === "latest-turn") {
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: id, tokenUsage: {
          total: { inputTokens: 900000, outputTokens: 50000, cachedInputTokens: 800000 },
          last: { totalTokens: 12345 },
          modelContextWindow: 200000,
        } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: id, tokenUsage: {
          total: { inputTokens: 950000, outputTokens: 51000 },
          modelContextWindow: 200000,
        } } }) + "\\n");
      }
      if (process.env.MODE === "reroute") {
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: id, tokenUsage: {
          total: { inputTokens: 1000, outputTokens: 10 },
          last: { totalTokens: 1010 },
          modelContextWindow: 200000,
        } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "model/rerouted", params: { threadId: "thread-1", turnId: id, fromModel: process.env.THREAD_MODEL, toModel: "gpt-5.6-codex-mini", reason: "fixture" } }) + "\\n");
      }
      if (process.env.MODE === "stale-scope") {
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-other", tokenUsage: {
          total: { inputTokens: 1, outputTokens: 1 },
          last: { totalTokens: 999999 },
          modelContextWindow: 999999,
        } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-other", turnId: id, tokenUsage: {
          total: { inputTokens: 1, outputTokens: 1 },
          last: { totalTokens: 888888 },
          modelContextWindow: 888888,
        } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-other", fromModel: "a", toModel: "stale-model", reason: "fixture" } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: id, tokenUsage: {
          total: { inputTokens: 10, outputTokens: 5 },
          last: { totalTokens: 4242 },
          modelContextWindow: 100000,
        } } }) + "\\n");
      }
      if (process.env.MODE === "retained-generation") {
        if (number === 1) {
          process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: id, tokenUsage: {
            total: { inputTokens: 1000, outputTokens: 10 },
            last: { totalTokens: 1010 },
            modelContextWindow: 200000,
          } } }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ method: "model/rerouted", params: { threadId: "thread-1", turnId: id, fromModel: "a", toModel: "gen-2-model", reason: "fixture" } }) + "\\n");
        }
      }
      if (process.env.MODE === "dynamic-tool") {
        process.stdout.write(JSON.stringify({ id: "server-tool-1", method: "item/tool/call", params: { threadId: "thread-1", turnId: id, callId: "call-1", tool: "parent_thread_context", arguments: { query: "decision" } } }) + "\\n");
      }
      if (process.env.MODE === "ask-tool") {
        process.stdout.write(JSON.stringify({ id: "server-tool-1", method: "item/tool/call", params: { threadId: "thread-1", turnId: id, callId: "call-1", tool: process.env.ASK_TOOL_NAME, arguments: JSON.parse(process.env.ASK_TOOL_ARGS) } }) + "\\n");
      }
      if (process.env.MODE === "activity") {
        for (const delay of [80, 160, 240]) setTimeout(() => process.stdout.write(JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { delta: "." } }) + "\\n"), delay);
      }
      if (process.env.MODE === "exit-mid-turn") {
        process.stdout.write(JSON.stringify({ method: "item/started", params: { item: {
          id: "dynamic-1", type: "dynamicToolCall", tool: "fixture_tool", arguments: { value: "fixture" },
        } } }) + "\\n");
        setTimeout(() => process.exit(0), 30);
      }
      if (process.env.MODE === "quota-progress") {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "PARTIAL" } } }) + "\\n");
          process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: {
            id, status: "failed", error: { code: "usage_limit_reached", resetsAt: new Date(Date.now() + 60000).toISOString() },
          } } }) + "\\n");
        }, 20);
      }
      if (process.env.MODE !== "silent" && process.env.MODE !== "dynamic-tool" && process.env.MODE !== "ask-tool" && process.env.MODE !== "exit-mid-turn" && process.env.MODE !== "quota-progress") setTimeout(() => {
        if (process.env.MODE === "tool-events") {
          process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "command-1", type: "commandExecution", command: "pwd" } } }) + "\\n");
          process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", command: "pwd", aggregatedOutput: "/tmp", status: "completed" } } }) + "\\n");
        }
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

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function request(harness: HarnessName, cwd: string, env: NodeJS.ProcessEnv): BackendRequest {
  return {
    jobId: `job-${harness}`, name: "worker", task: "fixture task", systemPrompt: "fixture system", cwd, env,
    signal: new AbortController().signal,
    policy: {
      harness, access: "readOnly", customization: "isolated", model: "fixture-model", thinking: "low",
      speed: "standard",
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

function contextEvents(events: BackendEvent[]): Array<Extract<BackendEvent, { type: "context" }>> {
  return events.filter((event): event is Extract<BackendEvent, { type: "context" }> => event.type === "context");
}

test("Codex usage separates cached input and never substitutes the configured model for an unreported serving model", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  let run: BackendRun | undefined;
  try {
    const codexRequest = request("codex", fake.dir, { ...process.env, MODE: "usage" });
    assert.equal(codexRequest.policy.model, "fixture-model");
    run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(codexRequest, (event) => events.push(event));
    await run.completed;
    const usage = events.filter((event): event is Extract<BackendEvent, { type: "usage" }> => event.type === "usage")
      .reduce((total, event) => ({
        input: total.input + (event.usage.input ?? 0),
        output: total.output + (event.usage.output ?? 0),
        cacheRead: total.cacheRead + (event.usage.cacheRead ?? 0),
      }), { input: 0, output: 0, cacheRead: 0 });
    assert.deepEqual(usage, { input: 2_541, output: 106, cacheRead: 102_144 });
    assert.deepEqual(contextEvents(events).at(-1)?.context, { tokens: 104_791, window: 258_400 });
    assert.equal(codexRequest.policy.model, "fixture-model", "the configured job model is never rewritten");
  } finally {
    await run?.close();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Codex leaves the effective serving model unknown when thread/start reports a model but no reroute ever arrives", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  let run: BackendRun | undefined;
  try {
    run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "usage", THREAD_MODEL: "gpt-5.6-codex" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(
      contextEvents(events).at(-1)?.context,
      { tokens: 104_791, window: 258_400 },
      "thread/start's model field is configured/resolved routing state, not authoritative serving telemetry, and must never populate servingModel",
    );
  } finally {
    await run?.close();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Codex context occupancy uses the latest-turn gauge, never thread-cumulative totals, and stays unknown without a last reading", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  let run: BackendRun | undefined;
  try {
    run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "latest-turn" }), (event) => events.push(event));
    await run.completed;
    const contexts = contextEvents(events);
    assert.deepEqual(contexts[0]?.context, { tokens: 12_345, window: 200_000 }, "occupancy reads the latest-turn gauge, not the thread-cumulative total");
    assert.deepEqual(contexts[1]?.context, { window: 200_000 }, "tokens stay unknown, not zero, when a reading omits the latest-turn gauge");
  } finally {
    await run?.close();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Codex model/rerouted updates the effective serving model and preserves the last occupancy reading", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  let run: BackendRun | undefined;
  try {
    run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "reroute", THREAD_MODEL: "gpt-5.6-codex" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(contextEvents(events).at(-1)?.context, { tokens: 1_010, window: 200_000, servingModel: "gpt-5.6-codex-mini" });
  } finally {
    await run?.close();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Codex clears its private occupancy cache at a retained follow-up's generation boundary instead of re-emitting the prior generation's gauge", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  let run: BackendRun | undefined;
  try {
    run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "retained-generation" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(contextEvents(events).at(-1)?.context, { tokens: 1_010, window: 200_000 }, "generation one's own telemetry reports occupancy");
    await run.send("FOLLOW", "followUp");
    const deadline = Date.now() + 1_000;
    while (events.filter((event) => event.type === "completed").length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      contextEvents(events).at(-1)?.context,
      { servingModel: "gen-2-model" },
      "the retained generation's own turn only reports a reroute, never a fresh occupancy reading; the prior generation's lastOccupancy cache must not be re-emitted alongside it",
    );
  } finally {
    await run?.close();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Codex ignores thread-scoped telemetry whose threadId or turnId does not match the current turn", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  let run: BackendRun | undefined;
  try {
    run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "stale-scope" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(contextEvents(events).at(-1)?.context, { tokens: 4_242, window: 100_000 }, "only telemetry scoped to this job's current threadId/turnId is accepted");
  } finally {
    await run?.close();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Codex normalizes a valid 1.1 MB tool-result notification with no pending request instead of masquerading as an app-server exit", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "large-item" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "FIRST" });
    const toolEnd = events.find((event): event is Extract<BackendEvent, { type: "tool_end" }> => event.type === "tool_end" && event.id === "command-1");
    assert.ok(toolEnd, "the large notification still produces a tool_end event");
    const text = toolEnd?.result?.content[0]?.text ?? "";
    assert.ok(text.length > 0 && text.length <= 4_096, "normalized output stays within the bounded transcript limit");
    assert.ok(!events.some((event) => event.type === "failed"), "a valid large notification must not fail the run");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex reports the framing cause, not an unexplained app-server exit, for a genuinely oversized frame", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000, maxFrameBytes: 4_096 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "oversized" }), (event) => events.push(event));
    await run.completed;
    const event = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
    assert.equal(event.type, "failed");
    assert.match(event.error, /JSONL frame exceeds/);
    assert.doesNotMatch(event.error, /exited \(/);
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex preserves command arguments and results for Pi tool rendering", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("codex", fake.dir, { ...process.env, MODE: "tool-events" }), (event) => events.push(event));
    await run.completed;
    assert.ok(events.some((event) => event.type === "tool_start"
      && event.id === "command-1"
      && event.name === "bash"
      && event.args?.command === "pwd"));
    assert.ok(events.some((event) => event.type === "tool_end"
      && event.id === "command-1"
      && event.result?.content[0]?.text === "/tmp"
      && event.result.isError === false));
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
      ask: { address: null, token: null, targets: null },
    }, "Pi inherits provider configuration instead of applying a native-harness subscription policy");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi RPC preserves native tool arguments, content, and details", async () => {
  const fake = await fixture(PI_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 20_000, inactivityTimeoutMs: 20_000 })
      .start(request("pi", fake.dir, { ...process.env, MODE: "tool-events" }), (event) => events.push(event));
    await run.completed;
    assert.ok(events.some((event) => event.type === "tool_start"
      && event.id === "read-1"
      && event.args?.path === "src/index.ts"));
    assert.ok(events.some((event) => event.type === "tool_end"
      && event.id === "read-1"
      && event.result?.content[0]?.text === "source"
      && (event.result.details as { lineCount?: number } | undefined)?.lineCount === 1));
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
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { path: "src/index.ts" } }] } };
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "source text" }], is_error: false }] } };
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
  assert.ok(events.some((event) => event.type === "tool_start" && event.id === "read-1" && event.args?.path === "src/index.ts"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.id === "read-1" && event.result?.content[0]?.text === "source text"));
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

test("Claude reports the effective serving model and per-turn occupancy from init, assistant, and result frames", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [], model: "claude-init-model" };
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        model: "claude-turn-model",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      },
    };
    yield {
      type: "result", subtype: "success", result: "done", usage: {}, total_cost_usd: 0, num_turns: 1,
      modelUsage: { "claude-turn-model": { contextWindow: 200_000 } },
    };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const claudeRequest = request("claude", process.cwd(), process.env);
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(claudeRequest, (event) => events.push(event));
  await run.completed;
  const contexts = contextEvents(events);
  assert.deepEqual(contexts[0]?.context, { servingModel: "claude-init-model" }, "init reports the effective model before any turn");
  assert.deepEqual(contexts.at(-1)?.context, { servingModel: "claude-turn-model", tokens: 750, window: 200_000 });
  assert.equal(claudeRequest.policy.model, "fixture-model", "the configured job model is never rewritten");
  await run.close();
});

test("Claude prefers the last usage.iterations entry over cumulative top-level usage and the requested model", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield {
      type: "assistant", parent_tool_use_id: null,
      message: {
        model: "claude-requested",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 905_000, cache_read_input_tokens: 800_100, cache_creation_input_tokens: 0,
          iterations: [
            { type: "message", model: "claude-requested", input_tokens: 900_000, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 0, output_tokens: 1_000 },
            { type: "fallback_message", model: "claude-fallback-hop", input_tokens: 5_000, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 },
          ],
        },
      },
    };
    yield { type: "result", subtype: "success", result: "done", usage: {}, total_cost_usd: 0, num_turns: 1, modelUsage: {} };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const contexts = contextEvents(events);
  assert.deepEqual(contexts.at(-1)?.context, { servingModel: "claude-fallback-hop", tokens: 5_100 }, "the last iteration is the true context size and identifies the model that actually served the response");
  await run.close();
});

test("Claude clears the prior generation's occupancy gauge at the start of a retained follow-up instead of carrying it forward as current", async () => {
  let releaseSecond!: () => void;
  const secondTurn = new Promise<void>((resolve) => { releaseSecond = resolve; });
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [], model: "claude-g1" };
    yield { type: "assistant", parent_tool_use_id: null, message: { model: "claude-g1", content: [{ type: "text", text: "first" }], usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    yield { type: "result", subtype: "success", result: "first", usage: {}, total_cost_usd: 0, num_turns: 1, modelUsage: { "claude-g1": { contextWindow: 100_000 } } };
    await secondTurn;
    // The second generation's own turn never reports a fresh usage reading.
    yield { type: "assistant", parent_tool_use_id: null, message: { model: "claude-g1", content: [{ type: "text", text: "second" }] } };
    yield { type: "result", subtype: "success", result: "second", usage: {}, total_cost_usd: 0, num_turns: 1, modelUsage: {} };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  assert.deepEqual(contextEvents(events).at(-1)?.context, { servingModel: "claude-g1", tokens: 500, window: 100_000 });
  await run.send("follow up", "followUp");
  releaseSecond();
  const deadline = Date.now() + 1_000;
  while (events.filter((event) => event.type === "completed").length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(contextEvents(events).at(-1)?.context, { servingModel: "claude-g1" }, "the retained follow-up's unreported occupancy is unknown, not generation one's stale reading");
  await run.close();
});

test("Claude system/model_refusal_fallback updates the effective serving model and clears the refused model's stale occupancy", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [], model: "claude-primary" };
    yield {
      type: "assistant", parent_tool_use_id: null,
      message: { model: "claude-primary", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    };
    yield {
      type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry",
      original_model: "claude-primary", fallback_model: "claude-fallback", request_id: null, content: "",
    };
    yield { type: "result", subtype: "success", result: "done", usage: {}, total_cost_usd: 0, num_turns: 1, modelUsage: {} };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const contexts = contextEvents(events);
  assert.deepEqual(contexts.at(-1)?.context, { servingModel: "claude-fallback" }, "the refused model's occupancy reading never carries over labeled as the fallback model's own");
  await run.close();
});

test("Claude emits no context event when the stream omits model and usage fields", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } };
    yield { type: "result", subtype: "success", result: "done", usage: {}, total_cost_usd: 0, num_turns: 1, modelUsage: {} };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  assert.deepEqual(contextEvents(events), []);
  await run.close();
});

test("Claude wires a requested structuredOutput policy into outputFormat and returns the native payload separate from narrative output", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "here is the result" }] } };
    yield { type: "result", subtype: "success", result: "here is the result", structured_output: { ok: true }, usage: {}, total_cost_usd: 0, num_turns: 1 };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  let capturedOptions: Record<string, unknown> | undefined;
  const claudeRequest = request("claude", process.cwd(), process.env);
  claudeRequest.policy.structuredOutput = { schema: { type: "object", properties: { ok: { type: "boolean" } } } };
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: ((input: { options?: Record<string, unknown> }) => { capturedOptions = input.options; return stream; }) as never,
    inactivityTimeoutMs: 2_000,
  }).start(claudeRequest, (event) => events.push(event));
  await run.completed;
  assert.deepEqual(capturedOptions?.outputFormat, { type: "json_schema", schema: claudeRequest.policy.structuredOutput.schema });
  const final = terminal(events) as Extract<BackendEvent, { type: "completed" }>;
  assert.equal(final.type, "completed");
  assert.equal(final.output, "here is the result");
  assert.deepEqual(final.structured, { ok: true });
  await run.close();
});

test("Claude fails clearly, without accepting narrative text, when a schema-constrained turn reports no native structured result", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "result", subtype: "success", result: `{"ok":true}`, usage: {}, total_cost_usd: 0, num_turns: 1 };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const claudeRequest = request("claude", process.cwd(), process.env);
  claudeRequest.policy.structuredOutput = { schema: { type: "object" } };
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(claudeRequest, (event) => events.push(event));
  await run.completed;
  const final = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(final.type, "failed");
  assert.match(final.error, /reported no native structured result/);
  await run.close();
});

test("Claude maps exhausted native structured-output retries to a clear failure", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield {
      type: "result", subtype: "error_max_structured_output_retries", errors: ["retries exhausted"],
      usage: {}, total_cost_usd: 0, num_turns: 3,
    };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const claudeRequest = request("claude", process.cwd(), process.env);
  claudeRequest.policy.structuredOutput = { schema: { type: "object" } };
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(claudeRequest, (event) => events.push(event));
  await run.completed;
  const final = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(final.type, "failed");
  assert.match(final.error, /exhausted its native structured-output retries/);
  await run.close();
});

test("Claude structured-output support probe reports supported only when the installed CLI accepts the zero-turn json_schema handshake", async () => {
  async function* accepted() {
    // No user message and no result frame: initializationResult() must resolve without one.
  }
  const acceptedStream = Object.assign(accepted(), {
    close() {},
    initializationResult: async () => ({ commands: [], agents: [] }),
  });
  const supported = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => acceptedStream) as never,
  }).structuredOutputSupport({
    cwd: process.cwd(), access: "readOnly", customization: "isolated", env: process.env,
    signal: new AbortController().signal, refresh: true,
  });
  assert.equal(supported.supported, true);
  assert.equal(supported.mechanism, "claude-agent-sdk:outputFormat.json_schema");

  async function* rejected() {}
  const rejectedStream = Object.assign(rejected(), {
    close() {},
    initializationResult: async () => { throw new Error("unrecognized flag --json-schema"); },
  });
  const unsupported = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => rejectedStream) as never,
  }).structuredOutputSupport({
    cwd: process.cwd(), access: "readOnly", customization: "isolated", env: process.env,
    signal: new AbortController().signal, refresh: true,
  });
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.detail ?? "", /unrecognized flag/);

  let queried = false;
  const unauthenticated = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => { throw new Error("authentication_failed"); },
    queryFn: (() => { queried = true; throw new Error("must not query after auth failure"); }) as never,
  }).structuredOutputSupport({
    cwd: process.cwd(), access: "readOnly", customization: "isolated", env: process.env,
    signal: new AbortController().signal, refresh: true,
  });
  assert.equal(unauthenticated.supported, false);
  assert.match(unauthenticated.detail ?? "", /authentication_failed/);
  assert.equal(queried, false);
});

test("Codex and Pi reject a structuredOutput policy instead of silently ignoring it", async () => {
  const codexRequest = request("codex", process.cwd(), process.env);
  codexRequest.policy.structuredOutput = { schema: { type: "object" } };
  await assert.rejects(
    new CodexAppServerBackend("fixture-codex-missing").start(codexRequest, () => {}),
    /does not support native structured results/,
  );

  const piRequest = request("pi", process.cwd(), process.env);
  piRequest.policy.structuredOutput = { schema: { type: "object" } };
  await assert.rejects(
    new PiRpcBackend("fixture-pi-missing").start(piRequest, () => {}),
    /does not support native structured results/,
  );
});

test("Claude classifies an authoritative rate_limit rejection into structured unavailability", async () => {
  const quotaText = "You've hit your session limit · resets 12pm (America/Sao_Paulo)";
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor((Date.now() + 5 * 60_000) / 1000), rateLimitType: "five_hour" },
    };
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: quotaText }], usage: { input_tokens: 0, output_tokens: 0 } },
      error: "rate_limit",
    };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const failed = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(failed.type, "failed");
  assert.ok(failed.unavailable, "an authoritative rate_limit rejection must classify as provider unavailability");
  assert.equal(failed.unavailable?.provider, "claude");
  assert.equal(failed.unavailable?.kind, "quota");
  assert.equal(failed.unavailable?.authoritative, true);
  assert.equal(failed.unavailable?.preInference, true);
  assert.equal(failed.unavailable?.scope, "five_hour");
  assert.ok(failed.unavailable!.retryAt! > Date.now());
  assert.ok(!failed.unavailable?.detail.includes("@"), "detail must never include a raw email address");
  assert.equal(events.some((event) => event.type === "message"), false, "Claude quota boilerplate is refusal metadata, not model output");
  assert.equal(events.some((event) => event.type === "thinking_message"), false);
  assert.equal(events.some((event) => event.type === "tool_start"), false);
  await run.close();
});

test("Claude close waits for native process-tree termination after provider failure", async () => {
  const nativeProcess = new GatedManagedProcess();
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor((Date.now() + 5 * 60_000) / 1000), rateLimitType: "five_hour" },
    };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [] }, error: "rate_limit" };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    processFactory: () => nativeProcess,
    queryFn: ((input: { options?: Record<string, unknown> }) => {
      const spawnProcess = input.options?.spawnClaudeCodeProcess as ((options: {
        command: string;
        args: string[];
        cwd?: string;
        env: NodeJS.ProcessEnv;
        signal: AbortSignal;
      }) => unknown) | undefined;
      assert.ok(spawnProcess, "Claude launch installs the managed process-tree wrapper");
      spawnProcess({
        command: "fixture-claude",
        args: [],
        cwd: process.cwd(),
        env: process.env,
        signal: new AbortController().signal,
      });
      return stream;
    }) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));

  await run.completed;
  assert.equal(terminal(events)?.type, "failed");
  let closed = false;
  const closing = run.close().then(() => { closed = true; });
  await nativeProcess.waitUntilTerminate();
  await delay(0);
  assert.equal(closed, false, "close cannot resolve while the failed Claude process tree still exists");
  nativeProcess.release();
  await closing;
  assert.equal(closed, true);
});

test("Claude accounts terminal quota-frame usage before failure and withholds pre-inference proof", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor((Date.now() + 5 * 60_000) / 1000), rateLimitType: "five_hour" },
    };
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "text", text: "You've hit your session limit · resets 12pm (America/Sao_Paulo)" }],
        usage: {
          input_tokens: 7,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
        },
      },
      error: "rate_limit",
    };
    yield {
      type: "result",
      subtype: "error_during_execution",
      errors: ["quota"],
      usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
      total_cost_usd: 0,
      num_turns: 0,
      modelUsage: {},
    };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;

  assert.deepEqual(events.filter((event) => event.type === "usage"), [{
    type: "usage",
    usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0, turns: 0 },
  }]);
  const failed = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(failed.unavailable?.preInference, undefined);
  assert.ok(events.findIndex((event) => event.type === "usage") < events.findIndex((event) => event.type === "failed"));
  await run.close();
});

test("Claude preserves mixed content on an authoritative rate_limit rejection", async () => {
  const quotaText = "You've hit your session limit · resets 12pm (America/Sao_Paulo)";
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor((Date.now() + 5 * 60_000) / 1000), rateLimitType: "five_hour" },
    };
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: `${quotaText} Please save your work.` },
          { type: "thinking", thinking: "the refusal followed model activity" },
          { type: "tool_use", id: "write-1", name: "Write", input: { path: "out.txt" } },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      error: "rate_limit",
    };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  assert.ok(events.some((event) => event.type === "message" && event.text.includes("Please save your work.")));
  assert.ok(events.some((event) => event.type === "thinking_message" && event.text === "the refusal followed model activity"));
  assert.ok(events.some((event) => event.type === "tool_start" && event.id === "write-1"));
  const failed = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(failed.type, "failed");
  assert.equal(failed.unavailable?.preInference, undefined, "mixed model or tool content disproves a pre-inference refusal");
  await run.close();
});

test("Claude does not classify its own api_retry notice as provider unavailability", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: "overloaded" };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } };
    yield { type: "result", subtype: "success", result: "done", usage: {}, total_cost_usd: 0, num_turns: 1 };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const final = terminal(events) as Extract<BackendEvent, { type: "completed" }>;
  assert.equal(final.type, "completed");
  assert.ok(!events.some((event) => event.type === "failed"));
  await run.close();
});

test("Claude reports a non-authoritative rate_limit rejection when no reset time is available", async () => {
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [] };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [] }, error: "rate_limit" };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: (() => stream) as never,
    inactivityTimeoutMs: 2_000,
  }).start(request("claude", process.cwd(), process.env), (event) => events.push(event));
  await run.completed;
  const failed = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
  assert.equal(failed.unavailable?.authoritative, false);
  assert.equal(failed.unavailable?.retryAt, undefined);
  await run.close();
});

test("Codex classifies a structured usage-limit error only when a plausible reset field is present", () => {
  const now = Date.now();
  const withReset = classifyCodexUnavailability({ code: "usage_limit_reached", message: "quota exhausted", resetsAt: new Date(now + 10 * 60_000).toISOString(), window: "weekly" }, now);
  assert.ok(withReset);
  assert.equal(withReset?.provider, "codex");
  assert.equal(withReset?.authoritative, true);
  assert.equal(withReset?.preInference, true);
  assert.equal(withReset?.scope, undefined, "Codex's error.window has no verified schema and must never reach scope");
  assert.ok(!withReset?.detail.includes("@"));
  const afterProgress = classifyCodexUnavailability({ code: "usage_limit_reached", resetsAt: now + 60_000 }, now, true);
  assert.equal(afterProgress?.preInference, undefined, "current-turn activity makes the same structured rejection eligible for progressed continuation");

  const withoutReset = classifyCodexUnavailability({ code: "usage_limit_reached", message: "quota exhausted" }, now);
  assert.ok(withoutReset, "still classified as a quota rejection, but not authoritative");
  assert.equal(withoutReset?.authoritative, false);
  assert.equal(withoutReset?.retryAt, undefined);

  const unrelated = classifyCodexUnavailability({ code: "invalid_request", message: "bad params" }, now);
  assert.equal(unrelated, undefined, "unrelated Codex errors never classify as provider unavailability");

  const nameCollision = classifyCodexUnavailability({ code: "quota_configuration_error", message: "no quota configured", resetsAt: new Date(now + 60_000).toISOString() }, now);
  assert.equal(nameCollision, undefined, "a quota-named but non-exhaustion error code must never classify as provider unavailability");

  const relativeDelayField = classifyCodexUnavailability({ code: "usage_limit_reached", retryAfter: 120 }, now);
  assert.equal(relativeDelayField?.authoritative, false, "retryAfter is a relative delay by convention and must never be read as an absolute reset time");
});

test("Codex exposes authoritative quota failure as progressed after current-turn assistant activity", async () => {
  const f = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(f.command, { inactivityTimeoutMs: 2_000 }).start(
      request("codex", f.dir, { ...process.env, MODE: "quota-progress" }),
      (event) => events.push(event),
    );
    await run.completed;
    const failed = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
    assert.equal(failed.type, "failed");
    assert.equal(failed.unavailable?.authoritative, true);
    assert.equal(failed.unavailable?.preInference, undefined);
    assert.ok(events.some((event) => event.type === "message" && event.text === "PARTIAL"));
    await run.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("Codex failed-turn close proves its native descendants are gone before resolving", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(CODEX_FIXTURE);
  const descendantFile = join(f.dir, "descendant.pid");
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(f.command, { inactivityTimeoutMs: 2_000 }).start(
      request("codex", f.dir, {
        ...process.env,
        MODE: "quota-progress",
        DESCENDANT_PID_FILE: descendantFile,
      }),
      (event) => events.push(event),
    );
    await run.completed;
    assert.equal(terminal(events)?.type, "failed");
    const descendantPid = Number(await readFile(descendantFile, "utf8"));
    assert.equal(processExists(descendantPid), true, "fixture descendant is alive before close");
    await run.close();
    assert.equal(processExists(descendantPid), false, "close resolves only after the failed process group is absent");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("Codex never copies unverified error.window data into scope, even when oversized or account-bearing", () => {
  const now = Date.now();
  const oversized = classifyCodexUnavailability({ code: "usage_limit_reached", window: "x".repeat(10_000) }, now);
  assert.equal(oversized?.scope, undefined, "an oversized window value must not reach scope");

  const accountBearing = classifyCodexUnavailability({
    code: "usage_limit_reached",
    window: "acct_1a2b3c4d org-secret-billing-id user@example.com",
  }, now);
  assert.equal(accountBearing?.scope, undefined, "account/plan-identifying window text must not reach scope");
  assert.ok(JSON.stringify(accountBearing).length < 300, "classified unavailability must stay bounded regardless of the raw error payload size");
});

test("Codex never copies error.message credentials or identifiers into detail, even when the code is allowlisted", () => {
  const now = Date.now();
  const secretMessage = {
    code: "usage_limit_reached",
    message: "sk-proj-aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV org-4f9a8b7c6d5e Bearer eyJhbGciOiJIUzI1NiJ9.secret acct_9z8y7x6w5v user@example.com",
  };
  const classified = classifyCodexUnavailability(secretMessage, now);
  assert.ok(classified);
  assert.equal(classified?.detail, "Codex reported a usage-limit rejection (usage_limit_reached)", "detail must be the fixed, provider-neutral template, not raw prose");
  assert.ok(!classified?.detail.includes("sk-proj-"), "API keys must never survive classification");
  assert.ok(!classified?.detail.includes("org-4f9a8b7c6d5e"), "organization ids must never survive classification");
  assert.ok(!classified?.detail.includes("Bearer"), "bearer tokens must never survive classification");
  assert.ok(!classified?.detail.includes("acct_9z8y7x6w5v"), "account ids must never survive classification");
  assert.ok(!classified?.detail.includes("@"), "emails must never survive classification");

  const serialized = JSON.stringify(classified);
  assert.ok(!serialized.includes("sk-proj-"), "API keys must never survive serialization");
  assert.ok(!serialized.includes("org-4f9a8b7c6d5e"), "organization ids must never survive serialization");
  assert.ok(!serialized.includes("Bearer"), "bearer tokens must never survive serialization");
  assert.ok(!serialized.includes("acct_9z8y7x6w5v"), "account ids must never survive serialization");
  assert.ok(!serialized.includes("@"), "emails must never survive serialization");

  const usageLimitExceeded = classifyCodexUnavailability({ code: "usage_limit_exceeded", message: "sk-live-topsecretkey12345" }, now);
  assert.equal(usageLimitExceeded?.detail, "Codex reported a usage-limit rejection (usage_limit_exceeded)");
  assert.ok(!usageLimitExceeded?.detail.includes("sk-live-"), "the other allowlisted exhaustion code must also strip raw error.message");
});

test("codexExitDiagnostic distinguishes lifecycle stages instead of always reporting a bare exit code", () => {
  const base = { code: 0, signal: null, threadStarted: false, turnState: "idle" as const, turnOutputLength: 0, toolCallCount: 0 };

  assert.equal(codexExitDiagnostic(base), "Codex app-server exited (0) before starting a Codex thread");

  assert.equal(
    codexExitDiagnostic({ ...base, threadStarted: true }),
    "Codex app-server exited (0) between turns, with no turn in progress",
  );

  assert.equal(
    codexExitDiagnostic({ ...base, threadStarted: true, turnState: "starting" }),
    "Codex app-server exited (0) while turn/start was pending with no terminal result — no tool calls started, no assistant output was delivered",
  );

  assert.equal(
    codexExitDiagnostic({ ...base, threadStarted: true, turnState: "inProgress" }),
    "Codex app-server exited (0) during an in-progress turn with no terminal result — no tool calls started, no assistant output was delivered",
  );

  assert.equal(
    codexExitDiagnostic({ ...base, threadStarted: true, turnState: "inProgress", toolCallCount: 2, turnOutputLength: 40 }),
    "Codex app-server exited (0) during an in-progress turn with no terminal result — 2 tool call(s) started, partial assistant output was streaming",
  );

  const withRequires = codexExitDiagnostic({
    ...base, threadStarted: true, turnState: "inProgress", toolCallCount: 1, requires: ["codex:skill:imagegen"],
  });
  assert.match(withRequires, /\(requires: codex:skill:imagegen\)$/);
  assert.doesNotMatch(withRequires, /unsupported|not supported|unavailable/i, "the diagnostic never diagnoses the required capability as the cause");

  // Signal-only exits (no numeric code) still resolve to a readable label.
  assert.match(codexExitDiagnostic({ ...base, code: null, signal: "SIGKILL" }), /^Codex app-server exited \(SIGKILL\)/);
});

test("codexExitDiagnostic keeps capability context and the complete diagnostic strictly bounded", () => {
  const base = { code: 1, signal: null, threadStarted: true, turnState: "inProgress" as const, turnOutputLength: 0, toolCallCount: 0 };
  const manyRequirements = Array.from({ length: 16 }, (_, index) => `codex:skill:tool-${index}`);
  const withManyRequirements = codexExitDiagnostic({ ...base, requires: manyRequirements });
  const requiresSegment = withManyRequirements.match(/\(requires: (.*)\)$/)?.[1] ?? "";
  assert.equal(requiresSegment.split(", ").length, 4, "at most the first few capability requirements are echoed back, never the full bounded list");
  const withLongRequirements = codexExitDiagnostic({ ...base, requires: Array(16).fill("x".repeat(10_000)) });
  assert.ok(withLongRequirements.length < 900, `defense-in-depth bounds the complete diagnostic (got ${withLongRequirements.length} chars)`);
});

test("Pi reports the concrete responseModel over the requested alias and totalTokens as occupancy", async () => {
  const fake = await fixture(PI_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("pi", fake.dir, { ...process.env, MODE: "serving-model" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "MODEL_OK" });
    const contexts = contextEvents(events);
    assert.deepEqual(contexts, [{ type: "context", context: { servingModel: "pi-served-model", tokens: 4_242 } }], "responseModel is preferred over the requested alias in model, and usage.totalTokens is the occupancy gauge");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi keeps servingModel unknown when only the requested alias is present and responseModel is absent", async () => {
  const fake = await fixture(PI_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("pi", fake.dir, { ...process.env, MODE: "alias-only" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(terminal(events), { type: "completed", output: "ALIAS_OK" });
    const contexts = contextEvents(events);
    assert.deepEqual(contexts, [{ type: "context", context: { tokens: 4_242 } }], "message.model is only the requested alias and must never substitute for an absent responseModel");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Pi emits no context event for an unsupported runtime version that omits model, responseModel, and totalTokens", async () => {
  const fake = await fixture(PI_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const run = await new PiRpcBackend(fake.command, { requestTimeoutMs: 2_000 })
      .start(request("pi", fake.dir, { ...process.env, MODE: "complete" }), (event) => events.push(event));
    await run.completed;
    assert.deepEqual(contextEvents(events), []);
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
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
      assert.equal(params.serviceTier, undefined, "standard policy preserves native Codex tier configuration");
    }
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex sends priority on every fast retained turn and reports native effective speed", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  const paramFile = join(fake.dir, "turn-params.jsonl");
  try {
    const codexRequest = request("codex", fake.dir, {
      ...process.env,
      MODE: "normal",
      PARAM_FILE: paramFile,
      THREAD_SERVICE_TIER: "default",
      SETTINGS_TIER: "priority",
    });
    codexRequest.policy.speed = "fast";
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 5_000 })
      .start(codexRequest, (event) => events.push(event));
    await run.completed;
    await run.send("FOLLOW", "followUp");
    const deadline = Date.now() + 1_000;
    while (events.filter((event) => event.type === "completed").length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const turns = (await readFile(paramFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(turns.map((params) => params.serviceTier), ["priority", "priority"]);
    assert.ok(contextEvents(events).some((event) => event.context.effectiveSpeed === "standard"));
    assert.equal(contextEvents(events).at(-1)?.context.effectiveSpeed, "fast");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex effective speed normalization ignores unknown provider values", () => {
  assert.equal(normalizeCodexSpeed("default"), "standard");
  assert.equal(normalizeCodexSpeed("priority"), "fast");
  assert.equal(normalizeCodexSpeed("fast"), "fast");
  assert.equal(normalizeCodexSpeed("experimental"), undefined);
});

test("Codex surfaces a native priority-policy rejection without retrying or downgrading", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  try {
    const codexRequest = request("codex", fake.dir, { ...process.env, MODE: "reject-priority" });
    codexRequest.policy.speed = "fast";
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 5_000 })
      .start(codexRequest, (event) => events.push(event));
    await run.completed;
    const failed = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /priority service tier is unavailable for this model/);
    assert.equal(contextEvents(events).at(-1)?.context.effectiveSpeed, undefined, "requested Fast is never invented as accepted telemetry");
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

test("Codex reports bounded active-turn context after generic tool activity without claiming a required capability ran (issue #22)", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const events: BackendEvent[] = [];
  const stderrSecrets = [
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "password=hunter2",
    "token=punc!#$%^&*()[]{}",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "contact=user@example.com",
    "opaque_id=req_7F3a-91.Zq",
    "n".repeat(400),
    "fatal: trailing crash reason",
  ];
  try {
    const codexRequest = request("codex", fake.dir, {
      ...process.env,
      MODE: "exit-mid-turn",
      STDERR_TEXT: stderrSecrets.join("\n"),
    });
    codexRequest.policy.requires = ["codex:skill:imagegen"];
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 5_000 })
      .start(codexRequest, (event) => events.push(event));
    await run.completed;
    const event = terminal(events) as Extract<BackendEvent, { type: "failed" }>;
    assert.equal(event.type, "failed");
    // Not just the bare generic exit summary from before this fix.
    assert.notEqual(event.error, "Codex app-server exited (0)");
    assert.match(event.error, /Codex app-server exited \(0\) during an in-progress turn with no terminal result/);
    assert.match(event.error, /1 tool call\(s\) started/);
    assert.match(event.error, /no assistant output was delivered/);
    // The requirement is dispatch context only. The fixture emitted a
    // protocol-realistic generic dynamicToolCall, not a native imagegen call.
    assert.match(event.error, /requires: codex:skill:imagegen/);
    assert.doesNotMatch(event.error, /unsupported|not supported|does not support/i);
    const toolStart = events.find((item): item is Extract<BackendEvent, { type: "tool_start" }> => item.type === "tool_start");
    assert.equal(toolStart?.name, "fixture_tool");
    assert.ok(!events.some((item) => item.type === "completed"), "a clean mid-turn exit must never be reported as completed");

    const serializedEvents = JSON.stringify(events);
    for (const stderrValue of stderrSecrets) {
      assert.ok(!serializedEvents.includes(stderrValue), `provider stderr must be omitted from terminal-event serialization: ${stderrValue.slice(0, 40)}`);
    }
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex settles a close during pending turn/start once with pending-request context", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const turnParamFile = join(fake.dir, "turn-params.jsonl");
  const events: BackendEvent[] = [];
  try {
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 2_000, inactivityTimeoutMs: 5_000 })
      .start(request("codex", fake.dir, {
        ...process.env,
        MODE: "exit-turn-start-pending",
        PARAM_FILE: turnParamFile,
      }), (event) => events.push(event));
    await run.completed;
    await delay(20);

    assert.match(await readFile(turnParamFile, "utf8"), /fixture task/, "the fixture received turn/start before exiting without a reply");
    const terminalEvents = events.filter((event) => event.type === "completed" || event.type === "failed" || event.type === "cancelled");
    assert.deepEqual(terminalEvents, [{
      type: "failed",
      error: "Codex app-server exited (0) while turn/start was pending with no terminal result — no tool calls started, no assistant output was delivered",
    }]);
    assert.doesNotMatch(JSON.stringify(events), /JSON-RPC process exited/, "the rejected turn/start catch cannot override close settlement");
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});


/** Records every routed question a backend adapter forwards through the host callback. */
function recordingInteractions(answer: string | Error = "keep the legacy flag"): InteractionHandler & { calls: InteractionAskInput[] } {
  const calls: InteractionAskInput[] = [];
  return {
    calls,
    async ask(input) {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return { answer, requestId: "req-1", route: "orchestrator-model", answeredBy: "orchestrator" };
    },
  };
}

test("Claude exposes the ask tool as an in-process MCP server only for an authorized job", async () => {
  const interactions = recordingInteractions();
  let capturedOptions: Record<string, unknown> | undefined;
  async function* messages() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [CLAUDE_SUBAGENT_ASK_TOOL] };
    yield { type: "result", subtype: "success", result: "done", usage: {}, total_cost_usd: 0, num_turns: 1 };
  }
  const stream = Object.assign(messages(), { close() {} });
  const events: BackendEvent[] = [];
  const claudeRequest = request("claude", process.cwd(), process.env);
  claudeRequest.interactions = interactions;
  claudeRequest.interactionTargets = ["orchestrator"];
  const run = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: ((input: { options?: Record<string, unknown> }) => { capturedOptions = input.options; return stream; }) as never,
    inactivityTimeoutMs: 2_000,
  }).start(claudeRequest, (event) => events.push(event));
  await run.completed;
  assert.equal(terminal(events)?.type, "completed", "a read-only init advertising the host ask tool is not a policy violation");
  assert.ok((capturedOptions?.allowedTools as string[]).includes(CLAUDE_SUBAGENT_ASK_TOOL));
  assert.ok((capturedOptions?.mcpServers as Record<string, unknown>).subagent_interactions);
  await run.close();

  // Without the host callback the tool is neither served nor tolerated.
  const unauthorized = request("claude", process.cwd(), process.env);
  let unauthorizedOptions: Record<string, unknown> | undefined;
  async function* denied() {
    yield { type: "system", subtype: "init", apiKeySource: "oauth", session_id: "claude-session", tools: [CLAUDE_SUBAGENT_ASK_TOOL] };
  }
  const deniedStream = Object.assign(denied(), { close() {} });
  const deniedEvents: BackendEvent[] = [];
  const deniedRun = await new ClaudeBackend("fixture-claude", {
    verifyAuth: async () => undefined,
    queryFn: ((input: { options?: Record<string, unknown> }) => { unauthorizedOptions = input.options; return deniedStream; }) as never,
    inactivityTimeoutMs: 2_000,
  }).start(unauthorized, (event) => deniedEvents.push(event));
  await deniedRun.completed;
  assert.equal(unauthorizedOptions?.mcpServers, undefined);
  assert.match((terminal(deniedEvents) as { error: string }).error, /exposed forbidden tools/);
  await deniedRun.close();

  assert.deepEqual(forbiddenInitTools([CLAUDE_SUBAGENT_ASK_TOOL, "mcp__user__other"], true, [CLAUDE_SUBAGENT_ASK_TOOL]), ["mcp__user__other"],
    "a granted host tool is the only mcp surface a read-only child may see");
});

test("Codex routes its dynamic ask tool through the host callback and rejects unknown tools", async () => {
  const fake = await fixture(CODEX_FIXTURE);
  const threadParamFile = join(fake.dir, "thread-params.json");
  const toolResultFile = join(fake.dir, "tool-result.json");
  const interactions = recordingInteractions();
  try {
    const codexRequest = request("codex", fake.dir, {
      ...process.env,
      MODE: "ask-tool",
      ASK_TOOL_NAME: SUBAGENT_ASK_TOOL_NAME,
      ASK_TOOL_ARGS: JSON.stringify({ question: "Which flag stays?", target: { type: "orchestrator" } }),
      THREAD_PARAM_FILE: threadParamFile,
      TOOL_RESULT_FILE: toolResultFile,
    });
    codexRequest.interactions = interactions;
    const run = await new CodexAppServerBackend(fake.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 5_000 })
      .start(codexRequest, () => {});
    await run.completed;
    const threadParams = JSON.parse(await readFile(threadParamFile, "utf8"));
    assert.deepEqual(threadParams.dynamicTools.map((tool: { name: string }) => tool.name), [SUBAGENT_ASK_TOOL_NAME]);
    const toolResult = JSON.parse(await readFile(toolResultFile, "utf8"));
    assert.equal(toolResult.success, true);
    assert.equal(toolResult.contentItems[0].text, "keep the legacy flag");
    assert.deepEqual(interactions.calls[0]?.target, { kind: "orchestrator" });
    await run.close();
  } finally { await rm(fake.dir, { recursive: true, force: true }); }

  const denied = await fixture(CODEX_FIXTURE);
  const deniedResultFile = join(denied.dir, "tool-result.json");
  try {
    const codexRequest = request("codex", denied.dir, {
      ...process.env,
      MODE: "ask-tool",
      ASK_TOOL_NAME: "arbitrary_tool",
      ASK_TOOL_ARGS: JSON.stringify({}),
      TOOL_RESULT_FILE: deniedResultFile,
    });
    codexRequest.interactions = recordingInteractions();
    const events: BackendEvent[] = [];
    const run = await new CodexAppServerBackend(denied.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 2_000 })
      .start(codexRequest, (event) => events.push(event));
    await run.cancel("done");
    await run.close();
    assert.equal(await readFile(deniedResultFile, "utf8").catch(() => ""), "", "an unsupported dynamic tool is never answered");
  } finally { await rm(denied.dir, { recursive: true, force: true }); }
});

test("the Pi interaction bridge answers only authenticated, well-formed requests", async () => {
  const interactions = recordingInteractions();
  const bridge = await openInteractionBridge("job-abc", interactions);
  try {
    const answer = await askThroughInteractionBridge({
      address: bridge.address,
      token: bridge.token,
      question: "Which flag stays?",
      context: "tests disagree",
      target: { type: "orchestrator" },
    });
    assert.equal(answer.answer, "keep the legacy flag");
    assert.equal(interactions.calls[0]?.context, "tests disagree");

    await assert.rejects(
      askThroughInteractionBridge({ address: bridge.address, token: "wrong-token", question: "let me in", target: undefined }),
      /Interaction bridge (?:closed before answering|is unavailable)/,
      "an unauthenticated frame is dropped without protocol detail",
    );
    assert.equal(interactions.calls.length, 1, "a rejected frame never reaches the host callback");

    await assert.rejects(
      askThroughInteractionBridge({ address: bridge.address, token: bridge.token, question: "  ", target: undefined }),
      /question must be a non-empty string/,
    );
  } finally {
    await bridge.close();
  }
  await assert.rejects(
    askThroughInteractionBridge({ address: bridge.address, token: bridge.token, question: "after close", target: undefined }),
    /Interaction bridge/,
  );
});

test("Pi loads the interaction child extension and its bridge coordinates only when authorized", async () => {
  const fake = await fixture(PI_FIXTURE);
  const argFile = join(fake.dir, "args.json");
  const events: BackendEvent[] = [];
  const interactions = recordingInteractions();
  let openedFor: string | undefined;
  try {
    const piRequest = request("pi", fake.dir, { ...process.env, MODE: "complete", ARG_FILE: argFile, ENV_FILE: join(fake.dir, "env.json") });
    piRequest.interactions = interactions;
    piRequest.interactionTargets = ["orchestrator", "agent"];
    const backend = new PiRpcBackend(fake.command, {
      requestTimeoutMs: 5_000,
      inactivityTimeoutMs: 5_000,
      openInteractionBridge: async (jobId, handler) => {
        openedFor = jobId;
        return openInteractionBridge(jobId, handler);
      },
    });
    const run = await backend.start(piRequest, (event) => events.push(event));
    await run.completed;
    await run.close();
    assert.equal(openedFor, piRequest.jobId, "the bridge is opened per authorized job");
    const args = JSON.parse(await readFile(argFile, "utf8")) as string[];
    assert.ok(args.some((arg) => arg.endsWith("extensions/interactions/index.ts")), "the child extension is loaded explicitly");
    const childEnv = JSON.parse(await readFile(join(fake.dir, "env.json"), "utf8"));
    assert.ok(childEnv.ask.address && childEnv.ask.token, "the authorized child receives live bridge coordinates");
    assert.equal(childEnv.ask.targets, "orchestrator,agent");
  } finally { await rm(fake.dir, { recursive: true, force: true }); }

  const plain = await fixture(PI_FIXTURE);
  const plainArgs = join(plain.dir, "args.json");
  try {
    const run = await new PiRpcBackend(plain.command, { requestTimeoutMs: 5_000, inactivityTimeoutMs: 5_000 })
      .start(request("pi", plain.dir, { ...process.env, MODE: "complete", ARG_FILE: plainArgs, ENV_FILE: join(plain.dir, "env.json") }), () => {});
    await run.completed;
    await run.close();
    const args = JSON.parse(await readFile(plainArgs, "utf8")) as string[];
    assert.ok(!args.some((arg) => arg.endsWith("extensions/interactions/index.ts")), "an unauthorized child never loads the ask extension");
    const plainEnv = JSON.parse(await readFile(join(plain.dir, "env.json"), "utf8"));
    assert.deepEqual(plainEnv.ask, { address: null, token: null, targets: null }, "no bridge coordinates leak into an unauthorized child");
  } finally { await rm(plain.dir, { recursive: true, force: true }); }
});
