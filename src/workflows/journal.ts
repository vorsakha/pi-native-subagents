import { createHash } from "node:crypto";
import type {
  WorkflowContinuationHandoff,
  WorkflowContinuationProgress,
  WorkflowJournalRecord,
  WorkflowJournalRoute,
  WorkflowJournalResult,
  WorkflowReplayCall,
  WorkflowReplayHandoff,
  WorkflowReplayInteraction,
} from "./types.ts";

const FINGERPRINT_VERSION = "workflow-v1";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Workflow fingerprint values must be JSON-compatible");
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function fingerprint(kind: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(FINGERPRINT_VERSION)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function workflowCallFingerprint(prompt: string, options: Record<string, unknown>): string {
  return fingerprint("agent-call", { options, prompt });
}

/** Binds prompt, options, and the exact retained target so a follow-up cannot
 * replay against a different job than the one it originally continued. */
export function workflowFollowUpFingerprint(input: { jobId: string; prompt: string; options: Record<string, unknown> }): string {
  return fingerprint("followup-call", { jobId: input.jobId, options: input.options, prompt: input.prompt });
}

/**
 * Binds the exact question text and optional context so a replayed answer can
 * only satisfy the same question. The asking agent's identity and the target's
 * call fingerprint are matched separately, from the record's own detail.
 */
export function workflowInteractionFingerprint(input: { question: string; context?: string }): string {
  return fingerprint("peer-question", { context: input.context ?? null, question: input.question });
}

export function workflowDefinitionFingerprint(input: {
  script: string;
  argsJson: string;
  cwd: string;
  parentProvider?: string;
  defaultHarness?: string;
  approval?: string;
  budget?: unknown;
}): string {
  return fingerprint("workflow-definition", {
    approval: input.approval ?? "auto",
    argsJson: input.argsJson,
    budget: input.budget ?? null,
    cwd: input.cwd,
    defaultHarness: input.defaultHarness ?? null,
    parentProvider: input.parentProvider ?? null,
    script: input.script,
  });
}

function callKind(record: WorkflowJournalRecord): "agent" | "followUp" {
  return record.kind === "followUp" ? "followUp" : "agent";
}

function routeIdentity(route: WorkflowJournalRoute): Omit<WorkflowJournalRoute, "continuation"> {
  const { continuation: _continuation, ...identity } = route;
  return identity;
}

function usageContainsAttempt(progress: WorkflowContinuationProgress): boolean {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const;
  return keys.every((key) => progress.attemptUsage[key] <= progress.usage[key]);
}

/**
 * A handoff authorizes replacement only when it is the second checkpoint for
 * the exact progressed primary recorded earlier for that call. Structural
 * validity alone cannot prove that lineage, route, or accounting identity.
 */
function continuationCheckpointsMatch(
  progressRecord: WorkflowJournalRecord,
  handoffRecord: WorkflowJournalRecord,
): boolean {
  const progress = progressRecord.continuationProgress;
  const handoff = handoffRecord.continuation;
  const progressRoute = progressRecord.route;
  const handoffRoute = handoffRecord.route;
  if (!progress || !handoff || !progressRoute || !handoffRoute
      || progressRecord.replayProof !== handoffRecord.replayProof
      || progressRecord.replayUsageClaim !== handoffRecord.replayUsageClaim) return false;
  if (callKind(progressRecord) !== callKind(handoffRecord)
      || progressRecord.agentIndex !== progress.agentIndex
      || handoffRecord.agentIndex !== handoff.agentIndex
      || progress.agentIndex !== handoff.agentIndex
      || !usageContainsAttempt(progress)) return false;

  const progressProof = {
    agentIndex: progress.agentIndex,
    logicalJobId: progress.logicalJobId ?? progress.failedJobId,
    failedJobId: progress.failedJobId,
    target: progress.target,
    trigger: progress.trigger,
    attemptUsage: progress.attemptUsage,
    usage: progress.usage,
  };
  const handoffProof = {
    agentIndex: handoff.agentIndex,
    logicalJobId: handoff.logicalJobId ?? handoff.failedJobId,
    failedJobId: handoff.failedJobId,
    target: handoff.target,
    trigger: handoff.trigger,
    attemptUsage: handoff.attemptUsage ?? handoff.usage,
    usage: handoff.usage,
  };
  if (canonicalJson(progressProof) !== canonicalJson(handoffProof)
      || canonicalJson(routeIdentity(progressRoute)) !== canonicalJson(routeIdentity(handoffRoute))) return false;

  const continuation = handoffRoute.continuation;
  return progress.trigger.provider !== progress.target.harness
    && progressRoute.continuation === undefined
    && progressRoute.jobId === progress.failedJobId
    && progressRoute.logicalJobId === (progress.logicalJobId ?? progress.failedJobId)
    && progressRoute.harness === progress.trigger.provider
    && canonicalJson(progressRoute.continuationFallback ?? null) === canonicalJson(progress.target)
    && continuation?.state === "handoff"
    && continuation.fromHarness === progress.trigger.provider
    && continuation.toHarness === progress.target.harness
    && continuation.failedJobId === progress.failedJobId
    && continuation.replacementJobId === undefined
    && continuation.checkoutDigest === handoff.checkout.digest
    && canonicalJson(continuation.trigger) === canonicalJson(progress.trigger);
}

/**
 * A successful terminal record may replace a progressed primary only when its
 * route proves that it completed the exact replacement authorized by the
 * accepted handoff. A terminal result on its own cannot establish that link.
 */
function continuationTerminalMatches(
  handoffRecord: WorkflowJournalRecord,
  terminalRecord: WorkflowJournalRecord,
): boolean {
  const handoff = handoffRecord.continuation;
  const handoffRoute = handoffRecord.route;
  const terminalRoute = terminalRecord.route;
  const authorized = handoffRoute?.continuation;
  const completed = terminalRoute?.continuation;
  if (!handoff || !handoffRoute || !terminalRoute || !authorized || !completed
      || terminalRecord.result?.ok !== true
      || callKind(handoffRecord) !== callKind(terminalRecord)
      || terminalRecord.agentIndex !== handoff.agentIndex
      || terminalRecord.agentIndex !== handoffRecord.agentIndex) return false;

  const logicalJobId = handoff.logicalJobId ?? handoff.failedJobId;
  const authorizedProvenance = {
    ...authorized,
    state: "completed",
    replacementJobId: completed.replacementJobId,
  };
  return authorized.state === "handoff"
    && authorized.replacementJobId === undefined
    && completed.state === "completed"
    && typeof completed.replacementJobId === "string"
    && completed.replacementJobId.length > 0
    && canonicalJson(completed) === canonicalJson(authorizedProvenance)
    && terminalRoute.jobId === completed.replacementJobId
    && terminalRoute.logicalJobId === logicalJobId
    && terminalRoute.harness === handoff.target.harness
    && terminalRecord.result.jobId === logicalJobId
    && canonicalJson(terminalRoute.continuationFallback ?? null) === canonicalJson(handoff.target)
    && (handoff.target.model === undefined || terminalRoute.model === handoff.target.model);
}

export function workflowReplayReferenceKey(reference: { runId: string; callIndex: number }): string {
  return `${reference.runId}\0${reference.callIndex}`;
}

function bindContinuationProof(
  proof: NonNullable<WorkflowReplayCall["continuationProof"]>,
  agentIndex: number,
): NonNullable<WorkflowReplayCall["continuationProof"]> {
  return {
    progress: { ...structuredClone(proof.progress), agentIndex },
    progressRoute: structuredClone(proof.progressRoute),
    handoff: { ...structuredClone(proof.handoff), agentIndex },
    handoffRoute: structuredClone(proof.handoffRoute),
  };
}

function localContinuationProof(
  progressRecord: WorkflowJournalRecord,
  handoffRecord: WorkflowJournalRecord,
): NonNullable<WorkflowReplayCall["continuationProof"]> | undefined {
  if (!progressRecord.continuationProgress || !progressRecord.route
      || !handoffRecord.continuation || !handoffRecord.route) return undefined;
  return {
    progress: structuredClone(progressRecord.continuationProgress),
    progressRoute: structuredClone(progressRecord.route),
    handoff: structuredClone(handoffRecord.continuation),
    handoffRoute: structuredClone(handoffRecord.route),
  };
}

function validatedReplayContinuationProof(
  record: WorkflowJournalRecord,
  replaySources: ReadonlyMap<string, WorkflowReplayCall>,
): NonNullable<WorkflowReplayCall["continuationProof"]> | undefined {
  const reference = record.replayedFrom;
  if (!reference || record.agentIndex === undefined) return undefined;
  const source = replaySources.get(workflowReplayReferenceKey(reference));
  if (!source?.continuationProof
      || source.callIndex !== reference.callIndex
      || source.fingerprint !== record.fingerprint
      || source.kind !== callKind(record)
      || canonicalJson(source.result) !== canonicalJson(record.result)
      || canonicalJson(source.route ?? null) !== canonicalJson(record.route ?? null)) return undefined;

  const proof = bindContinuationProof(source.continuationProof, record.agentIndex);
  return continuationProofMatchesTerminal(proof, record) ? proof : undefined;
}

function continuationProofMatchesTerminal(
  proof: NonNullable<WorkflowReplayCall["continuationProof"]>,
  record: WorkflowJournalRecord,
): boolean {
  if (record.agentIndex === undefined) return false;
  const handoffRecord: WorkflowJournalRecord = {
    version: 1,
    sequence: record.sequence,
    callIndex: record.callIndex,
    fingerprint: record.fingerprint,
    kind: record.kind,
    state: "handoff",
    at: record.at,
    agentIndex: record.agentIndex,
    route: proof.handoffRoute,
    continuation: proof.handoff,
  };
  return continuationTerminalMatches(handoffRecord, record);
}

/** Return every independently replayable completed call. Failed, incomplete,
 * duplicated, or fingerprint-inconsistent ordinals are excluded without
 * discarding later parallel calls whose own journal pairs remain valid. */
export function replayableJournalCalls(
  records: WorkflowJournalRecord[],
  replaySources: ReadonlyMap<string, WorkflowReplayCall> = new Map(),
): WorkflowReplayCall[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const progressed = new Map<number, WorkflowJournalRecord>();
  const handoffs = new Map<number, WorkflowJournalRecord>();
  const rejectedHandoffs = new Map<number, WorkflowJournalRecord>();
  const rejectedTerminals = new Set<number>();
  const rejectedContinuationTerminals = new Map<number, WorkflowJournalRecord>();
  const completed = new Map<number, WorkflowJournalRecord>();
  const continuationProofs = new Map<number, NonNullable<WorkflowReplayCall["continuationProof"]>>();
  const acceptedLineageProofs: Array<NonNullable<WorkflowReplayCall["continuationProof"]>> = [];
  const durableProgressEvidence = new Map<number, WorkflowJournalRecord>();
  const invalid = new Set<number>();
  const failClosedProgress = new Set<number>();

  for (const record of records) {
    // Peer questions carry their own ordinal namespace in `callIndex`; they are
    // replayed by `replayableJournalInteractions` and must never be confused
    // with the sandbox's contiguous agent()/followUp() ordinals.
    if (record.kind === "peerQuestion") continue;
    const priorStart = started.get(record.callIndex);
    if (record.state === "started") {
      if (priorStart || completed.has(record.callIndex)) invalid.add(record.callIndex);
      else started.set(record.callIndex, record);
      continue;
    }
    if (record.state === "progressed") {
      if (!priorStart || priorStart.fingerprint !== record.fingerprint || progressed.has(record.callIndex)
          || callKind(priorStart) !== callKind(record) || handoffs.has(record.callIndex)
          || completed.has(record.callIndex) || !record.continuationProgress) {
        invalid.add(record.callIndex);
      } else {
        progressed.set(record.callIndex, record);
        durableProgressEvidence.set(record.callIndex, record);
      }
      continue;
    }
    if (record.state === "handoff") {
      const progress = progressed.get(record.callIndex);
      if (!priorStart || priorStart.fingerprint !== record.fingerprint || !record.continuation) {
        invalid.add(record.callIndex);
      } else if (!progress || handoffs.has(record.callIndex) || completed.has(record.callIndex)
          || rejectedTerminals.has(record.callIndex)
          || !continuationCheckpointsMatch(progress, record)) {
        rejectedHandoffs.set(record.callIndex, record);
        handoffs.delete(record.callIndex);
        completed.delete(record.callIndex);
      } else handoffs.set(record.callIndex, record);
      continue;
    }
    if (rejectedHandoffs.has(record.callIndex)) continue;
    if (!priorStart || priorStart.fingerprint !== record.fingerprint || completed.has(record.callIndex)) {
      invalid.add(record.callIndex);
      continue;
    }
    if (record.state === "completed" && record.result?.ok === true) {
      const progress = progressed.get(record.callIndex);
      const handoff = handoffs.get(record.callIndex);
      const carriesContinuation = record.route?.continuation !== undefined;
      const localProof = progress && handoff && continuationTerminalMatches(handoff, record)
        ? localContinuationProof(progress, handoff)
        : undefined;
      const replayProof = !progress && carriesContinuation
        ? validatedReplayContinuationProof(record, replaySources)
        : undefined;
      const lineageProof = !progress && carriesContinuation && record.agentIndex !== undefined
        ? acceptedLineageProofs
          .map((proof) => bindContinuationProof(proof, record.agentIndex!))
          .find((proof) => continuationProofMatchesTerminal(proof, record))
        : undefined;
      if ((carriesContinuation && !localProof && !replayProof && !lineageProof) || (progress && !localProof)) {
        rejectedTerminals.add(record.callIndex);
        rejectedContinuationTerminals.set(record.callIndex, record);
        durableProgressEvidence.set(record.callIndex, record);
        handoffs.delete(record.callIndex);
      } else {
        completed.set(record.callIndex, record);
        const proof = localProof ?? replayProof ?? lineageProof;
        if (record.result.progressed === true) durableProgressEvidence.set(record.callIndex, record);
        if (proof) {
          continuationProofs.set(record.callIndex, proof);
          acceptedLineageProofs.push(proof);
          durableProgressEvidence.set(record.callIndex, record);
        }
      }
    }
    else if (record.state === "failed" && record.result?.ok === false
        && (progressed.has(record.callIndex) || handoffs.has(record.callIndex) || record.result.progressed === true)) {
      completed.set(record.callIndex, record);
      if (record.result.progressed === true || progressed.has(record.callIndex) || handoffs.has(record.callIndex)) {
        durableProgressEvidence.set(record.callIndex, record);
      }
    }
    else invalid.add(record.callIndex);
  }

  const replayable = new Map(completed);
  for (const [callIndex, record] of progressed) {
    const handoff = handoffs.get(callIndex);
    if (!invalid.has(callIndex) && completed.has(callIndex)) continue;
    if (!invalid.has(callIndex) && handoff && handoff.replayProof !== true) continue;
    const progress = record.continuationProgress!;
    const route = record.route ? structuredClone(record.route) : undefined;
    if (route && !route.attempts?.length) {
      route.attempts = [{
        index: 0,
        jobId: progress.failedJobId,
        harness: progress.trigger.provider,
        requestedHarness: progress.trigger.provider,
        model: route.model,
        error: route.error,
        usage: { ...progress.attemptUsage },
        disposition: "continuation",
        trigger: { ...progress.trigger },
      }];
    }
    const error = handoff?.replayProof === true
      ? "Replayed continuation proof stopped before its terminal record; copied proof cannot authorize another replacement"
      : "Progressed primary stopped before a safe continuation handoff; the original prompt was not replayed";
    replayable.set(callIndex, {
      ...record,
      state: "failed",
      route,
      result: {
        ok: false,
        output: "",
        error,
        progressed: true,
        usage: { ...progress.usage },
      },
    });
    failClosedProgress.add(callIndex);
  }
  for (const [callIndex, record] of durableProgressEvidence) {
    if (!invalid.has(callIndex) || failClosedProgress.has(callIndex)) continue;
    const usage = progressed.get(callIndex)?.continuationProgress?.usage ?? record.result?.usage;
    replayable.set(callIndex, {
      ...record,
      state: "failed",
      route: undefined,
      result: {
        ok: false,
        output: "",
        error: "Workflow journal became inconsistent after durable progress; the original prompt was not replayed",
        progressed: true,
        ...(usage ? { usage: { ...usage } } : {}),
      },
    });
    failClosedProgress.add(callIndex);
  }
  for (const [callIndex, record] of rejectedHandoffs) {
    if (invalid.has(callIndex) || progressed.has(callIndex)) continue;
    replayable.set(callIndex, {
      ...record,
      state: "failed",
      route: undefined,
      result: {
        ok: false,
        output: "",
        error: "Continuation handoff lacks a matching progressed-primary checkpoint; neither provider was dispatched",
        progressed: true,
      },
    });
  }
  for (const [callIndex, record] of rejectedContinuationTerminals) {
    if (invalid.has(callIndex) || progressed.has(callIndex)) continue;
    replayable.set(callIndex, {
      ...record,
      state: "failed",
      route: undefined,
      result: {
        ok: false,
        output: "",
        error: "Continuation completion lacks durable checkpoint or validated replay provenance; neither provider was dispatched",
        progressed: true,
      },
    });
  }

  return [...replayable.entries()]
    .filter(([callIndex, record]) => (!invalid.has(callIndex) || failClosedProgress.has(callIndex)) && !!record.result)
    .sort(([left], [right]) => left - right)
    .map(([callIndex, record]) => ({
      callIndex,
      fingerprint: record.fingerprint,
      kind: record.kind === "followUp" ? "followUp" : "agent",
      agentIndex: record.agentIndex,
      result: structuredClone(record.result) as WorkflowJournalResult,
      route: record.route ? { ...record.route } : undefined,
      ...(!failClosedProgress.has(callIndex) && continuationProofs.get(callIndex)
        ? { continuationProof: structuredClone(continuationProofs.get(callIndex)!) }
        : {}),
    }));
}

/**
 * Returns durable progressed-work checkpoints whose logical call never reached
 * a terminal continuation result. Replay may start only from these checkpoints,
 * never from the original prompt.
 */
export function replayableJournalHandoffs(records: WorkflowJournalRecord[]): WorkflowReplayHandoff[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const progressed = new Map<number, WorkflowJournalRecord>();
  const handoffs = new Map<number, WorkflowJournalRecord>();
  const terminal = new Set<number>();
  const invalid = new Set<number>();

  for (const record of records) {
    if (record.kind === "peerQuestion") continue;
    if (record.state === "started") {
      if (started.has(record.callIndex)) invalid.add(record.callIndex);
      else started.set(record.callIndex, record);
      continue;
    }
    const start = started.get(record.callIndex);
    if (!start || start.fingerprint !== record.fingerprint) {
      invalid.add(record.callIndex);
      continue;
    }
    if (record.state === "progressed") {
      if (callKind(start) !== callKind(record) || progressed.has(record.callIndex)
          || handoffs.has(record.callIndex) || !record.continuationProgress) invalid.add(record.callIndex);
      else progressed.set(record.callIndex, record);
      continue;
    }
    if (record.state === "handoff") {
      const progress = progressed.get(record.callIndex);
      if (!progress || handoffs.has(record.callIndex) || !record.continuation
          || !continuationCheckpointsMatch(progress, record)) invalid.add(record.callIndex);
      else handoffs.set(record.callIndex, record);
      continue;
    }
    terminal.add(record.callIndex);
  }

  return [...handoffs.entries()]
    .filter(([callIndex, record]) => record.replayProof !== true && !invalid.has(callIndex) && !terminal.has(callIndex))
    .sort(([left], [right]) => left - right)
    .map(([callIndex, record]) => ({
      callIndex,
      fingerprint: record.fingerprint,
      kind: record.kind === "followUp" ? "followUp" : "agent",
      checkpoint: structuredClone(record.continuation!),
      route: record.route ? structuredClone(record.route) : undefined,
    }));
}

/**
 * Return every accepted peer answer that may be replayed. New journals require
 * a provisional completion followed by matching acceptance; legacy completed
 * records remain readable. A peer answer is reusable only for the same ordinal,
 * asking lineage, question, and target call fingerprint. Anything incomplete,
 * duplicated, or failed is dropped so the question reruns or fails safely.
 */
export function replayableJournalInteractions(records: WorkflowJournalRecord[]): WorkflowReplayInteraction[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const provisional = new Map<number, WorkflowJournalRecord>();
  const completed = new Map<number, WorkflowJournalRecord>();
  const invalid = new Set<number>();

  for (const record of records) {
    if (record.kind !== "peerQuestion") continue;
    const ordinal = record.callIndex;
    const priorStart = started.get(ordinal);
    if (record.state === "started") {
      if (priorStart || provisional.has(ordinal) || completed.has(ordinal)) invalid.add(ordinal);
      else started.set(ordinal, record);
      continue;
    }
    if (!priorStart || priorStart.fingerprint !== record.fingerprint || completed.has(ordinal)) {
      invalid.add(ordinal);
      continue;
    }
    if (record.state === "completed" && record.result?.ok === true && record.interaction) {
      if (provisional.has(ordinal)) invalid.add(ordinal);
      else if (record.interactionPending === true) provisional.set(ordinal, record);
      else completed.set(ordinal, record); // Backward-compatible journals predate two-phase acceptance.
      continue;
    }
    const answer = provisional.get(ordinal);
    if (record.state === "accepted" && answer?.interaction && record.interaction
        && answer.agentIndex === record.agentIndex
        && canonicalJson(answer.interaction) === canonicalJson(record.interaction)) {
      completed.set(ordinal, answer);
    } else invalid.add(ordinal);
  }

  return [...completed.entries()]
    .filter(([ordinal]) => !invalid.has(ordinal))
    .sort(([left], [right]) => left - right)
    .map(([ordinal, record]) => ({
      ordinal,
      questionFingerprint: record.fingerprint,
      detail: { ...record.interaction! },
      answer: record.result!.output,
      usage: record.result!.usage ? { ...record.result!.usage } : undefined,
    } satisfies WorkflowReplayInteraction));
}
