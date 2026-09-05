import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { JobSnapshot, Usage } from "./types.ts";
import type {
  WorkflowAgentRecord,
  WorkflowPhase,
  WorkflowSnapshot,
  WorkflowTimestamps,
  WorkflowUsage,
} from "./workflows/types.ts";

export const NATIVE_SUBAGENTS_STATE_EVENT_V1 = "native-subagents:state:v1" as const;
export const NATIVE_SUBAGENTS_PRODUCER_NAME = "@vorsakha/pi-native-subagents" as const;
export const NATIVE_SUBAGENTS_PRODUCER_VERSION = "0.1.0";

export const MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS = 100;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS = 64;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS = 32;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES = 64;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS = 200;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS = 160;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS = 2_000;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES = 512 * 1024;
export const MAX_NATIVE_SUBAGENTS_STATE_V1_NUMBER = Number.MAX_SAFE_INTEGER;

export const NATIVE_SUBAGENTS_STATE_V1_LIMITS = Object.freeze({
  jobs: MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS,
  workflows: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS,
  workflowAgents: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS,
  phases: MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES,
  idChars: MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS,
  nameChars: MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS,
  summaryChars: MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS,
  serializedBytes: MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES,
  maximumNumber: MAX_NATIVE_SUBAGENTS_STATE_V1_NUMBER,
});

const exact = { additionalProperties: false } as const;
const boundedNumber = Type.Number({ minimum: 0, maximum: MAX_NATIVE_SUBAGENTS_STATE_V1_NUMBER });
const boundedInteger = Type.Integer({ minimum: 0, maximum: MAX_NATIVE_SUBAGENTS_STATE_V1_NUMBER });
const positiveInteger = Type.Integer({ minimum: 1, maximum: MAX_NATIVE_SUBAGENTS_STATE_V1_NUMBER });
const safePresentationCharacter =
  String.raw`(?:[^\s\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])`;
const normalizedPresentationText = `^${safePresentationCharacter}+(?: ${safePresentationCharacter}+)*$`;
const identifier = Type.String({
  minLength: 1,
  maxLength: MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS,
  pattern: normalizedPresentationText,
});
const displayName = Type.String({
  minLength: 1,
  maxLength: MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS,
  pattern: normalizedPresentationText,
});
const summary = Type.String({
  minLength: 1,
  maxLength: MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS,
  pattern: normalizedPresentationText,
});
const timestamp = boundedInteger;
const jobStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
const workflowStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
]);
const workflowAgentStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("aborted"),
]);
const harness = Type.Union([Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex")]);
const access = Type.Union([Type.Literal("readOnly"), Type.Literal("full")]);
const effort = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const speed = Type.Union([Type.Literal("standard"), Type.Literal("fast")]);

export const NativeSubagentsUsageV1Schema = Type.Object({
  input: boundedNumber,
  output: boundedNumber,
  cacheRead: boundedNumber,
  cacheWrite: boundedNumber,
  cost: boundedNumber,
  turns: boundedNumber,
}, exact);

const jobTimestampsSchema = Type.Object({
  createdAt: timestamp,
  startedAt: Type.Optional(timestamp),
  endedAt: Type.Optional(timestamp),
}, exact);

const workflowTimestampsSchema = Type.Object({
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: Type.Optional(timestamp),
  pausedAt: Type.Optional(timestamp),
  endedAt: Type.Optional(timestamp),
}, exact);

const jobRouteSchema = Type.Object({
  harness,
  model: displayName,
  access,
  effort: Type.Optional(effort),
  speed,
}, exact);

const workflowAgentRouteSchema = Type.Object({
  harness: Type.Optional(harness),
  model: Type.Optional(displayName),
  access,
  effort: Type.Optional(effort),
  speed: Type.Optional(speed),
}, exact);

export const NativeSubagentJobStateV1Schema = Type.Object({
  id: identifier,
  name: displayName,
  kind: Type.Union([
    Type.Literal("direct"),
    Type.Literal("workflow-agent"),
    Type.Literal("session-peer"),
  ]),
  status: jobStatus,
  generation: boundedInteger,
  timestamps: jobTimestampsSchema,
  route: jobRouteSchema,
  relationships: Type.Object({
    workflow: Type.Optional(Type.Object({
      runId: identifier,
      agentIndex: boundedInteger,
      phase: Type.Optional(displayName),
    }, exact)),
    independentOfJobId: Type.Optional(identifier),
  }, exact),
  usage: Type.Optional(NativeSubagentsUsageV1Schema),
  waitingSummary: Type.Optional(summary),
  resultSummary: Type.Optional(summary),
  errorSummary: Type.Optional(summary),
}, exact);

export const NativeWorkflowPhaseStateV1Schema = Type.Object({
  index: boundedInteger,
  name: displayName,
  status: workflowStatus,
  timestamps: workflowTimestampsSchema,
  agentIndexes: Type.Array(boundedInteger, { maxItems: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS }),
}, exact);

export const NativeWorkflowAgentStateV1Schema = Type.Object({
  index: boundedInteger,
  jobId: Type.Optional(identifier),
  logicalJobId: Type.Optional(identifier),
  name: displayName,
  status: workflowAgentStatus,
  phaseIndex: boundedInteger,
  timestamps: workflowTimestampsSchema,
  route: workflowAgentRouteSchema,
  relationships: Type.Object({
    independentOfJobId: Type.Optional(identifier),
    replayedFrom: Type.Optional(Type.Object({
      runId: identifier,
      callIndex: boundedInteger,
    }, exact)),
    replacedBy: Type.Optional(Type.Object({ runId: identifier }, exact)),
    continuation: Type.Optional(Type.Object({
      fromJobId: identifier,
      toJobId: Type.Optional(identifier),
    }, exact)),
  }, exact),
  usage: Type.Optional(NativeSubagentsUsageV1Schema),
  waitingSummary: Type.Optional(summary),
  resultSummary: Type.Optional(summary),
  errorSummary: Type.Optional(summary),
}, exact);

export const NativeWorkflowStateV1Schema = Type.Object({
  id: identifier,
  name: displayName,
  status: workflowStatus,
  taskOutcome: Type.Optional(Type.Union([
    Type.Literal("successful"),
    Type.Literal("unsuccessful"),
    Type.Literal("unspecified"),
  ])),
  timestamps: workflowTimestampsSchema,
  currentPhase: Type.Optional(Type.Object({
    index: boundedInteger,
    name: displayName,
    status: workflowStatus,
  }, exact)),
  phases: Type.Array(NativeWorkflowPhaseStateV1Schema, { maxItems: MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES }),
  agents: Type.Array(NativeWorkflowAgentStateV1Schema, { maxItems: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS }),
  relationships: Type.Object({
    replayedFrom: Type.Optional(Type.Object({ runId: identifier }, exact)),
    replacementOf: Type.Optional(Type.Object({
      runId: identifier,
      agentIndex: boundedInteger,
    }, exact)),
  }, exact),
  usage: Type.Optional(NativeSubagentsUsageV1Schema),
  waitingSummary: Type.Optional(summary),
  resultSummary: Type.Optional(summary),
  errorSummary: Type.Optional(summary),
}, exact);

export const NativeSubagentsStateV1Schema = Type.Object({
  schemaVersion: Type.Literal(1),
  producer: Type.Object({
    name: Type.Literal(NATIVE_SUBAGENTS_PRODUCER_NAME),
    version: displayName,
    instanceId: identifier,
  }, exact),
  sequence: positiveInteger,
  emittedAt: timestamp,
  cause: Type.Union([Type.Literal("startup"), Type.Literal("update"), Type.Literal("shutdown")]),
  session: Type.Object({
    id: identifier,
    lifecycle: Type.Union([Type.Literal("active"), Type.Literal("closed")]),
  }, exact),
  truncation: Type.Object({
    jobsOmitted: boundedInteger,
    workflowsOmitted: boundedInteger,
    workflowAgentsOmitted: boundedInteger,
    phasesOmitted: boundedInteger,
    summariesTruncated: boundedInteger,
  }, exact),
  jobs: Type.Array(NativeSubagentJobStateV1Schema, { maxItems: MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS }),
  workflows: Type.Array(NativeWorkflowStateV1Schema, { maxItems: MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS }),
}, exact);

export type NativeSubagentsUsageV1 = Static<typeof NativeSubagentsUsageV1Schema>;
export type NativeSubagentJobStateV1 = Static<typeof NativeSubagentJobStateV1Schema>;
export type NativeWorkflowPhaseStateV1 = Static<typeof NativeWorkflowPhaseStateV1Schema>;
export type NativeWorkflowAgentStateV1 = Static<typeof NativeWorkflowAgentStateV1Schema>;
export type NativeWorkflowStateV1 = Static<typeof NativeWorkflowStateV1Schema>;
export type NativeSubagentsStateV1 = Static<typeof NativeSubagentsStateV1Schema>;

export interface NativeSubagentsProjectionOptionsV1 {
  producerVersion: string;
  instanceId: string;
  sequence: number;
  emittedAt: number;
  cause: NativeSubagentsStateV1["cause"];
  sessionId: string;
  lifecycle: NativeSubagentsStateV1["session"]["lifecycle"];
}

interface ProjectionContext {
  summaryEffects: Map<string, Set<string>>;
  workflowSources: WeakMap<NativeWorkflowStateV1, { agents: number; phases: number }>;
}

const ESCAPE_SEQUENCE =
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\u001B]*(?:\u001B\\)|.)/g;
const UNSAFE_PRESENTATION_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function replaceInvalidSurrogates(value: string): string {
  let result = "";
  for (const character of value) {
    const codeUnit = character.charCodeAt(0);
    result += character.length === 1 && codeUnit >= 0xD800 && codeUnit <= 0xDFFF ? " " : character;
  }
  return result;
}

function boundedText(value: string, limit: number, fallback: string): { text: string; truncated: boolean } {
  const normalized = replaceInvalidSurrogates(value)
    .replace(ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_PRESENTATION_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  let text = "";
  for (const character of normalized) {
    if (text.length + character.length > limit) break;
    text += character;
  }
  return { text: text || fallback, truncated: text.length < normalized.length };
}

function boundedId(value: string): string {
  return boundedText(value, MAX_NATIVE_SUBAGENTS_STATE_V1_ID_CHARS, "unknown").text;
}

function boundedName(value: string): string {
  return boundedText(value, MAX_NATIVE_SUBAGENTS_STATE_V1_NAME_CHARS, "unnamed").text;
}

function markSummaryEffect(context: ProjectionContext, recordKey: string, field: string): boolean {
  const fields = context.summaryEffects.get(recordKey) ?? new Set<string>();
  if (fields.has(field)) return false;
  fields.add(field);
  context.summaryEffects.set(recordKey, fields);
  return true;
}

function boundedSummary(value: string, context: ProjectionContext, recordKey: string, field: string): string {
  const result = boundedText(value, MAX_NATIVE_SUBAGENTS_STATE_V1_SUMMARY_CHARS, "No details available.");
  if (result.truncated) markSummaryEffect(context, recordKey, field);
  return result.text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function latestJobTimestamp(job: JobSnapshot): number {
  return job.endedAt ?? job.startedAt ?? job.createdAt;
}

function isTerminalJob(status: JobSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalWorkflow(status: WorkflowSnapshot["status"] | WorkflowPhase["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function isTerminalAgent(status: WorkflowAgentRecord["state"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "aborted";
}

function compareJobs(left: JobSnapshot, right: JobSnapshot): number {
  return Number(isTerminalJob(left.status)) - Number(isTerminalJob(right.status))
    || latestJobTimestamp(right) - latestJobTimestamp(left)
    || compareText(left.id, right.id);
}

function compareWorkflows(left: WorkflowSnapshot, right: WorkflowSnapshot): number {
  return Number(isTerminalWorkflow(left.status)) - Number(isTerminalWorkflow(right.status))
    || right.timestamps.updatedAt - left.timestamps.updatedAt
    || compareText(left.runId, right.runId);
}

function compareAgents(left: WorkflowAgentRecord, right: WorkflowAgentRecord): number {
  return Number(isTerminalAgent(left.state)) - Number(isTerminalAgent(right.state))
    || right.timestamps.updatedAt - left.timestamps.updatedAt
    || left.index - right.index;
}

function projectTimestamps(value: WorkflowTimestamps): NativeWorkflowStateV1["timestamps"] {
  return {
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    ...(value.pausedAt === undefined ? {} : { pausedAt: value.pausedAt }),
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
  };
}

function usageValue(value: Partial<Usage | WorkflowUsage> | undefined): NativeSubagentsUsageV1 {
  return {
    input: value?.input ?? 0,
    output: value?.output ?? 0,
    cacheRead: value?.cacheRead ?? 0,
    cacheWrite: value?.cacheWrite ?? 0,
    cost: value?.cost ?? 0,
    turns: value?.turns ?? 0,
  };
}

function optionalUsage(value: Partial<Usage | WorkflowUsage> | undefined): NativeSubagentsUsageV1 | undefined {
  const usage = usageValue(value);
  return Object.values(usage).some((item) => item !== 0) ? usage : undefined;
}

function workflowUsage(workflow: WorkflowSnapshot): NativeSubagentsUsageV1 | undefined {
  const total = workflow.agents.reduce((sum, agent) => {
    const usage = usageValue(agent.usage);
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheRead += usage.cacheRead;
    sum.cacheWrite += usage.cacheWrite;
    sum.cost += usage.cost;
    sum.turns += usage.turns;
    return sum;
  }, usageValue(undefined));
  return Object.values(total).some((item) => item !== 0) ? total : undefined;
}

function jobResultSummary(status: JobSnapshot["status"]): string | undefined {
  return status === "completed" ? "Job completed." : undefined;
}

function agentResultSummary(status: WorkflowAgentRecord["state"]): string | undefined {
  return status === "completed" ? "Workflow agent completed." : undefined;
}

function workflowResultSummary(
  status: WorkflowSnapshot["status"],
  taskOutcome: WorkflowSnapshot["taskOutcome"],
): string | undefined {
  if (status !== "completed") return undefined;
  if (taskOutcome === "successful") return "Workflow completed successfully.";
  if (taskOutcome === "unsuccessful") return "Workflow completed unsuccessfully.";
  return "Workflow completed with an unspecified task outcome.";
}

function safeErrorSummary(kind: "job" | "workflow" | "agent", status: string, quotaUnavailable = false): string | undefined {
  if (status !== "failed" && status !== "cancelled" && status !== "aborted") return undefined;
  if (status === "failed" && quotaUnavailable) return kind === "job" ? "Job failed because provider quota is unavailable." : "Workflow agent failed because provider quota is unavailable.";
  if (status === "cancelled") return kind === "job" ? "Job cancelled." : "Workflow agent cancelled.";
  if (status === "aborted") return kind === "agent" ? "Workflow agent aborted." : "Workflow aborted.";
  const label = kind === "job" ? "Job" : kind === "workflow" ? "Workflow" : "Workflow agent";
  return `${label} failed.`;
}

function waitingJobSummary(job: JobSnapshot): string | undefined {
  const interaction = job.interaction;
  if (interaction && (interaction.state === "pending" || interaction.state === "answering")) {
    return interaction.target.kind === "agent" ? "Waiting for a peer agent." : "Waiting for host input.";
  }
  if (job.answeringInteraction) return "Answering a peer agent.";
  if (job.status === "queued") return "Waiting for a scheduler slot.";
  return undefined;
}

function waitingAgentSummary(agent: WorkflowAgentRecord): string | undefined {
  if (agent.providerWait) {
    return `Waiting to retry ${agent.providerWait.provider} at ${agent.providerWait.retryAt}; attempt ${agent.providerWait.attempt} of ${agent.providerWait.maxAttempts}.`;
  }
  if (agent.waitingOn) {
    return agent.waitingOn.target === "peer" ? "Waiting for a peer agent." : "Waiting for host input.";
  }
  if (agent.answering) return "Answering a peer agent.";
  if (agent.state === "queued") return "Waiting for a scheduler slot.";
  return undefined;
}

function projectJob(job: JobSnapshot, context: ProjectionContext): NativeSubagentJobStateV1 {
  const recordKey = `job:${boundedId(job.id)}`;
  const waiting = waitingJobSummary(job);
  const result = jobResultSummary(job.status);
  const error = safeErrorSummary("job", job.status, job.unavailable?.kind === "quota");
  const usage = optionalUsage(job.usage);
  return {
    id: boundedId(job.id),
    name: boundedName(job.name),
    kind: job.workflow ? "workflow-agent" : job.peer ? "session-peer" : "direct",
    status: job.status,
    generation: job.generation,
    timestamps: {
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    },
    route: {
      harness: job.harness,
      model: boundedName(job.model),
      access: job.access,
      ...(job.effort === undefined ? {} : { effort: job.effort }),
      speed: job.speed,
    },
    relationships: {
      ...(job.workflow ? {
        workflow: {
          runId: boundedId(job.workflow.runId),
          agentIndex: job.workflow.agentIndex,
          ...(job.workflow.phase === undefined ? {} : { phase: boundedName(job.workflow.phase) }),
        },
      } : {}),
      ...(job.independentOf === undefined ? {} : { independentOfJobId: boundedId(job.independentOf) }),
    },
    ...(usage === undefined ? {} : { usage }),
    ...(waiting === undefined ? {} : { waitingSummary: boundedSummary(waiting, context, recordKey, "waitingSummary") }),
    ...(result === undefined ? {} : { resultSummary: boundedSummary(result, context, recordKey, "resultSummary") }),
    ...(error === undefined ? {} : { errorSummary: boundedSummary(error, context, recordKey, "errorSummary") }),
  };
}

function projectPhase(
  phase: WorkflowPhase,
  retainedAgents: Set<number>,
): NativeWorkflowPhaseStateV1 {
  return {
    index: phase.index,
    name: boundedName(phase.name),
    status: phase.status,
    timestamps: projectTimestamps(phase.timestamps),
    agentIndexes: [...new Set(phase.agents)]
      .filter((index) => retainedAgents.has(index))
      .sort((left, right) => left - right)
      .slice(0, MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS),
  };
}

function projectAgent(workflowId: string, agent: WorkflowAgentRecord, context: ProjectionContext): NativeWorkflowAgentStateV1 {
  const recordKey = `workflow:${workflowId}:agent:${agent.index}`;
  const validHarness = agent.harness === "pi" || agent.harness === "claude" || agent.harness === "codex"
    ? agent.harness
    : undefined;
  const waiting = waitingAgentSummary(agent);
  const result = agentResultSummary(agent.state);
  const error = safeErrorSummary("agent", agent.state, agent.continuation?.trigger.kind === "quota");
  const usage = optionalUsage(agent.usage);
  return {
    index: agent.index,
    ...(agent.jobId === undefined ? {} : { jobId: boundedId(agent.jobId) }),
    ...(agent.logicalJobId === undefined ? {} : { logicalJobId: boundedId(agent.logicalJobId) }),
    name: boundedName(agent.name),
    status: agent.state,
    phaseIndex: agent.phase,
    timestamps: projectTimestamps(agent.timestamps),
    route: {
      ...(validHarness === undefined ? {} : { harness: validHarness }),
      ...(agent.model === undefined ? {} : { model: boundedName(agent.model) }),
      access: agent.access,
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      ...(agent.speed === undefined ? {} : { speed: agent.speed }),
    },
    relationships: {
      ...(agent.independentOf === undefined ? {} : { independentOfJobId: boundedId(agent.independentOf) }),
      ...(agent.replayedFrom === undefined ? {} : {
        replayedFrom: { runId: boundedId(agent.replayedFrom.runId), callIndex: agent.replayedFrom.callIndex },
      }),
      ...(agent.replacedBy === undefined ? {} : {
        replacedBy: { runId: boundedId(agent.replacedBy.replacementRunId) },
      }),
      ...(agent.continuation === undefined ? {} : {
        continuation: {
          fromJobId: boundedId(agent.continuation.failedJobId),
          ...(agent.continuation.replacementJobId === undefined
            ? {}
            : { toJobId: boundedId(agent.continuation.replacementJobId) }),
        },
      }),
    },
    ...(usage === undefined ? {} : { usage }),
    ...(waiting === undefined ? {} : { waitingSummary: boundedSummary(waiting, context, recordKey, "waitingSummary") }),
    ...(result === undefined ? {} : { resultSummary: boundedSummary(result, context, recordKey, "resultSummary") }),
    ...(error === undefined ? {} : { errorSummary: boundedSummary(error, context, recordKey, "errorSummary") }),
  };
}

function projectWorkflow(workflow: WorkflowSnapshot, context: ProjectionContext): NativeWorkflowStateV1 {
  const workflowId = boundedId(workflow.runId);
  const recordKey = `workflow:${workflowId}`;
  const sortedAgents = [...workflow.agents].sort(compareAgents);
  const retainedAgents = sortedAgents.slice(0, MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS);
  const retainedAgentIndexes = new Set(retainedAgents.map((agent) => agent.index));
  const sortedPhases = [...workflow.phases].sort((left, right) => left.index - right.index);
  const retainedPhases = sortedPhases.slice(0, MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES);
  const currentPhase = retainedPhases.find((phase) => phase.index === workflow.currentPhase);
  const waiting = workflow.status === "paused" ? "Workflow paused." : undefined;
  const result = workflowResultSummary(workflow.status, workflow.taskOutcome);
  const error = safeErrorSummary("workflow", workflow.status);
  const usage = workflowUsage(workflow);
  const projected: NativeWorkflowStateV1 = {
    id: boundedId(workflow.runId),
    name: boundedName(workflow.name),
    status: workflow.status,
    ...(workflow.taskOutcome === undefined ? {} : { taskOutcome: workflow.taskOutcome }),
    timestamps: projectTimestamps(workflow.timestamps),
    ...(currentPhase === undefined ? {} : {
      currentPhase: { index: currentPhase.index, name: boundedName(currentPhase.name), status: currentPhase.status },
    }),
    phases: retainedPhases.map((phase) => projectPhase(phase, retainedAgentIndexes)),
    agents: retainedAgents.map((agent) => projectAgent(workflowId, agent, context)),
    relationships: {
      ...(workflow.replay === undefined ? {} : {
        replayedFrom: { runId: boundedId(workflow.replay.sourceRunId) },
      }),
      ...(workflow.replacementOf === undefined ? {} : {
        replacementOf: {
          runId: boundedId(workflow.replacementOf.sourceRunId),
          agentIndex: workflow.replacementOf.sourceAgentIndex,
        },
      }),
    },
    ...(usage === undefined ? {} : { usage }),
    ...(waiting === undefined ? {} : { waitingSummary: boundedSummary(waiting, context, recordKey, "waitingSummary") }),
    ...(result === undefined ? {} : { resultSummary: boundedSummary(result, context, recordKey, "resultSummary") }),
    ...(error === undefined ? {} : { errorSummary: boundedSummary(error, context, recordKey, "errorSummary") }),
  };
  context.workflowSources.set(projected, { agents: workflow.agents.length, phases: workflow.phases.length });
  return projected;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

type PriorityRecord = {
  terminal: boolean;
  timestamp: number;
  key: string;
};

type SummaryRecord = PriorityRecord & {
  record: { waitingSummary?: string; resultSummary?: string; errorSummary?: string };
};

function summaryRecords(state: NativeSubagentsStateV1): SummaryRecord[] {
  const records: SummaryRecord[] = [];
  for (const job of state.jobs) {
    records.push({
      terminal: isTerminalJob(job.status),
      timestamp: job.timestamps.endedAt ?? job.timestamps.startedAt ?? job.timestamps.createdAt,
      key: `job:${job.id}`,
      record: job,
    });
  }
  for (const workflow of state.workflows) {
    records.push({ terminal: isTerminalWorkflow(workflow.status), timestamp: workflow.timestamps.updatedAt, key: `workflow:${workflow.id}`, record: workflow });
    for (const agent of workflow.agents) {
      records.push({ terminal: isTerminalAgent(agent.status), timestamp: agent.timestamps.updatedAt, key: `workflow:${workflow.id}:agent:${agent.index}`, record: agent });
    }
  }
  return records;
}

function lowestPriority(left: PriorityRecord, right: PriorityRecord): number {
  return Number(right.terminal) - Number(left.terminal)
    || left.timestamp - right.timestamp
    || compareText(right.key, left.key);
}

function summaryPropertyBytes(key: string, value: string): number {
  return Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)},`, "utf8");
}

function removeTerminalSummaries(
  state: NativeSubagentsStateV1,
  context: ProjectionContext,
  initialBytes: number,
): number {
  let bytes = initialBytes;
  for (const candidate of summaryRecords(state).filter((record) => record.terminal).sort(lowestPriority)) {
    for (const key of ["waitingSummary", "resultSummary", "errorSummary"] as const) {
      const value = candidate.record[key];
      if (value === undefined) continue;
      bytes -= summaryPropertyBytes(key, value);
      delete candidate.record[key];
      if (markSummaryEffect(context, candidate.key, key)) {
        const before = String(state.truncation.summariesTruncated).length;
        state.truncation.summariesTruncated++;
        bytes += String(state.truncation.summariesTruncated).length - before;
      }
    }
    if (bytes <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES) return bytes;
  }
  return bytes;
}

type OmissionCandidate = PriorityRecord & { remove(): boolean };

function omissionCandidates(state: NativeSubagentsStateV1): OmissionCandidate[] {
  const candidates: OmissionCandidate[] = [];
  for (const job of [...state.jobs]) {
    candidates.push({
      terminal: isTerminalJob(job.status),
      timestamp: job.timestamps.endedAt ?? job.timestamps.startedAt ?? job.timestamps.createdAt,
      key: `job:${job.id}`,
      remove: () => {
        const index = state.jobs.indexOf(job);
        if (index < 0) return false;
        state.jobs.splice(index, 1);
        state.truncation.jobsOmitted++;
        return true;
      },
    });
  }
  for (const workflow of [...state.workflows]) {
    for (const agent of [...workflow.agents]) {
      candidates.push({
        terminal: isTerminalAgent(agent.status),
        timestamp: agent.timestamps.updatedAt,
        key: `workflow:${workflow.id}:0-agent:${agent.index}`,
        remove: () => {
          if (!state.workflows.includes(workflow)) return false;
          const index = workflow.agents.indexOf(agent);
          if (index < 0) return false;
          workflow.agents.splice(index, 1);
          for (const phase of workflow.phases) {
            phase.agentIndexes = phase.agentIndexes.filter((agentIndex) => agentIndex !== agent.index);
          }
          state.truncation.workflowAgentsOmitted++;
          return true;
        },
      });
    }
    for (const phase of [...workflow.phases]) {
      candidates.push({
        terminal: isTerminalWorkflow(phase.status),
        timestamp: phase.timestamps.updatedAt,
        key: `workflow:${workflow.id}:1-phase:${phase.index}`,
        remove: () => {
          if (!state.workflows.includes(workflow)) return false;
          const index = workflow.phases.indexOf(phase);
          if (index < 0) return false;
          workflow.phases.splice(index, 1);
          if (workflow.currentPhase?.index === phase.index) delete workflow.currentPhase;
          state.truncation.phasesOmitted++;
          return true;
        },
      });
    }
    candidates.push({
      terminal: isTerminalWorkflow(workflow.status),
      timestamp: workflow.timestamps.updatedAt,
      key: `workflow:${workflow.id}:2-run`,
      remove: () => {
        const index = state.workflows.indexOf(workflow);
        if (index < 0) return false;
        state.workflows.splice(index, 1);
        state.truncation.workflowsOmitted++;
        return true;
      },
    });
  }
  return candidates.sort(lowestPriority);
}

function enforcePayloadLimit(state: NativeSubagentsStateV1, context: ProjectionContext): void {
  let bytes = serializedBytes(state);
  if (bytes <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES) return;
  bytes = removeTerminalSummaries(state, context, bytes);
  if (bytes <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES) return;
  for (const candidate of omissionCandidates(state)) {
    if (!candidate.remove()) continue;
    if (serializedBytes(state) <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES) return;
  }
}

export function projectNativeSubagentsStateV1(
  jobs: readonly JobSnapshot[],
  workflows: readonly WorkflowSnapshot[],
  options: NativeSubagentsProjectionOptionsV1,
): NativeSubagentsStateV1 {
  const context: ProjectionContext = { summaryEffects: new Map(), workflowSources: new WeakMap() };
  const sortedJobs = [...jobs].sort(compareJobs);
  const sortedWorkflows = [...workflows].sort(compareWorkflows);
  const retainedWorkflows = sortedWorkflows.slice(0, MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS);
  const workflowAgentsOmitted = retainedWorkflows.reduce(
    (total, workflow) => total + Math.max(0, workflow.agents.length - MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOW_AGENTS),
    0,
  );
  const phasesOmitted = retainedWorkflows.reduce(
    (total, workflow) => total + Math.max(0, workflow.phases.length - MAX_NATIVE_SUBAGENTS_STATE_V1_PHASES),
    0,
  );
  const state: NativeSubagentsStateV1 = {
    schemaVersion: 1,
    producer: {
      name: NATIVE_SUBAGENTS_PRODUCER_NAME,
      version: boundedName(options.producerVersion),
      instanceId: boundedId(options.instanceId),
    },
    sequence: options.sequence,
    emittedAt: options.emittedAt,
    cause: options.cause,
    session: { id: boundedId(options.sessionId), lifecycle: options.lifecycle },
    truncation: {
      jobsOmitted: Math.max(0, sortedJobs.length - MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS),
      workflowsOmitted: Math.max(0, sortedWorkflows.length - MAX_NATIVE_SUBAGENTS_STATE_V1_WORKFLOWS),
      workflowAgentsOmitted,
      phasesOmitted,
      summariesTruncated: 0,
    },
    jobs: sortedJobs.slice(0, MAX_NATIVE_SUBAGENTS_STATE_V1_JOBS).map((job) => projectJob(job, context)),
    workflows: retainedWorkflows.map((workflow) => projectWorkflow(workflow, context)),
  };
  state.truncation.summariesTruncated = [...context.summaryEffects.values()]
    .reduce((total, fields) => total + fields.size, 0);
  enforcePayloadLimit(state, context);
  const retainedKeys = new Set(summaryRecords(state).map((record) => record.key));
  state.truncation.summariesTruncated = [...context.summaryEffects]
    .filter(([recordKey]) => retainedKeys.has(recordKey))
    .reduce((total, [, fields]) => total + fields.size, 0);
  state.truncation.jobsOmitted = jobs.length - state.jobs.length;
  state.truncation.workflowsOmitted = workflows.length - state.workflows.length;
  state.truncation.workflowAgentsOmitted = state.workflows.reduce((total, workflow) => {
    return total + (context.workflowSources.get(workflow)?.agents ?? workflow.agents.length) - workflow.agents.length;
  }, 0);
  state.truncation.phasesOmitted = state.workflows.reduce((total, workflow) => {
    return total + (context.workflowSources.get(workflow)?.phases ?? workflow.phases.length) - workflow.phases.length;
  }, 0);
  assertNativeSubagentsStateV1(state);
  return state;
}

export function validateNativeSubagentsStateV1(value: unknown): value is NativeSubagentsStateV1 {
  try {
    return serializedBytes(value) <= MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES
      && Check(NativeSubagentsStateV1Schema, value);
  } catch {
    return false;
  }
}

export function assertNativeSubagentsStateV1(value: unknown): asserts value is NativeSubagentsStateV1 {
  let bytes: number;
  try {
    bytes = serializedBytes(value);
  } catch (error) {
    throw new TypeError(`Native subagents state V1 is not serializable: ${error instanceof Error ? error.name : "unknown error"}`);
  }
  if (bytes > MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES) {
    throw new RangeError(`Native subagents state V1 exceeds ${MAX_NATIVE_SUBAGENTS_STATE_V1_BYTES} UTF-8 bytes`);
  }
  if (!Check(NativeSubagentsStateV1Schema, value)) {
    throw new TypeError("Native subagents state does not match V1");
  }
}

/** Equality key for public state. Only event metadata named by the V1 contract is ignored. */
export function fingerprintNativeSubagentsStateV1(state: NativeSubagentsStateV1): string {
  const { sequence: _sequence, emittedAt: _emittedAt, cause: _cause, ...material } = state;
  return JSON.stringify(material);
}
