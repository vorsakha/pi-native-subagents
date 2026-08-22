import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import {
  pairToolEntries,
  renderToolGroupRow,
  summarizeToolCalls,
  toolCallStates,
  type ToolEntry,
} from "../extensions/tool-summary.ts";

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return { kind: "tool", toolId: "t1", name: "bash", ...overrides };
}

test("a phase-less entry carrying an explicit error is failed, not running", () => {
  const entry = tool({ error: true, result: { content: [], isError: true } });
  const [state] = toolCallStates([entry]);
  assert.equal(state?.name, "bash");
  assert.equal(state?.status, "failed");
});

test("a phase-less entry carrying a settled non-error result is completed, not running", () => {
  const entry = tool({ result: { content: [{ type: "text", text: "ok" }], isError: false } });
  const [state] = toolCallStates([entry]);
  assert.equal(state?.status, "completed");
});

test("a bare phase-less entry with no settlement info stays running (documented legacy behavior)", () => {
  const entry = tool({ text: "file.ts" });
  const [state] = toolCallStates([entry]);
  assert.equal(state?.status, "running");
});

test("pairToolEntries resolves a self-settled phase-less entry as its own result", () => {
  const entry = tool({ toolId: "bash-1", error: true, result: { content: [], isError: true } });
  const { order, pairs } = pairToolEntries([entry]);
  assert.deepEqual(order, ["bash-1"]);
  assert.equal(pairs.get("bash-1")?.result, entry);
});

test("a call interrupted by an intervening event still resolves to exactly one paired call", () => {
  const start = tool({ toolId: "bash-1", phase: "start", name: "bash" });
  const end = tool({ toolId: "bash-1", phase: "end", name: "bash", result: { content: [], isError: true }, error: true });
  // The entries a caller pairs are only the tool events; a non-tool entry in
  // between (assistant/user/thinking) never reaches pairToolEntries, mirroring
  // how both dashboard surfaces filter their transcript before pairing.
  const states = toolCallStates([start, end]);
  assert.equal(states.length, 1, "start and end merge into exactly one call, not a running call plus a separate failed one");
  assert.equal(states[0]?.status, "failed");
});

test("pairToolEntries pairs interleaved parallel calls by id regardless of arrival order", () => {
  const startA = tool({ toolId: "a", phase: "start", name: "read" });
  const startB = tool({ toolId: "b", phase: "start", name: "edit" });
  const endA = tool({ toolId: "a", phase: "end", name: "read", result: { content: [], isError: false } });
  const endB = tool({ toolId: "b", phase: "end", name: "edit", result: { content: [], isError: true }, error: true });
  const states = toolCallStates([startA, startB, endA, endB]);
  assert.deepEqual(states, [
    { name: "read", status: "completed" },
    { name: "edit", status: "failed" },
  ]);
});

test("summarizeToolCalls counts a failed self-settled phase-less call in the failed bucket", () => {
  const entry = tool({ toolId: "bash-1", error: true, result: { content: [], isError: true } });
  const states = toolCallStates([entry]);
  const summary = summarizeToolCalls(states);
  assert.equal(summary.failed, 1);
  assert.equal(summary.running, 0);
  assert.deepEqual(summary.failedTools, ["bash"]);
});

test("the width ladder keeps the failure count once the row has room for it, and never exceeds the given width", () => {
  const summary = summarizeToolCalls([
    { name: "read", status: "completed" },
    { name: "bash", status: "failed" },
  ]);
  for (const width of [40, 20, 10, 7]) {
    const row = renderToolGroupRow(summary, theme, width);
    assert.ok(visibleWidth(row) <= width, `row must not exceed width ${width}`);
    assert.ok(row.includes("×1"), `width ${width} fits the minimal candidate and must keep the failure count`);
  }
  for (const width of [6, 3, 1, 0]) {
    assert.ok(visibleWidth(renderToolGroupRow(summary, theme, width)) <= width, `row must not exceed width ${width}`);
  }
});

test("an all-running group keeps a bounded running indicator down to the narrowest widths, instead of losing running state entirely", () => {
  const summary = summarizeToolCalls([
    { name: "bash", status: "running" },
    { name: "read", status: "running" },
  ]);
  for (const width of [40, 20, 10, 8]) {
    const row = renderToolGroupRow(summary, theme, width);
    assert.ok(visibleWidth(row) <= width, `row must not exceed width ${width}`);
    assert.ok(row.includes("●2"), `width ${width} fits the minimal candidate and must keep the running count`);
  }
  for (const width of [7, 3, 1, 0]) {
    assert.ok(visibleWidth(renderToolGroupRow(summary, theme, width)) <= width, `row must not exceed width ${width}`);
  }
});
