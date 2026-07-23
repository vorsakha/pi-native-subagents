export type HarnessName = "pi" | "claude" | "codex";
export type ProviderFamily = "claude" | "codex" | "other";
export type AccessMode = "readOnly" | "full";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export type BackendEvent =
  | { type: "started"; backendSessionId?: string; sessionFile?: string; at?: number }
  | { type: "user_message"; text: string; at?: number }
  | { type: "text_delta"; text: string; at?: number }
  | { type: "thinking_delta"; text: string; at?: number }
  | { type: "thinking_message"; text: string; at?: number }
  | { type: "message"; text: string; at?: number }
  | { type: "queue_changed"; messages: QueuedMessage[]; at?: number }
  | { type: "tool_start"; id: string; name: string; summary?: string; at?: number }
  | { type: "tool_end"; id: string; name?: string; output?: string; error?: boolean; at?: number }
  | { type: "usage"; usage: Partial<Usage>; at?: number }
  | { type: "completed"; output?: string; at?: number }
  | { type: "failed"; error: string; at?: number }
  | { type: "cancelled"; reason?: string; at?: number };

export interface BackendPolicy {
  harness: HarnessName;
  access: AccessMode;
  /** Optional harness-local model ID. Omitted to use the harness's native default. */
  model?: string;
  thinking: ThinkingLevel;
  /** Optional provider hint. Omitted by default so the model/provider remains adaptive. */
  effort?: EffortLevel;
  piTools: string[];
  claudeTools: string[];
  approvalPolicy: "never";
  codexSandbox: { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: false };
}

export interface BackendRequest {
  jobId: string;
  name: string;
  task: string;
  systemPrompt: string;
  cwd: string;
  policy: BackendPolicy;
  env: NodeJS.ProcessEnv;
  /** Aborts harness initialization before a usable run has been returned. */
  signal: AbortSignal;
  /** Existing Pi session file to resume instead of starting fresh. Pi-only; other backends ignore it. */
  resumeSessionFile?: string;
  /** When true, the initial message is sent verbatim instead of prefixed with the generic "Task:" wrapper. */
  rawInitialMessage?: boolean;
}

export type SendBehavior = "steer" | "followUp";

export interface QueuedMessage {
  text: string;
  behavior: SendBehavior;
}

export type TranscriptEntry =
  | { kind: "user"; text: string; at?: number }
  | { kind: "assistant"; text: string; at?: number }
  | { kind: "thinking"; text: string; at?: number }
  | { kind: "tool"; toolId: string; name: string; text?: string; error?: boolean; at?: number };

export interface BackendRun {
  completed: Promise<void>;
  send(message: string, behavior?: SendBehavior): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
  /** Immediate teardown used after a manager deadline; must settle `completed`. */
  forceClose?(): Promise<void>;
}

export interface Backend {
  readonly name: HarnessName;
  start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun>;
}

export type ProfileOrigin = "global" | "project";

export interface ProfileDefinition {
  name: string;
  description: string;
  access?: AccessMode;
  harness?: HarnessName;
  effort?: EffortLevel;
  independent?: boolean;
  lockedHarness?: HarnessName;
  systemPrompt: string;
  filePath: string;
  origin: ProfileOrigin;
}

export interface ProfileValidationWarning {
  filePath: string;
  origin: ProfileOrigin;
  message: string;
}

export interface WorkflowJobReference {
  runId: string;
  agentIndex: number;
  label: string;
  phase?: string;
}

/** Provenance for a job forked from a saved Pi session (a "session peer"). */
export interface PeerSessionReference {
  sourceSessionId: string;
  sourceCwd: string;
  sourceName?: string;
}

export interface SpawnRequest {
  name?: string;
  task: string;
  cwd: string;
  trusted: boolean;
  harness?: HarnessName;
  /** Harness-local model ID selected by the caller or routing skill. */
  model?: string;
  effort?: EffortLevel;
  access?: AccessMode;
  independent?: boolean;
  profile?: string;
  /** Internal configured fallback; not exposed as a model-facing tool field. */
  defaultHarness?: HarnessName;
  parentProvider?: ProviderFamily;
  /** Internal ownership metadata supplied by the workflow runtime, never by a harness adapter. */
  workflow?: WorkflowJobReference;
  /** Internal session-peer fork data (source provenance plus the already-forked session file to resume). Pi-only; never set by a harness adapter. */
  peer?: PeerSessionReference & { sessionFile: string };
}

export interface ToolTrace {
  id: string;
  name: string;
  summary?: string;
  status: "running" | "completed" | "failed";
}

export interface JobSnapshot {
  id: string;
  name: string;
  access: AccessMode;
  profile?: string;
  independent: boolean;
  harness: HarnessName;
  model: string;
  /** Explicit request-scoped provider effort; omitted means provider-adaptive. */
  effort?: EffortLevel;
  task: string;
  cwd: string;
  status: JobStatus;
  /** Increments each time a retained native session starts another turn. */
  generation: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output: string;
  error?: string;
  truncated: boolean;
  usage: Usage;
  tools: ToolTrace[];
  transcript: TranscriptEntry[];
  liveThinking: string;
  queuedMessages: QueuedMessage[];
  backendSessionId?: string;
  sessionFile?: string;
  workflow?: WorkflowJobReference;
  /** Present when this job is a read-only session peer forked from a saved Pi session. */
  peer?: PeerSessionReference;
}
