import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import {
  createWorkflowsDashboardOverlay,
  openWorkflowsDashboard,
  type WorkflowsDashboardAction,
} from "../extensions/workflows/dashboard.ts";
import { dashboardLayout } from "../extensions/dashboard-style.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

const ENTER = "\r";
const ESCAPE = "\u001b";
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const CTRL_D = "\u0004";
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
}

function harness(
  runs: WorkflowSnapshot[],
  rows = 30,
  done: (action: WorkflowsDashboardAction) => void = () => {},
  options: HarnessOptions = {},
) {
  let renders = 0;
  const listeners = new Set<(snapshot: WorkflowSnapshot) => void>();
  const checked: string[] = [];
  const actions: WorkflowsDashboardAction[] = [];
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
    } as unknown as KeybindingsManager,
    manager,
    (action) => {
      actions.push(action);
      done(action);
    },
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
  const { overlay } = harness([markdown], 30, () => {}, {
    renderMarkdown: (text) => {
      sources.push(text);
      return ["\u001b[1mVerdict\u001b[0m", "\u001b[32mPASS\u001b[0m"];
    },
  });
  t.after(() => overlay.dispose());

  overlay.render(72);
  overlay.handleInput("\r");
  const lines = overlay.render(72);
  assert.deepEqual(sources, ["# Verdict\n\n**PASS**", "review result"], "assistant transcript and distinct final result use Markdown");
  assert.ok(lines.some((line) => line.includes("\u001b[1mVerdict\u001b[0m")));
  assert.ok(lines.some((line) => line.includes("> **inspect this literally**")));
  assert.ok(lines.some((line) => line.includes("~ considering options")));
  assert.ok(lines.some((line) => line.includes("→ read · file.ts")));
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
  assert.match(overlay.render(52).join("\n"), /workflow · phase 1\/2/);
  assert.match(overlay.render(52).join("\n"), /First phase/);

  overlay.handleInput("l");
  const second = overlay.render(52).join("\n");
  assert.match(second, /workflow · phase 2\/2/);
  assert.match(second, /Second phase/);

  overlay.handleInput("h");
  const first = overlay.render(52).join("\n");
  assert.match(first, /workflow · phase 1\/2/);
  assert.match(first, /First phase/);
  assert.doesNotMatch(first, /Enter open/, "h navigates phases instead of returning to the hidden run list");
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
