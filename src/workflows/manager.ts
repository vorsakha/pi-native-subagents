import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { isRequestedHarness, routeCapabilities, type RequestedHarness } from "../capability-routing.ts";
import type { CapabilityRouter } from "../capability-service.ts";
import type { JobManager } from "../manager.ts";
import { isTerminal } from "../manager.ts";
import { normalizeModel } from "../policy.ts";
import type { AccessMode, BackendEvent, HarnessName, EffortLevel, JobSnapshot, ProfileDefinition, ProviderFamily, Usage } from "../types.ts";
import {
  appendWorkflowJournal,
  checkpointWorkflow,
  createWorkflowArtifacts,
  loadWorkflowJournal,
  loadWorkflowSummaries,
  writeWorkflowReport,
  writeWorkflowResult,
} from "./artifacts.ts";
import { replayableJournalPrefix, workflowCallFingerprint, workflowDefinitionFingerprint } from "./journal.ts";
import { runWorkflowSandbox, serializeWorkflowArgs, type WorkflowAgentResult } from "./sandbox.ts";
import { finishWorkflowWorktree, prepareWorkflowWorktree, type WorkflowWorktreeHandle } from "./worktree.ts";
import type {
  WorkflowAgentRecord,
  WorkflowAgentState,
  WorkflowJournalRecord,
  WorkflowJournalResult,
  WorkflowJournalRoute,
  WorkflowApprovalMode,
  WorkflowBudgetPolicy,
  WorkflowPhase,
  WorkflowReplayCall,
  WorkflowReplacementReference,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowUsage,
} from "./types.ts";

const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
const ACCESS = new Set<AccessMode>(["readOnly", "full"]);
const CHECKPOINT_DELAY_MS = 150;
const MAX_RETAINED_RUNS = 64;
const MAX_WORKFLOW_LOGS = 128;
export const MAX_WORKFLOW_PHASES = 64;

export interface StartWorkflowRequest {
  sessionId: string;
  name: string;
  description?: string;
  script: string;
  args?: unknown;
  background?: boolean;
  cwd: string;
  trusted: boolean;
  parentProvider?: ProviderFamily;
  defaultHarness?: HarnessName;
  /** Replay the completed call prefix from this terminal run. The definition and execution context must match exactly. */
  resumeFromRunId?: string;
  /** Internal dashboard control: force replay invalidation at this call ordinal. */
  restartFromCallIndex?: number;
  /** Internal replacement provenance set by restartAgent(). */
  replacementOf?: WorkflowReplacementReference;
  approval?: WorkflowApprovalMode;
  budget?: WorkflowBudgetPolicy;
}

export interface StartedWorkflow {
  snapshot: WorkflowSnapshot;
  completion: Promise<WorkflowSnapshot>;
}

interface ReplayRuntime {
  sourceRunId: string;
  calls: WorkflowReplayCall[];
  active: boolean;
  priorJobProviders: Map<string, ProviderFamily>;
}

interface RunEntry {
  snapshot: WorkflowSnapshot;
  controller: AbortController;
  completion: Promise<WorkflowSnapshot>;
  checkpointTimer?: NodeJS.Timeout;
  persistChain: Promise<void>;
  journalChain: Promise<void>;
  journalSequence: number;
  nextCallIndex: number;
  replay?: ReplayRuntime;
  request?: StartWorkflowRequest;
  pauseWaiters: Set<() => void>;
  mutationApproved: boolean;
  approvalPromise?: Promise<boolean>;
  activeDispatches: number;
  dispatchWaiters: Set<() => void>;
}

function workflowUsage(usage?: Partial<Usage>): WorkflowUsage {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: usage?.cost ?? 0,
    turns: usage?.turns ?? 0,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedText(value: unknown, max = 16_384): string {
  return String(value instanceof Error ? value.message : value ?? "").slice(0, max);
}

function label(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 160);
}

function looksInstructionShaped(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const sample = value.slice(0, 32 * 1024);
  return /(?:ignore|disregard|override).{0,80}(?:previous|prior|system|developer|instructions?)|(?:system|developer)\s+(?:message|instructions?)\s*:|you\s+must\s+(?:now\s+)?(?:ignore|disregard|override)/is.test(sample);
}

function journalRoute(agent?: WorkflowAgentRecord): WorkflowJournalRoute | undefined {
  if (!agent) return undefined;
  return {
    jobId: agent.jobId,
    harness: agent.harness as HarnessName | undefined,
    model: agent.model,
    status: agent.state,
    error: agent.error ? boundedText(agent.error, 2_000) : undefined,
  };
}

function agentState(job: JobSnapshot): WorkflowAgentState {
  switch (job.status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "running": return "running";
    default: return "queued";
  }
}

function terminalWorkflow(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function replacementReason(agent: WorkflowAgentRecord): string {
  if (agent.state === "failed") return agent.error ? "failed" : "failed without a recorded reason";
  if (agent.state === "cancelled") return "cancelled";
  if (agent.state === "aborted") return "aborted or stalled";
  if (agent.state === "completed") return "manual replacement / inadequate result";
  return "manual replacement";
}

function budgetsAllowReplay(source: WorkflowBudgetPolicy | undefined, next: WorkflowBudgetPolicy | undefined): boolean {
  for (const key of ["maxAgents", "maxConcurrency", "maxTokens", "maxCost", "maxTurns"] as const) {
    const previous = source?.[key] ?? Number.POSITIVE_INFINITY;
    const current = next?.[key] ?? Number.POSITIVE_INFINITY;
    if (current < previous) return false;
  }
  return true;
}

function abortError(reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(String(reason ?? "Workflow aborted"));
  error.name = "AbortError";
  return error;
}

export class WorkflowManager {
  readonly #jobs: JobManager;
  readonly #artifactRoot: string;
  readonly #sessionId: string;
  readonly #runs = new Map<string, RunEntry>();
  readonly #jobOwners = new Map<string, { runId: string; agentIndex: number }>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(snapshot: WorkflowSnapshot) => void>();
  readonly #unsubscribeJobs: () => void;
  readonly #approveMutation?: (request: { runId: string; workflow: string; agent: string; prompt: string; signal: AbortSignal }) => Promise<boolean>;
  readonly #router?: CapabilityRouter;
  readonly #resolveProfile?: (name: string) => ProfileDefinition | undefined;
  #initializing?: Promise<void>;
  #closed = false;

  constructor(options: {
    jobs: JobManager;
    artifactRoot: string;
    sessionId: string;
    approveMutation?: (request: { runId: string; workflow: string; agent: string; prompt: string; signal: AbortSignal }) => Promise<boolean>;
    /** Live capability routing for `requires`/`harness: "auto"`; absent means requirements fail closed. */
    router?: CapabilityRouter;
    resolveProfile?: (name: string) => ProfileDefinition | undefined;
  }) {
    this.#jobs = options.jobs;
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#sessionId = options.sessionId;
    this.#approveMutation = options.approveMutation;
    this.#router = options.router;
    this.#resolveProfile = options.resolveProfile;
    this.#unsubscribeJobs = this.#jobs.subscribe((job, event) => this.#updateAgentFromJob(job, event));
  }

  async initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      const restored = await loadWorkflowSummaries(this.#artifactRoot, { staleAfterMs: 0, sessionId: this.#sessionId });
      for (const snapshot of restored.slice(0, MAX_RETAINED_RUNS)) {
        if (this.#runs.has(snapshot.runId)) continue;
        const controller = new AbortController();
        const completion = Promise.resolve(clone(snapshot));
        this.#runs.set(snapshot.runId, {
          snapshot,
          controller,
          completion,
          persistChain: Promise.resolve(),
          journalChain: Promise.resolve(),
          journalSequence: 0,
          nextCallIndex: 0,
          pauseWaiters: new Set(),
          mutationApproved: false,
          activeDispatches: 0,
          dispatchWaiters: new Set(),
        });
      }
    })();
    return this.#initializing;
  }

  list(): WorkflowSnapshot[] {
    return [...this.#runs.values()]
      .map((entry) => clone(entry.snapshot))
      .sort((left, right) => right.timestamps.createdAt - left.timestamps.createdAt);
  }

  check(runId: string): WorkflowSnapshot {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    const snapshot = clone(entry.snapshot);
    snapshot.agents = snapshot.agents.map((agent) => this.#projectAgent(agent));
    return snapshot;
  }

  subscribe(listener: (snapshot: WorkflowSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(request: StartWorkflowRequest): Promise<StartedWorkflow> {
    if (!request.trusted) throw new Error("Workflows are disabled for untrusted projects");
    await this.initialize();
    if (this.#closed) throw new Error("Workflow manager is closed");
    if (!request.script.trim()) throw new Error("Workflow script must not be empty");
    const argsJson = serializeWorkflowArgs(request.args ?? null);
    const approval = request.approval ?? "auto";
    if (!["auto", "plan", "onMutate"].includes(approval)) throw new Error(`Unknown workflow approval mode: ${approval}`);
    const budget = normalizeWorkflowBudget(request.budget);
    const fingerprintInput = {
      script: request.script,
      argsJson,
      cwd: resolve(request.cwd),
      parentProvider: request.parentProvider,
      defaultHarness: request.defaultHarness,
      approval,
    };
    const replayBaseFingerprint = workflowDefinitionFingerprint(fingerprintInput);
    const definitionFingerprint = workflowDefinitionFingerprint({
      ...fingerprintInput,
      budget,
    });
    let replay: ReplayRuntime | undefined;
    if (request.resumeFromRunId) {
      const source = this.#runs.get(request.resumeFromRunId);
      if (!source) throw new Error(`Unknown workflow replay source: ${request.resumeFromRunId}`);
      if (!terminalWorkflow(source.snapshot.status)) throw new Error("Cannot resume from an active workflow");
      if (!source.snapshot.definitionFingerprint) throw new Error("Workflow predates durable replay and cannot be resumed");
      const sameDefinition = source.snapshot.replayBaseFingerprint
        ? source.snapshot.replayBaseFingerprint === replayBaseFingerprint && budgetsAllowReplay(source.snapshot.budget, budget)
        : source.snapshot.definitionFingerprint === definitionFingerprint;
      if (!sameDefinition) {
        throw new Error("Workflow definition or execution context does not match the replay source (including budget)");
      }
      const restartAt = request.restartFromCallIndex;
      if (restartAt !== undefined && (!Number.isSafeInteger(restartAt) || restartAt < 0 || restartAt >= 32)) {
        throw new Error("restartFromCallIndex must be an agent call ordinal from 0 to 31");
      }
      const prefix = replayableJournalPrefix(await loadWorkflowJournal(this.#artifactRoot, source.snapshot.runId));
      const calls = restartAt === undefined ? prefix : prefix.filter((call) => call.callIndex < restartAt);
      replay = {
        sourceRunId: source.snapshot.runId,
        calls,
        active: true,
        priorJobProviders: new Map(calls.flatMap((call) => {
          const jobId = call.result.jobId ?? call.route?.jobId;
          const harness = call.route?.harness;
          return jobId && (harness === "claude" || harness === "codex") ? [[jobId, harness] as const] : [];
        })),
      };
    }
    const warnings = workflowBudgetWarnings(budget);
    const now = Date.now();
    const base: Omit<WorkflowSnapshot, "runId" | "artifactDir"> = {
      sessionId: request.sessionId,
      name: label(request.name, "workflow"),
      description: label(request.description, ""),
      background: request.background ?? false,
      status: "running",
      timestamps: { createdAt: now, updatedAt: now, startedAt: now },
      currentPhase: null,
      phases: [],
      agents: [],
      logs: [],
      definitionFingerprint,
      replayBaseFingerprint,
      replacementOf: request.replacementOf ? clone(request.replacementOf) : undefined,
      journalArtifact: "journal.jsonl",
      approval,
      budget,
      warnings: warnings.length ? warnings : undefined,
      replay: replay ? {
        sourceRunId: replay.sourceRunId,
        matchedCalls: 0,
        invalidatedAt: request.restartFromCallIndex,
      } : undefined,
    };
    const snapshot = await createWorkflowArtifacts(this.#artifactRoot, {
      script: request.script,
      args: request.args ?? null,
      snapshot: base,
    });
    this.#evictOldRuns();
    const controller = new AbortController();
    const entry: RunEntry = {
      snapshot,
      controller,
      completion: Promise.resolve(snapshot),
      persistChain: Promise.resolve(),
      journalChain: Promise.resolve(),
      journalSequence: 0,
      nextCallIndex: 0,
      replay,
      request: clone(request),
      pauseWaiters: new Set(),
      mutationApproved: approval === "auto",
      activeDispatches: 0,
      dispatchWaiters: new Set(),
    };
    this.#runs.set(snapshot.runId, entry);
    entry.completion = this.#execute(entry, request);
    this.#publish(entry);
    return { snapshot: clone(snapshot), completion: entry.completion };
  }

  async cancel(runId: string, reason = "Cancelled by parent"): Promise<WorkflowSnapshot> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    if (terminalWorkflow(entry.snapshot.status)) return clone(entry.snapshot);
    entry.snapshot.error = boundedText(reason);
    entry.controller.abort(new Error(reason));
    this.#releasePause(entry);
    return entry.completion;
  }

  async pause(runId: string): Promise<WorkflowSnapshot> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    if (terminalWorkflow(entry.snapshot.status)) throw new Error("Cannot pause a terminal workflow");
    if (entry.snapshot.status === "paused") return this.check(runId);
    entry.snapshot.status = "paused";
    entry.snapshot.timestamps.pausedAt = Date.now();
    this.#touch(entry);
    await this.#flushCheckpoint(entry);
    return this.check(runId);
  }

  async resume(runId: string): Promise<WorkflowSnapshot> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    if (terminalWorkflow(entry.snapshot.status)) throw new Error("Cannot resume a terminal workflow in place; start a journal replay instead");
    if (entry.snapshot.status !== "paused") return this.check(runId);
    entry.snapshot.status = "running";
    entry.snapshot.timestamps.pausedAt = undefined;
    this.#releasePause(entry);
    this.#touch(entry);
    await this.#flushCheckpoint(entry);
    return this.check(runId);
  }

  async restartAgent(runId: string, agentIndex: number): Promise<StartedWorkflow> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    const agent = entry.snapshot.agents.find((candidate) => candidate.index === agentIndex);
    if (!agent) throw new Error(`Unknown workflow agent: ${agentIndex}`);
    if (agent.callIndex === undefined) throw new Error("Workflow agent predates durable replay and cannot be restarted");
    if (!entry.request) throw new Error("Workflow definition is unavailable in this session; rerun the workflow tool with resumeFromRunId");
    if (!terminalWorkflow(entry.snapshot.status)) await this.cancel(runId, `Restarting workflow from agent ${agent.name}`);
    const reason = replacementReason(agent);
    const replacementOf: WorkflowReplacementReference = {
      sourceRunId: runId,
      sourceAgentIndex: agent.index,
      sourceCallIndex: agent.callIndex,
      sourceJobId: agent.jobId,
      sourceHarness: agent.harness as HarnessName | undefined,
      sourceModel: agent.model,
      sourceState: agent.state,
      sourceError: agent.error ? boundedText(agent.error, 2_000) : undefined,
      reason,
    };
    const started = await this.start({
      ...clone(entry.request),
      resumeFromRunId: runId,
      restartFromCallIndex: agent.callIndex,
      replacementOf,
    });
    agent.replacedBy = { replacementRunId: started.snapshot.runId, reason, at: Date.now() };
    this.#touch(entry);
    await this.#flushCheckpoint(entry);
    return started;
  }

  async cancelAgent(runId: string, agentIndex: number, reason = "Workflow agent cancelled by user"): Promise<WorkflowSnapshot> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    const agent = entry.snapshot.agents.find((candidate) => candidate.index === agentIndex);
    if (!agent) throw new Error(`Unknown workflow agent: ${agentIndex}`);
    if (!agent.jobId) throw new Error(`Workflow agent ${agent.name} has not started`);
    if (["completed", "failed", "cancelled", "aborted"].includes(agent.state)) return this.check(runId);
    await this.#jobs.cancel(agent.jobId, reason);
    return this.check(runId);
  }

  async shutdown(timeoutMs = 8_000): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#initializing?.catch(() => undefined);
    const active = [...this.#runs.values()].filter((entry) => !terminalWorkflow(entry.snapshot.status));
    for (const entry of active) {
      entry.snapshot.error = "Session shutdown";
      entry.controller.abort(new Error("Session shutdown"));
      this.#releasePause(entry);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(active.map((entry) => entry.completion)).then(() => undefined),
      new Promise<void>((resolveDeadline) => { timer = setTimeout(resolveDeadline, Math.max(0, timeoutMs)); }),
    ]);
    if (timer) clearTimeout(timer);
    this.#unsubscribeJobs();
    for (const entry of this.#runs.values()) {
      if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
      entry.checkpointTimer = undefined;
    }
    this.#listeners.clear();
  }

  async #execute(entry: RunEntry, request: StartWorkflowRequest): Promise<WorkflowSnapshot> {
    try {
      const sandbox = await runWorkflowSandbox({
        source: request.script,
        args: request.args ?? null,
        cwd: request.cwd,
        signal: entry.controller.signal,
        onMeta: (meta) => this.#applyMeta(entry, meta),
        onPhase: (title) => this.#activatePhase(entry, title),
        onLog: (message) => this.#recordLog(entry, message),
        onAgent: (prompt, options, signal, callIndex) => this.#runAgent(entry, request, prompt, options, signal, callIndex),
      });
      this.#applyMeta(entry, sandbox.meta);
      entry.snapshot.result = sandbox.result;
      entry.snapshot.status = "completed";
      this.#finishPhases(entry, "completed");
      await writeWorkflowResult(this.#artifactRoot, entry.snapshot.runId, sandbox.result);
    } catch (error) {
      const aborted = entry.controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      entry.snapshot.status = aborted ? "aborted" : "failed";
      entry.snapshot.error = boundedText(entry.snapshot.error || error);
      await this.#cancelMemberJobs(entry, entry.snapshot.error);
      this.#finishPhases(entry, entry.snapshot.status);
    } finally {
      this.#releasePause(entry);
      const now = Date.now();
      entry.snapshot.timestamps.updatedAt = now;
      entry.snapshot.timestamps.pausedAt = undefined;
      entry.snapshot.timestamps.endedAt = now;
      try {
        await entry.journalChain;
        entry.snapshot.reportArtifact = "report.md";
        await writeWorkflowReport(this.#artifactRoot, entry.snapshot);
        await this.#flushCheckpoint(entry);
      } catch (error) {
        // Artifact failure is a workflow failure, not a rejected lifecycle
        // promise. Foreground cards and background follow-ups must still get
        // exactly one structured terminal result.
        entry.snapshot.status = "failed";
        const detail = `Artifact persistence failed: ${boundedText(error)}`;
        entry.snapshot.error = entry.snapshot.error ? `${entry.snapshot.error}; ${detail}` : detail;
        this.#finishPhases(entry, "failed");
      }
      this.#publish(entry);
    }
    return clone(entry.snapshot);
  }

  async #runAgent(
    entry: RunEntry,
    request: StartWorkflowRequest,
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
    callIndex: number,
  ): Promise<WorkflowAgentResult> {
    if (callIndex !== entry.nextCallIndex || callIndex < 0 || callIndex >= 32) {
      throw new Error(`Workflow agent call ordinal is invalid or out of sequence: ${callIndex}`);
    }
    entry.nextCallIndex++;
    const fingerprint = workflowCallFingerprint(prompt, options);
    await this.#appendJournal(entry, {
      callIndex,
      fingerprint,
      state: "started",
      at: Date.now(),
    });
    await this.#waitUntilResumed(entry, signal);

    const expected = entry.replay?.active && callIndex < (entry.snapshot.budget?.maxAgents ?? 32)
      ? entry.replay.calls[callIndex]
      : undefined;
    if (entry.replay?.active && expected?.fingerprint === fingerprint) {
      const record = this.#recordReplayedAgent(entry, prompt, options, callIndex, fingerprint, expected);
      entry.snapshot.replay!.matchedCalls++;
      await this.#appendJournal(entry, {
        callIndex,
        fingerprint,
        state: "completed",
        at: Date.now(),
        agentIndex: record.index,
        result: clone(expected.result),
        route: expected.route ? { ...expected.route } : undefined,
        replayedFrom: { runId: entry.replay.sourceRunId, callIndex: expected.callIndex },
      });
      this.#touch(entry);
      return clone(expected.result);
    }
    if (entry.replay?.active) {
      entry.replay.active = false;
      entry.snapshot.replay!.invalidatedAt = callIndex;
      this.#touch(entry);
    }

    let result: WorkflowAgentResult;
    try {
      const execute = () => this.#runFreshAgent(entry, request, prompt, options, signal, callIndex, fingerprint);
      const isolated = () => options.access === "readOnly" || options.isolation === "worktree"
        ? execute()
        : this.#withMutationLock(request.cwd, signal, execute);
      result = await this.#withDispatchSlot(entry, signal, isolated);
    } catch (error) {
      const failed = { ok: false, output: "", error: boundedText(error) } satisfies WorkflowJournalResult;
      const record = entry.snapshot.agents.find((candidate) => candidate.callIndex === callIndex);
      await this.#appendJournal(entry, {
        callIndex,
        fingerprint,
        state: "failed",
        at: Date.now(),
        agentIndex: record?.index,
        result: failed,
        route: journalRoute(record),
        replacementOf: entry.snapshot.replacementOf ? clone(entry.snapshot.replacementOf) : undefined,
      });
      throw error;
    }
    const record = entry.snapshot.agents.find((candidate) => candidate.callIndex === callIndex);
    const budgetError = this.#budgetViolation(entry);
    if (budgetError) {
      result = { ...result, ok: false, error: budgetError };
      if (record) {
        record.state = "failed";
        record.error = budgetError;
        record.timestamps.updatedAt = Date.now();
        record.timestamps.endedAt ??= record.timestamps.updatedAt;
      }
      entry.snapshot.error = budgetError;
    }
    await this.#appendJournal(entry, {
      callIndex,
      fingerprint,
      state: result.ok ? "completed" : "failed",
      at: Date.now(),
      agentIndex: record?.index,
      result: clone(result) as WorkflowJournalResult,
      route: journalRoute(record),
      replacementOf: entry.snapshot.replacementOf ? clone(entry.snapshot.replacementOf) : undefined,
    });
    if (budgetError) entry.controller.abort(new Error(budgetError));
    return result;
  }

  async #runFreshAgent(
    entry: RunEntry,
    request: StartWorkflowRequest,
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
    callIndex: number,
    fingerprint: string,
  ): Promise<WorkflowAgentResult> {
    if (!prompt.trim()) return { ok: false, output: "", error: "agent() requires a non-empty prompt" };
    const preflightError = this.#budgetPreflight(entry);
    if (preflightError) return { ok: false, output: "", error: preflightError };
    if (["role", "agent", "tier", "modelTier", "modelProfile", "backend"].some((key) => Object.hasOwn(options, key))) {
      return { ok: false, output: "", error: "Workflow agent() API schema mismatch: use the current task-driven schema." };
    }
    const harness = options.harness === undefined ? undefined : String(options.harness) as RequestedHarness;
    if (harness && !isRequestedHarness(harness)) return { ok: false, output: "", error: `Unknown harness: ${harness}` };
    let model: string | undefined;
    try { model = normalizeModel(options.model); }
    catch (error) { return { ok: false, output: "", error: boundedText(error) }; }
    const effortValue = options.effort;
    const effort = effortValue === undefined ? undefined : String(effortValue) as EffortLevel;
    if (effort && !EFFORTS.has(effort)) return { ok: false, output: "", error: `Unknown effort: ${effort}` };
    const access = options.access === undefined ? undefined : String(options.access) as AccessMode;
    if (access && !ACCESS.has(access)) return { ok: false, output: "", error: `Unknown access: ${access}` };
    if (callIndex >= (entry.snapshot.budget?.maxAgents ?? 32)) {
      return { ok: false, output: "", error: `Workflow agent budget exceeded (${entry.snapshot.budget?.maxAgents} calls)` };
    }
    if (options.independent !== undefined && typeof options.independent !== "boolean") return { ok: false, output: "", error: "independent must be boolean" };
    if (options.independentOf !== undefined && (typeof options.independentOf !== "string" || !options.independentOf.trim() || options.independentOf.trim().length > 200)) return { ok: false, output: "", error: "independentOf must be a job ID containing 1–200 characters" };
    if (options.profile !== undefined && (typeof options.profile !== "string" || !options.profile.trim())) return { ok: false, output: "", error: "profile must be a non-empty string" };
    if (options.isolation !== undefined && options.isolation !== "worktree") return { ok: false, output: "", error: "isolation must be worktree when provided" };
    if ((access ?? "full") === "full") {
      const approved = await this.#authorizeMutation(entry, label(options.name ?? options.label, `agent-${callIndex + 1}`), prompt, signal);
      if (!approved) return { ok: false, output: "", error: entry.snapshot.approval === "plan"
        ? "Workflow approval mode plan forbids mutating agents"
        : "Workflow mutation was not approved by the host" };
    }
    await this.#waitUntilResumed(entry, signal);

    const phase = typeof options.phase === "string"
      ? this.#ensurePhase(entry, options.phase)
      : entry.snapshot.currentPhase ?? this.#ensurePhase(entry, "Agents");
    this.#markPhaseRunning(entry, phase);
    const index = entry.snapshot.agents.length;
    const name = label(options.name ?? options.label, `agent-${index + 1}`);
    const now = Date.now();
    const record: WorkflowAgentRecord = {
      index,
      callIndex,
      callFingerprint: fingerprint,
      name,
      access: access ?? "full",
      profile: typeof options.profile === "string" ? options.profile.trim() : undefined,
      independent: options.independent === true || options.independentOf !== undefined,
      independentOf: typeof options.independentOf === "string" ? options.independentOf.trim() : undefined,
      phase,
      state: "queued",
      timestamps: { createdAt: now, updatedAt: now },
      harness: harness && harness !== "auto" ? harness : undefined,
      model,
      prompt: boundedText(prompt, 2 * 1024),
      effort,
      tools: [],
      usage: workflowUsage(),
    };
    entry.snapshot.agents.push(record);
    entry.snapshot.phases[phase]?.agents.push(index);
    this.#touch(entry);

    const schema = options.schema === undefined ? undefined : workflowSchema(options.schema);
    if (options.schema !== undefined && !schema) {
      record.state = "failed";
      record.error = "agent schema must be a bounded JSON Schema object";
      record.timestamps.updatedAt = Date.now();
      record.timestamps.endedAt = record.timestamps.updatedAt;
      this.#touch(entry);
      return { ok: false, output: "", error: record.error };
    }
    const task = schema
      ? `${prompt}\n\nReturn ONLY valid JSON matching this JSON Schema (no markdown fences):\n${JSON.stringify(schema)}`
      : prompt;

    let worktree: WorkflowWorktreeHandle | undefined;
    const finishIsolation = async () => {
      if (!worktree) return;
      const handle = worktree;
      worktree = undefined;
      try {
        record.isolation = await this.#withMutationLock(request.cwd, new AbortController().signal, () => finishWorkflowWorktree(handle, entry.snapshot.artifactDir));
      } catch (error) {
        record.isolation = {
          type: "worktree",
          state: "orphaned",
          branch: handle.branch,
          changed: true,
          error: boundedText(error, 2_000),
        };
        this.#touch(entry);
        throw error;
      }
      this.#touch(entry);
    };
    let agentCwd = request.cwd;
    if (options.isolation === "worktree") {
      try {
        worktree = await this.#withMutationLock(request.cwd, signal, () => prepareWorkflowWorktree({
          cwd: request.cwd,
          artifactDir: entry.snapshot.artifactDir,
          runId: entry.snapshot.runId,
          agentIndex: index,
        }));
        agentCwd = worktree.path;
      } catch (error) {
        record.state = "failed";
        record.error = boundedText(error);
        record.timestamps.updatedAt = Date.now();
        record.timestamps.endedAt = record.timestamps.updatedAt;
        this.#touch(entry);
        return { ok: false, output: "", error: record.error };
      }
    }

    const replayIndependenceProvider = record.independentOf
      ? entry.replay?.priorJobProviders.get(record.independentOf)
      : undefined;
    let job: JobSnapshot;
    try {
      const routing = await routeCapabilities(this.#router, {
        request: {
          name,
          task,
          cwd: agentCwd,
          trusted: request.trusted,
          harness,
          requires: options.requires as string[] | undefined,
          model,
          effort,
          access,
          independent: options.independent === true,
          independentOf: record.independentOf,
          independentOfProvider: replayIndependenceProvider,
          profile: record.profile,
          defaultHarness: request.defaultHarness,
          parentProvider: request.parentProvider,
        },
        profile: record.profile ? this.#resolveProfile?.(record.profile) : undefined,
        independentOfProvider: replayIndependenceProvider,
        preference: request.defaultHarness ? [request.defaultHarness] : undefined,
        signal,
      });
      job = this.#jobs.spawn({
        name,
        task,
        cwd: agentCwd,
        trusted: request.trusted,
        harness: routing.harness ?? (harness === "auto" ? undefined : harness),
        requires: routing.requires,
        capabilityRoute: routing.capabilityRoute,
        model,
        effort,
        access,
        independent: options.independent === true,
        independentOf: record.independentOf,
        independentOfProvider: replayIndependenceProvider,
        profile: record.profile,
        defaultHarness: request.defaultHarness,
        parentProvider: request.parentProvider,
        workflow: {
          runId: entry.snapshot.runId,
          agentIndex: index,
          label: record.name,
          phase: entry.snapshot.phases[phase]?.name,
        },
      });
    } catch (error) {
      await finishIsolation().catch(() => undefined);
      record.state = "failed";
      record.error = boundedText(error);
      record.timestamps.updatedAt = Date.now();
      record.timestamps.endedAt = record.timestamps.updatedAt;
      this.#touch(entry);
      return { ok: false, output: "", error: record.error };
    }

    record.jobId = job.id;
    record.name = job.name;
    record.access = job.access;
    record.profile = job.profile;
    record.independent = job.independent;
    record.independentOf = job.independentOf;
    record.harness = job.harness;
    record.model = job.model;
    record.timestamps.updatedAt = Date.now();
    this.#jobOwners.set(job.id, { runId: entry.snapshot.runId, agentIndex: index });
    // spawn() may synchronously pump the job to running before ownership is
    // registered, so re-read the authoritative snapshot instead of applying
    // the stale queued value returned to the caller.
    this.#updateAgentFromJob(this.#jobs.check(job.id));

    const abort = () => { void this.#jobs.cancel(job.id, "Workflow agent cancelled").catch(() => undefined); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      const final = await this.#jobs.wait(job.id, { signal });
      this.#updateAgentFromJob(final);
      if (final.status === "completed") {
        if (schema) {
          const structured = parseStructuredOutput(final.output);
          if (structured === undefined || !Check(schema, structured)) {
            record.state = "failed";
            record.error = "Agent output did not match the requested JSON Schema";
            record.timestamps.updatedAt = Date.now();
            record.timestamps.endedAt = record.timestamps.updatedAt;
            record.structured = undefined;
            this.#touch(entry);
            return { ok: false, output: final.output, jobId: final.id, error: record.error, usage: clone(final.usage) };
          }
          record.structured = structured;
          this.#touch(entry);
          return { ok: true, output: final.output, structured, jobId: final.id, usage: clone(final.usage) };
        }
        return { ok: true, output: final.output, jobId: final.id, usage: clone(final.usage) };
      }
      return { ok: false, output: final.output, jobId: final.id, error: final.error ?? `Agent ${final.status}`, usage: clone(final.usage) };
    } catch (error) {
      await this.#jobs.cancel(job.id, "Workflow agent wait aborted").catch(() => undefined);
      const final = this.#jobs.check(job.id);
      this.#updateAgentFromJob(final);
      return { ok: false, output: final.output, jobId: final.id, error: boundedText(error), usage: clone(final.usage) };
    } finally {
      signal.removeEventListener("abort", abort);
      try { await finishIsolation(); }
      catch (error) {
        record.state = "failed";
        record.error = boundedText(error);
        record.timestamps.updatedAt = Date.now();
        record.timestamps.endedAt ??= record.timestamps.updatedAt;
        this.#touch(entry);
        throw error;
      }
    }
  }

  #recordReplayedAgent(
    entry: RunEntry,
    prompt: string,
    options: Record<string, unknown>,
    callIndex: number,
    fingerprint: string,
    replay: WorkflowReplayCall,
  ): WorkflowAgentRecord {
    const phase = typeof options.phase === "string"
      ? this.#ensurePhase(entry, options.phase)
      : entry.snapshot.currentPhase ?? this.#ensurePhase(entry, "Agents");
    this.#markPhaseRunning(entry, phase);
    const index = entry.snapshot.agents.length;
    const now = Date.now();
    const access = options.access === "readOnly" ? "readOnly" : "full";
    const independentOf = typeof options.independentOf === "string" ? options.independentOf.trim() : undefined;
    const replayEffort = typeof options.effort === "string" && EFFORTS.has(options.effort as EffortLevel)
      ? options.effort as EffortLevel
      : undefined;
    const record: WorkflowAgentRecord = {
      index,
      callIndex,
      callFingerprint: fingerprint,
      replayedFrom: { runId: entry.replay!.sourceRunId, callIndex: replay.callIndex },
      outputProvenance: "replay",
      instructionShaped: looksInstructionShaped(replay.result.output),
      name: label(options.name ?? options.label, `agent-${index + 1}`),
      access,
      profile: typeof options.profile === "string" ? options.profile.trim() : undefined,
      independent: options.independent === true || independentOf !== undefined,
      independentOf,
      phase,
      jobId: replay.result.jobId ?? replay.route?.jobId,
      state: "completed",
      timestamps: { createdAt: now, updatedAt: now, startedAt: now, endedAt: now },
      harness: replay.route?.harness,
      model: replay.route?.model,
      effort: replayEffort,
      prompt: boundedText(prompt, 2 * 1024),
      tools: [],
      output: replay.result.output,
      structured: replay.result.structured === undefined ? undefined : clone(replay.result.structured),
      usage: workflowUsage(),
    };
    entry.snapshot.agents.push(record);
    entry.snapshot.phases[phase]?.agents.push(index);
    this.#touch(entry);
    return record;
  }

  async #authorizeMutation(entry: RunEntry, agent: string, prompt: string, signal: AbortSignal): Promise<boolean> {
    if (entry.snapshot.approval === "plan") return false;
    if (entry.mutationApproved || entry.snapshot.approval === "auto") return true;
    entry.approvalPromise ??= this.#approveMutation?.({
      runId: entry.snapshot.runId,
      workflow: entry.snapshot.name,
      agent,
      prompt: boundedText(prompt, 1_000).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
      signal,
    }) ?? Promise.resolve(false);
    const approved = await entry.approvalPromise.catch(() => false);
    entry.approvalPromise = undefined;
    if (signal.aborted) throw abortError(signal.reason);
    entry.mutationApproved = approved;
    return approved;
  }

  async #withDispatchSlot<T>(entry: RunEntry, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const limit = entry.snapshot.budget?.maxConcurrency ?? 4;
    while (entry.activeDispatches >= limit) {
      if (signal.aborted) throw abortError(signal.reason);
      await new Promise<void>((resolveSlot, rejectSlot) => {
        const ready = () => { cleanup(); resolveSlot(); };
        const abort = () => { cleanup(); rejectSlot(abortError(signal.reason)); };
        const cleanup = () => {
          entry.dispatchWaiters.delete(ready);
          signal.removeEventListener("abort", abort);
        };
        entry.dispatchWaiters.add(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    entry.activeDispatches++;
    try { return await operation(); }
    finally {
      entry.activeDispatches--;
      const ready = entry.dispatchWaiters.values().next().value as (() => void) | undefined;
      if (ready) {
        entry.dispatchWaiters.delete(ready);
        ready();
      }
    }
  }

  #budgetPreflight(entry: RunEntry): string | undefined {
    const budget = entry.snapshot.budget;
    if (!budget) return undefined;
    const usage = aggregateWorkflowUsage(entry.snapshot);
    const tokens = usage.input + usage.output;
    if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) return `Workflow token budget exhausted (${tokens}/${budget.maxTokens})`;
    if (budget.maxCost !== undefined && usage.cost >= budget.maxCost) return `Workflow cost budget exhausted ($${usage.cost.toFixed(4)}/$${budget.maxCost})`;
    if (budget.maxTurns !== undefined && usage.turns >= budget.maxTurns) return `Workflow turn budget exhausted (${usage.turns}/${budget.maxTurns})`;
    return undefined;
  }

  #budgetViolation(entry: RunEntry): string | undefined {
    const budget = entry.snapshot.budget;
    if (!budget) return undefined;
    const usage = aggregateWorkflowUsage(entry.snapshot);
    const tokens = usage.input + usage.output;
    if (budget.maxTokens !== undefined && tokens > budget.maxTokens) return `Workflow token budget exceeded (${tokens}/${budget.maxTokens})`;
    if (budget.maxCost !== undefined && usage.cost > budget.maxCost) return `Workflow cost budget exceeded ($${usage.cost.toFixed(4)}/$${budget.maxCost})`;
    if (budget.maxTurns !== undefined && usage.turns > budget.maxTurns) return `Workflow turn budget exceeded (${usage.turns}/${budget.maxTurns})`;
    return undefined;
  }

  async #withMutationLock<T>(cwd: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const key = await realpath(resolve(cwd)).catch(() => resolve(cwd));
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      if (signal.aborted) throw abortError(signal.reason);
      return operation();
    });
    const tail = queued.then(() => undefined, () => undefined);
    this.#mutationTails.set(key, tail);
    void tail.then(() => { if (this.#mutationTails.get(key) === tail) this.#mutationTails.delete(key); });
    return queued;
  }

  async #waitUntilResumed(entry: RunEntry, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError(signal.reason);
    if (entry.snapshot.status !== "paused") return;
    await new Promise<void>((resolveWait, rejectWait) => {
      const resume = () => {
        cleanup();
        resolveWait();
      };
      const abort = () => {
        cleanup();
        rejectWait(abortError(signal.reason));
      };
      const cleanup = () => {
        entry.pauseWaiters.delete(resume);
        signal.removeEventListener("abort", abort);
      };
      entry.pauseWaiters.add(resume);
      signal.addEventListener("abort", abort, { once: true });
      if (entry.snapshot.status !== "paused") resume();
    });
  }

  #releasePause(entry: RunEntry): void {
    const waiters = [...entry.pauseWaiters];
    entry.pauseWaiters.clear();
    for (const resume of waiters) resume();
  }

  async #appendJournal(
    entry: RunEntry,
    value: Omit<WorkflowJournalRecord, "version" | "sequence">,
  ): Promise<void> {
    const record: WorkflowJournalRecord = {
      version: 1,
      sequence: entry.journalSequence++,
      ...value,
    };
    const write = entry.journalChain.then(() => appendWorkflowJournal(this.#artifactRoot, entry.snapshot.runId, record));
    entry.journalChain = write.catch(() => undefined);
    try { await write; }
    catch (error) {
      entry.snapshot.error ??= `Workflow journal persistence failed: ${boundedText(error)}`;
      entry.controller.abort(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  #projectAgent(agent: WorkflowAgentRecord): WorkflowAgentRecord {
    if (!agent.jobId || ["completed", "failed", "cancelled", "aborted"].includes(agent.state)) return agent;
    let job: JobSnapshot;
    try { job = this.#jobs.check(agent.jobId); }
    catch { return agent; }
    return {
      ...agent,
      name: job.name,
      access: job.access,
      profile: job.profile,
      independent: job.independent,
      independentOf: job.independentOf,
      state: agentState(job),
      harness: job.harness,
      model: job.model,
      effort: job.effort,
      preview: job.output.slice(-500),
      output: isTerminal(job.status) ? job.output : agent.output,
      transcript: job.transcript.map((item) => ({ ...item })),
      tools: job.tools.slice(-8).map((tool) => ({ ...tool })),
      liveThinking: job.liveThinking,
      truncated: job.truncated,
      error: job.error,
      usage: workflowUsage(job.usage),
      timestamps: {
        ...agent.timestamps,
        updatedAt: Date.now(),
        startedAt: agent.timestamps.startedAt ?? job.startedAt,
        endedAt: job.endedAt,
      },
    };
  }

  #updateAgentFromJob(job: JobSnapshot, event: BackendEvent = { type: "started" }): void {
    const owner = this.#jobOwners.get(job.id);
    if (!owner) return;
    const entry = this.#runs.get(owner.runId);
    const agent = entry?.snapshot.agents[owner.agentIndex];
    if (!entry || !agent) return;

    // Streaming deltas stay authoritative in JobManager and are projected by check().
    // Persisting and cloning the full workflow on every token is both redundant and quadratic.
    if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "queue_changed") return;

    const now = Date.now();
    agent.state = agentState(job);
    agent.name = job.name;
    agent.access = job.access;
    agent.profile = job.profile;
    agent.independent = job.independent;
    agent.independentOf = job.independentOf;
    agent.harness = job.harness;
    agent.model = job.model;
    agent.effort = job.effort;
    agent.preview = job.output.slice(-500);
    agent.error = job.error;
    agent.usage = workflowUsage(job.usage);
    agent.timestamps.updatedAt = now;
    agent.timestamps.startedAt ??= job.startedAt;
    agent.timestamps.endedAt = job.endedAt;

    if (event.type === "user_message" || event.type === "thinking_message" || event.type === "message"
        || event.type === "tool_start" || event.type === "tool_end" || isTerminal(job.status)) {
      agent.transcript = job.transcript.map((item) => ({ ...item }));
      agent.tools = job.tools.slice(-8).map((tool) => ({ ...tool }));
      agent.truncated = job.truncated;
    }
    if (isTerminal(job.status)) {
      agent.output = job.output;
      agent.outputProvenance = "subagent";
      agent.instructionShaped = looksInstructionShaped(job.output);
    }
    this.#touch(entry);
    if (event.type === "usage") {
      const violation = this.#budgetViolation(entry);
      if (violation && !entry.controller.signal.aborted) {
        entry.snapshot.error = violation;
        entry.controller.abort(new Error(violation));
        void this.#cancelMemberJobs(entry, violation);
      }
    }
  }

  #ensurePhase(entry: RunEntry, rawTitle: string): number {
    const name = label(rawTitle, "Phase");
    const existing = entry.snapshot.phases.find((phase) => phase.name === name);
    if (existing) return existing.index;
    if (entry.snapshot.phases.length >= MAX_WORKFLOW_PHASES) {
      throw new Error(`Workflow phase limit exceeded (${MAX_WORKFLOW_PHASES})`);
    }
    const now = Date.now();
    const phase: WorkflowPhase = {
      index: entry.snapshot.phases.length,
      name,
      status: "pending",
      timestamps: { createdAt: now, updatedAt: now },
      agents: [],
    };
    entry.snapshot.phases.push(phase);
    return phase.index;
  }

  #markPhaseRunning(entry: RunEntry, index: number): void {
    const phase = entry.snapshot.phases[index];
    if (!phase || phase.status !== "pending") return;
    const now = Date.now();
    phase.status = "running";
    phase.timestamps.startedAt ??= now;
    phase.timestamps.updatedAt = now;
    entry.snapshot.currentPhase ??= index;
    this.#touch(entry);
  }

  #applyMeta(entry: RunEntry, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const meta = value as Record<string, unknown>;
    const name = meta.name === undefined ? entry.snapshot.name : label(meta.name, entry.snapshot.name);
    const description = meta.description === undefined ? entry.snapshot.description : label(meta.description, entry.snapshot.description);
    if (name === entry.snapshot.name && description === entry.snapshot.description) return;
    entry.snapshot.name = name;
    entry.snapshot.description = description;
    this.#touch(entry);
  }

  #recordLog(entry: RunEntry, message: string): void {
    const logs = entry.snapshot.logs ??= [];
    logs.push({
      index: logs.length ? logs.at(-1)!.index + 1 : 0,
      message: boundedText(message, 4 * 1024),
      at: Date.now(),
    });
    if (logs.length > MAX_WORKFLOW_LOGS) logs.splice(0, logs.length - MAX_WORKFLOW_LOGS);
    this.#touch(entry);
  }

  #activatePhase(entry: RunEntry, title: string): void {
    const index = this.#ensurePhase(entry, title);
    const now = Date.now();
    const current = entry.snapshot.currentPhase === null ? undefined : entry.snapshot.phases[entry.snapshot.currentPhase];
    if (current && current.index !== index && current.status === "running") {
      current.status = "completed";
      current.timestamps.updatedAt = now;
      current.timestamps.endedAt = now;
    }
    const phase = entry.snapshot.phases[index]!;
    phase.status = "running";
    phase.timestamps.startedAt ??= now;
    phase.timestamps.updatedAt = now;
    entry.snapshot.currentPhase = index;
    this.#touch(entry);
  }

  #finishPhases(entry: RunEntry, status: "completed" | "failed" | "aborted"): void {
    const now = Date.now();
    for (const phase of entry.snapshot.phases) {
      if (phase.status === "completed") continue;
      phase.status = phase.status === "pending" && status === "completed" ? "completed" : status;
      phase.timestamps.updatedAt = now;
      phase.timestamps.endedAt = now;
      if (status !== "completed") phase.error ??= entry.snapshot.error;
    }
  }

  async #cancelMemberJobs(entry: RunEntry, reason: string): Promise<void> {
    const jobs = entry.snapshot.agents
      .map((agent) => agent.jobId)
      .filter((id): id is string => id !== undefined && this.#jobOwners.get(id)?.runId === entry.snapshot.runId)
      .flatMap((id) => {
        try { return [this.#jobs.check(id)]; }
        catch { return []; }
      })
      .filter((job) => !isTerminal(job.status));
    await Promise.allSettled(jobs.map((job) => this.#jobs.cancel(job.id, reason)));
  }

  #touch(entry: RunEntry): void {
    entry.snapshot.timestamps.updatedAt = Date.now();
    this.#publish(entry);
    if (entry.checkpointTimer) return;
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = undefined;
      entry.persistChain = entry.persistChain
        .then(() => checkpointWorkflow(this.#artifactRoot, clone(entry.snapshot)))
        .catch(() => undefined);
    }, CHECKPOINT_DELAY_MS);
    entry.checkpointTimer.unref();
  }

  async #flushCheckpoint(entry: RunEntry): Promise<void> {
    if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = undefined;
    await entry.persistChain.catch(() => undefined);
    await checkpointWorkflow(this.#artifactRoot, clone(entry.snapshot));
  }

  #publish(entry: RunEntry): void {
    const snapshot = clone(entry.snapshot);
    for (const listener of this.#listeners) {
      try { listener(snapshot); } catch { /* observers cannot corrupt lifecycle state */ }
    }
  }

  #evictOldRuns(): void {
    if (this.#runs.size < MAX_RETAINED_RUNS) return;
    const terminal = [...this.#runs.values()]
      .filter((entry) => terminalWorkflow(entry.snapshot.status))
      .sort((left, right) => left.snapshot.timestamps.updatedAt - right.snapshot.timestamps.updatedAt);
    while (this.#runs.size >= MAX_RETAINED_RUNS && terminal.length) {
      this.#runs.delete(terminal.shift()!.snapshot.runId);
    }
    if (this.#runs.size >= MAX_RETAINED_RUNS) throw new Error(`Workflow retention limit reached (${MAX_RETAINED_RUNS})`);
  }
}

export function aggregateWorkflowUsage(snapshot: WorkflowSnapshot): WorkflowUsage {
  return snapshot.agents.reduce((total, agent) => ({
    input: total.input + agent.usage.input,
    output: total.output + agent.usage.output,
    cacheRead: total.cacheRead + agent.usage.cacheRead,
    cacheWrite: total.cacheWrite + agent.usage.cacheWrite,
    cost: total.cost + agent.usage.cost,
    turns: total.turns + agent.usage.turns,
  }), workflowUsage());
}

function normalizeWorkflowBudget(value: WorkflowBudgetPolicy | undefined): WorkflowBudgetPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow budget must be an object");
  const integer = (name: keyof WorkflowBudgetPolicy, maximum: number) => {
    const item = value[name];
    if (item === undefined) return undefined;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1 || item > maximum) throw new Error(`Workflow budget ${name} must be an integer from 1 to ${maximum}`);
    return item;
  };
  const maxCost = value.maxCost;
  if (maxCost !== undefined && (typeof maxCost !== "number" || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 10_000)) {
    throw new Error("Workflow budget maxCost must be a positive number no greater than 10000");
  }
  return {
    maxAgents: integer("maxAgents", 32),
    maxConcurrency: integer("maxConcurrency", 4),
    maxTokens: integer("maxTokens", 100_000_000),
    maxCost,
    maxTurns: integer("maxTurns", 10_000),
  };
}

function workflowBudgetWarnings(budget: WorkflowBudgetPolicy | undefined): string[] {
  if (!budget) return [];
  const warnings: string[] = [];
  if ((budget.maxAgents ?? 0) > 16) warnings.push(`Large workflow allowance: ${budget.maxAgents} agents`);
  if ((budget.maxConcurrency ?? 0) === 4) warnings.push("Maximum workflow concurrency requested");
  if ((budget.maxTokens ?? 0) > 500_000) warnings.push(`Large token allowance: ${budget.maxTokens} tokens`);
  if ((budget.maxCost ?? 0) > 20) warnings.push(`Large cost allowance: $${budget.maxCost}`);
  return warnings;
}

function workflowSchema(value: unknown): TSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  const annotations = new Set(["$id", "$schema", "title", "description", "default", "examples", "readOnly", "writeOnly"]);
  const numeric = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const nonnegative = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const seen = new WeakSet<object>();
  let nodes = 0;
  const schema = (current: unknown, depth: number): boolean => {
    if (current === true || current === false) return true;
    if (!current || typeof current !== "object" || Array.isArray(current) || seen.has(current) || ++nodes > 2_000 || depth > 16) return false;
    seen.add(current);
    let constraint = false;
    for (const [key, item] of Object.entries(current)) {
      if (["__proto__", "prototype", "constructor", "$ref", "$dynamicRef"].includes(key)) return false;
      if (annotations.has(key)) {
        if (["$id", "$schema", "title", "description"].includes(key) && typeof item !== "string") return false;
        continue;
      }
      if (key === "type") {
        const values = Array.isArray(item) ? item : [item];
        if (!values.length || !values.every((entry) => typeof entry === "string" && types.has(entry))) return false;
        constraint = true;
      } else if (["properties", "patternProperties", "$defs", "dependentSchemas"].includes(key)) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !Object.values(item).every((entry) => schema(entry, depth + 1))) return false;
        constraint = true;
      } else if (["items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else"].includes(key)) {
        if (!schema(item, depth + 1)) return false;
        constraint = true;
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (!Array.isArray(item) || !item.length || !item.every((entry) => schema(entry, depth + 1))) return false;
        constraint = true;
      } else if (key === "required" || key === "dependentRequired") {
        const valid = key === "required"
          ? Array.isArray(item) && item.every((entry) => typeof entry === "string")
          : !!item && typeof item === "object" && !Array.isArray(item) && Object.values(item).every((entry) => Array.isArray(entry) && entry.every((name) => typeof name === "string"));
        if (!valid) return false;
        constraint = true;
      } else if (key === "enum") {
        if (!Array.isArray(item) || !item.length) return false;
        constraint = true;
      } else if (key === "const") {
        constraint = true;
      } else if (numeric.has(key)) {
        if (typeof item !== "number" || !Number.isFinite(item) || nonnegative.has(key) && (!Number.isInteger(item) || item < 0) || key === "multipleOf" && item <= 0) return false;
        constraint = true;
      } else if (key === "pattern") {
        if (typeof item !== "string") return false;
        try { new RegExp(item); } catch { return false; }
        constraint = true;
      } else if (key === "format") {
        if (typeof item !== "string") return false;
        constraint = true;
      } else if (key === "uniqueItems") {
        if (typeof item !== "boolean") return false;
        constraint = true;
      } else {
        return false;
      }
    }
    seen.delete(current);
    return constraint;
  };
  return schema(value, 0) ? value as TSchema : undefined;
}

function parseStructuredOutput(output: string): unknown {
  const text = output.trim();
  const candidate = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : text;
  try { return JSON.parse(candidate); } catch { return undefined; }
}

export function workflowIsTerminal(status: WorkflowStatus): boolean {
  return terminalWorkflow(status);
}
