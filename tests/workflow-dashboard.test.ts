import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowsDashboardOverlay,
  openWorkflowsDashboard,
  truncateWorkflowDashboardLine,
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

function harness(runs: WorkflowSnapshot[], rows = 30, done: (action: unknown) => void = () => {}) {
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
    { now: () => 65_000 },
  );
  return { overlay, manager, renders: () => renders, emit: () => listener?.(runs[0]!), unsubscribed: () => unsubscribed, checked };
}

test("workflow dashboard truncation handles ANSI and Unicode display width", () => {
  const rendered = truncateWorkflowDashboardLine("\u001b[31mfailed 你好世界\u001b[0m", 12);
  assert.ok(visibleWidth(rendered) <= 12);
  assert.equal(truncateWorkflowDashboardLine("你好世界", 5).replace(/\u001b\[[0-9;]*m/g, ""), "你好…");
  assert.equal(truncateWorkflowDashboardLine("anything", 0), "");
});

test("dashboard renders a polished focused frame, run list, phase, and agent detail", (t) => {
  const { overlay, checked } = harness([workflow("run-one"), workflow("run-two", "completed")]);
  t.after(() => overlay.dispose());
  overlay.focused = true;
  const lines = overlay.render(72);
  assert.equal(lines[0], `╔${"═".repeat(70)}╗`);
  assert.equal(lines.at(-1), `╚${"═".repeat(70)}╝`);
  assert.ok(lines.some((line) => line.includes("Workflow Runs")));
  assert.ok(lines.some((line) => line.includes("Verification")));
  assert.ok(lines.some((line) => line.includes("reviewer")));
  assert.ok(lines.some((line) => line.includes("Esc close")));
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
  assert.ok(checked.includes("run-one"));
});

test("dashboard sanitizes control sequences and remains safe at narrow and short sizes", (t) => {
  const dirty = workflow("dirty");
  dirty.name = "\u001b[31mhostile\u001b[0m\u0007";
  dirty.phases[0]!.name = "\u001b]0;phase\u0007verify";
  dirty.agents[0]!.label = "agent\u0000label";
  dirty.agents[0]!.output = "first\u0008 line\n\u001b[2Ksecond";
  for (const rows of [1, 3, 7, 12, 24]) {
    const { overlay } = harness([dirty], rows);
    t.after(() => overlay.dispose());
    for (const width of [0, 2, 8, 36]) {
      const lines = overlay.render(width);
      assert.ok(lines.length <= Math.floor(rows * 0.9));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const withoutThemeAnsi = lines.map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
      assert.ok(
        withoutThemeAnsi.every((line) => !/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(line)),
        `rows=${rows} width=${width}: ${JSON.stringify(lines)}`,
      );
      assert.ok(lines.every((line) => !line.includes("\u001b]")));
    }
  }
});

test("dashboard navigates runs and agents, then scrolls wrapped bounded result", (t) => {
  const first = workflow("first");
  first.agents[1]!.output = `${"wrapped segment ".repeat(200)}REACHABLE_SUFFIX`;
  const second = workflow("second");
  const { overlay } = harness([first, second], 30);
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
});

test("dashboard cancels only active runs and closes via Escape or configured binding", () => {
  const actions: unknown[] = [];
  const active = harness([workflow("done", "completed"), workflow("active")], 24, (action) => actions.push(action));
  active.overlay.handleInput("x");
  assert.deepEqual(actions, []);
  active.overlay.handleInput("j");
  active.overlay.handleInput("x");
  assert.deepEqual(actions, [{ type: "cancel", runId: "active" }]);

  const escaped: unknown[] = [];
  const escapeOverlay = harness([workflow("one")], 24, (action) => escaped.push(action)).overlay;
  escapeOverlay.handleInput("\x1b");
  escapeOverlay.handleInput("\x1b");
  assert.deepEqual(escaped, [{ type: "close" }]);

  const configured: unknown[] = [];
  harness([workflow("two")], 24, (action) => configured.push(action)).overlay.handleInput("\u0003");
  assert.deepEqual(configured, [{ type: "close" }]);
});

test("dashboard subscription redraws and dispose clears timer and subscription exactly once", () => {
  let cleared = 0;
  let renders = 0;
  let unsubscribed = 0;
  let listener: ((snapshot: WorkflowSnapshot) => void) | undefined;
  const run = workflow("tracked");
  const manager = {
    list: () => [run],
    check: () => run,
    cancel: async () => run,
    subscribe: (next: (snapshot: WorkflowSnapshot) => void) => {
      listener = next;
      return () => { unsubscribed++; };
    },
  };
  const overlay = createWorkflowsDashboardOverlay(
    { requestRender: () => { renders++; } } as never,
    theme,
    { matches: () => false } as unknown as KeybindingsManager,
    manager,
    () => {},
    {
      setInterval: (() => 42) as unknown as typeof setInterval,
      clearInterval: (() => { cleared++; }) as unknown as typeof clearInterval,
    },
  );
  listener?.(run);
  assert.equal(renders, 1);
  overlay.dispose();
  overlay.dispose();
  assert.equal(cleared, 1);
  assert.equal(unsubscribed, 1);
});

test("openWorkflowsDashboard cancels from the overlay action", async () => {
  const run = workflow("active");
  const cancellations: Array<[string, string | undefined]> = [];
  let customCalls = 0;
  const manager = {
    list: () => [run],
    check: () => run,
    cancel: async (runId: string, reason?: string) => {
      cancellations.push([runId, reason]);
      run.status = "aborted";
      return run;
    },
    subscribe: () => () => {},
  };
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => customCalls++ === 0 ? { type: "cancel", runId: "active" } : { type: "close" },
      notify: () => {},
    },
  } as never;
  await openWorkflowsDashboard(ctx, manager);
  assert.deepEqual(cancellations, [["active", "Cancelled from /workflows dashboard"]]);
});
