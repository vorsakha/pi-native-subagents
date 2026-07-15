export type BackendName = "pi" | "claude" | "codex";
export type AccessMode = "readOnly" | "full";
export type ModelTier = "economy" | "balanced" | "quality";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
  | { type: "started"; backendSessionId?: string; at?: number }
  | { type: "text_delta"; text: string; at?: number }
  | { type: "message"; text: string; at?: number }
  | { type: "tool_start"; id: string; name: string; summary?: string; at?: number }
  | { type: "tool_end"; id: string; name?: string; error?: boolean; at?: number }
  | { type: "usage"; usage: Partial<Usage>; at?: number }
  | { type: "completed"; output?: string; at?: number }
  | { type: "failed"; error: string; at?: number }
  | { type: "cancelled"; reason?: string; at?: number };

export interface BackendPolicy {
  backend: BackendName;
  access: AccessMode;
  model: string;
  thinking: ThinkingLevel;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
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
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface RoleDefinition {
  name: string;
  description: string;
  access: AccessMode;
  defaultBackend: BackendName;
  lockedBackend?: BackendName;
  nestedAgents: string[];
  piTools: string[];
  claudeTools: string[];
  routes: Record<BackendName, RoleRoute>;
  systemPrompt: string;
  filePath: string;
}

export interface SpawnRequest {
  role: string;
  task: string;
  cwd: string;
  trusted: boolean;
  backend?: BackendName;
  tier?: ModelTier;
  depth?: number;
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
  task: string;
  cwd: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output: string;
  error?: string;
  truncated: boolean;
  usage: Usage;
  tools: ToolTrace[];
}
