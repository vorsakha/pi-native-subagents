import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, MAX_OUTPUT_BYTES, reduceJob } from "../src/reducer.ts";
import type { JobSnapshot } from "../src/types.ts";
import { interactionSnapshot } from "./helpers.ts";

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
  state = reduceJob(state, { type: "usage", usage: { input: 5, output: 1 } });
  state = reduceJob(state, { type: "context", context: { tokens: 5_000 } });
  state = reduceJob(state, { type: "message", text: "final" });
  state = reduceJob(state, { type: "completed", at: 3 });
  assert.equal(state.status, "completed");
  assert.equal(state.output, "final");
  assert.equal(state.tools[0]?.status, "completed");
  assert.equal(state.usage.input, 15, "usage accumulates across context events instead of resetting");
  assert.deepEqual(state.context, { tokens: 5_000 }, "a later context event fully replaces the gauge instead of merging with the prior reading");
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

test("reducer records a native structured completion payload separately from narrative output, and leaves it absent otherwise", () => {
  const withStructured = reduceJob(job(), { type: "completed", output: "narrative summary", structured: { ok: true }, at: 3 });
  assert.equal(withStructured.output, "narrative summary");
  assert.deepEqual(withStructured.structured, { ok: true });

  const withoutStructured = reduceJob(job(), { type: "completed", output: "narrative only", at: 3 });
  assert.equal(withoutStructured.output, "narrative only");
  assert.equal(withoutStructured.structured, undefined);
});

test("reducer preserves a native structured payload exactly, without the string/array/byte truncation applied to other bounded fields", () => {
  const longString = "x".repeat(30 * 1024);
  const longArray = Array.from({ length: 100 }, (_, index) => index);
  const large = { longString, longArray, nested: { longString } };
  const state = reduceJob(job(), { type: "completed", output: "ok", structured: large, at: 3 });
  assert.deepEqual(state.structured, large, "a >4 KiB string, a >32 item array, and an overall >50 KiB payload must survive untouched for schema validation");
  assert.equal((state.structured as typeof large).longString.length, 30 * 1024);
  assert.equal((state.structured as typeof large).longArray.length, 100);
});

test("reducer projects progressed only from model/tool activity, and carries unavailable onto a failed job", () => {
  assert.equal(reduceJob(job(), { type: "usage", usage: { input: 1 } }).progressed, undefined, "usage alone is not progress");
  assert.equal(reduceJob(job(), { type: "text_delta", text: "hi" }).progressed, true);
  assert.equal(reduceJob(job(), { type: "thinking_delta", text: "hi" }).progressed, true);
  assert.equal(reduceJob(job(), { type: "thinking_message", text: "hi" }).progressed, true);
  assert.equal(reduceJob(job(), { type: "message", text: "hi" }).progressed, true);
  assert.equal(reduceJob(job(), { type: "tool_start", id: "1", name: "read" }).progressed, true);
  assert.equal(reduceJob(job(), { type: "tool_end", id: "1" }).progressed, true);

  const unavailable = { provider: "claude" as const, kind: "quota" as const, authoritative: true, retryAt: 123, detail: "d" };
  const failed = reduceJob(job(), { type: "failed", error: "quota exceeded", unavailable });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.unavailable, unavailable);

  const failedWithoutUnavailable = reduceJob(job(), { type: "failed", error: "boom" });
  assert.equal(failedWithoutUnavailable.unavailable, undefined);
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

test("reducer mirrors routed-question state without letting observers read manager internals", () => {
  const pending = interactionSnapshot({ requestId: "req-7" });
  let state = reduceJob(job(), { type: "interaction", interaction: pending });
  assert.equal(state.interaction?.requestId, "req-7");
  assert.equal(state.interaction?.state, "pending");
  assert.equal(state.interactionsAsked, 1, "opening a question counts once against the job's own history");
  assert.notEqual(state.interaction, pending, "the snapshot never aliases the authoritative record");

  state = reduceJob(state, { type: "interaction", interaction: { ...pending, state: "answered", answer: "keep it" } });
  assert.equal(state.interactionsAsked, 1, "later transitions of the same question do not recount it");
  assert.equal(state.interaction?.answer, "keep it");

  state = reduceJob(state, { type: "interaction_cleared", requestId: "other" });
  assert.equal(state.interaction?.requestId, "req-7", "a stale clear cannot drop the current question");
  state = reduceJob(state, { type: "interaction_cleared", requestId: "req-7" });
  assert.equal(state.interaction, undefined);

  state = reduceJob(state, { type: "interaction_answering", answering: { requestId: "req-8", sourceJobId: "peer", sourceName: "implementer" } });
  assert.equal(state.answeringInteraction?.sourceName, "implementer");
  state = reduceJob(state, { type: "interaction_answering" });
  assert.equal(state.answeringInteraction, undefined);
});
