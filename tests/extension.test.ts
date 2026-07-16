import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { Backend, BackendEvent, BackendName, BackendRequest, BackendRun } from "../src/types.ts";

class HoldingBackend implements Backend {
  readonly name: BackendName;
  constructor(name: BackendName) { this.name = name; }
  async start(_request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    emit({ type: "started", backendSessionId: `${this.name}-session` });
    const settle = (event: BackendEvent) => { emit(event); resolveCompleted(); };
    return {
      completed,
      async send() {},
      async cancel(reason = "Cancelled") { settle({ type: "cancelled", reason }); },
      async close() { resolveCompleted(); },
    };
  }
}

class ImmediateBackend implements Backend {
  readonly starts: BackendRequest[] = [];
  readonly name: BackendName;
  constructor(name: BackendName) { this.name = name; }
  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.starts.push(request);
    emit({ type: "completed", output: `${this.name}-ok` });
    return {
      completed: Promise.resolve(),
      send: async (message: string) => { emit({ type: "completed", output: `${this.name}-${message}` }); },
      async cancel() {},
      async close() {},
    };
  }
}

function fakePi() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messageRenderers = new Map<string, any>();
  const messages: unknown[] = [];
  return {
    api: {
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      registerTool(tool: any) {
        if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) {
        if (commands.has(name)) throw new Error(`duplicate command: ${name}`);
        commands.set(name, command);
      },
      registerMessageRenderer(name: string, renderer: any) { messageRenderers.set(name, renderer); },
      sendMessage(message: unknown) { messages.push(message); },
      appendEntry() {},
    } as any,
    handlers,
    tools,
    commands,
    messageRenderers,
    messages,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function context(branch: unknown[] = []) {
  return {
    cwd: process.cwd(),
    mode: "rpc",
    isProjectTrusted: () => true,
    isIdle: () => false,
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus() {},
      notify() {},
    },
  } as any;
}

test("extension registers once and spawn uses role default while foreground uses legacy session profile", async () => {
  const pi = fakePi();
  const registry = {};
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  const workflowArtifactRoot = join(await mkdtemp(join(tmpdir(), "extension-workflows-")), "runs");
  registerNativeSubagents(pi.api, { registry, legacyRoot: false, backends, workflowArtifactRoot });

  assert.deepEqual([...pi.tools.keys()].sort(), [
    "subagent", "subagent_cancel", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait", "workflow",
  ]);
  assert.deepEqual([...pi.commands.keys()].sort(), ["subagents", "subagents-config", "workflows"]);
  assert.ok(pi.messageRenderers.has("native-workflow-result"));
  assert.ok(pi.messageRenderers.has("native-subagent-result"));
  assert.throws(() => registerNativeSubagents(fakePi().api, { registry, legacyRoot: false, backends }), /loaded more than once/);

  const ctx = context([{ type: "custom", customType: "subagents-profile", data: { profile: "pi" } }]);
  pi.handlers.get("session_start")?.({}, ctx);

  const background = await pi.tools.get("subagent_spawn").execute("spawn", { role: "researcher", task: "background" }, undefined, undefined, ctx);
  assert.equal(background.details.job.backend, "claude", "background spawn must preserve researcher.defaultBackend");
  await new Promise((resolve) => setImmediate(resolve));
  pi.handlers.get("agent_settled")?.();
  assert.equal((pi.messages[0] as any)?.customType, "native-subagent-result", "unconsumed background result is delivered once");

  const consumed = await pi.tools.get("subagent_spawn").execute("spawn", { role: "researcher", task: "consumed" }, undefined, undefined, ctx);
  await pi.tools.get("subagent_wait").execute("wait", { jobId: consumed.details.job.id }, undefined, undefined, ctx);
  pi.handlers.get("agent_settled")?.();
  assert.equal(pi.messages.length, 1, "wait consumes deferred delivery without duplication");
  const historicalContext = { args: {}, state: {}, invalidate() {} };
  const generationZero = pi.tools.get("subagent_spawn").renderResult(consumed, { expanded: true, isPartial: false }, theme, historicalContext).render(100).join("\n");
  assert.match(generationZero, /claude-ok/);
  await pi.tools.get("subagent_send").execute("send", { jobId: consumed.details.job.id, message: "second generation", behavior: "followUp" }, undefined, undefined, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  pi.handlers.get("agent_settled")?.();
  assert.equal(pi.messages.length, 2, "consumption is scoped to one generation; reused-session output still delivers once");
  const historicalAfterFollowUp = pi.tools.get("subagent_spawn").renderResult(consumed, { expanded: true, isPartial: false }, theme, historicalContext).render(100).join("\n");
  assert.match(historicalAfterFollowUp, /claude-ok/);
  assert.doesNotMatch(historicalAfterFollowUp, /second generation/, "older thread cards stay pinned to their own generation");

  const foreground = await pi.tools.get("subagent").execute("foreground", { agent: "researcher", task: "foreground" }, undefined, undefined, ctx);
  assert.equal(foreground.details.job.backend, "pi", "compatibility foreground uses the restored session profile");

  await pi.handlers.get("session_shutdown")?.();

  const pulsePi = fakePi();
  const pulseTimers = new Map<object, () => void>();
  let pulseDelay = 0;
  const fakeSetInterval = ((callback: () => void, delay: number) => {
    pulseDelay = delay;
    const timer = { unref() {} };
    pulseTimers.set(timer, callback);
    return timer;
  }) as unknown as typeof setInterval;
  const fakeClearInterval = ((timer: object) => { pulseTimers.delete(timer); }) as unknown as typeof clearInterval;
  registerNativeSubagents(pulsePi.api, {
    registry: {},
    legacyRoot: false,
    backends: [new HoldingBackend("pi"), new HoldingBackend("claude"), new HoldingBackend("codex")],
    workflowArtifactRoot: join(await mkdtemp(join(tmpdir(), "extension-pulse-workflows-")), "runs"),
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });
  const pulseCtx = context();
  pulsePi.handlers.get("session_start")?.({}, pulseCtx);
  const active = await pulsePi.tools.get("subagent_spawn").execute("pulse", { role: "researcher", task: "show pulse" }, undefined, undefined, pulseCtx);
  await new Promise((resolve) => setImmediate(resolve));
  let invalidations = 0;
  const renderContext = { args: {}, state: {}, invalidate: () => { invalidations++; } };
  const activeCard = pulsePi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(activeCard.render(80).some((line: string) => line.includes("updating…")), "background thread card follows the live job");
  assert.equal(pulseTimers.size, 1, "active thread cards share one bounded pulse timer");
  assert.equal(pulseDelay, 200, "thread card fade advances in smooth 200 ms frames");
  pulseTimers.values().next().value?.();
  assert.equal(invalidations, 1, "pulse timer invalidates the existing thread row");
  await pulsePi.tools.get("subagent_cancel").execute("cancel-pulse", { jobId: active.details.job.id }, undefined, undefined, pulseCtx);
  assert.equal(pulseTimers.size, 0, "manager settlement prunes the pulse without requiring a rerender");
  const settledCard = pulsePi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(80).some((line: string) => line.includes("cancelled")), "thread card settles from remembered manager state");
  await pulsePi.handlers.get("session_shutdown")?.();
});
