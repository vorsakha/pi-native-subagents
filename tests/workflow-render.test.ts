import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import {
  MAX_COLLAPSED_LINES,
  MAX_EXPANDED_LINES,
  buildWorkflowCardLines,
  renderWorkflowCall,
  renderWorkflowCard,
} from "../extensions/workflows/render.ts";
import { shortId } from "../extensions/subagents/render.ts";
import type { WorkflowAgentRecord, WorkflowPhase, WorkflowSnapshot } from "../src/workflows/types.ts";

const ESC = "\u001b";
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

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
    logs: [{ index: 0, message: "Verification is underway", at: 3_000 }],
    agents: [
      {
        index: 0, name: "reviewer", access: "readOnly", independent: true, phase: 0, state: "completed",
        timestamps: { createdAt, updatedAt: 2_000 }, harness: "claude", model: "claude-fixture-model",
        preview: "Review complete", output: "Review complete", usage: { input: 1_200, output: 300, cacheRead: 50, cacheWrite: 0, cost: 0.01, turns: 2 },
      },
      {
        index: 1, name: "tests", access: "full", independent: false, phase: 1, state: "running",
        timestamps: { createdAt, updatedAt: 3_000 }, harness: "codex", model: "codex-fixture-model",
        preview: "Running targeted tests", usage: { input: 800, output: 200, cacheRead: 0, cacheWrite: 20, cost: 0.02, turns: 1 },
      },
    ],
    artifactDir: "/private/workflows/run-0123456789abcdef",
    ...overrides,
  };
}

function phase(overrides: Partial<WorkflowPhase>): WorkflowPhase {
  return {
    index: 0, name: "phase", status: "pending", timestamps: { createdAt: 1_000, updatedAt: 1_000 }, agents: [],
    ...overrides,
  };
}

function agent(overrides: Partial<WorkflowAgentRecord>): WorkflowAgentRecord {
  return {
    index: 0, name: "agent", access: "full", independent: false, phase: 0, state: "queued",
    timestamps: { createdAt: 1_000, updatedAt: 1_000 }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    ...overrides,
  };
}

test("workflow cards enforce one budget, sanitization, and dashboard-pointer contract", () => {
  const huge = workflow({
    status: "failed",
    timestamps: { createdAt: 1_000, updatedAt: 5_000, startedAt: 2_000, endedAt: 5_000 },
    error: `${ESC}[31mworkflow failed${ESC}[0m\nsecond\nthird\nfourth`,
    result: Array.from({ length: 2_000 }, (_, index) => `result ${index} ${ESC}[2K`).join("\n"),
    phases: Array.from({ length: 30 }, (_, index) => phase({
      index, name: `phase ${index}\u0000`, status: index < 29 ? "completed" as const : "failed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 5_000 }, agents: [index],
    })),
    agents: Array.from({ length: 30 }, (_, index) => agent({
      index, name: `agent ${index}\u0007`, access: "full", independent: false, phase: index,
      state: index < 29 ? "completed" as const : "failed" as const,
      timestamps: { createdAt: 1_000, updatedAt: 5_000 }, preview: `preview ${index}`,
      usage: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 10, cost: 0.01, turns: 1 },
    })),
  });

  const collapsed = buildWorkflowCardLines(huge, theme, { expanded: false, now: 6_000 });
  assert.ok(collapsed.length <= MAX_COLLAPSED_LINES);
  assert.ok(collapsed.at(-1)?.includes("/workflows"));
  assert.ok(collapsed.some((line) => line.includes("phase")), "the current phase name is visible");
  assert.ok(collapsed.some((line) => line.includes("29 done") && line.includes("1 failed")), "collapsed agents are a bare count rollup");
  assert.ok(collapsed.every((line) => !line.includes("effort") && !line.includes("claude-fixture-model")), "collapsed rollup carries no policy or model noise");
  assert.ok(collapsed.every((line) => !line.includes("Verification is underway")), "collapsed cards drop the narrator log to stay inside budget");
  assert.ok(collapsed.some((line) => line.includes("↑")));
  assert.ok(collapsed.some((line) => line.includes("budget")), "budget health is folded into collapsed Usage");

  const callLines = renderWorkflowCall("Release readiness", "Review and verify", false, theme).render(100);
  assert.ok(callLines[0]?.startsWith("⌁"));
  const cardLines = renderWorkflowCard(workflow(), theme, { expanded: false, now: 6_000 }).render(100);
  assert.ok(cardLines.every((line) => line.startsWith("│")), "workflow result rows use the trace continuation rail");
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: false, now: 6_000 }).some((line) => line.includes("●")));
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: false, now: 6_500 }).some((line) => line.includes("●")), "active workflow state uses a static indicator");

  const expanded = buildWorkflowCardLines(huge, theme, { expanded: true, now: 6_000 });
  assert.ok(expanded.length <= MAX_EXPANDED_LINES);
  assert.ok(expanded.at(-1)?.includes("/workflows"));
  assert.ok(expanded.every((line) => !CONTROL_CHARS.test(line)));
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: true, now: 6_000 }).some((line) => line.includes("independent")), "cross-provider independence is visible in workflow cards");
  assert.ok(buildWorkflowCardLines(workflow(), theme, { expanded: true, now: 6_000 }).some((line) => line.includes("Verification is underway")), "the narrator log is a labeled group in expanded cards");
  const flagged = workflow();
  flagged.agents[1]!.outputProvenance = "subagent";
  flagged.agents[1]!.instructionShaped = true;
  assert.ok(buildWorkflowCardLines(flagged, theme, { expanded: true, now: 6_000 }).some((line) => line.includes("instruction-like output")), "instruction-shaped child output is visibly flagged");
  const partial = workflow({
    agents: workflow().agents.map((candidate, index) => ({
      ...candidate,
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
  assert.ok(lines.some((line) => line.includes("latest 1")), "collapsed Latest identifies the focused agent's current activity");
  assert.ok(lines.at(-1)?.includes("/workflows"));
  assert.ok(lines.every((line) => !line.includes("updating")), "active state is conveyed by the blink, not redundant copy");
  assert.ok(lines.every((line) => !CONTROL_CHARS.test(line)));
});

test("workflow cards show lifecycle, task outcome, and open or unsupported budget state", () => {
  const completed = workflow({
    status: "completed",
    taskOutcome: "unsuccessful",
    result: { ok: false },
    timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000, endedAt: 3_000 },
  });
  const open = buildWorkflowCardLines(completed, theme, { expanded: true, now: 4_000 });
  assert.ok(open.some((line) => line.includes("completed") && line.includes("task unsuccessful")));
  assert.ok(open.some((line) => line.includes("!")));
  assert.ok(open.some((line) => line.startsWith("Budget") && line.includes("open")));

  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
  const colored = buildWorkflowCardLines(completed, coloredTheme, { expanded: true, now: 4_000 });
  assert.ok(colored.some((line) => line.includes("[warning]!") && line.includes("[warning]· completed · task unsuccessful")));

  const active = buildWorkflowCardLines(workflow({ taskOutcome: undefined }), theme, { expanded: true, now: 4_000 });
  assert.ok(active.every((line) => !line.includes("task unspecified")), "active task outcome stays pending by omission");

  const unsupported = buildWorkflowCardLines(workflow({ budget: { maxCost: 1 } }), theme, { expanded: true, now: 4_000 });
  assert.ok(unsupported.some((line) => line.includes("cost unsupported")));

  const settled = buildWorkflowCardLines(completed, theme, { expanded: false, now: 4_000 });
  assert.ok(settled.some((line) => line.startsWith("Result")), "settled collapsed cards report Result, not Latest");
});

test("the phase spine stays bounded for many phases while the current/total fraction stays authoritative", () => {
  const many = workflow({
    currentPhase: 6,
    phases: Array.from({ length: 12 }, (_, index) => phase({
      index, name: `phase ${index}`, status: index < 6 ? "completed" as const : index === 6 ? "running" as const : "pending" as const,
    })),
  });
  const collapsed = buildWorkflowCardLines(many, theme, { expanded: false, now: 6_000 });
  const phasesLine = collapsed.find((line) => line.startsWith("Phases"));
  assert.ok(phasesLine, "a Phases group is always present");
  assert.ok(phasesLine!.includes("7/12"), "the fraction reports the true position out of the true total, independent of windowing");
  assert.ok(phasesLine!.includes("⋯"), "a bounded spine marks hidden phases rather than listing all 12");
  assert.ok(collapsed.length <= MAX_COLLAPSED_LINES);

  const expanded = buildWorkflowCardLines(many, theme, { expanded: true, now: 6_000 });
  assert.ok(expanded.length <= MAX_EXPANDED_LINES);
  assert.ok(expanded.some((line) => line.includes("phase 6")), "the roster window is centered on the current phase");
  assert.ok(expanded.some((line) => line.includes("earlier phase")), "hidden earlier phases are called out by count");
});

test("abnormal warning and failure counts sit before elapsed time in the header, ahead of mode and run id", () => {
  const abnormal = workflow({
    warnings: ["budget approaching limit", "slow tool response"],
    agents: [
      agent({ index: 0, name: "reviewer", state: "failed" }),
      agent({ index: 1, name: "tests", state: "running" }),
    ],
  });
  const [header] = buildWorkflowCardLines(abnormal, theme, { expanded: false, now: 6_000 });
  const warningIndex = header!.indexOf("⚠2");
  const failureIndex = header!.indexOf("×1");
  const elapsedIndex = header!.indexOf("· 4s");
  const modeIndex = header!.indexOf("· bg");
  const runIdIndex = header!.indexOf(shortId("run-0123456789abcdef"));
  assert.ok(warningIndex > 0 && failureIndex > warningIndex, "warnings and failures appear right after status, in that order");
  assert.ok(elapsedIndex > failureIndex, "abnormal counts precede elapsed time");
  assert.ok(modeIndex > elapsedIndex && runIdIndex > modeIndex, "mode and run id trail last so width truncation drops them first");

  const clean = buildWorkflowCardLines(workflow(), theme, { expanded: false, now: 6_000 });
  assert.ok(clean.every((line) => !line.includes("⚠") && !line.includes("×")), "a healthy workflow shows no abnormal header markers");
});

test("collapsed agent rows are always a count rollup, never per-agent policy detail", () => {
  const mixed = workflow({
    agents: [
      agent({ index: 0, name: "reviewer", state: "completed" }),
      agent({ index: 1, name: "tests", state: "running", harness: "codex", model: "codex-fixture-model" }),
      agent({ index: 2, name: "lint", state: "running" }),
      agent({ index: 3, name: "docs", state: "queued" }),
      agent({ index: 4, name: "security", state: "failed" }),
    ],
  });
  const collapsed = buildWorkflowCardLines(mixed, theme, { expanded: false, now: 6_000 });
  const agentsLine = collapsed.find((line) => line.startsWith("Agents"));
  assert.ok(agentsLine, "an Agents group is always present");
  assert.ok(agentsLine!.includes("5"), "the rollup reports the total agent count");
  assert.ok(agentsLine!.includes("2 running") && agentsLine!.includes("1 done") && agentsLine!.includes("1 failed") && agentsLine!.includes("1 queued"));
  assert.ok(!agentsLine!.includes("codex-fixture-model") && !agentsLine!.includes("effort"), "no policy or model noise leaks into the collapsed rollup");
  assert.ok(collapsed.every((line) => !line.includes("reviewer") && !line.includes("security")), "collapsed cards never name individual agents in the rollup row");
});

test("narrow widths keep the left-loaded header and drop mode/run id before the name", () => {
  const snapshot = workflow();
  const wide = renderWorkflowCard(snapshot, theme, { expanded: false, now: 6_000 }).render(200);
  assert.ok(wide.every((line) => visibleWidth(line) <= 200));
  const wideHeader = wide[0]!;
  assert.ok(wideHeader.includes("Release readiness"));
  assert.ok(wideHeader.includes(shortId("run-0123456789abcdef")), "at ample width the run id is present");
  assert.ok(wideHeader.includes("· bg"), "at ample width the mode is present");

  const narrow = renderWorkflowCard(snapshot, theme, { expanded: false, now: 6_000 }).render(16);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 16), "no line wraps or overflows the terminal width");
  const narrowHeader = narrow[0]!;
  assert.ok(narrowHeader.includes("Release"), "the name survives truncation at a narrow width");
  assert.ok(!narrowHeader.includes(shortId("run-0123456789abcdef")), "the run id truncates away before the name at a narrow width");
  assert.ok(!narrowHeader.includes("bg"), "the mode truncates away before the name at a narrow width");
});
