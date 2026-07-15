import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  MAX_COLLAPSED_LINES,
  MAX_EXPANDED_LINES,
  buildJobCardLines,
  renderJobCard,
  renderJobListCard,
  renderToolCallLine,
  sanitizeInline,
  sanitizeText,
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
    role: "worker",
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
  };
}

test("sanitizeText strips ANSI, OSC, and control characters but keeps newlines", () => {
  const dirty = `${ESC}[31mred${ESC}[0m\tline1 \nline2${ESC}]0;title${ESC}\\end`;
  const clean = sanitizeText(dirty);
  assert.equal(clean.includes(ESC), false);
  assert.equal(CONTROL_CHARS.test(clean), false);
  assert.ok(clean.includes("\n"));
  assert.ok(clean.includes("red"));
  assert.ok(clean.includes("line1"));
  assert.ok(clean.includes("line2end"));
});

test("sanitizeInline collapses whitespace and newlines into a single line", () => {
  assert.equal(sanitizeInline("a\n\nb\tc   d"), "a b c d");
  assert.equal(sanitizeInline(`${ESC}[31mred${ESC}[0m text`), "red text");
});

test("huge, control-laden output stays within the collapsed and expanded line budgets", () => {
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

  const expandedLines = buildJobCardLines(bigJob, theme, { expanded: true, now: 4_000 });
  assert.ok(expandedLines.length <= MAX_EXPANDED_LINES, `expanded produced ${expandedLines.length} lines`);
  assert.ok(expandedLines.every((line) => !CONTROL_CHARS.test(line)));
  assert.ok(expandedLines.some((line) => line.includes("/subagents")));
});

test("live partial card stays compact: bounded tools, bounded tail, usage, no spam", () => {
  const running = job({
    status: "running",
    output: Array.from({ length: 40 }, (_, i) => `stream line ${i}`).join("\n"),
    tools: Array.from({ length: 12 }, (_, i) => tool(String(i), i === 11 ? "running" : "completed")),
    usage: usage({ input: 500, output: 20, turns: 1 }),
  });
  const lines = buildJobCardLines(running, theme, { expanded: false, now: 2_500, isPartial: true });
  assert.ok(lines.length <= MAX_COLLAPSED_LINES);
  const toolLines = lines.filter((line) => line.includes("tool-"));
  assert.ok(toolLines.length <= 3, `expected at most 3 tool lines, got ${toolLines.length}`);
  assert.ok(lines.some((line) => line.includes("updating")));
  assert.ok(!lines.some((line) => line.includes("(subagent running...)")));
});

test("settled previews preserve the head and tail while streaming previews follow the tail", () => {
  const completed = job({ status: "completed", endedAt: 3_000, output: "first\nsecond\nthird\nfourth\nlast" });
  const settled = buildJobCardLines(completed, theme, { expanded: false, now: 4_000 });
  assert.ok(settled.some((line) => line.includes("first")));
  assert.ok(settled.some((line) => line.includes("last")));
  assert.ok(settled.some((line) => line.includes("omitted")));

  const streaming = buildJobCardLines({ ...completed, status: "running" }, theme, { expanded: false, now: 4_000, isPartial: true });
  assert.ok(!streaming.some((line) => line.includes("first")));
  assert.ok(streaming.some((line) => line.includes("last")));
});

test("job card line width never exceeds the requested render width", () => {
  const wide = job({
    role: "reviewer-with-a-suspiciously-long-role-name-that-keeps-going",
    task: "你好世界".repeat(50),
    output: "第一行\n第二行\n第三行".repeat(20),
    tools: [tool("wide-tool-name-that-is-quite-long-indeed")],
  });
  for (const width of [1, 5, 20, 40, 80]) {
    for (const expanded of [false, true]) {
      const component = renderJobCard(wide, ansiTheme, { expanded, now: 3_000 });
      const rendered = component.render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width), `width=${width} expanded=${expanded}`);
    }
  }
});

test("configured expand hint is used once and call-line text is sanitized", () => {
  const lines = buildJobCardLines(job({ status: "completed", endedAt: 2_000 }), theme, {
    expanded: false, now: 3_000, expandHint: "Alt+E to expand",
  });
  const footer = lines.at(-1)!;
  assert.ok(footer.includes("Alt+E to expand"));
  assert.equal(footer.split("/subagents").length - 1, 1);

  const call = renderToolCallLine(theme, "Spawn", `\u001b[31mworker\u001b[0m`, "\u001b]0;bad\u0007 task").render(80).join("\n");
  assert.equal(call.includes("\u001b"), false);
  assert.ok(call.includes("→ Spawn worker task"));
});

test("error and cancellation states surface a bounded, sanitized error line", () => {
  const failed = job({
    status: "failed",
    endedAt: 3_000,
    error: `${ESC}[31mstack trace line one${ESC}[0m\nstack trace line two\nstack trace line three\nstack trace line four`,
  });
  const collapsed = buildJobCardLines(failed, theme, { expanded: false, now: 4_000 });
  const errorLines = collapsed.filter((line) => line.includes("stack trace"));
  assert.equal(errorLines.length, 1);
  const expanded = buildJobCardLines(failed, theme, { expanded: true, now: 4_000 });
  const expandedErrorLines = expanded.filter((line) => line.includes("stack trace"));
  assert.ok(expandedErrorLines.length <= 3);
});

test("empty job list and populated job list render capped, width-safe summaries", () => {
  const emptyComponent = renderJobListCard([], theme, { expanded: false, now: 1_000 });
  const emptyLines = emptyComponent.render(60);
  assert.ok(emptyLines.some((line) => line.includes("No subagent jobs")));

  const manyJobs = Array.from({ length: 50 }, (_, i) => job({ id: `job-${i}`, status: i % 2 === 0 ? "completed" : "running" }));
  const collapsedComponent = renderJobListCard(manyJobs, theme, { expanded: false, now: 1_000 });
  const collapsedLines = collapsedComponent.render(72);
  assert.ok(collapsedLines.length <= MAX_COLLAPSED_LINES);
  assert.ok(collapsedLines.some((line) => line.includes("more job")));
  assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 72));

  const expandedComponent = renderJobListCard(manyJobs, theme, { expanded: true, now: 1_000 });
  const expandedLines = expandedComponent.render(72);
  assert.ok(expandedLines.length <= MAX_EXPANDED_LINES);
});

test("empty output states render a clear empty-state line instead of blank space", () => {
  const freshRunning = job({ status: "queued", output: "" });
  const lines = buildJobCardLines(freshRunning, theme, { expanded: false, now: 1_000 });
  assert.ok(lines.some((line) => line.includes("no output yet")));

  const completedEmpty = job({ status: "completed", endedAt: 1_500, output: "" });
  const doneLines = buildJobCardLines(completedEmpty, theme, { expanded: false, now: 2_000 });
  assert.ok(doneLines.some((line) => line.includes("(no output)")));
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

test("every subagent tool defines and invokes humanized custom renderers", () => {
  const pi = fakePi();
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, { registry: {}, legacyRoot: false, backends });

  const expected = [
    "subagent", "subagent_cancel", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait",
  ];
  assert.deepEqual([...pi.tools.keys()].filter((name) => name !== "workflow").sort(), expected);
  assert.ok(pi.tools.has("workflow"));
  const args: Record<string, Record<string, unknown>> = {
    subagent_spawn: { role: "worker", task: "\u001b[31mdo work\u001b[0m", backend: "codex" },
    subagent_check: { jobId: "\u001b[31m123456789\u001b[0m" },
    subagent_wait: { jobId: "123456789", timeoutMs: 1_000 },
    subagent_send: { jobId: "123456789", message: "\u001b]0;bad\u0007hello", behavior: "steer" },
    subagent_cancel: { jobId: "123456789" },
    subagent_list: {},
    subagent: { agent: "worker", task: "\u001b[31mdo work\u001b[0m", backend: "codex" },
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
    assert.ok(resultLines.every((line: string) => visibleWidth(line) <= 48), `${name} result exceeded width`);
  }
});
