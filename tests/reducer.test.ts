import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, MAX_OUTPUT_BYTES, reduceJob } from "../src/reducer.ts";
import type { JobSnapshot } from "../src/types.ts";

function job(): JobSnapshot {
  return { id: "j", name: "worker", access: "full", independent: false, harness: "codex", model: "m", task: "t", cwd: "/tmp", status: "queued", generation: 0, createdAt: 1, output: "", truncated: false, usage: emptyUsage(), tools: [], transcript: [], liveThinking: "", queuedMessages: [] };
}

test("reducer tracks lifecycle, tools, usage, and authoritative final message", () => {
  let state = reduceJob(job(), { type: "started", at: 2 });
  state = reduceJob(state, { type: "user_message", text: "task" });
  state = reduceJob(state, { type: "thinking_delta", text: "considering" });
  state = reduceJob(state, { type: "thinking_message", text: "considering" });
  state = reduceJob(state, { type: "text_delta", text: "partial" });
  state = reduceJob(state, { type: "queue_changed", messages: [{ text: "next", behavior: "followUp" }] });
  state = reduceJob(state, { type: "tool_start", id: "1", name: "read", args: { path: "src/index.ts" } });
  state = reduceJob(state, {
    type: "tool_end",
    id: "1",
    result: { content: [{ type: "text", text: "source" }], details: { lineCount: 1 }, isError: false },
  });
  state = reduceJob(state, { type: "usage", usage: { input: 10, output: 2, turns: 1 } });
  state = reduceJob(state, { type: "context", context: { tokens: 12_000, window: 100_000, servingModel: "served-model" } });
  state = reduceJob(state, { type: "message", text: "final" });
  state = reduceJob(state, { type: "completed", at: 3 });
  assert.equal(state.status, "completed");
  assert.equal(state.output, "final");
  assert.equal(state.tools[0]?.status, "completed");
  assert.equal(state.usage.input, 10);
  assert.deepEqual(state.context, { tokens: 12_000, window: 100_000, servingModel: "served-model" });
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ["user", "thinking", "tool", "tool", "assistant"]);
  assert.deepEqual(state.transcript.filter((entry) => entry.kind === "tool").map((entry) => entry.phase), ["start", "end"]);
  assert.deepEqual(state.tools[0]?.args, { path: "src/index.ts" });
  assert.deepEqual(state.tools[0]?.result?.details, { lineCount: 1 });
  assert.deepEqual(state.queuedMessages, []);
  assert.equal(state.endedAt, 3);
  assert.equal(reduceJob(job(), { type: "failed", error: "boom" }).error, "boom");
  const cancelled = reduceJob(job(), { type: "cancelled", reason: "stop" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, "stop");
});

test("reducer bounds in-memory transcript output", () => {
  const seeded = job();
  seeded.transcript = [{ kind: "assistant", text: "retained context" }];
  seeded.tools = [{ id: "read", name: "read", status: "completed" }];
  const streamed = reduceJob(seeded, { type: "text_delta", text: "partial" });
  assert.equal(streamed.transcript, seeded.transcript, "streaming deltas reuse immutable transcript state");
  assert.equal(streamed.tools, seeded.tools, "streaming deltas do not clone unrelated tool state");
  assert.equal(streamed.usage, seeded.usage, "streaming deltas do not clone unrelated usage state");

  const state = reduceJob(job(), { type: "text_delta", text: "x".repeat(MAX_OUTPUT_BYTES + 5_000) });
  assert.equal(state.truncated, true);
  assert.ok(Buffer.byteLength(state.output) <= MAX_OUTPUT_BYTES + 40);
  assert.match(state.output, /Earlier output truncated/);

  let toolState = reduceJob(job(), {
    type: "tool_start",
    id: "large",
    name: "write",
    args: { path: "large.txt", content: "x".repeat(100_000) },
  });
  toolState = reduceJob(toolState, {
    type: "tool_end",
    id: "large",
    result: {
      content: [{ type: "text", text: "y".repeat(100_000) }],
      details: { diagnostic: "z".repeat(100_000) },
      isError: false,
    },
  });
  const toolEntries = toolState.transcript.filter((entry) => entry.kind === "tool");
  assert.ok(toolEntries.every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= 16 * 1024));
});
