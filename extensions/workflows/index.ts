import { resolve } from "node:path";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapabilityRouter } from "../../src/capability-service.ts";
import type { ProfileDefinition } from "../../src/types.ts";
import { Type } from "typebox";
import type { JobManager } from "../../src/manager.ts";
import { providerFamily } from "../../src/policy.ts";
import { serializeWorkflowValue } from "../../src/workflows/artifacts.ts";
import { loadSavedWorkflow, loadWorkflowScriptPath } from "../../src/workflows/saved.ts";
import {
  WorkflowManager,
  workflowIsTerminal,
  type StartWorkflowRequest,
} from "../../src/workflows/manager.ts";
import type { WorkflowProtectedWorktree } from "../../src/workflows/retention.ts";
import type { WorkflowSnapshot } from "../../src/workflows/types.ts";
import { workflowTaskOutcome } from "../../src/workflows/outcome.ts";
import { openWorkflowsDashboard } from "./dashboard.ts";
import { sanitizeInline, shortId } from "../subagents/render.ts";
import { renderWorkflowCall, renderWorkflowCard, renderWorkflowFailure } from "./render.ts";

const WORKFLOW_MESSAGE = "native-workflow-result";
const MAX_RESULT_TEXT_BYTES = 48 * 1024;

export interface WorkflowRegistration {
  sessionStart(ctx: ExtensionContext, jobs: JobManager): void;
  sessionShutdown(): Promise<void>;
}

export interface RegisterWorkflowOptions {
  artifactRoot?: string;
  defaultHarness?: () => "pi" | "claude" | "codex";
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  savedWorkflowRoot?: string;
  router?: CapabilityRouter;
  resolveProfile?: (name: string) => ProfileDefinition | undefined;
}

interface LiveWorkflowBlink {
  runId?: string;
  invalidate?: () => void;
}

interface LiveWorkflowRenderContext {
  state: {
    nativeWorkflowBlink?: LiveWorkflowBlink;
    nativeWorkflowSnapshot?: WorkflowSnapshot;
  };
  invalidate(): void;
}

function expandHint(): string {
  try { return keyHint("app.tools.expand", "to expand"); }
  catch { return "to expand"; }
}

function compactSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const serializedResult = serializeWorkflowValue(snapshot.result, { maxTotalBytes: 64 * 1024, maxStringBytes: 24 * 1024 });
  const result = serializedResult === undefined ? undefined : JSON.parse(JSON.stringify(serializedResult));
  return {
    ...structuredClone(snapshot),
    taskOutcome: snapshot.taskOutcome ?? (snapshot.status === "completed" ? workflowTaskOutcome(snapshot.result) : undefined),
    result,
    agents: snapshot.agents.map((agent) => ({
      index: agent.index,
      callIndex: agent.callIndex,
      generations: agent.generations?.map((generation) => ({
        index: generation.index,
        callIndex: generation.callIndex,
        state: generation.state,
        error: generation.error,
        outputProvenance: generation.outputProvenance,
        structuredTransport: generation.structuredTransport,
        timestamps: structuredClone(generation.timestamps),
      })),
      replayedFrom: agent.replayedFrom ? structuredClone(agent.replayedFrom) : undefined,
      outputProvenance: agent.outputProvenance,
      instructionShaped: agent.instructionShaped,
      isolation: agent.isolation ? structuredClone(agent.isolation) : undefined,
      name: agent.name,
      access: agent.access,
      profile: agent.profile,
      independent: agent.independent,
      phase: agent.phase,
      jobId: agent.jobId,
      state: agent.state,
      timestamps: structuredClone(agent.timestamps),
      harness: agent.harness,
      model: agent.model,
      effort: agent.effort,
      preview: agent.preview?.slice(-500),
      structured: agent.structured === undefined ? undefined : structuredClone(agent.structured),
      structuredTransport: agent.structuredTransport,
      error: agent.error,
      usage: structuredClone(agent.usage),
      output: undefined,
      transcript: undefined,
    })),
  };
}

function failedCallText(snapshot: WorkflowSnapshot): string {
  const failed = snapshot.agents.filter((agent) =>
    agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted" || agent.error,
  ).slice(-4);
  if (!failed.length) return "";
  const lines = failed.map((agent) => {
    const call = agent.callIndex ?? agent.index;
    const route = `${agent.harness ?? "?"}/${agent.model ?? "?"}`;
    const job = agent.jobId ? ` · job ${shortId(agent.jobId)}` : "";
    const reason = sanitizeInline(agent.error ?? "no reason recorded").slice(0, 2_000);
    return `- call ${call} · ${sanitizeInline(agent.name)} · ${agent.state} · ${route}${job} · ${reason}`;
  });
  return `\nFailed calls:\n${lines.join("\n")}`;
}

function resultText(snapshot: WorkflowSnapshot): string {
  const outcome = snapshot.taskOutcome ? ` · task ${snapshot.taskOutcome}` : "";
  const heading = `Workflow ${snapshot.runId} ${snapshot.status}${outcome}: ${snapshot.name}`;
  const error = snapshot.error ? `\nError: ${sanitizeInline(snapshot.error)}` : "";
  let result = "";
  if (snapshot.result !== undefined) {
    try { result = JSON.stringify(serializeWorkflowValue(snapshot.result, { maxTotalBytes: MAX_RESULT_TEXT_BYTES - 512 }), null, 2); }
    catch { result = String(snapshot.result); }
  }
  const warnings = snapshot.warnings ?? [];
  const reached = warnings.filter((warning) => warning.startsWith("Workflow budget ") && warning.includes(" limit reached"));
  const advisory = warnings.filter((warning) => !reached.includes(warning)).slice(-3);
  const shownWarnings = [...reached, ...advisory];
  const warningText = shownWarnings.length ? `\nWarnings:\n${shownWarnings.map((warning) => `- ${sanitizeInline(warning)}`).join("\n")}` : "";
  const body = `${heading}${error}${warningText}${failedCallText(snapshot)}${result ? `\n\nResult:\n${result}` : ""}\nInspect private artifacts with /workflows.`;
  const buffer = Buffer.from(body);
  if (buffer.byteLength <= MAX_RESULT_TEXT_BYTES) return body;
  return `${buffer.subarray(0, MAX_RESULT_TEXT_BYTES - 64).toString("utf8")}\n[workflow result truncated — inspect /workflows]`;
}

function parseArgs(value: string | undefined): unknown {
  if (value === undefined || !value.trim()) return null;
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`Workflow args must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function sessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as { getSessionId?: () => string };
  return manager.getSessionId?.() ?? "session-unknown";
}

const MAX_PROTECTED_WORKTREE_LINES = 64;

function formatProtectedWorktree(entry: WorkflowProtectedWorktree): string {
  const patch = entry.patchArtifact ? `patch ${sanitizeInline(entry.patchArtifact)}` : "no patch";
  const git = entry.git
    ? ` · registered ${entry.git.registered ? "yes" : "no"} · branch-ref ${entry.git.branchExists ? "yes" : "no"} · checkout ${entry.git.checkoutPresent ? "yes" : "no"}`
    : "";
  const unrecorded = entry.unrecorded ? " · unrecorded" : "";
  const error = entry.error ? ` · ${sanitizeInline(entry.error).slice(0, 200)}` : "";
  return `${entry.runId} · agent ${entry.agentIndex} · ${entry.state}${unrecorded} · branch ${sanitizeInline(entry.branch)} · ${entry.worktreePath} · ${patch}${git}${error}`;
}

async function reportProtectedWorktrees(ctx: ExtensionContext, workflows: WorkflowManager): Promise<void> {
  let worktrees: WorkflowProtectedWorktree[];
  try {
    worktrees = await workflows.listProtectedWorktrees({ cwd: ctx.cwd });
  } catch (error) {
    ctx.ui.notify(`Could not inspect protected worktrees: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (!worktrees.length) {
    ctx.ui.notify("No protected worktrees; every isolated worktree either finished cleanly or was reclaimed.", "info");
    return;
  }
  const shown = worktrees.slice(0, MAX_PROTECTED_WORKTREE_LINES).map(formatProtectedWorktree);
  const overflow = worktrees.length > MAX_PROTECTED_WORKTREE_LINES ? [`… ${worktrees.length - MAX_PROTECTED_WORKTREE_LINES} more`] : [];
  ctx.ui.notify([
    `${worktrees.length} protected worktree${worktrees.length === 1 ? "" : "s"}:`,
    ...shown,
    ...overflow,
    "",
    "Usage: /workflows reclaim <runId> <agentIndex> [--force]",
  ].join("\n"), "warning");
}

async function reclaimProtectedWorktree(rest: string, ctx: ExtensionContext, workflows: WorkflowManager): Promise<void> {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const [runId, agentIndexRaw, ...flags] = parts;
  const force = flags.includes("--force");
  if (!runId || !agentIndexRaw || !/^wf_[a-f0-9]+$/.test(runId) || !/^\d+$/.test(agentIndexRaw)) {
    ctx.ui.notify("Usage: /workflows reclaim <runId> <agentIndex> [--force]", "warning");
    return;
  }
  const agentIndex = Number(agentIndexRaw);
  if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
    ctx.ui.notify("Reclaiming a worktree requires host confirmation, which is unavailable in this context.", "warning");
    return;
  }
  let worktree: WorkflowProtectedWorktree | undefined;
  try {
    const worktrees = await workflows.listProtectedWorktrees({ cwd: ctx.cwd });
    worktree = worktrees.find((candidate) => candidate.runId === runId && candidate.agentIndex === agentIndex);
  } catch (error) {
    ctx.ui.notify(`Could not inspect protected worktrees: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (!worktree) {
    ctx.ui.notify(`No protected worktree for ${runId} agent ${agentIndex}.`, "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Reclaim isolated worktree?",
    `${formatProtectedWorktree(worktree)}\n\nThis removes the Git worktree registration and its branch.${force ? " --force discards a checkout with no patch artifact." : ""}`,
    { timeout: 60_000 },
  );
  if (!confirmed) {
    ctx.ui.notify("Reclamation cancelled.", "info");
    return;
  }
  try {
    const result = await workflows.reclaimWorktree({ runId, agentIndex, cwd: ctx.cwd, confirmed: true, force });
    const lines = [
      `Reclaimed ${runId} agent ${agentIndex}: registration ${result.reclamation.removedRegistration ? "removed" : "unchanged"}, checkout ${result.reclamation.removedCheckout ? "removed" : "unchanged"}, branch ${result.reclamation.deletedBranch ? "deleted" : "unchanged"}.`,
      ...result.reclamation.warnings.map((warning) => `Warning: ${sanitizeInline(warning)}`),
    ];
    ctx.ui.notify(lines.join("\n"), result.reclamation.warnings.length ? "warning" : "info");
  } catch (error) {
    ctx.ui.notify(`Reclamation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export function registerWorkflows(pi: ExtensionAPI, options: RegisterWorkflowOptions): WorkflowRegistration {
  const artifactRoot = options.artifactRoot ?? resolve(getAgentDir(), "workflows");
  const savedWorkflowRoot = options.savedWorkflowRoot ?? resolve(getAgentDir(), "workflow-definitions");
  let manager: WorkflowManager | undefined;
  let unsubscribe: (() => void) | undefined;
  let sessionContext: ExtensionContext | undefined;
  let generation = 0;
  let shuttingDown = false;
  const liveBlinks = new Set<LiveWorkflowBlink>();

  const getManager = () => {
    if (!manager) throw new Error("Workflow manager is not available before session_start");
    return manager;
  };
  const stopBlink = (blink: LiveWorkflowBlink) => {
    blink.invalidate = undefined;
    blink.runId = undefined;
    liveBlinks.delete(blink);
  };
  const clearBlinks = () => {
    for (const blink of liveBlinks) {
      blink.invalidate = undefined;
      blink.runId = undefined;
    }
    liveBlinks.clear();
  };
  const workflowIsActive = (runId: string): boolean => {
    if (!manager) return false;
    try { return !workflowIsTerminal(manager.check(runId).status); }
    catch { return false; }
  };
  const syncBlink = (context: LiveWorkflowRenderContext | undefined, runId: string, active: boolean) => {
    if (!context?.state) return;
    const blink = context.state.nativeWorkflowBlink ??= {};
    if (!active) return stopBlink(blink);
    blink.runId = runId;
    blink.invalidate = context.invalidate;
    liveBlinks.add(blink);
  };
  const refreshBlinks = () => {
    for (const blink of [...liveBlinks]) {
      if (!blink.runId || !workflowIsActive(blink.runId)) {
        stopBlink(blink);
        continue;
      }
      try { blink.invalidate?.(); }
      catch { stopBlink(blink); }
    }
  };
  const liveSnapshot = (fallback: WorkflowSnapshot, context?: LiveWorkflowRenderContext): WorkflowSnapshot => {
    let snapshot = context?.state.nativeWorkflowSnapshot ?? fallback;
    let tracked = false;
    if (manager) {
      try {
        snapshot = compactSnapshot(manager.check(fallback.runId));
        tracked = true;
      } catch { /* durable transcript snapshot survives history eviction */ }
    }
    if (context?.state) context.state.nativeWorkflowSnapshot = snapshot;
    syncBlink(context, fallback.runId, tracked && !workflowIsTerminal(snapshot.status));
    return snapshot;
  };

  const updateStatus = (snapshot?: WorkflowSnapshot) => {
    const ctx = sessionContext;
    if (!ctx?.hasUI) return;
    const runs = manager?.list() ?? [];
    const active = runs.filter((run) => !workflowIsTerminal(run.status)).length;
    const failed = runs.filter((run) => run.status === "failed" || run.status === "aborted").length;
    const successful = runs.filter((run) => run.status === "completed" && run.taskOutcome === "successful").length;
    const unsuccessful = runs.filter((run) => run.status === "completed" && run.taskOutcome === "unsuccessful").length;
    const completed = runs.filter((run) => run.status === "completed" && run.taskOutcome !== "successful" && run.taskOutcome !== "unsuccessful").length;
    const phase = snapshot?.currentPhase === null || snapshot?.currentPhase === undefined
      ? undefined
      : snapshot.phases[snapshot.currentPhase]?.name;
    if (!active && !successful && !unsuccessful && !completed && !failed) ctx.ui.setStatus("native-workflows", undefined);
    else ctx.ui.setStatus("native-workflows", `workflows${active ? ` ${active}↻` : ""}${successful ? ` ${successful}✓` : ""}${unsuccessful ? ` ${unsuccessful}!` : ""}${completed ? ` ${completed}○` : ""}${failed ? ` ${failed}×` : ""}${active === 1 && phase ? ` · ${phase}` : ""}`);
  };

  const deliverBackgroundResult = (snapshot: WorkflowSnapshot, runGeneration: number) => {
    if (shuttingDown || runGeneration !== generation) return;
    try {
      pi.sendMessage({
        customType: WORKFLOW_MESSAGE,
        content: resultText(snapshot),
        display: true,
        details: { workflow: compactSnapshot(snapshot) },
      }, { deliverAs: "followUp", triggerTurn: true });
    } catch {
      // Parent session may already be shutting down; artifacts remain durable.
    }
  };

  pi.registerTool({
    name: "workflow",
    renderShell: "self",
    label: "Workflow",
    description: "Run sandboxed JavaScript orchestration over generic task-driven subagents. Export a default async function and use the injected globals phase(), log(), agent(), followUp(), parallel(), and pipeline(); parallel receives deferred task functions, not already-started promises. Use exactly one source (script, workflowName, or scriptPath) and one input form (input or legacy args). isolation='worktree' runs a mutating agent in a clean Git worktree and preserves changed work with a patch. Runs are limited to 32 agent calls and four concurrent agents; resumeFromRunId replays matching completed calls from an exact interrupted run, including independent later parallel lanes.",
    promptSnippet: "Run a sandboxed multi-agent workflow with phases and bounded parallelism",
    promptGuidelines: [
      "Use workflow for multi-phase fan-out/fan-in work rather than manually chaining many subagent calls; use direct spawning for a small simple fan-out.",
      "Workflow scripts export a default async function; helpers are globals: use phase(), log(), agent(), followUp(), parallel(), and pipeline(). Do not destructure a callback context object.",
      "When phases are known up front, declare meta.phases and call phase(title) to activate them in order; omit it for dynamic discovery.",
      "Use parallel only with deferred functions such as () => agent(...); never pass already-started agent promises.",
      "Use exactly one source (script, workflowName, or scriptPath) and exactly one input form (input or legacy args).",
      "agent(prompt) is generic and defaults to full access after project trust; set access=readOnly for inspection.",
      "Use independent=true only for a different native provider; use independentOf=<jobId> to review with a provider different from the producer.",
      "Omit profile by default; use a profile only when the human explicitly requests that named profile.",
      "Scripts cannot access files, network, environment variables, subprocesses, imports, or credentials; only agent, followUp, parallel, pipeline, phase, log, and JSON args are available.",
      "Use background=true for independent long work; completion is delivered automatically as a follow-up.",
      "Keep workflow results JSON-serializable and branch explicitly on each agent result's ok field.",
      "Use pipeline for independent multi-stage item processing; use parallel only when the next step needs a barrier across all results.",
      "Read-only workflow agents can run concurrently; mutating agents sharing the checkout are serialized unless each uses isolation='worktree'.",
      "maxTurns is aggregate native-provider turns across all workflow agents; size it for the full fan-out rather than per-agent turns.",
      "Use log for concise progress updates that are useful without opening an agent transcript.",
      "Set resumeFromRunId only to replay an interrupted run with the exact same script, input, project, and routing context.",
      "Use approval=plan for read-only planning or approval=onMutate to require a host confirmation before mutation.",
      "Use workflowName for a saved user/project workflow or scriptPath for a trusted project-local script; provide exactly one script source.",
      "Use agent schema for validated JSON output when downstream phases need structure; schema cannot change access policy.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      description: Type.Optional(Type.String({ maxLength: 1_000 })),
      script: Type.Optional(Type.String({ minLength: 1, maxLength: 512 * 1024 })),
      workflowName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      scriptPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      args: Type.Optional(Type.String({ maxLength: 256 * 1024, description: "Legacy JSON string passed to the script as args" })),
      input: Type.Optional(Type.Unknown({ description: "Structured JSON value exposed to the script as args; do not combine with legacy args" })),
      resumeFromRunId: Type.Optional(Type.String({ pattern: "^wf_[a-f0-9]+$", description: "Terminal run whose matching completed calls should be replayed" })),
      approval: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("plan"), Type.Literal("onMutate")])),
      budget: Type.Optional(Type.Object({
        maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "Maximum child agent calls in this workflow" })),
        maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Maximum concurrently running child agents" })),
        maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000_000, description: "Aggregate fresh input plus output token budget across workflow agents" })),
        maxTokensPerAgent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000_000, description: "Fresh input plus output ceiling for any single workflow agent" })),
        maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_000, description: "Aggregate cost budget across workflow agents" })),
        maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "Aggregate native-provider turns across all workflow agents; not a per-agent allowance" })),
      })),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workflows = getManager();
      if (params.args !== undefined && params.input !== undefined) {
        throw new Error("Workflow accepts either structured input or legacy JSON args, not both");
      }
      const sources = [params.script !== undefined, params.workflowName !== undefined, params.scriptPath !== undefined].filter(Boolean).length;
      if (sources !== 1) throw new Error("Workflow requires exactly one of script, workflowName, or scriptPath");
      let script = params.script;
      let sourceName: string | undefined;
      if (params.workflowName !== undefined) {
        const saved = await loadSavedWorkflow({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), globalRoot: savedWorkflowRoot, name: params.workflowName });
        script = saved.script;
        sourceName = saved.definition.name;
      } else if (params.scriptPath !== undefined) {
        const loaded = await loadWorkflowScriptPath({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), scriptPath: params.scriptPath });
        script = loaded.script;
        sourceName = params.scriptPath.split(/[\\/]/).at(-1)?.replace(/\.(?:m?js)$/i, "");
      }
      if (script === undefined) throw new Error("Workflow script could not be resolved");
      const request: StartWorkflowRequest = {
        sessionId: sessionId(ctx),
        name: params.name ?? sourceName ?? "workflow",
        description: params.description,
        script,
        args: params.input !== undefined ? params.input : parseArgs(params.args),
        background: params.background ?? false,
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        parentProvider: providerFamily(ctx.model?.provider),
        defaultHarness: options.defaultHarness?.() ?? "pi",
        resumeFromRunId: params.resumeFromRunId,
        approval: params.approval,
        budget: params.budget,
      };
      const started = await workflows.start(request);
      const runGeneration = generation;
      if (request.background) {
        void started.completion.then(
          (final) => deliverBackgroundResult(final, runGeneration),
          (error) => deliverBackgroundResult({
            ...started.snapshot,
            status: "failed",
            error: `Workflow lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
            timestamps: { ...started.snapshot.timestamps, updatedAt: Date.now(), endedAt: Date.now() },
          }, runGeneration),
        );
        return {
          content: [{ type: "text" as const, text: `Workflow started: ${started.snapshot.runId} (${started.snapshot.name}). Inspect with /workflows.` }],
          details: { workflow: compactSnapshot(started.snapshot) },
        };
      }

      const abort = () => { void workflows.cancel(started.snapshot.runId, "Parent workflow tool aborted").catch(() => undefined); };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const timer = setInterval(() => {
        try {
          const current = compactSnapshot(workflows.check(started.snapshot.runId));
          onUpdate?.({ content: [{ type: "text", text: `Workflow ${current.runId} ${current.status}` }], details: { workflow: current } });
        } catch { /* run may be settling */ }
      }, 500);
      timer.unref();
      try {
        const final = await started.completion;
        return {
          content: [{ type: "text" as const, text: resultText(final) }],
          details: { workflow: compactSnapshot(final) },
        };
      } finally {
        clearInterval(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    renderCall(args, theme) {
      return renderWorkflowCall(args.name ?? "Workflow", args.description ?? "", args.background ?? false, theme);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const fallback = (result.details as { workflow?: WorkflowSnapshot } | undefined)?.workflow;
      if (!fallback) return renderWorkflowFailure("workflow result unavailable", theme);
      const snapshot = liveSnapshot(fallback, context as LiveWorkflowRenderContext | undefined);
      return renderWorkflowCard(snapshot, theme, {
        expanded,
        isPartial: isPartial || !workflowIsTerminal(snapshot.status),
        expandHint: expandHint(),
        now: Date.now(),
      });
    },
  });

  pi.registerMessageRenderer(WORKFLOW_MESSAGE, (message, { expanded }, theme) => {
    const snapshot = (message.details as { workflow?: WorkflowSnapshot } | undefined)?.workflow;
    if (!snapshot) return renderWorkflowCall("Workflow", "background result", true, theme);
    return renderWorkflowCard(snapshot, theme, { expanded, expandHint: expandHint(), standalone: true, now: Date.now() });
  });

  pi.registerCommand("workflows", {
    description: "Inspect, pause, resume, restart, or cancel workflow runs. `worktrees` lists protected isolated worktrees; `reclaim <runId> <agentIndex> [--force]` reclaims one.",
    getArgumentCompletions: (prefix) => ["worktrees", "reclaim"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Workflow history is unavailable for untrusted projects.", "error");
        return;
      }
      await getManager().initialize();
      const trimmed = args.trim();
      if (!trimmed) {
        await openWorkflowsDashboard(ctx, getManager());
        return;
      }
      if (trimmed === "worktrees") {
        await reportProtectedWorktrees(ctx, getManager());
        return;
      }
      if (trimmed === "reclaim" || trimmed.startsWith("reclaim ")) {
        await reclaimProtectedWorktree(trimmed.slice("reclaim".length), ctx, getManager());
        return;
      }
      ctx.ui.notify("Usage: /workflows [worktrees|reclaim <runId> <agentIndex> [--force]]", "warning");
    },
  });

  return {
    sessionStart(ctx, jobs) {
      generation++;
      shuttingDown = false;
      clearBlinks();
      sessionContext = ctx;
      unsubscribe?.();
      manager = new WorkflowManager({
        jobs,
        artifactRoot,
        sessionId: ctx.sessionManager.getSessionId(),
        router: options.router,
        resolveProfile: options.resolveProfile,
        approveMutation: async ({ workflow, agent, prompt, signal }) => {
          if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") return false;
          return ctx.ui.confirm(
            `Allow workflow mutation?`,
            `${workflow} · ${agent}\n\n${prompt}`,
            { timeout: 60_000, signal },
          );
        },
      });
      unsubscribe = manager.subscribe((snapshot) => {
        updateStatus(snapshot);
        refreshBlinks();
      });
      void manager.initialize().then(() => updateStatus()).catch((error) => {
        if (ctx.hasUI) ctx.ui.notify(`Workflow history unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    },
    async sessionShutdown() {
      shuttingDown = true;
      generation++;
      clearBlinks();
      unsubscribe?.();
      unsubscribe = undefined;
      const closing = manager;
      manager = undefined;
      await closing?.shutdown();
      if (sessionContext?.hasUI) sessionContext.ui.setStatus("native-workflows", undefined);
      sessionContext = undefined;
    },
  };
}
