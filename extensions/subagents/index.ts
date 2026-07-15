import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ClaudeBackend, CodexAppServerBackend, PiRpcBackend } from "../../src/backends/index.ts";
import { isTerminal, JobManager } from "../../src/manager.ts";
import { claimExtensionInstall } from "../../src/install-guard.ts";
import { openSubagentsDashboard } from "./dashboard.ts";
import { loadRoles, parseAllowedRoles } from "../../src/roles.ts";
import type { Backend, BackendName, JobSnapshot, ModelTier, SendBehavior } from "../../src/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = resolve(ROOT, "agents");
const STATE_ENTRY = "native-subagents-profile";
const LEGACY_STATE_ENTRY = "subagents-profile";
const BACKENDS = ["codex", "claude", "pi"] as const;
const TIERS = ["economy", "balanced", "quality"] as const;

interface RegistrationOptions {
  registry?: object;
  legacyRoot?: string | false;
  backends?: Backend[];
}

export default function nativeSubagents(pi: ExtensionAPI): void {
  registerNativeSubagents(pi);
}

export function registerNativeSubagents(pi: ExtensionAPI, options: RegistrationOptions = {}): void {
  const legacyRoot = options.legacyRoot === false
    ? undefined
    : options.legacyRoot ?? resolve(homedir(), ".pi/agent/extensions/subagents");
  const releaseInstall = claimExtensionInstall(ROOT, options.registry ?? globalThis, legacyRoot);
  const roles = loadRoles(AGENTS_DIR, parseAllowedRoles(process.env));
  const roleNames = [...roles.keys()];
  const roleSchema = roleNames.length > 0
    ? StringEnum(roleNames as [string, ...string[]])
    : Type.String();
  const configuredBackend = configuredBackendFromEnv(process.env);
  let activeBackend = configuredBackend;
  let manager: JobManager | undefined;
  let unsubscribeManager: (() => void) | undefined;

  const createManager = () => new JobManager({
    roles,
    concurrency: 4,
    maxDepth: 2,
    backends: options.backends ?? [new PiRpcBackend(), new ClaudeBackend(), new CodexAppServerBackend()],
  });
  const getManager = () => manager ??= createManager();

  pi.on("session_start", (_event, ctx) => {
    manager = createManager();
    activeBackend = configuredBackend;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data as { backend?: unknown; profile?: unknown } | undefined;
      const restored = entry.customType === STATE_ENTRY
        ? normalizeBackend(data?.backend)
        : entry.customType === LEGACY_STATE_ENTRY
          ? normalizeBackend(data?.profile)
          : undefined;
      if (restored) activeBackend = restored;
    }
    const sessionManager = manager;
    unsubscribeManager = sessionManager.subscribe((job, event) => {
      updateStatus(ctx, sessionManager, activeBackend);
      if (event.type === "completed" || event.type === "failed" || (event.type === "cancelled" && event.reason !== "Session shutdown")) {
        const level = event.type === "failed" ? "error" : event.type === "cancelled" ? "warning" : "info";
        ctx.ui.notify(`Subagent ${job.role} ${job.status} · ${job.id.slice(0, 8)}`, level);
      }
    });
    updateStatus(ctx, sessionManager, activeBackend);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeManager?.();
    unsubscribeManager = undefined;
    try { await manager?.shutdown(); }
    finally {
      manager = undefined;
      releaseInstall();
    }
  });

  const configure = async (args: string, ctx: ExtensionCommandContext) => {
    const value = args.trim().toLowerCase();
    const selected = normalizeBackend(value);
    if (selected) {
      activeBackend = selected;
      pi.appendEntry(STATE_ENTRY, { backend: selected });
      updateStatus(ctx, getManager(), activeBackend);
      ctx.ui.notify(`Default subagent backend: ${selected}`, "info");
    } else if (value === "status") {
      ctx.ui.notify(`Default backend: ${activeBackend}\nRoles: ${roleNames.join(", ") || "none"}`, "info");
    } else {
      ctx.ui.notify("Usage: /subagents [status|codex|claude|pi|--use-codex|--use-claude] or /subagents-config <backend>", "warning");
    }
  };

  pi.registerCommand("subagents", {
    description: "Open the subagent dashboard; status/backend arguments retain configuration behavior.",
    getArgumentCompletions: (prefix) => ["status", ...BACKENDS, "--use-codex", "--use-claude"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (args.trim()) await configure(args, ctx);
      else await openSubagentsDashboard(ctx, getManager());
    },
  });

  pi.registerCommand("subagents-config", {
    description: "Show or switch the default native subagent backend.",
    getArgumentCompletions: (prefix) => ["status", ...BACKENDS].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: configure,
  });

  const spawnParameters = Type.Object({
    role: roleSchema,
    task: Type.String({ minLength: 1, maxLength: 100_000 }),
    cwd: Type.Optional(Type.String()),
    backend: Type.Optional(StringEnum(BACKENDS)),
    modelTier: Type.Optional(StringEnum(TIERS)),
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: `Spawn a native background subagent. Roles: ${roleNames.join(", ") || "none"}. Maximum four jobs run concurrently.`,
    promptSnippet: "Spawn a native Pi, Claude Code, or Codex subagent in the background",
    parameters: spawnParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = spawn(getManager(), params, ctx.cwd, ctx.isProjectTrusted());
      return result(snapshot, `Spawned ${snapshot.id} (${snapshot.role}, ${snapshot.backend}/${snapshot.model})`);
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: "Check one background subagent without waiting.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const snapshot = getManager().check(params.jobId);
      return result(snapshot, statusLine(snapshot));
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait for a background subagent to finish, or return its current state after a timeout.",
    parameters: Type.Object({
      jobId: Type.String(),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
    }),
    async execute(_id, params, signal) {
      const snapshot = await getManager().wait(params.jobId, { timeoutMs: params.timeoutMs ?? 600_000, signal });
      return result(snapshot, terminalText(snapshot));
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: "Steer an active subagent now or queue a follow-up on its native session.",
    parameters: Type.Object({
      jobId: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 100_000 }),
      behavior: Type.Optional(StringEnum(["steer", "followUp"] as const)),
    }),
    async execute(_id, params) {
      const snapshot = await getManager().send(params.jobId, params.message, (params.behavior ?? "steer") as SendBehavior);
      return result(snapshot, `Sent ${params.behavior ?? "steer"} message to ${snapshot.id}`);
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagent",
    description: "Cancel a queued or running background subagent and tear down its process tree.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const snapshot = await getManager().cancel(params.jobId);
      return result(snapshot, statusLine(snapshot));
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all jobs scoped to the current Pi session.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = getManager().list();
      const text = jobs.length ? jobs.map(statusLine).join("\n") : "No subagent jobs in this session.";
      return { content: [{ type: "text", text }], details: { jobs } };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Compatibility foreground subagent call. Runs one role and waits for completion. Default backend: ${activeBackend}.`,
    promptSnippet: `Run an isolated subagent: ${roleNames.join(", ") || "none"}`,
    promptGuidelines: [
      "Use subagent_spawn for independent work that can run in parallel; use subagent_wait before consuming its result.",
      "Use subagent for a single compatibility foreground delegation.",
      "Subagents have isolated context; include all required paths, requirements, constraints, and verification evidence in task.",
    ],
    parameters: Type.Object({
      agent: roleSchema,
      task: Type.String({ minLength: 1, maxLength: 100_000 }),
      cwd: Type.Optional(Type.String()),
      backend: Type.Optional(StringEnum(BACKENDS)),
      modelProfile: Type.Optional(StringEnum(BACKENDS)),
      modelTier: Type.Optional(StringEnum(TIERS)),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const snapshot = spawn(getManager(), {
        role: params.agent, task: params.task, cwd: params.cwd,
        backend: params.backend ?? params.modelProfile, modelTier: params.modelTier,
      }, ctx.cwd, ctx.isProjectTrusted(), activeBackend);
      const timer = setInterval(() => {
        const current = getManager().check(snapshot.id);
        onUpdate?.({ content: [{ type: "text", text: statusLine(current) }], details: { job: current } });
      }, 500);
      timer.unref();
      try {
        const final = await getManager().wait(snapshot.id, { signal });
        if (!isTerminal(final.status)) throw new Error("Subagent wait ended before completion");
        if (final.status === "failed") throw new Error(final.error ?? "Subagent failed");
        return result(final, terminalText(final));
      } catch (error) {
        if (signal?.aborted) await getManager().cancel(snapshot.id, "Parent tool aborted");
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  });
}

function spawn(
  manager: JobManager,
  params: { role: string; task: string; cwd?: string; backend?: BackendName; modelTier?: ModelTier },
  parentCwd: string,
  trusted: boolean,
  compatibilityBackend?: BackendName,
): JobSnapshot {
  const cwd = secureCwd(parentCwd, params.cwd);
  const depth = Number.parseInt(process.env.PI_NATIVE_SUBAGENTS_DEPTH ?? "0", 10) || 0;
  return manager.spawn({
    role: params.role,
    task: params.task,
    cwd,
    trusted,
    backend: resolveBackendOverride(params.backend, params.modelTier, compatibilityBackend),
    tier: params.modelTier,
    depth,
  });
}

function secureCwd(parentCwd: string, requested?: string): string {
  const root = realpathSync(parentCwd);
  const candidatePath = resolve(root, requested ?? ".");
  if (!existsSync(candidatePath)) throw new Error(`Subagent cwd does not exist: ${candidatePath}`);
  const candidate = realpathSync(candidatePath);
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Subagent cwd must stay within the trusted project directory");
  }
  return candidate;
}

export function configuredBackendFromEnv(env: NodeJS.ProcessEnv): BackendName {
  return normalizeBackend(env.PI_NATIVE_SUBAGENTS_BACKEND)
    ?? normalizeBackend(env.PI_SUBAGENTS_PROFILE)
    ?? "codex";
}

export function resolveBackendOverride(
  requested: BackendName | undefined,
  tier: ModelTier | undefined,
  compatibilityBackend?: BackendName,
): BackendName | undefined {
  return tier ? undefined : requested ?? compatibilityBackend;
}

export function normalizeBackend(value: unknown): BackendName | undefined {
  const text = String(value ?? "").trim().toLowerCase().replace(/^--use-/, "");
  if (text === "codex" || text === "openai" || text === "gpt") return "codex";
  if (text === "claude" || text === "anthropic") return "claude";
  if (text === "pi") return "pi";
  return undefined;
}

function updateStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }, manager: JobManager, backend: BackendName): void {
  const jobs = manager.list();
  const running = jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const finished = jobs.filter((job) => isTerminal(job.status)).length;
  ctx.ui.setStatus("native-subagents", `subagents:${backend}${running ? ` ${running}↻` : ""}${finished ? ` ${finished}✓` : ""}`);
}

function statusLine(job: JobSnapshot): string {
  return `${job.id} ${job.status} ${job.role} [${job.backend}/${job.model}]`;
}
function terminalText(job: JobSnapshot): string {
  if (job.status === "completed") return job.output || "(completed with no text output)";
  if (job.status === "failed" || job.status === "cancelled") return `${statusLine(job)}\n${job.error ?? ""}`.trim();
  return statusLine(job);
}
function result(job: JobSnapshot, text: string) {
  return { content: [{ type: "text" as const, text }], details: { job } };
}
