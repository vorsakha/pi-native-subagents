import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { AdvisorsDashboard, type AdvisorsDashboardManager } from "../extensions/advisors/dashboard.ts";
import { advisorSnapshotFixture, theme, tick } from "./helpers.ts";

const ENTER = "\r";
const ESCAPE = "\u001b";

function harness(options: { advisors?: number; rows?: number; answer?: string } = {}) {
  const count = options.advisors ?? 1;
  const roster = Array.from({ length: count }, (_, index) => advisorSnapshotFixture(count === 1 ? {} : {
    id: `adv_${index.toString(16).padStart(32, "0")}`,
    name: `Advisor ${index.toString().padStart(2, "0")}`,
    aliases: [`advisor-${index}`],
  }));
  const calls: string[] = [];
  const listeners = new Set<(advisor: ReturnType<typeof advisorSnapshotFixture>) => void>();
  let renders = 0;
  let closed = 0;
  let trusted = true;
  const manager: AdvisorsDashboardManager = {
    list: (_threadId, allowed) => allowed ? roster : [],
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    consult: async (request) => {
      calls.push(request.question);
      return {
        ok: true,
        advisorId: request.advisorId,
        advisorName: roster[0]!.name,
        lineage: 1,
        generation: 4,
        output: options.answer ?? "Keep it read-only.",
        route: { harness: "claude" },
        queuedMs: 0,
      };
    },
    close: async (_threadId, advisorId, allowed) => {
      assert.equal(allowed, true);
      const advisor = roster.find((candidate) => candidate.id === advisorId)!;
      roster.splice(roster.indexOf(advisor), 1);
      for (const listener of listeners) listener({ ...advisor, state: "closed" });
      return { ...advisor, state: "closed" };
    },
    reset: async (_threadId, advisorId, allowed) => {
      assert.equal(allowed, true);
      const advisor = roster.find((candidate) => candidate.id === advisorId)!;
      advisor.lineage++;
      advisor.generation = 0;
      for (const listener of listeners) listener(advisor);
      return advisor;
    },
  };
  const tui = {
    terminal: { rows: options.rows ?? 24 },
    requestRender: () => { renders++; },
  } as unknown as TUI;
  const keybindings = {
    matches: () => false,
    getKeys: () => [],
  } as unknown as KeybindingsManager;
  const dashboard = new AdvisorsDashboard(tui, theme, keybindings, manager, "thread-advisors", () => trusted, () => { closed++; });
  dashboard.focused = true;
  return {
    dashboard,
    roster,
    calls,
    setTrusted(value: boolean) { trusted = value; },
    get renders() { return renders; },
    get closed() { return closed; },
  };
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
  assert.match(state.dashboard.render(72).join("\n"), /Advisor answer[\s\S]*Keep it read-only/);
  state.dashboard.handleInput(ESCAPE);

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

test("advisor answers and persisted latest results remain readable through a wrapped scroll viewport", async () => {
  const suffix = "HUMAN-ADVISOR-SUFFIX";
  const answer = `${"substantive advisor guidance ".repeat(80)}${suffix}`;
  const state = harness({ rows: 12, answer });
  state.dashboard.handleInput("a");
  for (const character of "Review this boundary") state.dashboard.handleInput(character);
  state.dashboard.handleInput(ENTER);
  await tick();
  assert.doesNotMatch(state.dashboard.render(48).join("\n"), new RegExp(suffix));
  state.dashboard.handleInput("G");
  assert.match(state.dashboard.render(48).join("\n"), new RegExp(suffix));
  state.dashboard.handleInput("g");
  assert.doesNotMatch(state.dashboard.render(48).join("\n"), new RegExp(suffix));
  state.dashboard.handleInput(ESCAPE);

  state.roster[0]!.ledger.at(-1)!.output = answer;
  state.dashboard.handleInput(ENTER);
  state.dashboard.handleInput("G");
  assert.match(state.dashboard.render(48).join("\n"), new RegExp(suffix), "Enter reopens the persisted latest ledger result");
  state.dashboard.dispose();
});

test("advisor dashboard keeps the selected roster row and inspector visible in a short viewport", () => {
  const state = harness({ advisors: 16, rows: 12 });
  for (let index = 1; index < 16; index++) state.dashboard.handleInput("j");
  const text = state.dashboard.render(64).join("\n");
  assert.match(text, /❯.*Advisor 15/);
  assert.match(text, /Advisor 15.*owner/);
  assert.match(text, /Route.*read-only/);
  assert.doesNotMatch(text, /❯.*Advisor 00/);
  state.dashboard.dispose();
});

test("advisor dashboard hides the roster and refuses lifecycle controls after trust is revoked", async () => {
  const state = harness();
  state.dashboard.handleInput("x");
  state.setTrusted(false);
  state.dashboard.handleInput(ENTER);
  await tick();
  const text = state.dashboard.render(72).join("\n");
  assert.match(text, /hidden while this project is untrusted/);
  assert.doesNotMatch(text, /Security advisor|lineage|generation/);
  assert.equal(state.roster.length, 1, "revoked trust cannot confirm a pending close");
  state.dashboard.handleInput("r");
  state.dashboard.handleInput("a");
  assert.equal(state.roster[0]?.lineage, 1);
  assert.deepEqual(state.calls, []);
  state.dashboard.dispose();
});
