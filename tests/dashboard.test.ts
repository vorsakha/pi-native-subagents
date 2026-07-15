import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { createDashboardOverlay, truncateDashboardLine } from "../extensions/subagents/dashboard.ts";
import type { JobSnapshot } from "../src/types.ts";

test("dashboard truncation respects terminal display width for Unicode and ANSI", () => {
  for (const value of [
    "reviewer · 你好世界 · codex/gpt-5.6-sol",
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
    role: "worker",
    backend: "codex",
    model: "gpt-5.6",
    task: "Review Unicode output 你好世界",
    cwd: "/tmp",
    status,
    createdAt: 1_000,
    startedAt: 2_000,
    output: "first line\n你好世界\nlast line",
    truncated: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    tools: [],
  };
}

function dashboard(jobs: JobSnapshot[], rows = 24, done: (action: unknown) => void = () => {}) {
  let renders = 0;
  const overlay = createDashboardOverlay(
    { requestRender: () => { renders++; }, terminal: { rows } } as never,
    theme,
    { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\u0003" } as unknown as KeybindingsManager,
    { list: () => jobs },
    done as never,
    { now: () => 65_000 },
  );
  return { overlay, renders: () => renders };
}

test("dashboard has a complete focused frame and width-safe rows", (t) => {
  const { overlay } = dashboard([job("123456789")]);
  t.after(() => overlay.dispose());
  overlay.focused = true;
  const lines = overlay.render(36);
  assert.equal(lines[0], `╔${"═".repeat(34)}╗`);
  assert.equal(lines.at(-1), `╚${"═".repeat(34)}╝`);
  assert.ok(lines.filter((line) => line.startsWith("║ ")).every((line) => line.endsWith(" ║")));
  assert.ok(lines.filter((line) => line.startsWith("╠")).every((line) => line.endsWith("╣")));
  assert.ok(lines.some((line) => line.includes("Esc close")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 36));
  const narrow = dashboard([]).overlay;
  t.after(() => narrow.dispose());
  assert.ok(narrow.render(3).every((line) => visibleWidth(line) <= 3));
});

test("dashboard fits the 90% overlay height and keeps its footer framed", (t) => {
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    ...job(`job-${index}-long-id`),
    error: "\u001b[31merror\u001b[0m\twith a control\u0007 character",
    tools: [
      { id: "one", name: "tool\tname", summary: "\u001b[2Ksummary\u0000", status: "failed" as const },
      { id: "two", name: "other", summary: "second tool", status: "completed" as const },
    ],
    output: "\u001b[31mfirst\u001b[0m\tline\nsecond\u0008 line\nthird line",
  }));
  const { overlay } = dashboard(jobs, 24);
  t.after(() => overlay.dispose());
  overlay.focused = true;
  for (let index = 0; index < 4; index++) overlay.handleInput("j");
  const lines = overlay.render(72);
  assert.ok(lines.length <= Math.floor(24 * 0.9));
  assert.match(lines.at(-2)!, /Esc close/);
  assert.ok(lines.some((line) => line.includes("Transcript ")));
  assert.ok(lines.some((line) => line.includes("›") && line.includes("job-4-lo")));
  assert.equal(lines.at(-1), `╚${"═".repeat(70)}╝`);
  assert.ok(lines.every((line) => !/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(line)));
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
});

test("dashboard degrades gracefully across short-terminal height boundaries", (t) => {
  for (let rows = 1; rows <= 12; rows++) {
    const { overlay } = dashboard([job("short")], rows);
    t.after(() => overlay.dispose());
    const lines = overlay.render(36);
    const maxHeight = Math.floor(rows * 0.9);
    assert.ok(lines.length <= maxHeight, `rows=${rows}: ${lines.length} lines exceed max height ${maxHeight}`);
    assert.ok(lines.every((line) => visibleWidth(line) <= 36));
    if (maxHeight >= 2) assert.match(lines.at(-1)!, /^[╰╚].*[╯╝]$/);
    if (maxHeight >= 4) assert.ok(lines.some((line) => line.includes("Esc close")));
  }
});

test("dashboard closes once for Escape and the configured cancel binding", () => {
  const actions: unknown[] = [];
  const { overlay } = dashboard([job("one")], 24, (action) => actions.push(action));
  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b");
  assert.deepEqual(actions, [{ type: "close" }]);

  const cancelActions: unknown[] = [];
  const second = dashboard([job("two")], 24, (action) => cancelActions.push(action)).overlay;
  second.handleInput("\u0003");
  assert.deepEqual(cancelActions, [{ type: "close" }]);
});

test("dashboard scrolls the full bounded transcript with Shift and Page keys and resets on selection", (t) => {
  const first = { ...job("first"), output: Array.from({ length: 40 }, (_, index) => `first-${index}`).join("\n") };
  const second = { ...job("second"), output: "second-0\nsecond-1" };
  const { overlay } = dashboard([first, second], 30);
  t.after(() => overlay.dispose());
  overlay.render(72);
  assert.ok(overlay.render(72).some((line) => line.includes("first-0")));
  overlay.handleInput("\u001b[6~"); // Page Down
  const scrolled = overlay.render(72);
  assert.ok(scrolled.some((line) => line.includes("first-")));
  assert.ok(!scrolled.some((line) => line.includes("first-0")));
  assert.ok(scrolled.every((line) => visibleWidth(line) === 72));

  overlay.handleInput("j");
  const reset = overlay.render(72);
  assert.ok(reset.some((line) => line.includes("second-0")));
  overlay.handleInput("\u001b[1;2B"); // Shift+Down
  assert.ok(overlay.render(72).some((line) => line.includes("second-1")));
});

test("dashboard wraps and scrolls long logical transcript lines without hiding their suffix", (t) => {
  const long = `${"segment ".repeat(180)}REACHABLE_SUFFIX`;
  const { overlay } = dashboard([{ ...job("long-line"), output: long }], 24);
  t.after(() => overlay.dispose());
  const initial = overlay.render(48);
  assert.ok(!initial.some((line) => line.includes("REACHABLE_SUFFIX")));
  for (let index = 0; index < 20; index++) overlay.handleInput("\u001b[6~");
  const scrolled = overlay.render(48);
  assert.ok(scrolled.some((line) => line.includes("REACHABLE_SUFFIX")));
  assert.ok(scrolled.every((line) => visibleWidth(line) === 48));
});

test("dashboard preserves navigation and running-job actions", () => {
  const actions: unknown[] = [];
  const { overlay, renders } = dashboard([job("first", "completed"), job("second")], 24, (action) => actions.push(action));
  overlay.handleInput("j");
  overlay.handleInput("x");
  assert.ok(renders() >= 1);
  assert.deepEqual(actions, [{ type: "cancel", jobId: "second" }]);
});

test("dashboard dispose clears its refresh timer", () => {
  let cleared = 0;
  const overlay = createDashboardOverlay(
    { requestRender: () => {} } as never,
    theme,
    { matches: () => false } as unknown as KeybindingsManager,
    { list: () => [] },
    () => {},
    {
      setInterval: (() => 42) as unknown as typeof setInterval,
      clearInterval: (() => { cleared++; }) as unknown as typeof clearInterval,
    },
  );
  overlay.dispose();
  overlay.dispose();
  assert.equal(cleared, 1);
});
