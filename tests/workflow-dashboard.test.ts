import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, visibleWidth } from "@earendil-works/pi-tui";
import { tempDir, theme, tick, workflowSnapshotFixture as workflow } from "./helpers.ts";
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
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";

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

type DashboardDriver = Pick<ReturnType<typeof createWorkflowsDashboardOverlay>, "render" | "handleInput">;

function openOutline(overlay: DashboardDriver, width: number): void {
  overlay.render(width);
  overlay.handleInput(ENTER);
}

function selectOutlineAgent(overlay: DashboardDriver, width: number, offset = 0): void {
  openOutline(overlay, width);
  overlay.handleInput(ENTER);
  for (let index = 0; index < offset; index++) overlay.handleInput("j");
}

function openAgentDetail(overlay: DashboardDriver, width: number, offset = 0): void {
  selectOutlineAgent(overlay, width, offset);
  overlay.handleInput(ENTER);
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
  assert.ok(regularHarness.overlay.render(72).some((line) => line.includes("outline")), "medium mode keeps the short run list above the outline");
  assert.ok(!regularHarness.overlay.render(52).some((line) => line.includes("┬")), "narrow mode renders one pane");

  const short = harness([workflow("short")], 8, () => {}, { fullscreen: true }).overlay;
  t.after(() => short.dispose());
  assertPanel(short.render(120), 120, 8);
  assert.equal(dashboardLayout(120, 8).kind, "narrow", "short screens use one predictable pane");
});

test("run and agent summaries render across wide, medium, and narrow dashboard rows", (t) => {
  for (const width of [120, 72, 52]) {
    const run = workflow(`summary-${width}`);
    run.name = "run";
    run.logs = [{ index: 0, message: "BUILDING", at: 4_000 }];
    const active = run.agents[1]!;
    active.name = "tests";
    active.liveThinking = "VERIFYING";
    active.preview = "older preview";
    active.timestamps.updatedAt = 5_000;

    const state = harness([run], 30, () => {}, { fullscreen: true });
    t.after(() => state.overlay.dispose());
    const listLines = state.overlay.render(width);
    assertPanel(listLines, width, 30);
    assert.ok(listLines.some((line) => line.includes("run") && line.includes("VE")), `${width}-column run row shows its summary`);
    if (width === 52) state.overlay.handleInput(ENTER);
    const lines = state.overlay.render(width);
    assertPanel(lines, width, 30);
    assert.ok(lines.some((line) => line.includes("tests") && line.includes("VERIFY")), `${width}-column agent row shows its summary`);
  }
});

test("workflow runs render attention groups with counts and keep grouped states exact", (t) => {
  const input = workflow("input");
  input.name = "IN";
  input.agents[1]!.waitingOn = {
    ordinal: 0,
    requestId: "request-input",
    target: "orchestrator",
    sourceAgentIndex: 1,
    sourceName: "tests",
    question: "Which release should proceed?",
    state: "pending",
    createdAt: 60_000,
  };
  const pending = workflow("pending", "pending");
  pending.name = "PN";
  const paused = workflow("paused", "paused");
  paused.name = "PS";
  const provider = workflow("provider");
  provider.name = "QT";
  provider.agents[1]!.state = "waiting";
  provider.agents[1]!.providerWait = {
    provider: "codex",
    kind: "quota",
    detail: "usage limit",
    attempt: 1,
    maxAttempts: 3,
    retryAt: 125_000,
  };
  const failed = workflow("failed", "failed");
  failed.name = "FL";
  const unsuccessful = workflow("unsuccessful", "completed");
  unsuccessful.name = "UN";
  unsuccessful.taskOutcome = "unsuccessful";
  const aborted = workflow("aborted", "aborted");
  aborted.name = "AB";
  const successful = workflow("successful", "completed");
  successful.name = "OK";
  successful.taskOutcome = "successful";
  const runs = [successful, failed, pending, aborted, input, paused, provider, unsuccessful];
  const state = harness(runs, 36, () => {}, { focusRunId: input.runId, fullscreen: true });
  t.after(() => state.overlay.dispose());

  const lines = state.overlay.render(180);
  const text = lines.join("\n");
  for (const heading of [
    "Needs input · 1",
    "Active · 3",
    "Failed · 2",
    "Finished · 2",
  ]) assert.match(text, new RegExp(heading));

  const positions = [" IN ", " PN ", " FL ", " OK "]
    .map((name) => lines.findIndex((line) => line.includes(name)));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(lines.find((line) => line.includes(" PS ")) ?? "", /paused/);
  assert.match(lines.find((line) => line.includes(" QT ")) ?? "", /running · waiting/);
  assert.match(lines.find((line) => line.includes(" UN ")) ?? "", /completed · unsuccessful/);
  assert.match(lines.find((line) => line.includes(" AB ")) ?? "", /aborted/);

  state.overlay.handleInput("j");
  assert.ok(state.overlay.render(180).some((line) => line.includes(" PN ") && line.includes("❯")), "navigation skips the Active header");
  state.overlay.handleInput("X");
  state.overlay.render(180);
  state.overlay.handleInput("X");
  assert.deepEqual(state.actions.at(-1), { type: "cancel", runId: "pending" }, "run actions target the selected identity, not a section row");
});

test("responsive workflow header keeps input, active, and failed counts", (t) => {
  const input = workflow("header-input");
  input.agents[1]!.waitingOn = {
    ordinal: 0,
    requestId: "header-question",
    target: "orchestrator",
    sourceAgentIndex: 1,
    sourceName: "tests",
    question: "Proceed?",
    state: "pending",
    createdAt: 60_000,
  };
  const failed = workflow("header-failed", "failed");
  const state = harness([input, failed], 24, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  const header = state.overlay.render(60)[0] ?? "";
  assert.match(header, /1 need input/);
  assert.match(header, /1 active/);
  assert.match(header, /1 failed/);
  assert.ok(visibleWidth(header) <= 60);
});

test("minimum-width workflow header keeps the largest fitting attention prefix", (t) => {
  const inputs = Array.from({ length: 10 }, (_, index) => {
    const run = workflow(`header-input-${index}`);
    run.agents[1]!.waitingOn = {
      ordinal: 0,
      requestId: `header-question-${index}`,
      target: "orchestrator",
      sourceAgentIndex: 1,
      sourceName: "tests",
      question: "Proceed?",
      state: "pending",
      createdAt: 60_000,
    };
    return run;
  });
  const active = Array.from({ length: 10 }, (_, index) => workflow(`header-active-${index}`));
  const failed = Array.from({ length: 10 }, (_, index) => workflow(`header-failed-${index}`, "failed"));
  const state = harness([...inputs, ...active, ...failed], 24, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  const header = state.overlay.render(40)[0] ?? "";
  assert.match(header, /10 need input/);
  assert.match(header, /20 active/);
  assert.doesNotMatch(header, /30 runs/);
});

test("empty workflows name the next safe action within constrained geometry", (t) => {
  const state = harness([], 10, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());
  const lines = state.overlay.render(52);
  assertPanel(lines, 52, 10);
  assert.match(lines.join("\n"), /Invoke a workflow, then return to \/workflows\./);
});

test("workflow finished folding reveals selection and selection survives a group move", (t) => {
  const active = workflow("active");
  const finished = Array.from({ length: 7 }, (_, index) => workflow(`done-${index + 1}`, "completed"));
  const runs = [active, ...finished];
  const state = harness(runs, 7, () => {}, { focusRunId: active.runId, fullscreen: true });
  t.after(() => state.overlay.dispose());

  let lines = state.overlay.render(120);
  assertPanel(lines, 120, 7);
  assert.ok(lines.some((line) => line.includes("7 finished hidden")));
  for (let index = 0; index < 5; index++) state.overlay.handleInput("j");
  lines = state.overlay.render(120);
  assert.ok(lines.some((line) => line.includes("Release done-5") && line.includes("❯")), "a selected finished run is revealed");
  assert.ok(lines.some((line) => line.includes("6 finished hidden")));

  const selected = runs.find((run) => run.runId === "done-5")!;
  selected.status = "running";
  selected.taskOutcome = undefined;
  selected.timestamps.endedAt = undefined;
  runs.reverse();
  state.emit(selected.runId);
  lines = state.overlay.render(120);
  assert.ok(lines.some((line) => line.includes("Release done-5") && line.includes("❯")), "the selected run ID survives reordering into Active");
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
  selectOutlineAgent(agentState.overlay, 40, 1);
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

  openAgentDetail(overlay, 72);
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
  overlay.handleInput("i");
  overlay.handleInput("g");
  const infoLines = overlay.render(72);
  assert.ok(infoLines.some((line) => line.includes("effort high")));

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
  openAgentDetail(failedOverlay, 72);
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
  openAgentDetail(stressOverlay, 60);
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
  const run = workflow("no-duplication");
  const agent = run.agents[0]!;
  agent.state = "running";
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

  openAgentDetail(overlay, 72);
  const compactLines = overlay.render(72);
  assert.ok(!compactLines.some((line) => line.includes("DISTINCT_TOOL_SUMMARY_MARKER")), "compact mode is the default and does not surface per-tool detail anywhere, including Activity");
  assert.ok(compactLines.some((line) => line.includes("Latest") && line.includes("narrowing down the failing assertion")), "the state preview surfaces live semantic progress in compact mode");

  overlay.handleInput("t");
  const lines = overlay.render(72);
  assert.ok(lines.some((line) => line.includes("DISTINCT_TOOL_SUMMARY_MARKER")), "the tool lifecycle row still appears in the Transcript section in full mode, via Pi's native execution component");
  assert.ok(lines.some((line) => line.includes("Latest") && line.includes("narrowing down the failing assertion")), "the state preview still surfaces live semantic progress");

  const activityLine = lines.find((line) => line.includes("Latest"));
  assert.ok(activityLine && !activityLine.includes("DISTINCT_TOOL_SUMMARY_MARKER"), "the state preview does not repeat the tool detail already in the transcript");
  const toolMentions = lines.filter((line) => line.includes("DISTINCT_TOOL_SUMMARY_MARKER"));
  assert.equal(toolMentions.length, 1, "tool detail is rendered exactly once, in the transcript, not duplicated in Activity");
});

test("narrow workflows drill from runs to outline to agent detail with layered Escape and Pi cancel backtracking", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const { overlay, actions } = harness([workflow("narrow")], 30, (action) => closed.push(action));
  t.after(() => overlay.dispose());

  overlay.render(52);
  assert.ok(overlay.render(52).some((line) => line.includes("outline")));
  for (const input of ["h", "f", "x", PAGE_DOWN, "r"]) overlay.handleInput(input);
  assert.deepEqual(actions, [], "the narrow run list rejects outline and agent controls");
  assert.ok(overlay.render(52).some((line) => line.includes("runs ·")));
  overlay.handleInput(ENTER);
  assert.ok(overlay.render(52).some((line) => line.includes("outline · phase")));
  overlay.handleInput(ENTER);
  assert.ok(overlay.render(52).some((line) => line.includes("review")), "phase drill advances to its first agent without opening detail");
  overlay.handleInput(ENTER);
  assert.ok(overlay.render(52).some((line) => line.includes("agent ·")));
  for (const input of ["p", "l", "f", "\t", ENTER]) overlay.handleInput(input);
  assert.deepEqual(actions, [], "the narrow agent pane accepts only its displayed controls");
  assert.ok(overlay.render(52).some((line) => line.includes("agent ·")));

  overlay.handleInput(ESCAPE);
  assert.ok(overlay.render(52).some((line) => line.includes("outline · phase")));
  overlay.handleInput("\u0003");
  assert.ok(overlay.render(52).some((line) => line.includes("runs ·")));
  overlay.handleInput("\u0003");
  assert.deepEqual(closed, [{ type: "close" }]);
});

test("focus routing gives j/k and Right/Left one meaning in runs, outline, and agent detail", (t) => {
  const first = workflow("focus-routing-first");
  const second = workflow("focus-routing-second");
  first.name = "FIRST";
  second.name = "SECOND";
  second.agents[0]!.output = Array.from({ length: 80 }, (_, index) => `detail ${index}`).join("\n");
  const { overlay } = harness([first, second], 30);
  t.after(() => overlay.dispose());

  overlay.render(52);
  overlay.handleInput("j");
  assert.match(overlay.render(52).join("\n"), /SECOND/, "j selects a real run in runs focus");

  overlay.handleInput(RIGHT);
  assert.match(overlay.render(52).join("\n"), /outline · phase/, "Right drills into outline focus");
  overlay.handleInput("j");
  assert.match(overlay.render(52).join("\n"), /›.*review/, "j traverses outline nodes without changing runs");
  overlay.handleInput(RIGHT);
  assert.match(overlay.render(52).join("\n"), /agent · review/, "Right on an agent opens detail");

  overlay.handleInput("g");
  const top = overlay.render(52).join("\n");
  overlay.handleInput("j");
  const scrolled = overlay.render(52).join("\n");
  assert.notEqual(scrolled, top, "j scrolls agent detail instead of selecting a run or outline node");
  overlay.handleInput("k");
  assert.equal(overlay.render(52).join("\n"), top, "k scrolls back by one detail row");

  overlay.handleInput(LEFT);
  assert.match(overlay.render(52).join("\n"), /outline · phase/, "Left restores outline with the agent identity preserved");
  overlay.handleInput(LEFT);
  const runs = overlay.render(52).join("\n");
  assert.match(runs, /runs ·/);
  assert.match(runs, /SECOND/, "Left restores runs with run identity preserved");
});

test("narrow workflow outline uses j/k for nodes and h/l as unambiguous back/drill aliases", (t) => {
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
  assert.match(overlay.render(52).join("\n"), /outline · phase 1\/\?/);
  assert.match(overlay.render(52).join("\n"), /First phase/);

  overlay.handleInput("j");
  overlay.handleInput("j");
  const second = overlay.render(52).join("\n");
  assert.match(second, /outline · phase 2\/\?/);
  assert.match(second, /Second phase/);

  overlay.handleInput("k");
  overlay.handleInput("k");
  const first = overlay.render(52).join("\n");
  assert.match(first, /outline · phase 1\/\?/);
  assert.match(first, /First phase/);
  overlay.handleInput("h");
  assert.match(overlay.render(52).join("\n"), /runs ·/);
  overlay.handleInput("l");
  assert.match(overlay.render(52).join("\n"), /outline · phase 1\/\?/);
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
  assert.match(declaredText, /outline · phase 1\/6/);
  assert.match(declaredText, /no current phase/);
  assert.match(declaredText, /Phase 1\/6.*One.*pending/);
  assert.match(declaredText, /Phase 6\/6.*Six.*pending/);

  const waiting = workflow("waiting-for-first-phase");
  waiting.currentPhase = null;
  waiting.phases = [];
  waiting.agents = [];
  const waitingState = harness([waiting], 30);
  t.after(() => waitingState.overlay.dispose());
  waitingState.overlay.render(52);
  waitingState.overlay.handleInput(ENTER);
  const waitingText = waitingState.overlay.render(52).join("\n");
  assert.match(waitingText, /outline · phase waiting/);
  assert.match(waitingText, /waiting for the first phase/);

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
  assert.match(terminalText, /No recorded or planned phases/);
  assert.match(terminalText, /no phases recorded/);
  assert.doesNotMatch(terminalText, /waiting for the first phase/);
});

test("terminal dynamic dashboard selection reports selected phase positions", (t) => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    const run = workflow(`terminal-${status}`, status);
    const template = run.phases[0]!;
    run.currentPhase = 1;
    run.phases = [
      { ...template, index: 0, name: "First", status, agents: [] },
      { ...template, index: 1, name: "Second", status, agents: [] },
    ];
    run.agents = [];
    const state = harness([run], 30);
    t.after(() => state.overlay.dispose());
    state.overlay.render(52);
    state.overlay.handleInput(ENTER);
    assert.match(state.overlay.render(52).join("\n"), /outline · phase 2\/2/);
    state.overlay.handleInput("k");
    assert.match(state.overlay.render(52).join("\n"), /outline · phase 1\/2/);
    state.overlay.handleInput("j");
    assert.match(state.overlay.render(52).join("\n"), /outline · phase 2\/2/);
  }
});

test("tiny workflow outlines keep the selected node visible and never target a selected phase", (t) => {
  const clipped = workflow("clipped-agent");
  clipped.description = "A workflow with enough metadata to clip its agent roster";
  clipped.approval = "plan";
  clipped.definitionFingerprint = "definition-fingerprint";
  clipped.warnings = ["warning one", "warning two"];
  clipped.logs = [0, 1, 2].map((index) => ({ index, message: `log ${index}`, at: 1_000 + index }));

  const harnessState = harness([clipped], 10, () => {}, { fullscreen: true });
  t.after(() => harnessState.overlay.dispose());

  openOutline(harnessState.overlay, 52);
  const phase = harnessState.overlay.render(52).join("\n");
  assert.match(phase, /Phase 1\/\?/, "the selected phase survives the one-row outline budget");
  assert.doesNotMatch(phase, /r restart agent|x cancel agent/);
  harnessState.overlay.handleInput("r");
  harnessState.overlay.handleInput("x");
  assert.deepEqual(harnessState.actions, [], "phases cannot receive agent actions");

  harnessState.overlay.handleInput(ENTER);
  harnessState.overlay.handleInput("j");
  const agent = harnessState.overlay.render(52).join("\n");
  assert.match(agent, /tests/, "the selected agent is never omitted under row pressure");
  assert.match(agent, /x cancel/, "the selected visible agent retains its rendered destructive control proof");
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

  openAgentDetail(medium.overlay, 72);
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

  openAgentDetail(short.overlay, 72);
  const shortInitial = short.overlay.render(72).join("\n");
  assert.doesNotMatch(shortInitial, /Detail 0\//, "short metadata leaves a result viewport");
  assert.match(shortInitial, /COMPLETED_OUTPUT_METADATA/);
  short.overlay.handleInput("g");
  const shortTop = short.overlay.render(72).join("\n");
  assert.match(shortTop, /Error/);
  short.overlay.handleInput(PAGE_DOWN);
  assert.notEqual(short.overlay.render(72).join("\n"), shortTop, "Page Down advances the short result body");
  short.overlay.handleInput("G");
  assert.match(short.overlay.render(72).join("\n"), /COMPLETED_OUTPUT_METADATA/);
});

test("workflow agent info fold is opt-in and short geometry retains a useful result row", (t) => {
  const run = workflow("info-fold", "completed");
  const agent = run.agents[0]!;
  agent.context = { tokens: 48_000, window: 128_000, servingModel: "served-model" };
  agent.isolation = { type: "worktree", state: "preserved", branch: "feature/漢字", changed: true };
  agent.independentOf = "producer-run";
  agent.replayedFrom = { runId: "source-run", callIndex: 2 };
  agent.replacedBy = { replacementRunId: "replacement-run", reason: "retry", at: 4_000 };
  agent.transcript = [{ kind: "assistant", text: "USEFUL_WORKFLOW_RESULT" }];
  agent.output = "USEFUL_WORKFLOW_RESULT";
  const state = harness([run], 8, () => {}, { fullscreen: true, renderMarkdown: (text) => [text] });
  t.after(() => state.overlay.dispose());

  openAgentDetail(state.overlay, 52);
  let lines = state.overlay.render(52);
  assertPanel(lines, 52, 8);
  assert.match(lines.join("\n"), /USEFUL_WORKFLOW_RESULT/);
  assert.doesNotMatch(lines.join("\n"), /Isolation ·|Replay ·|Replacement ·/);
  assert.match(lines.find((line) => line.includes("transcript")) ?? "", /· end/, "terminal agent output is labelled as an end, not live");

  state.overlay.handleInput("i");
  state.overlay.handleInput("g");
  lines = state.overlay.render(52);
  assertPanel(lines, 52, 8);
  assert.match(lines.join("\n"), /readOnly|Context ·|Isolation ·/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 52));
});

test("terminal workflow agents use end labels while their workflow remains active", (t) => {
  const run = workflow("terminal-agent-active-run");
  run.status = "running";
  run.agents[1]!.state = "failed";
  run.agents[1]!.error = "agent stopped";
  run.agents[1]!.transcript = [{ kind: "assistant", text: "TERMINAL_AGENT_OUTPUT" }];
  const state = harness([run], 24, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  openAgentDetail(state.overlay, 72, 1);
  const label = state.overlay.render(72).find((line) => line.includes("transcript")) ?? "";
  assert.match(label, /· end/);
  assert.doesNotMatch(label, /live|resumes live/);
});

test("short workflow agent inspectors pin recovery details above the transcript reserve", (t) => {
  const failedRun = workflow("short-failed-agent", "failed");
  failedRun.agents[1]!.state = "failed";
  failedRun.agents[1]!.error = "bounded agent failure";
  failedRun.agents[1]!.transcript = [{ kind: "assistant", text: "SHORT_AGENT_TRANSCRIPT" }];
  const failed = harness([failedRun], 8, () => {}, { fullscreen: true });
  t.after(() => failed.overlay.dispose());
  openAgentDetail(failed.overlay, 52, 1);
  const failedText = failed.overlay.render(52).join("\n");
  assert.match(failedText, /Error · bounded agent failure/);
  assert.match(failedText, /Recovery · press r to restart this agent/);
  assert.match(failedText, /transcript/);
  assert.match(failedText, /test result 59/, "the reserved body row renders the transcript tail");

  const waitingRun = workflow("short-provider-wait");
  const waiting = waitingRun.agents[1]!;
  waiting.state = "waiting";
  waiting.providerWait = {
    provider: "codex",
    kind: "quota",
    scope: "quota",
    detail: "quota window",
    retryAt: 125_000,
    attempt: 1,
    maxAttempts: 3,
  };
  waiting.transcript = [{ kind: "assistant", text: "WAIT_TRANSCRIPT" }];
  const provider = harness([waitingRun], 8, () => {}, { fullscreen: true });
  t.after(() => provider.overlay.dispose());
  openAgentDetail(provider.overlay, 52, 1);
  const providerText = provider.overlay.render(52).join("\n");
  assert.match(providerText, /Provider wait ·/);
  assert.match(providerText, /Retry · 1m · attempt 1\/3 · automatic/);
  assert.match(providerText, /test result 59/, "provider waits also retain the transcript body row");

  const questionRun = workflow("short-question");
  questionRun.agents[1]!.waitingOn = {
    ordinal: 0,
    requestId: "short-question-request",
    target: "orchestrator",
    sourceAgentIndex: 1,
    sourceName: "tests",
    question: "Which behavior should remain?",
    state: "pending",
    createdAt: 60_000,
  };
  const question = harness([questionRun], 8, () => {}, { fullscreen: true });
  t.after(() => question.overlay.dispose());
  openAgentDetail(question.overlay, 52, 1);
  const questionLines = question.overlay.render(52);
  assertPanel(questionLines, 52, 8);
  const questionText = questionLines.join("\n");
  assert.match(questionText, /Question · Which behavior should remain\?/);
  assert.match(questionText, /Route · tests → parent orchestrator/);
  assert.match(questionText, /Next · parent: subagent_answer; do not steer/);
  assert.match(questionText, /transcript/);
  assert.match(questionText, /test result 59/, "questions also retain the transcript body row");
});

test("workflow run preview stays pinned ahead of result rows and routine info is opt-in", (t) => {
  const run = workflow("run-preview", "failed");
  run.error = "provider failed";
  run.agents = [];
  run.phases[0] = { ...run.phases[0]!, agents: [], error: "provider failed" };
  run.result = "RECOVERABLE_RESULT";
  const state = harness([run], 8, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  openOutline(state.overlay, 52);
  let lines = state.overlay.render(52);
  assertPanel(lines, 52, 8);
  assert.match(lines.join("\n"), /Error ·.*provider failed/);
  assert.match(lines.join("\n"), /Recovery ·/);
  assert.match(lines.join("\n"), /RECOVERABLE_RESULT/);
  assert.doesNotMatch(lines.join("\n"), /Review and verify Unicode output/, "routine run metadata is folded by default");

  state.setRows(24);
  state.overlay.handleInput("i");
  lines = state.overlay.render(72);
  assertPanel(lines, 72, 24);
  assert.match(lines.join("\n"), /Review and verify Unicode output/, "i reveals routine run metadata in outline focus");
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

  openAgentDetail(state.overlay, 100);
  state.overlay.handleInput("i");
  state.overlay.handleInput("g");
  const inspector = state.overlay.render(100).join("\n");
  assert.match(inspector, /Provider fallback · used · declared codex\/declared MODEL/);
  assert.match(inspector, /Attempt 1 · claude\/primary MODEL/);
  assert.match(inspector, /Final route · codex\/final MODEL/);
  assert.doesNotMatch(inspector, /\u001b\[(?:31|32|33)m/, "caller-controlled model ANSI never reaches the dashboard");
});

test("progressed continuation dashboard exposes checkpoint, trigger, historical replacement, and sanitized provenance", (t) => {
  const run = workflow("continuation-provenance", "completed");
  const agent = run.agents[0]!;
  agent.harness = "codex";
  agent.model = "replacement\n\u001b[31mMODEL";
  agent.jobId = "replacement-job-123456";
  agent.logicalJobId = "failed-job-123456";
  agent.continuationFallback = { harness: "codex", model: "declared\n\u001b[32mMODEL" };
  agent.continuation = {
    state: "completed",
    fromHarness: "claude",
    toHarness: "codex",
    failedJobId: "failed-job-123456",
    replacementJobId: "replacement-job-123456",
    checkpointAt: 1_000,
    checkoutDigest: "sha256:checkout-proof-123456",
    trigger: { source: "continuation", provider: "claude", kind: "quota", detail: "quota\n\u001b[33mafter progress" },
    warning: "exactly-once is not guaranteed",
  };
  agent.attempts = [{
    index: 0,
    harness: "claude",
    requestedHarness: "claude",
    model: "primary",
    disposition: "continuation",
    trigger: agent.continuation.trigger,
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  }];
  const state = harness([run], 34, () => {}, { theme });
  t.after(() => state.overlay.dispose());

  openAgentDetail(state.overlay, 140);
  state.overlay.handleInput("i");
  state.overlay.handleInput("g");
  const inspector = state.overlay.render(140).join("\n");
  assert.match(inspector, /Progressed continuation · used · declared codex\/declared MODEL/);
  assert.match(inspector, /Continuation · completed · claude → codex · failed job .* · replacement job/);
  assert.doesNotMatch(inspector, /retained job/, "terminal snapshots do not claim that replacement sessions remain available");
  assert.match(inspector, /Continuation trigger · claude quota · quota after progress/);
  assert.match(inspector, /Checkout proof · sha256:c/);
  assert.match(inspector, /Continuation warning · exactly-once is not guaranteed/);
  assert.match(inspector, /Attempt 1 · claude\/primary · continuation/);
  assert.match(inspector, /Final route · codex\/replacement MODEL/);
  assert.doesNotMatch(inspector, /\u001b\[(?:31|32|33)m/);
});

test("continuation handoff dashboard never labels the settled primary as retained", (t) => {
  const run = workflow("continuation-handoff", "running");
  const agent = run.agents[0]!;
  agent.state = "failed";
  agent.harness = "claude";
  agent.jobId = "settled-primary-123456";
  agent.continuationFallback = { harness: "codex" };
  agent.continuation = {
    state: "handoff",
    fromHarness: "claude",
    toHarness: "codex",
    failedJobId: "settled-primary-123456",
    checkpointAt: 1_000,
    checkoutDigest: "sha256:" + "a".repeat(64),
    trigger: { source: "continuation", provider: "claude", kind: "quota", detail: "quota after progress" },
    warning: "exactly-once is not guaranteed",
  };
  const state = harness([run], 34, () => {}, { theme });
  t.after(() => state.overlay.dispose());

  openAgentDetail(state.overlay, 140);
  state.overlay.handleInput("i");
  state.overlay.handleInput("g");
  const inspector = state.overlay.render(140).join("\n");
  assert.match(inspector, /Continuation · handoff · claude → codex · failed job/);
  assert.doesNotMatch(inspector, /retained job/, "no replacement session exists during the durable handoff");
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

  state.overlay.handleInput("i");
  state.overlay.handleInput("g");
  assert.match(state.overlay.render(52).join("\n"), /Activity/, "the bounded result body is reachable from the top");
  state.overlay.handleInput("G");
  assert.match(state.overlay.render(52).join("\n"), /standalone result 39/, "the result tail remains reachable after scrolling");
});

test("compact resize hides interaction without losing workflow focus or node identity", (t) => {
  const closed: WorkflowsDashboardAction[] = [];
  const state = harness([workflow("compact-resize")], 30, (action) => closed.push(action), { fullscreen: true });
  t.after(() => state.overlay.dispose());

  openAgentDetail(state.overlay, 52);
  assert.match(state.overlay.render(52).join("\n"), /agent ·/);

  state.setRows(5);
  const compact = state.overlay.render(52);
  assertPanel(compact, 52, 5);
  assert.match(compact.join("\n"), /Esc close/);
  assert.doesNotMatch(compact.join("\n"), /outline · phase|agent ·/);

  for (const input of [ENTER, "p", "r", "x", "X", PAGE_DOWN]) state.overlay.handleInput(input);
  assert.deepEqual(state.actions, [], "compact mode accepts only its displayed close control");

  state.setRows(30);
  const expanded = state.overlay.render(52).join("\n");
  assert.match(expanded, /agent · review/, "the detail focus and selected agent survive compact geometry");
  state.overlay.handleInput(ESCAPE);
  assert.match(state.overlay.render(52).join("\n"), /outline · phase/);
  state.overlay.handleInput(ESCAPE);
  assert.match(state.overlay.render(52).join("\n"), /runs ·/);
  state.overlay.handleInput(ESCAPE);
  assert.deepEqual(closed, [{ type: "close" }]);
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
  overlay.handleInput("j");
  overlay.handleInput("j");
  const selectedPhase = overlay.render(52).join("\n");
  assert.match(selectedPhase, /Second phase/, "phase selection starts from a known phase identity");
  overlay.handleInput(ENTER);
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
  assert.ok(overlay.render(52).some((line) => line.includes("Press x again")));
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

  openAgentDetail(overlay, 52);
  const tail = overlay.render(52).join("\n");
  assert.match(tail, /line 159/);
  overlay.handleInput("g");
  const pausedAtTop = overlay.render(72);
  assert.match(pausedAtTop.join("\n"), /line 0/);
  assert.match(
    pausedAtTop.find((line) => line.includes("transcript")) ?? "",
    /transcript \d+–\d+\/\d+ · paused · G resumes end/,
    "a terminal workflow agent resumes its end even while the run remains active",
  );
  const narrowPaused = overlay.render(40);
  assertPanel(narrowPaused, 40, 24);
  assert.match(
    overlay.render(72).find((line) => line.includes("transcript")) ?? "",
    /paused · G resumes end/,
    "width changes preserve workflow agent tail state",
  );
  overlay.handleInput(PAGE_DOWN);
  overlay.handleInput(CTRL_D);
  overlay.handleInput(SHIFT_UP);
  const pinned = overlay.render(52).join("\n");
  current.agents[0]!.output += "\nline 160";
  emit("scroll");
  assert.doesNotMatch(overlay.render(52).join("\n"), /line 160/, "upward scrolling unpins live tail following");
  overlay.handleInput("G");
  const resumed = overlay.render(52);
  assert.match(resumed.join("\n"), /line 160/);
  assert.match(resumed.find((line) => line.includes("transcript")) ?? "", /· end/);
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

test("an agentless selected phase renders its result when other phases contain agents", (t) => {
  const mixed = workflow("mixed-phase-result", "completed");
  const template = mixed.phases[0]!;
  mixed.currentPhase = 0;
  mixed.agents = [mixed.agents[0]!];
  mixed.agents[0]!.phase = 0;
  mixed.phases = [
    { ...template, index: 0, name: "Agent phase", agents: [0], result: undefined },
    { ...template, index: 1, name: "Agentless phase", agents: [], result: "agentless phase result" },
  ];
  const state = harness([mixed], 30);
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  state.overlay.handleInput(ENTER);
  state.overlay.handleInput("j");
  state.overlay.handleInput("j");
  const selected = state.overlay.render(52).join("\n");
  assert.match(selected, /Agentless phase/);
  assert.match(selected, /agentless phase result/);
});

test("cancellation is two-step, disarms on other input, and actions use stable run and agent identities", (t) => {
  const agentRun = workflow("agent-action");
  const agentHarness = harness([agentRun], 30);
  t.after(() => agentHarness.overlay.dispose());
  selectOutlineAgent(agentHarness.overlay, 52, 1);
  agentHarness.overlay.handleInput("x");
  agentHarness.overlay.handleInput("x");
  assert.deepEqual(agentHarness.actions, [], "navigation cannot synthesize a rendered agent-action proof");
  assert.ok(agentHarness.overlay.render(52).some((line) => line.includes("x cancel")));
  agentHarness.overlay.handleInput("x");
  assert.ok(agentHarness.overlay.render(52).some((line) => line.includes("Press x again")));
  agentHarness.overlay.handleInput("g");
  assert.deepEqual(agentHarness.actions, [], "another key disarms agent cancellation");
  agentHarness.overlay.handleInput("g");
  agentHarness.overlay.render(52);
  agentHarness.overlay.handleInput("x");
  agentHarness.overlay.handleInput("x");
  assert.deepEqual(agentHarness.actions, [], "confirmation cannot be accepted before its prompt renders");
  agentHarness.overlay.handleInput("g");
  agentHarness.overlay.render(52);
  agentHarness.overlay.handleInput("x");
  assert.ok(agentHarness.overlay.render(52).some((line) => line.includes("Press x again")));
  agentHarness.overlay.handleInput("x");
  assert.deepEqual(agentHarness.actions.at(-1), { type: "cancelAgent", runId: "agent-action", agentIndex: 1 });

  const noJobRun = workflow("agent-without-job");
  noJobRun.agents[1]!.jobId = undefined;
  const noJobHarness = harness([noJobRun], 30);
  t.after(() => noJobHarness.overlay.dispose());
  selectOutlineAgent(noJobHarness.overlay, 52, 1);
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
  runHarness.overlay.handleInput("g");
  runHarness.overlay.render(52);
  runHarness.overlay.handleInput("X");
  assert.ok(runHarness.overlay.render(52).some((line) => line.includes("Press X again")));
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
  selectOutlineAgent(restart.overlay, 72);
  restart.overlay.handleInput("r");
  assert.deepEqual(restart.actions, [], "navigation cannot synthesize a rendered restart proof");
  restart.overlay.render(72);
  restart.overlay.handleInput("r");
  assert.deepEqual(restart.actions.at(-1), { type: "restartAgent", runId: "restart", agentIndex: 0 });

  const filtered = harness([workflow("filter")], 30);
  t.after(() => filtered.overlay.dispose());
  selectOutlineAgent(filtered.overlay, 52);
  filtered.overlay.handleInput("f");
  const activeOnly = filtered.overlay.render(52);
  assert.ok(activeOnly.some((line) => line.includes("filter active")));
  assert.ok(activeOnly.some((line) => line.includes("tests")));
  assert.ok(!activeOnly.some((line) => line.includes("agent · review")), "a filtered-out inspected agent returns to the outline");
  filtered.overlay.handleInput("f");
  assert.match(filtered.overlay.render(52).join("\n"), /filter failed/);
  filtered.overlay.handleInput("r");
  filtered.overlay.handleInput("x");
  filtered.overlay.handleInput("x");
  assert.deepEqual(filtered.actions, [], "a filtered agent cannot remain an action target after fallback to its phase");

  const closed: WorkflowsDashboardAction[] = [];
  const bound = harness([workflow("binding")], 30, (action) => closed.push(action), { cancelBinding: "q" }).overlay;
  t.after(() => bound.dispose());
  openAgentDetail(bound, 52);
  bound.handleInput("q");
  assert.ok(bound.render(52).some((line) => line.includes("outline · phase")));
  bound.handleInput("q");
  assert.ok(bound.render(52).some((line) => line.includes("runs ·")));
  bound.handleInput("q");
  assert.deepEqual(closed, [{ type: "close" }]);
});

test("restart stays keyboard accessible when a narrow footer truncates its label", (t) => {
  for (const width of [40, 52]) {
    const state = harness([workflow(`narrow-restart-${width}`)], 30);
    t.after(() => state.overlay.dispose());
    selectOutlineAgent(state.overlay, width, 1);

    const rendered = state.overlay.render(width);
    assert.ok(
      rendered.some((line) => line.includes("›") && line.includes("tests")),
      `the selected restart target is visibly rendered at ${width} columns`,
    );
    assert.doesNotMatch(rendered.join("\n"), /r restart agent/, "the probe exercises a truncated footer label");

    state.overlay.handleInput("r");
    assert.deepEqual(state.actions.at(-1), {
      type: "restartAgent",
      runId: `narrow-restart-${width}`,
      agentIndex: 1,
    });
  }
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

  openOutline(overlay, 72);
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

  selectOutlineAgent(overlay, 120, 1); // select the running "tests" agent so restart/cancel stay actionable below

  manager.pause = (async () => { throw new Error("pause rejected"); }) as typeof manager.pause;
  overlay.handleInput("p");
  await tick();
  let after = overlay.render(120).join("\n");
  assert.match(after, /! pause rejected/);
  assert.match(after, /outline · phase/, "the outline stays open after a rejected pause");
  assert.deepEqual(closed, []);

  manager.resume = (async () => { throw new Error("resume rejected"); }) as typeof manager.resume;
  run.status = "paused";
  overlay.handleInput("p");
  await tick();
  after = overlay.render(120).join("\n");
  assert.match(after, /! resume rejected/);
  assert.deepEqual(closed, []);

  manager.restartAgent = (async () => { throw new Error("restart rejected"); }) as typeof manager.restartAgent;
  overlay.handleInput("g");
  overlay.render(120);
  overlay.handleInput("r");
  await tick();
  after = overlay.render(120).join("\n");
  assert.match(after, /! restart rejected/);
  assert.deepEqual(closed, []);

  manager.cancelAgent = (async () => { throw new Error("agent cancel rejected"); }) as typeof manager.cancelAgent;
  overlay.handleInput("g");
  overlay.render(120);
  overlay.handleInput("x");
  overlay.render(120);
  overlay.handleInput("x");
  await tick();
  after = overlay.render(120).join("\n");
  assert.match(after, /! agent cancel rejected/);
  assert.deepEqual(closed, []);

  manager.cancel = (async () => { throw new Error("run cancel rejected"); }) as typeof manager.cancel;
  overlay.handleInput("g");
  overlay.render(120);
  overlay.handleInput("X");
  overlay.render(120);
  overlay.handleInput("X");
  await tick();
  after = overlay.render(120).join("\n");
  assert.match(after, /! run cancel rejected/);
  assert.match(after, /outline · phase/, "the dashboard remains open after every rejected action");
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

  selectOutlineAgent(overlay, 72);
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

  selectOutlineAgent(overlay, 72, 1); // select the running "tests" agent
  overlay.render(72); // re-mark the newly selected agent visible before arming its cancellation
  overlay.handleInput("x");
  overlay.render(72);
  overlay.handleInput("x");
  assert.deepEqual(actions.at(-1), { type: "cancelAgent", runId: "inplace-cancel", agentIndex: 1 });
  await tick();
  let after = overlay.render(72).join("\n");
  assert.match(after, /outline · phase/, "the outline stays open after a successful agent cancellation");
  assert.match(after, /tests/, "the cancelled agent remains selected and visible");
  assert.deepEqual(closed, []);

  overlay.handleInput("g");
  overlay.render(72);
  overlay.handleInput("X");
  overlay.render(72);
  overlay.handleInput("X");
  assert.deepEqual(actions.at(-1), { type: "cancel", runId: "inplace-cancel" });
  await tick();
  after = overlay.render(72).join("\n");
  assert.match(after, /outline · phase/, "the outline stays open after a successful run cancellation");
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
  assert.ok(restoreState.overlay.render(52).some((line) => line.includes("runs ·")), "the panel regains its narrow run focus once interactive again");
  restoreState.overlay.handleInput(ENTER);
  assert.ok(restoreState.overlay.render(52).some((line) => line.includes("outline · phase")), "Enter opens the outline once the panel is interactive again");
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

  openAgentDetail(overlay, 60);
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

  openAgentDetail(overlay, 60);
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
  openAgentDetail(overlay, 72);
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
  openAgentDetail(overlay, 100);
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

  openAgentDetail(state.overlay, 72);
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
  overlay.handleInput(ENTER);
  overlay.handleInput(ENTER);
  const wide = overlay.render(120).join("\n");
  assert.match(wide, /agent · tests/, "wide selects the tests agent in the current phase");

  const medium = overlay.render(72).join("\n");
  assert.match(medium, /agent · tests/, "resizing to medium keeps the same agent identity");

  const narrow = overlay.render(52).join("\n");
  assert.match(narrow, /agent ·/, "resizing to narrow keeps the agent pane instead of resetting to the run list");
  assert.match(narrow, /tests/);

  overlay.handleInput(ESCAPE);
  assert.match(overlay.render(52).join("\n"), /outline · phase/, "the first Escape returns to the workflow outline");
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

test("the cheatsheet reflects runs, outline, and agent-detail focus and never closes the dashboard", (t) => {
  const { overlay, actions } = harness([workflow("cheatsheet-pane")], 30, () => {}, { fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(52); // narrow: starts on the run list
  overlay.handleInput("?");
  assert.match(overlay.render(52).join("\n"), /open outline/i, "the runs cheatsheet documents opening the outline");
  overlay.handleInput("?");

  overlay.handleInput(ENTER); // -> outline
  overlay.handleInput(ENTER); // -> first agent node
  overlay.handleInput(ENTER); // -> agent detail
  overlay.handleInput("?");
  const agentHelp = overlay.render(52).join("\n");
  assert.match(agentHelp, /restart this agent/i, "the agent-pane cheatsheet documents restart");
  assert.doesNotMatch(agentHelp, /pause \/ resume/i, "the agent-detail cheatsheet omits outline-only actions");

  for (const input of ["p", "r", "x", "X", "j", "k"]) overlay.handleInput(input);
  assert.deepEqual(actions, [], "input is inert while the cheatsheet is shown");
});

test("configurable confirm/cancel bindings render their configured key names in workflow hints, falling back to defaults otherwise", (t) => {
  const configured = harness([workflow("configured-keys")], 30, () => {}, {
    fullscreen: true,
    getKeys: (binding) => binding === "tui.select.cancel" ? ["q"] : binding === "tui.select.confirm" ? ["space"] : [],
  });
  t.after(() => configured.overlay.dispose());
  assert.match(configured.overlay.render(60).join("\n"), /Space\/→ outli/i, "the runs hint reflects the configured confirm key");
  configured.overlay.handleInput(ENTER);
  const outline = configured.overlay.render(90).join("\n");
  assert.match(outline, /Space\/→ drill/i);
  assert.match(outline, /Q back/i);
  assert.doesNotMatch(outline, /Esc close/);

  const defaulted = harness([workflow("default-keys")], 30, () => {}, { fullscreen: true });
  t.after(() => defaulted.overlay.dispose());
  const defaultHint = defaulted.overlay.render(90).join("\n");
  assert.match(defaultHint, /Enter\/→ outline/);
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
  assert.match(overviewText, /Question · Which compatibility behavior did we decide to preserve\?/);
  assert.match(overviewText, /Route · tests → peer review · waiting 5s/);
  assert.match(overviewText, /no human action required; waiting for peer review/);
  assert.match(overviewText, /waiting for review/, "the wait names the peer that owes the answer");
  assert.match(overviewText, /Which compatibility behavi/, "the bounded question rides along with the wait");
  assert.match(overviewText, /unanswered/);
  assert.match(overviewText, /answering peer/, "the target lineage shows the answer turn it is producing");

  selectOutlineAgent(state.overlay, 120, 1);
  state.overlay.handleInput(ENTER);
  const inspector = state.overlay.render(120).join("\n");
  assert.match(inspector, /agent · tests/);
  assert.match(inspector, /Question · Which compatibility behavior did we decide to preserve\?/);
  assert.match(inspector, /Route · tests → peer review · waiting 5s/);
  assert.match(inspector, /Question context · the task wording and the fixtures disagree/);
  assert.doesNotMatch(inspector, /Provider wait/, "an interaction wait is never reported as a provider-quota wait");

  const quotaState = harness([quota], 30, () => {}, { fullscreen: true, focusRunId: quota.runId });
  t.after(() => quotaState.overlay.dispose());
  openAgentDetail(quotaState.overlay, 120, 1);
  const quotaText = quotaState.overlay.render(120).join("\n");
  assert.match(quotaText, /Provider wait · tests · codex · window quota/);
  assert.match(quotaText, /Retry · 1m · attempt 1\/3 · automatic; no human action required/);
  assert.doesNotMatch(quotaText, /need input|Question ·/, "a provider wait never borrows the interaction vocabulary");
});

test("workflow question previews send orchestrator answers to the parent thread, never steering", (t) => {
  const run = workflow("orchestrator-question");
  const agent = run.agents[1]!;
  agent.waitingOn = {
    ordinal: 0,
    requestId: "req-parent",
    target: "orchestrator",
    sourceAgentIndex: agent.index,
    sourceName: agent.name,
    question: "Should the compatibility flag remain enabled?",
    state: "pending",
    createdAt: 60_000,
  };
  run.interactions = [agent.waitingOn];
  const state = harness([run], 30, () => {}, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  const overview = state.overlay.render(120).join("\n");
  assert.match(overview, /Route · tests → parent orchestrator · waiting 5s/);
  assert.match(overview, /parent thread: subagent_answer/);
  assert.match(overview, /do not steer/);

  openAgentDetail(state.overlay, 120, 1);
  const inspector = state.overlay.render(120).join("\n");
  assert.match(inspector, /Question · Should the compatibility flag remain enabled\?/);
  assert.match(inspector, /parent orchestrator/);
  assert.doesNotMatch(inspector, /s steer|takeover|a answer/);
});

test("workflow inspectors put state preview and real recovery before telemetry", (t) => {
  const failedRun = workflow("failed-priority", "failed");
  failedRun.error = "workflow bounded failure";
  failedRun.agents[1]!.state = "failed";
  failedRun.agents[1]!.error = "agent bounded failure";
  const failed = harness([failedRun], 30, () => {}, { fullscreen: true });
  t.after(() => failed.overlay.dispose());
  failed.overlay.render(120);
  failed.overlay.handleInput("i");
  let lines = failed.overlay.render(120);
  let text = lines.join("\n");
  assert.match(text, /Error · workflow bounded failure/);
  assert.match(text, /select tests, then press r to restart that agent/);
  assert.doesNotMatch(text, /restart (?:this )?run/);
  assert.ok(lines.findIndex((line) => line.includes("Error ·")) < lines.findIndex((line) => line.includes("Usage ·")));

  failed.overlay.handleInput("i");
  openAgentDetail(failed.overlay, 120, 1);
  lines = failed.overlay.render(120);
  text = lines.join("\n");
  assert.match(text, /Error · agent bounded failure/);
  assert.match(text, /Recovery · press r to restart this agent/);
  assert.doesNotMatch(text, /codex\/codex-fixture-model/, "routine route telemetry is folded by default");
  failed.overlay.handleInput("i");
  failed.overlay.handleInput("g");
  lines = failed.overlay.render(120);
  assert.ok(lines.findIndex((line) => line.includes("Error ·")) < lines.findIndex((line) => line.includes("codex\/codex-fixture-model")));

  const completedAgentRun = workflow("completed-agent-no-restart");
  completedAgentRun.agents[1]!.state = "completed";
  completedAgentRun.agents[1]!.callIndex = undefined;
  completedAgentRun.agents[1]!.output = "completed without a restart lineage";
  const completedAgent = harness([completedAgentRun], 30, () => {}, { fullscreen: true });
  t.after(() => completedAgent.overlay.dispose());
  openAgentDetail(completedAgent.overlay, 120, 1);
  const completedAgentText = completedAgent.overlay.render(120).join("\n");
  assert.match(completedAgentText, /Result · completed without a restart lineage/);
  assert.match(completedAgentText, /Next · no human action required/);
  assert.doesNotMatch(completedAgentText, /press r/);

  const completedRun = workflow("result-priority", "completed");
  completedRun.result = "concise workflow result";
  const completed = harness([completedRun], 8, () => {}, { fullscreen: true });
  t.after(() => completed.overlay.dispose());
  completed.overlay.render(52);
  completed.overlay.handleInput(ENTER);
  lines = completed.overlay.render(52);
  assertPanel(lines, 52, 8);
  assert.match(lines.join("\n"), /Result · .*no action · inspect here/);

  const running = workflow("activity-priority");
  running.logs = [{ index: 0, message: "assembling deterministic evidence", at: 64_000 }];
  running.agents[1]!.liveThinking = "checking the final assertion";
  running.agents[1]!.timestamps.updatedAt = 65_000;
  const active = harness([running], 30, () => {}, { fullscreen: true });
  t.after(() => active.overlay.dispose());
  let activeLines = active.overlay.render(120);
  assert.match(activeLines.join("\n"), /Latest · checking the final assertion/);
  assert.doesNotMatch(activeLines.join("\n"), /Usage ·/, "routine run usage is folded by default");
  active.overlay.handleInput("i");
  activeLines = active.overlay.render(120);
  assert.ok(activeLines.findIndex((line) => line.includes("Latest ·")) < activeLines.findIndex((line) => line.includes("Usage ·")));

  const paused = workflow("pause-priority", "paused");
  const pausedState = harness([paused], 30, () => {}, { fullscreen: true });
  t.after(() => pausedState.overlay.dispose());
  assert.match(pausedState.overlay.render(120).join("\n"), /Paused · paused by operator[\s\S]*press p to resume; human action is required/);

  const queued = workflow("queue-priority", "pending");
  const queuedState = harness([queued], 30, () => {}, { fullscreen: true });
  t.after(() => queuedState.overlay.dispose());
  assert.match(queuedState.overlay.render(120).join("\n"), /Waiting · queued for workflow dispatch[\s\S]*automatic dispatch; no human action required/);
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

  state.overlay.render(200);
  state.overlay.handleInput("i");
  const wide = state.overlay.render(200);
  assertPanel(wide, 200, 30);
  const line = wide.find((entry) => entry.includes("Convergence · "));
  assert.ok(line, "the inspector reports convergence state");
  assert.ok(line.includes("≡") && line.includes("stalled"), "state is carried by a glyph and by words");
  assert.match(line, /round 3\/3/);
  assert.match(line, /verdict request_changes · 2 actionable findings/);
  assert.match(line, /repeated the same 2 unresolved finding/);

  // Narrow layouts show one focus layer at a time: drill from runs into the outline.
  state.overlay.render(40);
  state.overlay.handleInput(ENTER);
  const narrow = state.overlay.render(40);
  assertPanel(narrow, 40, 30);
  assert.ok(narrow.some((entry) => entry.includes("Convergence · ")), "convergence survives the narrow layout");

  const plain = harness([workflow("one-shot", "completed")], 30, () => {}, { fullscreen: true });
  t.after(() => plain.overlay.dispose());
  assert.ok(!plain.overlay.render(200).some((entry) => entry.includes("Convergence · ")), "one-shot runs show no convergence line");
});
