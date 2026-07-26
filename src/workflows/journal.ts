import { createHash } from "node:crypto";
import type {
  WorkflowJournalRecord,
  WorkflowJournalResult,
  WorkflowReplayCall,
} from "./types.ts";

const FINGERPRINT_VERSION = "workflow-v1";

function canonicalJson(value: unknown): string {
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

/** Return only the contiguous prefix of successfully completed calls. A
 * started, failed, missing, duplicated, or fingerprint-inconsistent call ends
 * replay so the runtime reruns that call and every suffix call. */
export function replayableJournalPrefix(records: WorkflowJournalRecord[]): WorkflowReplayCall[] {
  const started = new Map<number, WorkflowJournalRecord>();
  const completed = new Map<number, WorkflowJournalRecord>();
  const invalid = new Set<number>();

  for (const record of records) {
    const priorStart = started.get(record.callIndex);
    if (record.state === "started") {
      if (priorStart || completed.has(record.callIndex)) invalid.add(record.callIndex);
      else started.set(record.callIndex, record);
      continue;
    }
    if (!priorStart || priorStart.fingerprint !== record.fingerprint || completed.has(record.callIndex)) {
      invalid.add(record.callIndex);
      continue;
    }
    if (record.state === "completed" && record.result?.ok === true) completed.set(record.callIndex, record);
    else invalid.add(record.callIndex);
  }

  const prefix: WorkflowReplayCall[] = [];
  for (let callIndex = 0; ; callIndex++) {
    if (invalid.has(callIndex)) break;
    const record = completed.get(callIndex);
    if (!record?.result) break;
    prefix.push({
      callIndex,
      fingerprint: record.fingerprint,
      result: structuredClone(record.result) as WorkflowJournalResult,
      route: record.route ? { ...record.route } : undefined,
    });
  }
  return prefix;
}
