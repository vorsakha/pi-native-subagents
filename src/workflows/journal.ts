import { createHash } from "node:crypto";
import type {
  WorkflowJournalRecord,
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

/** Return every independently replayable completed call. Failed, incomplete,
 * duplicated, or fingerprint-inconsistent ordinals are excluded without
 * discarding later parallel calls whose own journal pairs remain valid. */
export function replayableJournalCalls(records: WorkflowJournalRecord[]): WorkflowReplayCall[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const progressed = new Map<number, WorkflowJournalRecord>();
  const handoffs = new Map<number, WorkflowJournalRecord>();
  const completed = new Map<number, WorkflowJournalRecord>();
  const invalid = new Set<number>();

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
          || handoffs.has(record.callIndex) || completed.has(record.callIndex) || !record.continuationProgress) {
        invalid.add(record.callIndex);
      } else progressed.set(record.callIndex, record);
      continue;
    }
    if (record.state === "handoff") {
      if (!priorStart || priorStart.fingerprint !== record.fingerprint || handoffs.has(record.callIndex)
          || completed.has(record.callIndex) || !record.continuation) invalid.add(record.callIndex);
      else handoffs.set(record.callIndex, record);
      continue;
    }
    if (!priorStart || priorStart.fingerprint !== record.fingerprint || completed.has(record.callIndex)) {
      invalid.add(record.callIndex);
      continue;
    }
    if (record.state === "completed" && record.result?.ok === true) completed.set(record.callIndex, record);
    else if (record.state === "failed" && record.result?.ok === false
        && (progressed.has(record.callIndex) || handoffs.has(record.callIndex) || record.result.progressed === true)) completed.set(record.callIndex, record);
    else invalid.add(record.callIndex);
  }

  const replayable = new Map(completed);
  for (const [callIndex, record] of progressed) {
    if (invalid.has(callIndex) || handoffs.has(callIndex) || completed.has(callIndex)) continue;
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
    replayable.set(callIndex, {
      ...record,
      state: "failed",
      route,
      result: {
        ok: false,
        output: "",
        error: "Progressed primary stopped before a safe continuation handoff; the original prompt was not replayed",
        progressed: true,
        usage: { ...progress.usage },
      },
    });
  }

  return [...replayable.entries()]
    .filter(([callIndex, record]) => !invalid.has(callIndex) && !!record.result)
    .sort(([left], [right]) => left - right)
    .map(([callIndex, record]) => ({
      callIndex,
      fingerprint: record.fingerprint,
      kind: record.kind === "followUp" ? "followUp" : "agent",
      agentIndex: record.agentIndex,
      result: structuredClone(record.result) as WorkflowJournalResult,
      route: record.route ? { ...record.route } : undefined,
    }));
}

/**
 * Returns durable progressed-work checkpoints whose logical call never reached
 * a terminal continuation result. Replay may start only from these checkpoints,
 * never from the original prompt.
 */
export function replayableJournalHandoffs(records: WorkflowJournalRecord[]): WorkflowReplayHandoff[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const progressed = new Set<number>();
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
      if (progressed.has(record.callIndex) || handoffs.has(record.callIndex) || !record.continuationProgress) invalid.add(record.callIndex);
      else progressed.add(record.callIndex);
      continue;
    }
    if (record.state === "handoff") {
      if (handoffs.has(record.callIndex) || !record.continuation) invalid.add(record.callIndex);
      else handoffs.set(record.callIndex, record);
      continue;
    }
    terminal.add(record.callIndex);
  }

  return [...handoffs.entries()]
    .filter(([callIndex]) => !invalid.has(callIndex) && !terminal.has(callIndex))
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
 * Return every completed peer answer that may be replayed. A peer answer is
 * only reusable as an exact triple: the same interaction ordinal, the same
 * asking lineage identity, and the same question against the same target call
 * fingerprint. Anything incomplete, duplicated, or failed is dropped so the
 * question reruns live (or fails with an actionable error) instead.
 */
export function replayableJournalInteractions(records: WorkflowJournalRecord[]): WorkflowReplayInteraction[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const completed = new Map<number, WorkflowJournalRecord>();
  const invalid = new Set<number>();

  for (const record of records) {
    if (record.kind !== "peerQuestion") continue;
    const ordinal = record.callIndex;
    const priorStart = started.get(ordinal);
    if (record.state === "started") {
      if (priorStart || completed.has(ordinal)) invalid.add(ordinal);
      else started.set(ordinal, record);
      continue;
    }
    if (!priorStart || priorStart.fingerprint !== record.fingerprint || completed.has(ordinal)) {
      invalid.add(ordinal);
      continue;
    }
    if (record.state === "completed" && record.result?.ok === true && record.interaction) completed.set(ordinal, record);
    else invalid.add(ordinal);
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
