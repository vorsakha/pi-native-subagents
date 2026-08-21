import type {
  CapabilityHealth,
  CapabilitySourceStatus,
  DiscoveredCapability,
} from "./capabilities.ts";
import type { ParentThreadSnapshot } from "./parent-thread-context.ts";
import type { SpendBudget } from "./budget.ts";

export type HarnessName = "pi" | "claude" | "codex";
export type ProviderFamily = "claude" | "codex" | "other";
export type AccessMode = "readOnly" | "full";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Usage {
  /** Fresh, non-cached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/** Latest native request occupancy. This is a gauge, not cumulative usage. */
export interface ContextSnapshot {
  tokens: number;
  window?: number;
  servingModel?: string;
}

export interface ToolResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResultSnapshot {
  content: ToolResultContent[];
  details?: unknown;
  isError: boolean;
}

export type BackendEvent =
  | { type: "started"; backendSessionId?: string; sessionFile?: string; at?: number }
  | { type: "user_message"; text: string; at?: number }
  | { type: "text_delta"; text: string; at?: number }
  | { type: "thinking_delta"; text: string; at?: number }
  | { type: "thinking_message"; text: string; at?: number }
  | { type: "message"; text: string; at?: number }
  | { type: "queue_changed"; messages: QueuedMessage[]; at?: number }
  | { type: "tool_start"; id: string; name: string; args?: Record<string, unknown>; summary?: string; at?: number }
  | { type: "tool_end"; id: string; name?: string; result?: ToolResultSnapshot; output?: string; error?: boolean; at?: number }
  | { type: "usage"; usage: Partial<Usage>; at?: number }
  | { type: "context"; context: ContextSnapshot; at?: number }
  | { type: "completed"; output?: string; at?: number }
  | { type: "failed"; error: string; at?: number }
  | { type: "cancelled"; reason?: string; at?: number }
  /** An optional native integration failed; the job continues without it. */
  | { type: "degraded"; source: string; detail: string; at?: number };

/**
 * `native` loads the harness's installed context, skills, plugins, and MCP
 * inside the access ceiling. `isolated` keeps the historical stripped launch and
 * is used for tool-less session peers.
 */
export type CustomizationMode = "native" | "isolated";

export interface BackendPolicy {
  harness: HarnessName;
  access: AccessMode;
  /** Native customization parity mode; defaults to `native`. */
  customization: CustomizationMode;
  /** Capability IDs the caller required; adapters must not silently drop them. */
  requires?: string[];
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
  /** Read-only spawn-time snapshot available only to human /subagent jobs through parent_thread_context. */
  parentThread?: ParentThreadSnapshot;
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
  | {
      kind: "tool";
      phase?: "start" | "end";
      toolId: string;
      name: string;
      args?: Record<string, unknown>;
      result?: ToolResultSnapshot;
      text?: string;
      error?: boolean;
      at?: number;
    };

export interface BackendRun {
  completed: Promise<void>;
  send(message: string, behavior?: SendBehavior): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
  /** Immediate teardown used after a manager deadline; must settle `completed`. */
  forceClose?(): Promise<void>;
}

/** Zero-turn capability/readiness discovery request. Discovery never sends a user message. */
export interface DiscoveryRequest {
  cwd: string;
  access: AccessMode;
  customization: CustomizationMode;
  /** Optional harness-local model whose readiness must be verified. */
  model?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Bypass native caches (Codex `forceReload`, fresh SDK/RPC initialization). */
  refresh: boolean;
}

export interface DiscoveryResult {
  capabilities: DiscoveredCapability[];
  sources: CapabilitySourceStatus[];
  warnings?: string[];
  nativeVersion?: string;
  /** Overall discovery health; omitted means derived from `sources`. */
  health?: CapabilityHealth;
}

export interface Backend {
  readonly name: HarnessName;
  start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun>;
  /** Optional zero-model-turn native inventory. Absent adapters report an unknown catalog. */
  discover?(request: DiscoveryRequest): Promise<DiscoveryResult>;
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

/** Capability provenance recorded on a job after live pre-dispatch revalidation. */
export interface JobCapabilityRoute {
  harness: HarnessName;
  /** Capability IDs that satisfied the request's requirements. */
  matched: string[];
  revision: string;
  discoveredAt: number;
  /** Set when the route was chosen by `harness: "auto"` rather than an explicit route. */
  auto?: boolean;
  warnings?: string[];
}

export interface SpawnRequest {
  name?: string;
  task: string;
  cwd: string;
  trusted: boolean;
  harness?: HarnessName;
  /** Capability IDs the child must actually have; revalidated live before dispatch. */
  requires?: string[];
  /** Internal override; only tool-less session peers opt out of native customization. */
  customization?: CustomizationMode;
  /** Route provenance captured when requirements were resolved before spawning. */
  capabilityRoute?: JobCapabilityRoute;
  /** Harness-local model ID selected by the caller or routing skill. */
  model?: string;
  effort?: EffortLevel;
  access?: AccessMode;
  independent?: boolean;
  /** Route on a native provider different from this existing session-scoped job. */
  independentOf?: string;
  /** Internal durable-replay hint used only when independentOf names a prior-session job no longer retained by JobManager. */
  independentOfProvider?: ProviderFamily;
  profile?: string;
  /** Optional cumulative spend boundary for this retained native session. */
  budget?: SpendBudget;
  /** Internal configured fallback; not exposed as a model-facing tool field. */
  defaultHarness?: HarnessName;
  parentProvider?: ProviderFamily;
  /** Internal TUI-only delivery marker for human-triggered background commands. */
  humanVisible?: boolean;
  /** Permitted parent Pi tools inherited only by full-access human-triggered Pi jobs. */
  humanPiTools?: string[];
  /** Internal read-only spawn-time snapshot attached only by the human /subagent command. */
  parentThread?: ParentThreadSnapshot;
  /** Internal ownership metadata supplied by the workflow runtime, never by a harness adapter. */
  workflow?: WorkflowJobReference;
  /** Internal synchronous gate checked immediately before a queued job starts. */
  dispatchGate?: () => string | undefined;
  /** Internal session-peer fork data (source provenance plus the already-forked session file to resume). Pi-only; never set by a harness adapter. */
  peer?: PeerSessionReference & { sessionFile: string };
}

export interface ToolTrace {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: ToolResultSnapshot;
  summary?: string;
  status: "running" | "completed" | "failed";
}

export interface JobSnapshot {
  id: string;
  name: string;
  access: AccessMode;
  profile?: string;
  independent: boolean;
  /** Existing job whose native provider this job was routed against. */
  independentOf?: string;
  /** True when the job was started by the human-facing /subagent command. */
  humanVisible?: boolean;
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
  /** Omitted means open spend budget. Usage is cumulative across retained follow-ups. */
  budget?: SpendBudget;
  /** Latest native request occupancy, when the harness exposes it. */
  context?: ContextSnapshot;
  tools: ToolTrace[];
  transcript: TranscriptEntry[];
  liveThinking: string;
  queuedMessages: QueuedMessage[];
  backendSessionId?: string;
  sessionFile?: string;
  workflow?: WorkflowJobReference;
  /** Present when this job is a read-only session peer forked from a saved Pi session. */
  peer?: PeerSessionReference;
  /** Capability IDs required by the caller. */
  requires?: string[];
  /** Effective capability route recorded at pre-dispatch revalidation. */
  capabilities?: JobCapabilityRoute;
  /** Bounded degraded-integration notices reported by the harness. */
  warnings?: string[];
}
