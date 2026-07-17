import test from "node:test";
import assert from "node:assert/strict";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowsDashboardOverlay,
} from "../extensions/workflows/dashboard.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function workflow(id: string, status: WorkflowSnapshot["status"] = "running"): WorkflowSnapshot {
  const settledAgentState = status === "pending" ? "queued" as const : status;
  return {
    runId: id,
    sessionId: "session",
    name: `Release ${id}`,
    description: "Review and verify Unicode output 你好世界",
    background: true,
    status,
    timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000, ...(status === "running" ? {} : { endedAt: 4_000 }) },
    currentPhase: 0,
    phases: [{ index: 0, name: "Verification", status, timestamps: { createdAt: 1_000, updatedAt: 3_000 }, agents: [0, 1] }],
    agents: [
      {
        index: 0, label: "review", role: "reviewer", phase: 0, state: status === "running" ? "completed" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000 }, backend: "claude", model: "sonnet",
        output: "review result", preview: "review result", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
      },
      {
        index: 1, label: "tests", role: "worker", phase: 0, state: status === "running" ? "running" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000 }, backend: "codex", model: "gpt-5",
        output: Array.from({ length: 60 }, (_, index) => `test result ${index}`).join("\n"), preview: "test result 59",
        usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0, cost: 0.02, turns: 2 },
      },
    ],
    result: "workflow result",
    artifactDir: `/private/${id}`,
  };
}

function harness(
  runs: WorkflowSnapshot[],
  rows = 30,
  done: (action: unknown) => void = () => {},
  renderMarkdown?: (text: string, width: number) => string[],
) {
  let renders = 0;
  let listener: ((snapshot: WorkflowSnapshot) => void) | undefined;
  let unsubscribed = 0;
  const checked: string[] = [];
  const manager = {
    list: () => runs,
    check: (runId: string) => {
      checked.push(runId);
      const run = runs.find((candidate) => candidate.runId === runId);
      if (!run) throw new Error("unknown run");
      return run;
    },
    cancel: async (runId: string) => runs.find((candidate) => candidate.runId === runId)!,
    subscribe: (next: (snapshot: WorkflowSnapshot) => void) => {
      listener = next;
      return () => { unsubscribed++; };
    },
  };
  const overlay = createWorkflowsDashboardOverlay(
    { requestRender: () => { renders++; }, terminal: { rows } } as never,
    theme,
    { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\u0003" } as unknown as KeybindingsManager,
    manager,
    done as never,
    { now: () => 65_000, renderMarkdown },
  );
  return { overlay, manager, renders: () => renders, emit: () => listener?.(runs[0]!), unsubscribed: () => unsubscribed, checked };
}

test("workflow results use native Markdown while transcript roles keep explicit styling", (t) => {
  const markdown = workflow("markdown", "completed");
  markdown.agents[0]!.transcript = [
    { kind: "user", text: "**inspect this literally**" },
    { kind: "thinking", text: "considering options" },
    { kind: "assistant", text: "\u001b[31m# Verdict\u001b[0m\n\n**PASS**" },
    { kind: "tool", toolId: "t1", name: "read", text: "file.ts" },
  ];
  const sources: string[] = [];
  const { overlay } = harness([markdown], 30, () => {}, (text) => {
    sources.push(text);
    return ["\u001b[1mVerdict\u001b[0m", "\u001b[32mPASS\u001b[0m"];
  });
  t.after(() => overlay.dispose());

  const lines = overlay.render(72);
  assert.deepEqual(sources, ["# Verdict\n\n**PASS**"], "only assistant content is routed through Markdown");
  assert.ok(lines.some((line) => line.includes("\u001b[1mVerdict\u001b[0m")), "native Markdown styling survives dashboard chrome");
  assert.ok(lines.some((line) => line.includes("> **inspect this literally**")), "user transcript remains an explicit role row");
  assert.ok(lines.some((line) => line.includes("~ considering options")), "thinking transcript remains explicitly styled");
  assert.ok(lines.some((line) => line.includes("→ read · file.ts")), "tool transcript remains explicitly styled");

  const standalone = workflow("standalone", "completed");
  standalone.agents = [];
  standalone.phases[0]!.agents = [];
  standalone.result = "## Summary\n\n- one\n- two";
  const resultSources: string[] = [];
  const resultOverlay = harness([standalone], 30, () => {}, (text) => {
    resultSources.push(text);
    return ["\u001b[1mSummary\u001b[0m", "• one", "• two"];
  }).overlay;
  t.after(() => resultOverlay.dispose());
  assert.ok(resultOverlay.render(72).some((line) => line.includes("\u001b[1mSummary\u001b[0m")));
  assert.deepEqual(resultSources, ["## Summary\n\n- one\n- two"], "standalone workflow results are routed through Markdown");

  standalone.result = false;
  resultSources.length = 0;
  resultOverlay.render(72);
  assert.deepEqual(resultSources, ["```json\nfalse\n```"], "structured and falsey results retain readable fenced JSON");
});

test("dashboard navigation, cancellation, and scrolling share one interaction contract", (t) => {
  const first = workflow("first");
  first.agents[1]!.output = `${"wrapped segment ".repeat(200)}REACHABLE_SUFFIX`;
  const second = workflow("second");
  const actions: unknown[] = [];
  const { overlay } = harness([first, second], 30, (action) => actions.push(action));
  t.after(() => overlay.dispose());

  overlay.render(52);
  overlay.handleInput("\t");
  assert.ok(overlay.render(52).some((line) => line.includes("worker")));
  for (let index = 0; index < 30; index++) overlay.handleInput("\u001b[6~");
  assert.ok(overlay.render(52).some((line) => line.includes("REACHABLE_SUFFIX")));

  overlay.handleInput("j");
  const selectedSecond = overlay.render(52);
  assert.ok(selectedSecond.some((line) => line.includes("Release second")));
  assert.ok(selectedSecond.some((line) => line.includes("review result")));
  overlay.handleInput("x");
  assert.deepEqual(actions, [{ type: "cancel", runId: "second" }]);
});
