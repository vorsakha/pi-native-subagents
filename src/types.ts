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
  nestedAgents: string[];
  depth: number;
  maxDepth: number;
}

export interface BackendRequest {
  jobId: string;
  role: string;
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

export interface RoleRoute {
  model: string;
  thinking: ThinkingLevel;
  /** Deprecated compatibility metadata; runtime effort is request-scoped and provider-adaptive by default. */
  effort?: EffortLevel;
}

export interface RoleDefinition {
  name: string;
  description: string;
  access: AccessMode;
  defaultBackend: BackendName;
  lockedBackend?: BackendName;
  /** Route onto a native provider different from the parent model when possible. */
  differentProviderFromParent?: boolean;
  nestedAgents: string[];
  piTools: string[];
  claudeTools: string[];
  routes: Record<BackendName, RoleRoute>;
  systemPrompt: string;
  filePath: string;
}

export interface WorkflowJobReference {
  runId: string;
  agentIndex: number;
  label: string;
  phase?: string;
}

export interface SpawnRequest {
  role: string;
  task: string;
  cwd: string;
  trusted: boolean;
  backend?: BackendName;
  tier?: ModelTier;
  effort?: EffortLevel;
  parentProvider?: ProviderFamily;
  depth?: number;
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
  role: string;
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
