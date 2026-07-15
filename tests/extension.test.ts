import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { Backend, BackendEvent, BackendName, BackendRequest, BackendRun } from "../src/types.ts";

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
  await pi.tools.get("subagent_send").execute("send", { jobId: consumed.details.job.id, message: "second generation", behavior: "followUp" }, undefined, undefined, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  pi.handlers.get("agent_settled")?.();
  assert.equal(pi.messages.length, 2, "consumption is scoped to one generation; reused-session output still delivers once");

  const foreground = await pi.tools.get("subagent").execute("foreground", { agent: "researcher", task: "foreground" }, undefined, undefined, ctx);
  assert.equal(foreground.details.job.backend, "pi", "compatibility foreground uses the restored session profile");

  await pi.handlers.get("session_shutdown")?.();
});
