import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { Backend, BackendEvent, HarnessName, BackendRequest, BackendRun } from "../src/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

class ImmediateBackend implements Backend {
  readonly name: HarnessName;
  readonly requests: BackendRequest[] = [];
  constructor(name: HarnessName) { this.name = name; }
  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.requests.push(request);
    emit({ type: "usage", usage: { input: 12, output: 3, cost: 0.01, turns: 1 } });
    emit({ type: "completed", output: `${request.name}:${request.task}` });
    return { completed: Promise.resolve(), async send() {}, async cancel() {}, async close() {} };
  }
}

class HoldingBackend implements Backend {
  readonly name: HarnessName = "pi";
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

function context(trusted = true, confirm: () => Promise<boolean> = async () => false) {
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
        confirm,
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
  const savedWorkflowRoot = join(await mkdtemp(join(tmpdir(), "workflow-extension-saved-")), "definitions");
  await mkdir(savedWorkflowRoot, { recursive: true });
  const pi = fakePi();
  const backends = options.backends ?? [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, {
    registry: {}, legacyRoot: false, backends, workflowArtifactRoot: root, globalProfilesDir, savedWorkflowRoot,
    setInterval: options.setInterval, clearInterval: options.clearInterval,
  });
  return { root, savedWorkflowRoot, pi };
}

test("direct and workflow agents use Pi by default and forward exact models or native defaults", async () => {
  const piBackend = new ImmediateBackend("pi");
  const { pi } = await setup({ backends: [piBackend] });
  const { ctx } = context();
  pi.handlers.get("session_start")?.({}, ctx);
  const direct = await pi.tools.get("subagent").execute("direct", { task: "direct", model: "direct-model" }, undefined, undefined, ctx);
  assert.equal(direct.details.job.model, "direct-model");
  const workflow = await pi.tools.get("workflow").execute("wf", {
    name: "routing",
    script: `export default async () => agent("workflow " + args.subject, { model: "workflow-model" })`,
    input: { subject: "agent" },
  }, undefined, undefined, ctx);
  assert.equal(workflow.details.workflow.agents[0].model, "workflow-model");
  assert.equal(workflow.details.workflow.agents[0].harness, "pi");
  assert.equal(piBackend.requests.at(-1)?.policy.model, "workflow-model");
  assert.equal(piBackend.requests.at(-1)?.task, "workflow agent");
  const requestsBeforeResume = piBackend.requests.length;
  const resumed = await pi.tools.get("workflow").execute("wf-resume", {
    name: "routing",
    script: `export default async () => agent("workflow " + args.subject, { model: "workflow-model" })`,
    input: { subject: "agent" },
    resumeFromRunId: workflow.details.workflow.runId,
  }, undefined, undefined, ctx);
  assert.equal(resumed.details.workflow.replay.matchedCalls, 1);
  assert.equal(piBackend.requests.length, requestsBeforeResume, "resuming an exact completed workflow replays without dispatch");
  const nativeDefault = await pi.tools.get("subagent").execute("default", { task: "default" }, undefined, undefined, ctx);
  assert.equal(nativeDefault.details.job.harness, "pi");
  assert.equal(nativeDefault.details.job.model, "default");
  assert.equal(piBackend.requests.at(-1)?.policy.model, undefined);
  await pi.handlers.get("session_shutdown")?.();
});

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

  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0]?.message.customType, "native-workflow-result");
  assert.equal(pi.messages[0]?.options.deliverAs, "followUp");
  assert.equal(pi.messages[0]?.options.triggerTurn, true);
  assert.equal(pi.messages[0]?.message.details.workflow.status, "completed");
  assert.doesNotMatch(pi.messages[0]?.message.content ?? "", /Artifacts:|workflow-extension-/i, "model-facing results omit machine-local artifact paths");
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
  for (let index = 0; index < 500 && failed.pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(failed.pi.messages.length, 1);
  assert.equal(failed.pi.messages[0]?.message.details.workflow.status, "failed");
  assert.match(failed.pi.messages[0]?.message.details.workflow.error ?? "", /script exploded/);
  await failed.pi.handlers.get("session_shutdown")?.();
});

test("background workflow cards follow live state without periodic rerenders", async () => {
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
  for (let index = 0; index < 500 && backend.starts === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(backend.starts, 1);

  let invalidations = 0;
  const renderContext = { args: {}, state: {}, invalidate: () => { invalidations++; } };
  const activeCard = pi.tools.get("workflow").renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(activeCard.render(100).some((line: string) => line.includes("running")));
  assert.equal(timers.size, 0);
  assert.equal(blinkDelay, 0);
  assert.equal(invalidations, 0);

  backend.complete("review complete");
  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(timers.size, 0, "terminal workflow state leaves no periodic render timer");
  assert.ok(invalidations > 0, "workflow events still invalidate the existing card");
  const settledCard = pi.tools.get("workflow").renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(100).some((line: string) => line.includes("completed")));
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow tool resolves saved definitions and enforces one script source", async () => {
  const { pi, savedWorkflowRoot } = await setup();
  await writeFile(join(savedWorkflowRoot, "saved-review.js"), `export default async () => agent("saved " + args.subject, { access: "readOnly" });`);
  const { ctx } = context();
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("saved", {
    workflowName: "saved-review",
    input: { subject: "workflow" },
  }, undefined, undefined, ctx);
  assert.equal(result.details.workflow.name, "saved-review");
  assert.equal(result.details.workflow.status, "completed");
  await assert.rejects(pi.tools.get("workflow").execute("ambiguous", {
    script: `export default null`, workflowName: "saved-review",
  }, undefined, undefined, ctx), /exactly one/);
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow onMutate approval is decided by the host UI", async () => {
  const { pi } = await setup();
  let confirmations = 0;
  const approved = context(true, async () => { confirmations++; return true; });
  pi.handlers.get("session_start")?.({}, approved.ctx);
  const result = await pi.tools.get("workflow").execute("approved", {
    name: "approved", script: `export default async () => agent("mutate", {})`, approval: "onMutate",
  }, undefined, undefined, approved.ctx);
  assert.equal(result.details.workflow.status, "completed");
  assert.equal(confirmations, 1);
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
  await assert.rejects(
    invalid.pi.tools.get("workflow").execute("wf", {
      name: "ambiguous",
      script: "export default async () => null",
      args: "{}",
      input: {},
    }, undefined, undefined, trusted.ctx),
    /either structured input or legacy JSON args/i,
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
