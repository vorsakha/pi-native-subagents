import type { AccessMode, ContextSnapshot, EffortLevel, HarnessName, ProviderFamily, ToolTrace, TranscriptEntry, Usage } from "../types.ts";
import type { ProviderUnavailabilityKind } from "../provider-unavailability.ts";
import type { WorkflowWorktreeResult } from "./worktree.ts";
import type { SpendBudget } from "../budget.ts";

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
 * fallback did. Present only when the call requested a `schema`.
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
  /** Provider-wait retries allowed per logical `agent()`/`followUp()` call. */
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

/** Bounded provenance for one abandoned attempt of a logical call that later retried. */
export interface WorkflowAgentAttempt {
  jobId?: string;
  harness?: string;
  model?: string;
  error?: string;
  usage: WorkflowUsage;
  endedAt?: number;
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
  outputProvenance?: "subagent" | "replay";
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
  outputProvenance?: "subagent" | "replay";
  instructionShaped?: boolean;
  isolation?: WorkflowWorktreeResult;
  name: string;
  access: AccessMode;
  profile?: string;
  independent: boolean;
  independentOf?: string;
  phase: number;
  jobId?: string;
  state: WorkflowAgentState;
  timestamps: WorkflowTimestamps;
  harness?: string;
  model?: string;
  effort?: EffortLevel;
  /** Original caller prompt, bounded before persistence; excludes schema scaffolding. */
  prompt?: string;
  /** Bounded recent tool state, projected live and frozen when the job settles. */
  tools?: ToolTrace[];
  /** Live-only thinking preview projected from JobManager when available. */
  liveThinking?: string;
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
  /** Bounded provenance for prior abandoned attempts of this logical call, oldest first. */
  attempts?: WorkflowAgentAttempt[];
  /** Latest native request occupancy, when exposed by the harness. */
  context?: ContextSnapshot;
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
}

export interface WorkflowJournalRoute {
  jobId?: string;
  harness?: HarnessName;
  model?: string;
  /** Actual child lifecycle state and bounded failure detail for durable review. */
  status?: WorkflowAgentState;
  error?: string;
}

export interface WorkflowJournalRecord {
  version: 1;
  sequence: number;
  callIndex: number;
  fingerprint: string;
  state: "started" | "completed" | "failed";
  at: number;
  /** Absent means "agent" for journals written before followUp() existed. */
  kind?: "agent" | "followUp";
  agentIndex?: number;
  result?: WorkflowJournalResult;
  route?: WorkflowJournalRoute;
  replayedFrom?: WorkflowReplayReference;
  replacementOf?: WorkflowReplacementReference;
}

export interface WorkflowReplayCall {
  callIndex: number;
  fingerprint: string;
  kind: "agent" | "followUp";
  /** The lineage this call belongs to; required to reconstruct a followUp() replay. */
  agentIndex?: number;
  result: WorkflowJournalResult;
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
  /** Bounded narrator-style progress emitted by workflow log(). */
  logs?: WorkflowLogRecord[];
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
  result?: unknown;
  error?: string;
  artifactDir: string;
  transcriptArtifact?: string;
  reportArtifact?: string;
}
