import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ansiTheme, availabilityFixture, interactionSnapshot, jobSnapshot, theme, tick } from "./helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import {
  createDashboardOverlay,
  truncateDashboardLine,
} from "../extensions/subagents/dashboard.ts";
import { alignDashboardRow, createDashboardFrame, dashboardLayout } from "../extensions/dashboard-style.ts";
import { dashboardCollectionViewport, groupDashboardCollection } from "../extensions/dashboard-collection.ts";
import { TakeoverView, buildTranscript } from "../extensions/subagents/takeover.ts";
import { renderAssistantMarkdown } from "../extensions/subagents/transcript.ts";
import type { JobSnapshot } from "../src/types.ts";
import { harnessActivation, type HarnessActivation } from "../src/harness-availability.ts";

initTheme("dark", false);

const ENTER = "\r";
const ESCAPE = "\u001b";
const PAGE_UP = "\u001b[5~";
const CTRL_T = String.fromCharCode(20);
const PAGE_DOWN = "\u001b[6~";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";

test("dashboard truncation respects terminal display width for Unicode and ANSI", () => {
  for (const value of [
    "reviewer · 你好世界 · codex/fixture-model",
    "worker · 👩🏽‍💻 launch 🚀 complete",
    "\u001b[31mfailed 你好世界\u001b[0m",
  ]) {
    const rendered = truncateDashboardLine(value, 14);
    assert.ok(visibleWidth(rendered) <= 14, `${JSON.stringify(rendered)} exceeds terminal width`);
  }
  assert.equal(truncateDashboardLine("你好世界", 5).replace(/\u001b\[[0-9;]*m/g, ""), "你好…");
  assert.equal(truncateDashboardLine("anything", 0), "");
});

test("shared dashboard framing stays within tiny Unicode and ANSI widths", () => {
  for (const width of [0, 1, 2, 3, 4, 5]) {
    const frame = createDashboardFrame(ansiTheme, width, true);
    const lines = [
      frame.header("左 [31m你好[0m", "右 👩🏽‍💻"),
      frame.top("标题 你好"),
      frame.divider("分隔"),
      frame.row("[31m你好世界[0m"),
      frame.bottom(),
      frame.splitTop("左", "右", 1),
      frame.splitRow("[31m你好[0m", "世界", 1),
      frame.splitBottom(1),
      frame.hint("[31m提示你好[0m", "· Esc close"),
      alignDashboardRow("[31m你好世界[0m", "右👩🏽‍💻", width),
    ];
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `a frame line exceeds ${width} columns`);
  }
});

test("dashboard layout adapts to fullscreen terminal geometry", () => {
  assert.equal(dashboardLayout(120, 24).kind, "wide");
  assert.equal(dashboardLayout(72, 24).kind, "medium");
  assert.equal(dashboardLayout(50, 24).kind, "narrow");
  assert.equal(dashboardLayout(120, 8).kind, "narrow");
});

test("grouped collection rows keep headers presentational and selected entities visible at one row", () => {
  const definitions = [
    { key: "active", label: "Active" },
    { key: "finished", label: "Finished", foldLabel: "finished" },
  ] as const;
  const collection = groupDashboardCollection(
    [
      { id: "done-1", group: "finished" as const },
      { id: "live", group: "active" as const },
      { id: "done-2", group: "finished" as const },
    ],
    definitions,
    (item) => item.group,
  );

  assert.deepEqual(collection.items.map((item) => item.id), ["live", "done-1", "done-2"]);
  const view = dashboardCollectionViewport(collection, "done-2", 1, (item) => item.id);
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0]?.kind, "item", "a section header never consumes the selected entity's only row");
  assert.equal(view.rows[0]?.kind === "item" ? view.rows[0].item.id : undefined, "done-2");

  const pressured = groupDashboardCollection(
    [
      { id: "live-1", group: "active" as const },
      { id: "live-2", group: "active" as const },
      { id: "live-3", group: "active" as const },
      { id: "done", group: "finished" as const },
    ],
    definitions,
    (item) => item.group,
  );
  const pressuredView = dashboardCollectionViewport(pressured, "live-1", 3, (item) => item.id);
  assert.ok(pressuredView.rows.some((row) => row.kind === "item" && row.item.id === "live-1"));
  assert.ok(pressuredView.rows.some((row) => row.kind === "fold" && row.hidden === 1), "folding always has a visible count when two rows fit");
});

test("direct jobs render attention groups with counts and navigate only entity rows", (t) => {
  const blocked = {
    ...job("blocked"),
    name: "input-row",
    interaction: interactionSnapshot({ sourceJobId: "blocked", sourceName: "blocked" }),
  };
  const working = { ...job("working"), name: "work-row" };
  const queued = { ...job("queued", "queued"), name: "queue-row" };
  const failed = { ...job("failed", "failed"), name: "error-row" };
  const completed = { ...job("completed", "completed"), name: "done-row" };
  const cancelled = { ...job("cancelled", "cancelled"), name: "cancel-row" };
  const state = dashboard(
    [completed, failed, cancelled, queued, working, blocked],
    30,
    () => {},
    undefined,
    { focusJobId: blocked.id, fullscreen: true },
  );
  t.after(() => state.overlay.dispose());

  const lines = state.overlay.render(160);
  const text = lines.join("\n");
  for (const heading of [
    "Needs input · 1",
    "Working · 1",
    "Queued or waiting · 1",
    "Failed · 1",
    "Finished · 2",
  ]) assert.match(text, new RegExp(heading));

  const positions = ["input-row", "work-row", "queue-row", "error-row", "done-row"]
    .map((name) => lines.findIndex((line) => line.includes(name)));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, "rows follow attention order");
  assert.match(lines.find((line) => line.includes("input-row") && line.includes("❯")) ?? "", /running/, "a routed question does not erase the lifecycle status");
  assert.match(lines.find((line) => line.includes("cancel-row")) ?? "", /cancelled/);

  state.overlay.handleInput("j");
  const selected = state.overlay.render(160).find((line) => line.includes("work-row") && line.includes("❯"));
  assert.ok(selected, "one navigation step skips the section header and selects the next entity");
  state.overlay.handleInput("x");
  state.overlay.render(160);
  state.overlay.handleInput("x");
  assert.deepEqual(state.manager.cancelCalls, ["working"], "the destructive action targets the selected entity, never a header");
});

test("direct job folding yields to live work and reveals the selected finished identity", (t) => {
  const live = { ...job("live"), name: "live" };
  const finished = Array.from({ length: 8 }, (_, index) => ({
    ...job(`done-${index + 1}`, "completed"),
    name: `done-${index + 1}`,
  }));
  const jobs = [live, ...finished];
  const state = dashboard(jobs, 7, () => {}, undefined, { focusJobId: live.id, fullscreen: true });
  t.after(() => state.overlay.dispose());

  let lines = state.overlay.render(120);
  assert.equal(lines.length, 7);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  assert.ok(lines.some((line) => line.includes("live")));
  assert.ok(lines.some((line) => line.includes("8 finished hidden")));

  for (let index = 0; index < 6; index++) state.overlay.handleInput("j");
  lines = state.overlay.render(120);
  assert.ok(lines.some((line) => line.includes("done-6") && line.includes("❯")), "navigation reveals the selected folded job");
  assert.ok(lines.some((line) => line.includes("7 finished hidden")));

  finished[5]!.status = "running";
  jobs.reverse();
  lines = state.overlay.render(120);
  assert.ok(lines.some((line) => line.includes("done-6") && line.includes("❯")), "the selected job ID survives reordering into Working");
});

test("grouped job folding stays within wide, medium, and narrow panel geometry", (t) => {
  const jobs = [
    { ...job("active"), name: "active" },
    ...Array.from({ length: 30 }, (_, index) => ({
      ...job(`history-${index}`, "completed"),
      name: `history-${index}`,
    })),
  ];
  for (const width of [120, 72, 52]) {
    const state = dashboard(jobs, 30, () => {}, undefined, { focusJobId: "active", fullscreen: true });
    t.after(() => state.overlay.dispose());
    const lines = state.overlay.render(width);
    assert.equal(lines.length, 30);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.some((line) => line.includes("active")));
    assert.ok(lines.some((line) => line.includes("finished hidden")), `${width}-column layout exposes the folded count`);
  }
});

test("job summaries render in wide, medium, and narrow rows without displacing identity", (t) => {
  for (const width of [120, 72, 52]) {
    const current = jobSnapshot({
      id: `summary-${width}`,
      name: "worker",
      liveThinking: "checking semantic summary",
    });
    const state = dashboard([current], 30, () => {}, undefined, { fullscreen: true });
    t.after(() => state.overlay.dispose());
    const lines = state.overlay.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.some((line) => line.includes("worker") && line.includes("check")), `${width}-column row shows the job summary`);
  }

  const constrained = dashboard([jobSnapshot({
    id: "identity-priority",
    name: "identity-survives",
    liveThinking: "SUMMARY_MUST_YIELD",
  })], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => constrained.overlay.dispose());
  const text = constrained.overlay.render(40).join("\n");
  assert.match(text, /ide/);
  assert.doesNotMatch(text, /SUMMARY_MUST_YIELD/, "summary yields before the job name at the constrained width");

  const owned = dashboard([jobSnapshot({
    id: "workflow-owned",
    name: "owned",
    workflow: { runId: "run-owned", agentIndex: 0, label: "build" },
  })], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => owned.overlay.dispose());
  assert.ok(owned.overlay.render(120).some((line) => line.includes("owned") && line.includes("workflow")));
  assert.ok(owned.overlay.render(40).some((line) => line.includes("owned") && line.includes("workflow")), "workflow ownership survives the minimum width");
});

test("detail focus keeps Page Up and Page Down aliases in wide and medium layouts", (t) => {
  const output = Array.from({ length: 80 }, (_, index) => `page ${index}`).join("\n");
  for (const width of [120, 72]) {
    const state = dashboard([{ ...job(`paging-${width}`, "completed"), output, transcript: [{ kind: "assistant", text: output }] }], 30, () => {}, (text) => text.split("\n"), { fullscreen: true });
    t.after(() => state.overlay.dispose());

    assert.equal(dashboardLayout(width, 30).kind, width === 120 ? "wide" : "medium");
    state.overlay.render(width);
    state.overlay.handleInput(ENTER);
    state.overlay.handleInput("g");
    const top = state.overlay.render(width).join("\n");
    state.overlay.handleInput(PAGE_DOWN);
    assert.notEqual(state.overlay.render(width).join("\n"), top, `Page Down advances the ${width}-column detail`);
    state.overlay.handleInput(PAGE_UP);
    assert.equal(state.overlay.render(width).join("\n"), top, `Page Up returns to the ${width}-column detail top`);
  }
});

test("explicit job focus separates selection, detail scrolling, and composer drafts", (t) => {
  const output = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
  const first = { ...job("focus-first"), name: "focus-first", output, transcript: [{ kind: "assistant" as const, text: output }] };
  const second = { ...job("focus-second"), name: "focus-second" };
  const state = dashboard([first, second], 30, () => {}, (text) => text.split("\n"), {
    focusJobId: first.id,
    fullscreen: true,
  });
  t.after(() => state.overlay.dispose());
  state.overlay.focused = true;

  state.overlay.render(120);
  state.overlay.handleInput("j");
  assert.match(state.overlay.render(120).find((line) => line.includes("focus-second") && line.includes("❯")) ?? "", /focus-second/);
  state.overlay.handleInput("k");
  state.overlay.handleInput(RIGHT);
  assert.match(state.overlay.render(52).join("\n"), /▸ detail/, "Right drills into detail and survives a narrow resize");

  state.overlay.handleInput("g");
  const top = state.overlay.render(120).join("\n");
  state.overlay.handleInput("j");
  const scrolled = state.overlay.render(120);
  assert.notEqual(scrolled.join("\n"), top, "j scrolls instead of changing jobs in detail focus");
  assert.match(scrolled.find((line) => line.includes("focus-first") && line.includes("❯")) ?? "", /focus-first/);
  const pausedRange = scrolled.find((line) => line.includes("transcript"));

  state.overlay.handleInput("s");
  for (const character of "keep this draft") state.overlay.handleInput(character);
  state.overlay.handleInput(LEFT);
  assert.match(state.overlay.render(120).join("\n"), /▸ detail/, "Left backs out of the composer by one layer");
  state.overlay.handleInput("s");
  assert.match(state.overlay.render(120).join("\n"), /keep this draft/, "the steer draft survives focus changes");
  state.overlay.handleInput(ESCAPE);
  state.overlay.handleInput(LEFT);
  assert.match(state.overlay.render(120).join("\n"), /▸ jobs/, "Left backs out from detail to the job list");
  state.overlay.handleInput(RIGHT);
  assert.equal(
    state.overlay.render(120).find((line) => line.includes("transcript")),
    pausedRange,
    "detail focus changes preserve the paused transcript viewport",
  );
});

test("minimum-width live cancellation keeps its Unicode hint visible through confirmation", (t) => {
  const state = dashboard([{ ...job("cancel-你好👩🏽‍💻") }], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  const initial = state.overlay.render(40);
  assert.ok(initial.every((line) => visibleWidth(line) <= 40));
  assert.ok(initial.some((line) => line.includes("x cancel")), "the minimum-width hint exposes cancellation");

  state.overlay.handleInput("x");
  const confirmation = state.overlay.render(40);
  assert.ok(confirmation.some((line) => line.includes("Press x again to confirm")), "confirmation remains actionable at the minimum width");
  assert.ok(confirmation.every((line) => visibleWidth(line) <= 40));

  state.overlay.handleInput("x");
  assert.deepEqual(state.manager.cancelCalls, ["cancel-你好👩🏽‍💻"]);
});

test("compact geometry resets hidden composer state and accepts only its close control", (t) => {
  const closed: unknown[] = [];
  const state = dashboard([job("compact")], 30, (value) => closed.push(value), undefined, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  state.overlay.handleInput(ENTER);
  state.overlay.handleInput("s");
  assert.match(state.overlay.render(52).join("\n"), /composer · steer/);

  state.setRows(5);
  const compact = state.overlay.render(52);
  assert.equal(compact.length, 5);
  assert.match(compact.join("\n"), /Esc close/);
  assert.doesNotMatch(compact.join("\n"), /composer|detail/);

  for (const input of [ENTER, "p", "r", "s", "f", "x", PAGE_DOWN]) state.overlay.handleInput(input);
  assert.deepEqual(state.manager.cancelCalls, []);
  assert.deepEqual(state.manager.sendCalls, []);
  assert.deepEqual(closed, []);

  state.setRows(30);
  const restored = state.overlay.render(52).join("\n");
  assert.match(restored, /Enter\/→ inspe/);
  assert.doesNotMatch(restored, /composer|detail/);
  state.overlay.handleInput(ESCAPE);
  assert.deepEqual(closed, [null]);
});

test("narrow list keeps selection keys out of the hidden detail viewport", (t) => {
  const state = dashboard([job("narrow-list", "completed")], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  const list = state.overlay.render(52).join("\n");
  assert.match(list, /Enter\/→ inspect/);
  assert.doesNotMatch(list, /scroll/);

  for (const input of ["p", "h", "g", PAGE_DOWN, "r"]) state.overlay.handleInput(input);
  assert.deepEqual(state.manager.cancelCalls, []);
  assert.deepEqual(state.manager.sendCalls, []);
  assert.match(state.overlay.render(52).join("\n"), /Enter\/→ inspect/);

  state.overlay.handleInput(ENTER);
  assert.match(state.overlay.render(52).join("\n"), /detail/);
});

test("narrow detail ignores controls that are not exposed by a read-only inspector", (t) => {
  const state = dashboard([{
    ...job("narrow-detail", "failed"),
    output: Array.from({ length: 80 }, (_, index) => `output ${index}`).join("\n"),
  }], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  state.overlay.handleInput(ENTER);
  const detail = state.overlay.render(52).join("\n");
  assert.match(detail, /detail/);
  assert.doesNotMatch(detail, /s steer|f follow-up|x cancel/);
  state.overlay.handleInput("g");
  const top = state.overlay.render(52).join("\n");
  state.overlay.handleInput(PAGE_DOWN);
  assert.notEqual(state.overlay.render(52).join("\n"), top, "Page Down scrolls the focused narrow detail pane");

  for (const input of ["p", ENTER, "s", "f", "x", "X"]) state.overlay.handleInput(input);
  assert.deepEqual(state.manager.cancelCalls, []);
  assert.deepEqual(state.manager.sendCalls, []);
  assert.match(state.overlay.render(52).join("\n"), /detail/);

  state.overlay.handleInput(ESCAPE);
  assert.match(state.overlay.render(52).join("\n"), /Enter\/→ inspect/);
});

test("composer accepts input without exposing detail cancellation or paging", (t) => {
  const current = {
    ...job("takeover-controls"),
    output: Array.from({ length: 80 }, (_, index) => `output ${index}`).join("\n"),
  };
  const state = dashboard([current], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => state.overlay.dispose());

  state.overlay.render(52);
  state.overlay.handleInput(ENTER);
  state.overlay.handleInput("s");
  const takeover = state.overlay.render(52).join("\n");
  assert.match(takeover, /▸ composer · steer/);
  assert.match(takeover, /Enter steer/);
  assert.match(takeover, /Esc back/);

  for (const input of ["p", "r", "x", "f", PAGE_DOWN]) state.overlay.handleInput(input);
  assert.deepEqual(state.manager.cancelCalls, []);
  assert.deepEqual(state.manager.sendCalls, []);
  assert.match(state.overlay.render(52).join("\n"), /▸ composer · steer/);

  state.overlay.handleInput(ESCAPE);
  assert.doesNotMatch(state.overlay.render(52).join("\n"), /▸ composer/);
});

function job(id: string, status: JobSnapshot["status"] = "running"): JobSnapshot {
  return jobSnapshot({
    id,
    status,
    effort: "high",
    task: "Review Unicode output 你好世界",
    output: "first line\n你好世界\nlast line",
  });
}

interface DashboardHarness {
  overlay: ReturnType<typeof createDashboardOverlay>;
  manager: {
    listeners: Set<(job: JobSnapshot) => void>;
    cancelCalls: string[];
    sendCalls: string[];
    answerCalls: Array<[string, string, string | undefined]>;
  };
  renders: () => number;
  setRows: (rows: number) => void;
}

function dashboard(
  jobs: JobSnapshot[],
  rows = 24,
  done: (value: unknown) => void = () => {},
  renderMarkdown: (text: string, width: number) => string[] = (text) => text.split("\n"),
  options: {
    focusJobId?: string;
    fullscreen?: boolean;
    sendError?: string;
    sendPromise?: Promise<JobSnapshot>;
    submitKey?: string;
    getKeys?: (binding: string) => string[];
    answerError?: string;
    /** Omitted entirely for a session that cannot resolve routed questions. */
    answerable?: boolean;
    availability?: HarnessActivation[];
  } = {},
): DashboardHarness {
  let renders = 0;
  const listeners = new Set<(job: JobSnapshot) => void>();
  const cancelCalls: string[] = [];
  const sendCalls: string[] = [];
  const answerCalls: Array<[string, string, string | undefined]> = [];
  const terminal = { rows };
  const manager = {
    listeners,
    cancelCalls,
    sendCalls,
    answerCalls,
    concurrency: 4,
    ...(options.answerable === false ? {} : {
      answerInteraction(requestId: string, answer: string, route?: string) {
        answerCalls.push([requestId, answer, route]);
        if (options.answerError) throw new Error(options.answerError);
        return { requestId, answer, state: "answered" };
      },
    }),
    list: () => jobs,
    subscribe(listener: (job: JobSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(id: string): Promise<JobSnapshot> {
      sendCalls.push(id);
      if (options.sendError) throw new Error(options.sendError);
      if (options.sendPromise) return options.sendPromise;
      const current = jobs.find((item) => item.id === id);
      if (!current) throw new Error(`unknown job ${id}`);
      return current;
    },
    async cancel(id: string): Promise<JobSnapshot> {
      cancelCalls.push(id);
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`unknown job ${id}`);
      const current = { ...jobs[index]!, status: "cancelled" as const, endedAt: 65_000 };
      jobs[index] = current;
      for (const listener of listeners) listener(current);
      return current;
    },
  };
  const tui = {
    requestRender: () => { renders++; },
    terminal,
    ...(options.fullscreen ? { mode: "fullscreen" } : {}),
  } as never;
  const overlay = createDashboardOverlay(
    tui,
    theme,
    {
      matches: (data: string, binding: string) =>
        (binding === "tui.select.cancel" && data === "\u0003") ||
        (binding === "tui.input.submit" && data === options.submitKey),
      ...(options.getKeys ? { getKeys: options.getKeys } : {}),
    } as unknown as KeybindingsManager,
    manager,
    done as never,
    {
      now: () => 65_000,
      renderMarkdown,
      focusJobId: options.focusJobId,
      fullscreen: options.fullscreen,
      availability: options.availability,
    },
  );
  return {
    overlay,
    manager,
    renders: () => renders,
    setRows: (nextRows) => { terminal.rows = nextRows; },
  };
}

test("dashboard renders adaptive detail, follows live output, and keeps fullscreen-safe controls", async (t) => {
  const transcriptText = Array.from({ length: 40 }, (_, index) => `first-${index}`).join("\n");
  const first = {
    ...job("first", "completed"),
    transcript: [{ kind: "assistant" as const, text: transcriptText }],
    output: transcriptText,
  };
  const second = job("second");
  const closed: unknown[] = [];
  const { overlay, manager, renders } = dashboard(
    [first, second],
    30,
    (value) => closed.push(value),
    (text) => text.split("\n"),
    { focusJobId: "first", fullscreen: true },
  );
  t.after(() => overlay.dispose());
  overlay.focused = true;

  const wide = overlay.render(120);
  assert.equal(wide.length, 30, "fullscreen dashboard owns the available terminal height");
  assert.ok(wide[0]?.includes("Native subagents"));
  assert.ok(wide.some((line) => line.includes("first")));
  assert.ok(wide.some((line) => line.includes("detail")));
  assert.ok(wide.every((line) => visibleWidth(line) <= 120));
  assert.ok(wide.some((line) => line.includes("first-39")), "live detail follows the transcript tail");

  overlay.handleInput(ENTER);
  overlay.handleInput("g");
  const top = overlay.render(120);
  assert.ok(top.some((line) => line.includes("first-0")), "g scrolls to the transcript top");
  overlay.handleInput("\u0004"); // Ctrl+D, fullscreen-safe half-page scroll.
  const halfPage = overlay.render(120);
  assert.ok(halfPage.some((line) => line.includes("first-")));
  assert.ok(halfPage.every((line) => visibleWidth(line) <= 120));

  overlay.handleInput(ESCAPE);
  overlay.handleInput("k");
  assert.ok(overlay.render(72).some((line) => line.includes("second")), "selection moves by job id");
  overlay.handleInput("x");
  assert.ok(overlay.render(72).some((line) => line.includes("Press x again")), "cancel is confirmed inline");
  overlay.handleInput("x");
  await tick();
  assert.deepEqual(manager.cancelCalls, ["second"]);
  assert.ok(renders() >= 1);

  overlay.handleInput("k");
  overlay.handleInput("f");
  assert.ok(overlay.render(72).some((line) => line.includes("follow-up")), "the composer stays in the same panel");
  overlay.handleInput("\x1b");
  assert.ok(!overlay.render(72).some((line) => line.includes("▸ composer")), "Escape returns from the composer without losing the panel");
  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b");
  assert.deepEqual(closed, [null]);
  assert.equal(manager.listeners.size, 0, "closing the dashboard unsubscribes from manager updates");
});

test("dashboard header exposes normalized harness states in text, not color alone", (t) => {
  const availability = [
    harnessActivation(availabilityFixture("pi"), true),
    harnessActivation(availabilityFixture("claude", {
      authenticated: false,
      ready: false,
      detail: "Claude Code is not logged in",
    }), true),
    harnessActivation(availabilityFixture("codex", {
      installed: false,
      authenticated: false,
      ready: false,
    }), false),
  ];
  const { overlay } = dashboard([job("status")], 24, () => {}, undefined, { availability });
  t.after(() => overlay.dispose());
  const header = overlay.render(180)[0] ?? "";
  assert.match(header, /pi ready/);
  assert.match(header, /claude login required/);
  assert.match(header, /codex disabled by user/);
});

test("dashboard pins errors and exposes queued empty states", (t) => {
  const failed = { ...job("failed", "failed"), output: "", error: "Harness exited before first response" };
  const queued = { ...job("queued", "queued"), output: "" };
  const { overlay } = dashboard([failed, queued], 24, () => {}, undefined, { focusJobId: "failed" });
  t.after(() => overlay.dispose());
  const failedLines = overlay.render(72);
  assert.ok(failedLines.some((line) => line.includes("Harness exited before first response")));
  overlay.handleInput("k");
  const queuedLines = overlay.render(72);
  assert.ok(queuedLines.some((line) => line.includes("queued")));
  assert.ok(queuedLines.some((line) => line.includes("waiting for an agent slot")));
});

test("assistant transcripts use regular Pi Markdown message padding by default", () => {
  const current = {
    ...job("pi-markdown", "completed"),
    transcript: [{ kind: "assistant" as const, text: "assistant prose" }],
  };
  const expected = renderAssistantMarkdown("assistant prose", 20);
  const rendered = buildTranscript(current, 20, theme);

  assert.deepEqual(rendered, expected);
  assert.equal(rendered[0]?.startsWith(" "), true, "regular Pi assistant output keeps one column of padding");
  assert.ok(rendered.every((line) => visibleWidth(line) <= 20));
});

test("dashboard caches Markdown rendering by transcript and width", (t) => {
  const current = {
    ...job("markdown", "completed"),
    transcript: [{ kind: "assistant" as const, text: "# Verdict\n\n**PASS**" }],
  };
  let calls = 0;
  const { overlay, manager } = dashboard([current], 24, () => {}, () => {
    calls++;
    return ["\u001b[1mVerdict\u001b[0m", "\u001b[32mPASS\u001b[0m"];
  }, { focusJobId: current.id });
  t.after(() => overlay.dispose());
  const first = overlay.render(72);
  overlay.render(72);
  assert.equal(calls, 1, "unchanged renders reuse the cached transcript");
  assert.ok(first.some((line) => line.includes("\u001b[1mVerdict\u001b[0m")));
  overlay.render(80);
  assert.equal(calls, 2, "a width change invalidates the transcript layout cache");
  current.transcript[0] = { kind: "assistant", text: "# Verdict\n\n**FAIL**" };
  for (const listener of manager.listeners) listener(current);
  overlay.render(80);
  assert.equal(calls, 3, "manager events invalidate equal-length transcript changes");
});

test("transcript delegates structured tool events to Pi execution components", () => {
  const current = {
    ...job("tools"),
    output: "",
    tools: [
      { id: "grep-1", name: "Grep", status: "completed" as const },
      { id: "read-1", name: "Read", status: "failed" as const },
    ],
    transcript: [
      { kind: "tool" as const, phase: "start" as const, toolId: "grep-1", name: "Grep", args: { pattern: "480", path: "frontend", glob: "*.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "read-1", name: "Read", args: { path: "missing.ts" } },
      { kind: "tool" as const, phase: "end" as const, toolId: "grep-1", name: "Grep", result: { content: [{ type: "text", text: "src/a.ts:1: match\nsrc/b.ts:2: match" }], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "read-1", name: "Read", result: { content: [{ type: "text", text: "File not found" }], isError: true }, error: true },
    ],
  };
  const lines = buildTranscript(current, 48, ansiTheme, { toolDisplay: "full" });
  const plain = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  const backgrounds = new Set(lines.flatMap((line) => line.match(/\u001b\[48;[^m]+m/g) ?? []));

  assert.match(plain, /grep \/480\/ in frontend \(\*\.ts\)/);
  assert.match(plain, /src\/a\.ts:1: match\s*\n\s*src\/b\.ts:2: match/);
  assert.match(plain, /read .*missing\.ts/);
  assert.match(plain, /File not found/);
  assert.doesNotMatch(plain, /[✓×]/, "Pi's native tool shell does not add custom status glyphs");
  assert.ok(backgrounds.size >= 2, "success and error use Pi's distinct semantic tool backgrounds");
  assert.ok(lines.every((line) => visibleWidth(line) <= 48));

  const compactLines = buildTranscript(current, 48, ansiTheme);
  assert.ok(!compactLines.some((line) => line.includes("missing.ts")), "compact mode is the default and omits Pi's native tool shell");
  assert.match(compactLines.join("\n"), /2 tool calls/);
});

test("compact tool groups fold consecutive calls between assistant turns and stay chronological", () => {
  const current = {
    ...job("grouping"),
    output: "",
    transcript: [
      { kind: "assistant" as const, text: "starting work" },
      { kind: "tool" as const, phase: "start" as const, toolId: "r1", name: "read", args: { path: "a.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "r2", name: "read", args: { path: "b.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "r3", name: "read", args: { path: "c.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "e1", name: "edit", args: { path: "a.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "e2", name: "edit", args: { path: "b.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "b1", name: "bash", args: { command: "npm test" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "b2", name: "bash", args: { command: "npm run lint" } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r1", name: "read", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r2", name: "read", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r3", name: "read", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "e1", name: "edit", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "e2", name: "edit", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "b1", name: "bash", result: { content: [], isError: true }, error: true },
      { kind: "tool" as const, phase: "end" as const, toolId: "b2", name: "bash", result: { content: [], isError: false } },
      { kind: "assistant" as const, text: "concluding work" },
    ],
  };
  const lines = buildTranscript(current, 70, theme);
  const groupLines = lines.filter((line) => line.includes("tool calls"));
  assert.equal(groupLines.length, 1, "consecutive tool calls fold into exactly one group row");
  const groupIndex = lines.indexOf(groupLines[0]!);
  const startIndex = lines.findIndex((line) => line.includes("starting work"));
  const endIndex = lines.findIndex((line) => line.includes("concluding work"));
  assert.ok(startIndex >= 0 && groupIndex > startIndex && endIndex > groupIndex, "the group sits between the surrounding assistant turns");
  assert.match(groupLines[0]!, /7 tool calls/);
  assert.match(groupLines[0]!, /✓6/);
  assert.match(groupLines[0]!, /×1/);
  assert.match(groupLines[0]!, /read ×3, edit ×2, bash ×2/);
});

test("dashboard toggles between compact groups and full Pi tool rendering with t and Ctrl+T", (t) => {
  const current = {
    ...job("toggle-tools"),
    output: "",
    transcript: [
      { kind: "tool" as const, phase: "start" as const, toolId: "r1", name: "read", args: { path: "a.ts" } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r1", name: "read", result: { content: [{ type: "text", text: "contents" }], isError: false } },
    ],
  };
  const { overlay } = dashboard([current], 24, () => {}, undefined, { focusJobId: current.id });
  t.after(() => overlay.dispose());

  const compact = overlay.render(90);
  assert.ok(compact.some((line) => line.includes("1 tool call")), "compact mode is the default");
  assert.ok(compact.some((line) => line.includes("t full")), "hint offers the toggle to full mode");

  overlay.handleInput("t");
  const full = overlay.render(90);
  assert.ok(full.some((line) => line.includes("a.ts")), "full mode restores Pi's native tool rendering");
  assert.ok(full.some((line) => line.includes("t compact")), "hint offers the toggle back to compact mode");

  overlay.handleInput("t");
  const backToCompact = overlay.render(90);
  assert.deepEqual(backToCompact, compact, "toggling twice reproduces the original compact output, including the cache key");
});

test("t toggles tool display from the narrow list pane, and the detail title carries the mode even when hints truncate", (t) => {
  const current = {
    ...job("narrow-tool-toggle", "completed"),
    output: "",
    transcript: [
      { kind: "tool" as const, phase: "start" as const, toolId: "r1", name: "read", args: { path: "a.ts" } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r1", name: "read", result: { content: [{ type: "text", text: "contents" }], isError: false } },
    ],
  };
  const { overlay } = dashboard([current], 30, () => {}, undefined, { focusJobId: current.id, fullscreen: true });
  t.after(() => overlay.dispose());

  overlay.render(52);
  assert.ok(overlay.render(52).some((line) => line.includes("jobs ·")), "narrow layout starts on the list pane");
  overlay.handleInput("t");
  overlay.handleInput("\r");
  const full = overlay.render(52).join("\n");
  assert.match(full, /detail · [\w-]+ · completed · full/, "the detail title carries the toggled mode");
  assert.ok(full.includes("a.ts"), "the narrow-list t toggle applied before entering detail");

  overlay.handleInput(ESCAPE);
  overlay.handleInput("t");
  overlay.handleInput("\r");
  assert.match(overlay.render(52).join("\n"), /detail · [\w-]+ · completed · compact/, "a second narrow-list t toggle reverts the mode");
});

test("? opens a width-safe grouped cheatsheet, dismisses without losing state, and stays printable in the composer", (t) => {
  for (const width of [40, 72, 120]) {
    const state = dashboard([job("cheatsheet")], 30, () => {}, undefined, { fullscreen: true });
    t.after(() => state.overlay.dispose());
    state.overlay.render(width);
    state.overlay.handleInput(PAGE_DOWN); // move some transient input through first, unrelated to help
    state.overlay.handleInput("j"); // narrow layouts stay on the list pane; wide/medium keep the same job selected
    const before = state.overlay.render(width).join("\n");

    state.overlay.handleInput("?");
    const help = state.overlay.render(width);
    assert.equal(help.length, 30);
    assert.ok(help.every((line) => visibleWidth(line) <= width), `a cheatsheet line exceeds ${width} columns`);
    assert.match(help.join("\n"), /help/);
    assert.match(help.join("\n"), /Navigate/);

    state.overlay.handleInput("?");
    assert.equal(state.overlay.render(width).join("\n"), before, "dismissing with ? restores the exact prior state");

    state.overlay.handleInput("?");
    state.overlay.handleInput(ESCAPE);
    assert.equal(state.overlay.render(width).join("\n"), before, "Esc also dismisses the cheatsheet without losing state");
  }
});

test("the cheatsheet never intercepts ? inside the steer composer", (t) => {
  const state = dashboard([job("cheatsheet-takeover")], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => state.overlay.dispose());
  state.overlay.focused = true;
  state.overlay.render(90);
  state.overlay.handleInput("s");
  assert.match(state.overlay.render(90).join("\n"), /composer · steer/);

  state.overlay.handleInput("?");
  state.overlay.handleInput("!");
  const composer = state.overlay.render(90).join("\n");
  assert.match(composer, /\?!/, "? reaches the composer as ordinary text instead of opening the cheatsheet");
  assert.doesNotMatch(composer, /Navigate/, "the cheatsheet legend never appears while composing");
});

test("configurable confirm/cancel/submit bindings render their configured key names in hints, falling back to defaults otherwise", (t) => {
  const configured = dashboard([job("configured-keys")], 30, () => {}, undefined, {
    fullscreen: true,
    getKeys: (binding) => binding === "tui.select.cancel" ? ["q"] : binding === "tui.select.confirm" ? ["space"] : [],
  });
  t.after(() => configured.overlay.dispose());
  assert.match(configured.overlay.render(60).join("\n"), /Space\/→ inspect/i, "the narrow list hint reflects the configured confirm key");
  const wide = configured.overlay.render(90).join("\n");
  assert.match(wide, /Space\/→ inspect/i, "the list hint reflects the configured confirm key");
  assert.match(wide, /Q close/i, "the browse hint reflects the configured cancel key");
  assert.doesNotMatch(wide, /Esc close/);

  const defaulted = dashboard([job("default-keys")], 30, () => {}, undefined, { fullscreen: true });
  t.after(() => defaulted.overlay.dispose());
  const defaultHint = defaulted.overlay.render(90).join("\n");
  assert.match(defaultHint, /Enter\/→ inspect/);
  assert.match(defaultHint, /Esc close/);
});

test("in-panel composer toggles tool rendering with Ctrl+T and treats a bare t as composer input", (t) => {
  const current = {
    ...job("takeover-toggle-tools"),
    output: "",
    transcript: [
      { kind: "tool" as const, phase: "start" as const, toolId: "r1", name: "read", args: { path: "a.ts" } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r1", name: "read", result: { content: [{ type: "text", text: "contents" }], isError: false } },
    ],
  };
  const { overlay } = dashboard([current], 24, () => {}, undefined, { focusJobId: current.id });
  t.after(() => overlay.dispose());
  overlay.focused = true;

  overlay.render(90);
  overlay.handleInput("s");
  const compact = overlay.render(90);
  assert.ok(compact.some((line) => line.includes("1 tool call")), "takeover compact mode is the default");
  assert.ok(compact.some((line) => line.includes("Ctrl+T full")), "takeover hint offers the toggle to full mode");

  overlay.handleInput("t");
  const stillCompact = overlay.render(90);
  assert.ok(stillCompact.some((line) => line.includes("1 tool call")), "a bare t while composing types into the draft instead of toggling out of compact mode");
  assert.ok(stillCompact.some((line) => line.includes("> t")), "the composer echoes the typed t");

  overlay.handleInput(CTRL_T);
  const full = overlay.render(90);
  assert.ok(full.some((line) => line.includes("a.ts")), "Ctrl+T restores Pi's native tool rendering during takeover");
  assert.ok(full.some((line) => line.includes("Ctrl+T compact")), "takeover hint offers the toggle back to compact mode");

  overlay.handleInput(CTRL_T);
  const backToCompact = overlay.render(90);
  assert.ok(backToCompact.some((line) => line.includes("1 tool call")), "a second Ctrl+T toggles back to compact mode");
});

test("compact tool group rows keep failures visible and stay within every width", () => {
  const current = {
    ...job("width-bounds"),
    output: "",
    transcript: [
      { kind: "tool" as const, phase: "start" as const, toolId: "r1", name: "read", args: { path: "a.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "r2", name: "read", args: { path: "b.ts" } },
      { kind: "tool" as const, phase: "start" as const, toolId: "b1", name: "bash", args: { command: "npm test" } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r1", name: "read", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "r2", name: "read", result: { content: [], isError: false } },
      { kind: "tool" as const, phase: "end" as const, toolId: "b1", name: "bash", result: { content: [], isError: true }, error: true },
    ],
  };
  for (const width of [80, 60, 40, 24, 12]) {
    const lines = buildTranscript(current, width, theme);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `every line fits within ${width} columns`);
    const groupLine = lines.find((line) => line.includes("⌁"));
    assert.ok(groupLine?.includes("×1"), `the failed-call count survives at width ${width}`);
  }
});

test("takeover restores a rejected draft without overwriting newer input", async (t) => {
  const current = job("draft");
  const { overlay } = dashboard([current], 24, () => {}, undefined, { focusJobId: current.id, sendError: "send failed", submitKey: "\u0011" });
  t.after(() => overlay.dispose());
  overlay.focused = true;
  overlay.render(72);
  overlay.handleInput("s");
  for (const character of "g/G draft message") overlay.handleInput(character);
  overlay.handleInput("\u0011");
  await tick();
  const lines = overlay.render(72);
  assert.ok(lines.some((line) => line.includes("send failed")));
  assert.ok(lines.some((line) => line.includes("g") && line.includes("/G draft message")), "failed sends keep ordinary g/G characters and the draft available");
});

test("a newer draft survives rejection of an earlier in-flight send", async (t) => {
  const current = job("deferred");
  let rejectSend!: (error: Error) => void;
  const sendPromise = new Promise<JobSnapshot>((_resolve, reject) => { rejectSend = reject; });
  const { overlay } = dashboard([current], 24, () => {}, undefined, { focusJobId: current.id, sendPromise });
  t.after(() => overlay.dispose());
  overlay.focused = true;
  overlay.render(72);
  overlay.handleInput("s");
  for (const character of "first") overlay.handleInput(character);
  overlay.handleInput("\r");
  for (const character of "second") overlay.handleInput(character);
  overlay.handleInput("\r"); // second submit is held as a newer draft while first is pending
  rejectSend(new Error("first failed"));
  await tick();
  const lines = overlay.render(72);
  const composer = lines.find((line) => line.includes("│ >")) ?? "";
  assert.ok(composer.includes("second"), "the newer draft remains in the composer");
  assert.ok(!composer.includes("first"), "the older rejected draft is not restored over newer input");
});

test("takeover renders normalized thinking, tools, queued messages, and closes reliably", (t) => {
  const current = {
    ...job("takeover"),
    transcript: [
      { kind: "user" as const, text: "inspect this" },
      { kind: "thinking" as const, text: "considering options" },
      { kind: "tool" as const, toolId: "t1", name: "read", text: "file.ts" },
      { kind: "assistant" as const, text: "working conclusion" },
    ],
    liveThinking: "checking details",
    queuedMessages: [{ text: "also verify tests", behavior: "followUp" as const }],
  };
  const updates = new Set<(job: JobSnapshot) => void>();
  const closed: unknown[] = [];
  const view = new TakeoverView(
    { requestRender() {}, terminal: { rows: 24 } } as never,
    theme,
    { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\u0003" } as unknown as KeybindingsManager,
    {
      check: () => current,
      async send() { return current; },
      async cancel() { return { ...current, status: "cancelled" as const }; },
      subscribe(listener: (value: JobSnapshot) => void) { updates.add(listener); return () => updates.delete(listener); },
    } as never,
    current.id,
    (value) => closed.push(value),
  );
  t.after(() => view.dispose());
  view.focused = true;
  const lines = view.render(72);
  assert.equal(lines.length, 24, "takeover stays within the fullscreen overlay height");
  assert.ok(lines.some((line) => line.includes("considering options")));
  assert.ok(lines.some((line) => line.includes("1 tool call") && line.includes("read")), "compact mode is the default in takeover");
  assert.ok(!lines.some((line) => line.includes("file.ts")), "compact mode omits Pi's native tool shell");
  assert.ok(lines.some((line) => line.includes("also verify tests")));
  assert.ok(lines.some((line) => line.includes("effort high")), "takeover metadata shows request effort");
  assert.ok(lines.some((line) => line.includes("Ctrl+T full")), "footer hint offers the toggle to full mode");

  view.handleInput("");
  const fullLines = view.render(72);
  assert.ok(fullLines.some((line) => line.includes("read") && line.includes("file.ts")), "Ctrl+T restores Pi's native tool rendering");
  assert.ok(fullLines.some((line) => line.includes("Ctrl+T compact")), "footer hint offers the toggle back to compact mode");

  view.handleInput("t");
  const afterLiteralT = view.render(72);
  assert.ok(afterLiteralT.some((line) => line.includes("read") && line.includes("file.ts")), "a bare t types into the composer instead of toggling");
  const compactTakeover = view.render(48);
  assert.equal(compactTakeover.length, 24, "takeover height remains exact after resize");
  assert.ok(compactTakeover.some((line) => line.includes("effort high")), "effort survives bounded takeover rendering");
  assert.ok(buildTranscript(current, 72, theme).every((line) => visibleWidth(line) <= 72));
  view.handleInput("\x1b");
  assert.deepEqual(closed, [null]);
  assert.equal(updates.size, 0);

  const workflowCurrent = {
    ...current,
    workflow: { runId: "wf-test", agentIndex: 0, label: "implementation", phase: "Build" },
  };
  let workflowSends = 0;
  const workflowView = new TakeoverView(
    { requestRender() {}, terminal: { rows: 24 } } as never,
    theme,
    { matches: () => false } as unknown as KeybindingsManager,
    {
      check: () => workflowCurrent,
      async send() { workflowSends++; return workflowCurrent; },
      async cancel() { return { ...workflowCurrent, status: "cancelled" as const }; },
      subscribe() { return () => {}; },
    } as never,
    workflowCurrent.id,
    () => {},
  );
  t.after(() => workflowView.dispose());
  workflowView.focused = true;
  assert.ok(workflowView.render(72).some((line) => line.includes("Workflow-owned agent")));
  workflowView.handleInput("a");
  workflowView.handleInput("\r");
  assert.equal(workflowSends, 0, "workflow-owned takeover is read-only");
});

function parkedJob(id: string, overrides: Parameters<typeof interactionSnapshot>[0] = {}): JobSnapshot {
  return {
    ...job(id),
    interaction: interactionSnapshot({ sourceJobId: id, sourceName: id, question: "Which fixture is authoritative?", ...overrides }),
  };
}

test("a job parked on a question states the wait in words, withdraws steer/follow-up, and keeps cancel", (t) => {
  const parked = { ...parkedJob("parked"), humanVisible: true, interaction: interactionSnapshot({ sourceJobId: "parked", sourceName: "parked", humanVisible: true, question: "Which fixture is authoritative?", context: "the task and the tests disagree" }) };
  const { overlay } = dashboard([parked], 24, () => {}, undefined, { focusJobId: parked.id });
  t.after(() => overlay.dispose());
  overlay.focused = true;

  const lines = overlay.render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("needs your answer"), "the wait is carried by words, not colour alone");
  assert.ok(text.includes("?"), "and by its own glyph");
  assert.ok(text.includes("Which fixture is authoritative?"), "the pending question is pinned in the inspector");
  assert.ok(text.includes("Route · parked → you · waiting 1m 04s"), "the inspector names source, owner, and elapsed wait");
  assert.ok(text.includes("the task and the tests disagree"));
  assert.ok(text.includes("1 need input"), "the panel header aggregates blocked jobs");
  assert.ok(text.includes("a answer"), "the inline answer control is offered for a human-owned question");
  assert.ok(!text.includes("s steer") && !text.includes("f follow-up"), "steer and follow-up are withdrawn while the caller is parked");
  assert.ok(text.includes("x cancel"), "cancellation stays available");
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));

  // The withdrawn controls are not merely hidden: the keys do nothing.
  overlay.handleInput("s");
  overlay.handleInput("f");
  overlay.handleInput("\r");
  assert.ok(!overlay.render(120).some((line) => line.includes("▸ takeover ·")), "no key opens a competing user turn while a question is pending");
});

test("the inline answer composer resolves a human-owned question and surfaces a rejected answer", async (t) => {
  const parked = { ...parkedJob("human"), humanVisible: true, interaction: interactionSnapshot({ sourceJobId: "human", humanVisible: true, requestId: "req-9" }) };
  const { overlay, manager } = dashboard([parked], 24, () => {}, undefined, { focusJobId: parked.id, submitKey: "\u0011" });
  t.after(() => overlay.dispose());
  overlay.focused = true;
  overlay.render(120);

  overlay.handleInput("a");
  assert.ok(overlay.render(120).some((line) => line.includes("▸ answer ·")), "a opens the answer composer in the same panel");
  for (const character of "use the fixture") overlay.handleInput(character);
  overlay.handleInput("\u0011");
  await tick();
  assert.deepEqual(manager.answerCalls, [["req-9", "use the fixture", "human"]]);
  const after = overlay.render(120).join("\n");
  assert.ok(after.includes("Answer delivered"));
  assert.ok(!after.includes("▸ answer ·"), "a delivered answer returns to browse mode");

  const rejected = dashboard([parked], 24, () => {}, undefined, { focusJobId: parked.id, submitKey: "\u0011", answerError: "Question req-9 is expired and can no longer be answered" });
  t.after(() => rejected.overlay.dispose());
  rejected.overlay.focused = true;
  rejected.overlay.render(120);
  rejected.overlay.handleInput("a");
  for (const character of "too late") rejected.overlay.handleInput(character);
  rejected.overlay.handleInput("\u0011");
  await tick();
  const failed = rejected.overlay.render(120).join("\n");
  assert.ok(failed.includes("expired and can no longer be answered"), "a late answer surfaces the manager's reason");
  assert.ok(failed.includes("too late"), "and keeps the draft for another attempt");
});

test("a model-owned question stays read-only in /subagents and Escape leaves the composer", (t) => {
  const parked = parkedJob("model-owned");
  const { overlay, manager } = dashboard([parked], 24, () => {}, undefined, { focusJobId: parked.id, submitKey: "\u0011" });
  t.after(() => overlay.dispose());
  overlay.focused = true;
  const lines = overlay.render(120).join("\n");
  assert.ok(lines.includes("needs orchestrator"));
  assert.ok(lines.includes("parent thread: subagent_answer"));
  assert.ok(lines.includes("do not steer"));
  assert.ok(!lines.includes("a answer"), "no inline composer is offered for a question the parent thread owns");

  overlay.handleInput("a");
  const notice = overlay.render(120).join("\n");
  assert.ok(!notice.includes("▸ answer ·"));
  assert.ok(notice.includes("routed to the orchestrator"));
  assert.deepEqual(manager.answerCalls, []);

  const human = { ...parked, humanVisible: true, interaction: interactionSnapshot({ sourceJobId: parked.id, humanVisible: true }) };
  const composing = dashboard([human], 24, () => {}, undefined, { focusJobId: human.id, submitKey: "\u0011" });
  t.after(() => composing.overlay.dispose());
  composing.overlay.focused = true;
  composing.overlay.render(120);
  composing.overlay.handleInput("a");
  assert.ok(composing.overlay.render(120).some((line) => line.includes("▸ answer ·")));
  composing.overlay.handleInput("\u0003");
  assert.ok(!composing.overlay.render(120).some((line) => line.includes("▸ answer ·")), "cancel layers back to browse without closing the panel");
  assert.deepEqual(composing.manager.answerCalls, []);
});

test("direct question previews route peer and workflow ownership to the accurate destination", (t) => {
  const peer = parkedJob("peer-owned", {
    sourceName: "implementer",
    target: { kind: "agent", jobId: "planner-job", label: "planner" },
  });
  const peerState = dashboard([peer], 24, () => {}, undefined, { focusJobId: peer.id });
  t.after(() => peerState.overlay.dispose());
  peerState.overlay.focused = true;
  const peerText = peerState.overlay.render(120).join("\n");
  assert.match(peerText, /Route · implementer → peer planner · waiting 1m 04s/);
  assert.match(peerText, /no human action required; waiting for peer planner/);
  assert.doesNotMatch(peerText, /a answer|s steer|f follow-up|subagent_answer/);

  const owned = jobSnapshot({
    id: "workflow-question",
    name: "workflow-worker",
    workflow: { runId: "workflow-run-1234", agentIndex: 2, label: "release-flow", phase: "verify" },
    interaction: interactionSnapshot({
      sourceJobId: "workflow-question",
      sourceName: "workflow-worker",
      workflow: { runId: "workflow-run-1234", agentIndex: 2, label: "release-flow", phase: "verify" },
    }),
  });
  const ownedState = dashboard([owned], 24, () => {}, undefined, { focusJobId: owned.id });
  t.after(() => ownedState.overlay.dispose());
  ownedState.overlay.focused = true;
  const ownedText = ownedState.overlay.render(120).join("\n");
  assert.match(ownedText, /\/workflows: supervise release-flow/);
  assert.match(ownedText, /no answer or steer here/);
  assert.doesNotMatch(ownedText, /a answer|takeover|s steer|f follow-up/);

  const human = parkedJob("human-owned", { humanVisible: true });
  const unavailable = dashboard([human], 24, () => {}, undefined, {
    focusJobId: human.id,
    answerable: false,
  });
  t.after(() => unavailable.overlay.dispose());
  const unavailableText = unavailable.overlay.render(120).join("\n");
  assert.match(unavailableText, /inline answering is unavailable in this session/);
  assert.doesNotMatch(unavailableText, /press a|a answer/);
});

test("direct inspectors prioritize activity, results, failures, and queue recovery at constrained geometry", (t) => {
  const cases = [
    jobSnapshot({ id: "live-preview", name: "live-preview", liveThinking: "checking the bounded state preview" }),
    jobSnapshot({ id: "done-preview", name: "done-preview", status: "completed", output: "final concise result", endedAt: 4_000 }),
    jobSnapshot({ id: "failed-preview", name: "failed-preview", status: "failed", error: "bounded provider failure", endedAt: 4_000 }),
    jobSnapshot({ id: "queued-preview", name: "queued-preview", status: "queued", startedAt: undefined }),
  ];

  for (const current of cases) {
    const state = dashboard([current], 8, () => {}, undefined, { focusJobId: current.id, fullscreen: true });
    t.after(() => state.overlay.dispose());
    state.overlay.render(52);
    state.overlay.handleInput(ENTER);
    const lines = state.overlay.render(52);
    const text = lines.join("\n");
    assert.ok(lines.every((line) => visibleWidth(line) <= 52));
    assert.match(text, current.status === "running"
      ? /Latest · checking/
      : current.status === "completed"
        ? /Result · final concise result/
        : current.status === "failed"
          ? /Error · bounded provider failure/
          : /Waiting · waiting for scheduler slot/);
    const previewAt = lines.findIndex((line) => /Latest ·|Result ·|Error ·|Waiting ·/.test(line));
    const routeAt = lines.findIndex((line) => line.includes("route "));
    assert.ok(previewAt >= 0 && (routeAt < 0 || previewAt < routeAt), "state preview precedes route telemetry");
  }

  const failedState = dashboard([cases[2]!], 24, () => {}, undefined, { focusJobId: cases[2]!.id });
  t.after(() => failedState.overlay.dispose());
  const failedText = failedState.overlay.render(120).join("\n");
  assert.match(failedText, /Recovery · no recovery action is available in this pane/);
  assert.doesNotMatch(failedText, /f follow-up|restart|takeover/);

  const liveFailure = jobSnapshot({
    id: "live-failure",
    name: "live-failure",
    status: "running",
    error: "transient tool failure",
  });
  const liveFailureState = dashboard([liveFailure], 24, () => {}, undefined, {
    focusJobId: liveFailure.id,
  });
  t.after(() => liveFailureState.overlay.dispose());
  const liveFailureText = liveFailureState.overlay.render(120).join("\n");
  assert.match(liveFailureText, /Recovery · press s to steer/);
  assert.doesNotMatch(liveFailureText, /press f to follow up/);
});
