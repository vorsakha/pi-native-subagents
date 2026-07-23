import { resolve } from "node:path";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JobManager } from "../../src/manager.ts";
import { providerFamily } from "../../src/policy.ts";
import { serializeWorkflowValue } from "../../src/workflows/artifacts.ts";
import {
  WorkflowManager,
  workflowIsTerminal,
  type StartWorkflowRequest,
} from "../../src/workflows/manager.ts";
import type { WorkflowSnapshot } from "../../src/workflows/types.ts";
import { openWorkflowsDashboard } from "./dashboard.ts";
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
    result,
    agents: snapshot.agents.map((agent) => ({
      index: agent.index,
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
      error: agent.error,
      usage: structuredClone(agent.usage),
      output: undefined,
      transcript: undefined,
    })),
  };
}

function resultText(snapshot: WorkflowSnapshot): string {
  const heading = `Workflow ${snapshot.runId} ${snapshot.status}: ${snapshot.name}`;
  const error = snapshot.error ? `\nError: ${snapshot.error}` : "";
  let result = "";
  if (snapshot.result !== undefined) {
    try { result = JSON.stringify(serializeWorkflowValue(snapshot.result, { maxTotalBytes: MAX_RESULT_TEXT_BYTES - 512 }), null, 2); }
    catch { result = String(snapshot.result); }
  }
  const artifact = `\nArtifacts: ${snapshot.artifactDir}`;
  const body = `${heading}${error}${result ? `\n\nResult:\n${result}` : ""}${artifact}`;
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

export function registerWorkflows(pi: ExtensionAPI, options: RegisterWorkflowOptions): WorkflowRegistration {
  const artifactRoot = options.artifactRoot ?? resolve(getAgentDir(), "workflows");
  let manager: WorkflowManager | undefined;
  let unsubscribe: (() => void) | undefined;
  let sessionContext: ExtensionContext | undefined;
  let generation = 0;
  let shuttingDown = false;
  const scheduleBlink = options.setInterval ?? setInterval;
  const cancelBlink = options.clearInterval ?? clearInterval;
  const liveBlinks = new Set<LiveWorkflowBlink>();
  let liveBlinkTicker: ReturnType<typeof setInterval> | undefined;

  const getManager = () => {
    if (!manager) throw new Error("Workflow manager is not available before session_start");
    return manager;
  };
  const stopBlink = (blink: LiveWorkflowBlink) => {
    blink.invalidate = undefined;
    blink.runId = undefined;
    liveBlinks.delete(blink);
    if (!liveBlinks.size && liveBlinkTicker) {
      cancelBlink(liveBlinkTicker);
      liveBlinkTicker = undefined;
    }
  };
  const clearBlinks = () => {
    for (const blink of liveBlinks) {
      blink.invalidate = undefined;
      blink.runId = undefined;
    }
    liveBlinks.clear();
    if (liveBlinkTicker) cancelBlink(liveBlinkTicker);
    liveBlinkTicker = undefined;
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
    if (liveBlinkTicker) return;
    liveBlinkTicker = scheduleBlink(() => {
      for (const current of [...liveBlinks]) {
        if (!current.runId || !workflowIsActive(current.runId)) {
          stopBlink(current);
          continue;
        }
        try { current.invalidate?.(); }
        catch { stopBlink(current); }
      }
    }, 500);
    liveBlinkTicker.unref?.();
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
    const completed = runs.filter((run) => run.status === "completed").length;
    const phase = snapshot?.currentPhase === null || snapshot?.currentPhase === undefined
      ? undefined
      : snapshot.phases[snapshot.currentPhase]?.name;
    if (!active && !completed && !failed) ctx.ui.setStatus("native-workflows", undefined);
    else ctx.ui.setStatus("native-workflows", `workflows${active ? ` ${active}↻` : ""}${completed ? ` ${completed}✓` : ""}${failed ? ` ${failed}×` : ""}${active === 1 && phase ? ` · ${phase}` : ""}`);
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
    description: "Run sandboxed JavaScript orchestration over generic task-driven subagents. Scripts export a default async function and may call phase(title), agent(prompt,{name?,label?,access?,harness?,model?,effort?,independent?,profile?,phase?,schema?}), and parallel(tasks,{concurrency?}). agent(prompt) works without options. Runs are limited to 32 agent calls and four concurrent agents.",
    promptSnippet: "Run a sandboxed multi-agent workflow with phases and bounded parallelism",
    promptGuidelines: [
      "Use workflow for multi-phase fan-out/fan-in work rather than manually chaining many subagent calls.",
      "agent(prompt) is generic and defaults to full access after project trust; set access=readOnly for inspection.",
      "Use independent=true when a review or critique must run on a native provider different from the parent.",
      "Omit profile by default; use a profile only when the human explicitly requests that named profile.",
      "Scripts cannot access files, network, environment variables, subprocesses, imports, or credentials; only agent, parallel, phase, and JSON args are available.",
      "Use background=true for independent long work; completion is delivered automatically as a follow-up.",
      "Keep workflow results JSON-serializable and branch explicitly on each agent result's ok field.",
      "Use agent schema for validated JSON output when downstream phases need structure; schema cannot change access policy.",
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.Optional(Type.String({ maxLength: 1_000 })),
      script: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
      args: Type.Optional(Type.String({ maxLength: 256 * 1024, description: "JSON passed to the script as args" })),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workflows = getManager();
      const request: StartWorkflowRequest = {
        sessionId: sessionId(ctx),
        name: params.name,
        description: params.description,
        script: params.script,
        args: parseArgs(params.args),
        background: params.background ?? false,
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        parentProvider: providerFamily(ctx.model?.provider),
        defaultHarness: options.defaultHarness?.() ?? "pi",
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
    description: "Inspect and cancel persisted workflow runs.",
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Workflow history is unavailable for untrusted projects.", "error");
        return;
      }
      await getManager().initialize();
      await openWorkflowsDashboard(ctx, getManager());
    },
  });

  return {
    sessionStart(ctx, jobs) {
      generation++;
      shuttingDown = false;
      clearBlinks();
      sessionContext = ctx;
      unsubscribe?.();
      manager = new WorkflowManager({ jobs, artifactRoot, sessionId: ctx.sessionManager.getSessionId() });
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
