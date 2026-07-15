import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, MAX_OUTPUT_BYTES, reduceJob } from "../src/reducer.ts";
import type { JobSnapshot } from "../src/types.ts";

function job(): JobSnapshot {
  return { id: "j", role: "worker", backend: "codex", model: "m", task: "t", cwd: "/tmp", status: "queued", createdAt: 1, output: "", truncated: false, usage: emptyUsage(), tools: [] };
}

test("reducer tracks lifecycle, tools, usage, and authoritative final message", () => {
  let state = reduceJob(job(), { type: "started", at: 2 });
  state = reduceJob(state, { type: "text_delta", text: "partial" });
  state = reduceJob(state, { type: "tool_start", id: "1", name: "read" });
  state = reduceJob(state, { type: "tool_end", id: "1", error: false });
  state = reduceJob(state, { type: "usage", usage: { input: 10, output: 2, turns: 1 } });
  state = reduceJob(state, { type: "message", text: "final" });
  state = reduceJob(state, { type: "completed", at: 3 });
  assert.equal(state.status, "completed");
  assert.equal(state.output, "final");
  assert.equal(state.tools[0]?.status, "completed");
  assert.equal(state.usage.input, 10);
  assert.equal(state.endedAt, 3);
});

test("reducer bounds in-memory transcript output", () => {
  const state = reduceJob(job(), { type: "text_delta", text: "x".repeat(MAX_OUTPUT_BYTES + 5_000) });
  assert.equal(state.truncated, true);
  assert.ok(Buffer.byteLength(state.output) <= MAX_OUTPUT_BYTES + 40);
  assert.match(state.output, /Earlier output truncated/);
});

test("failed and cancelled events preserve explicit terminal reasons", () => {
  assert.equal(reduceJob(job(), { type: "failed", error: "boom" }).error, "boom");
  const cancelled = reduceJob(job(), { type: "cancelled", reason: "stop" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, "stop");
});
