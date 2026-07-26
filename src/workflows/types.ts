import type { AccessMode, EffortLevel, HarnessName, ToolTrace, TranscriptEntry, Usage } from "../types.ts";
import type { WorkflowWorktreeResult } from "./worktree.ts";

export type WorkflowStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export type WorkflowAgentState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted";

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

export interface WorkflowAgentRecord {
  index: number;
  /** Script-level agent() ordinal used by the durable replay journal. */
  callIndex?: number;
  callFingerprint?: string;
  replayedFrom?: WorkflowReplayReference;
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
  transcript?: TranscriptEntry[];
  error?: string;
  usage: WorkflowUsage;
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
}

export interface WorkflowJournalRoute {
  jobId?: string;
  harness?: HarnessName;
  model?: string;
}

export interface WorkflowJournalRecord {
  version: 1;
  sequence: number;
  callIndex: number;
  fingerprint: string;
  state: "started" | "completed" | "failed";
  at: number;
  agentIndex?: number;
  result?: WorkflowJournalResult;
  route?: WorkflowJournalRoute;
  replayedFrom?: WorkflowReplayReference;
}

export interface WorkflowReplayCall {
  callIndex: number;
  fingerprint: string;
  result: WorkflowJournalResult;
  route?: WorkflowJournalRoute;
}

export type WorkflowApprovalMode = "auto" | "plan" | "onMutate";

export interface WorkflowBudgetPolicy {
  maxAgents?: number;
  maxConcurrency?: number;
  maxTokens?: number;
  maxCost?: number;
  maxTurns?: number;
}

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
  timestamps: WorkflowTimestamps;
  currentPhase: number | null;
  phases: WorkflowPhase[];
  agents: WorkflowAgentRecord[];
  /** Bounded narrator-style progress emitted by workflow log(). */
  logs?: WorkflowLogRecord[];
  /** Hash of script, arguments, project cwd, and default routing context. */
  definitionFingerprint?: string;
  replay?: WorkflowReplayState;
  journalArtifact?: string;
  approval?: WorkflowApprovalMode;
  budget?: WorkflowBudgetPolicy;
  warnings?: string[];
  result?: unknown;
  error?: string;
  artifactDir: string;
  transcriptArtifact?: string;
  reportArtifact?: string;
}
