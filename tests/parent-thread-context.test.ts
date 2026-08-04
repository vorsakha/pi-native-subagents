import test from "node:test";
import assert from "node:assert/strict";
import { captureParentThread, renderParentThreadContext } from "../src/parent-thread-context.ts";

test("captureParentThread keeps conversation text and summaries while excluding thinking, tool calls, and tool results", () => {
  const snapshot = captureParentThread([
    { role: "user", content: [{ type: "text", text: "Build the bridge" }, { type: "image", data: "secret-image" }], timestamp: 1_000 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "hidden chain" },
      { type: "toolCall", name: "bash", arguments: { command: "printenv SECRET" } },
      { type: "text", text: "We chose a pull-based tool." },
    ], timestamp: 2_000 },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "secret tool output" }] },
    { role: "compactionSummary", summary: "Earlier work changed the manager." },
    { role: "custom", content: "hidden extension context" },
  ], 3_000);

  assert.deepEqual(snapshot.messages, [
    { role: "user", text: "Build the bridge", timestamp: 1_000 },
    { role: "assistant", text: "We chose a pull-based tool.", timestamp: 2_000 },
    { role: "summary", text: "Earlier work changed the manager.", timestamp: undefined },
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /hidden chain|printenv|secret tool output|secret-image|hidden extension/);
});

test("renderParentThreadContext defaults to recent messages and supports bounded search/pagination", () => {
  const snapshot = captureParentThread([
    { role: "user", content: "alpha decision" },
    { role: "assistant", content: [{ type: "text", text: "beta implementation" }] },
    { role: "user", content: "alpha follow-up" },
  ], 10_000);

  const recent = renderParentThreadContext(snapshot, { limit: 1 });
  assert.match(recent, /\[2\] USER/);
  assert.doesNotMatch(recent, /beta implementation/);

  const searched = renderParentThreadContext(snapshot, { query: "alpha", offset: 1, limit: 1 });
  assert.match(searched, /2 match\(es\)/);
  assert.match(searched, /alpha follow-up/);
  assert.doesNotMatch(searched, /alpha decision/);
  assert.match(searched, /untrusted reference data/);
  assert.ok(Buffer.byteLength(searched, "utf8") <= 50 * 1024);
});
