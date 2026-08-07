import test from "node:test";
import assert from "node:assert/strict";
import { jobSnapshot, theme, tick } from "./helpers.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import {
  createDashboardOverlay,
  dashboardLayout,
  truncateDashboardLine,
} from "../extensions/subagents/dashboard.ts";
import { TakeoverView, buildTranscript } from "../extensions/subagents/takeover.ts";
import type { JobSnapshot } from "../src/types.ts";

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

test("dashboard layout adapts to fullscreen terminal geometry", () => {
  assert.equal(dashboardLayout(120, 24).kind, "wide");
  assert.equal(dashboardLayout(72, 24).kind, "medium");
  assert.equal(dashboardLayout(50, 24).kind, "narrow");
  assert.equal(dashboardLayout(120, 8).kind, "narrow");
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
  };
  renders: () => number;
}

function dashboard(
  jobs: JobSnapshot[],
  rows = 24,
  done: (value: unknown) => void = () => {},
  renderMarkdown: (text: string, width: number) => string[] = (text) => text.split("\n"),
  options: { focusJobId?: string; fullscreen?: boolean; sendError?: string; sendPromise?: Promise<JobSnapshot>; submitKey?: string } = {},
): DashboardHarness {
  let renders = 0;
  const listeners = new Set<(job: JobSnapshot) => void>();
  const cancelCalls: string[] = [];
  const manager = {
    listeners,
    cancelCalls,
    concurrency: 4,
    list: () => jobs,
    subscribe(listener: (job: JobSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(id: string): Promise<JobSnapshot> {
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
    terminal: { rows },
    ...(options.fullscreen ? { mode: "fullscreen" } : {}),
  } as never;
  const overlay = createDashboardOverlay(
    tui,
    theme,
    {
      matches: (data: string, binding: string) =>
        (binding === "tui.select.cancel" && data === "\u0003") ||
        (binding === "tui.input.submit" && data === options.submitKey),
    } as unknown as KeybindingsManager,
    manager,
    done as never,
    { now: () => 65_000, renderMarkdown, focusJobId: options.focusJobId, fullscreen: options.fullscreen },
  );
  return { overlay, manager, renders: () => renders };
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

  overlay.handleInput("g");
  const top = overlay.render(120);
  assert.ok(top.some((line) => line.includes("first-0")), "g scrolls to the transcript top");
  overlay.handleInput("\u0004"); // Ctrl+D, fullscreen-safe half-page scroll.
  const halfPage = overlay.render(120);
  assert.ok(halfPage.some((line) => line.includes("first-")));
  assert.ok(halfPage.every((line) => visibleWidth(line) <= 120));

  overlay.handleInput("j");
  assert.ok(overlay.render(72).some((line) => line.includes("second")), "selection moves by job id");
  overlay.handleInput("x");
  assert.ok(overlay.render(72).some((line) => line.includes("Press x again")), "cancel is confirmed inline");
  overlay.handleInput("x");
  await tick();
  assert.deepEqual(manager.cancelCalls, ["second"]);
  assert.ok(renders() >= 1);

  overlay.handleInput("k");
  overlay.handleInput("\r");
  assert.ok(overlay.render(72).some((line) => line.includes("takeover")), "takeover stays in the same panel");
  overlay.handleInput("\x1b");
  assert.ok(!overlay.render(72).some((line) => line.includes("▸ takeover ·")), "Escape returns from takeover without losing the panel");
  overlay.handleInput("\x1b");
  assert.deepEqual(closed, [null]);
  assert.equal(manager.listeners.size, 0, "closing the dashboard unsubscribes from manager updates");
});

test("dashboard pins errors and exposes queued empty states", (t) => {
  const failed = { ...job("failed", "failed"), output: "", error: "Harness exited before first response" };
  const queued = { ...job("queued", "queued"), output: "" };
  const { overlay } = dashboard([failed, queued], 24, () => {}, undefined, { focusJobId: "failed" });
  t.after(() => overlay.dispose());
  const failedLines = overlay.render(72);
  assert.ok(failedLines.some((line) => line.includes("Harness exited before first response")));
  overlay.handleInput("j");
  const queuedLines = overlay.render(72);
  assert.ok(queuedLines.some((line) => line.includes("queued")));
  assert.ok(queuedLines.some((line) => line.includes("waiting for an agent slot")));
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

test("takeover restores a rejected draft without overwriting newer input", async (t) => {
  const current = job("draft");
  const { overlay } = dashboard([current], 24, () => {}, undefined, { focusJobId: current.id, sendError: "send failed", submitKey: "\u0011" });
  t.after(() => overlay.dispose());
  overlay.focused = true;
  overlay.render(72);
  overlay.handleInput("\r");
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
  overlay.handleInput("\r");
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
  assert.ok(lines.some((line) => line.includes("read · file.ts")));
  assert.ok(lines.some((line) => line.includes("also verify tests")));
  assert.ok(lines.some((line) => line.includes("effort high")), "takeover metadata shows request effort");
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
