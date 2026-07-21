import test from "node:test";
import assert from "node:assert/strict";
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
        index: 0, name: "reviewer", access: "readOnly", independent: true, phase: 0, state: "completed",
        timestamps: { createdAt, updatedAt: 2_000 }, backend: "claude", model: "claude-fixture-model",
        preview: "Review complete", output: "Review complete", usage: { input: 1_200, output: 300, cacheRead: 50, cacheWrite: 0, cost: 0.01, turns: 2 },
      },
      {
        index: 1, name: "tests", access: "full", independent: false, phase: 1, state: "running",
        timestamps: { createdAt, updatedAt: 3_000 }, backend: "codex", model: "codex-fixture-model",
        preview: "Running targeted tests", usage: { input: 800, output: 200, cacheRead: 0, cacheWrite: 20, cost: 0.02, turns: 1 },
      },
    ],
    artifactDir: "/private/workflows/run-0123456789abcdef",
    ...overrides,
  };
}

test("workflow cards enforce one budget, sanitization, and dashboard-pointer contract", () => {
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
      index, name: `agent ${index}\u0007`, access: "full", independent: false, phase: index,
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

  const callLines = renderWorkflowCall("Release readiness", "Review and verify", false, theme).render(100);
  assert.ok(callLines[0]?.startsWith("⌁"));
  const cardLines = renderWorkflowCard(workflow(), theme, { expanded: false, now: 6_000 }).render(100);
  assert.ok(cardLines.every((line) => line.startsWith("│")), "workflow result rows use the trace continuation rail");
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: false, now: 6_000 }).some((line) => line.includes("●")));
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: false, now: 6_500 }).every((line) => !line.includes("●")), "active workflow state uses a two-frame blink");

  const expanded = buildWorkflowCardLines(huge, theme, { expanded: true, now: 6_000 });
  assert.ok(expanded.length <= MAX_EXPANDED_LINES);
  assert.ok(expanded.at(-1)?.includes("/workflows"));
  assert.ok(expanded.every((line) => !CONTROL_CHARS.test(line)));
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: true, now: 6_000 }).some((line) => line.includes("independent")), "cross-provider independence is visible in workflow cards");
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
  assert.ok(lines.at(-1)?.includes("/workflows"));
  assert.ok(lines.every((line) => !line.includes("updating")), "active state is conveyed by the blink, not redundant copy");
  assert.ok(lines.every((line) => !CONTROL_CHARS.test(line)));
});
