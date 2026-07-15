import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  MAX_COLLAPSED_LINES,
  MAX_EXPANDED_LINES,
  buildWorkflowCardLines,
  renderWorkflowCall,
  renderWorkflowCard,
} from "../extensions/workflows/render.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

const ESC = "\u001b";
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

function workflow(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const createdAt = 1_000;
  return {
    runId: "run-0123456789abcdef",
    sessionId: "session-1",
    name: "Release readiness",
    description: "Review, verify, and summarize the release",
    background: true,
    status: "running",
    timestamps: { createdAt, updatedAt: 3_000, startedAt: 2_000 },
    currentPhase: 1,
    phases: [
      { index: 0, name: "Review", status: "completed", timestamps: { createdAt, updatedAt: 2_000 }, agents: [0] },
      { index: 1, name: "Verification", status: "running", timestamps: { createdAt, updatedAt: 3_000 }, agents: [1] },
    ],
    agents: [
      {
        index: 0, label: "reviewer", role: "reviewer", phase: 0, state: "completed",
        timestamps: { createdAt, updatedAt: 2_000 }, backend: "claude", model: "sonnet",
        preview: "Review complete", output: "Review complete", usage: { input: 1_200, output: 300, cacheRead: 50, cacheWrite: 0, cost: 0.01, turns: 2 },
      },
      {
        index: 1, label: "tests", role: "worker", phase: 1, state: "running",
        timestamps: { createdAt, updatedAt: 3_000 }, backend: "codex", model: "gpt-5",
        preview: "Running targeted tests", usage: { input: 800, output: 200, cacheRead: 0, cacheWrite: 20, cost: 0.02, turns: 1 },
      },
    ],
    artifactDir: "/private/workflows/run-0123456789abcdef",
    ...overrides,
  };
}

test("workflow call renderer is sanitized, descriptive, and width-safe", () => {
  const component = renderWorkflowCall(
    `${ESC}[31mRelease${ESC}[0m\u0007`,
    `${ESC}]0;hostile\u0007verify\nall targets`,
    true,
    ansiTheme,
  );
  for (const width of [0, 1, 8, 24, 64]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.join("").includes("\u001b]"), false);
  }
  const plain = component.render(120).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(plain, /Workflow Release/);
  assert.match(plain, /background/);
  assert.match(plain, /verify all targets/);
});

test("workflow cards enforce hard collapsed and expanded budgets with a dashboard pointer", () => {
  const huge = workflow({
    status: "failed",
    timestamps: { createdAt: 1_000, updatedAt: 5_000, startedAt: 2_000, endedAt: 5_000 },
    error: `${ESC}[31mworkflow failed${ESC}[0m\nsecond\nthird\nfourth`,
    result: Array.from({ length: 2_000 }, (_, index) => `result ${index} ${ESC}[2K`).join("\n"),
    phases: Array.from({ length: 30 }, (_, index) => ({
      index, name: `phase ${index}\u0000`, status: index < 29 ? "completed" as const : "failed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 5_000 }, agents: [index],
    })),
    agents: Array.from({ length: 30 }, (_, index) => ({
      index, label: `agent ${index}\u0007`, role: "worker", phase: index,
      state: index < 29 ? "completed" as const : "failed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 5_000 }, preview: `preview ${index}`,
      usage: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 10, cost: 0.01, turns: 1 },
    })),
  });

  const collapsed = buildWorkflowCardLines(huge, theme, { expanded: false, now: 6_000 });
  assert.ok(collapsed.length <= MAX_COLLAPSED_LINES);
  assert.ok(collapsed.at(-1)?.includes("/workflows"));
  assert.ok(collapsed.some((line) => line.includes("phase")));
  assert.ok(collapsed.some((line) => line.includes("agent")));
  assert.ok(collapsed.some((line) => line.includes("↑")));

  const expanded = buildWorkflowCardLines(huge, theme, { expanded: true, now: 6_000 });
  assert.ok(expanded.length <= MAX_EXPANDED_LINES);
  assert.ok(expanded.at(-1)?.includes("/workflows"));
  assert.ok(expanded.every((line) => !CONTROL_CHARS.test(line)));
});

test("partial workflow cards show recent sanitized previews and retain the pointer", () => {
  const partial = workflow({
    agents: workflow().agents.map((agent, index) => ({
      ...agent,
      preview: `${ESC}[31magent ${index}${ESC}[0m\nlatest ${index}\u0007`,
    })),
  });
  const lines = buildWorkflowCardLines(partial, theme, {
    expanded: false,
    isPartial: true,
    expandHint: "Alt+E expand",
    now: 4_000,
  });
  assert.ok(lines.length <= MAX_COLLAPSED_LINES);
  assert.ok(lines.some((line) => line.includes("latest 1")));
  assert.ok(lines.at(-1)?.includes("updating"));
  assert.ok(lines.at(-1)?.includes("/workflows"));
  assert.ok(lines.every((line) => !CONTROL_CHARS.test(line)));
});

test("workflow card components remain width-safe at narrow Unicode terminal widths", () => {
  const snapshot = workflow({
    name: "验证发布流程".repeat(20),
    description: "👩🏽‍💻 verify every target ".repeat(30),
    result: { summary: "结果".repeat(300) },
  });
  for (const width of [0, 1, 3, 12, 31, 80]) {
    for (const expanded of [false, true]) {
      const lines = renderWorkflowCard(snapshot, ansiTheme, { expanded, now: 5_000 }).render(width);
      assert.ok(lines.length <= (expanded ? MAX_EXPANDED_LINES : MAX_COLLAPSED_LINES));
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `width=${width} expanded=${expanded}`);
    }
  }
});

test("workflow cards tolerate non-JSON result values", () => {
  const symbolResult = workflow({ status: "completed", result: Symbol("release-ready") });
  const lines = renderWorkflowCard(symbolResult, theme, { expanded: true, now: 5_000 }).render(80);
  assert.ok(lines.some((line) => line.includes("release-ready")));
  assert.ok(lines.length <= MAX_EXPANDED_LINES);
});
