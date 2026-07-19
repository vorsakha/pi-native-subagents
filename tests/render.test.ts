import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
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
import type { Backend, BackendEvent, BackendName, BackendRequest, BackendRun, JobSnapshot, ToolTrace } from "../src/types.ts";

const ESC = "\u001B";
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const ansiTheme = {
  fg: (color: string, text: string) => `\u001b[3${color.length % 8}m${text}\u001b[0m`,
  bg: (_color: string, text: string) => `\u001b[48;5;24m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
} as unknown as Theme;

function usage(overrides: Partial<JobSnapshot["usage"]> = {}): JobSnapshot["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...overrides };
}

function tool(id: string, status: ToolTrace["status"] = "completed"): ToolTrace {
  return { id, name: `tool-${id}`, summary: `summary ${id}`, status };
}

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "0123456789abcdef",
    name: "worker", access: "full", independent: false,
    backend: "codex",
    model: "gpt-5.6-terra",
    task: "Implement the widget",
    cwd: "/tmp",
    status: "running",
    createdAt: 1_000,
    startedAt: 2_000,
    output: "",
    truncated: false,
    usage: usage(),
    tools: [],
    ...overrides,
    generation: overrides.generation ?? 0,
    transcript: [],
    liveThinking: "",
    queuedMessages: [],
  };
}

test("renderer sanitizes output, enforces line budgets, and registers runtime renderers", () => {
  const clean = sanitizeText(`${ESC}[31mred${ESC}[0m\tline1 \nline2${ESC}]0;title${ESC}\\end`);
  assert.equal(clean.includes(ESC), false);
  assert.equal(CONTROL_CHARS.test(clean), false);
  assert.ok(clean.includes("\n"));
  assert.equal(sanitizeInline("a\n\nb\tc   d"), "a b c d");
  assert.deepEqual(statusMeta("running"), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 0), { glyph: " ", color: "dim" });
  assert.deepEqual(statusMeta("running", 200), { glyph: "·", color: "dim" });
  assert.deepEqual(statusMeta("running", 400), { glyph: "•", color: "muted" });
  assert.deepEqual(statusMeta("running", 600), { glyph: "●", color: "accent" });
  assert.deepEqual(statusMeta("running", 1_600), { glyph: " ", color: "dim" });
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
  assert.ok(adaptiveLines[0]?.includes("effort adaptive"), "default effort is visible in the main thread card");
  assert.ok(renderJobCard(job(), theme, { expanded: false, now: 5_000 }).render(48)[0]?.includes("effort adaptive"), "adaptive effort survives bounded-width rendering");
  const independentLines = buildJobCardLines(job({ independent: true }), theme, { expanded: false, now: 5_000 });
  assert.ok(independentLines[0]?.includes("independent"), "cross-provider independence is visible in the main thread card");

  const outcomeLines = buildJobCardLines(job({
    status: "completed",
    effort: "high",
    endedAt: 4_000,
    output: "## Verdict\nPASS\nDetails\nFinal recommendation",
    tools: [tool("old"), tool("latest")],
    usage: usage({ input: 1200, output: 50, turns: 2 }),
  }), theme, { expanded: false, now: 5_000 });
  const resultIndex = outcomeLines.findIndex((line) => line.includes("Result"));
  const activityIndex = outcomeLines.findIndex((line) => line.includes("Activity"));
  const usageIndex = outcomeLines.findIndex((line) => line.includes("Usage"));
  assert.ok(resultIndex > 0 && resultIndex < activityIndex && activityIndex < usageIndex, "collapsed card prioritizes outcome before activity and usage");
  assert.ok(outcomeLines[0]?.includes("effort high"), "explicit effort is visible in the main thread card");
  assert.ok(renderJobCard(job({ effort: "high" }), theme, { expanded: false, now: 5_000 }).render(48)[0]?.includes("effort high"), "explicit effort survives bounded-width rendering");
  assert.ok(outcomeLines.some((line) => line.includes("tool-latest")));
  assert.ok(outcomeLines.every((line) => !line.includes("tool-old")), "collapsed card keeps only latest activity");
  const receipt = renderJobReceipt(job({ status: "running" }), theme, { action: "Waiting on", now: 5_000 }).render(48);
  assert.equal(receipt.length, 1);
  assert.match(receipt[0]!, /Waiting on worker 01234567/);
  assert.match(receipt[0]!, /full/);

  const expandedLines = buildJobCardLines(bigJob, theme, { expanded: true, now: 4_000 });
  assert.ok(expandedLines.length <= MAX_EXPANDED_LINES, `expanded produced ${expandedLines.length} lines`);
  assert.ok(expandedLines.every((line) => !CONTROL_CHARS.test(line)));
  assert.ok(expandedLines.some((line) => line.includes("/subagents")));
  assertRuntimeRenderers();
});

class ImmediateBackend implements Backend {
  readonly name: BackendName;
  constructor(name: BackendName) { this.name = name; }
  async start(_request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    emit({ type: "completed", output: `${this.name}-ok` });
    return { completed: Promise.resolve(), async send() {}, async cancel() {}, async close() {} };
  }
}

function fakePi() {
  const tools = new Map<string, any>();
  return {
    api: {
      on() {},
      registerTool(toolDef: any) { tools.set(toolDef.name, toolDef); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      appendEntry() {},
    } as any,
    tools,
  };
}

function assertRuntimeRenderers(): void {
  const pi = fakePi();
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, { registry: {}, legacyRoot: false, backends });

  const expected = [
    "subagent", "subagent_cancel", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait",
  ];
  assert.deepEqual([...pi.tools.keys()].filter((name) => name !== "workflow").sort(), expected);
  assert.ok(pi.tools.has("workflow"));
  const args: Record<string, Record<string, unknown>> = {
    subagent_spawn: { name: "worker", access: "full", independent: false, task: "\u001b[31mdo work\u001b[0m", backend: "codex" },
    subagent_check: { jobId: "\u001b[31m123456789\u001b[0m" },
    subagent_wait: { jobId: "123456789", timeoutMs: 1_000 },
    subagent_send: { jobId: "123456789", message: "\u001b]0;bad\u0007hello", behavior: "steer" },
    subagent_cancel: { jobId: "123456789" },
    subagent_list: {},
    subagent: { name: "implementation", task: "\u001b[31mdo work\u001b[0m", backend: "codex" },
  };
  for (const name of expected) {
    const toolDef = pi.tools.get(name);
    assert.equal(typeof toolDef.renderCall, "function", `${name} missing renderCall`);
    assert.equal(typeof toolDef.renderResult, "function", `${name} missing renderResult`);
    const callLines = toolDef.renderCall(args[name], ansiTheme).render(48);
    assert.ok(callLines[0].includes("\u001b["), `${name} did not apply the theme`);
    assert.equal(callLines.join("\n").includes("\u001b]"), false, `${name} leaked an OSC sequence`);
    assert.ok(callLines.every((line: string) => visibleWidth(line) <= 48), `${name} call exceeded width`);
    const details = name === "subagent_list" ? { jobs: [job()] } : { job: job({ status: "completed", endedAt: 3_000, output: "first\nlast" }) };
    const resultLines = toolDef.renderResult({ details }, { expanded: false, isPartial: false }, ansiTheme, { args: args[name] }).render(48);
    assert.ok(resultLines.length <= MAX_COLLAPSED_LINES, `${name} result exceeded budget`);
    if (["subagent_check", "subagent_wait", "subagent_send", "subagent_cancel"].includes(name)) {
      assert.equal(resultLines.length, 1, `${name} should render a compact receipt instead of duplicating the spawn card`);
    }
    assert.ok(resultLines.every((line: string) => visibleWidth(line) <= 48), `${name} result exceeded width`);
  }
}
