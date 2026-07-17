import type { EffortLevel, ToolTrace, TranscriptEntry } from "../types.ts";

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "aborted";

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
  endedAt?: number;
}

export interface WorkflowBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTurns?: number;
  maxCost?: number;
}

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface WorkflowAgentRecord {
  index: number;
  label: string;
  role: string;
  phase: number;
  jobId?: string;
  state: WorkflowAgentState;
  timestamps: WorkflowTimestamps;
  backend?: string;
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
  result?: unknown;
  error?: string;
  artifactDir: string;
  transcriptArtifact?: string;
  reportArtifact?: string;
  budget?: WorkflowBudget;
}
