import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isRequestedHarness, routeCapabilities, type RequestedHarness } from "../capability-routing.ts";
import type { CapabilityRouter } from "../capability-service.ts";
import type { JobManager, PeerInteractionRequest, PeerInteractionResult } from "../manager.ts";
import { isTerminal } from "../manager.ts";
import { renderPeerQuestionPrompt, type PendingInteraction } from "../interactions.ts";
import { normalizeModel } from "../policy.ts";
import { reachedSpendWarning, spendBudgetMetrics, validateSpendBudget } from "../budget.ts";
import { waitDecision, type ProviderUnavailability } from "../provider-unavailability.ts";
import type { AccessMode, BackendEvent, HarnessName, EffortLevel, JobSnapshot, ProfileDefinition, ProviderFamily, SpawnRequest, StructuredOutputSupport, Usage } from "../types.ts";
import {
  appendWorkflowJournal,
  checkpointWorkflow,
  createWorkflowArtifacts,
  loadWorkflowJournal,
  loadWorkflowSummaries,
  readWorkflowRunSummary,
  updateWorkflowRunIsolation,
  writeWorkflowReport,
  writeWorkflowResult,
} from "./artifacts.ts";
import { MAX_CONVERGENCE_ROUNDS } from "./convergence.ts";
import {
  canonicalJson,
  replayableJournalCalls,
  replayableJournalInteractions,
  workflowCallFingerprint,
  workflowDefinitionFingerprint,
  workflowFollowUpFingerprint,
  workflowInteractionFingerprint,
} from "./journal.ts";
import { resolveWorkflowStructured, workflowSchema } from "./schema.ts";
import { runWorkflowSandbox, serializeWorkflowArgs, type WorkflowAgentResult } from "./sandbox.ts";
import { workflowTaskOutcome } from "./outcome.ts";
import { finishWorkflowWorktree, prepareWorkflowWorktree, reclaimWorkflowWorktree, type WorkflowWorktreeHandle, type WorkflowWorktreeReclamation } from "./worktree.ts";
import {
  applyWorkflowRetention,
  DEFAULT_WORKFLOW_RETAINED_RUNS,
  listWorkflowProtectedWorktrees,
  listWorkflowRunProtectedWorktrees,
  openWorkflowSessionLease,
  withWorkflowRetentionLock,
  type WorkflowProtectedWorktree,
  type WorkflowSessionLease,
} from "./retention.ts";
import type {
  WorkflowAgentAttempt,
  WorkflowAgentGeneration,
  WorkflowAgentRecord,
  WorkflowAgentState,
  WorkflowJournalRecord,
  WorkflowJournalResult,
  WorkflowJournalRoute,
  WorkflowApprovalMode,
  WorkflowBudgetPolicy,
  WorkflowConvergence,
  WorkflowInteractionJournalDetail,
  WorkflowInteractionSummary,
  WorkflowReplayInteraction,
  WorkflowPhase,
  WorkflowReplayCall,
  WorkflowReplacementReference,
  WorkflowRetryPolicy,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowStructuredTransport,
  WorkflowUsage,
} from "./types.ts";

const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
const ACCESS = new Set<AccessMode>(["readOnly", "full"]);
const CHECKPOINT_DELAY_MS = 150;
const MAX_WORKFLOW_LOGS = 128;
export const MAX_WORKFLOW_PHASES = 64;
export const MAX_WORKFLOW_PHASE_NAME_LENGTH = 160;
/** Bounded turn history retained per agent lineage; older generations are dropped, newest first preserved. */
const MAX_AGENT_GENERATIONS = 8;
/**
 * Bounded host-routed questions per run. Interactions share the run's hard
 * 32-call ceiling but own a separate ordinal, so asking a question never
 * consumes a sandbox `agent()`/`followUp()` ordinal from inside a child.
 */
export const MAX_WORKFLOW_INTERACTIONS = 32;
/** Bounded interaction history kept on the snapshot for `/workflows`. */
const MAX_WORKFLOW_INTERACTION_HISTORY = 16;
/** followUp() options are presentation/validation only; every policy field stays fixed at the original agent() call. */
const FOLLOWUP_OPTION_KEYS = new Set(["phase", "schema"]);

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
  /** Replay matching completed calls from this terminal run. The definition and execution context must match exactly. */
  resumeFromRunId?: string;
  /** Internal dashboard control: force replay invalidation at this call ordinal. */
  restartFromCallIndex?: number;
  /** Internal replacement provenance set by restartAgent(). */
  replacementOf?: WorkflowReplacementReference;
  approval?: WorkflowApprovalMode;
  budget?: WorkflowBudgetPolicy;
  /** Opt-in provider-quota wait policy; absent preserves today's immediate-failure behavior. */
  retry?: WorkflowRetryPolicy;
}

export interface StartedWorkflow {
  snapshot: WorkflowSnapshot;
  completion: Promise<WorkflowSnapshot>;
}

interface ReplayRuntime {
  sourceRunId: string;
  calls: WorkflowReplayCall[];
  /** Completed peer answers from the source run, matched by identity rather than ordinal. */
  interactions: WorkflowReplayInteraction[];
  /** Ordinals already served in this run, so one record answers at most one question. */
  usedInteractions: Set<number>;
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
  reachedBudgetWarnings: Set<string>;
  metadataReceived: boolean;
  /** Per-call abort controllers for an in-progress provider wait, keyed by callIndex, so `cancelAgent` can end a wait with no active job. */
  providerWaits: Map<number, AbortController>;
  /** Shared, run-wide `retry.maxWaitMs` allowance. Synchronously decremented by every call (sequential or concurrent) so the total time spent waiting across the whole run never exceeds the configured budget. */
  providerWaitBudgetMs: number;
  /** Interaction ordinal assigned to each routed question, keyed by host request ID. */
  interactionOrdinals: Map<string, number>;
}

interface ReplaySource {
  snapshot: WorkflowSnapshot;
  calls: WorkflowReplayCall[];
  interactions: WorkflowReplayInteraction[];
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

function addWorkflowUsage(base: WorkflowUsage | undefined, addition: WorkflowUsage): WorkflowUsage {
  if (!base) return addition;
  return {
    input: base.input + addition.input,
    output: base.output + addition.output,
    cacheRead: base.cacheRead + addition.cacheRead,
    cacheWrite: base.cacheWrite + addition.cacheWrite,
    cost: base.cost + addition.cost,
    turns: base.turns + addition.turns,
  };
}

/** Isolates one attempt's own usage out of a cumulative total, for bounded per-attempt provenance. */
function subtractWorkflowUsage(total: WorkflowUsage, base: WorkflowUsage | undefined): WorkflowUsage {
  if (!base) return total;
  return {
    input: total.input - base.input,
    output: total.output - base.output,
    cacheRead: total.cacheRead - base.cacheRead,
    cacheWrite: total.cacheWrite - base.cacheWrite,
    cost: total.cost - base.cost,
    turns: total.turns - base.turns,
  };
}

/** Injectable clock/timer for provider-wait scheduling; tests supply a controllable fake so they never sleep on a real provider window. */
export interface ProviderWaitClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const DEFAULT_PROVIDER_WAIT_CLOCK: ProviderWaitClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolveSleep, rejectSleep) => {
    if (signal.aborted) { rejectSleep(abortError(signal.reason)); return; }
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); rejectSleep(abortError(signal.reason)); };
    const timer = setTimeout(() => { cleanup(); resolveSleep(); }, Math.max(0, ms));
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  }),
};

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

function normalizePhaseName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validateDeclaredPhasePlan(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORKFLOW_PHASES) {
    throw new Error(`Workflow meta phases must be an array with 1 to ${MAX_WORKFLOW_PHASES} entries`);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw new Error(`Workflow meta phase ${index + 1} must be a string`);
    const name = normalizePhaseName(item);
    if (!name) throw new Error(`Workflow meta phase ${index + 1} must be non-empty after whitespace normalization`);
    if (name.length > MAX_WORKFLOW_PHASE_NAME_LENGTH) {
      throw new Error(`Workflow meta phase ${index + 1} exceeds ${MAX_WORKFLOW_PHASE_NAME_LENGTH} characters after whitespace normalization`);
    }
    if (seen.has(name)) throw new Error(`Workflow meta phase names must be unique after whitespace normalization: ${JSON.stringify(name)}`);
    seen.add(name);
    names.push(name);
  }
  return names;
}

interface PhaseActivationView {
  declared: boolean;
  names: string[];
  currentPhase: number | null;
}

interface PlannedPhaseActivation {
  index: number;
  name: string;
  create: boolean;
}

/**
 * Resolves one phase activation without changing the run. Both real activation
 * and convergence preflight use this planner, so normalization, duplicates,
 * declared-plan order, and the phase cap cannot drift apart.
 */
function planPhaseActivation(view: PhaseActivationView, rawTitle: string): PlannedPhaseActivation {
  const name = view.declared ? normalizePhaseName(rawTitle) : label(rawTitle, "Phase");
  let index = view.names.indexOf(name);
  const create = index < 0;
  if (create) {
    if (view.declared) {
      throw new Error(`Workflow phase ${JSON.stringify(name || "<blank>")} is not declared in the workflow phase plan`);
    }
    if (view.names.length >= MAX_WORKFLOW_PHASES) {
      throw new Error(`Workflow phase limit exceeded (${MAX_WORKFLOW_PHASES})`);
    }
    index = view.names.length;
  }

  const currentIndex = view.currentPhase !== null && view.names[view.currentPhase] !== undefined
    ? view.currentPhase
    : undefined;
  if (currentIndex !== undefined && index < currentIndex) {
    throw new Error(`Workflow phase cannot move backward from ${JSON.stringify(view.names[currentIndex])} to ${JSON.stringify(name)}`);
  }
  return { index, name, create };
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
  for (const key of ["maxAgents", "maxConcurrency", "maxTokens", "maxTokensPerAgent", "maxCost", "maxTurns"] as const) {
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
  readonly #releasePeerRouter: () => void;
  readonly #approveMutation?: (request: { runId: string; workflow: string; agent: string; prompt: string; signal: AbortSignal }) => Promise<boolean>;
  readonly #router?: CapabilityRouter;
  readonly #resolveProfile?: (name: string) => ProfileDefinition | undefined;
  #initializing?: Promise<void>;
  #closed = false;
  #retentionChain: Promise<void> = Promise.resolve();
  #retentionLease?: WorkflowSessionLease;
  readonly #replaySourceRunIds = new Set<string>();
  readonly #maxRetainedRuns: number;
  readonly #providerWaitClock: ProviderWaitClock;

  constructor(options: {
    jobs: JobManager;
    artifactRoot: string;
    sessionId: string;
    approveMutation?: (request: { runId: string; workflow: string; agent: string; prompt: string; signal: AbortSignal }) => Promise<boolean>;
    /** Live capability routing for `requires`/`harness: "auto"`; absent means requirements fail closed. */
    router?: CapabilityRouter;
    resolveProfile?: (name: string) => ProfileDefinition | undefined;
    /** Overrides the retained-run window (default {@link DEFAULT_WORKFLOW_RETAINED_RUNS}); test-only knob, in-memory and on-disk retention always share this one bound. */
    retainedRuns?: number;
    /** Test-only injection point for provider-quota wait scheduling; defaults to a real, abortable, unref'd timer. */
    providerWaitClock?: ProviderWaitClock;
  }) {
    this.#jobs = options.jobs;
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#sessionId = options.sessionId;
    this.#approveMutation = options.approveMutation;
    this.#router = options.router;
    this.#resolveProfile = options.resolveProfile;
    this.#maxRetainedRuns = Number.isSafeInteger(options.retainedRuns) && options.retainedRuns! > 0
      ? options.retainedRuns!
      : DEFAULT_WORKFLOW_RETAINED_RUNS;
    this.#providerWaitClock = options.providerWaitClock ?? DEFAULT_PROVIDER_WAIT_CLOCK;
    this.#unsubscribeJobs = this.#jobs.subscribe((job, event) => this.#updateAgentFromJob(job, event));
    // Same-run peer routing is workflow policy; JobManager owns only the
    // generic lifecycle rules and hands the authorized request over here.
    this.#releasePeerRouter = this.#jobs.setPeerInteractionRouter((request) => this.#answerPeerQuestion(request));
  }

  async initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      const lease = await openWorkflowSessionLease(this.#artifactRoot, this.#sessionId);
      this.#retentionLease = lease;
      try {
        const restored = await withWorkflowRetentionLock(this.#artifactRoot, async () => {
          const loaded = await loadWorkflowSummaries(this.#artifactRoot, { staleAfterMs: 0, sessionId: this.#sessionId });
          const retained = loaded.slice(0, this.#maxRetainedRuns);
          await lease.claimWhileLocked(retained.map((snapshot) => snapshot.runId));
          return retained;
        });
        for (const snapshot of restored) this.#restoreRun(snapshot);
      } catch (error) {
        await lease.close().catch(() => undefined);
        this.#retentionLease = undefined;
        throw error;
      }
      await this.#applyRetention();
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
    const retry = normalizeWorkflowRetry(request.retry);
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
      const source = await this.#loadReplaySource(request.resumeFromRunId);
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
      const calls = restartAt === undefined ? source.calls : source.calls.filter((call) => call.callIndex < restartAt);
      replay = {
        sourceRunId: source.snapshot.runId,
        calls,
        interactions: source.interactions,
        usedInteractions: new Set(),
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
      retry,
      warnings: warnings.length ? warnings : undefined,
      replay: replay ? {
        sourceRunId: replay.sourceRunId,
        matchedCalls: 0,
        invalidatedAt: request.restartFromCallIndex,
      } : undefined,
    };
    await this.#evictOldRuns();
    const lease = this.#retentionLease;
    if (!lease) throw new Error("Workflow session lease is unavailable");
    const snapshot = await withWorkflowRetentionLock(this.#artifactRoot, async () => {
      const created = await createWorkflowArtifacts(this.#artifactRoot, {
        script: request.script,
        args: request.args ?? null,
        snapshot: base,
      });
      await lease.claimWhileLocked([created.runId]);
      return created;
    });
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
      reachedBudgetWarnings: new Set(),
      metadataReceived: false,
      providerWaits: new Map(),
      providerWaitBudgetMs: retry?.maxWaitMs ?? 0,
      interactionOrdinals: new Map(),
    };
    this.#runs.set(snapshot.runId, entry);
    entry.completion = this.#execute(entry, request);
    this.#publish(entry);
    void this.#applyRetention();
    return { snapshot: clone(snapshot), completion: entry.completion };
  }

  /**
   * Bounds on-disk artifacts to the retained-run window. Every run held in
   * `#runs` is protected by this manager's durable session lease, and the
   * retention pass also reads leases written by other open managers.
   */
  #applyRetention(): Promise<void> {
    const next = this.#retentionChain
      .catch(() => undefined)
      .then(() => applyWorkflowRetention(this.#artifactRoot, {
        maxRuns: this.#maxRetainedRuns,
        protectRunIds: [...this.#runs.keys(), ...this.#replaySourceRunIds],
      }))
      .then(() => undefined)
      .catch(() => undefined);
    this.#retentionChain = next;
    return next;
  }

  #restoreRun(snapshot: WorkflowSnapshot): RunEntry {
    const existing = this.#runs.get(snapshot.runId);
    if (existing) return existing;
    const controller = new AbortController();
    const completion = Promise.resolve(clone(snapshot));
    const entry: RunEntry = {
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
      reachedBudgetWarnings: new Set(),
      metadataReceived: true,
      providerWaits: new Map(),
      providerWaitBudgetMs: snapshot.retry?.maxWaitMs ?? 0,
      interactionOrdinals: new Map(),
    };
    this.#runs.set(snapshot.runId, entry);
    return entry;
  }

  /** Loads a replay source from the shared artifact root when it was not
   * restored into this session's history. The retention lock covers the
   * summary and journal read, so a concurrent retention pass cannot delete a
   * source between those reads. Terminal sources remain claimed by this
   * manager while an explicit replay references them. */
  async #loadReplaySource(runId: string): Promise<ReplaySource | undefined> {
    const inMemory = this.#runs.get(runId);
    if (inMemory) {
      const records = await loadWorkflowJournal(this.#artifactRoot, runId);
      return {
        snapshot: inMemory.snapshot,
        calls: replayableJournalCalls(records),
        interactions: replayableJournalInteractions(records),
      };
    }
    const lease = this.#retentionLease;
    if (!lease) throw new Error("Workflow session lease is unavailable");
    return withWorkflowRetentionLock(this.#artifactRoot, async () => {
      const snapshot = await readWorkflowRunSummary(this.#artifactRoot, runId);
      if (!snapshot) return undefined;
      if (!terminalWorkflow(snapshot.status)) return { snapshot, calls: [], interactions: [] };
      await lease.claimWhileLocked([runId]);
      this.#replaySourceRunIds.add(runId);
      const records = await loadWorkflowJournal(this.#artifactRoot, runId);
      return { snapshot, calls: replayableJournalCalls(records), interactions: replayableJournalInteractions(records) };
    });
  }

  /** Enumerates every preserved/orphaned worktree across this manager's artifact root. */
  async listProtectedWorktrees(options: { cwd?: string } = {}): Promise<WorkflowProtectedWorktree[]> {
    return listWorkflowProtectedWorktrees(this.#artifactRoot, options);
  }

  /**
   * Explicit, confirmation-gated reclamation of one preserved or orphaned
   * isolated worktree: removes the Git worktree registration and branch, and
   * persists the resulting `removed` isolation state. Refuses a non-terminal
   * run so reclamation can never race a live checkpointer.
   */
  async reclaimWorktree(input: {
    runId: string;
    agentIndex: number;
    cwd: string;
    /** Literal-typed confirmation gate: this method cannot be called without an explicit caller decision. */
    confirmed: true;
    force?: boolean;
  }): Promise<{ reclamation: WorkflowWorktreeReclamation; worktree: WorkflowProtectedWorktree }> {
    const entry = this.#runs.get(input.runId);
    const snapshot = entry?.snapshot ?? await readWorkflowRunSummary(this.#artifactRoot, input.runId);
    if (!snapshot) throw new Error(`Unknown workflow run: ${input.runId}`);
    if (!terminalWorkflow(snapshot.status)) throw new Error("Cannot reclaim a worktree from an active workflow run");
    const worktrees = await listWorkflowRunProtectedWorktrees(this.#artifactRoot, input.runId);
    const worktree = worktrees.find((candidate) => candidate.agentIndex === input.agentIndex);
    if (!worktree) throw new Error(`No protected worktree for agent ${input.agentIndex} in workflow ${input.runId}`);
    if (worktree.state === "active") throw new Error("Cannot reclaim a live worktree from an active checkpoint");
    const reclamation = await reclaimWorkflowWorktree({
      cwd: input.cwd,
      artifactDir: snapshot.artifactDir,
      runId: input.runId,
      agentIndex: input.agentIndex,
      branch: worktree.branch,
      state: worktree.state,
      patchArtifact: worktree.patchArtifact,
      force: input.force,
    });
    const isolation = {
      type: "worktree" as const,
      state: "removed" as const,
      branch: worktree.branch,
      changed: true,
      patchArtifact: worktree.patchArtifact,
      error: worktree.error,
      reclaimedAt: Date.now(),
    };
    const agent = entry?.snapshot.agents[input.agentIndex];
    if (entry && agent) {
      agent.isolation = isolation;
      this.#touch(entry);
      await this.#flushCheckpoint(entry);
    } else {
      try { await updateWorkflowRunIsolation(this.#artifactRoot, input.runId, input.agentIndex, isolation); }
      catch (error) {
        reclamation.warnings.push(`Reclaimed the Git worktree, but could not update the run record: ${boundedText(error)}`);
      }
    }
    void this.#applyRetention();
    return { reclamation, worktree };
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
    if (agent.state === "waiting") {
      const controller = agent.callIndex === undefined ? undefined : entry.providerWaits.get(agent.callIndex);
      if (controller) controller.abort(new Error(reason));
      return this.check(runId);
    }
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
    let activeSettled = active.length === 0;
    const activeCompletion = Promise.allSettled(active.map((entry) => entry.completion)).then(() => {
      activeSettled = true;
    });
    await Promise.race([
      activeCompletion,
      new Promise<void>((resolveDeadline) => { timer = setTimeout(resolveDeadline, Math.max(0, timeoutMs)); }),
    ]);
    if (timer) clearTimeout(timer);
    this.#unsubscribeJobs();
    this.#releasePeerRouter();
    for (const entry of this.#runs.values()) {
      if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
      entry.checkpointTimer = undefined;
    }
    this.#listeners.clear();
    const lease = this.#retentionLease;
    if (lease) {
      this.#retentionLease = undefined;
      if (activeSettled) await lease.close().catch(() => undefined);
      else void activeCompletion.then(() => lease.close()).catch(() => undefined);
    }
  }

  async #execute(entry: RunEntry, request: StartWorkflowRequest): Promise<WorkflowSnapshot> {
    try {
      const sandbox = await runWorkflowSandbox({
        source: request.script,
        args: request.args ?? null,
        cwd: request.cwd,
        signal: entry.controller.signal,
        maxAgentCalls: entry.snapshot.budget?.maxAgents ?? 32,
        onMeta: (meta) => this.#applyMeta(entry, meta, true),
        onPhase: (title) => this.#activatePhase(entry, title),
        onPhaseCapacity: (titles) => this.#phaseCapacity(entry, titles),
        onLog: (message) => this.#recordLog(entry, message),
        onConvergence: (progress) => this.#recordConvergence(entry, progress),
        onAgent: (prompt, options, signal, callIndex) => this.#runAgent(entry, request, prompt, options, signal, callIndex),
        onFollowUp: (jobId, prompt, options, signal, callIndex) => this.#runFollowUpCall(entry, request, jobId, prompt, options, signal, callIndex),
      });
      this.#applyMeta(entry, sandbox.meta, false);
      entry.snapshot.result = sandbox.result;
      entry.snapshot.status = "completed";
      entry.snapshot.taskOutcome = workflowTaskOutcome(sandbox.result);
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
      await this.#releaseMemberRuns(entry);
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
      kind: "agent",
      state: "started",
      at: Date.now(),
    });
    await this.#waitUntilResumed(entry, signal);

    const expected = entry.replay?.active && callIndex < (entry.snapshot.budget?.maxAgents ?? 32)
      ? entry.replay.calls.find((call) => call.callIndex === callIndex)
      : undefined;
    if (entry.replay?.active && expected?.fingerprint === fingerprint && expected.kind === "agent") {
      const record = this.#recordReplayedAgent(entry, prompt, options, callIndex, fingerprint, expected);
      entry.snapshot.replay!.matchedCalls++;
      await this.#appendJournal(entry, {
        callIndex,
        fingerprint,
        kind: "agent",
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
      entry.snapshot.replay!.invalidatedAt ??= callIndex;
      this.#touch(entry);
    }

    type Attempt = WorkflowAgentResult & { unavailable?: ProviderUnavailability; progressed?: boolean };
    let result: Attempt;
    const policy = entry.snapshot.retry;
    let record: WorkflowAgentRecord | undefined;
    let pinnedHarness: HarnessName | undefined;
    let attempt = 0;
    for (;;) {
      try {
        const attemptRetry = record ? { record, attempt, pinnedHarness } : undefined;
        const execute = () => this.#runFreshAgent(entry, request, prompt, options, signal, callIndex, fingerprint, attemptRetry);
        const isolated = () => options.access === "readOnly" || options.isolation === "worktree"
          ? execute()
          : this.#withMutationLock(request.cwd, signal, execute);
        result = await this.#withDispatchSlot(entry, signal, isolated);
      } catch (error) {
        const failed = { ok: false, output: "", error: boundedText(error) } satisfies WorkflowJournalResult;
        const failedRecord = record ?? entry.snapshot.agents.find((candidate) => candidate.callIndex === callIndex);
        await this.#appendJournal(entry, {
          callIndex,
          fingerprint,
          kind: "agent",
          state: "failed",
          at: Date.now(),
          agentIndex: failedRecord?.index,
          result: failed,
          route: journalRoute(failedRecord),
        });
        throw error;
      }
      record ??= entry.snapshot.agents.find((candidate) => candidate.callIndex === callIndex);
      if (result.ok || !policy || policy.providerUnavailable !== "wait" || !record) break;
      // `entry.providerWaitBudgetMs` is a run-wide allowance shared by every logical
      // call, including concurrent ones from `parallel()`. Reading and decrementing
      // it here happens synchronously (no `await` in between), so concurrent calls
      // never see a stale or double-spent balance.
      const decision = this.#planProviderWait(record, result, policy, attempt, entry.providerWaitBudgetMs);
      if (!decision.wait) {
        result = { ok: false, output: result.output, jobId: result.jobId, error: decision.reason, usage: result.usage };
        break;
      }
      pinnedHarness ??= record.harness as HarnessName | undefined;
      const unavailable = result.unavailable!;
      entry.providerWaitBudgetMs = Math.max(0, entry.providerWaitBudgetMs - Math.max(0, decision.until - this.#providerWaitClock.now()));
      const maxAttempts = policy.maxAttempts ?? 1;
      this.#beginProviderWait(entry, record, unavailable, decision.until, attempt + 1, maxAttempts);
      const waitController = new AbortController();
      entry.providerWaits.set(callIndex, waitController);
      const bridgeAbort = () => waitController.abort(signal.reason);
      if (signal.aborted) bridgeAbort();
      else signal.addEventListener("abort", bridgeAbort, { once: true });
      try {
        await this.#providerWaitClock.sleep(Math.max(0, decision.until - this.#providerWaitClock.now()), waitController.signal);
        await this.#waitUntilResumed(entry, waitController.signal);
      } catch (error) {
        signal.removeEventListener("abort", bridgeAbort);
        entry.providerWaits.delete(callIndex);
        // A waiting call has no active job, so nothing else moves it out of
        // "waiting" on cancellation; settle it explicitly before journaling,
        // both to leave a clean terminal record and because "waiting" is not
        // a valid persisted route status.
        record.state = "cancelled";
        record.providerWait = undefined;
        record.error = boundedText(error);
        record.timestamps.updatedAt = Date.now();
        record.timestamps.endedAt = record.timestamps.updatedAt;
        this.#touch(entry);
        const failed = { ok: false, output: "", error: boundedText(error) } satisfies WorkflowJournalResult;
        await this.#appendJournal(entry, {
          callIndex,
          fingerprint,
          kind: "agent",
          state: "failed",
          at: Date.now(),
          agentIndex: record.index,
          result: failed,
          route: journalRoute(record),
        });
        throw error;
      }
      signal.removeEventListener("abort", bridgeAbort);
      entry.providerWaits.delete(callIndex);
      attempt++;
    }
    const finalRecord = record ?? entry.snapshot.agents.find((candidate) => candidate.callIndex === callIndex);
    const sanitized: WorkflowAgentResult = {
      ok: result.ok,
      output: result.output,
      jobId: result.jobId,
      error: result.error,
      usage: result.usage,
      structured: result.structured,
      // Machine-readable budget marker, preserved so a bounded convergence
      // loop reports `limit-reached` rather than parsing failure prose.
      limit: result.limit,
    };
    await this.#appendJournal(entry, {
      callIndex,
      fingerprint,
      kind: "agent",
      state: sanitized.ok ? "completed" : "failed",
      at: Date.now(),
      agentIndex: finalRecord?.index,
      result: { ...clone(sanitized), transport: finalRecord?.structuredTransport } as WorkflowJournalResult,
      route: journalRoute(finalRecord),
      replacementOf: entry.snapshot.replacementOf ? clone(entry.snapshot.replacementOf) : undefined,
    });
    return sanitized;
  }

  /**
   * Continues a completed workflow-owned agent's retained native session.
   * Ownership, retention, and policy are enforced before any dispatch: the
   * target must be a job this run's own agent() call started and must still
   * be completed with a retained session, and followUp() options may only
   * touch presentation/validation fields, never policy.
   */
  async #runFollowUpCall(
    entry: RunEntry,
    request: StartWorkflowRequest,
    jobId: string,
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
    callIndex: number,
  ): Promise<WorkflowAgentResult> {
    if (callIndex !== entry.nextCallIndex || callIndex < 0 || callIndex >= 32) {
      throw new Error(`Workflow agent call ordinal is invalid or out of sequence: ${callIndex}`);
    }
    entry.nextCallIndex++;
    const fingerprint = workflowFollowUpFingerprint({ jobId, prompt, options });
    await this.#appendJournal(entry, {
      callIndex,
      fingerprint,
      kind: "followUp",
      state: "started",
      at: Date.now(),
    });
    await this.#waitUntilResumed(entry, signal);

    const expected = entry.replay?.active && callIndex < (entry.snapshot.budget?.maxAgents ?? 32)
      ? entry.replay.calls.find((call) => call.callIndex === callIndex)
      : undefined;
    if (entry.replay?.active && expected?.fingerprint === fingerprint && expected.kind === "followUp") {
      // Reattach by the lineage's stable native jobId rather than the journaled
      // agentIndex: that index reflects push order under the ORIGINAL run's
      // (possibly reordered) parallel dispatch completion, which can differ
      // from this reconstruction's push order and would otherwise mislabel
      // a sibling agent's record.
      const targetIndex = entry.snapshot.agents.findIndex((candidate) => candidate.jobId === jobId);
      const record = targetIndex < 0 ? undefined : this.#recordReplayedFollowUp(entry, targetIndex, prompt, callIndex, fingerprint, expected);
      if (!record) {
        const error = "Workflow follow-up replay could not locate its source agent lineage";
        await this.#appendJournal(entry, { callIndex, fingerprint, kind: "followUp", state: "failed", at: Date.now(), result: { ok: false, output: "", error } });
        return { ok: false, output: "", error };
      }
      entry.snapshot.replay!.matchedCalls++;
      await this.#appendJournal(entry, {
        callIndex,
        fingerprint,
        kind: "followUp",
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
      entry.snapshot.replay!.invalidatedAt ??= callIndex;
      this.#touch(entry);
    }

    let result: WorkflowAgentResult;
    try {
      const execute = () => this.#runFreshFollowUp(entry, request, jobId, prompt, options, signal, callIndex, fingerprint);
      const owner = this.#jobOwners.get(jobId);
      const targetAgent = owner?.runId === entry.snapshot.runId ? entry.snapshot.agents[owner.agentIndex] : undefined;
      const isolated = () => targetAgent?.access === "readOnly"
        ? execute()
        : this.#withMutationLock(request.cwd, signal, execute);
      result = await this.#withDispatchSlot(entry, signal, isolated);
    } catch (error) {
      const failed = { ok: false, output: "", error: boundedText(error) } satisfies WorkflowJournalResult;
      const owner = this.#jobOwners.get(jobId);
      const record = owner?.runId === entry.snapshot.runId ? entry.snapshot.agents[owner.agentIndex] : undefined;
      await this.#appendJournal(entry, {
        callIndex,
        fingerprint,
        kind: "followUp",
        state: "failed",
        at: Date.now(),
        agentIndex: record?.index,
        result: failed,
        route: journalRoute(record),
        replacementOf: entry.snapshot.replacementOf ? clone(entry.snapshot.replacementOf) : undefined,
      });
      throw error;
    }
    const owner = this.#jobOwners.get(jobId);
    const record = owner?.runId === entry.snapshot.runId ? entry.snapshot.agents[owner.agentIndex] : undefined;
    await this.#appendJournal(entry, {
      callIndex,
      fingerprint,
      kind: "followUp",
      state: result.ok ? "completed" : "failed",
      at: Date.now(),
      agentIndex: record?.index,
      result: { ...clone(result), transport: record?.structuredTransport } as WorkflowJournalResult,
      route: journalRoute(record),
      replacementOf: entry.snapshot.replacementOf ? clone(entry.snapshot.replacementOf) : undefined,
    });
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
    retry?: { record: WorkflowAgentRecord; attempt: number; pinnedHarness?: HarnessName },
  ): Promise<WorkflowAgentResult & { unavailable?: ProviderUnavailability; progressed?: boolean }> {
    if (!prompt.trim()) return { ok: false, output: "", error: "agent() requires a non-empty prompt" };
    const preflightError = this.#budgetPreflight(entry);
    if (preflightError) return { ok: false, output: "", error: preflightError, limit: "budget" };
    if (["role", "agent", "tier", "modelTier", "modelProfile", "backend"].some((key) => Object.hasOwn(options, key))) {
      return { ok: false, output: "", error: "Workflow agent() API schema mismatch: use the current task-driven schema." };
    }
    // A provider-wait redispatch always reuses the harness the first attempt
    // actually resolved to, so waiting can never move a call to a different provider.
    const harness = retry?.pinnedHarness ?? (options.harness === undefined ? undefined : String(options.harness) as RequestedHarness);
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
      return { ok: false, output: "", error: `Workflow agent budget exceeded (${entry.snapshot.budget?.maxAgents} calls)`, limit: "budget" };
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

    const phase = retry ? retry.record.phase : this.#resolveAgentPhase(entry, options.phase);
    if (!retry) this.#markPhaseRunning(entry, phase);
    const index = retry ? retry.record.index : entry.snapshot.agents.length;
    const name = retry ? retry.record.name : label(options.name ?? options.label, `agent-${index + 1}`);
    const now = Date.now();
    let record: WorkflowAgentRecord;
    if (retry) {
      record = retry.record;
      const attempts = record.attempts ??= [];
      attempts.push({
        jobId: record.jobId,
        harness: record.harness,
        model: record.model,
        error: record.error,
        // record.usage is already cumulative (prior retryUsage + this attempt's own
        // usage); isolate just this attempt's contribution for bounded provenance.
        usage: subtractWorkflowUsage(record.usage, record.retryUsage),
        endedAt: record.timestamps.endedAt,
      } satisfies WorkflowAgentAttempt);
      if (attempts.length > 4) attempts.splice(0, attempts.length - 4);
      // record.usage already includes every prior attempt (see above), so the new
      // baseline for the next attempt IS record.usage, not retryUsage + record.usage
      // — adding retryUsage again would double-count every attempt before this one.
      record.retryUsage = record.usage;
      record.usage = workflowUsage();
      record.providerWait = undefined;
      record.state = "queued";
      record.jobId = undefined;
      record.error = undefined;
      record.tools = [];
      record.transcript = undefined;
      record.liveThinking = undefined;
      record.truncated = undefined;
      record.timestamps.updatedAt = now;
      record.timestamps.endedAt = undefined;
    } else {
      record = {
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
    }
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
    let structuredTransport: WorkflowStructuredTransport | undefined;
    try {
      const routing = await routeCapabilities(this.#router, {
        request: {
          name,
          task: prompt,
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
      const spawnRequest = {
        name,
        task: prompt,
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
        structuredOutput: undefined as { schema: Record<string, unknown> } | undefined,
        workflow: {
          runId: entry.snapshot.runId,
          agentIndex: index,
          label: record.name,
          phase: entry.snapshot.phases[phase]?.name,
        },
        dispatchGate: () => this.#budgetPreflight(entry),
        // A workflow child may ask an authorized same-run peer, and may wake the
        // parent orchestrator only when this run is itself in the background:
        // a foreground workflow's parent turn is blocked awaiting the workflow
        // tool result and cannot safely start another turn.
        interaction: { orchestrator: entry.snapshot.background ? "allow" : "foregroundDenied", peers: true },
        interactionGate: (target) => this.#interactionGate(entry, target),
      } satisfies SpawnRequest;
      if (schema) {
        // Transport is decided against the exact harness compilePolicy will
        // pick for this spawnRequest, never a re-derived guess: capability
        // routing, requires, independence, profile locks, and defaultHarness
        // all stay authoritative over native structured-output selection.
        const targetHarness = this.#jobs.resolveHarness(spawnRequest);
        const support = await this.#router?.structuredOutput?.(targetHarness, {
          cwd: agentCwd,
          access: access ?? "full",
          model,
          signal,
        }).catch((error): StructuredOutputSupport => ({ supported: false, detail: boundedText(error) }));
        structuredTransport = support?.supported ? "native" : "portable";
        if (structuredTransport === "native") {
          spawnRequest.structuredOutput = { schema: schema as Record<string, unknown> };
          record.nativeStructuredSchema = schema as Record<string, unknown>;
        }
        spawnRequest.task = structuredTransport === "native"
          ? prompt
          : `${prompt}\n\nReturn ONLY valid JSON matching this JSON Schema (no markdown fences):\n${JSON.stringify(schema)}`;
        record.structuredTransport = structuredTransport;
        this.#touch(entry);
      }
      this.#jobs.assertSpendBudgetSupported(spawnRequest, entry.snapshot.budget);
      job = this.#jobs.spawn(spawnRequest);
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
          const outcome = resolveWorkflowStructured(schema, structuredTransport, final);
          if (!outcome.ok) {
            record.state = "failed";
            record.error = outcome.error;
            record.timestamps.updatedAt = Date.now();
            record.timestamps.endedAt = record.timestamps.updatedAt;
            record.structured = undefined;
            this.#touch(entry);
            return { ok: false, output: final.output, jobId: final.id, error: outcome.error, usage: clone(final.usage) };
          }
          record.structured = outcome.value;
          this.#touch(entry);
          return { ok: true, output: final.output, structured: outcome.value, jobId: final.id, usage: clone(final.usage) };
        }
        return { ok: true, output: final.output, jobId: final.id, usage: clone(final.usage) };
      }
      return {
        ok: false,
        output: final.output,
        jobId: final.id,
        error: final.error ?? `Agent ${final.status}`,
        usage: clone(final.usage),
        unavailable: final.unavailable,
        progressed: final.progressed,
      };
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

  /** Snapshot a record's current (pre-follow-up) fields as generation 0, so a
   * lineage that never received a follow-up before now still has a complete
   * generation history once one starts. */
  #snapshotGeneration(record: WorkflowAgentRecord): WorkflowAgentGeneration {
    return {
      index: 0,
      callIndex: record.callIndex ?? 0,
      prompt: record.prompt,
      state: record.state,
      output: record.output,
      structured: record.structured,
      structuredTransport: record.structuredTransport,
      error: record.error,
      outputProvenance: record.outputProvenance,
      timestamps: { ...record.timestamps },
    };
  }

  async #runFreshFollowUp(
    entry: RunEntry,
    request: StartWorkflowRequest,
    jobId: string,
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
    callIndex: number,
    fingerprint: string,
  ): Promise<WorkflowAgentResult> {
    if (!prompt.trim()) return { ok: false, output: "", error: "followUp() requires a non-empty prompt" };
    const disallowed = Object.keys(options).filter((key) => !FOLLOWUP_OPTION_KEYS.has(key));
    if (disallowed.length) {
      return { ok: false, output: "", error: `followUp() does not accept policy options: ${disallowed.join(", ")}` };
    }
    const owner = this.#jobOwners.get(jobId);
    if (!owner || owner.runId !== entry.snapshot.runId) {
      return { ok: false, output: "", error: `followUp() target ${jobId} does not belong to this workflow run` };
    }
    const record = entry.snapshot.agents[owner.agentIndex];
    if (!record) return { ok: false, output: "", error: `followUp() target ${jobId} is unknown` };
    if (record.isolation) {
      return { ok: false, output: "", error: `followUp() target ${jobId} used an isolated worktree that already finalized (${record.isolation.state}) and cannot continue` };
    }
    if (callIndex >= (entry.snapshot.budget?.maxAgents ?? 32)) {
      return { ok: false, output: "", error: `Workflow agent budget exceeded (${entry.snapshot.budget?.maxAgents} calls)`, limit: "budget" };
    }
    const preflightError = this.#budgetPreflight(entry);
    if (preflightError) return { ok: false, output: "", error: preflightError, limit: "budget" };
    const schema = options.schema === undefined ? undefined : workflowSchema(options.schema);
    if (options.schema !== undefined && !schema) {
      return { ok: false, output: "", error: "followUp schema must be a bounded JSON Schema object" };
    }
    // A retained native session is schema-bound at agent() time (the SDK
    // exposes no way to change outputFormat mid-session): followUp() may
    // reuse that exact schema, or omit schema and still receive it validated,
    // but cannot request a different one.
    const nativeLineage = record.structuredTransport === "native" && record.nativeStructuredSchema;
    if (nativeLineage && schema && canonicalJson(schema) !== canonicalJson(record.nativeStructuredSchema)) {
      return { ok: false, output: "", error: "followUp() cannot change the schema of a native structured lineage; the retained session is bound to its agent() schema" };
    }
    const effectiveSchema = nativeLineage ? workflowSchema(record.nativeStructuredSchema) : schema;
    // Snapshot generation 0 from the record's pre-follow-up fields before any
    // mutation below, then re-derive structuredTransport strictly for this
    // call: it must not linger from a schema-bearing agent() call now
    // followed by a schemaless followUp() (or the reverse).
    record.generations ??= [this.#snapshotGeneration(record)];
    record.structuredTransport = nativeLineage ? "native" : effectiveSchema ? "portable" : undefined;
    const message = nativeLineage || !schema
      ? prompt
      : `${prompt}\n\nReturn ONLY valid JSON matching this JSON Schema (no markdown fences):\n${JSON.stringify(schema)}`;
    // Phase validation/progression mirrors agent(), but a follow-up continues
    // its original lineage card rather than relisting it under a new phase.
    const phase = this.#resolveAgentPhase(entry, options.phase);
    this.#markPhaseRunning(entry, phase);

    const now = Date.now();
    record.generations.push({
      index: record.generations.length,
      callIndex,
      prompt: boundedText(prompt, 2 * 1024),
      state: "queued",
      timestamps: { createdAt: now, updatedAt: now },
    });
    if (record.generations.length > MAX_AGENT_GENERATIONS) record.generations.splice(0, record.generations.length - MAX_AGENT_GENERATIONS);
    record.callIndex = callIndex;
    record.callFingerprint = fingerprint;
    record.state = "queued";
    record.prompt = boundedText(prompt, 2 * 1024);
    record.error = undefined;
    record.structured = undefined;
    record.timestamps.updatedAt = now;
    this.#touch(entry);

    let queued: JobSnapshot;
    try {
      queued = await this.#jobs.continueWorkflowJob(jobId, message);
    } catch (error) {
      const failure = boundedText(error);
      record.state = "failed";
      record.error = failure;
      record.timestamps.updatedAt = Date.now();
      record.timestamps.endedAt = record.timestamps.updatedAt;
      const generation = record.generations.at(-1);
      if (generation) {
        generation.state = "failed";
        generation.error = failure;
        generation.timestamps = { ...generation.timestamps, updatedAt: record.timestamps.updatedAt, endedAt: record.timestamps.endedAt };
      }
      this.#touch(entry);
      return { ok: false, output: "", error: failure };
    }
    this.#updateAgentFromJob(queued);

    const abort = () => { void this.#jobs.cancel(jobId, "Workflow follow-up cancelled").catch(() => undefined); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      const final = await this.#jobs.wait(jobId, { signal });
      this.#updateAgentFromJob(final);
      if (final.status === "completed") {
        if (effectiveSchema) {
          const outcome = resolveWorkflowStructured(effectiveSchema, nativeLineage ? "native" : "portable", final);
          const generation = record.generations.at(-1);
          if (!outcome.ok) {
            record.state = "failed";
            record.error = outcome.error;
            record.timestamps.updatedAt = Date.now();
            record.timestamps.endedAt = record.timestamps.updatedAt;
            record.structured = undefined;
            if (generation) {
              generation.state = "failed";
              generation.error = outcome.error;
              generation.structured = undefined;
              generation.structuredTransport = nativeLineage ? "native" : "portable";
              generation.timestamps = { ...generation.timestamps, updatedAt: record.timestamps.updatedAt, endedAt: record.timestamps.endedAt };
            }
            this.#touch(entry);
            return { ok: false, output: final.output, jobId: final.id, error: outcome.error, usage: clone(final.usage) };
          }
          record.structured = outcome.value;
          if (generation) {
            generation.structured = outcome.value;
            generation.structuredTransport = nativeLineage ? "native" : "portable";
          }
          this.#touch(entry);
          return { ok: true, output: final.output, structured: outcome.value, jobId: final.id, usage: clone(final.usage) };
        }
        return { ok: true, output: final.output, jobId: final.id, usage: clone(final.usage) };
      }
      return { ok: false, output: final.output, jobId: final.id, error: final.error ?? `Agent ${final.status}`, usage: clone(final.usage) };
    } catch (error) {
      await this.#jobs.cancel(jobId, "Workflow follow-up wait aborted").catch(() => undefined);
      const final = this.#jobs.check(jobId);
      this.#updateAgentFromJob(final);
      return { ok: false, output: final.output, jobId: final.id, error: boundedText(error), usage: clone(final.usage) };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  #recordReplayedFollowUp(
    entry: RunEntry,
    targetAgentIndex: number,
    prompt: string,
    callIndex: number,
    fingerprint: string,
    replay: WorkflowReplayCall,
  ): WorkflowAgentRecord | undefined {
    const record = entry.snapshot.agents[targetAgentIndex];
    if (!record) return undefined;
    const now = Date.now();
    const structured = replay.result.structured === undefined ? undefined : clone(replay.result.structured);
    record.generations ??= [this.#snapshotGeneration(record)];
    record.generations.push({
      index: record.generations.length,
      callIndex,
      prompt: boundedText(prompt, 2 * 1024),
      state: "completed",
      output: replay.result.output,
      structured,
      structuredTransport: replay.result.transport,
      outputProvenance: "replay",
      timestamps: { createdAt: now, updatedAt: now, startedAt: now, endedAt: now },
    });
    if (record.generations.length > MAX_AGENT_GENERATIONS) record.generations.splice(0, record.generations.length - MAX_AGENT_GENERATIONS);
    record.callIndex = callIndex;
    record.callFingerprint = fingerprint;
    record.outputProvenance = "replay";
    record.instructionShaped = looksInstructionShaped(replay.result.output);
    record.prompt = boundedText(prompt, 2 * 1024);
    record.state = "completed";
    record.output = replay.result.output;
    record.structured = structured;
    record.structuredTransport = replay.result.transport;
    record.error = undefined;
    record.timestamps.updatedAt = now;
    record.timestamps.endedAt = now;
    this.#touch(entry);
    return record;
  }

  #recordReplayedAgent(
    entry: RunEntry,
    prompt: string,
    options: Record<string, unknown>,
    callIndex: number,
    fingerprint: string,
    replay: WorkflowReplayCall,
  ): WorkflowAgentRecord {
    const phase = this.#resolveAgentPhase(entry, options.phase);
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
      structuredTransport: replay.result.transport,
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
    await this.#acquireDispatchSlot(entry, signal);
    try { return await operation(); }
    finally { this.#releaseDispatchSlot(entry); }
  }

  async #acquireDispatchSlot(entry: RunEntry, signal: AbortSignal): Promise<void> {
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
  }

  #releaseDispatchSlot(entry: RunEntry): void {
    entry.activeDispatches--;
    const ready = entry.dispatchWaiters.values().next().value as (() => void) | undefined;
    if (ready) {
      entry.dispatchWaiters.delete(ready);
      ready();
    }
  }

  /**
   * Runs a peer-answer turn under the same workflow dispatch limit as ordinary
   * calls. The asking agent still owns its own dispatch slot but is parked in a
   * host tool callback and performs no inference, so its slot is handed back
   * first: otherwise a run with maxConcurrency 1 would deadlock against itself.
   * The slot is always taken back before the caller resumes, including on abort,
   * so the caller's own `finally` releases exactly one slot.
   */
  async #withParkedDispatchSlot<T>(entry: RunEntry, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    this.#releaseDispatchSlot(entry);
    try {
      return await this.#withDispatchSlot(entry, signal, operation);
    } finally {
      try { await this.#acquireDispatchSlot(entry, signal); }
      catch { entry.activeDispatches++; }
    }
  }

  /* ── routed interactions ─────────────────────────────────────────────── */

  /**
   * Admission check for one routed question, run before any interaction state
   * exists. Bounds the run's interaction count and refuses to open a question
   * the run could not afford to answer anyway.
   */
  #interactionGate(entry: RunEntry, target: "orchestrator" | "agent"): string | undefined {
    if (terminalWorkflow(entry.snapshot.status)) return `Workflow ${entry.snapshot.runId} already ${entry.snapshot.status}`;
    if (entry.interactionOrdinals.size >= MAX_WORKFLOW_INTERACTIONS) {
      return `Workflow interaction budget exhausted (${MAX_WORKFLOW_INTERACTIONS} routed questions)`;
    }
    // A peer answer is a real model turn on the target lineage; an orchestrator
    // answer costs this run no provider work, so it is not budget-gated here.
    return target === "agent" ? this.#budgetPreflight(entry) : undefined;
  }

  /** Stable interaction ordinal for one host request, allocated on first sight. */
  #interactionOrdinal(entry: RunEntry, requestId: string): number {
    const existing = entry.interactionOrdinals.get(requestId);
    if (existing !== undefined) return existing;
    const ordinal = entry.interactionOrdinals.size;
    entry.interactionOrdinals.set(requestId, ordinal);
    return ordinal;
  }

  /**
   * Mirrors one routed-question transition onto the run so `/workflows` can
   * distinguish an interaction wait from a provider-quota wait, scheduler
   * queueing, or a user pause. Authoritative state stays in `JobManager`.
   */
  #applyInteractionEvent(job: JobSnapshot, event: BackendEvent): void {
    const owner = this.#jobOwners.get(job.id);
    if (!owner) return;
    const entry = this.#runs.get(owner.runId);
    const agent = entry?.snapshot.agents[owner.agentIndex];
    if (!entry || !agent) return;
    if (event.type === "interaction_answering") {
      agent.answering = event.answering
        ? {
            requestId: event.answering.requestId,
            sourceAgentIndex: this.#jobOwners.get(event.answering.sourceJobId)?.agentIndex,
            sourceName: event.answering.sourceName,
          }
        : undefined;
      this.#touch(entry);
      return;
    }
    if (event.type === "interaction_cleared") {
      if (agent.waitingOn?.requestId === event.requestId) agent.waitingOn = undefined;
      this.#touch(entry);
      return;
    }
    if (event.type !== "interaction") return;
    const summary = this.#interactionSummary(entry, owner.agentIndex, agent.name, event.interaction);
    agent.waitingOn = summary.state === "pending" || summary.state === "answering" ? summary : undefined;
    const history = entry.snapshot.interactions ??= [];
    const index = history.findIndex((item) => item.requestId === summary.requestId);
    if (index >= 0) history[index] = summary;
    else history.push(summary);
    if (history.length > MAX_WORKFLOW_INTERACTION_HISTORY) history.splice(0, history.length - MAX_WORKFLOW_INTERACTION_HISTORY);
    this.#touch(entry);
  }

  #interactionSummary(
    entry: RunEntry,
    sourceAgentIndex: number,
    sourceName: string,
    interaction: PendingInteraction,
  ): WorkflowInteractionSummary {
    const targetAgentIndex = interaction.target.jobId
      ? entry.snapshot.agents.findIndex((candidate) => candidate.jobId === interaction.target.jobId)
      : -1;
    return {
      ordinal: this.#interactionOrdinal(entry, interaction.requestId),
      requestId: interaction.requestId,
      target: interaction.target.kind === "orchestrator" ? "orchestrator" : "peer",
      sourceAgentIndex,
      sourceName,
      targetAgentIndex: targetAgentIndex >= 0 ? targetAgentIndex : undefined,
      targetName: targetAgentIndex >= 0 ? entry.snapshot.agents[targetAgentIndex].name : interaction.target.label,
      question: boundedText(interaction.question, 2 * 1024),
      context: interaction.context ? boundedText(interaction.context, 2 * 1024) : undefined,
      state: interaction.state,
      route: interaction.route,
      createdAt: interaction.createdAt,
      answeredAt: interaction.answeredAt,
      answer: interaction.answer ? boundedText(interaction.answer, 4 * 1024) : undefined,
      error: interaction.error,
    };
  }

  /**
   * Answers one same-workflow peer question. `JobManager` has already enforced
   * the generic rules (authorized policy, not self, one outstanding question,
   * no wait cycle, live target still completed and retained); this owns the
   * workflow-specific ones: run membership, worktree eligibility, budgets,
   * durable journalling, and replay of a recorded answer when the target
   * lineage was itself replayed and has no live session left.
   */
  async #answerPeerQuestion(request: PeerInteractionRequest): Promise<PeerInteractionResult> {
    const owner = this.#jobOwners.get(request.source.id);
    if (!owner) throw new Error("Peer questions are limited to workflow-owned agents");
    const entry = this.#runs.get(owner.runId);
    if (!entry) throw new Error("The asking agent's workflow run is no longer active");
    if (terminalWorkflow(entry.snapshot.status)) throw new Error(`Workflow ${entry.snapshot.runId} already ${entry.snapshot.status}`);
    const source = entry.snapshot.agents[owner.agentIndex];
    if (!source) throw new Error("The asking agent is no longer part of this workflow run");
    const targetIndex = entry.snapshot.agents.findIndex((candidate) => candidate.jobId === request.targetJobId);
    const target = targetIndex >= 0 ? entry.snapshot.agents[targetIndex] : undefined;
    if (!target || targetIndex === owner.agentIndex) {
      throw new Error(`Peer agent ${request.targetJobId} does not belong to this workflow run`);
    }
    if (target.isolation) {
      throw new Error(`Peer agent ${target.name} ran in an isolated worktree that already finalized (${target.isolation.state}); its retained session is intentionally unavailable`);
    }
    if (target.state !== "completed") {
      throw new Error(`Peer agent ${target.name} is ${target.state}; only a completed agent can answer a peer question`);
    }
    if (!target.callFingerprint) {
      throw new Error(`Peer agent ${target.name} has no durable call fingerprint and cannot safely answer or replay a peer question`);
    }
    // The host already marked this target as answering *this* request; only a
    // different one means the lineage is busy.
    if (target.answering && target.answering.requestId !== request.requestId) {
      throw new Error(`Peer agent ${target.name} is already answering another question`);
    }

    const ordinal = this.#interactionOrdinal(entry, request.requestId);
    if (ordinal >= MAX_WORKFLOW_INTERACTIONS) {
      throw new Error(`Workflow interaction budget exhausted (${MAX_WORKFLOW_INTERACTIONS} routed questions)`);
    }
    const questionFingerprint = workflowInteractionFingerprint({ question: request.question, context: request.context });
    const detail: WorkflowInteractionJournalDetail = {
      sourceAgentIndex: owner.agentIndex,
      sourceGeneration: request.source.generation,
      targetAgentIndex: targetIndex,
      targetJobId: target.jobId,
      targetCallFingerprint: target.callFingerprint,
    };
    await this.#appendJournal(entry, {
      callIndex: ordinal,
      fingerprint: questionFingerprint,
      kind: "peerQuestion",
      state: "started",
      at: Date.now(),
      agentIndex: owner.agentIndex,
      interaction: { ...detail },
    });

    try {
      const replayed = this.#matchReplayedInteraction(entry, questionFingerprint, detail);
      if (replayed) {
        await this.#appendJournal(entry, {
          callIndex: ordinal,
          fingerprint: questionFingerprint,
          kind: "peerQuestion",
          state: "completed",
          at: Date.now(),
          agentIndex: owner.agentIndex,
          result: { ok: true, output: replayed.answer, usage: replayed.usage },
          interaction: { ...detail, targetGeneration: replayed.detail.targetGeneration, route: "replay" },
        });
        return { answer: replayed.answer, targetGeneration: replayed.detail.targetGeneration, targetLabel: target.name, route: "replay" };
      }
      if (!request.target) {
        if (target.replayedFrom) {
          throw new Error(`Peer agent ${target.name} was replayed from ${entry.replay?.sourceRunId ?? "an earlier run"} and retains no native session, and no recorded answer matches this question. Re-run without resumeFromRunId, or ask the orchestrator instead.`);
        }
        throw new Error(`Peer agent ${target.name} no longer has a live retained session (it may have been evicted); ask the orchestrator or rerun the target agent`);
      }
      const preflight = this.#budgetPreflight(entry);
      if (preflight) throw new Error(preflight);
      const dispatched = await this.#withParkedDispatchSlot(entry, request.signal, async () => {
        await this.#waitUntilResumed(entry, request.signal);
        return this.#dispatchPeerAnswer(entry, target, {
          requestId: request.requestId,
          sourceAgentIndex: owner.agentIndex,
          sourceName: source.name,
          question: request.question,
          context: request.context,
          signal: request.signal,
        });
      });
      await this.#appendJournal(entry, {
        callIndex: ordinal,
        fingerprint: questionFingerprint,
        kind: "peerQuestion",
        state: "completed",
        at: Date.now(),
        agentIndex: owner.agentIndex,
        result: { ok: true, output: dispatched.answer, jobId: target.jobId, usage: dispatched.usage },
        route: journalRoute(target),
        interaction: { ...detail, targetGeneration: dispatched.targetGeneration, route: "peer" },
      });
      return { answer: dispatched.answer, targetGeneration: dispatched.targetGeneration, targetLabel: target.name, route: "peer" };
    } catch (error) {
      await this.#appendJournal(entry, {
        callIndex: ordinal,
        fingerprint: questionFingerprint,
        kind: "peerQuestion",
        state: "failed",
        at: Date.now(),
        agentIndex: owner.agentIndex,
        result: { ok: false, output: "", error: boundedText(error, 2_000) },
        interaction: { ...detail },
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A recorded answer is reusable only as an exact identity match: same asking
   * lineage and generation, same target lineage and target call fingerprint,
   * and the same question. Ordinals are deliberately not part of the key,
   * because a rerun replays a different mix of calls and would otherwise never
   * line up. Each record answers at most one question per run.
   */
  #matchReplayedInteraction(
    entry: RunEntry,
    questionFingerprint: string,
    detail: WorkflowInteractionJournalDetail,
  ): WorkflowReplayInteraction | undefined {
    const replay = entry.replay;
    if (!replay?.active) return undefined;
    const match = replay.interactions.find((candidate) =>
      !replay.usedInteractions.has(candidate.ordinal)
      && candidate.questionFingerprint === questionFingerprint
      && candidate.detail.sourceAgentIndex === detail.sourceAgentIndex
      && candidate.detail.sourceGeneration === detail.sourceGeneration
      && candidate.detail.targetAgentIndex === detail.targetAgentIndex
      && candidate.detail.targetCallFingerprint === detail.targetCallFingerprint);
    if (match) replay.usedInteractions.add(match.ordinal);
    return match;
  }

  /**
   * Continues the target's retained native session with the constrained peer
   * prompt and records the answer as another generation on that lineage. The
   * target keeps its original policy and context; usage lands on the target's
   * own record, so aggregate workflow budgets charge it like any other turn.
   */
  async #dispatchPeerAnswer(
    entry: RunEntry,
    target: WorkflowAgentRecord,
    input: { requestId: string; sourceAgentIndex: number; sourceName: string; question: string; context?: string; signal: AbortSignal },
  ): Promise<{ answer: string; targetGeneration: number; usage?: Usage }> {
    const jobId = target.jobId;
    if (!jobId) throw new Error(`Peer agent ${target.name} has no retained native session`);
    const prompt = renderPeerQuestionPrompt({ sourceName: input.sourceName, question: input.question, context: input.context });
    const now = Date.now();
    target.generations ??= [this.#snapshotGeneration(target)];
    target.generations.push({
      index: target.generations.length,
      callIndex: target.callIndex ?? 0,
      prompt: `Peer question from ${input.sourceName}: ${boundedText(input.question, 1_000)}`,
      state: "queued",
      outputProvenance: "peerAnswer",
      timestamps: { createdAt: now, updatedAt: now },
    });
    if (target.generations.length > MAX_AGENT_GENERATIONS) target.generations.splice(0, target.generations.length - MAX_AGENT_GENERATIONS);
    const generationIndex = target.generations.at(-1)!.index;
    // The completed lineage as the script already saw it. A peer answer is
    // auxiliary work, so a failed one marks only its own generation failed and
    // restores this projection instead of retroactively turning a completed
    // agent — whose result the script has already consumed — into a failed one.
    const settled = {
      state: target.state,
      output: target.output,
      structured: target.structured,
      outputProvenance: target.outputProvenance,
      preview: target.preview,
      truncated: target.truncated,
      instructionShaped: target.instructionShaped,
      error: target.error,
      endedAt: target.timestamps.endedAt,
    };
    target.answering = { requestId: input.requestId, sourceAgentIndex: input.sourceAgentIndex, sourceName: input.sourceName };
    target.state = "queued";
    target.error = undefined;
    target.timestamps.updatedAt = now;
    this.#touch(entry);

    const failGeneration = (message: string) => {
      const generation = target.generations?.find((candidate) => candidate.index === generationIndex);
      const at = Date.now();
      target.state = settled.state;
      target.output = settled.output;
      target.structured = settled.structured;
      target.outputProvenance = settled.outputProvenance;
      target.preview = settled.preview;
      target.truncated = settled.truncated;
      target.instructionShaped = settled.instructionShaped;
      target.error = settled.error;
      target.timestamps.updatedAt = at;
      target.timestamps.endedAt = settled.endedAt ?? at;
      if (generation) {
        generation.state = "failed";
        generation.error = message;
        generation.output = undefined;
        generation.outputProvenance = "peerAnswer";
        generation.timestamps = { ...generation.timestamps, updatedAt: at, endedAt: at };
      }
      this.#touch(entry);
    };

    let abort: (() => void) | undefined;
    try {
      const queued = await this.#jobs.continueWorkflowJob(jobId, prompt);
      this.#updateAgentFromJob(queued);
      abort = () => { void this.#jobs.cancel(jobId, "Peer answer cancelled").catch(() => undefined); };
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
      const final = await this.#jobs.wait(jobId, { signal: input.signal });
      this.#updateAgentFromJob(final);
      if (final.status !== "completed") throw new Error(final.error ?? `Peer agent ${final.status} before answering`);
      if (!final.output.trim()) throw new Error(`Peer agent ${target.name} returned no answer text`);
      // The lineage's latest turn is a host-routed answer, not script-driven
      // work; tag it after the terminal projection so provenance survives.
      const generation = target.generations?.find((candidate) => candidate.index === generationIndex);
      if (generation) generation.outputProvenance = "peerAnswer";
      target.outputProvenance = "peerAnswer";
      this.#touch(entry);
      return { answer: final.output, targetGeneration: generationIndex, usage: final.usage };
    } catch (error) {
      failGeneration(boundedText(error));
      throw error;
    } finally {
      if (abort) input.signal.removeEventListener("abort", abort);
      target.answering = undefined;
      this.#touch(entry);
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
    const agent = budget.maxTokensPerAgent === undefined ? undefined : entry.snapshot.agents.find((candidate) => candidate.usage.input + candidate.usage.output >= budget.maxTokensPerAgent!);
    if (agent) return `Workflow per-agent token budget exhausted for ${agent.name} (${agent.usage.input + agent.usage.output}/${budget.maxTokensPerAgent})`;
    return undefined;
  }

  /**
   * Decides whether a failed attempt may be redispatched after an authoritative
   * provider-quota wait. Automatic redispatch is only safe when the provider
   * rejected inference before any observable model/tool progress, and when the
   * failed attempt's isolated worktree (if any) fully finalized — otherwise a
   * mutating call is returned as a terminal, actionable failure instead.
   */
  #planProviderWait(
    record: WorkflowAgentRecord,
    result: { unavailable?: ProviderUnavailability; progressed?: boolean; error?: string },
    policy: WorkflowRetryPolicy,
    attempt: number,
    remainingWaitMs: number,
  ): ReturnType<typeof waitDecision> {
    if (!result.unavailable) return { wait: false, reason: result.error ?? "Agent failed" };
    if (result.progressed) {
      return {
        wait: false,
        reason: `Provider ${result.unavailable.provider} reported a ${result.unavailable.kind} rejection, but this call already produced model or tool activity; it was not replayed automatically. Rerun with resumeFromRunId after the window resets.`,
      };
    }
    if (record.isolation && record.isolation.state !== "removed") {
      return {
        wait: false,
        reason: `Provider ${result.unavailable.provider} reported a ${result.unavailable.kind} rejection, but this call used an isolated worktree that was not fully finalized; it was not replayed automatically. Rerun with resumeFromRunId after the window resets.`,
      };
    }
    return waitDecision({
      unavailable: result.unavailable,
      now: this.#providerWaitClock.now(),
      attempt,
      maxAttempts: policy.maxAttempts ?? 1,
      remainingWaitMs,
    });
  }

  #beginProviderWait(
    entry: RunEntry,
    record: WorkflowAgentRecord,
    unavailable: ProviderUnavailability,
    retryAt: number,
    attempt: number,
    maxAttempts: number,
  ): void {
    record.state = "waiting";
    record.providerWait = {
      provider: unavailable.provider,
      kind: unavailable.kind,
      scope: unavailable.scope,
      detail: unavailable.detail,
      retryAt,
      attempt,
      maxAttempts,
    };
    record.timestamps.updatedAt = Date.now();
    this.#touch(entry);
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
    // A "waiting" agent has no active job — its jobId still names the prior
    // terminal (failed) attempt, and re-reading it would flip the displayed
    // state back to "failed" until the redispatch actually starts.
    if (!agent.jobId || ["completed", "failed", "cancelled", "aborted", "waiting"].includes(agent.state)) return agent;
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
      usage: addWorkflowUsage(agent.retryUsage, workflowUsage(job.usage)),
      context: job.context ? { ...job.context } : undefined,
      timestamps: {
        ...agent.timestamps,
        updatedAt: Date.now(),
        startedAt: agent.timestamps.startedAt ?? job.startedAt,
        endedAt: job.endedAt,
      },
    };
  }

  #updateAgentFromJob(job: JobSnapshot, event: BackendEvent = { type: "started" }): void {
    if (event.type === "interaction" || event.type === "interaction_cleared" || event.type === "interaction_answering") {
      this.#applyInteractionEvent(job, event);
      return;
    }
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
    agent.usage = addWorkflowUsage(agent.retryUsage, workflowUsage(job.usage));
    agent.context = job.context ? { ...job.context } : undefined;
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
    // The latest generation entry mirrors the same live fields as the
    // top-level record whenever it is the one this event belongs to; prior
    // generations were already frozen when their own follow-up settled.
    const generation = agent.generations?.at(-1);
    if (generation && generation.callIndex === agent.callIndex) {
      generation.state = agent.state;
      generation.error = agent.error;
      generation.timestamps = { ...generation.timestamps, updatedAt: now, startedAt: generation.timestamps.startedAt ?? job.startedAt, endedAt: job.endedAt };
      if (isTerminal(job.status)) {
        generation.output = job.output;
        generation.outputProvenance = "subagent";
      }
    }
    this.#touch(entry);
    this.#recordBudgetWarnings(entry);
  }

  #recordBudgetWarnings(entry: RunEntry): void {
    const usage = aggregateWorkflowUsage(entry.snapshot);
    let changed = false;
    const harnesses = new Set(entry.snapshot.agents.map((agent) => agent.harness).filter((value): value is HarnessName => value === "pi" || value === "claude" || value === "codex"));
    for (const harness of harnesses) {
      for (const metric of spendBudgetMetrics(entry.snapshot.budget, usage, harness)) {
        const key = `aggregate:${metric.key}`;
        if (!metric.reached || !metric.supported || entry.reachedBudgetWarnings.has(key)) continue;
        const warning = reachedSpendWarning(metric, "Workflow budget");
        if (!warning) continue;
        entry.reachedBudgetWarnings.add(key);
        entry.snapshot.warnings = [...(entry.snapshot.warnings ?? []), warning].slice(-16);
        changed = true;
      }
    }
    const limit = entry.snapshot.budget?.maxTokensPerAgent;
    const agent = limit === undefined ? undefined : entry.snapshot.agents.find((candidate) => candidate.usage.input + candidate.usage.output >= limit);
    if (agent && !entry.reachedBudgetWarnings.has("agentTokens")) {
      const warning = `Workflow budget agent tokens limit reached for ${agent.name} (${agent.usage.input + agent.usage.output}/${limit}); later dispatches are blocked`;
      entry.reachedBudgetWarnings.add("agentTokens");
      entry.snapshot.warnings = [...(entry.snapshot.warnings ?? []), warning].slice(-16);
      changed = true;
    }
    if (changed) this.#touch(entry);
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

  #resolveAgentPhase(entry: RunEntry, rawPhase: unknown): number {
    if (entry.snapshot.plannedPhaseCount !== undefined) {
      const current = entry.snapshot.currentPhase === null
        ? undefined
        : entry.snapshot.phases[entry.snapshot.currentPhase];
      if (!current) {
        throw new Error("No declared workflow phase is active; call phase(title) before agent()");
      }
      if (rawPhase === undefined) return current.index;
      if (typeof rawPhase !== "string") throw new Error("agent phase must be a declared phase title");
      const requested = this.#declaredPhaseIndex(entry, rawPhase);
      if (requested !== current.index) {
        throw new Error(`agent({ phase: ${JSON.stringify(entry.snapshot.phases[requested]!.name)} }) cannot advance the declared plan; call phase(title) first`);
      }
      return requested;
    }
    return typeof rawPhase === "string"
      ? this.#ensurePhase(entry, rawPhase)
      : entry.snapshot.currentPhase ?? this.#ensurePhase(entry, "Agents");
  }

  #phaseCapacity(entry: RunEntry, titles: string[]): { ok: boolean; reason?: string } {
    const view: PhaseActivationView = {
      declared: entry.snapshot.plannedPhaseCount !== undefined,
      names: entry.snapshot.phases.map((phase) => phase.name),
      currentPhase: entry.snapshot.currentPhase,
    };
    try {
      for (const title of titles) {
        const activation = planPhaseActivation(view, title);
        if (activation.create) view.names.push(activation.name);
        view.currentPhase = activation.index;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: boundedText(error, 500) };
    }
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

  #applyMeta(entry: RunEntry, value: unknown, initial: boolean): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const meta = value as Record<string, unknown>;
    const plan = initial && !entry.metadataReceived && Object.hasOwn(meta, "phases")
      ? validateDeclaredPhasePlan(meta.phases)
      : undefined;
    if (initial && !entry.metadataReceived) {
      entry.metadataReceived = true;
      if (plan) {
        const now = Date.now();
        entry.snapshot.plannedPhaseCount = plan.length;
        entry.snapshot.phases = plan.map((name, index) => ({
          index,
          name,
          status: "pending",
          timestamps: { createdAt: now, updatedAt: now },
          agents: [],
        }));
      }
    }
    const name = meta.name === undefined ? entry.snapshot.name : label(meta.name, entry.snapshot.name);
    const description = meta.description === undefined ? entry.snapshot.description : label(meta.description, entry.snapshot.description);
    if (name === entry.snapshot.name && description === entry.snapshot.description && !plan) return;
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

  /**
   * Mirrors the sandbox convergence loop's bounded progress onto the snapshot.
   * Purely projected state: the loop itself runs on ordinary agent()/followUp()
   * calls, so scheduling, budgets, journaling, and replay are untouched.
   */
  #recordConvergence(entry: RunEntry, progress: WorkflowConvergence): void {
    entry.snapshot.convergence = {
      ...progress,
      name: progress.name === undefined ? undefined : boundedText(progress.name, 200),
      stoppingReason: progress.stoppingReason === undefined ? undefined : boundedText(progress.stoppingReason, 2_000),
      rounds: progress.rounds.slice(-MAX_CONVERGENCE_ROUNDS),
    };
    this.#touch(entry);
  }

  #activatePhase(entry: RunEntry, title: string): void {
    const activation = planPhaseActivation({
      declared: entry.snapshot.plannedPhaseCount !== undefined,
      names: entry.snapshot.phases.map((phase) => phase.name),
      currentPhase: entry.snapshot.currentPhase,
    }, title);
    const now = Date.now();
    if (activation.create) {
      entry.snapshot.phases.push({
        index: activation.index,
        name: activation.name,
        status: "pending",
        timestamps: { createdAt: now, updatedAt: now },
        agents: [],
      });
    }
    const index = activation.index;
    const current = entry.snapshot.currentPhase === null ? undefined : entry.snapshot.phases[entry.snapshot.currentPhase];
    if (current && current.index === index) return;
    if (current && current.index !== index && current.status === "running") {
      current.status = "completed";
      current.timestamps.updatedAt = now;
      current.timestamps.endedAt = now;
    }
    if (entry.snapshot.plannedPhaseCount !== undefined && current) {
      for (let skipped = current.index + 1; skipped < index; skipped++) {
        const phase = entry.snapshot.phases[skipped]!;
        if (phase.status !== "pending") continue;
        phase.status = "completed";
        phase.timestamps.updatedAt = now;
        phase.timestamps.endedAt = now;
      }
    } else if (entry.snapshot.plannedPhaseCount !== undefined) {
      for (let skipped = 0; skipped < index; skipped++) {
        const phase = entry.snapshot.phases[skipped]!;
        if (phase.status !== "pending") continue;
        phase.status = "completed";
        phase.timestamps.updatedAt = now;
        phase.timestamps.endedAt = now;
      }
    }
    const phase = entry.snapshot.phases[index]!;
    phase.status = "running";
    phase.timestamps.startedAt ??= now;
    phase.timestamps.updatedAt = now;
    entry.snapshot.currentPhase = index;
    this.#touch(entry);
  }

  #declaredPhaseIndex(entry: RunEntry, rawTitle: string): number {
    const name = normalizePhaseName(rawTitle);
    const index = entry.snapshot.phases.findIndex((phase) => phase.name === name);
    if (index >= 0) return index;
    const shown = name || "<blank>";
    throw new Error(`Workflow phase ${JSON.stringify(shown)} is not declared in the workflow phase plan`);
  }

  #finishPhases(entry: RunEntry, status: "completed" | "failed" | "aborted"): void {
    const now = Date.now();
    for (const phase of entry.snapshot.phases) {
      // A declared plan is a view of the workflow's possible phases, not a
      // promise that every conditional phase will run. Only phases reached
      // by phase() (including explicitly skipped phases, which are already
      // completed) receive the workflow's terminal state.
      if (phase.status === "completed" || (entry.snapshot.plannedPhaseCount !== undefined && phase.status === "pending")) continue;
      phase.status = status;
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

  /** A completed workflow-owned job keeps its retained native session only for
   * this run's lifetime; release every session this run owns once it ends so
   * success, failure, abort, and shutdown all leave nothing retained behind. */
  async #releaseMemberRuns(entry: RunEntry): Promise<void> {
    const jobIds = entry.snapshot.agents
      .map((agent) => agent.jobId)
      .filter((id): id is string => id !== undefined && this.#jobOwners.get(id)?.runId === entry.snapshot.runId);
    await Promise.allSettled(jobIds.map((id) => this.#jobs.releaseRun(id)));
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

  async #evictOldRuns(): Promise<void> {
    if (this.#runs.size < this.#maxRetainedRuns) return;
    const terminal = [...this.#runs.values()]
      .filter((entry) => terminalWorkflow(entry.snapshot.status))
      .sort((left, right) => left.snapshot.timestamps.updatedAt - right.snapshot.timestamps.updatedAt);
    while (this.#runs.size >= this.#maxRetainedRuns && terminal.length) {
      const victim = terminal.shift()!;
      this.#runs.delete(victim.snapshot.runId);
      await this.#retentionLease?.release(victim.snapshot.runId);
    }
    if (this.#runs.size >= this.#maxRetainedRuns) throw new Error(`Workflow retention limit reached (${this.#maxRetainedRuns})`);
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
  const spend = validateSpendBudget(value, "Workflow budget");
  const normalized = {
    maxAgents: integer("maxAgents", 32),
    maxConcurrency: integer("maxConcurrency", 4),
    maxTokensPerAgent: integer("maxTokensPerAgent", 100_000_000),
    ...spend,
  };
  return Object.values(normalized).some((item) => item !== undefined) ? normalized : undefined;
}

const DEFAULT_RETRY_MAX_WAIT_MS = 1_800_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 1;

function normalizeWorkflowRetry(value: WorkflowRetryPolicy | undefined): WorkflowRetryPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow retry must be an object");
  const providerUnavailable = value.providerUnavailable ?? "fail";
  if (providerUnavailable !== "fail" && providerUnavailable !== "wait") {
    throw new Error('Workflow retry.providerUnavailable must be "fail" or "wait"');
  }
  if (providerUnavailable === "fail") return { providerUnavailable: "fail" };
  const integer = (name: "maxWaitMs" | "maxAttempts", minimum: number, maximum: number, fallback: number) => {
    const item = value[name];
    if (item === undefined) return fallback;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < minimum || item > maximum) {
      throw new Error(`Workflow retry.${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return item;
  };
  return {
    providerUnavailable: "wait",
    maxWaitMs: integer("maxWaitMs", 1_000, 21_600_000, DEFAULT_RETRY_MAX_WAIT_MS),
    maxAttempts: integer("maxAttempts", 1, 8, DEFAULT_RETRY_MAX_ATTEMPTS),
  };
}

function workflowBudgetWarnings(budget: WorkflowBudgetPolicy | undefined): string[] {
  if (!budget) return [];
  const warnings: string[] = [];
  if ((budget.maxAgents ?? 0) > 16) warnings.push(`Large workflow allowance: ${budget.maxAgents} agents`);
  if ((budget.maxConcurrency ?? 0) === 4) warnings.push("Maximum workflow concurrency requested");
  if ((budget.maxTokens ?? 0) > 500_000) warnings.push(`Large token allowance: ${budget.maxTokens} fresh/output tokens`);
  if ((budget.maxTokensPerAgent ?? 0) > 250_000) warnings.push(`Large per-agent token allowance: ${budget.maxTokensPerAgent} fresh/output tokens`);
  if ((budget.maxCost ?? 0) > 20) warnings.push(`Large cost allowance: $${budget.maxCost}`);
  return warnings;
}

export function workflowIsTerminal(status: WorkflowStatus): boolean {
  return terminalWorkflow(status);
}
