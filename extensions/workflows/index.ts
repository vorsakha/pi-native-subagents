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
import { renderWorkflowCall, renderWorkflowCard } from "./render.ts";

const WORKFLOW_MESSAGE = "native-workflow-result";
const MAX_RESULT_TEXT_BYTES = 48 * 1024;

export interface WorkflowRegistration {
  sessionStart(ctx: ExtensionContext, jobs: JobManager): void;
  sessionShutdown(): Promise<void>;
}

export interface RegisterWorkflowOptions {
  roleNames: string[];
  artifactRoot?: string;
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
      ...structuredClone(agent),
      output: undefined,
      transcript: undefined,
      preview: agent.preview?.slice(-500),
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

  const getManager = () => {
    if (!manager) throw new Error("Workflow manager is not available before session_start");
    return manager;
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
    label: "Workflow",
    description: `Run sandboxed JavaScript orchestration over native role-based subagents. Available roles: ${options.roleNames.join(", ") || "none"}. Scripts export a default async function and may call phase(title), agent(prompt,{role,label?,backend?,modelTier?,effort?,phase?,schema?}), and parallel(tasks,{concurrency?}). Optional workflow budgets cap reported tokens, turns, and cost.`,
    promptSnippet: "Run a sandboxed multi-agent workflow with phases and bounded parallelism",
    promptGuidelines: [
      "Use workflow for multi-phase fan-out/fan-in work rather than manually chaining many subagent calls.",
      "Every agent() call must include an explicit role; workflow scripts cannot override role access policies.",
      "Scripts cannot access files, network, environment variables, subprocesses, imports, or credentials; only agent, parallel, phase, and JSON args are available.",
      "Use background=true for independent long work; completion is delivered automatically as a follow-up.",
      "Keep workflow results JSON-serializable and branch explicitly on each agent result's ok field.",
      "Use agent schema for validated JSON output when downstream phases need structure; schema cannot change role permissions.",
      "Use workflow budgets for expensive or open-ended runs; parallel members already running may cause bounded overshoot.",
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.Optional(Type.String({ maxLength: 1_000 })),
      script: Type.String({ minLength: 1, maxLength: 256 * 1024 }),
      args: Type.Optional(Type.String({ maxLength: 128 * 1024, description: "JSON passed to the script as args" })),
      background: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 2 * 60 * 60 * 1_000 })),
      budget: Type.Optional(Type.Object({
        maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
        maxCost: Type.Optional(Type.Number({ minimum: 0 })),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workflows = getManager();
      const depth = Number.parseInt(process.env.PI_NATIVE_SUBAGENTS_DEPTH ?? "0", 10) || 0;
      const request: StartWorkflowRequest = {
        sessionId: sessionId(ctx),
        name: params.name,
        description: params.description,
        script: params.script,
        args: parseArgs(params.args),
        background: params.background ?? false,
        timeoutMs: params.timeoutMs,
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        parentProvider: providerFamily(ctx.model?.provider),
        depth,
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
      }, 300);
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
    renderResult(result, { expanded, isPartial }, theme) {
      const snapshot = (result.details as { workflow?: WorkflowSnapshot } | undefined)?.workflow;
      if (!snapshot) return renderWorkflowCall("Workflow", "result unavailable", false, theme);
      return renderWorkflowCard(snapshot, theme, { expanded, isPartial, expandHint: expandHint(), now: Date.now() });
    },
  });

  pi.registerMessageRenderer(WORKFLOW_MESSAGE, (message, { expanded }, theme) => {
    const snapshot = (message.details as { workflow?: WorkflowSnapshot } | undefined)?.workflow;
    if (!snapshot) return renderWorkflowCall("Workflow", "background result", true, theme);
    return renderWorkflowCard(snapshot, theme, { expanded, expandHint: expandHint(), now: Date.now() });
  });

  pi.registerCommand("workflows", {
    description: "Inspect and cancel persisted workflow runs.",
    handler: async (_args, ctx) => {
      await getManager().initialize();
      await openWorkflowsDashboard(ctx, getManager());
    },
  });

  return {
    sessionStart(ctx, jobs) {
      generation++;
      shuttingDown = false;
      sessionContext = ctx;
      unsubscribe?.();
      manager = new WorkflowManager({ jobs, artifactRoot });
      unsubscribe = manager.subscribe((snapshot) => updateStatus(snapshot));
      void manager.initialize().then(() => updateStatus()).catch((error) => {
        if (ctx.hasUI) ctx.ui.notify(`Workflow history unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    },
    async sessionShutdown() {
      shuttingDown = true;
      generation++;
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
