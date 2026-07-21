import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

function context(branch: unknown[] = [], provider?: string) {
  const notifications: string[] = [];
  return {
    cwd: process.cwd(),
    model: provider ? { provider, id: "parent-model" } : undefined,
    mode: "rpc",
    isProjectTrusted: () => true,
    isIdle: () => false,
    sessionManager: { getBranch: () => branch, getSessionId: () => "extension-session" },
    ui: {
      notifications,
      setStatus() {},
      notify(message: string) { notifications.push(message); },
    },
  } as any;
}

test("extension exposes generic direct tools, caller models, independence, and one-shot delivery", async () => {
  const pi = fakePi();
  const registry = {};
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  const extensionRoot = await mkdtemp(join(tmpdir(), "extension-workflows-"));
  const workflowArtifactRoot = join(extensionRoot, "runs");
  const globalProfilesDir = join(extensionRoot, "profiles");
  await mkdir(globalProfilesDir);
  await writeFile(join(globalProfilesDir, "audit.md"), "---\nname: audit\naccess: readOnly\n---\nAudit carefully.\n");
  registerNativeSubagents(pi.api, { registry, legacyRoot: false, backends, workflowArtifactRoot, globalProfilesDir });

  assert.deepEqual([...pi.tools.keys()].sort(), [
    "subagent", "subagent_cancel", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait", "workflow",
  ]);
  assert.deepEqual([...pi.commands.keys()].sort(), ["subagents", "subagents-config", "workflows"]);
  const spawnProperties = pi.tools.get("subagent_spawn").parameters.properties;
  assert.ok(spawnProperties.model);
  assert.equal(spawnProperties.modelTier, undefined, "tier compatibility is intentionally absent");
  assert.ok(pi.messageRenderers.has("native-workflow-result"));
  assert.ok(pi.messageRenderers.has("native-subagent-result"));
  assert.throws(() => registerNativeSubagents(fakePi().api, { registry, legacyRoot: false, backends }), /loaded more than once/);

  const ctx = context([{ type: "custom", customType: "native-subagents-profile", data: { backend: "pi" } }]);
  ctx.cwd = extensionRoot;
  pi.handlers.get("session_start")?.({}, ctx);
  await pi.commands.get("subagents").handler("profiles", ctx);
  assert.match(ctx.ui.notifications.at(-1) ?? "", /audit \(global\)/);

  const background = await pi.tools.get("subagent_spawn").execute("spawn", { name: "research", task: "background" }, undefined, undefined, ctx);
  assert.equal(background.details.job.backend, "pi", "background spawn uses the configured backend");
  assert.equal(background.details.job.model, "default", "omitted models use the native backend default");
  assert.equal(background.details.job.access, "full", "trusted generic agents default to full access");
  await new Promise((resolve) => setImmediate(resolve));
  pi.handlers.get("agent_settled")?.();
  assert.equal((pi.messages[0] as any)?.customType, "native-subagent-result", "unconsumed background result is delivered once");

  const consumed = await pi.tools.get("subagent_spawn").execute("spawn", { name: "reader", task: "consumed", access: "readOnly", effort: "high" }, undefined, undefined, ctx);
  assert.equal(consumed.details.job.effort, "high");
  const waitCall = pi.tools.get("subagent_wait").renderCall({ jobId: consumed.details.job.id, timeoutMs: 600_000 }, theme).render(100).join("\n");
  assert.match(waitCall, /⌁\s+· wait reader .*timeout 600s/, "wait call resolves the human-readable agent name once");
  const waited = await pi.tools.get("subagent_wait").execute("wait", { jobId: consumed.details.job.id }, undefined, undefined, ctx);
  const waitReceipt = pi.tools.get("subagent_wait").renderResult(waited, { expanded: false, isPartial: false }, theme, { args: {} }).render(100).join("\n");
  assert.match(waitReceipt, /^│\s+✓ completed ·/);
  assert.equal(waitReceipt.includes("reader"), false, "wait result does not repeat its call target");
  pi.handlers.get("agent_settled")?.();
  assert.equal(pi.messages.length, 1, "wait consumes deferred delivery without duplication");
  const historicalContext = { args: {}, state: {}, invalidate() {} };
  const generationZero = pi.tools.get("subagent_spawn").renderResult(consumed, { expanded: true, isPartial: false }, theme, historicalContext).render(100).join("\n");
  assert.match(generationZero, /pi-ok/);
  const reused = await pi.tools.get("subagent_send").execute("send", { jobId: consumed.details.job.id, message: "second generation", behavior: "followUp" }, undefined, undefined, ctx);
  assert.equal(reused.details.job.effort, "high", "retained-session generations preserve request effort metadata");
  await new Promise((resolve) => setImmediate(resolve));
  pi.handlers.get("agent_settled")?.();
  assert.equal(pi.messages.length, 2, "consumption is scoped to one generation; reused-session output still delivers once");
  const historicalAfterFollowUp = pi.tools.get("subagent_spawn").renderResult(consumed, { expanded: true, isPartial: false }, theme, historicalContext).render(100).join("\n");
  assert.match(historicalAfterFollowUp, /pi-ok/);
  assert.doesNotMatch(historicalAfterFollowUp, /second generation/, "older thread cards stay pinned to their own generation");

  const explicitClaude = await pi.tools.get("subagent_spawn").execute("claude-model", {
    name: "implementation", task: "explicit Claude model", backend: "claude", model: "caller-model", effort: "max",
  }, undefined, undefined, ctx);
  assert.equal(explicitClaude.details.job.backend, "claude");
  assert.equal(explicitClaude.details.job.model, "caller-model");
  await pi.tools.get("subagent_wait").execute("wait-claude-model", { jobId: explicitClaude.details.job.id }, undefined, undefined, ctx);
  const explicitRequest = backends.find((backend) => backend.name === "claude")?.starts.find((request) => request.task === "explicit Claude model");
  assert.equal(explicitRequest?.policy.model, "caller-model");
  assert.equal(explicitRequest?.policy.effort, "max");
  await assert.rejects(
    pi.tools.get("subagent_spawn").execute("blank-model", { task: "invalid", model: "   " }, undefined, undefined, ctx),
    /1–256/,
  );

  const profiled = await pi.tools.get("subagent").execute("profiled", { task: "profiled audit", profile: "audit", access: "full" }, undefined, undefined, ctx);
  assert.equal(profiled.details.job.access, "readOnly", "profile access is a ceiling in direct tools");
  assert.match(backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.task === "profiled audit")?.systemPrompt ?? "", /Audit carefully/);

  const foreground = await pi.tools.get("subagent").execute("foreground", { name: "foreground", task: "foreground" }, undefined, undefined, ctx);
  assert.equal(foreground.details.job.backend, "pi", "foreground uses the same configured generic route");
  const independentDefault = await pi.tools.get("subagent").execute("foreground-independent", { name: "independent", independent: true, task: "cross-provider default" }, undefined, undefined, ctx);
  assert.equal(independentDefault.details.job.backend, "claude", "unknown parent provider uses native Claude for independent work");
  assert.equal(independentDefault.details.job.model, "default");
  const claudeParent = context([], "anthropic");
  const independentAgainstClaude = await pi.tools.get("subagent_spawn").execute("independent-codex", { name: "second-opinion", independent: true, task: "review Claude independently" }, undefined, undefined, claudeParent);
  assert.equal(independentAgainstClaude.details.job.backend, "codex");
  assert.equal(independentAgainstClaude.details.job.model, "default");
  await assert.rejects(
    pi.tools.get("subagent_spawn").execute("independent-same", { independent: true, backend: "claude", task: "invalid same provider" }, undefined, undefined, claudeParent),
    /different from the parent claude/,
  );
  await assert.rejects(
    pi.tools.get("subagent_spawn").execute("schema-mismatch", { role: "worker", task: "wrong schema" }, undefined, undefined, ctx),
    /Subagent API schema mismatch: reload Pi to use the current task-driven schema\./,
  );

  await pi.handlers.get("session_shutdown")?.();

  const blinkPi = fakePi();
  const blinkTimers = new Map<object, () => void>();
  let blinkDelay = 0;
  const fakeSetInterval = ((callback: () => void, delay: number) => {
    blinkDelay = delay;
    const timer = { unref() {} };
    blinkTimers.set(timer, callback);
    return timer;
  }) as unknown as typeof setInterval;
  const fakeClearInterval = ((timer: object) => { blinkTimers.delete(timer); }) as unknown as typeof clearInterval;
  registerNativeSubagents(blinkPi.api, {
    registry: {},
    legacyRoot: false,
    backends: [new HoldingBackend("pi"), new HoldingBackend("claude"), new HoldingBackend("codex")],
    workflowArtifactRoot: join(await mkdtemp(join(tmpdir(), "extension-blink-workflows-")), "runs"),
    globalProfilesDir: join(await mkdtemp(join(tmpdir(), "extension-blink-profiles-")), "profiles"),
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });
  const blinkCtx = context();
  blinkPi.handlers.get("session_start")?.({}, blinkCtx);
  const active = await blinkPi.tools.get("subagent_spawn").execute("blink", { name: "blink", task: "show blink" }, undefined, undefined, blinkCtx);
  await new Promise((resolve) => setImmediate(resolve));
  let invalidations = 0;
  const renderContext = { args: {}, state: {}, invalidate: () => { invalidations++; } };
  const activeCard = blinkPi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(activeCard.render(80).some((line: string) => line.includes("running")), "background thread card follows the live job");
  assert.equal(blinkTimers.size, 1, "active thread cards share one bounded blink timer");
  assert.equal(blinkDelay, 500, "thread card status blinks at a restrained 500 ms cadence");
  blinkTimers.values().next().value?.();
  assert.equal(invalidations, 1, "blink timer invalidates the existing thread row");
  await blinkPi.tools.get("subagent_cancel").execute("cancel-blink", { jobId: active.details.job.id }, undefined, undefined, blinkCtx);
  assert.equal(blinkTimers.size, 0, "manager settlement prunes the blink without requiring a rerender");
  const settledCard = blinkPi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(80).some((line: string) => line.includes("cancelled")), "thread card settles from remembered manager state");
  await blinkPi.handlers.get("session_shutdown")?.();
});
