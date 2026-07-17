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
        timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000 }, backend: "claude", model: "sonnet", effort: "high",
        jobId: "review-job-0001", prompt: "Review the implementation", tools: [{ id: "read-1", name: "read", summary: "src/index.ts", status: "completed" }],
        output: "review result", preview: "review result", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
      },
      {
        index: 1, label: "tests", role: "worker", phase: 0, state: status === "running" ? "running" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000 }, backend: "codex", model: "gpt-5", effort: "medium",
        jobId: "tests-job-0002", prompt: "\u001b[31mRun the affected tests\u001b[0m", liveThinking: "\u001b]0;bad\u0007checking failures", tools: [{ id: "bash-1", name: "bash", summary: "npm test", status: "running" }],
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
    cancelAgent: async (runId: string, agentIndex: number) => {
      const run = runs.find((candidate) => candidate.runId === runId)!;
      const agent = run.agents[agentIndex];
      if (agent) agent.state = "cancelled";
      return run;
    },
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

  overlay.render(72);
  overlay.handleInput("\r");
  const lines = overlay.render(72);
  assert.deepEqual(sources, ["# Verdict\n\n**PASS**", "review result"], "assistant transcript and distinct final result use Markdown");
  assert.ok(lines.some((line) => line.includes("\u001b[1mVerdict\u001b[0m")), "native Markdown styling survives dashboard chrome");
  assert.ok(lines.some((line) => line.includes("> **inspect this literally**")), "user transcript remains an explicit role row");
  assert.ok(lines.some((line) => line.includes("~ considering options")), "thinking transcript remains explicitly styled");
  assert.ok(lines.some((line) => line.includes("→ read · file.ts")), "tool transcript remains explicitly styled");
  assert.ok(lines.some((line) => line.includes("Review the implementation")), "agent inspector exposes the bounded caller prompt");
  assert.ok(lines.some((line) => line.includes("effort high")), "agent inspector exposes effort and route metadata");

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

  const failed = workflow("failed-agent", "failed");
  failed.agents[0]!.state = "failed";
  failed.agents[0]!.error = "Agent output did not match the requested JSON Schema";
  failed.agents[0]!.structured = { clean: false };
  failed.agents[0]!.transcript = undefined;
  failed.agents[0]!.output = undefined;
  const failedSources: string[] = [];
  const failedOverlay = harness([failed], 30, () => {}, (text) => {
    failedSources.push(text);
    return text.split("\n");
  }).overlay;
  t.after(() => failedOverlay.dispose());
  failedOverlay.render(72);
  failedOverlay.handleInput("\r");
  const failedLines = failedOverlay.render(72);
  assert.ok(failedLines.some((line) => line.includes("did not match")), "failed-agent inspector exposes the failure reason");
  assert.ok(failedSources.includes("```json\n{\n  \"clean\": false\n}\n```"), "transcriptless structured output remains inspectable");

  const stress = workflow("bounded-sections", "failed");
  const stressAgent = stress.agents[0]!;
  stressAgent.state = "failed";
  stressAgent.error = `${"long error context ".repeat(80)}ERROR_SUFFIX`;
  stressAgent.prompt = "prompt context ".repeat(200);
  stressAgent.liveThinking = "thinking context ".repeat(200);
  stressAgent.structured = { details: `${"structured context ".repeat(400)}STRUCTURED_SUFFIX` };
  stressAgent.transcript = [{ kind: "assistant", text: `${"transcript context ".repeat(1_000)}TRANSCRIPT_SUFFIX` }];
  stressAgent.output = `distinct final ${"result context ".repeat(600)}FINAL_SUFFIX`;
  const stressOverlay = harness([stress], 32, () => {}, (text, width) => text.split("\n").flatMap((line) => {
    const value = line || " ";
    return Array.from({ length: Math.max(1, Math.ceil(value.length / width)) }, (_, index) => value.slice(index * width, (index + 1) * width));
  })).overlay;
  t.after(() => stressOverlay.dispose());
  stressOverlay.render(60);
  stressOverlay.handleInput("\r");
  const seen = new Set<string>();
  for (let page = 0; page < 40; page++) {
    for (const line of stressOverlay.render(60)) seen.add(line);
    stressOverlay.handleInput("\u001b[6~");
  }
  const allDetail = [...seen].join("\n");
  for (const section of ["Error", "Prompt", "Activity", "Structured result", "Transcript", "Final result"]) {
    assert.match(allDetail, new RegExp(section), `${section} remains reachable under combined maximum sections`);
  }
  const compactDetail = allDetail.replace(/[\s│║]+/g, "");
  assert.match(compactDetail, /ERROR_SUFFIX/, "wrapped error tail remains reachable");
  assert.match(compactDetail, /STRUCTURED_SUFFIX/, "bounded structured-result tail remains reachable");
  assert.match(compactDetail, /TRANSCRIPT_SUFFIX/, "bounded transcript tail remains reachable");
  assert.match(compactDetail, /FINAL_SUFFIX/, "bounded final-result tail remains reachable");

  const transcriptless = workflow("transcriptless", "completed");
  transcriptless.agents[0]!.transcript = undefined;
  transcriptless.agents[0]!.output = `${"standalone result context ".repeat(1_000)}STANDALONE_SUFFIX`;
  const transcriptlessOverlay = harness([transcriptless], 32, () => {}, (text, width) => text.split("\n").flatMap((line) => {
    const value = line || " ";
    return Array.from({ length: Math.max(1, Math.ceil(value.length / width)) }, (_, index) => value.slice(index * width, (index + 1) * width));
  })).overlay;
  t.after(() => transcriptlessOverlay.dispose());
  transcriptlessOverlay.render(60);
  transcriptlessOverlay.handleInput("\r");
  const transcriptlessSeen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    for (const line of transcriptlessOverlay.render(60)) transcriptlessSeen.add(line);
    transcriptlessOverlay.handleInput("\u001b[6~");
  }
  assert.match([...transcriptlessSeen].join("").replace(/[\s│║]+/g, ""), /STANDALONE_SUFFIX/, "transcriptless final-output tail remains reachable");
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
  overlay.handleInput("\r");
  const workerHeader = overlay.render(52);
  assert.ok(workerHeader.some((line) => line.includes("Run the affected tests")));
  assert.ok(workerHeader.some((line) => line.includes("checking failures")) || workerHeader.some((line) => line.includes("npm test")));
  assert.ok(workerHeader.every((line) => !line.includes("\u001b]")), "prompt and live thinking strip terminal control sequences");
  for (let index = 0; index < 30; index++) overlay.handleInput("\u001b[6~");
  const inspectedWorker = overlay.render(52);
  assert.ok(inspectedWorker.some((line) => line.includes("REACHABLE_SUFFIX")));

  overlay.handleInput("h");
  overlay.handleInput("j");
  const selectedSecond = overlay.render(52);
  assert.ok(selectedSecond.some((line) => line.includes("Release second")));
  assert.ok(selectedSecond.some((line) => line.includes("review")), "overview exposes the phase agent roster");
  overlay.handleInput("\r");
  assert.ok(overlay.render(52).some((line) => line.includes("review result")), "agent inspector exposes the selected result");
  overlay.handleInput("X");
  assert.deepEqual(actions, [{ type: "cancel", runId: "second" }]);

  const agentActions: unknown[] = [];
  const filtered = harness([workflow("agent-action")], 30, (action) => agentActions.push(action)).overlay;
  t.after(() => filtered.dispose());
  filtered.render(72);
  filtered.handleInput("f");
  const activeOnly = filtered.render(72);
  assert.ok(activeOnly.some((line) => line.includes("filter active")));
  assert.ok(activeOnly.some((line) => line.includes("tests")));
  assert.ok(!activeOnly.some((line) => line.includes("reviewer")), "status filter hides completed agents");
  filtered.handleInput("x");
  assert.deepEqual(agentActions, [{ type: "cancelAgent", runId: "agent-action", agentIndex: 1 }]);
});
