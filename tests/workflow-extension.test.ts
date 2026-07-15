import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { Backend, BackendEvent, BackendName, BackendRequest, BackendRun } from "../src/types.ts";

class ImmediateBackend implements Backend {
  readonly name: BackendName;
  constructor(name: BackendName) { this.name = name; }
  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    emit({ type: "usage", usage: { input: 12, output: 3, cost: 0.01, turns: 1 } });
    emit({ type: "completed", output: `${request.role}:${request.task}` });
    return { completed: Promise.resolve(), async send() {}, async cancel() {}, async close() {} };
  }
}

function fakePi() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  return {
    api: {
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerMessageRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
      sendMessage(message: any, options: any) { messages.push({ message, options }); },
      appendEntry() {},
    } as any,
    handlers,
    tools,
    commands,
    renderers,
    messages,
  };
}

function context(trusted = true) {
  const statuses = new Map<string, string | undefined>();
  return {
    ctx: {
      cwd: process.cwd(),
      mode: "rpc",
      hasUI: true,
      isProjectTrusted: () => trusted,
      isIdle: () => false,
      sessionManager: { getBranch: () => [], getSessionId: () => "workflow-extension-session" },
      ui: {
        setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
        notify() {},
      },
    } as any,
    statuses,
  };
}

async function setup() {
  const root = join(await mkdtemp(join(tmpdir(), "workflow-extension-")), "runs");
  const pi = fakePi();
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, { registry: {}, legacyRoot: false, backends, workflowArtifactRoot: root });
  return { root, pi };
}

const script = `
  export const meta = { name: "Meta name", description: "Meta description" };
  export default async () => {
    phase("Build");
    const built = await agent("implement", { role: "worker", label: "implementation" });
    phase("Review");
    const reviewed = await agent(built.output, { role: "reviewer", label: "review" });
    return { built: built.ok, reviewed: reviewed.ok, output: reviewed.output };
  };
`;

test("workflow tool runs role-based agents, persists artifacts, and returns structured renderer details", async () => {
  const { root, pi } = await setup();
  const { ctx, statuses } = context();
  pi.handlers.get("session_start")?.({}, ctx);
  const tool = pi.tools.get("workflow");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.ok(pi.commands.has("workflows"));
  assert.ok(pi.renderers.has("native-workflow-result"));

  const result = await tool.execute("wf", {
    name: "Implement and review",
    description: "Two phases",
    script,
    args: JSON.stringify({ ticket: "SIS-1" }),
  }, new AbortController().signal, () => {}, ctx);

  assert.equal(result.details.workflow.status, "completed");
  assert.equal(result.details.workflow.name, "Meta name");
  assert.deepEqual(result.details.workflow.result, { built: true, reviewed: true, output: "reviewer:worker:implement" });
  assert.equal(result.details.workflow.agents.length, 2);
  assert.equal(result.details.workflow.agents[0].output, undefined, "tool details must not embed full child transcripts");
  assert.match(result.content[0].text, /Artifacts:/);
  assert.match(statuses.get("native-workflows") ?? "", /1✓/);

  const persisted = JSON.parse(await readFile(join(root, result.details.workflow.runId, "workflow.json"), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.agents.length, 2);
  await pi.handlers.get("session_shutdown")?.();
});

test("background workflow returns immediately and delivers one follow-up result", async () => {
  const { pi } = await setup();
  const { ctx } = context();
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("wf", {
    name: "Background review",
    script: `export default async () => agent("inspect", { role: "reviewer" })`,
    background: true,
  }, new AbortController().signal, undefined, ctx);
  assert.match(result.content[0].text, /Workflow started/);

  for (let index = 0; index < 50 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0]?.message.customType, "native-workflow-result");
  assert.equal(pi.messages[0]?.options.deliverAs, "followUp");
  assert.equal(pi.messages[0]?.options.triggerTurn, true);
  assert.equal(pi.messages[0]?.message.details.workflow.status, "completed");
  await pi.handlers.get("session_shutdown")?.();
});

test("failed background workflow still delivers exactly one failure follow-up", async () => {
  const { pi } = await setup();
  const { ctx } = context();
  pi.handlers.get("session_start")?.({}, ctx);
  await pi.tools.get("workflow").execute("wf", {
    name: "Background failure",
    script: `export default async () => { throw new Error("script exploded") }`,
    background: true,
  }, new AbortController().signal, undefined, ctx);
  for (let index = 0; index < 50 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0]?.message.details.workflow.status, "failed");
  assert.match(pi.messages[0]?.message.details.workflow.error ?? "", /script exploded/);
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow tool rejects invalid JSON args and untrusted projects", async () => {
  const invalid = await setup();
  const trusted = context();
  invalid.pi.handlers.get("session_start")?.({}, trusted.ctx);
  await assert.rejects(
    invalid.pi.tools.get("workflow").execute("wf", { name: "bad", script: "export default async () => null", args: "{" }, undefined, undefined, trusted.ctx),
    /valid JSON/,
  );
  await invalid.pi.handlers.get("session_shutdown")?.();

  const denied = await setup();
  const untrusted = context(false);
  denied.pi.handlers.get("session_start")?.({}, untrusted.ctx);
  await assert.rejects(
    denied.pi.tools.get("workflow").execute("wf", { name: "denied", script: "export default async () => null" }, undefined, undefined, untrusted.ctx),
    /disabled for untrusted projects/,
  );
  await denied.pi.handlers.get("session_shutdown")?.();
});
