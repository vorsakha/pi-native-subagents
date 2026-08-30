import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { AdvisorsDashboard, type AdvisorsDashboardManager } from "../extensions/advisors/dashboard.ts";
import { advisorSnapshotFixture, theme, tick } from "./helpers.ts";

const ENTER = "\r";
const ESCAPE = "\u001b";

function harness() {
  const roster = [advisorSnapshotFixture()];
  const calls: string[] = [];
  const listeners = new Set<(advisor: ReturnType<typeof advisorSnapshotFixture>) => void>();
  let renders = 0;
  let closed = 0;
  const manager: AdvisorsDashboardManager = {
    list: () => roster,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    consult: async (request) => {
      calls.push(request.question);
      return {
        ok: true,
        advisorId: request.advisorId,
        advisorName: roster[0]!.name,
        lineage: 1,
        generation: 4,
        output: "Keep it read-only.",
        route: { harness: "claude" },
        queuedMs: 0,
      };
    },
    close: async (_threadId, advisorId) => {
      const advisor = roster.find((candidate) => candidate.id === advisorId)!;
      roster.splice(roster.indexOf(advisor), 1);
      for (const listener of listeners) listener({ ...advisor, state: "closed" });
      return { ...advisor, state: "closed" };
    },
    reset: async (_threadId, advisorId) => {
      const advisor = roster.find((candidate) => candidate.id === advisorId)!;
      advisor.lineage++;
      advisor.generation = 0;
      for (const listener of listeners) listener(advisor);
      return advisor;
    },
  };
  const tui = {
    terminal: { rows: 24 },
    requestRender: () => { renders++; },
  } as unknown as TUI;
  const keybindings = {
    matches: () => false,
    getKeys: () => [],
  } as unknown as KeybindingsManager;
  const dashboard = new AdvisorsDashboard(tui, theme, keybindings, manager, "thread-advisors", () => { closed++; });
  dashboard.focused = true;
  return { dashboard, roster, calls, get renders() { return renders; }, get closed() { return closed; } };
}

test("advisor dashboard renders bounded identity, policy, queue, usage, and provenance without private continuations", () => {
  const state = harness();
  const rendered = state.dashboard.render(64);
  const text = rendered.join("\n");
  assert.match(text, /Security advisor/);
  assert.match(text, /read-only/);
  assert.match(text, /Lineage.*1.*generation 3/);
  assert.match(text, /Latest.*workflow.*completed/);
  assert.doesNotMatch(text, /sessionFile|threadId|continuation/);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 64));
  assert.ok(rendered.length <= 24);
  state.dashboard.dispose();
});

test("advisor dashboard keeps ask, explicit reset, close confirmation, and Escape keyboard accessible", async () => {
  const state = harness();
  state.dashboard.handleInput("a");
  for (const character of "Review this") state.dashboard.handleInput(character);
  state.dashboard.handleInput(ENTER);
  await tick();
  assert.deepEqual(state.calls, ["Review this"]);
  assert.match(state.dashboard.render(72).join("\n"), /Answer.*Keep it read-only/);

  state.dashboard.handleInput("r");
  assert.match(state.dashboard.render(72).join("\n"), /Reset this lineage explicitly/);
  state.dashboard.handleInput(ENTER);
  await tick();
  assert.equal(state.roster[0]?.lineage, 2);
  assert.equal(state.roster[0]?.generation, 0);

  state.dashboard.handleInput("x");
  assert.match(state.dashboard.render(72).join("\n"), /Close this advisor/);
  state.dashboard.handleInput(ESCAPE);
  assert.equal(state.roster.length, 1, "Escape cancels destructive confirmation");
  state.dashboard.handleInput("x");
  state.dashboard.handleInput(ENTER);
  await tick();
  assert.equal(state.roster.length, 0);

  state.dashboard.handleInput(ESCAPE);
  assert.equal(state.closed, 1);
});
