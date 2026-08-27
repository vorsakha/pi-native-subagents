import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ansiTheme, theme } from "./helpers.ts";
import {
  MAX_COLLAPSED_LINES,
  MAX_EXPANDED_LINES,
  buildWorkflowCardLines,
  formatWorkflowConvergence,
  renderWorkflowCall,
  renderWorkflowCard,
  workflowConvergenceMeta,
  workflowPhaseProgress,
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

test("header marker follows the attention branch: quiet for a successful completion, full color for paused", () => {
  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;

  const completed = workflow({ status: "completed", taskOutcome: "successful" });
  const completedHeader = buildWorkflowCardLines(completed, coloredTheme, { expanded: false, now: 6_000 })[0]!;
  assert.ok(completedHeader.includes("[muted]◆"), "a successful completion uses the neutral marker rather than its own success glyph");
  assert.ok(completedHeader.includes("[dim]· completed"), "the status text stays dim once nothing needs attention");

  const paused = workflow({ status: "paused" });
  const pausedHeader = buildWorkflowCardLines(paused, coloredTheme, { expanded: false, now: 6_000 })[0]!;
  assert.ok(pausedHeader.includes("[warning]Ⅱ"), "a paused workflow keeps its own full-color glyph since it needs attention");
  assert.ok(pausedHeader.includes("[warning]· paused"), "the status text stays full color when attention is warranted");
});

test("collapsed and expanded cards share one budget-health verdict: unsupported metrics are named and abnormal, concurrency saturation is not", () => {
  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;

  const unsupportedCost = workflow({ budget: { maxCost: 1 } });
  const collapsedUnsupported = buildWorkflowCardLines(unsupportedCost, coloredTheme, { expanded: false, now: 6_000 });
  assert.ok(collapsedUnsupported.some((line) => line.includes("cost unsupported")), "the collapsed card names the unsupported Codex maxCost metric instead of reporting budget ok");
  assert.ok(collapsedUnsupported.every((line) => !line.includes("budget ok")), "an unsupported explicit metric is never folded into budget ok");
  assert.ok(collapsedUnsupported.some((line) => line.includes("[warning]") && line.includes("cost unsupported")), "the unsupported metric is marked abnormal");
  const expandedUnsupported = buildWorkflowCardLines(unsupportedCost, coloredTheme, { expanded: true, now: 6_000 });
  assert.ok(expandedUnsupported.some((line) => line.includes("Budget") && line.includes("[warning]")), "the expanded Budget row uses the same abnormal verdict");

  const saturated = workflow({ budget: { maxConcurrency: 1 } });
  const collapsedSaturated = buildWorkflowCardLines(saturated, coloredTheme, { expanded: false, now: 6_000 });
  assert.ok(collapsedSaturated.some((line) => line.includes("budget ok")), "reaching maxConcurrency alone is normal temporary scheduling saturation");
  assert.ok(collapsedSaturated.every((line) => !line.includes("reached") && !/Usage.*\[warning\]/.test(line)), "concurrency saturation is never presented as exhausted spend or a warning");
  const expandedSaturated = buildWorkflowCardLines(saturated, coloredTheme, { expanded: true, now: 6_000 });
  assert.ok(expandedSaturated.some((line) => line.includes("Budget") && !line.includes("[warning]")), "the expanded Budget row agrees that saturation alone is not abnormal");

  const agentsExhausted = workflow({ budget: { maxAgents: 2 } });
  const collapsedExhausted = buildWorkflowCardLines(agentsExhausted, coloredTheme, { expanded: false, now: 6_000 });
  assert.ok(collapsedExhausted.some((line) => line.includes("reached (agents)")), "hard call exhaustion remains distinct and accurately named");
});

test("the phase spine stays bounded for many phases while the current/total fraction stays authoritative", () => {
  const many = workflow({
    currentPhase: 6,
    plannedPhaseCount: 12,
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

test("shared phase progress distinguishes declared, dynamic, terminal, and no-phase states", () => {
  const declared = workflow({
    currentPhase: null,
    plannedPhaseCount: 6,
    phases: Array.from({ length: 6 }, (_, index) => phase({ index, name: `declared ${index}` })),
  });
  assert.equal(workflowPhaseProgress(declared).label, "0/6");
  declared.currentPhase = 0;
  assert.equal(workflowPhaseProgress(declared).label, "1/6");

  const dynamic = workflow({ currentPhase: 1 });
  assert.equal(workflowPhaseProgress(dynamic).label, "2/?");
  for (const status of ["completed", "failed", "aborted"] as const) {
    const terminal = workflow({ status, currentPhase: 1 });
    assert.equal(workflowPhaseProgress(terminal).label, "2/2");
    assert.equal(workflowPhaseProgress(terminal, 0).label, "1/2");
    assert.equal(workflowPhaseProgress(terminal, 1).label, "2/2");
  }

  const declaredTerminal = workflow({
    status: "completed",
    currentPhase: null,
    plannedPhaseCount: 6,
    phases: Array.from({ length: 6 }, (_, index) => phase({ index, name: `declared ${index}` })),
  });
  const declaredTerminalProgress = workflowPhaseProgress(declaredTerminal);
  assert.equal(declaredTerminalProgress.label, "0/6");
  assert.equal(declaredTerminalProgress.phase, undefined);
  assert.equal(declaredTerminalProgress.phaseIndex, -1);
  const declaredTerminalCard = buildWorkflowCardLines(declaredTerminal, theme, { expanded: true, now: 4_000 }).join("\n");
  assert.match(declaredTerminalCard, /0\/6.*not started/);
  assert.doesNotMatch(declaredTerminalCard, /›/);

  const activeWithoutPhases = workflow({ currentPhase: null, phases: [] });
  assert.equal(workflowPhaseProgress(activeWithoutPhases).label, "waiting");
  assert.match(buildWorkflowCardLines(activeWithoutPhases, theme, { expanded: true, now: 4_000 }).join("\n"), /waiting for the first phase/);
  const terminalWithoutPhases = workflow({ status: "completed", currentPhase: null, phases: [] });
  assert.equal(workflowPhaseProgress(terminalWithoutPhases).label, "no phases");
  assert.doesNotMatch(buildWorkflowCardLines(terminalWithoutPhases, theme, { expanded: true, now: 4_000 }).join("\n"), /waiting for the first phase/);

  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
  const activePhasesLine = buildWorkflowCardLines(activeWithoutPhases, coloredTheme, { expanded: true, now: 4_000 }).find((line) => line.startsWith("[dim]Phases"))!;
  assert.ok(activePhasesLine.includes("[accent]●"), "before any phase exists, the phase slot still carries the workflow's own live status glyph");
  const terminalPhasesLine = buildWorkflowCardLines(terminalWithoutPhases, coloredTheme, { expanded: true, now: 4_000 }).find((line) => line.startsWith("[dim]Phases"))!;
  assert.ok(terminalPhasesLine.includes("[success]✓"), "a workflow that finishes with no phases recorded still shows its terminal status glyph in the phase slot");
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

test("styled header and phase spine truncate cleanly at narrow widths with a real ANSI theme", () => {
  const snapshot = workflow();
  const narrow = renderWorkflowCard(snapshot, ansiTheme, { expanded: false, now: 6_000 }).render(20);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 20), "escape sequences never count toward the visible width budget");
  const narrowHeader = narrow[0]!;
  assert.ok(narrowHeader.includes(ESC), "the header still applies theme styling at a narrow width");
  assert.ok(narrowHeader.includes("Release"), "the name survives truncation alongside real escape sequences");
  const phasesLine = narrow.find((line) => line.includes("Phases"))!;
  assert.ok(phasesLine.includes(ESC), "the phase spine still applies theme styling at a narrow width");
});

test("collapsed cards keep only the phase spine loud for routine running state; the header and agent rollup stay quiet", () => {
  const allRunning = workflow({
    status: "running",
    agents: [
      agent({ index: 0, name: "reviewer", state: "running" }),
      agent({ index: 1, name: "tests", state: "running" }),
      agent({ index: 2, name: "docs", state: "running" }),
    ],
  });
  const lines = buildWorkflowCardLines(allRunning, theme, { expanded: false, now: 6_000 });
  const [header] = lines;
  const phasesLine = lines.find((line) => line.startsWith("Phases"))!;
  const agentsLine = lines.find((line) => line.startsWith("Agents"))!;

  assert.ok(!header!.includes("●"), "the header no longer duplicates the phase spine's running dot");
  assert.ok(header!.includes("◆"), "the header uses a neutral marker for a routine (non-attention) status");
  assert.ok(header!.includes("running"), "the overall status is still stated once, as text, in the header");
  assert.ok(phasesLine.includes("●"), "the phase spine still carries the current phase's running dot");
  assert.match(agentsLine, /\b3 active\b/, "a uniformly running roster collapses to a compact readable count, not glyph-heavy per-state tallies");
  assert.doesNotMatch(agentsLine, /[●○✓×]/, "the compact count carries no per-state status glyphs");
});

test("mixed-state agent rollups stay textual and readable, and failures/queued remain distinguishable without glyphs or color alone", () => {
  const mixed = workflow({
    agents: [
      agent({ index: 0, name: "reviewer", state: "completed" }),
      agent({ index: 1, name: "tests", state: "running" }),
      agent({ index: 2, name: "lint", state: "queued" }),
      agent({ index: 3, name: "security", state: "failed" }),
    ],
  });
  const agentsLine = buildWorkflowCardLines(mixed, theme, { expanded: false, now: 6_000 }).find((line) => line.startsWith("Agents"))!;

  assert.doesNotMatch(agentsLine, /[●○✓×]/, "the collapsed rollup no longer carries per-state status glyphs");
  assert.match(agentsLine, /\bqueued\b/);
  assert.match(agentsLine, /\brunning\b/);
  assert.match(agentsLine, /\bdone\b/);
  assert.match(agentsLine, /\bfailed\b/);

  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
  const coloredAgentsLine = buildWorkflowCardLines(mixed, coloredTheme, { expanded: false, now: 6_000 }).find((line) => line.startsWith("[dim]Agents"))!;
  assert.ok(coloredAgentsLine.includes("[error]1 failed"), "the failed count keeps its attention color as reinforcement, on top of its own word");
});

test("a waiting agent renders distinctly from failed/queued, is excluded from the failure count, and never shows credential data", () => {
  const waiting = workflow({
    agents: [
      agent({
        index: 0,
        name: "quota-check",
        state: "waiting",
        providerWait: {
          provider: "claude",
          kind: "quota",
          scope: "five_hour",
          detail: "Claude reported a rate_limit rejection (five_hour)",
          retryAt: 6_000 + 12 * 60_000,
          attempt: 1,
          maxAttempts: 2,
        },
      }),
    ],
  });
  const lines = buildWorkflowCardLines(waiting, theme, { expanded: false, now: 6_000 });
  const header = lines[0]!;
  assert.doesNotMatch(header, /×1/, "a waiting agent is never counted as a header failure");

  const agentsLine = lines.find((line) => line.startsWith("Agents"))!;
  assert.match(agentsLine, /\bwaiting\b/);
  assert.doesNotMatch(agentsLine, /\bfailed\b/, "waiting is distinct from failed in the rollup");

  const latestLine = lines.find((line) => line.startsWith("Latest"))!;
  assert.match(latestLine, /waiting for claude quota/);
  assert.match(latestLine, /attempt 1\/2/);
  assert.doesNotMatch(latestLine, /@/, "no email or account identifier ever appears in the rendered wait reason");

  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
  const coloredAgentsLine = buildWorkflowCardLines(waiting, coloredTheme, { expanded: false, now: 6_000 }).find((line) => line.startsWith("[dim]Agents"))!;
  assert.ok(coloredAgentsLine.includes("[warning]1 waiting"), "waiting keeps an attention color distinct from failed/error");
});

test("a used provider fallback renders as a route transition, never as provider waiting", () => {
  const snapshot = workflow({
    status: "completed",
    currentPhase: 0,
    phases: [phase({ index: 0, name: "work", status: "completed", agents: [0] })],
    agents: [agent({
      state: "completed",
      harness: "codex",
      providerFallback: { harness: "codex" },
      attempts: [{
        index: 0,
        harness: "claude",
        requestedHarness: "claude",
        disposition: "fallback",
        trigger: { source: "provider", provider: "claude", kind: "quota", detail: "quota exhausted" },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      }],
    })],
  });
  const rendered = buildWorkflowCardLines(snapshot, theme, { expanded: true, now: 6_000 }).join("\n");
  assert.match(rendered, /claude → codex \(fallback\)/);
  assert.doesNotMatch(rendered, /waiting for .*quota/i);
});

test("Latest identifies the focused agent by name plus its activity, without a status glyph, and never just repeats the word running", () => {
  const withPreview = workflow({
    agents: [
      agent({ index: 0, name: "reviewer", state: "completed" }),
      agent({ index: 1, name: "reliability-security", state: "running", preview: "scanning dependency advisories" }),
    ],
  });
  const previewLine = buildWorkflowCardLines(withPreview, theme, { expanded: false, now: 6_000 }).find((line) => line.startsWith("Latest"))!;
  assert.match(previewLine, /reliability-security.* · scanning dependency advisories/);

  const runningNoPreview = workflow({ agents: [agent({ index: 0, name: "tests", state: "running" })] });
  const runningLine = buildWorkflowCardLines(runningNoPreview, theme, { expanded: false, now: 6_000 }).find((line) => line.startsWith("Latest"))!;
  assert.doesNotMatch(runningLine, /[●○✓×]/, "the Latest row carries no status glyph");
  assert.doesNotMatch(runningLine, /\brunning\b/, "quiet fallback copy avoids repeating the header's already-stated running status");
  assert.match(runningLine, /in progress/);

  const queuedNoPreview = workflow({ agents: [agent({ index: 0, name: "tests", state: "queued" })] });
  const queuedLine = buildWorkflowCardLines(queuedNoPreview, theme, { expanded: false, now: 6_000 }).find((line) => line.startsWith("Latest"))!;
  assert.match(queuedLine, /waiting to start/);
});

test("Latest renders the resolved model and explicit effort as one dim suffix after the emphasized name", () => {
  const snapshot = workflow({
    agents: [agent({
      name: "tests",
      state: "running",
      model: "codex-fixture-model",
      effort: "high",
      preview: "Running targeted tests",
    })],
  });
  const plainLine = buildWorkflowCardLines(snapshot, theme, { expanded: false, now: 6_000 })
    .find((line) => line.startsWith("Latest"));
  assert.equal(plainLine, "Latest   tests(codex-fixture-model·high) · Running targeted tests");

  const styledTheme = {
    ...theme,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as unknown as Theme;
  const styledLine = buildWorkflowCardLines(snapshot, styledTheme, { expanded: false, now: 6_000 })
    .find((line) => line.includes("<dim>Latest"));
  assert.equal(
    styledLine,
    "<dim>Latest  </dim> <toolTitle>tests</toolTitle><dim>(codex-fixture-model·high)</dim> <dim>·</dim> <muted>Running targeted tests</muted>",
  );
});

test("Latest renders omitted effort as adaptive and truncates safely after the readable agent name", () => {
  const snapshot = workflow({
    agents: [agent({
      name: "tests",
      state: "running",
      model: "codex-fixture-model",
      preview: "Running targeted tests",
    })],
  });
  const plainLine = buildWorkflowCardLines(snapshot, theme, { expanded: false, now: 6_000 })
    .find((line) => line.startsWith("Latest"));
  assert.equal(plainLine, "Latest   tests(codex-fixture-model·adaptive) · Running targeted tests");

  const width = 24;
  const narrow = renderWorkflowCard(snapshot, ansiTheme, { expanded: false, now: 6_000 }).render(width);
  assert.ok(narrow.every((line) => visibleWidth(line) <= width));
  const latestLine = narrow.find((line) => line.includes("Latest"));
  assert.ok(latestLine?.includes("tests"), "the focused agent name remains readable");
  assert.ok(latestLine?.includes("…"), "the existing truncation behavior adds an ellipsis");
});

test("expanded phase and agent rosters demote routine glyphs, keeping only current selection and failure/warning states attention-worthy", () => {
  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
  const snapshot = workflow({
    currentPhase: 1,
    phases: [
      phase({ index: 0, name: "inspect", status: "completed", agents: [0] }),
      phase({ index: 1, name: "verify", status: "running", agents: [1] }),
      phase({ index: 2, name: "ship", status: "failed", agents: [2] }),
    ],
    agents: [
      agent({ index: 0, name: "reviewer", state: "completed" }),
      agent({ index: 1, name: "tests", state: "running" }),
      agent({ index: 2, name: "release", state: "failed" }),
    ],
  });
  const lines = buildWorkflowCardLines(snapshot, coloredTheme, { expanded: true, now: 6_000 });
  // Roster rows (phases and agents) are the only lines indented under the shared label gutter.
  const rosterLines = lines.filter((line) => line.startsWith(" ".repeat(9)));

  const inspectRow = rosterLines.find((line) => line.includes("inspect"))!;
  assert.ok(inspectRow.includes("[dim]✓"), "a completed, non-current phase is demoted to dim");
  assert.ok(!inspectRow.includes("[success]✓"), "the completed phase no longer competes with attention states for the eye");

  const verifyRow = rosterLines.find((line) => line.includes("verify"))!;
  assert.ok(verifyRow.includes("[accent]›"), "the current phase keeps its selection marker at full color");
  assert.ok(verifyRow.includes("[accent]●"), "the current phase's own status glyph stays undemoted alongside the selection marker");

  const shipRow = rosterLines.find((line) => line.includes("ship"))!;
  assert.ok(shipRow.includes("[error]×"), "a failed phase keeps its full attention color regardless of position");

  const reviewerRow = rosterLines.find((line) => line.includes("reviewer"))!;
  assert.ok(reviewerRow.includes("[dim]✓"), "a completed agent row is demoted to dim");

  const releaseRow = rosterLines.find((line) => line.includes("release"))!;
  assert.ok(releaseRow.includes("[error]×"), "a failed agent row keeps its full attention color");
});

test("the neutral header marker and quiet rollups stay inside hard width budgets, even at narrow widths", () => {
  const snapshot = workflow({
    agents: [agent({ index: 0, name: "reliability-security-and-compliance-review", state: "running" })],
  });
  const wide = renderWorkflowCard(snapshot, theme, { expanded: false, now: 6_000 }).render(200);
  assert.ok(wide.every((line) => visibleWidth(line) <= 200));
  assert.ok(wide[0]!.includes("◆"), "the neutral workflow marker renders at ample width");

  const narrow = renderWorkflowCard(snapshot, theme, { expanded: false, now: 6_000 }).render(24);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24), "no line overflows a narrow terminal width even with a long agent name");
});

test("convergence state reads without color: distinct glyphs, round position, verdict, and stopping reason", () => {
  const base = {
    name: "issue 24",
    round: 2,
    maxRounds: 3,
    verdict: "request_changes" as const,
    actionableCount: 2,
    fingerprint: "abc",
    rounds: [
      { round: 1, verdict: "request_changes" as const, actionableCount: 2, fingerprint: "abc" },
      { round: 2, verdict: "request_changes" as const, actionableCount: 2, fingerprint: "abc" },
    ],
  };
  const states = ["running", "approved", "blocked", "stalled", "limit-reached", "failed"] as const;
  const glyphs = states.map((state) => workflowConvergenceMeta({ state }).glyph);
  assert.equal(new Set(glyphs).size, states.length, "every convergence state has its own glyph");

  for (const state of states) {
    const line = formatWorkflowConvergence({ ...base, state, stoppingReason: state === "running" ? undefined : `stopped: ${state}` });
    assert.match(line, /issue 24 · round 2\/3/);
    assert.ok(line.includes(state), `${state} is named in words, not only by color`);
    assert.match(line, /verdict request_changes · 2 actionable findings/);
  }

  // The collapsed card keeps its line budget and truncates a long stopping reason.
  const snapshot = workflow({
    status: "completed",
    convergence: { ...base, state: "stalled", stoppingReason: "z".repeat(400) },
  });
  const collapsed = buildWorkflowCardLines(snapshot, theme, { expanded: false, now: 6_000 });
  const rounds = collapsed.find((line) => line.startsWith("Rounds"));
  assert.ok(rounds, "the card reports convergence rounds");
  assert.ok(rounds.includes("stalled") && rounds.includes("≡"), "the terminal state is shown in words and with a glyph");
  assert.ok(rounds.length < 200, "a long stopping reason is truncated on the collapsed card");
  assert.ok(collapsed.length <= MAX_COLLAPSED_LINES);
  assert.ok(!CONTROL_CHARS.test(collapsed.join("\n")));

  const narrow = renderWorkflowCard(snapshot, ansiTheme, { expanded: false, now: 6_000 }).render(20);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 20, `narrow line overflows: ${JSON.stringify(line)}`);

  const withoutConvergence = buildWorkflowCardLines(workflow(), theme, { expanded: false, now: 6_000 });
  assert.ok(!withoutConvergence.some((line) => line.startsWith("Rounds")), "one-shot workflows gain no convergence line");
});
