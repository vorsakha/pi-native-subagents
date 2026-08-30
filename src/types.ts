import type {
  CapabilityHealth,
  CapabilitySourceStatus,
  DiscoveredCapability,
} from "./capabilities.ts";
import type { InteractionHandler, InteractionTargetKind, JobInteractionPolicy, PendingInteraction } from "./interactions.ts";
import type { ParentThreadSnapshot } from "./parent-thread-context.ts";
import type { SpendBudget } from "./budget.ts";
import type { ProviderUnavailability } from "./provider-unavailability.ts";

export type HarnessName = "pi" | "claude" | "codex";
export type ProviderFamily = "claude" | "codex" | "other";
export type AccessMode = "readOnly" | "full";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSpeed = "standard" | "fast";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Private native lineage handle. It is persisted only by the advisor store. */
export type NativeContinuation =
  | { harness: "pi"; sessionFile: string }
  | { harness: "claude"; sessionId: string }
  | { harness: "codex"; threadId: string; sessionFile?: string };

export interface Usage {
  /** Fresh, non-cached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/**
 * Latest native request occupancy. This is a gauge, not cumulative usage.
 * A field is omitted, never zero, when the runtime did not report it.
 */
export interface ContextSnapshot {
  tokens?: number;
  window?: number;
  /** Model identity reported by the native runtime for the current turn; never the configured policy model. */
  servingModel?: string;
  /** Authoritative served tier reported for the current turn; never inferred from request or settings. */
  effectiveSpeed?: AgentSpeed;
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
  /** Manager-only notification that a newly spawned job is queued and awaiting a scheduler slot; never emitted by a backend adapter. */
  | { type: "queued"; at?: number }
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
  /** `structured` is the authoritative terminal payload from a provider-native structured-result channel; present only when `BackendPolicy.structuredOutput` was requested and the runtime honored it. */
  | { type: "completed"; output?: string; structured?: unknown; at?: number }
  | { type: "failed"; error: string; unavailable?: ProviderUnavailability; at?: number }
  | { type: "cancelled"; reason?: string; at?: number }
  /** An optional native integration failed; the job continues without it. */
  | { type: "degraded"; source: string; detail: string; at?: number }
  /** A host-routed question opened, advanced, or settled on this job. */
  | { type: "interaction"; interaction: PendingInteraction; at?: number }
  /** The job's pending question is no longer displayable; the caller resumed. */
  | { type: "interaction_cleared"; requestId: string; at?: number }
  /** This job's retained session started or finished producing a peer answer. */
  | { type: "interaction_answering"; answering?: { requestId: string; sourceJobId: string; sourceName: string }; at?: number };

/** Bounded JSON Schema a caller wants a provider-native terminal channel to validate and return, instead of prompt/parse text extraction. Workflow-internal only; never a model-facing tool field. */
export interface StructuredOutputPolicy {
  schema: Record<string, unknown>;
}

/** What a live runtime reports about its own native structured-result mechanism, from a zero-model-turn probe. */
export interface StructuredOutputSupport {
  supported: boolean;
  /** Free-form mechanism id for receipts, e.g. `claude-agent-sdk:outputFormat.json_schema`. */
  mechanism?: string;
  /** Why unsupported, or how support was detected. */
  detail?: string;
}

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
  /** Requested service policy. `standard` preserves the provider's native configuration. */
  speed: AgentSpeed;
  piTools: string[];
  claudeTools: string[];
  approvalPolicy: "never";
  codexSandbox: { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: false };
  /** Present only when the workflow runtime selected a provider-native structured-result transport for this dispatch. */
  structuredOutput?: StructuredOutputPolicy;
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
  /** Existing native lineage to resume. The harness must match `policy.harness`. */
  continuation?: NativeContinuation;
  /** Previously accounted cumulative usage for that exact native lineage. */
  initialUsage?: Usage;
  /** When true, the initial message is sent verbatim instead of prefixed with the generic "Task:" wrapper. */
  rawInitialMessage?: boolean;
  /** Read-only spawn-time snapshot available only to human /subagent jobs through parent_thread_context. */
  parentThread?: ParentThreadSnapshot;
  /**
   * Live host callback for routed questions. Present only when the job carries
   * an authorized interaction policy; adapters must not advertise the child ask
   * tool without it. Never serialized into a snapshot or artifact.
   */
  interactions?: InteractionHandler;
  /** Authorized target kinds, used only to describe the injected tool accurately. */
  interactionTargets?: InteractionTargetKind[];
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
  /** Optional zero-model-turn probe of this runtime's native structured-result support. Absent adapters are treated as unsupported. */
  structuredOutputSupport?(request: DiscoveryRequest): Promise<StructuredOutputSupport>;
}

export type ProfileOrigin = "global" | "project";

export interface ProfileDefinition {
  name: string;
  description: string;
  access?: AccessMode;
  harness?: HarnessName;
  effort?: EffortLevel;
  /** Optional speed ceiling or permission. Never authorizes Fast without request.speed. */
  speed?: AgentSpeed;
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

/** Internal ownership marker for a read-only advisor lineage. */
export interface AdvisorJobReference {
  advisorId: string;
  threadId: string;
  /** Workflow origin keeps this advisor turn in the workflow scheduler lane. */
  workflow?: { runId: string; callIndex: number };
}

/** Private profile behavior captured when an advisor is opened. */
export interface BoundAdvisorProfile {
  name: string;
  systemPrompt: string;
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
  /** Explicit per-agent speed policy; defaults to standard. */
  speed?: AgentSpeed;
  access?: AccessMode;
  independent?: boolean;
  /** Route on a native provider different from this existing session-scoped job. */
  independentOf?: string;
  /** Internal authoritative provider hint for replayed jobs or continued logical IDs; a live target must match it. */
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
  /** Internal abortable admission check run after scheduler selection and immediately before backend startup. */
  dispatchAdmission?: (signal: AbortSignal) => Promise<DispatchAdmissionResult | undefined>;
  /** Internal session-peer fork data (source provenance plus the already-forked session file to resume). Pi-only; never set by a harness adapter. */
  peer?: PeerSessionReference & { sessionFile: string };
  /** Internal workflow-runtime request for a provider-native structured-result channel; never a model-facing tool field. */
  structuredOutput?: StructuredOutputPolicy;
  /** Internal advisor ownership. Presence forces read-only access and disables routed questions. */
  advisor?: AdvisorJobReference;
  /** Immutable profile behavior for an advisor job. Never copied into JobSnapshot. */
  advisorProfile?: BoundAdvisorProfile;
  /** Private native lineage restored by an advisor. */
  continuation?: NativeContinuation;
  /** Cumulative usage restored with an advisor lineage. */
  initialUsage?: Usage;
  /** Last completed advisor generation restored with a native lineage. */
  initialGeneration?: number;
  /** Internal authorization for host-routed questions; absent means the child never sees an ask tool. */
  interaction?: JobInteractionPolicy;
  /**
   * Host-side admission check for one routed question, mirroring
   * {@link SpawnRequest.dispatchGate}. Returns a bounded refusal reason to
   * reject the question before any interaction state is created; the workflow
   * runtime uses it for the bounded interaction count and budget preflight.
   */
  interactionGate?: (target: InteractionTargetKind) => string | undefined;
}

export interface DispatchAdmissionResult {
  error?: string;
  /** Fresh capability proof for the already-compiled harness; cannot change providers or requirements. */
  capabilityRoute?: JobCapabilityRoute;
}

export interface ToolTrace {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: ToolResultSnapshot;
  summary?: string;
  status: "running" | "completed" | "failed";
}

/** Bounded live operational evidence for supervision UI. Never persisted. */
export type AgentActivitySnapshot =
  | { kind: "reasoning" | "responding"; at: number }
  | {
      kind: "tool";
      at: number;
      tool: string;
      state: ToolTrace["status"];
      target?: string;
    };

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
  /** Resolved requested policy, fixed for the retained lineage. */
  speed: AgentSpeed;
  task: string;
  cwd: string;
  status: JobStatus;
  /** Increments each time a retained native session starts another turn. */
  generation: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output: string;
  /** Authoritative terminal payload from a provider-native structured-result channel; absent when only the fallback prompt/parse path applies. */
  structured?: unknown;
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
  activity?: AgentActivitySnapshot;
  queuedMessages: QueuedMessage[];
  backendSessionId?: string;
  sessionFile?: string;
  workflow?: WorkflowJobReference;
  /** Advisor ownership is safe to display; native continuation data is not. */
  advisor?: AdvisorJobReference;
  /** Present when this job is a read-only session peer forked from a saved Pi session. */
  peer?: PeerSessionReference;
  /** Capability IDs required by the caller. */
  requires?: string[];
  /** Effective capability route recorded at pre-dispatch revalidation. */
  capabilities?: JobCapabilityRoute;
  /** Bounded degraded-integration notices reported by the harness. */
  warnings?: string[];
  /** Structured provider-quota classification from the terminal `failed` event, when recognized. */
  unavailable?: ProviderUnavailability;
  /** True once the job observed model text, thinking, or tool activity; unset means a rejection before any progress. */
  progressed?: boolean;
  /** Bounded pending or just-settled host-routed question this job is parked on. */
  interaction?: PendingInteraction;
  /** Present while this job's retained session is answering a peer question. */
  answeringInteraction?: { requestId: string; sourceJobId: string; sourceName: string };
  /** Cumulative host-routed questions this job has asked. */
  interactionsAsked?: number;
}
