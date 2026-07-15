import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredBackendFromEnv,
  normalizeBackend,
  registerNativeSubagents,
  resolveBackendOverride,
} from "../extensions/subagents/index.ts";
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
      async send() {},
      async cancel() {},
      async close() {},
    };
  }
}

function fakePi() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
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
      appendEntry() {},
    } as any,
    handlers,
    tools,
    commands,
  };
}

function context(branch: unknown[] = []) {
  return {
    cwd: process.cwd(),
    mode: "rpc",
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus() {},
      notify() {},
    },
  } as any;
}

test("routing helpers preserve role defaults except for compatibility foreground overrides", () => {
  assert.equal(resolveBackendOverride(undefined, undefined), undefined);
  assert.equal(resolveBackendOverride(undefined, undefined, "claude"), "claude");
  assert.equal(resolveBackendOverride("pi", undefined, "claude"), "pi");
  assert.equal(resolveBackendOverride("pi", "quality", "claude"), undefined);
});

test("legacy backend flags, environment profile, and session profile normalize", () => {
  assert.equal(normalizeBackend("--use-codex"), "codex");
  assert.equal(normalizeBackend("--use-claude"), "claude");
  assert.equal(configuredBackendFromEnv({ PI_SUBAGENTS_PROFILE: "claude" }), "claude");
  assert.equal(configuredBackendFromEnv({ PI_NATIVE_SUBAGENTS_BACKEND: "pi", PI_SUBAGENTS_PROFILE: "claude" }), "pi");
});

test("extension registers once and spawn uses role default while foreground uses legacy session profile", async () => {
  const pi = fakePi();
  const registry = {};
  const backends = [new ImmediateBackend("pi"), new ImmediateBackend("claude"), new ImmediateBackend("codex")];
  registerNativeSubagents(pi.api, { registry, legacyRoot: false, backends });

  assert.deepEqual([...pi.tools.keys()].sort(), [
    "subagent", "subagent_cancel", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait",
  ]);
  assert.deepEqual([...pi.commands.keys()].sort(), ["subagents", "subagents-config"]);
  assert.throws(() => registerNativeSubagents(fakePi().api, { registry, legacyRoot: false, backends }), /loaded more than once/);

  const ctx = context([{ type: "custom", customType: "subagents-profile", data: { profile: "pi" } }]);
  pi.handlers.get("session_start")?.({}, ctx);

  const background = await pi.tools.get("subagent_spawn").execute("spawn", { role: "researcher", task: "background" }, undefined, undefined, ctx);
  assert.equal(background.details.job.backend, "claude", "background spawn must preserve researcher.defaultBackend");

  const foreground = await pi.tools.get("subagent").execute("foreground", { agent: "researcher", task: "foreground" }, undefined, undefined, ctx);
  assert.equal(foreground.details.job.backend, "pi", "compatibility foreground uses the restored session profile");

  await pi.handlers.get("session_shutdown")?.();
});
