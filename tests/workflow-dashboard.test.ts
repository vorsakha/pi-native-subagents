import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, visibleWidth } from "@earendil-works/pi-tui";
import { tempDir, theme, tick } from "./helpers.ts";
import {
  createWorkflowsDashboardOverlay,
  openWorkflowsDashboard,
  type WorkflowsDashboardAction,
} from "../extensions/workflows/dashboard.ts";
import { dashboardLayout } from "../extensions/dashboard-style.ts";
import { checkpointWorkflow, createWorkflowArtifacts, loadWorkflowSummaries } from "../src/workflows/artifacts.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";
import type { TranscriptEntry } from "../src/types.ts";

initTheme("dark", false);

const ENTER = "\r";
const ESCAPE = "\u001b";
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const CTRL_D = "\u0004";
const CTRL_T = String.fromCharCode(20);
const SHIFT_UP = "\u001b[1;2A";

function workflow(id: string, status: WorkflowSnapshot["status"] = "running"): WorkflowSnapshot {
  const settledAgentState = status === "pending" ? "queued" as const : status === "paused" ? "running" as const : status;
  const terminal = status === "completed" || status === "failed" || status === "aborted";
  return {
    runId: id,
    sessionId: "session",
    name: `Release ${id}`,
    description: "Review and verify Unicode output 你好世界",
    background: true,
    status,
    timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000, ...(status === "paused" ? { pausedAt: 3_000 } : {}), ...(terminal ? { endedAt: 4_000 } : {}) },
    currentPhase: 0,
    phases: [{ index: 0, name: "Verification", status, timestamps: { createdAt: 1_000, updatedAt: 3_000 }, agents: [0, 1] }],
    agents: [
      {
        index: 0, callIndex: 0, name: "review", access: "readOnly", independent: false, phase: 0, state: status === "running" || status === "paused" ? "completed" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000 }, harness: "claude", model: "claude-fixture-model", effort: "high",
        jobId: "review-job-0001", prompt: "Review the implementation", tools: [{ id: "read-1", name: "read", summary: "src/index.ts", status: "completed" }],
        output: "review result", preview: "review result", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
      },
      {
        index: 1, callIndex: 1, name: "tests", access: "full", independent: false, phase: 0, state: status === "running" || status === "paused" ? "running" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000 }, harness: "codex", model: "codex-fixture-model", effort: "medium",
        jobId: "tests-job-0002", prompt: "\u001b[31mRun the affected tests\u001b[0m", liveThinking: "\u001b]0;bad\u0007checking failures", tools: [{ id: "bash-1", name: "bash", summary: "npm test", status: "running" }],
        output: Array.from({ length: 60 }, (_, index) => `test result ${index}`).join("\n"), preview: "test result 59",
        usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0, cost: 0.02, turns: 2 },
      },
    ],
    result: "workflow result",
    artifactDir: `/private/${id}`,
  };
}

interface HarnessOptions {
  fullscreen?: boolean;
  focusRunId?: string;
  cancelBinding?: string;
  renderMarkdown?: (text: string, width: number) => string[];
  theme?: Theme;
  getKeys?: (binding: string) => string[];
}

/** Live-manager calls the overlay makes directly, applied in place while it stays mounted. */
type WorkflowManagerAction =
  | { type: "cancel"; runId: string }
  | { type: "cancelAgent"; runId: string; agentIndex: number }
  | { type: "pause"; runId: string }
  | { type: "resume"; runId: string }
  | { type: "restartAgent"; runId: string; agentIndex: number };

function harness(
  runs: WorkflowSnapshot[],
  rows = 30,
  done: (action: WorkflowsDashboardAction) => void = () => {},
  options: HarnessOptions = {},
) {
  let renders = 0;
  const listeners = new Set<(snapshot: WorkflowSnapshot) => void>();
  const checked: string[] = [];
  const actions: WorkflowManagerAction[] = [];
  const manager = {
    list: () => runs,
    check: (runId: string) => {
      checked.push(runId);
      const run = runs.find((candidate) => candidate.runId === runId);
      if (!run) throw new Error("unknown run");
      return run;
    },
    cancel: async (runId: string) => {
      actions.push({ type: "cancel", runId });
      return runs.find((candidate) => candidate.runId === runId)!;
    },
    cancelAgent: async (runId: string, agentIndex: number) => {
      actions.push({ type: "cancelAgent", runId, agentIndex });
      const run = runs.find((candidate) => candidate.runId === runId)!;
      const agent = run.agents.find((candidate) => candidate.index === agentIndex);
      if (agent) agent.state = "cancelled";
      return run;
    },
    pause: async (runId: string) => {
      actions.push({ type: "pause", runId });
      const run = runs.find((candidate) => candidate.runId === runId)!;
      run.status = "paused";
      return run;
    },
    resume: async (runId: string) => {
      actions.push({ type: "resume", runId });
      const run = runs.find((candidate) => candidate.runId === runId)!;
      run.status = "running";
      return run;
    },
    restartAgent: async (runId: string, agentIndex: number) => {
      actions.push({ type: "restartAgent", runId, agentIndex });
      return { snapshot: runs.find((candidate) => candidate.runId === runId)! };
    },
    subscribe: (listener: (snapshot: WorkflowSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const terminal = { rows };
  const tui = {
    requestRender: () => { renders++; },
    terminal,
    ...(options.fullscreen ? { mode: "fullscreen" } : {}),
  } as never;
  const overlay = createWorkflowsDashboardOverlay(
    tui,
    options.theme ?? theme,
    {
      matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === (options.cancelBinding ?? "\u0003"),
      ...(options.getKeys ? { getKeys: options.getKeys } : {}),
    } as unknown as KeybindingsManager,
    manager,
    // `done` is reserved for close; every other action applies in place via the manager mock above.
    done,
    {
      now: () => 65_000,
      renderMarkdown: options.renderMarkdown,
      focusRunId: options.focusRunId,
      fullscreen: options.fullscreen,
    },
  );
  return {
    overlay,
    manager,
    actions,
    checked,
    renders: () => renders,
    setRows(nextRows: number) {
      terminal.rows = nextRows;
    },
    emit(runId = runs[0]?.runId) {
      const snapshot = runs.find((run) => run.runId === runId);
      if (snapshot) for (const listener of listeners) listener(snapshot);
    },
  };
}

function assertPanel(lines: string[], width: number, rows: number): void {
  assert.equal(lines.length, rows);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `a dashboard line exceeds ${width} columns`);
}

test("workflow dashboard uses adaptive geometry and exact fullscreen or regular row budgets", (t) => {
  const fullHarness = harness([workflow("geometry")], 30, () => {}, { fullscreen: true });
  const regularHarness = harness([workflow("regular")], 30);
  t.after(() => { fullHarness.overlay.dispose(); regularHarness.overlay.dispose(); });

  assert.equal(dashboardLayout(120, 30).kind, "wide");
  assert.equal(dashboardLayout(72, 30).kind, "medium");
  assert.equal(dashboardLayout(52, 30).kind, "narrow");
  assert.equal(dashboardLayout(120, 8).kind, "narrow");

  const wide = fullHarness.overlay.render(120);
  assertPanel(wide, 120, 30);
  assert.ok(wide.some((line) => line.includes("┬")), "wide mode has side-by-side run rail and inspector");
  assert.equal(regularHarness.overlay.render(120).length, 24, "regular overlay stays within 80% of 30 rows");
  assert.ok(regularHarness.overlay.render(72).some((line) => line.includes("workflow")), "medium mode keeps a stacked inspector");
  assert.ok(!regularHarness.overlay.render(52).some((line) => line.includes("┬")), "narrow mode renders one pane");

  const short = harness([workflow("short")], 8, () => {}, { fullscreen: true }).overlay;
  t.after(() => short.dispose());
  assertPanel(short.render(120), 120, 8);
  assert.equal(dashboardLayout(120, 8).kind, "narrow", "short screens use one predictable pane");
});

test("workflow dashboard marks completed unsuccessful runs with warning color", (t) => {
  const run = workflow("unsuccessful", "completed");
  run.taskOutcome = "unsuccessful";
  run.result = { ok: false };
  const coloredTheme = { ...theme, fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
  const state = harness([run], 30, () => {}, { theme: coloredTheme });
  t.after(() => state.overlay.dispose());
  const rendered = state.overlay.render(200).join("\n");
  assert.match(rendered, /\[warning[^\n]*! completed/);
  assert.match(rendered, /! completed · task unsuccessful/);
});

test("minimum-width live run and agent cancellation keep Unicode controls visible through confirmation", (t) => {
  const runState = harness([workflow("cancel-run")], 30, () => {}, { fullscreen: true });
  runState.manager.list()[0]!.name = "Release 你好👩🏽‍💻";
  t.after(() => runState.overlay.dispose());

  const runHint = runState.overlay.render(40);
  assertPanel(runHint, 40, 30);
  assert.ok(runHint.some((line) => line.includes("X cancel")), "the minimum-width run hint exposes cancellation");
  runState.overlay.handleInput("X");
  const runConfirmation = runState.overlay.render(40);
  assert.ok(runConfirmation.some((line) => line.includes("Press X again to confirm")));
  runState.overlay.handleInput("X");
  assert.deepEqual(runState.actions.at(-1), { type: "cancel", runId: "cancel-run" });

  const agentState = harness([workflow("cancel-agent")], 30, () => {}, { fullscreen: true });
  t.after(() => agentState.overlay.dispose());
  agentState.overlay.render(40);
  agentState.overlay.handleInput(ENTER);
  agentState.overlay.handleInput("\t");
  const agentHint = agentState.overlay.render(40);
  assertPanel(agentHint, 40, 30);
  assert.ok(agentHint.some((line) => line.includes("x cancel")), "the minimum-width agent hint exposes cancellation");
  agentState.overlay.handleInput("x");
  const agentConfirmation = agentState.overlay.render(40);
  assert.ok(agentConfirmation.some((line) => line.includes("Press x again to confirm")));
  agentState.overlay.handleInput("x");
  assert.deepEqual(agentState.actions.at(-1), { type: "cancelAgent", runId: "cancel-agent", agentIndex: 1 });
});

test("workflow results use native Markdown while transcript roles and workflow metadata remain inspectable", (t) => {
  const markdown = workflow("markdown", "completed");
  markdown.agents[0]!.transcript = [
    { kind: "user", text: "**inspect this literally**" },
    { kind: "thinking", text: "considering options" },
    { kind: "assistant", text: "\u001b[31m# Verdict\u001b[0m\n\n**PASS**" },
    { kind: "tool", toolId: "t1", name: "read", text: "file.ts" },
  ];
  const sources: string[] = [];
  // Tall enough that the full-mode Pi tool render and every surrounding row
  // fit without scrolling, so tail-following after the toggle can't hide any of them.
  const { overlay } = harness([markdown], 55, () => {}, {
    renderMarkdown: (text) => {
      sources.push(text);
      return ["\u001b[1mVerdict\u001b[0m", "\u001b[32mPASS\u001b[0m"];
    },
  });
  t.after(() => overlay.dispose());

  overlay.render(72);
  overlay.handleInput("\r");
  const compactLines = overlay.render(72);
  assert.ok(compactLines.some((line) => line.includes("1 tool call") && line.includes("read")), "compact mode is the default in the agent pane");
  assert.ok(!compactLines.some((line) => line.includes("file.ts")), "compact mode omits the per-tool detail row");

  sources.length = 0;
  overlay.handleInput("t");
  const lines = overlay.render(72);
  assert.deepEqual(sources, ["# Verdict\n\n**PASS**", "review result"], "assistant transcript and distinct final result use Markdown");
  assert.ok(lines.some((line) => line.includes("\u001b[1mVerdict\u001b[0m")));
  assert.ok(lines.some((line) => line.includes("> **inspect this literally**")));
  assert.ok(lines.some((line) => line.includes("~ considering options")));
  assert.ok(lines.some((line) => line.includes("read") && line.includes("file.ts")), "full mode renders the tool through Pi's native execution component");
  assert.ok(lines.some((line) => line.includes("Prompt · Review the implementation")));
  assert.ok(lines.some((line) => line.includes("effort high")));

  const standalone = workflow("standalone", "completed");
  standalone.agents = [];
  standalone.phases[0]!.agents = [];
  standalone.result = "## Summary\n\n- one\n- two";
  const resultSources: string[] = [];
  const resultOverlay = harness([standalone], 30, () => {}, {
    renderMarkdown: (text) => {
      resultSources.push(text);
      return ["\u001b[1mSummary\u001b[0m", "• one", "• two"];
    },
  }).overlay;
  t.after(() => resultOverlay.dispose());
  assert.ok(resultOverlay.render(72).some((line) => line.includes("\u001b[1mSummary\u001b[0m")));
  assert.deepEqual(resultSources, ["## Summary\n\n- one\n- two"]);

  standalone.result = false;
  resultSources.length = 0;
  resultOverlay.render(72);
  assert.deepEqual(resultSources, ["```json\nfalse\n```"]);

  const failed = workflow("failed-agent", "failed");
  failed.agents[0]!.state = "failed";
  failed.agents[0]!.error = "Agent output did not match the requested JSON Schema";
  failed.agents[0]!.structured = { clean: false };
  failed.agents[0]!.transcript = undefined;
  failed.agents[0]!.output = undefined;
  const failedSources: string[] = [];
  const failedOverlay = harness([failed], 30, () => {}, {
    renderMarkdown: (text) => {
      failedSources.push(text);
      return text.split("\n");
    },
  }).overlay;
  t.after(() => failedOverlay.dispose());
  failedOverlay.render(72);
  failedOverlay.handleInput("\r");
  const failedLines = failedOverlay.render(72);
  assert.ok(failedLines.some((line) => line.includes("did not match")));
  assert.ok(failedSources.includes("```json\n{\n  \"clean\": false\n}\n```"));

  const stress = workflow("bounded-sections", "failed");
  const stressAgent = stress.agents[0]!;
  stressAgent.state = "failed";
  stressAgent.error = `${"long error context ".repeat(80)}ERROR_SUFFIX`;
  stressAgent.prompt = "prompt context ".repeat(200);
  stressAgent.liveThinking = "thinking context ".repeat(200);
  stressAgent.structured = { details: `${"structured context ".repeat(400)}STRUCTURED_SUFFIX` };
  stressAgent.transcript = [{ kind: "assistant", text: `${"transcript context ".repeat(1_000)}TRANSCRIPT_SUFFIX` }];
  stressAgent.output = `distinct final ${"result context ".repeat(600)}FINAL_SUFFIX`;
  const stressOverlay = harness([stress], 32, () => {}, {
    renderMarkdown: (text, width) => text.split("\n").flatMap((line) => {
      const value = line || " ";
      return Array.from({ length: Math.max(1, Math.ceil(value.length / width)) }, (_, index) => value.slice(index * width, (index + 1) * width));
    }),
  }).overlay;
  t.after(() => stressOverlay.dispose());
  stressOverlay.render(60);
  stressOverlay.handleInput("\r");
  stressOverlay.handleInput("\r");
  stressOverlay.handleInput("g");
  const seen = new Set<string>();
  for (let page = 0; page < 40; page++) {
    const rendered = stressOverlay.render(60);
    assertPanel(rendered, 60, 25);
    for (const line of rendered) seen.add(line);
    stressOverlay.handleInput(PAGE_DOWN);
  }
  const allDetail = [...seen].join("\n");
  for (const section of ["Error", "Prompt", "Activity", "Structured result", "Transcript", "Final result"]) {
    assert.match(allDetail, new RegExp(section));
  }
  const compactDetail = allDetail.replace(/[\s│║]+/g, "");
  assert.match(compactDetail, /ERROR_SUFFIX/);
  assert.match(compactDetail, /STRUCTURED_SUFFIX/);
  assert.match(compactDetail, /TRANSCRIPT_SUFFIX/);
  assert.match(compactDetail, /FINAL_SUFFIX/);
});

test("agent detail activity does not duplicate tool detail already shown in the transcript", (t) => {
  const run = workflow("no-duplication", "completed");
  const agent = run.agents[0]!;
  agent.liveThinking = "narrowing down the failing assertion";
  agent.tools = [{ id: "bash-1", name: "bash", summary: "DISTINCT_TOOL_SUMMARY_MARKER", status: "completed" }];
  agent.transcript = [
    { kind: "assistant", text: "investigating" },
    { kind: "tool", toolId: "bash-1", name: "bash", text: "DISTINCT_TOOL_SUMMARY_MARKER" },
  ];

  // Tall enough that the full-mode Pi tool render and every surrounding row fit
  // without scrolling, so tail-following after the toggle can't hide any of them.
  const { overlay } = harness([run], 40, () => {}, { renderMarkdown: (text) => text.split("\n") });
  t.after(() => overlay.dispose());

  overlay.render(72);
  overlay.handleInput(ENTER);
  const compactLines = overlay.render(72);
  assert.ok(!compactLines.some((line) => line.includes("DISTINCT_TOOL_SUMMARY_MARKER")), "compact mode is the default and does not surface per-tool detail anywhere, including Activity");
  assert.ok(compactLines.some((line) => line.includes("Activity") && line.includes("narrowing down the failing assertion")), "the Activity section still surfaces live semantic progress in compact mode");

  overlay.handleInput("t");
  const lines = overlay.render(72);
  assert.ok(lines.some((line) => line.includes("DISTINCT_TOOL_SUMMARY_MARKER")), "the tool lifecycle row still appears in the Transcript section in full mode, via Pi's native execution component");
  assert.ok(lines.some((line) => line.includes("Activity") && line.includes("narrowing down the failing assertion")), "the Activity section still surfaces live semantic progress");

  const activityLine = lines.find((line) => line.includes("Activity"));
  assert.ok(activityLine && !activityLine.includes("DISTINCT_TOOL_SUMMARY_MARKER"), "the Activity section does not repeat the tool detail already in the transcript");
  const toolMentions = lines.filter((line) => line.includes("DISTINCT_TOOL_SUMMARY_MARKER"));
  assert.equal(toolMentions.length, 1, "tool detail is rendered exactly once, in the transcript, not duplicated in Activity");
});

test("narrow workflows drill from runs to overview to agent, with layered Escape and Pi cancel backtracking", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const { overlay, actions } = harness([workflow("narrow")], 30, (action) => closed.push(action));
  t.after(() => overlay.dispose());

  overlay.render(52);
  assert.ok(overlay.render(52).some((line) => line.includes("Enter open")));
  for (const input of ["p", "h", "l", "f", "x", PAGE_DOWN, "r"]) overlay.handleInput(input);
  assert.deepEqual(actions, [], "the narrow run list accepts only its displayed controls");
  assert.ok(overlay.render(52).some((line) => line.includes("runs ·")));
  overlay.handleInput(ENTER);
  assert.ok(overlay.render(52).some((line) => line.includes("workflow · phase")));
  overlay.handleInput(ENTER);
  assert.ok(overlay.render(52).some((line) => line.includes("agent ·")));
  for (const input of ["p", "j", "l", "f", "\t", ENTER]) overlay.handleInput(input);
  assert.deepEqual(actions, [], "the narrow agent pane accepts only its displayed controls");
  assert.ok(overlay.render(52).some((line) => line.includes("agent ·")));

  overlay.handleInput(ESCAPE);
  assert.ok(overlay.render(52).some((line) => line.includes("workflow · phase")));
  overlay.handleInput("\u0003");
  assert.ok(overlay.render(52).some((line) => line.includes("runs ·")));
  overlay.handleInput("\u0003");
  assert.deepEqual(closed, [{ type: "close" }]);
});

test("narrow workflow overview keeps h and Left available for previous-phase navigation", (t) => {
  const current = workflow("narrow-phases");
  const [firstPhase] = current.phases;
  current.phases = [
    { ...firstPhase!, index: 0, name: "First phase", agents: [0] },
    { ...firstPhase!, index: 1, name: "Second phase", agents: [1] },
  ];
  current.currentPhase = 0;
  current.agents[0]!.phase = 0;
  current.agents[1]!.phase = 1;
  const { overlay } = harness([current], 30);
  t.after(() => overlay.dispose());

  overlay.render(52);
  overlay.handleInput(ENTER);
  assert.match(overlay.render(52).join("\n"), /workflow · phase 1\/\?/);
  assert.match(overlay.render(52).join("\n"), /First phase/);

  overlay.handleInput("l");
  const second = overlay.render(52).join("\n");
  assert.match(second, /workflow · phase 2\/\?/);
  assert.match(second, /Second phase/);

  overlay.handleInput("h");
  const first = overlay.render(52).join("\n");
  assert.match(first, /workflow · phase 1\/\?/);
  assert.match(first, /First phase/);
  assert.doesNotMatch(first, /Enter open/, "h navigates phases instead of returning to the hidden run list");
});

test("workflow dashboard shares declared totals and terminal no-phase wording with inline cards", (t) => {
  const declared = workflow("declared-dashboard");
  const template = declared.phases[0]!;
  declared.plannedPhaseCount = 6;
  declared.currentPhase = null;
  declared.phases = Array.from({ length: 6 }, (_, index) => ({
    ...template,
    index,
    name: ["One", "Two", "Three", "Four", "Five", "Six"][index]!,
    status: "pending" as const,
    agents: [],
  }));
  const declaredState = harness([declared], 30);
  t.after(() => declaredState.overlay.dispose());
  declaredState.overlay.render(52);
  declaredState.overlay.handleInput(ENTER);
  const declaredText = declaredState.overlay.render(52).join("\n");
  assert.match(declaredText, /workflow · phase 0\/6/);
  assert.match(declaredText, /Phase 0\/6.*no current phase/);

  const terminal = workflow("terminal-no-phase", "completed");
  terminal.currentPhase = null;
  terminal.phases = [];
  terminal.agents = [];
  const terminalState = harness([terminal], 30);
  t.after(() => terminalState.overlay.dispose());
  const terminalRun = terminalState.overlay.render(52).join("\n");
  assert.match(terminalRun, /phase no phases/);
  terminalState.overlay.handleInput(ENTER);
  const terminalText = terminalState.overlay.render(52).join("\n");
  assert.match(terminalText, /no phases recorded/);
  assert.doesNotMatch(terminalText, /waiting for the first phase/);
});

test("terminal dynamic dashboard selection reports selected phase positions", (t) => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    const run = workflow(`terminal-${status}`, status);
    const template = run.phases[0]!;
    run.currentPhase = 1;
    run.phases = [
      { ...template, index: 0, name: "First", status },
      { ...template, index: 1, name: "Second", status },
    ];
    const state = harness([run], 30);
    t.after(() => state.overlay.dispose());
    state.overlay.render(52);
    state.overlay.handleInput(ENTER);
    assert.match(state.overlay.render(52).join("\n"), /workflow · phase 2\/2/);
    state.overlay.handleInput("h");
    assert.match(state.overlay.render(52).join("\n"), /workflow · phase 1\/2/);
    state.overlay.handleInput("l");
    assert.match(state.overlay.render(52).join("\n"), /workflow · phase 2\/2/);
  }
});

test("agent actions and hints require the selected agent to survive the final overview viewport", (t) => {
  const clipped = workflow("clipped-agent");
  clipped.description = "A workflow with enough metadata to clip its agent roster";
  clipped.approval = "plan";
  clipped.definitionFingerprint = "definition-fingerprint";
  clipped.warnings = ["warning one", "warning two"];
  clipped.logs = [0, 1, 2].map((index) => ({ index, message: `log ${index}`, at: 1_000 + index }));

  const harnessState = harness([clipped], 10, () => {}, { fullscreen: true });
  t.after(() => harnessState.overlay.dispose());

  harnessState.overlay.render(52);
  harnessState.overlay.handleInput(ENTER);
  harnessState.overlay.handleInput("\t");
  const overview = harnessState.overlay.render(52).join("\n");
  assert.doesNotMatch(overview, /r restart agent/);
  assert.doesNotMatch(overview, /x cancel agent/);

  harnessState.overlay.handleInput("r");
  harnessState.overlay.handleInput("x");
  assert.deepEqual(harnessState.actions, [], "hidden agents cannot receive agent actions");
});

test("metadata-rich agent inspectors reserve result rows at medium and short heights", (t) => {
  const rich = workflow("metadata-rich", "completed");
  const agent = rich.agents[0]!;
  agent.context = { tokens: 32_000, window: 128_000, servingModel: "served-model" };
  agent.isolation = { type: "worktree", state: "preserved", branch: "feature/metadata", changed: true, patchArtifact: "metadata.patch" };
  agent.outputProvenance = "replay";
  agent.instructionShaped = true;
  agent.independentOf = "producer-run";
  agent.replayedFrom = { runId: "source-run", callIndex: 3 };
  agent.replacedBy = { replacementRunId: "replacement-run", reason: "retry", at: 4_000 };
  agent.truncated = true;
  agent.error = "ERROR_METADATA";
  agent.prompt = "PROMPT_METADATA";
  agent.liveThinking = "ACTIVITY_METADATA";
  agent.structured = { value: "STRUCTURED_METADATA" };
  agent.transcript = [{ kind: "assistant", text: "assistant transcript" }];
  agent.output = "COMPLETED_OUTPUT_METADATA";

  const renderMarkdown = (text: string) => text.split("\n");
  const medium = harness([rich], 30, () => {}, { renderMarkdown });
  const short = harness([rich], 8, () => {}, { renderMarkdown });
  t.after(() => { medium.overlay.dispose(); short.overlay.dispose(); });

  medium.overlay.render(72);
  medium.overlay.handleInput(ENTER);
  const mediumInitial = medium.overlay.render(72).join("\n");
  assert.doesNotMatch(mediumInitial, /Detail 0\//, "medium metadata leaves a result viewport");
  assert.match(mediumInitial, /COMPLETED_OUTPUT_METADATA/);
  medium.overlay.handleInput("g");
  const mediumTop = medium.overlay.render(72).join("\n");
  medium.overlay.handleInput(PAGE_DOWN);
  const mediumPage = medium.overlay.render(72).join("\n");
  assert.notEqual(mediumPage, mediumTop, "Page Down advances the medium result body");
  medium.overlay.handleInput(PAGE_UP);
  assert.equal(medium.overlay.render(72).join("\n"), mediumTop, "Page Up returns to the medium top");
  medium.overlay.handleInput("G");
  assert.match(medium.overlay.render(72).join("\n"), /COMPLETED_OUTPUT_METADATA/);

  short.overlay.render(72);
  short.overlay.handleInput(ENTER);
  short.overlay.handleInput(ENTER);
  const shortInitial = short.overlay.render(72).join("\n");
  assert.doesNotMatch(shortInitial, /Detail 0\//, "short metadata leaves a result viewport");
  assert.match(shortInitial, /COMPLETED_OUTPUT_METADATA/);
  short.overlay.handleInput("g");
  const shortTop = short.overlay.render(72).join("\n");
  assert.match(shortTop, /Metadata|ERROR_METADATA/);
  short.overlay.handleInput(PAGE_DOWN);
  assert.notEqual(short.overlay.render(72).join("\n"), shortTop, "Page Down advances the short result body");
  short.overlay.handleInput("G");
  assert.match(short.overlay.render(72).join("\n"), /COMPLETED_OUTPUT_METADATA/);
});

test("provider fallback dashboard metadata sanitizes every model route", (t) => {
  const run = workflow("fallback-sanitization", "completed");
  const agent = run.agents[0]!;
  agent.harness = "codex";
  agent.model = "final\n\u001b[31mMODEL";
  agent.requestedHarness = "codex";
  agent.providerFallback = { harness: "codex", model: "declared\n\u001b[32mMODEL" };
  agent.attempts = [{
    index: 0,
    harness: "claude",
    requestedHarness: "claude",
    model: "primary\n\u001b[33mMODEL",
    disposition: "fallback",
    trigger: { source: "provider", provider: "claude", kind: "quota", detail: "quota" },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  }];
  const state = harness([run], 30, () => {}, { theme });
  t.after(() => state.overlay.dispose());

  state.overlay.render(100);
  state.overlay.handleInput(ENTER);
  const inspector = state.overlay.render(100).join("\n");
  assert.match(inspector, /Provider fallback · used · declared codex\/declared MODEL/);
  assert.match(inspector, /Attempt 1 · claude\/primary MODEL/);
  assert.match(inspector, /Final route · codex\/final MODEL/);
  assert.doesNotMatch(inspector, /\u001b\[(?:31|32|33)m/, "caller-controlled model ANSI never reaches the dashboard");
});

test("metadata-rich standalone workflow results keep a scrollable result row", (t) => {
  const standalone = workflow("metadata-standalone", "completed");
  standalone.agents = [];
  standalone.phases[0]!.agents = [];
  standalone.approval = "plan";
  standalone.definitionFingerprint = "standalone-definition";
  standalone.warnings = ["warning one", "warning two"];
  standalone.logs = [0, 1, 2].map((index) => ({ index, message: `activity ${index}`, at: 1_000 + index }));
  standalone.result = Array.from({ length: 40 }, (_, index) => `standalone result ${index}`).join("\n");

  const state = harness([standalone], 8, () => {}, {
    fullscreen: true,
    renderMarkdown: (text) => text.split("\n"),
  });
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  state.overlay.handleInput(ENTER);
  const tail = state.overlay.render(52).join("\n");
  assert.doesNotMatch(tail, /Detail 0\//);
  assert.match(tail, /standalone result 39/);

  state.overlay.handleInput("g");
  assert.match(state.overlay.render(52).join("\n"), /Phase 1\/1|Verification/, "overflow metadata is reachable from the top");
  state.overlay.handleInput("G");
  assert.match(state.overlay.render(52).join("\n"), /standalone result 39/, "the result tail remains reachable after scrolling");
});

test("compact resize resets hidden workflow hierarchy and keeps Escape's close contract", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const state = harness([workflow("compact-resize")], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  state.overlay.handleInput(ENTER);
  state.overlay.handleInput(ENTER);
  assert.match(state.overlay.render(52).join("\n"), /agent ·/);
  state.overlay.handleInput("\t");
  state.overlay.handleInput("x");

  state.setRows(5);
  const compact = state.overlay.render(52);
  assertPanel(compact, 52, 5);
  assert.match(compact.join("\n"), /Esc close/);
  assert.doesNotMatch(compact.join("\n"), /workflow · phase|agent ·/);

  for (const input of [ENTER, "p", "r", "x", "X", PAGE_DOWN]) state.overlay.handleInput(input);
  assert.deepEqual(state.actions, [], "compact mode accepts only its displayed close control");

  state.setRows(30);
  const expanded = state.overlay.render(52).join("\n");
  assert.match(expanded, /Enter open/);
  assert.doesNotMatch(expanded, /workflow · phase|agent ·/);
  state.overlay.handleInput(ESCAPE);
  assert.deepEqual(closed, [{ type: "close" }], "Escape closes the reset compact hierarchy");
});

test("run, phase, and agent identities survive sorting, insertion, snapshots, filtering, and reordering", (t) => {
  const first = workflow("first");
  const second = workflow("second");
  const phaseTemplate = second.phases[0]!;
  second.phases = [
    { ...phaseTemplate, index: 10, name: "First phase", agents: [0] },
    { ...phaseTemplate, index: 20, name: "Second phase", agents: [1] },
  ];
  second.currentPhase = 10;
  second.agents[0]!.phase = 10;
  second.agents[1]!.phase = 20;
  const runs = [first, second];
  const { overlay, actions, emit } = harness(runs, 30);
  t.after(() => overlay.dispose());

  overlay.render(52);
  overlay.handleInput("j");
  assert.ok(overlay.render(52).some((line) => line.includes("Release sec")));
  runs.unshift(workflow("inserted"));
  runs.reverse();
  emit("second");
  assert.ok(overlay.render(52).some((line) => line.includes("Release sec")), "run selection follows runId after insertion and sorting");

  const selected = runs.find((run) => run.runId === "second")!;
  overlay.handleInput(ENTER);
  overlay.handleInput("l");
  const selectedPhase = overlay.render(52).join("\n");
  assert.match(selectedPhase, /Second phase/, "phase selection starts from a known phase identity");
  overlay.handleInput("\t");
  assert.ok(overlay.render(52).some((line) => line.includes("tests")), "agent selection starts from a known agent identity");

  selected.agents.reverse();
  selected.phases = [
    { ...selected.phases[1]!, index: 20, name: "Second phase refreshed", agents: [1] },
    { ...selected.phases[0]!, index: 10, name: "First phase refreshed", agents: [0] },
  ];
  selected.currentPhase = 20;
  selected.agents.find((agent) => agent.index === 0)!.phase = 10;
  selected.agents.find((agent) => agent.index === 1)!.phase = 20;
  emit("second");
  const refreshedLines = overlay.render(52);
  const refreshed = refreshedLines.join("\n");
  assert.match(refreshed, /Second phase refreshed/, "phase selection follows phase.index after reordering");
  assert.ok(refreshedLines.some((line) => line.includes("›") && line.includes("tests")), "agent selection follows agent.index after reordering");
  overlay.handleInput(ENTER);
  assert.match(overlay.render(52).join("\n"), /agent · tests/, "the refreshed agent identity remains visible");
  overlay.handleInput("x");
  overlay.handleInput("x");
  assert.deepEqual(actions.at(-1), { type: "cancelAgent", runId: "second", agentIndex: 1 }, "agent actions target the preserved identity");

  const fallback = harness(runs, 30);
  t.after(() => fallback.overlay.dispose());
  runs.splice(runs.findIndex((run) => run.runId === "second"), 1);
  fallback.emit("first");
  assert.ok(fallback.overlay.render(52).some((line) => line.includes("Release fir")), "removed run falls back deterministically");

  fallback.overlay.handleInput("X");
  assert.ok(fallback.overlay.render(52).some((line) => line.includes("Press X again")));
  fallback.overlay.handleInput("X");
  assert.deepEqual(fallback.actions.at(-1), { type: "cancel", runId: "first" });
});

test("scrolling clamps, follows live tails until unpinned, and reaches standalone workflow results", (t) => {
  const current = workflow("scroll");
  current.agents[0]!.output = Array.from({ length: 160 }, (_, index) => `line ${index}`).join("\n");
  current.agents[0]!.state = "completed";
  const { overlay, emit } = harness([current], 30);
  t.after(() => overlay.dispose());

  overlay.render(52);
  overlay.handleInput(ENTER);
  overlay.handleInput(ENTER);
  const tail = overlay.render(52).join("\n");
  assert.match(tail, /line 159/);
  overlay.handleInput("g");
  assert.match(overlay.render(52).join("\n"), /line 0/);
  overlay.handleInput(PAGE_DOWN);
  overlay.handleInput(CTRL_D);
  overlay.handleInput(SHIFT_UP);
  const pinned = overlay.render(52).join("\n");
  current.agents[0]!.output += "\nline 160";
  emit("scroll");
  assert.doesNotMatch(overlay.render(52).join("\n"), /line 160/, "upward scrolling unpins live tail following");
  overlay.handleInput("G");
  assert.match(overlay.render(52).join("\n"), /line 160/);
  assert.match(pinned, /line/);

  const standalone = workflow("workflow-result", "completed");
  standalone.agents = [];
  standalone.phases[0]!.agents = [];
  standalone.result = Array.from({ length: 140 }, (_, index) => `workflow line ${index}`).join("\n");
  const standaloneOverlay = harness([standalone], 30).overlay;
  t.after(() => standaloneOverlay.dispose());
  standaloneOverlay.render(52);
  standaloneOverlay.handleInput(ENTER);
  assert.match(standaloneOverlay.render(52).join("\n"), /workflow line 139/);
  standaloneOverlay.handleInput("g");
  assert.match(standaloneOverlay.render(52).join("\n"), /workflow line 0/);
  standaloneOverlay.handleInput("G");
  assert.match(standaloneOverlay.render(52).join("\n"), /workflow line 139/);
});

test("cancellation is two-step, disarms on other input, and actions use stable run and agent identities", (t) => {
  const agentRun = workflow("agent-action");
  const agentHarness = harness([agentRun], 30);
  t.after(() => agentHarness.overlay.dispose());
  agentHarness.overlay.render(52);
  agentHarness.overlay.handleInput(ENTER);
  agentHarness.overlay.handleInput("\t");
  agentHarness.overlay.handleInput("x");
  assert.ok(agentHarness.overlay.render(52).some((line) => line.includes("Press x again")));
  agentHarness.overlay.handleInput("g");
  assert.deepEqual(agentHarness.actions, [], "another key disarms agent cancellation");
  agentHarness.overlay.handleInput("x");
  agentHarness.overlay.handleInput("x");
  assert.deepEqual(agentHarness.actions.at(-1), { type: "cancelAgent", runId: "agent-action", agentIndex: 1 });

  const noJobRun = workflow("agent-without-job");
  noJobRun.agents[1]!.jobId = undefined;
  const noJobHarness = harness([noJobRun], 30);
  t.after(() => noJobHarness.overlay.dispose());
  noJobHarness.overlay.render(52);
  noJobHarness.overlay.handleInput(ENTER);
  noJobHarness.overlay.handleInput("\t");
  assert.doesNotMatch(noJobHarness.overlay.render(52).join("\n"), /x cancel agent/);
  noJobHarness.overlay.handleInput("x");
  noJobHarness.overlay.handleInput("x");
  assert.deepEqual(noJobHarness.actions, [], "an active agent without a jobId is not cancellable from the dashboard");

  const runHarness = harness([workflow("run-action")], 30);
  t.after(() => runHarness.overlay.dispose());
  runHarness.overlay.render(52);
  runHarness.overlay.handleInput("X");
  assert.ok(runHarness.overlay.render(52).some((line) => line.includes("Press X again")));
  runHarness.overlay.handleInput("x");
  assert.deepEqual(runHarness.actions, [], "a lowercase x does not confirm run cancellation");
  runHarness.overlay.handleInput("X");
  runHarness.overlay.handleInput("X");
  assert.deepEqual(runHarness.actions.at(-1), { type: "cancel", runId: "run-action" });

  const dismissed = harness([workflow("dismiss")], 30);
  t.after(() => dismissed.overlay.dispose());
  dismissed.overlay.render(52);
  dismissed.overlay.handleInput("X");
  dismissed.overlay.handleInput(ESCAPE);
  assert.deepEqual(dismissed.actions, [], "Escape dismisses an armed cancellation before navigation");
});

test("pause, resume, restart, filters, and configured cancel binding remain keyboard accessible", (t) => {
  const pause = harness([workflow("pause")], 30);
  t.after(() => pause.overlay.dispose());
  pause.overlay.render(72);
  pause.overlay.handleInput("p");
  assert.deepEqual(pause.actions.at(-1), { type: "pause", runId: "pause" });

  const resume = harness([workflow("resume", "paused")], 30);
  t.after(() => resume.overlay.dispose());
  resume.overlay.render(72);
  resume.overlay.handleInput("p");
  assert.deepEqual(resume.actions.at(-1), { type: "resume", runId: "resume" });

  const restart = harness([workflow("restart", "completed")], 30);
  t.after(() => restart.overlay.dispose());
  restart.overlay.render(72);
  restart.overlay.handleInput("r");
  assert.deepEqual(restart.actions.at(-1), { type: "restartAgent", runId: "restart", agentIndex: 0 });

  const filtered = harness([workflow("filter")], 30);
  t.after(() => filtered.overlay.dispose());
  filtered.overlay.render(52);
  filtered.overlay.handleInput(ENTER);
  filtered.overlay.handleInput(ENTER);
  filtered.overlay.handleInput("h");
  filtered.overlay.handleInput("f");
  const activeOnly = filtered.overlay.render(52);
  assert.ok(activeOnly.some((line) => line.includes("filter active")));
  assert.ok(activeOnly.some((line) => line.includes("tests")));
  assert.ok(!activeOnly.some((line) => line.includes("agent · review")), "a filtered-out inspected agent returns to the visible overview");

  const closed: WorkflowsDashboardAction[] = [];
  const bound = harness([workflow("binding")], 30, (action) => closed.push(action), { cancelBinding: "q" }).overlay;
  t.after(() => bound.dispose());
  bound.render(52);
  bound.handleInput(ENTER);
  bound.handleInput(ENTER);
  bound.handleInput("q");
  assert.ok(bound.render(52).some((line) => line.includes("workflow · phase")));
  bound.handleInput("q");
  assert.ok(bound.render(52).some((line) => line.includes("runs ·")));
  bound.handleInput("q");
  assert.deepEqual(closed, [{ type: "close" }]);
});

test("pause and resume apply in place, preserving phase, filter, and pane state without closing the dashboard", async (t) => {
  const run = workflow("inplace-pause");
  const template = run.phases[0]!;
  run.phases = [
    { ...template, index: 0, name: "First", agents: [0] },
    { ...template, index: 1, name: "Second", agents: [1] },
  ];
  run.currentPhase = 1;
  run.agents[0]!.phase = 0;
  run.agents[1]!.phase = 1;
  const closed: WorkflowsDashboardAction[] = [];
  const { overlay, actions } = harness([run], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(72);
  overlay.handleInput("f");
  const before = overlay.render(72).join("\n");
  assert.match(before, /filter active/);
  assert.match(before, /Second/, "the current phase is selected by default");

  overlay.handleInput("p");
  assert.deepEqual(actions.at(-1), { type: "pause", runId: "inplace-pause" });
  await tick();
  const paused = overlay.render(72).join("\n");
  assert.match(paused, /paused/);
  assert.match(paused, /filter active/, "the agent filter survives the in-place pause");
  assert.match(paused, /Second/, "the selected phase survives the in-place pause");
  assert.deepEqual(closed, [], "pausing does not close or reopen the dashboard");

  overlay.handleInput("p");
  assert.deepEqual(actions.at(-1), { type: "resume", runId: "inplace-pause" });
  await tick();
  const resumed = overlay.render(72).join("\n");
  assert.match(resumed, /running/);
  assert.match(resumed, /filter active/);
  assert.match(resumed, /Second/);
  assert.deepEqual(closed, []);
});

test("a rejected pause, resume, restart, agent-cancel, or run-cancel shows an in-panel notice and preserves dashboard state", async (t) => {
  const run = workflow("rejected-actions");
  const closed: WorkflowsDashboardAction[] = [];
  const { overlay, manager } = harness([run], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(72);
  overlay.handleInput("\t"); // select the running "tests" agent so restart/cancel stay actionable below

  manager.pause = (async () => { throw new Error("pause rejected"); }) as typeof manager.pause;
  overlay.handleInput("p");
  await tick();
  let after = overlay.render(72).join("\n");
  assert.match(after, /! pause rejected/);
  assert.match(after, /workflow · phase/, "the overview pane stays open after a rejected pause");
  assert.deepEqual(closed, []);

  manager.resume = (async () => { throw new Error("resume rejected"); }) as typeof manager.resume;
  run.status = "paused";
  overlay.handleInput("p");
  await tick();
  after = overlay.render(72).join("\n");
  assert.match(after, /! resume rejected/);
  assert.deepEqual(closed, []);

  manager.restartAgent = (async () => { throw new Error("restart rejected"); }) as typeof manager.restartAgent;
  overlay.handleInput("r");
  await tick();
  after = overlay.render(72).join("\n");
  assert.match(after, /! restart rejected/);
  assert.deepEqual(closed, []);

  manager.cancelAgent = (async () => { throw new Error("agent cancel rejected"); }) as typeof manager.cancelAgent;
  overlay.handleInput("x");
  overlay.handleInput("x");
  await tick();
  after = overlay.render(72).join("\n");
  assert.match(after, /! agent cancel rejected/);
  assert.deepEqual(closed, []);

  manager.cancel = (async () => { throw new Error("run cancel rejected"); }) as typeof manager.cancel;
  overlay.handleInput("X");
  overlay.handleInput("X");
  await tick();
  after = overlay.render(72).join("\n");
  assert.match(after, /! run cancel rejected/);
  assert.match(after, /workflow · phase/, "the dashboard remains open after every rejected action");
  assert.deepEqual(closed, [], "no rejected action closes the dashboard");
});

test("a restarted replacement run becomes selected in place, without tearing down the dashboard", async (t) => {
  const original = workflow("restart-original", "completed");
  const runsArray = [original];
  const closed: WorkflowsDashboardAction[] = [];
  const { overlay, manager } = harness(runsArray, 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => overlay.dispose());

  const replacement = workflow("restart-replacement");
  manager.restartAgent = (async () => {
    runsArray.push(replacement);
    return { snapshot: replacement };
  }) as typeof manager.restartAgent;

  overlay.render(72);
  overlay.handleInput("r");
  await tick();

  const after = overlay.render(72).join("\n");
  assert.match(after, /Release restart-replacement/, "the replacement run becomes selected");
  assert.deepEqual(closed, [], "restarting does not close or reopen the dashboard");
});

test("a successful agent or run cancellation applies in place, preserving phase and agent selection without closing the dashboard", async (t) => {
  const run = workflow("inplace-cancel");
  const closed: WorkflowsDashboardAction[] = [];
  const { overlay, actions } = harness([run], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(72);
  overlay.handleInput("\t"); // select the running "tests" agent
  overlay.render(72); // re-mark the newly selected agent visible before arming its cancellation
  overlay.handleInput("x");
  overlay.handleInput("x");
  assert.deepEqual(actions.at(-1), { type: "cancelAgent", runId: "inplace-cancel", agentIndex: 1 });
  await tick();
  let after = overlay.render(72).join("\n");
  assert.match(after, /workflow · phase/, "the overview pane stays open after a successful agent cancellation");
  assert.match(after, /tests/, "the cancelled agent remains selected and visible");
  assert.deepEqual(closed, []);

  overlay.handleInput("X");
  overlay.handleInput("X");
  assert.deepEqual(actions.at(-1), { type: "cancel", runId: "inplace-cancel" });
  await tick();
  after = overlay.render(72).join("\n");
  assert.match(after, /workflow · phase/, "the overview pane stays open after a successful run cancellation");
  assert.deepEqual(closed, [], "successful cancellation never closes or reopens the dashboard");
});

test("widths below the interactive threshold accept only Escape or the configured cancel binding", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const state = harness([workflow("tiny")], 30, (action) => closed.push(action), { fullscreen: true, cancelBinding: "q" });
  t.after(() => state.overlay.dispose());

  for (const width of [0, 1, 2, 3]) {
    const line = state.overlay.render(width);
    assertPanel(line, width, 1);
    for (const input of [ENTER, "p", "r", "x", "X", "j", "k", "h", "l", "f", "\t", "g", PAGE_UP, PAGE_DOWN, SHIFT_UP, CTRL_D]) {
      state.overlay.handleInput(input);
    }
    assert.deepEqual(state.actions, [], `width ${width} ignores every hidden control`);
  }

  state.overlay.render(2);
  state.overlay.handleInput("q");
  assert.deepEqual(closed, [{ type: "close" }], "the configured cancel binding still closes a sub-interactive-width panel");
});

test("Escape closes a sub-interactive-width panel, and an interactive width restores full navigation", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const escapeState = harness([workflow("escape-tiny")], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => escapeState.overlay.dispose());
  escapeState.overlay.render(3);
  escapeState.overlay.handleInput(ESCAPE);
  assert.deepEqual(closed, [{ type: "close" }], "Escape closes the panel while below the interactive width");

  const restoreState = harness([workflow("restore-nav")], 30, () => {}, { fullscreen: true });
  t.after(() => restoreState.overlay.dispose());
  restoreState.overlay.render(2);
  restoreState.overlay.handleInput(ENTER);
  restoreState.overlay.render(52);
  assert.ok(restoreState.overlay.render(52).some((line) => line.includes("Enter open")), "the panel regains its normal narrow-list hint once interactive again");
  restoreState.overlay.handleInput(ENTER);
  assert.ok(restoreState.overlay.render(52).some((line) => line.includes("workflow · phase")), "Enter opens the overview once the panel is interactive again");
});

test("focusRunId selects the requested run on the first render", (t) => {
  const first = workflow("focus-first");
  const second = workflow("focus-second");
  const state = harness([first, second], 30, () => {}, { focusRunId: "focus-second" });
  t.after(() => state.overlay.dispose());
  assert.match(state.overlay.render(120).join("\n"), /Release focus-second/);
});

test("workflow agent pane toggles between compact groups and full tool rendering with t", (t) => {
  const current = workflow("toggle-tools", "completed");
  current.agents[0]!.transcript = [
    { kind: "tool", phase: "start", toolId: "r1", name: "read", args: { path: "a.ts" } },
    { kind: "tool", phase: "end", toolId: "r1", name: "read", result: { content: [{ type: "text", text: "contents" }], isError: false } },
  ];
  const { overlay } = harness([current], 32, () => {}, { renderMarkdown: (text) => text.split("\n") });
  t.after(() => overlay.dispose());

  overlay.render(60);
  overlay.handleInput(ENTER);
  overlay.handleInput(ENTER);
  const compact = overlay.render(60);
  assertPanel(compact, 60, 25);
  assert.ok(compact.some((line) => line.includes("1 tool call") && line.includes("read")), "agent pane defaults to compact grouping");
  assert.ok(compact.some((line) => line.includes("t full")), "hint offers the toggle to full mode");

  overlay.handleInput("t");
  const full = overlay.render(60);
  assertPanel(full, 60, 25);
  assert.ok(full.some((line) => line.includes("read") && line.includes("a.ts")), "toggling to full mode renders the call through Pi's native execution component");
  assert.equal(full.filter((line) => line.includes("read") && line.includes("a.ts")).length, 1, "the paired start/end lifecycle events resolve to exactly one rendered call, not one per event");
  assert.ok(!full.some((line) => line.includes("1 tool call")), "full mode does not show the compact group row");
  assert.ok(full.some((line) => line.includes("t compact")), "hint offers the toggle back to compact mode");

  overlay.handleInput("t");
  const backToCompact = overlay.render(60);
  assertPanel(backToCompact, 60, 25);
  assert.deepEqual(backToCompact, compact, "toggling twice reproduces identical compact output across both detail cache keys");
});

test("workflow agent pane also toggles tool rendering with the primary Ctrl+T binding", (t) => {
  const current = workflow("toggle-tools-ctrl", "completed");
  current.agents[0]!.transcript = [
    { kind: "tool", phase: "start", toolId: "r1", name: "read", args: { path: "a.ts" } },
    { kind: "tool", phase: "end", toolId: "r1", name: "read", result: { content: [{ type: "text", text: "contents" }], isError: false } },
  ];
  const { overlay } = harness([current], 32, () => {}, { renderMarkdown: (text) => text.split("\n") });
  t.after(() => overlay.dispose());

  overlay.render(60);
  overlay.handleInput(ENTER);
  overlay.handleInput(ENTER);
  const compact = overlay.render(60);
  assert.ok(compact.some((line) => line.includes("1 tool call")), "agent pane defaults to compact grouping");

  overlay.handleInput(CTRL_T);
  const full = overlay.render(60);
  assert.ok(full.some((line) => line.includes("read") && line.includes("a.ts")), "Ctrl+T toggles to full mode, same as t");
  assert.ok(!full.some((line) => line.includes("1 tool call")), "full mode does not show the compact group row");

  overlay.handleInput(CTRL_T);
  const backToCompact = overlay.render(60);
  assert.deepEqual(backToCompact, compact, "a second Ctrl+T reproduces identical compact output");
});

test("a workflow tool call interrupted by an assistant entry resolves to one failed call, not a running and a completed group", () => {
  const current = workflow("split-lifecycle", "completed");
  current.agents[0]!.transcript = [
    { kind: "tool", phase: "start", toolId: "b1", name: "bash", args: { command: "npm test" } },
    { kind: "assistant", text: "still running" },
    { kind: "tool", phase: "end", toolId: "b1", name: "bash", result: { content: [], isError: true }, error: true },
  ];
  const { overlay } = harness([current], 40, () => {}, { renderMarkdown: (text) => text.split("\n") });
  overlay.render(72);
  overlay.handleInput(ENTER);
  overlay.handleInput(ENTER);
  const lines = overlay.render(72);
  overlay.dispose();

  const groupLines = lines.filter((line) => line.includes("tool call"));
  assert.equal(groupLines.length, 1, "the interrupted call folds into exactly one group, not a running group plus a separate completed/failed one");
  assert.match(groupLines[0]!, /1 tool call/);
  assert.match(groupLines[0]!, /×1/);
  assert.doesNotMatch(groupLines[0]!, /●1/, "the call is not still reported as running once its result has arrived");
});

test("a persisted transcript truncation sentinel survives reload and presents as omitted metadata, not a running tool", async (t) => {
  const root = join(await tempDir("workflow-dashboard-artifacts"), "workflows");
  const now = Date.now();
  // Large enough (by raw JSON size) that boundedTranscript() splices in the
  // "[older transcript entries omitted]" sentinel when this agent's
  // transcript is persisted, while each entry's *display* text (the only
  // thing the dashboard's own MAX_RESULT_CHARS bounding measures) stays
  // tiny, so that separate, unrelated bound never re-truncates the sentinel
  // back out before it reaches presentation.
  const bigTranscript: TranscriptEntry[] = [
    { kind: "user", text: "start" },
    ...Array.from({ length: 40 }, (_, index): TranscriptEntry => ({
      kind: "tool",
      toolId: `bash-${index}`,
      name: "bash",
      result: { content: [{ type: "text", text: "x".repeat(800) }], isError: false },
    })),
  ];
  const created = await createWorkflowArtifacts(root, {
    script: "export default async () => 'ok';\n",
    args: {},
    snapshot: {
      sessionId: "sentinel-session",
      name: "Sentinel run",
      description: "Persist a transcript large enough to be truncated",
      background: true,
      status: "completed",
      timestamps: { createdAt: now, startedAt: now, updatedAt: now, endedAt: now },
      currentPhase: 0,
      phases: [{ index: 0, name: "review", status: "completed", timestamps: { createdAt: now, updatedAt: now }, agents: [0] }],
      agents: [{
        index: 0, name: "review", access: "readOnly", independent: false, phase: 0, state: "completed",
        timestamps: { createdAt: now, updatedAt: now, startedAt: now, endedAt: now }, harness: "codex", model: "review-model",
        preview: "output chunk 39", transcript: bigTranscript, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      }],
      result: "ok",
    },
  });
  // checkpointWorkflow is what marks the snapshot as backed by a separate
  // transcripts.json artifact, matching how a real run reaches disk.
  await checkpointWorkflow(root, created);

  const [loaded] = await loadWorkflowSummaries(root, { sessionId: "sentinel-session" });
  assert.ok(loaded, "the persisted run reloads");
  const reloadedTranscript = loaded!.agents[0]!.transcript!;
  assert.ok(
    reloadedTranscript.some((entry) => entry.kind === "tool" && entry.toolId === "transcript" && entry.text === "[older transcript entries omitted]"),
    "the fixture transcript is large enough to trigger the persisted truncation sentinel",
  );

  const { overlay } = harness([loaded!], 40, () => {}, { renderMarkdown: (text) => text.split("\n") });
  t.after(() => overlay.dispose());
  overlay.render(100);
  overlay.handleInput(ENTER);
  overlay.handleInput(ENTER);
  const lines = overlay.render(100);

  assert.ok(
    lines.some((line) => line.includes("[older transcript entries omitted]")),
    "the sentinel renders as its own readable omission line",
  );
  const groupLine = lines.find((line) => line.includes("tool call"));
  assert.ok(groupLine, "the surviving real tool calls still render as a compact group");
  assert.doesNotMatch(groupLine!, /●/, "the phase-less sentinel is not folded into the group and counted as a running tool");
});

test("invalidate() clears the cached detail body so a manual refresh recomputes Markdown", (t) => {
  const current = workflow("cache", "completed");
  current.agents[0]!.transcript = [{ kind: "assistant", text: "# Verdict\n\n**PASS**" }];
  let calls = 0;
  const state = harness([current], 30, () => {}, {
    renderMarkdown: (text) => { calls++; return text.split("\n"); },
  });
  t.after(() => state.overlay.dispose());

  state.overlay.render(72);
  state.overlay.handleInput(ENTER);
  state.overlay.render(72);
  const callsAfterOpen = calls;
  assert.ok(callsAfterOpen > 0, "opening the agent pane renders the transcript once");
  state.overlay.render(72);
  assert.equal(calls, callsAfterOpen, "an unchanged render reuses the cached detail body");

  state.overlay.invalidate();
  state.overlay.render(72);
  assert.ok(calls > callsAfterOpen, "invalidate() forces the next render to recompute the cached detail body");
});

test("resizing wide, medium, narrow, and back to wide preserves run, phase, and agent identity with layered Escape", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const first = workflow("resize-first");
  const second = workflow("resize-second");
  const phaseTemplate = second.phases[0]!;
  second.phases = [
    { ...phaseTemplate, index: 10, name: "First phase", agents: [0] },
    { ...phaseTemplate, index: 20, name: "Second phase", agents: [1] },
  ];
  second.currentPhase = 20;
  second.agents[0]!.phase = 10;
  second.agents[1]!.phase = 20;
  const { overlay } = harness([first, second], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(120);
  overlay.handleInput("j");
  overlay.handleInput(ENTER);
  const wide = overlay.render(120).join("\n");
  assert.match(wide, /agent · tests/, "wide selects the tests agent in the current phase");

  const medium = overlay.render(72).join("\n");
  assert.match(medium, /agent · tests/, "resizing to medium keeps the same agent identity");

  const narrow = overlay.render(52).join("\n");
  assert.match(narrow, /agent ·/, "resizing to narrow keeps the agent pane instead of resetting to the run list");
  assert.match(narrow, /tests/);

  overlay.handleInput(ESCAPE);
  assert.match(overlay.render(52).join("\n"), /workflow · phase/, "the first Escape returns to the workflow overview");
  overlay.handleInput(ESCAPE);
  assert.match(overlay.render(52).join("\n"), /runs ·/, "the second Escape returns to the narrow run list");

  const wideAgain = overlay.render(120).join("\n");
  assert.match(wideAgain, /Release resize-second/, "re-widening keeps the previously selected run identity");

  overlay.handleInput(ESCAPE);
  assert.deepEqual(closed, [{ type: "close" }], "the final Escape closes the dashboard");
});

test("? opens a width-safe grouped cheatsheet in every browse pane and dismisses without losing state", (t) => {
  for (const width of [40, 72, 120]) {
    const state = harness([workflow("cheatsheet")], 30, () => {}, { fullscreen: true });
    t.after(() => state.overlay.dispose());
    state.overlay.render(width);
    state.overlay.handleInput("j"); // move some transient input through first, unrelated to help
    const before = state.overlay.render(width).join("\n");

    state.overlay.handleInput("?");
    const help = state.overlay.render(width);
    assertPanel(help, width, 30);
    assert.match(help.join("\n"), /help/);
    assert.match(help.join("\n"), /Navigate/);

    state.overlay.handleInput("?");
    assert.equal(state.overlay.render(width).join("\n"), before, "dismissing with ? restores the exact prior state");

    state.overlay.handleInput("?");
    state.overlay.handleInput(ESCAPE);
    assert.equal(state.overlay.render(width).join("\n"), before, "Esc also dismisses the cheatsheet without losing state");
  }
});

test("the cheatsheet reflects the currently active pane and never closes the dashboard", (t) => {
  const { overlay, actions } = harness([workflow("cheatsheet-pane")], 30, () => {}, { fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(52); // narrow: starts on the run list
  overlay.handleInput("?");
  assert.match(overlay.render(52).join("\n"), /open overview/i, "the narrow-list cheatsheet documents opening the overview");
  overlay.handleInput("?");

  overlay.handleInput(ENTER); // -> overview
  overlay.handleInput(ENTER); // -> agent pane
  overlay.handleInput("?");
  const agentHelp = overlay.render(52).join("\n");
  assert.match(agentHelp, /restart this agent/i, "the agent-pane cheatsheet documents restart");
  assert.doesNotMatch(agentHelp, /pause \/ resume/i, "the agent-pane cheatsheet omits overview-only actions");

  for (const input of ["p", "r", "x", "X", "j", "k"]) overlay.handleInput(input);
  assert.deepEqual(actions, [], "input is inert while the cheatsheet is shown");
});

test("configurable confirm/cancel bindings render their configured key names in workflow hints, falling back to defaults otherwise", (t) => {
  const configured = harness([workflow("configured-keys")], 30, () => {}, {
    fullscreen: true,
    getKeys: (binding) => binding === "tui.select.cancel" ? ["q"] : binding === "tui.select.confirm" ? ["space"] : [],
  });
  t.after(() => configured.overlay.dispose());
  assert.match(configured.overlay.render(60).join("\n"), /Space open/i, "the narrow run-list hint reflects the configured confirm key");
  // Medium/wide always show the overview pane's content, even while `#pane`
  // is still "list", so no navigation is needed to reach its hint.
  const overview = configured.overlay.render(90).join("\n");
  assert.match(overview, /Space inspect/i);
  assert.match(overview, /Q close/i);
  assert.doesNotMatch(overview, /Esc close/);

  const defaulted = harness([workflow("default-keys")], 30, () => {}, { fullscreen: true });
  t.after(() => defaulted.overlay.dispose());
  const defaultHint = defaulted.overlay.render(90).join("\n");
  assert.match(defaultHint, /Enter inspect/);
  assert.match(defaultHint, /Esc close/);
});

test("/workflows keeps the host overlay geometry and non-TUI summary contract", async () => {
  const runs = [workflow("integration", "completed")];
  let captured: unknown;
  const tuiContext = {
    mode: "tui",
    ui: {
      custom: async (_factory: unknown, options: unknown) => {
        captured = options;
        return { type: "close" } as WorkflowsDashboardAction;
      },
      notify: () => {},
    },
  };
  await openWorkflowsDashboard(tuiContext as never, {
    list: () => runs,
    check: (runId) => runs.find((run) => run.runId === runId)!,
    cancel: async (runId) => runs.find((run) => run.runId === runId)!,
    cancelAgent: async (runId) => runs.find((run) => run.runId === runId)!,
    pause: async (runId) => runs.find((run) => run.runId === runId)!,
    resume: async (runId) => runs.find((run) => run.runId === runId)!,
    restartAgent: async (runId) => ({ snapshot: runs.find((run) => run.runId === runId)! }),
    subscribe: () => () => {},
  });
  assert.deepEqual(captured, { overlay: true, overlayOptions: { width: "100%", minWidth: 40, maxHeight: "100%", anchor: "center" } });

  let summary = "";
  const summaryManager = { list: () => runs } as never;
  await openWorkflowsDashboard({
    mode: "rpc",
    ui: { notify: (message: string) => { summary = message; } },
  } as never, summaryManager);
  assert.equal(summary, "integration completed Release integration");
});

test("a routed-question wait reads differently from a provider-quota wait in /workflows", (t) => {
  const run = workflow("questions");
  const planner = run.agents[0]!;
  const implementer = run.agents[1]!;
  planner.answering = { requestId: "req-1", sourceAgentIndex: 1, sourceName: "tests" };
  implementer.waitingOn = {
    ordinal: 0,
    requestId: "req-1",
    target: "peer",
    sourceAgentIndex: 1,
    sourceName: "tests",
    targetAgentIndex: 0,
    targetName: "review",
    question: "Which compatibility behavior did we decide to preserve?",
    context: "the task wording and the fixtures disagree",
    state: "pending",
    createdAt: 60_000,
  };
  run.interactions = [implementer.waitingOn];

  const quota = workflow("quota");
  quota.agents[1]!.state = "waiting";
  quota.agents[1]!.providerWait = { provider: "codex", kind: "quota", detail: "usage limit", attempt: 1, maxAttempts: 3, retryAt: 125_000 };

  const state = harness([run, quota], 30, () => {}, { fullscreen: true, focusRunId: run.runId });
  t.after(() => state.overlay.dispose());

  const overview = state.overlay.render(120);
  assertPanel(overview, 120, 30);
  const overviewText = overview.join("\n");
  assert.match(overviewText, /\? 1 need input/, "the run row aggregates blocked agents in words and a glyph");
  assert.match(overviewText, /Questions · 1 need input/);
  assert.match(overviewText, /waiting for review/, "the wait names the peer that owes the answer");
  assert.match(overviewText, /Which compatibility behavi/, "the bounded question rides along with the wait");
  assert.match(overviewText, /unanswered/);
  assert.match(overviewText, /answering peer/, "the target lineage shows the answer turn it is producing");

  state.overlay.handleInput("\t");
  state.overlay.handleInput(ENTER);
  const inspector = state.overlay.render(120).join("\n");
  assert.match(inspector, /agent · tests/);
  assert.match(inspector, /Question · waiting for review/);
  assert.match(inspector, /Question context · the task wording and the fixtures disagree/);
  assert.doesNotMatch(inspector, /Provider wait/, "an interaction wait is never reported as a provider-quota wait");

  const quotaState = harness([quota], 30, () => {}, { fullscreen: true, focusRunId: quota.runId });
  t.after(() => quotaState.overlay.dispose());
  quotaState.overlay.render(120);
  quotaState.overlay.handleInput("\t");
  quotaState.overlay.handleInput(ENTER);
  const quotaText = quotaState.overlay.render(120).join("\n");
  assert.match(quotaText, /Provider wait · codex quota/);
  assert.doesNotMatch(quotaText, /need input|Question ·/, "a provider wait never borrows the interaction vocabulary");
});

test("the workflow inspector reports convergence round, state, verdict, and stopping reason at every width", (t) => {
  const run = workflow("converging", "completed");
  run.taskOutcome = "unsuccessful";
  run.convergence = {
    name: "issue 24",
    round: 3,
    maxRounds: 3,
    state: "stalled",
    verdict: "request_changes",
    actionableCount: 2,
    fingerprint: "abc123",
    stoppingReason: "round 3 repeated the same 2 unresolved finding(s) as the round before it",
    implementerJobId: "tests-job-0002",
    reviewerJobId: "review-job-0001",
    rounds: [
      { round: 1, verdict: "request_changes", actionableCount: 2, fingerprint: "abc123" },
      { round: 2, verdict: "request_changes", actionableCount: 2, fingerprint: "abc123" },
      { round: 3, verdict: "request_changes", actionableCount: 2, fingerprint: "abc123" },
    ],
  };
  const state = harness([run], 30, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  const wide = state.overlay.render(200);
  assertPanel(wide, 200, 30);
  const line = wide.find((entry) => entry.includes("Convergence · "));
  assert.ok(line, "the inspector reports convergence state");
  assert.ok(line.includes("≡") && line.includes("stalled"), "state is carried by a glyph and by words");
  assert.match(line, /round 3\/3/);
  assert.match(line, /verdict request_changes · 2 actionable findings/);
  assert.match(line, /repeated the same 2 unresolved finding/);

  // Narrow layouts show one pane at a time: drill from the run list into the overview.
  state.overlay.render(40);
  state.overlay.handleInput(ENTER);
  const narrow = state.overlay.render(40);
  assertPanel(narrow, 40, 30);
  assert.ok(narrow.some((entry) => entry.includes("Convergence · ")), "convergence survives the narrow layout");

  const plain = harness([workflow("one-shot", "completed")], 30, () => {}, { fullscreen: true });
  t.after(() => plain.overlay.dispose());
  assert.ok(!plain.overlay.render(200).some((entry) => entry.includes("Convergence · ")), "one-shot runs show no convergence line");
});
