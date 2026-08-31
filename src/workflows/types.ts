import type { AccessMode, AgentActivitySnapshot, AgentSpeed, ContextSnapshot, EffortLevel, HarnessName, ProviderFamily, ToolTrace, TranscriptEntry, Usage } from "../types.ts";
import type { RequestedHarness } from "../capability-routing.ts";
import type { HarnessAvailabilityStatus } from "../harness-availability.ts";
import type { InteractionRoute, InteractionState } from "../interactions.ts";
import type { ProviderUnavailabilityKind } from "../provider-unavailability.ts";
import type { WorkflowWorktreeResult } from "./worktree.ts";
import type { SpendBudget } from "../budget.ts";
import type { WorkflowCheckoutProof } from "./checkout.ts";

export type WorkflowStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export type WorkflowAgentState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted";

/**
 * `native` means a provider-native terminal structured-result channel produced
 * and validated `structured`; `portable` means the prompt/parse/validate
 * fallback did. Present when the call had an effective schema; a native
 * lineage's `followUp()` can inherit its original schema without passing one.
 */
export type WorkflowStructuredTransport = "native" | "portable";

/**
 * Opt-in policy for continuing an `agent()` call after an authoritative
 * provider-quota rejection instead of failing it immediately. Absent (or
 * `"fail"`) preserves today's behavior exactly.
 */
export interface WorkflowRetryPolicy {
  /** Absent means `"fail"`, preserving today's immediate-failure behavior. */
  providerUnavailable?: "fail" | "wait";
  /** Total wait allowance for the whole workflow run, in ms. */
  maxWaitMs?: number;
  /** Provider-wait retries allowed per fresh `agent()` call. */
  maxAttempts?: number;
}

/** Bounded, display-safe record of one provider wait a logical call went through. */
export interface WorkflowAgentProviderWait {
  provider: ProviderFamily;
  kind: ProviderUnavailabilityKind;
  scope?: string;
  detail: string;
  /** Epoch ms this attempt is waiting until. */
  retryAt: number;
  attempt: number;
  maxAttempts: number;
}

/** One explicit, opposite native route for a fresh workflow agent call. */
export interface WorkflowProviderFallback {
  harness: "claude" | "codex";
  model?: string;
}

/** One explicit opposite-provider route that may continue progressed work. */
export interface WorkflowContinuationFallback {
  harness: "claude" | "codex";
  model?: string;
}

/** Structured reason the runtime used the declared provider fallback. */
export interface WorkflowProviderFallbackTrigger {
  source: "readiness" | "provider";
  provider: "claude" | "codex";
  status?: "missing" | "unauthenticated" | "incompatible";
  kind?: ProviderUnavailabilityKind;
  retryAt?: number;
  scope?: string;
  detail: string;
}

/** Authoritative progressed failure that opened a continuation handoff. */
export interface WorkflowContinuationTrigger {
  source: "continuation";
  provider: "claude" | "codex";
  status?: undefined;
  kind: ProviderUnavailabilityKind;
  retryAt?: number;
  scope?: string;
  detail: string;
}

/** Bounded lineage provenance for the one progressed continuation route. */
export interface WorkflowAgentContinuation {
  state: "handoff" | "running" | "completed" | "failed";
  fromHarness: "claude" | "codex";
  toHarness: "claude" | "codex";
  failedJobId: string;
  replacementJobId?: string;
  checkpointAt: number;
  checkoutDigest: string;
  trigger: WorkflowContinuationTrigger;
  warning: string;
}

/** Bounded provenance for one abandoned attempt of a logical call that later retried. */
export interface WorkflowAgentAttempt {
  index?: number;
  jobId?: string;
  harness?: string;
  requestedHarness?: RequestedHarness;
  availability?: HarnessAvailabilityStatus;
  executableVersion?: string;
  capabilityRevision?: string;
  model?: string;
  speed?: AgentSpeed;
  effectiveSpeed?: AgentSpeed;
  error?: string;
  usage: WorkflowUsage;
  endedAt?: number;
  disposition?: "wait" | "fallback" | "continuation";
  trigger?: WorkflowProviderFallbackTrigger | WorkflowContinuationTrigger;
}

export interface WorkflowTimestamps {
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  pausedAt?: number;
  endedAt?: number;
}

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface WorkflowReplayReference {
  runId: string;
  callIndex: number;
}

export interface WorkflowReplacementLink {
  replacementRunId: string;
  reason: string;
  at: number;
}

export interface WorkflowReplacementReference {
  sourceRunId: string;
  sourceAgentIndex: number;
  sourceCallIndex?: number;
  sourceJobId?: string;
  sourceHarness?: HarnessName;
  sourceModel?: string;
  sourceState: WorkflowAgentState;
  sourceError?: string;
  reason: string;
}

/**
 * Where a lineage turn's output came from. `peerAnswer` marks a turn the host
 * ran to answer another agent's routed question rather than script-driven work.
 */
export type WorkflowOutputProvenance = "subagent" | "replay" | "peerAnswer";

/** One explicitly allowlisted thread-advisor consultation coordinated by the workflow script. */
export interface WorkflowAdvisorRecord {
  index: number;
  callIndex: number;
  callFingerprint: string;
  advisorId: string;
  advisorName: string;
  lineage: number;
  generation?: number;
  phase: number;
  state: WorkflowAgentState;
  timestamps: WorkflowTimestamps;
  prompt: string;
  context?: string;
  output?: string;
  error?: string;
  harness?: HarnessName;
  model?: string;
  usage: WorkflowUsage;
  queuedMs?: number;
  replayedFrom?: WorkflowReplayReference;
  outputProvenance?: "advisor" | "replay";
  instructionShaped?: boolean;
}

/**
 * Bounded, display-safe projection of one host-routed question a workflow agent
 * asked. Peer questions stay inside the run; orchestrator questions are mirrored
 * here so `/workflows` can distinguish an interaction wait from a provider-quota
 * wait, scheduler queueing, or a user pause.
 */
export interface WorkflowInteractionSummary {
  /** Interaction ordinal within the run, separate from the sandbox call index. */
  ordinal: number;
  requestId: string;
  target: "orchestrator" | "peer";
  sourceAgentIndex: number;
  sourceName: string;
  /** Present for peer targets resolved to a lineage in this same run. */
  targetAgentIndex?: number;
  targetName?: string;
  question: string;
  context?: string;
  state: InteractionState;
  route?: InteractionRoute;
  createdAt: number;
  answeredAt?: number;
  /** Bounded answer text, retained for auditability once the question settles. */
  answer?: string;
  error?: string;
}

/**
 * One turn in a workflow-agent lineage: either the originating `agent()` call
 * (index 0) or a later `followUp()` call against the same retained native
 * session. Bounded and bookkept separately from the top-level record so a
 * follow-up's live progress does not overwrite a prior turn's result.
 */
export interface WorkflowAgentGeneration {
  /** Ordinal within this lineage; 0 is the originating agent() call. */
  index: number;
  /** Script-level agent()/followUp() call ordinal that produced this turn. */
  callIndex: number;
  /** Bounded caller prompt for this turn; excludes schema scaffolding. */
  prompt?: string;
  state: WorkflowAgentState;
  output?: unknown;
  structured?: unknown;
  structuredTransport?: WorkflowStructuredTransport;
  outputProvenance?: WorkflowOutputProvenance;
  error?: string;
  timestamps: WorkflowTimestamps;
}

export interface WorkflowAgentRecord {
  index: number;
  /** Script-level agent() ordinal used by the durable replay journal. */
  callIndex?: number;
  callFingerprint?: string;
  replayedFrom?: WorkflowReplayReference;
  replacedBy?: WorkflowReplacementLink;
  outputProvenance?: WorkflowOutputProvenance;
  instructionShaped?: boolean;
  isolation?: WorkflowWorktreeResult;
  name: string;
  access: AccessMode;
  profile?: string;
  /** Required capability IDs from the original call, fixed across continuation. */
  requires?: string[];
  independent: boolean;
  independentOf?: string;
  phase: number;
  jobId?: string;
  /** Stable script-visible lineage ID; `jobId` may move to a replacement native session. */
  logicalJobId?: string;
  /** Durable proof that manual replay of this agent suffix could repeat progressed effects. */
  progressedCheckpoint?: true;
  state: WorkflowAgentState;
  timestamps: WorkflowTimestamps;
  harness?: string;
  /** Harness the caller asked for (`auto` or an explicit route), before availability resolution. */
  requestedHarness?: RequestedHarness;
  /** Normalized availability of the resolved route observed by the live pre-dispatch recheck. */
  availability?: HarnessAvailabilityStatus;
  /** Native executable version, only when the availability adapter reported one. */
  executableVersion?: string;
  /** Fingerprint of the live capability catalog used to resolve this route. */
  capabilityRevision?: string;
  /** Candidate availability observed for auto routing, including excluded routes. */
  availabilityChecks?: WorkflowHarnessAvailabilityEvidence[];
  model?: string;
  effort?: EffortLevel;
  /** Resolved requested speed, fixed across the logical lineage. */
  speed?: AgentSpeed;
  /** Latest authoritative provider receipt for the tier that served a turn. */
  effectiveSpeed?: AgentSpeed;
  /** Authoritative originating agent() objective, fixed across bounded history truncation. */
  objective?: string;
  /** Latest caller prompt, bounded before persistence; excludes schema scaffolding. */
  prompt?: string;
  /** Bounded recent tool state, projected live and frozen when the job settles. */
  tools?: ToolTrace[];
  /** Live-only thinking preview projected from JobManager when available. */
  liveThinking?: string;
  /** Live-only bounded operational evidence. Never durable or replayed. */
  activity?: AgentActivitySnapshot;
  truncated?: boolean;
  preview?: string;
  output?: unknown;
  structured?: unknown;
  structuredTransport?: WorkflowStructuredTransport;
  /** The bounded schema this lineage is validating against, when `structuredTransport` is `native`. A retained native session is schema-bound at `agent()` time; `followUp()` may reuse it but cannot change it. In-memory only — not required for replay because a purely replayed lineage cannot be targeted by `followUp()` either way. */
  nativeStructuredSchema?: Record<string, unknown>;
  transcript?: TranscriptEntry[];
  error?: string;
  usage: WorkflowUsage;
  /** Usage carried over from abandoned provider-wait attempts of this same logical call. */
  retryUsage?: WorkflowUsage;
  /** Present while `state` is `"waiting"`; cleared once the call redispatches. */
  providerWait?: WorkflowAgentProviderWait;
  /** Declared alternate native provider. Present whether or not it was used. */
  providerFallback?: WorkflowProviderFallback;
  /** Declared progressed-work continuation route. Present whether or not used. */
  continuationFallback?: WorkflowContinuationFallback;
  /** Present after a progressed failure opened the one allowed handoff. */
  continuation?: WorkflowAgentContinuation;
  /** Bounded provenance for prior abandoned attempts of this logical call, oldest first. */
  attempts?: WorkflowAgentAttempt[];
  /** Latest native request occupancy, when exposed by the harness. */
  context?: ContextSnapshot;
  /** Present while this agent is parked on a host-routed question of its own. */
  waitingOn?: WorkflowInteractionSummary;
  /** Present while this agent's retained session is answering a peer question. */
  answering?: { requestId: string; sourceAgentIndex?: number; sourceName: string };
  /**
   * Bounded turn history for this lineage. Present once a `followUp()` call
   * has targeted this agent; the top-level fields above always mirror the
   * latest (last) entry. Absent for agents that never received a follow-up.
   */
  generations?: WorkflowAgentGeneration[];
}

export interface WorkflowPhase {
  index: number;
  name: string;
  description?: string;
  status: WorkflowStatus;
  timestamps: WorkflowTimestamps;
  agents: number[];
  advisorConsultations?: number[];
  result?: unknown;
  error?: string;
}

export interface WorkflowLogRecord {
  index: number;
  message: string;
  at: number;
}

export interface WorkflowJournalResult {
  ok: boolean;
  output: string;
  jobId?: string;
  error?: string;
  usage?: Usage;
  structured?: unknown;
  transport?: WorkflowStructuredTransport;
  /** Machine-readable marker that a workflow budget, not the provider, refused this call. */
  limit?: "budget";
  /** Durable proof that replay must not restart this failed call from its original prompt. */
  progressed?: true;
  advisorId?: string;
  advisorName?: string;
  advisorLineage?: number;
  advisorGeneration?: number;
  queuedMs?: number;
}

export interface WorkflowJournalRoute {
  jobId?: string;
  logicalJobId?: string;
  harness?: HarnessName;
  /** Harness the caller requested (`auto` or an explicit route). Additive; absent on older journals. */
  requestedHarness?: RequestedHarness;
  /** Normalized availability of the resolved route. Additive; absent on older journals. */
  availability?: HarnessAvailabilityStatus;
  /** Native executable version, only when reported by a safe probe. */
  executableVersion?: string;
  /** Capability catalog fingerprint used for route selection, when applicable. */
  capabilityRevision?: string;
  /** Candidate availability observed for auto routing. */
  availabilityChecks?: WorkflowHarnessAvailabilityEvidence[];
  model?: string;
  /** Additive requested and observed tier metadata; absent on legacy journals. */
  speed?: AgentSpeed;
  effectiveSpeed?: AgentSpeed;
  /** Actual child lifecycle state and bounded failure detail for durable review. */
  status?: WorkflowAgentState;
  error?: string;
  providerFallback?: WorkflowProviderFallback;
  continuationFallback?: WorkflowContinuationFallback;
  continuation?: WorkflowAgentContinuation;
  attempts?: WorkflowAgentAttempt[];
}

/** Durable checkpoint that permits replacement dispatch without replaying the failed primary. */
export interface WorkflowContinuationHandoff {
  agentIndex: number;
  logicalJobId?: string;
  failedJobId: string;
  phase: string;
  objective: string;
  handoffPrompt: string;
  /** Effective bounded schema for a replacement session, when the failed generation was schema-constrained. */
  schema?: Record<string, unknown>;
  checkout: WorkflowCheckoutProof;
  target: WorkflowContinuationFallback;
  trigger: WorkflowContinuationTrigger;
  /** Usage from only the failed generation, for attempt provenance. */
  attemptUsage?: WorkflowUsage;
  /** Cumulative logical-lineage usage through the failed generation. */
  usage: WorkflowUsage;
}

/**
 * First durable proof that a failed primary made progress and must never be
 * replayed. This checkpoint does not authorize a replacement: checkout proof
 * and the bounded continuation prompt arrive in the later handoff record.
 */
export interface WorkflowContinuationProgress {
  agentIndex: number;
  logicalJobId?: string;
  failedJobId: string;
  target: WorkflowContinuationFallback;
  trigger: WorkflowContinuationTrigger;
  /** Usage from only the failed generation, for replay provenance. */
  attemptUsage: WorkflowUsage;
  /** Cumulative logical-lineage usage through the failed generation. */
  usage: WorkflowUsage;
}

export interface WorkflowHarnessAvailabilityEvidence {
  harness: HarnessName;
  status: HarnessAvailabilityStatus;
  executableVersion?: string;
}

/**
 * Durable provenance for one peer question. Persisted because a replayed
 * lineage has no live retained session: a downstream agent that reruns and asks
 * the same question again must be answerable from the journal instead of
 * dispatching (and re-charging) the target a second time.
 */
export interface WorkflowInteractionJournalDetail {
  /** Logical agent and lineage generation that asked. */
  sourceAgentIndex: number;
  sourceGeneration: number;
  /** Logical target agent and the exact call fingerprint its lineage carried. */
  targetAgentIndex: number;
  targetJobId?: string;
  targetCallFingerprint?: string;
  /** Lineage generation on the target that produced the answer. */
  targetGeneration?: number;
  route?: "peer" | "replay";
}

export interface WorkflowJournalRecord {
  version: 1;
  sequence: number;
  /**
   * Sandbox `agent()`/`followUp()` call ordinal, except for `peerQuestion`
   * records where it carries the run's separate interaction ordinal.
   */
  callIndex: number;
  /** Call fingerprint, or the question fingerprint for `peerQuestion` records. */
  fingerprint: string;
  state: "started" | "progressed" | "handoff" | "completed" | "accepted" | "failed";
  at: number;
  /** Absent means "agent" for journals written before followUp() existed. */
  kind?: "agent" | "followUp" | "advisor" | "peerQuestion";
  agentIndex?: number;
  /** Present only on `peerQuestion` records. */
  interaction?: WorkflowInteractionJournalDetail;
  /** A persisted peer answer that requires a later accepted record before replay. */
  interactionPending?: true;
  result?: WorkflowJournalResult;
  route?: WorkflowJournalRoute;
  replayedFrom?: WorkflowReplayReference;
  replacementOf?: WorkflowReplacementReference;
  /** Copied checkpoint evidence for replay validation; never replacement-dispatch authority. */
  replayProof?: true;
  /** A resumed handoff moved this lineage's checkpoint usage out of replay-carried usage. */
  replayUsageClaim?: true;
  /** Present only on a progressed continuation handoff checkpoint. */
  continuation?: WorkflowContinuationHandoff;
  /** Present only on the pre-settlement progressed-primary checkpoint. */
  continuationProgress?: WorkflowContinuationProgress;
}

/** A completed peer answer that may be replayed without dispatching the target again. */
export interface WorkflowReplayInteraction {
  ordinal: number;
  questionFingerprint: string;
  detail: WorkflowInteractionJournalDetail;
  answer: string;
  usage?: Usage;
}

export interface WorkflowReplayCall {
  callIndex: number;
  fingerprint: string;
  kind: "agent" | "followUp" | "advisor";
  /** The lineage this call belongs to; required to reconstruct a followUp() replay. */
  agentIndex?: number;
  result: WorkflowJournalResult;
  route?: WorkflowJournalRoute;
  /** Accepted checkpoint chain copied into a replay journal before its terminal record. */
  continuationProof?: {
    progress: WorkflowContinuationProgress;
    progressRoute: WorkflowJournalRoute;
    handoff: WorkflowContinuationHandoff;
    handoffRoute: WorkflowJournalRoute;
  };
}

export interface WorkflowReplayHandoff {
  callIndex: number;
  fingerprint: string;
  kind: "agent" | "followUp";
  checkpoint: WorkflowContinuationHandoff;
  route?: WorkflowJournalRoute;
}

export type WorkflowApprovalMode = "auto" | "plan" | "onMutate";

export interface WorkflowBudgetPolicy extends SpendBudget {
  maxAgents?: number;
  maxConcurrency?: number;
  /** Aggregate fresh input plus output tokens. */
  maxTokens?: number;
  /** Fresh input plus output ceiling for any single agent. */
  maxTokensPerAgent?: number;
}

export type WorkflowTaskOutcome = "successful" | "unsuccessful" | "unspecified";

export interface WorkflowReplayState {
  sourceRunId: string;
  matchedCalls: number;
  invalidatedAt?: number;
  /** Durable source usage not represented by reconstructed agents, charged only when an interrupted handoff dispatches its replacement. */
  carriedUsage?: WorkflowUsage;
}

/** Machine-readable review verdict a bounded convergence loop branches on. */
export type WorkflowConvergenceVerdict = "approve" | "request_changes" | "blocked";

/**
 * Terminal reason a bounded convergence loop stopped. Lifecycle states
 * (cancelled, aborted, paused, shut down) stay on the workflow itself and are
 * never folded into a convergence outcome.
 */
export type WorkflowConvergenceOutcome = "approved" | "blocked" | "limit-reached" | "stalled" | "failed";

export type WorkflowConvergenceState = "running" | WorkflowConvergenceOutcome;

/** Compact per-round evidence: enough to audit progress without keeping every review body. */
export interface WorkflowConvergenceRound {
  round: number;
  verdict: WorkflowConvergenceVerdict;
  actionableCount: number;
  /** Opaque, deterministic hash of the round's normalized actionable findings. */
  fingerprint: string;
}

/**
 * Live and terminal state of the run's bounded convergence loop. Optional
 * everywhere: workflows that never call `converge()` (and every snapshot
 * written before it existed) simply omit it.
 */
export interface WorkflowConvergence {
  /** Caller-supplied loop label, when provided. */
  name?: string;
  /** Round currently running, or the last round attempted once terminal. */
  round: number;
  maxRounds: number;
  state: WorkflowConvergenceState;
  /** Latest structured verdict, once a review of this loop has validated. */
  verdict?: WorkflowConvergenceVerdict;
  actionableCount?: number;
  fingerprint?: string;
  /** Bounded fix prompt containing every pending finding ID and available body evidence. */
  pendingFindings?: string;
  /** Human-readable reason the loop stopped; present once `state` is terminal. */
  stoppingReason?: string;
  implementerJobId?: string;
  reviewerJobId?: string;
  rounds: WorkflowConvergenceRound[];
}

export interface WorkflowSnapshot {
  runId: string;
  sessionId: string;
  name: string;
  description: string;
  background: boolean;
  status: WorkflowStatus;
  /** Script result semantics, separate from sandbox lifecycle. */
  taskOutcome?: WorkflowTaskOutcome;
  timestamps: WorkflowTimestamps;
  currentPhase: number | null;
  phases: WorkflowPhase[];
  /** Present when the workflow declared its complete phase plan in metadata. */
  plannedPhaseCount?: number;
  agents: WorkflowAgentRecord[];
  /** Advisors this invocation was explicitly authorized to consult. */
  advisors?: string[];
  advisorConsultations?: WorkflowAdvisorRecord[];
  /** Bounded narrator-style progress emitted by workflow log(). */
  logs?: WorkflowLogRecord[];
  /** Present once this run's script called `converge()`; absent otherwise. */
  convergence?: WorkflowConvergence;
  /** Hash of script, arguments, project cwd, routing context, and budget. */
  definitionFingerprint?: string;
  /** Same identity hash without budget, allowing monotonic budget increases on replay. */
  replayBaseFingerprint?: string;
  replay?: WorkflowReplayState;
  /** Present when this run replaces a failed, stalled, cancelled, or manually restarted agent. */
  replacementOf?: WorkflowReplacementReference;
  journalArtifact?: string;
  approval?: WorkflowApprovalMode;
  budget?: WorkflowBudgetPolicy;
  /** Opt-in provider-quota wait policy; absent means today's immediate-failure behavior. Not part of the replay fingerprint. */
  retry?: WorkflowRetryPolicy;
  warnings?: string[];
  /** Bounded history of host-routed questions asked inside this run, oldest first. */
  interactions?: WorkflowInteractionSummary[];
  result?: unknown;
  error?: string;
  artifactDir: string;
  transcriptArtifact?: string;
  reportArtifact?: string;
}
