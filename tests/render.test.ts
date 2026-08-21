import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  MAX_COLLAPSED_LINES,
  MAX_EXPANDED_LINES,
  buildJobCardLines,
  renderJobCard,
  renderJobReceipt,
  sanitizeInline,
  sanitizeText,
  statusMeta,
} from "../extensions/subagents/render.ts";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { ToolTrace } from "../src/types.ts";
import { ImmediateBackend, ansiTheme, fakePi, jobSnapshot as job, theme, usage } from "./helpers.ts";

const ESC = "\u001B";
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function tool(id: string, status: ToolTrace["status"] = "completed"): ToolTrace {
  return { id, name: `tool-${id}`, summary: `summary ${id}`, status };
}

test("renderer sanitizes output and enforces collapsed/expanded line budgets", () => {
  const clean = sanitizeText(`${ESC}[31mred${ESC}[0m\tline1 \nline2${ESC}]0;title${ESC}\\end`);
  assert.equal(clean.includes(ESC), false);
  assert.equal(CONTROL_CHARS.test(clean), false);
  assert.ok(clean.includes("\n"));
  assert.equal(sanitizeInline("a\n\nb\tc   d"), "a b c d");
  assert.deepEqual(statusMeta("running"), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 0), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 499), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 500), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 999), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 1_000), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("completed", 800), { glyph: "✓", color: "success" });
  const hugeOutput = Array.from({ length: 5_000 }, (_, i) => `${ESC}[3${i % 8}mline ${i} `).join("\n");
  const bigJob = job({
    status: "completed",
    endedAt: 3_000,
    output: hugeOutput,
    truncated: true,
    tools: Array.from({ length: 500 }, (_, i) => tool(String(i))),
    error: "boom\nsecond\nthird\nfourth",
    usage: usage({ input: 1_234_567, output: 42, turns: 3, cost: 1.23456 }),
  });

  const collapsedLines = buildJobCardLines(bigJob, theme, { expanded: false, now: 4_000 });
  assert.ok(collapsedLines.length <= MAX_COLLAPSED_LINES, `collapsed produced ${collapsedLines.length} lines`);
  assert.ok(collapsedLines.every((line) => !CONTROL_CHARS.test(line)));

  const adaptiveLines = buildJobCardLines(job(), theme, { expanded: false, now: 5_000 });
  assert.ok(adaptiveLines.some((line) => line.includes("effort adaptive")), "default effort is visible in the main thread card");
  assert.ok(renderJobCard(job(), theme, { expanded: false, now: 5_000 }).render(48).some((line) => line.includes("effort adaptive")), "adaptive effort survives bounded-width rendering");
  const independentLines = buildJobCardLines(job({ independent: true }), theme, { expanded: false, now: 5_000 });
  assert.ok(independentLines.some((line) => line.includes("independent")), "cross-provider independence is visible in the main thread card");
  assert.ok(buildJobCardLines(job(), theme, { expanded: true, now: 5_000 }).some((line) => line.includes("Budget") && line.includes("open")));
  assert.ok(buildJobCardLines(job({ budget: { maxTokens: 5 }, usage: usage({ input: 5 }) }), theme, { expanded: true, now: 5_000 })
    .some((line) => line.includes("tokens 5/5 reached")));

  const outcomeLines = buildJobCardLines(job({
    status: "completed",
    effort: "high",
    endedAt: 4_000,
    output: "## Verdict\nPASS\nDetails\nFinal recommendation",
    tools: [tool("old"), tool("latest")],
    usage: usage({ input: 1200, output: 50, turns: 2 }),
  }), theme, { expanded: false, now: 5_000 });
  const resultIndex = outcomeLines.findIndex((line) => line.includes("Result"));
  const usageIndex = outcomeLines.findIndex((line) => line.includes("Usage"));
  assert.ok(resultIndex > 0 && resultIndex < usageIndex, "collapsed card prioritizes outcome before usage");
  assert.ok(outcomeLines.some((line) => line.includes("effort high")), "explicit effort is visible in the main thread card");
  assert.ok(renderJobCard(job({ effort: "high" }), theme, { expanded: false, now: 5_000 }).render(48).some((line) => line.includes("effort high")), "explicit effort survives bounded-width rendering");
  assert.ok(outcomeLines.every((line) => !line.includes("tool-")), "collapsed card hides tool calls");

  const liveLines = buildJobCardLines(job({
    output: "Inspecting the renderer behavior",
    tools: [tool("latest", "running")],
  }), theme, { expanded: false, isPartial: true, now: 5_000 });
  assert.ok(liveLines.some((line) => line.includes("Latest") && line.includes("Inspecting the renderer behavior")), "latest activity uses assistant text");
  assert.ok(liveLines.every((line) => !line.includes("tool-latest")), "latest activity never substitutes a tool call");
  const receipt = renderJobReceipt(job({ status: "completed", endedAt: 5_000 }), theme, { action: "completed", now: 5_000 }).render(48);
  assert.equal(receipt.length, 1);
  assert.match(receipt[0]!, /^│\s+✓ completed · 3s$/);
  assert.equal(receipt[0]!.includes("worker"), false, "wait receipt does not repeat the agent identified by its call row");

  const expandedLines = buildJobCardLines(bigJob, theme, { expanded: true, now: 4_000 });
  assert.ok(expandedLines.length <= MAX_EXPANDED_LINES, `expanded produced ${expandedLines.length} lines`);
  assert.ok(expandedLines.every((line) => !CONTROL_CHARS.test(line)));
  assert.ok(expandedLines.some((line) => line.includes("/subagents")));
  assert.ok(expandedLines.every((line) => !line.includes("tool-")), "expanded card no longer lists recent tool calls as primary activity");
});

test("expanded activity prioritizes semantic progress over the tool list", () => {
  const manyTools = Array.from({ length: 6 }, (_, i) => tool(String(i)));

  const withTools = buildJobCardLines(job({ status: "running", tools: manyTools }), theme, { expanded: true, now: 5_000 });
  assert.ok(withTools.length <= MAX_EXPANDED_LINES, `expanded produced ${withTools.length} lines`);
  assert.ok(withTools.every((line) => !line.includes("tool-")), "no multi-row recent-tool list even when tools exist");
  assert.equal(withTools.filter((line) => line.includes("Activity")).length <= 1, true, "at most one Activity line");

  const liveThinking = "Reviewing the diff for edge cases before running the suite";
  const thinkingLines = buildJobCardLines(job({ status: "running", liveThinking, tools: manyTools }), theme, { expanded: true, now: 5_000 });
  const activityLines = thinkingLines.filter((line) => line.includes("Activity"));
  assert.equal(activityLines.length, 1, "exactly one Activity line carries live semantic progress");
  assert.ok(activityLines[0]!.includes(liveThinking), "live thinking preview is shown");
  assert.ok(thinkingLines.every((line) => !line.includes("tool-")), "tool detail stays out of the card even with live thinking present");
  assert.ok(thinkingLines.every((line) => !CONTROL_CHARS.test(line)));

  const narrow = renderJobCard(job({ status: "running", liveThinking, tools: manyTools }), theme, { expanded: true, now: 5_000 }).render(48);
  assert.ok(narrow.length <= MAX_EXPANDED_LINES);
  assert.ok(narrow.some((line) => line.includes("Activity")), "activity survives narrow-width rendering");

  const hugeThinking = "x".repeat(5_000) + "TAIL_MARKER";
  const boundedLines = buildJobCardLines(job({ status: "running", liveThinking: hugeThinking }), theme, { expanded: true, now: 5_000 });
  const boundedActivity = boundedLines.find((line) => line.includes("Activity"));
  assert.ok(boundedActivity, "activity line present for a large live-thinking buffer");
  assert.ok(boundedActivity!.length < 400, "activity preview is tightly bounded, not the full buffer");

  const runningToolOnly = buildJobCardLines(job({ status: "running", tools: [tool("build", "running")] }), theme, { expanded: true, now: 5_000 });
  assert.ok(runningToolOnly.some((line) => line.includes("Activity") && line.includes("running tool-build")), "no output/liveThinking falls back to the running tool as a minimal operational indicator");

  const queuedLines = buildJobCardLines(job({ status: "queued" }), theme, { expanded: true, now: 5_000 });
  assert.ok(queuedLines.some((line) => line.includes("waiting for an agent slot")), "queued job with nothing else falls back to a minimal waiting indicator");

  const completedNoOutput = buildJobCardLines(job({ status: "completed", output: "", endedAt: 5_000 }), theme, { expanded: true, now: 5_000 });
  assert.ok(completedNoOutput.some((line) => line.includes("Result") && line.includes("(no assistant text)")));
  assert.ok(completedNoOutput.every((line) => !line.includes("Activity")), "completed cards foreground Result, not Activity");
});

test("every direct tool registers width-safe, sanitized trace renderers", () => {
  const pi = fakePi();
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, { registry: {}, legacyRoot: false, backends });

  const expected = [
    "session_peer_fork", "session_peer_list",
    "subagent", "subagent_cancel", "subagent_capabilities", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait",
  ];
  assert.deepEqual([...pi.tools.keys()].filter((name) => name !== "workflow").sort(), expected);
  assert.ok(pi.tools.has("workflow"));
  const args: Record<string, Record<string, unknown>> = {
    subagent_spawn: { name: "worker", access: "full", independent: false, task: "\u001b[31mdo work\u001b[0m", harness: "codex" },
    subagent_check: { jobId: "\u001b[31m123456789\u001b[0m" },
    subagent_wait: { jobId: "123456789", timeoutMs: 1_000 },
    subagent_send: { jobId: "123456789", message: "\u001b]0;bad\u0007hello", behavior: "steer" },
    subagent_cancel: { jobId: "123456789" },
    subagent_list: {},
    subagent: { name: "implementation", task: "\u001b[31mdo work\u001b[0m", harness: "codex" },
    session_peer_list: { query: "\u001b[31mbug\u001b[0m", limit: 5 },
    session_peer_fork: { sessionId: "peer-1", message: "\u001b[31mclarify\u001b[0m", name: "peer" },
  };
  for (const name of expected) {
    const toolDef = pi.tools.get(name);
    assert.equal(typeof toolDef.renderCall, "function", `${name} missing renderCall`);
    assert.equal(typeof toolDef.renderResult, "function", `${name} missing renderResult`);
    assert.equal(toolDef.renderShell, "self", `${name} should use the inline trace shell`);
    const callLines = toolDef.renderCall(args[name], ansiTheme).render(48);
    if (name === "subagent_wait") {
      assert.deepEqual(callLines, [], "successful wait mechanics stay out of the transcript");
    } else {
      assert.ok(callLines[0].includes("\u001b["), `${name} did not apply the theme`);
      assert.ok(callLines[0].includes("⌁"), `${name} call is missing the trace group prefix`);
      assert.equal(callLines.join("\n").includes("\u001b]"), false, `${name} leaked an OSC sequence`);
      assert.ok(callLines.every((line: string) => visibleWidth(line) <= 48), `${name} call exceeded width`);
    }
    const details = name === "subagent_list"
      ? { jobs: [job()] }
      : name === "session_peer_list"
        ? { peers: [{ sessionId: "peer-1", name: "\u001b[31mnamed\u001b[0m", cwd: "/tmp/project", createdAt: 0, modifiedAt: 0, messageCount: 2, preview: "hi" }] }
        : { job: job({ status: "completed", endedAt: 3_000, output: "first\nlast" }) };
    const resultLines = toolDef.renderResult({ details }, { expanded: false, isPartial: false }, ansiTheme, { args: args[name] }).render(48);
    assert.ok(resultLines.length <= MAX_COLLAPSED_LINES, `${name} result exceeded budget`);
    if (name === "subagent_wait") {
      assert.deepEqual(resultLines, [], "completed waits are represented by the original live job card");
    } else {
      assert.ok(resultLines[0]?.includes("│"), `${name} result is missing the trace continuation rail`);
    }
    if (["subagent_check", "subagent_send", "subagent_cancel"].includes(name)) {
      assert.equal(resultLines.length, 1, `${name} should render a compact receipt instead of duplicating the spawn card`);
    }
    assert.ok(resultLines.every((line: string) => visibleWidth(line) <= 48), `${name} result exceeded width`);
  }

  const wait = pi.tools.get("subagent_wait");
  const timedOut = wait.renderResult(
    { details: { job: job({ status: "running" }) } },
    { expanded: false, isPartial: false },
    theme,
    { args: { timeoutMs: 30_000 }, state: {}, invalidate() {} },
  ).render(80).join("\n");
  assert.match(timedOut, /^⌁\s+/);
  assert.match(timedOut, /running after 30s wait timeout ·/);
});
