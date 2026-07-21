import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { createDashboardOverlay, truncateDashboardLine } from "../extensions/subagents/dashboard.ts";
import { TakeoverView, buildTranscript } from "../extensions/subagents/takeover.ts";
import type { JobSnapshot } from "../src/types.ts";

test("dashboard truncation respects terminal display width for Unicode and ANSI", () => {
  for (const value of [
    "reviewer · 你好世界 · codex/fixture-model",
    "worker · 👩🏽‍💻 launch 🚀 complete",
    "\u001b[31mfailed 你好世界\u001b[0m",
  ]) {
    const rendered = truncateDashboardLine(value, 14);
    assert.ok(visibleWidth(rendered) <= 14, `${JSON.stringify(rendered)} exceeds terminal width`);
  }
  assert.equal(truncateDashboardLine("你好世界", 5).replace(/\u001b\[[0-9;]*m/g, ""), "你好…");
  assert.equal(truncateDashboardLine("anything", 0), "");
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function job(id: string, status: JobSnapshot["status"] = "running"): JobSnapshot {
  return {
    id,
    name: "worker", access: "full", independent: false,
    backend: "codex",
    model: "fixture-model",
    effort: "high",
    task: "Review Unicode output 你好世界",
    cwd: "/tmp",
    status,
    generation: 0,
    createdAt: 1_000,
    startedAt: 2_000,
    output: "first line\n你好世界\nlast line",
    truncated: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    tools: [],
    transcript: [],
    liveThinking: "",
    queuedMessages: [],
  };
}

function dashboard(
  jobs: JobSnapshot[],
  rows = 24,
  done: (action: unknown) => void = () => {},
  renderMarkdown: (text: string, width: number) => string[] = (text) => text.split("\n"),
) {
  let renders = 0;
  const overlay = createDashboardOverlay(
    { requestRender: () => { renders++; }, terminal: { rows } } as never,
    theme,
    { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\u0003" } as unknown as KeybindingsManager,
    { list: () => jobs },
    done as never,
    { now: () => 65_000, renderMarkdown },
  );
  return { overlay, renders: () => renders };
}

test("dashboard layout, exit/actions, and transcript scrolling follow the overlay contract", (t) => {
  const actions: unknown[] = [];
  const first = { ...job("first", "completed"), output: Array.from({ length: 40 }, (_, index) => `first-${index}`).join("\n") };
  const second = job("second");
  const { overlay, renders } = dashboard([first, second], 30, (action) => actions.push(action));
  t.after(() => overlay.dispose());
  overlay.focused = true;
  const lines = overlay.render(72);
  assert.equal(lines[0], `╔${"═".repeat(70)}╗`);
  assert.equal(lines.at(-1), `╚${"═".repeat(70)}╝`);
  assert.ok(lines.filter((line) => line.startsWith("║ ")).every((line) => line.endsWith(" ║")));
  assert.ok(lines.filter((line) => line.startsWith("╠")).every((line) => line.endsWith("╣")));
  assert.ok(lines.some((line) => line.includes("Esc close")));
  assert.ok(lines.some((line) => line.includes("effort high")), "dashboard details show request effort");
  assert.ok(overlay.render(60).some((line) => line.includes("effort high")), "effort survives the dashboard minimum width");
  assert.ok(overlay.render(72).some((line) => line.includes("first-0")));
  overlay.handleInput("\u001b[6~"); // Page Down
  const scrolled = overlay.render(72);
  assert.ok(scrolled.some((line) => line.includes("first-")));
  assert.ok(!scrolled.some((line) => line.includes("first-0")));
  assert.ok(scrolled.every((line) => visibleWidth(line) === 72));

  overlay.handleInput("j");
  const reset = overlay.render(72);
  assert.ok(reset.some((line) => line.includes("second")));
  overlay.handleInput("x");
  assert.ok(renders() >= 1);
  assert.deepEqual(actions, [{ type: "cancel", jobId: "second" }]);
  const exits: unknown[] = [];
  const escape = dashboard([job("escape")], 30, (action) => exits.push(action)).overlay;
  t.after(() => escape.dispose());
  escape.handleInput("\x1b");
  escape.handleInput("\x1b");
  assert.deepEqual(exits, [{ type: "close" }]);

  let markdownSource = "";
  const markdown = dashboard(
    [{ ...job("markdown", "completed"), output: "# Verdict\n\n**PASS**" }],
    24,
    () => {},
    (text) => {
      markdownSource = text;
      return ["\u001b[1mVerdict\u001b[0m", "\u001b[32mPASS\u001b[0m"];
    },
  ).overlay;
  t.after(() => markdown.dispose());
  const styled = markdown.render(72);
  assert.equal(markdownSource, "# Verdict\n\n**PASS**");
  assert.ok(styled.some((line) => line.includes("\u001b[1mVerdict\u001b[0m")), "dashboard preserves native Markdown styling");
  assert.ok(styled.every((line) => visibleWidth(line) === 72));
});

test("takeover renders normalized thinking, tools, queued messages, and closes reliably", (t) => {
  const current = {
    ...job("takeover"),
    transcript: [
      { kind: "user" as const, text: "inspect this" },
      { kind: "thinking" as const, text: "considering options" },
      { kind: "tool" as const, toolId: "t1", name: "read", text: "file.ts" },
      { kind: "assistant" as const, text: "working conclusion" },
    ],
    liveThinking: "checking details",
    queuedMessages: [{ text: "also verify tests", behavior: "followUp" as const }],
  };
  const updates = new Set<(job: JobSnapshot) => void>();
  const closed: unknown[] = [];
  const view = new TakeoverView(
    { requestRender() {}, terminal: { rows: 24 } } as never,
    theme,
    { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\u0003" } as unknown as KeybindingsManager,
    {
      check: () => current,
      async send() { return current; },
      async cancel() { return { ...current, status: "cancelled" as const }; },
      subscribe(listener: (value: JobSnapshot) => void) { updates.add(listener); return () => updates.delete(listener); },
    } as never,
    current.id,
    (value) => closed.push(value),
  );
  t.after(() => view.dispose());
  view.focused = true;
  const lines = view.render(72);
  assert.ok(lines.some((line) => line.includes("considering options")));
  assert.ok(lines.some((line) => line.includes("read · file.ts")));
  assert.ok(lines.some((line) => line.includes("also verify tests")));
  assert.ok(lines.some((line) => line.includes("effort high")), "takeover metadata shows request effort");
  assert.ok(view.render(48).some((line) => line.includes("effort high")), "effort survives bounded takeover rendering");
  assert.ok(buildTranscript(current, 72, theme).every((line) => visibleWidth(line) <= 72));
  view.handleInput("\x1b");
  assert.deepEqual(closed, [null]);
  assert.equal(updates.size, 0);

  const workflowCurrent = {
    ...current,
    workflow: { runId: "wf-test", agentIndex: 0, label: "implementation", phase: "Build" },
  };
  let workflowSends = 0;
  const workflowView = new TakeoverView(
    { requestRender() {}, terminal: { rows: 24 } } as never,
    theme,
    { matches: () => false } as unknown as KeybindingsManager,
    {
      check: () => workflowCurrent,
      async send() { workflowSends++; return workflowCurrent; },
      async cancel() { return { ...workflowCurrent, status: "cancelled" as const }; },
      subscribe() { return () => {}; },
    } as never,
    workflowCurrent.id,
    () => {},
  );
  t.after(() => workflowView.dispose());
  workflowView.focused = true;
  assert.ok(workflowView.render(72).some((line) => line.includes("Workflow-owned agent")));
  workflowView.handleInput("a");
  workflowView.handleInput("\r");
  assert.equal(workflowSends, 0, "workflow-owned takeover is read-only");
});
