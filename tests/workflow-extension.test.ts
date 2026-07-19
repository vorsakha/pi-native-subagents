import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { Backend, BackendEvent, BackendName, BackendRequest, BackendRun } from "../src/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

class ImmediateBackend implements Backend {
  readonly name: BackendName;
  constructor(name: BackendName) { this.name = name; }
  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    emit({ type: "usage", usage: { input: 12, output: 3, cost: 0.01, turns: 1 } });
    emit({ type: "completed", output: `${request.name}:${request.task}` });
    return { completed: Promise.resolve(), async send() {}, async cancel() {}, async close() {} };
  }
}

class HoldingBackend implements Backend {
  readonly name: BackendName = "codex";
  starts = 0;
  private emit: ((event: BackendEvent) => void) | undefined;
  private settle: (() => void) | undefined;

  async start(_request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.starts++;
    this.emit = emit;
    const completed = new Promise<void>((resolve) => { this.settle = resolve; });
    return { completed, async send() {}, async cancel() {}, async close() {} };
  }

  complete(output = "done"): void {
    this.emit?.({ type: "completed", output });
    this.settle?.();
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
  const notifications: Array<{ message: string; type: string }> = [];
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
        notify(message: string, type: string) { notifications.push({ message, type }); },
      },
    } as any,
    statuses,
    notifications,
  };
}

async function setup(options: {
  backends?: Backend[];
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
} = {}) {
  const root = join(await mkdtemp(join(tmpdir(), "workflow-extension-")), "runs");
  const globalProfilesDir = join(await mkdtemp(join(tmpdir(), "workflow-extension-profiles-")), "profiles");
  const pi = fakePi();
  const backends = options.backends ?? [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, {
    registry: {}, legacyRoot: false, backends, workflowArtifactRoot: root, globalProfilesDir,
    setInterval: options.setInterval, clearInterval: options.clearInterval,
  });
  return { root, pi };
}

test("background workflows return immediately and deliver one follow-up result for success or failure", async () => {
  const { pi } = await setup();
  const { ctx } = context();
  assert.equal(pi.tools.get("workflow").renderShell, "self", "workflow should use the inline trace shell");
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("wf", {
    name: "Background review",
    script: `export default async () => agent("inspect", { name: "reviewer", access: "readOnly" })`,
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
  assert.equal(pi.messages[0]?.message.details.workflow.agents[0]?.prompt, undefined, "model-facing compact details exclude agent prompts");
  assert.equal(pi.messages[0]?.message.details.workflow.agents[0]?.tools, undefined, "model-facing compact details exclude supervision traces");
  await pi.handlers.get("session_shutdown")?.();

  const failed = await setup();
  const failedContext = context();
  failed.pi.handlers.get("session_start")?.({}, failedContext.ctx);
  await failed.pi.tools.get("workflow").execute("wf", {
    name: "Background failure",
    script: `export default async () => { throw new Error("script exploded") }`,
    background: true,
  }, new AbortController().signal, undefined, failedContext.ctx);
  for (let index = 0; index < 50 && failed.pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(failed.pi.messages.length, 1);
  assert.equal(failed.pi.messages[0]?.message.details.workflow.status, "failed");
  assert.match(failed.pi.messages[0]?.message.details.workflow.error ?? "", /script exploded/);
  await failed.pi.handlers.get("session_shutdown")?.();
});

test("background workflow cards follow live state with one bounded blink timer", async () => {
  const backend = new HoldingBackend();
  const timers = new Map<object, () => void>();
  let blinkDelay = 0;
  const fakeSetInterval = ((callback: () => void, delay: number) => {
    blinkDelay = delay;
    const timer = { unref() {} };
    timers.set(timer, callback);
    return timer;
  }) as unknown as typeof setInterval;
  const fakeClearInterval = ((timer: object) => { timers.delete(timer); }) as unknown as typeof clearInterval;
  const { pi } = await setup({ backends: [backend], setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
  const { ctx } = context();
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("wf-live", {
    name: "Live review",
    script: `export default async () => agent("inspect", { name: "inspection", access: "readOnly" })`,
    background: true,
  }, new AbortController().signal, undefined, ctx);
  for (let index = 0; index < 50 && backend.starts === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(backend.starts, 1);

  let invalidations = 0;
  const renderContext = { args: {}, state: {}, invalidate: () => { invalidations++; } };
  const activeCard = pi.tools.get("workflow").renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(activeCard.render(100).some((line: string) => line.includes("running")));
  assert.equal(timers.size, 1);
  assert.equal(blinkDelay, 500);
  timers.values().next().value?.();
  assert.equal(invalidations, 1);

  backend.complete("review complete");
  for (let index = 0; index < 50 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(timers.size, 0, "terminal workflow state prunes the shared blink timer");
  const settledCard = pi.tools.get("workflow").renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(100).some((line: string) => line.includes("completed")));
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
  await denied.pi.commands.get("workflows").handler("", untrusted.ctx);
  assert.match(untrusted.notifications.at(-1)?.message ?? "", /unavailable for untrusted projects/);
  await denied.pi.handlers.get("session_shutdown")?.();
});
