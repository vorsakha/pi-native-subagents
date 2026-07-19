export type BackendName = "pi" | "claude" | "codex";
export type ProviderFamily = "claude" | "codex" | "other";
export type AccessMode = "readOnly" | "full";
export type ModelTier = "economy" | "balanced" | "quality";
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
  backend: BackendName;
  access: AccessMode;
  model: string;
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
  /** Aborts backend initialization before a usable run has been returned. */
  signal: AbortSignal;
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
  readonly name: BackendName;
  start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun>;
}

export type ProfileOrigin = "global" | "project";

export interface ProfileDefinition {
  name: string;
  description: string;
  access?: AccessMode;
  backend?: BackendName;
  modelTier?: ModelTier;
  effort?: EffortLevel;
  independent?: boolean;
  lockedBackend?: BackendName;
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

export interface SpawnRequest {
  name?: string;
  task: string;
  cwd: string;
  trusted: boolean;
  backend?: BackendName;
  modelTier?: ModelTier;
  effort?: EffortLevel;
  access?: AccessMode;
  independent?: boolean;
  profile?: string;
  /** Internal configured fallback; not exposed as a model-facing tool field. */
  defaultBackend?: BackendName;
  parentProvider?: ProviderFamily;
  /** Internal ownership metadata supplied by the workflow runtime, never by a backend. */
  workflow?: WorkflowJobReference;
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
  backend: BackendName;
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
}
