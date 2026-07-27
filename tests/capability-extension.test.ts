import test from "node:test";
import assert from "node:assert/strict";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { DiscoveredCapability } from "../src/capabilities.ts";
import type {
  Backend,
  BackendEvent,
  BackendRequest,
  BackendRun,
  DiscoveryRequest,
  DiscoveryResult,
  HarnessName,
} from "../src/types.ts";

class DiscoverableBackend implements Backend {
  readonly name: HarnessName;
  readonly starts: BackendRequest[] = [];
  #capabilities: DiscoveredCapability[];

  constructor(name: HarnessName, capabilities: DiscoveredCapability[] = []) {
    this.name = name;
    this.#capabilities = capabilities;
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.starts.push(request);
    emit({ type: "completed", output: `${this.name}-ok` });
    return { completed: Promise.resolve(), async send() {}, async cancel() {}, async close() {} };
  }

  async discover(_request: DiscoveryRequest): Promise<DiscoveryResult> {
    return { capabilities: this.#capabilities, sources: [{ source: `${this.name}-fixture`, health: "healthy" }] };
  }
}

function fakePi() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  return {
    api: {
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerMessageRenderer() {},
      sendMessage() {},
      appendEntry() {},
    } as any,
    handlers,
    tools,
    commands,
  };
}

function context(trusted = true) {
  const notifications: string[] = [];
  return {
    cwd: process.cwd(),
    model: undefined,
    mode: "rpc",
    isProjectTrusted: () => trusted,
    isIdle: () => false,
    sessionManager: { getBranch: () => [], getSessionId: () => "capability-session" },
    ui: { notifications, setStatus() {}, notify(message: string) { notifications.push(message); } },
  } as any;
}

function setup(backends: Backend[], legacyRoot: string | false = false) {
  const pi = fakePi();
  registerNativeSubagents(pi.api, { registry: {}, legacyRoot, backends });
  const ctx = context();
  pi.handlers.get("session_start")?.({}, ctx);
  return { pi, ctx };
}

test("subagent_capabilities exposes a bounded discovery schema and denies untrusted projects", async () => {
  const { pi, ctx } = setup([new DiscoverableBackend("codex"), new DiscoverableBackend("claude"), new DiscoverableBackend("pi")]);
  const tool = pi.tools.get("subagent_capabilities");
  assert.ok(tool, "subagent_capabilities is registered");
  const properties = tool.parameters.properties;
  for (const field of ["query", "harness", "kind", "effect", "access", "includeUnavailable", "limit", "refresh"]) {
    assert.ok(Object.hasOwn(properties, field), `subagent_capabilities exposes ${field}`);
  }
  await assert.rejects(
    tool.execute("untrusted", {}, undefined, undefined, context(false)),
    /Subagent capability discovery is disabled for untrusted projects/,
  );
});

test("subagent_capabilities reports a live, per-harness catalog summary and matching capability lines", async () => {
  const { pi, ctx } = setup([
    new DiscoverableBackend("codex", [{ kind: "tool", name: "lint", description: "run the linter", effect: "inspect" }]),
    new DiscoverableBackend("claude", [{ kind: "tool", name: "Read" }]),
    new DiscoverableBackend("pi", []),
  ]);
  const result = await pi.tools.get("subagent_capabilities").execute("caps", { query: "lint" }, undefined, undefined, ctx);
  const text = result.content[0].text as string;
  assert.match(text, /codex: 1\/1 usable under full/);
  assert.match(text, /codex:tool:lint \[inspect\]/);
  assert.doesNotMatch(text, /claude:tool:read/i, "the query filters out non-matching capabilities");
});

test("subagent_capabilities can scope to one harness and surface denied/blocked capabilities with includeUnavailable", async () => {
  const { pi, ctx } = setup([
    new DiscoverableBackend("codex", [{ kind: "tool", name: "Bash" }, { kind: "agent", name: "reviewer" }]),
    new DiscoverableBackend("claude", []),
    new DiscoverableBackend("pi", []),
  ]);
  const result = await pi.tools.get("subagent_capabilities").execute("caps", {
    harness: "codex", includeUnavailable: true,
  }, undefined, undefined, ctx);
  const text = result.content[0].text as string;
  assert.match(text, /codex:agent:reviewer.*unavailable: nested agent orchestration is denied/);
});

test("subagent_spawn with harness auto routes to the harness that actually provides the required capability", async () => {
  const codex = new DiscoverableBackend("codex", []);
  const claude = new DiscoverableBackend("claude", [{ kind: "tool", name: "lint", effect: "inspect" }]);
  const pi2 = new DiscoverableBackend("pi", []);
  const { pi, ctx } = setup([codex, claude, pi2]);
  const spawned = await pi.tools.get("subagent_spawn").execute("spawn", {
    task: "lint the project", harness: "auto", requires: ["tool:lint"],
  }, undefined, undefined, ctx);
  assert.equal(spawned.details.job.harness, "claude");
  assert.deepEqual(spawned.details.job.requires, ["claude:tool:lint"], "the job records the live-normalized capability ID");
  assert.deepEqual(spawned.details.job.capabilities?.matched, ["claude:tool:lint"]);
  assert.equal(spawned.details.job.capabilities?.auto, true);
  assert.equal(claude.starts.length, 1, "the winning harness actually receives the dispatched job");
  assert.equal(codex.starts.length, 0);
});

test("subagent_spawn with an explicit harness that lacks the required capability fails closed before dispatch", async () => {
  const codex = new DiscoverableBackend("codex", []);
  const claude = new DiscoverableBackend("claude", [{ kind: "tool", name: "lint", effect: "inspect" }]);
  const pi2 = new DiscoverableBackend("pi", []);
  const { pi, ctx } = setup([codex, claude, pi2]);
  await assert.rejects(
    pi.tools.get("subagent_spawn").execute("spawn", {
      task: "lint the project", harness: "codex", requires: ["tool:lint"],
    }, undefined, undefined, ctx),
    /Selected harness cannot satisfy the required capabilities: tool:lint/,
  );
  assert.equal(codex.starts.length, 0, "a failed capability route never dispatches the job");
});

test("subagent_spawn with requires but no harness auto still records the live-revalidated route on an explicit harness", async () => {
  const claude = new DiscoverableBackend("claude", [{ kind: "tool", name: "lint", effect: "inspect" }]);
  const { pi, ctx } = setup([new DiscoverableBackend("codex", []), claude, new DiscoverableBackend("pi", [])]);
  const spawned = await pi.tools.get("subagent").execute("spawn", {
    task: "lint the project", harness: "claude", requires: ["claude:tool:lint"],
  }, undefined, undefined, ctx);
  assert.equal(spawned.details.job.harness, "claude");
  assert.deepEqual(spawned.details.job.capabilities?.matched, ["claude:tool:lint"]);
  assert.equal(spawned.details.job.capabilities?.auto, undefined, "an explicit route is not marked auto-routed");
});
