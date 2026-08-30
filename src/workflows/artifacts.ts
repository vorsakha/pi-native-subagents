import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolResultSnapshot, TranscriptEntry } from "../types.ts";
import { formatWorkflowBudget } from "./budget.ts";
import { isWorkflowConvergence, MAX_CONVERGENCE_ROUNDS } from "./convergence.ts";
import { workflowTaskOutcome } from "./outcome.ts";
import type { WorkflowJournalRecord, WorkflowSnapshot } from "./types.ts";
import type { WorkflowWorktreeResult } from "./worktree.ts";

const RUN_ID_PATTERN = /^wf_[a-f0-9]+$/;
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const TRANSCRIPT_ENTRY_BYTES = 4 * 1_024;
const TRANSCRIPT_AGENT_BYTES = 32 * 1_024;
const TRANSCRIPT_TRUNCATION_TOOL_ID = "transcript";
const TRANSCRIPT_TRUNCATION_TEXT = "[older transcript entries omitted]";

/** Phase-less sentinel `boundedTranscript` splices in for omitted entries; carries no
 * result of its own, so dashboard presentation must not mistake it for a running tool call. */
function transcriptTruncationEntry(): TranscriptEntry {
  return { kind: "tool", toolId: TRANSCRIPT_TRUNCATION_TOOL_ID, name: "transcript", text: TRANSCRIPT_TRUNCATION_TEXT };
}

export function isTranscriptTruncationEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "tool" && entry.toolId === TRANSCRIPT_TRUNCATION_TOOL_ID && entry.text === TRANSCRIPT_TRUNCATION_TEXT;
}
const JOURNAL_RECORD_BYTES = 1 * 1_024 * 1_024;
const JOURNAL_FILE_BYTES = 72 * 1_024 * 1_024;
const MAX_JOURNAL_RECORDS = 256;
const journalWrites = new Map<string, Promise<void>>();

export interface WorkflowSerializationLimits {
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_WORKFLOW_SERIALIZATION_LIMITS: Readonly<WorkflowSerializationLimits> = {
  maxDepth: 12,
  maxNodes: 10_000,
  maxStringBytes: 64 * 1_024,
  maxTotalBytes: 512 * 1_024,
};

export interface CreateWorkflowArtifactsInput {
  script: string;
  args: unknown;
  snapshot: Omit<WorkflowSnapshot, "runId" | "artifactDir">;
  limits?: Partial<WorkflowSerializationLimits>;
}

export interface LoadWorkflowSummariesOptions {
  sessionId?: string;
  staleAfterMs?: number;
  now?: number;
  limits?: Partial<WorkflowSerializationLimits>;
}

function normalizedLimits(overrides: Partial<WorkflowSerializationLimits> = {}): WorkflowSerializationLimits {
  const number = (value: number | undefined, fallback: number, minimum: number) =>
    Number.isFinite(value) ? Math.max(minimum, Math.floor(value!)) : fallback;
  return {
    maxDepth: number(overrides.maxDepth, DEFAULT_WORKFLOW_SERIALIZATION_LIMITS.maxDepth, 0),
    maxNodes: number(overrides.maxNodes, DEFAULT_WORKFLOW_SERIALIZATION_LIMITS.maxNodes, 1),
    maxStringBytes: number(overrides.maxStringBytes, DEFAULT_WORKFLOW_SERIALIZATION_LIMITS.maxStringBytes, 0),
    maxTotalBytes: number(overrides.maxTotalBytes, DEFAULT_WORKFLOW_SERIALIZATION_LIMITS.maxTotalBytes, 1),
  };
}

function truncateUtf8(value: string, maxBytes: number, suffix = "…[truncated]"): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const suffixBytes = Buffer.byteLength(suffix);
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > contentBudget) break;
    result += character;
    bytes += size;
  }
  if (suffixBytes <= maxBytes) return result + suffix;
  result = "";
  bytes = 0;
  for (const character of suffix) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "env"
    || normalized === "environment"
    || normalized === "auth"
    || normalized === "authentication"
    || normalized === "authorization"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized === "password"
    || normalized === "passwd"
    || normalized === "secret"
    || normalized === "secrets"
    || normalized === "token"
    || normalized === "tokens"
    || normalized === "apikey"
    || normalized === "privatekey"
    || normalized === "accesskey"
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password");
}

/**
 * Convert an arbitrary value to a JSON-safe, size-bounded value. Sensitive
 * environment and authentication fields are omitted at every nesting level.
 */
export function serializeWorkflowValue(
  value: unknown,
  overrides: Partial<WorkflowSerializationLimits> = {},
): unknown {
  const limits = normalizedLimits(overrides);
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > limits.maxNodes) return "[MaxNodes]";
    if (depth > limits.maxDepth) return "[MaxDepth]";
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") return truncateUtf8(current, limits.maxStringBytes);
    if (typeof current === "number") return Number.isFinite(current) ? current : `[${String(current)}]`;
    if (typeof current === "bigint") return truncateUtf8(`${current}n`, limits.maxStringBytes);
    if (typeof current === "undefined") return "[Undefined]";
    if (typeof current === "function") return "[Function]";
    if (typeof current === "symbol") return truncateUtf8(String(current), limits.maxStringBytes);
    if (ancestors.has(current)) return "[Circular]";

    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? "[Invalid Date]" : current.toISOString();
    }
    if (current instanceof Error) {
      return {
        name: truncateUtf8(current.name, limits.maxStringBytes),
        message: truncateUtf8(current.message, limits.maxStringBytes),
        ...(current.stack ? { stack: truncateUtf8(current.stack, limits.maxStringBytes) } : {}),
      };
    }
    if (ArrayBuffer.isView(current)) return `[Binary ${current.byteLength} bytes]`;
    if (current instanceof ArrayBuffer) return `[Binary ${current.byteLength} bytes]`;

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const result: unknown[] = [];
        for (const item of current) {
          if (nodes >= limits.maxNodes) {
            result.push("[MaxNodes]");
            break;
          }
          result.push(visit(item, depth + 1));
        }
        return result;
      }

      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const [rawKey, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || isSensitiveKey(rawKey)) continue;
        if (nodes >= limits.maxNodes) {
          result.$truncated = "[MaxNodes]";
          break;
        }
        const key = truncateUtf8(rawKey, limits.maxStringBytes);
        if ("value" in descriptor && descriptor.value === undefined) continue;
        result[key] = "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Accessor]";
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  };

  const serialized = visit(value, 0);
  const json = JSON.stringify(serialized);
  if (Buffer.byteLength(json) <= limits.maxTotalBytes) return serialized;

  const marker = { $truncated: "total bytes" };
  if (Buffer.byteLength(JSON.stringify(marker)) <= limits.maxTotalBytes) return marker;
  if (limits.maxTotalBytes >= 4) return null;
  if (limits.maxTotalBytes >= 2) return {};
  return 0;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Workflow artifact path is not a directory: ${path}`);
  await chmod(path, 0o700);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(dirname(path), "r").catch(() => undefined);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteJson(
  path: string,
  value: unknown,
  limits: Partial<WorkflowSerializationLimits> = {},
): Promise<void> {
  const serialized = serializeWorkflowValue(value, limits);
  await atomicWrite(path, JSON.stringify(serialized));
}

function boundedTranscript(entries: TranscriptEntry[] = []): TranscriptEntry[] {
  const bounded = entries.map((entry) => ({
    ...entry,
    text: entry.text === undefined ? undefined : truncateUtf8(entry.text, TRANSCRIPT_ENTRY_BYTES),
    name: entry.kind === "tool" ? truncateUtf8(entry.name, 512) : undefined,
    args: entry.kind === "tool" && entry.args
      ? serializeWorkflowValue(entry.args, { maxTotalBytes: TRANSCRIPT_ENTRY_BYTES })
      : undefined,
    result: entry.kind === "tool" && entry.result
      ? serializeWorkflowValue(entry.result, { maxTotalBytes: TRANSCRIPT_ENTRY_BYTES })
      : undefined,
  })) as TranscriptEntry[];
  const size = (items: TranscriptEntry[]) => Buffer.byteLength(JSON.stringify(items));
  if (size(bounded) <= TRANSCRIPT_AGENT_BYTES) return bounded;
  const first = bounded[0];
  const tail: TranscriptEntry[] = [];
  for (let index = bounded.length - 1; index > 0; index--) {
    const candidate = [
      ...(first ? [first] : []),
      transcriptTruncationEntry(),
      ...[...tail].reverse(),
      bounded[index]!,
    ];
    if (size(candidate) > TRANSCRIPT_AGENT_BYTES) break;
    tail.push(bounded[index]!);
  }
  return [
    ...(first ? [first] : []),
    transcriptTruncationEntry(),
    ...tail.reverse(),
  ];
}

function transcriptArtifact(snapshot: WorkflowSnapshot): Record<string, TranscriptEntry[]> {
  return Object.fromEntries(snapshot.agents.slice(0, 32).map((agent) => [String(agent.index), boundedTranscript(agent.transcript)]));
}

/** Keep the workflow summary structurally valid even when 32 agents each
 * produce their maximum retained output. Full native transcripts remain in
 * harness session files; workflow.json is an inspectable bounded summary. */
export function durableWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const compact = serializeWorkflowValue({
    ...snapshot,
    name: truncateUtf8(snapshot.name, 1_000),
    description: truncateUtf8(snapshot.description, 4_000),
    error: snapshot.error ? truncateUtf8(snapshot.error, 4_000) : undefined,
    transcriptArtifact: "transcripts.json",
    reportArtifact: snapshot.reportArtifact,
    result: serializeWorkflowValue(snapshot.result, { maxNodes: 4_000, maxStringBytes: 16 * 1024, maxTotalBytes: 64 * 1024 }),
    convergence: snapshot.convergence ? {
      ...snapshot.convergence,
      name: snapshot.convergence.name ? truncateUtf8(snapshot.convergence.name, 200) : undefined,
      stoppingReason: snapshot.convergence.stoppingReason ? truncateUtf8(snapshot.convergence.stoppingReason, 2_000) : undefined,
      pendingFindings: snapshot.convergence.pendingFindings ? truncateUtf8(snapshot.convergence.pendingFindings, 8_192) : undefined,
      rounds: snapshot.convergence.rounds.slice(-MAX_CONVERGENCE_ROUNDS),
    } : undefined,
    logs: snapshot.logs?.slice(-128).map((entry) => ({
      index: entry.index,
      message: truncateUtf8(entry.message, 4 * 1024),
      at: entry.at,
    })),
    phases: snapshot.phases.slice(0, 64).map((phase) => ({
      ...phase,
      name: truncateUtf8(phase.name, 1_000),
      description: phase.description ? truncateUtf8(phase.description, 2_000) : undefined,
      error: phase.error ? truncateUtf8(phase.error, 2_000) : undefined,
      agents: phase.agents.slice(0, 32),
      advisorConsultations: phase.advisorConsultations?.slice(0, 32),
      result: serializeWorkflowValue(phase.result, { maxNodes: 256, maxStringBytes: 4 * 1024, maxTotalBytes: 8 * 1024 }),
    })),
    interactions: snapshot.interactions?.slice(-16).map((interaction) => ({
      ...interaction,
      question: truncateUtf8(interaction.question, 1_000),
      context: interaction.context ? truncateUtf8(interaction.context, 1_000) : undefined,
      answer: interaction.answer ? truncateUtf8(interaction.answer, 2_000) : undefined,
      error: interaction.error ? truncateUtf8(interaction.error, 500) : undefined,
    })),
    agents: snapshot.agents.slice(0, 32).map((agent) => ({
      ...agent,
      name: truncateUtf8(agent.name, 1_000),
      objective: agent.objective ? truncateUtf8(agent.objective, 2 * 1024) : undefined,
      prompt: agent.prompt ? truncateUtf8(agent.prompt, 2 * 1024) : undefined,
      tools: agent.tools?.slice(-8).map((tool) => ({
        ...tool,
        name: truncateUtf8(tool.name, 512),
        summary: tool.summary ? truncateUtf8(tool.summary, 1_000) : undefined,
      })),
      liveThinking: undefined,
      activity: undefined,
      preview: agent.preview ? truncateUtf8(agent.preview, 1_000) : undefined,
      output: serializeWorkflowValue(agent.output, { maxNodes: 256, maxStringBytes: 4 * 1024, maxTotalBytes: 6 * 1024 }),
      structured: serializeWorkflowValue(agent.structured, { maxNodes: 512, maxStringBytes: 8 * 1024, maxTotalBytes: 16 * 1024 }),
      // In-memory only: a purely replayed lineage cannot be targeted by followUp() either way, so the schema needed to validate a live native follow-up never survives a process restart.
      nativeStructuredSchema: undefined,
      transcript: undefined,
      error: agent.error ? truncateUtf8(agent.error, 2_000) : undefined,
      providerWait: agent.providerWait ? { ...agent.providerWait, detail: truncateUtf8(agent.providerWait.detail, 500) } : undefined,
      providerFallback: agent.providerFallback ? {
        harness: agent.providerFallback.harness,
        model: agent.providerFallback.model ? truncateUtf8(agent.providerFallback.model, 256) : undefined,
      } : undefined,
      continuationFallback: agent.continuationFallback ? {
        harness: agent.continuationFallback.harness,
        model: agent.continuationFallback.model ? truncateUtf8(agent.continuationFallback.model, 256) : undefined,
      } : undefined,
      continuation: agent.continuation ? {
        ...agent.continuation,
        failedJobId: truncateUtf8(agent.continuation.failedJobId, 200),
        replacementJobId: agent.continuation.replacementJobId ? truncateUtf8(agent.continuation.replacementJobId, 200) : undefined,
        trigger: {
          ...agent.continuation.trigger,
          scope: agent.continuation.trigger.scope ? truncateUtf8(agent.continuation.trigger.scope, 300) : undefined,
          detail: truncateUtf8(agent.continuation.trigger.detail, 500),
        },
        warning: truncateUtf8(agent.continuation.warning, 500),
      } : undefined,
      attempts: agent.attempts?.slice(-4).map((attempt) => ({
        ...attempt,
        model: attempt.model ? truncateUtf8(attempt.model, 256) : undefined,
        error: attempt.error ? truncateUtf8(attempt.error, 2_000) : undefined,
        trigger: attempt.trigger ? {
          ...attempt.trigger,
          scope: attempt.trigger.scope ? truncateUtf8(attempt.trigger.scope, 300) : undefined,
          detail: truncateUtf8(attempt.trigger.detail, 500),
        } : undefined,
      })),
      generations: agent.generations?.slice(-8).map((generation) => ({
        ...generation,
        prompt: generation.prompt ? truncateUtf8(generation.prompt, 2 * 1024) : undefined,
        output: serializeWorkflowValue(generation.output, { maxNodes: 256, maxStringBytes: 4 * 1024, maxTotalBytes: 6 * 1024 }),
        structured: serializeWorkflowValue(generation.structured, { maxNodes: 512, maxStringBytes: 8 * 1024, maxTotalBytes: 16 * 1024 }),
        error: generation.error ? truncateUtf8(generation.error, 2_000) : undefined,
      })),
    })),
    advisors: snapshot.advisors?.slice(0, 16),
    advisorConsultations: snapshot.advisorConsultations?.slice(0, 32).map((advisor) => ({
      ...advisor,
      advisorName: truncateUtf8(advisor.advisorName, 1_000),
      prompt: truncateUtf8(advisor.prompt, 2 * 1024),
      context: advisor.context ? truncateUtf8(advisor.context, 2 * 1024) : undefined,
      output: advisor.output ? truncateUtf8(advisor.output, 16 * 1024) : undefined,
      error: advisor.error ? truncateUtf8(advisor.error, 2_000) : undefined,
    })),
  }, {
    maxDepth: 16,
    maxNodes: 20_000,
    maxStringBytes: 16 * 1024,
    maxTotalBytes: 512 * 1024,
  });
  const parsed = JSON.parse(JSON.stringify(compact)) as Partial<WorkflowSnapshot>;
  if (parsed.runId !== snapshot.runId || !Array.isArray(parsed.phases) || !Array.isArray(parsed.agents)
      || parsed.phases.some((phase) => !phase || typeof phase !== "object")
      || parsed.agents.some((agent) => !agent || typeof agent !== "object")) {
    throw new Error("Workflow summary could not be compacted without losing its schema");
  }
  return parsed as WorkflowSnapshot;
}

/** Public alias of the traversal-guarded run directory resolver, for
 * retention and reclamation callers outside this module. */
export function workflowRunDirectory(root: string, runId: string): string {
  return runDirectory(root, runId);
}

function runDirectory(root: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid workflow run id: ${runId}`);
  const normalizedRoot = resolve(root);
  const directory = resolve(normalizedRoot, runId);
  if (dirname(directory) !== normalizedRoot) throw new Error(`Workflow run escapes artifact root: ${runId}`);
  return directory;
}

async function requireRunDirectory(root: string, runId: string): Promise<string> {
  const directory = runDirectory(root, runId);
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Workflow run is not a directory: ${runId}`);
  return directory;
}

function isAvailabilityEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const evidence = value as { harness?: unknown; status?: unknown; executableVersion?: unknown };
  return ["pi", "claude", "codex"].includes(String(evidence.harness ?? ""))
    && ["ready", "missing", "unauthenticated", "incompatible", "unhealthy", "unknown"].includes(String(evidence.status ?? ""))
    && (evidence.executableVersion === undefined
      || typeof evidence.executableVersion === "string" && !!evidence.executableVersion && evidence.executableVersion.length <= 120);
}

function isProviderFallback(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fallback = value as Record<string, unknown>;
  return Object.keys(fallback).every((key) => key === "harness" || key === "model")
    && (fallback.harness === "claude" || fallback.harness === "codex")
    && (fallback.model === undefined || typeof fallback.model === "string" && !!fallback.model && fallback.model.length <= 256);
}

const isContinuationFallback = isProviderFallback;

function isCheckoutProof(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return typeof proof.cwd === "string" && !!proof.cwd && proof.cwd.length <= 4_096
    && typeof proof.root === "string" && !!proof.root && proof.root.length <= 4_096
    && typeof proof.gitDir === "string" && !!proof.gitDir && proof.gitDir.length <= 4_096
    && typeof proof.head === "string" && /^[a-f0-9]{40,64}$/i.test(proof.head)
    && (proof.headRef === null || typeof proof.headRef === "string" && !!proof.headRef && proof.headRef.length <= 4_096 && !proof.headRef.includes("\0"))
    && Number.isSafeInteger(proof.changedPaths) && (proof.changedPaths as number) >= 0 && (proof.changedPaths as number) <= 4_096
    && typeof proof.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(proof.digest);
}

function isContinuationTrigger(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trigger = value as Record<string, unknown>;
  return trigger.source === "continuation"
    && (trigger.provider === "claude" || trigger.provider === "codex")
    && trigger.kind === "quota"
    && (trigger.retryAt === undefined || typeof trigger.retryAt === "number" && Number.isFinite(trigger.retryAt))
    && (trigger.scope === undefined || typeof trigger.scope === "string" && trigger.scope.length <= 300)
    && typeof trigger.detail === "string" && trigger.detail.length <= 500;
}

function isAgentContinuation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const continuation = value as Record<string, unknown>;
  return ["handoff", "running", "completed", "failed"].includes(String(continuation.state))
    && (continuation.fromHarness === "claude" || continuation.fromHarness === "codex")
    && (continuation.toHarness === "claude" || continuation.toHarness === "codex")
    && continuation.fromHarness !== continuation.toHarness
    && typeof continuation.failedJobId === "string" && !!continuation.failedJobId && continuation.failedJobId.length <= 200
    && (continuation.replacementJobId === undefined || typeof continuation.replacementJobId === "string" && !!continuation.replacementJobId && continuation.replacementJobId.length <= 200)
    && typeof continuation.checkpointAt === "number" && Number.isFinite(continuation.checkpointAt)
    && continuation.checkpointAt >= 0 && continuation.checkpointAt <= 8_640_000_000_000_000
    && typeof continuation.checkoutDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(continuation.checkoutDigest)
    && isContinuationTrigger(continuation.trigger)
    && typeof continuation.warning === "string" && !!continuation.warning && continuation.warning.length <= 500;
}

function isContinuationHandoff(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const handoff = value as Record<string, unknown>;
  return Number.isSafeInteger(handoff.agentIndex) && (handoff.agentIndex as number) >= 0 && (handoff.agentIndex as number) < 32
    && (handoff.logicalJobId === undefined || typeof handoff.logicalJobId === "string" && !!handoff.logicalJobId && handoff.logicalJobId.length <= 200)
    && typeof handoff.failedJobId === "string" && !!handoff.failedJobId && handoff.failedJobId.length <= 200
    && typeof handoff.phase === "string" && handoff.phase.length <= 160
    && typeof handoff.objective === "string" && handoff.objective.length <= 2_048
    && typeof handoff.handoffPrompt === "string" && !!handoff.handoffPrompt && handoff.handoffPrompt.length <= 16_384
    && (handoff.schema === undefined || !!handoff.schema && typeof handoff.schema === "object" && !Array.isArray(handoff.schema)
      && Buffer.byteLength(JSON.stringify(handoff.schema)) <= 64 * 1_024)
    && isCheckoutProof(handoff.checkout)
    && isContinuationFallback(handoff.target)
    && isContinuationTrigger(handoff.trigger)
    && (handoff.attemptUsage === undefined || isWorkflowUsage(handoff.attemptUsage))
    && isWorkflowUsage(handoff.usage);
}

function isContinuationProgress(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  return Number.isSafeInteger(progress.agentIndex) && (progress.agentIndex as number) >= 0 && (progress.agentIndex as number) < 32
    && (progress.logicalJobId === undefined || typeof progress.logicalJobId === "string" && !!progress.logicalJobId && progress.logicalJobId.length <= 200)
    && typeof progress.failedJobId === "string" && !!progress.failedJobId && progress.failedJobId.length <= 200
    && isContinuationFallback(progress.target)
    && isContinuationTrigger(progress.trigger)
    && isWorkflowUsage(progress.attemptUsage)
    && isWorkflowUsage(progress.usage);
}

function isWorkflowUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"]
    .every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key]! >= 0);
}

function isFallbackTrigger(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trigger = value as Record<string, unknown>;
  return (trigger.source === "readiness" || trigger.source === "provider")
    && (trigger.provider === "claude" || trigger.provider === "codex")
    && (trigger.status === undefined || ["missing", "unauthenticated", "incompatible"].includes(String(trigger.status)))
    && (trigger.kind === undefined || trigger.kind === "quota")
    && (trigger.retryAt === undefined || typeof trigger.retryAt === "number" && Number.isFinite(trigger.retryAt))
    && (trigger.scope === undefined || typeof trigger.scope === "string" && trigger.scope.length <= 300)
    && typeof trigger.detail === "string" && trigger.detail.length <= 500;
}

function isWorkflowAttempt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (attempt.index === undefined || Number.isSafeInteger(attempt.index) && (attempt.index as number) >= 0 && (attempt.index as number) < 8)
    && (attempt.jobId === undefined || typeof attempt.jobId === "string" && !!attempt.jobId && attempt.jobId.length <= 200)
    && (attempt.harness === undefined || ["pi", "claude", "codex"].includes(String(attempt.harness)))
    && (attempt.requestedHarness === undefined || ["pi", "claude", "codex", "auto"].includes(String(attempt.requestedHarness)))
    && (attempt.availability === undefined || ["ready", "missing", "unauthenticated", "incompatible", "unhealthy", "unknown"].includes(String(attempt.availability)))
    && (attempt.executableVersion === undefined || typeof attempt.executableVersion === "string" && attempt.executableVersion.length <= 120)
    && (attempt.capabilityRevision === undefined || typeof attempt.capabilityRevision === "string" && attempt.capabilityRevision.length <= 200)
    && (attempt.model === undefined || typeof attempt.model === "string" && attempt.model.length <= 256)
    && (attempt.speed === undefined || attempt.speed === "standard" || attempt.speed === "fast")
    && (attempt.effectiveSpeed === undefined || attempt.effectiveSpeed === "standard" || attempt.effectiveSpeed === "fast")
    && (attempt.error === undefined || typeof attempt.error === "string" && attempt.error.length <= 2_000)
    && isWorkflowUsage(attempt.usage)
    && (attempt.endedAt === undefined || typeof attempt.endedAt === "number" && Number.isFinite(attempt.endedAt))
    && (attempt.disposition === undefined || attempt.disposition === "wait" || attempt.disposition === "fallback" || attempt.disposition === "continuation")
    && (attempt.trigger === undefined || isFallbackTrigger(attempt.trigger) || isContinuationTrigger(attempt.trigger));
}

function isWorkflowJournalRecord(value: unknown): value is WorkflowJournalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WorkflowJournalRecord>;
  if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence! < 0 || record.sequence! >= MAX_JOURNAL_RECORDS
      || !Number.isSafeInteger(record.callIndex) || record.callIndex! < 0 || record.callIndex! >= 32
      || typeof record.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.fingerprint)
      || !["started", "progressed", "handoff", "completed", "accepted", "failed"].includes(record.state ?? "")
      || typeof record.at !== "number" || !Number.isFinite(record.at)) return false;
  if (record.kind !== undefined && !["agent", "followUp", "advisor", "peerQuestion"].includes(record.kind)) return false;
  if (record.replayProof !== undefined && (record.replayProof !== true || record.kind === "peerQuestion")) return false;
  if (record.replayUsageClaim !== undefined && (record.replayUsageClaim !== true
      || record.kind === "peerQuestion" || record.replayProof === true)) return false;
  // Every peer-question state carries the same bounded lineage provenance.
  // Without it, a `started` record cannot prove what was in flight when a
  // crash occurred. Other record kinds must never acquire that authority.
  if ((record.interaction !== undefined) !== (record.kind === "peerQuestion")) return false;
  if (record.interactionPending !== undefined && (record.interactionPending !== true
      || record.kind !== "peerQuestion" || record.state !== "completed")) return false;
  if (record.interaction !== undefined) {
    const detail = record.interaction;
    if (!detail || typeof detail !== "object"
        || !Number.isSafeInteger(detail.sourceAgentIndex) || detail.sourceAgentIndex < 0 || detail.sourceAgentIndex >= 32
        || !Number.isSafeInteger(detail.sourceGeneration) || detail.sourceGeneration < 0 || detail.sourceGeneration >= 1_000
        || !Number.isSafeInteger(detail.targetAgentIndex) || detail.targetAgentIndex < 0 || detail.targetAgentIndex >= 32
        || detail.targetJobId !== undefined && (typeof detail.targetJobId !== "string" || !detail.targetJobId || detail.targetJobId.length > 200)
        || detail.targetCallFingerprint !== undefined && (typeof detail.targetCallFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(detail.targetCallFingerprint))
        || detail.targetGeneration !== undefined && (!Number.isSafeInteger(detail.targetGeneration) || detail.targetGeneration < 0 || detail.targetGeneration >= 1_000)
        || detail.route !== undefined && detail.route !== "peer" && detail.route !== "replay") return false;
  }
  if (record.agentIndex !== undefined && (!Number.isSafeInteger(record.agentIndex) || record.agentIndex! < 0 || record.agentIndex! >= 32)) return false;
  if (record.replayedFrom !== undefined && (typeof record.replayedFrom.runId !== "string"
      || !RUN_ID_PATTERN.test(record.replayedFrom.runId) || !Number.isSafeInteger(record.replayedFrom.callIndex)
      || record.replayedFrom.callIndex < 0 || record.replayedFrom.callIndex >= 32)) return false;
  if (record.route !== undefined && (record.route === null || typeof record.route !== "object"
      || record.route.harness !== undefined && !["pi", "claude", "codex"].includes(record.route.harness)
      || record.route.requestedHarness !== undefined && !["pi", "claude", "codex", "auto"].includes(record.route.requestedHarness)
      || record.route.availability !== undefined && !["ready", "missing", "unauthenticated", "incompatible", "unhealthy", "unknown"].includes(record.route.availability)
      || record.route.executableVersion !== undefined && (typeof record.route.executableVersion !== "string" || !record.route.executableVersion || record.route.executableVersion.length > 120)
      || record.route.capabilityRevision !== undefined && (typeof record.route.capabilityRevision !== "string" || !record.route.capabilityRevision || record.route.capabilityRevision.length > 200)
      || record.route.availabilityChecks !== undefined && (!Array.isArray(record.route.availabilityChecks)
        || record.route.availabilityChecks.length > 3
        || record.route.availabilityChecks.some((check) => !isAvailabilityEvidence(check)))
      || record.route.jobId !== undefined && (typeof record.route.jobId !== "string" || !record.route.jobId || record.route.jobId.length > 200)
      || record.route.logicalJobId !== undefined && (typeof record.route.logicalJobId !== "string" || !record.route.logicalJobId || record.route.logicalJobId.length > 200)
      || record.route.model !== undefined && (typeof record.route.model !== "string" || record.route.model.length > 256)
      || record.route.speed !== undefined && record.route.speed !== "standard" && record.route.speed !== "fast"
      || record.route.effectiveSpeed !== undefined && record.route.effectiveSpeed !== "standard" && record.route.effectiveSpeed !== "fast"
      || record.route.status !== undefined && !["queued", "running", "completed", "failed", "cancelled", "aborted"].includes(record.route.status)
      || record.route.error !== undefined && (typeof record.route.error !== "string" || record.route.error.length > 2_000))) return false;
  if (record.route !== undefined && (
      record.route.providerFallback !== undefined && !isProviderFallback(record.route.providerFallback)
      || record.route.continuationFallback !== undefined && !isContinuationFallback(record.route.continuationFallback)
      || record.route.continuation !== undefined && !isAgentContinuation(record.route.continuation)
      || record.route.attempts !== undefined && (!Array.isArray(record.route.attempts)
        || record.route.attempts.length > 4
        || record.route.attempts.some((attempt) => !isWorkflowAttempt(attempt))))) return false;
  if (record.replacementOf !== undefined && (record.replacementOf === null || typeof record.replacementOf !== "object"
      || typeof record.replacementOf.sourceRunId !== "string" || !RUN_ID_PATTERN.test(record.replacementOf.sourceRunId)
      || !Number.isSafeInteger(record.replacementOf.sourceAgentIndex) || record.replacementOf.sourceAgentIndex < 0 || record.replacementOf.sourceAgentIndex >= 32
      || record.replacementOf.sourceCallIndex !== undefined && (!Number.isSafeInteger(record.replacementOf.sourceCallIndex) || record.replacementOf.sourceCallIndex < 0 || record.replacementOf.sourceCallIndex >= 32)
      || record.replacementOf.sourceJobId !== undefined && (typeof record.replacementOf.sourceJobId !== "string" || !record.replacementOf.sourceJobId || record.replacementOf.sourceJobId.length > 200)
      || record.replacementOf.sourceHarness !== undefined && !["pi", "claude", "codex"].includes(record.replacementOf.sourceHarness)
      || record.replacementOf.sourceModel !== undefined && (typeof record.replacementOf.sourceModel !== "string" || !record.replacementOf.sourceModel || record.replacementOf.sourceModel.length > 256)
      || !["queued", "running", "completed", "failed", "cancelled", "aborted"].includes(record.replacementOf.sourceState)
      || record.replacementOf.sourceError !== undefined && (typeof record.replacementOf.sourceError !== "string" || record.replacementOf.sourceError.length > 2_000)
      || typeof record.replacementOf.reason !== "string" || !record.replacementOf.reason || record.replacementOf.reason.length > 200)) return false;
  if (record.state === "started") return record.result === undefined && record.route === undefined && record.replayedFrom === undefined
    && record.replacementOf === undefined && record.replayProof === undefined && record.replayUsageClaim === undefined
    && record.interactionPending === undefined && record.continuation === undefined && record.continuationProgress === undefined;
  if (record.state === "progressed") {
    return record.result === undefined && record.replayedFrom === undefined && record.replacementOf === undefined
      && record.continuation === undefined && isContinuationProgress(record.continuationProgress) && record.route !== undefined;
  }
  if (record.state === "handoff") {
    return record.result === undefined && record.replayedFrom === undefined && record.replacementOf === undefined
      && record.continuationProgress === undefined && isContinuationHandoff(record.continuation) && record.route !== undefined;
  }
  if (record.state === "accepted") {
    return record.kind === "peerQuestion" && record.result === undefined && record.route === undefined
      && record.replayedFrom === undefined && record.replacementOf === undefined
      && record.replayProof === undefined && record.replayUsageClaim === undefined
      && record.interactionPending === undefined && record.continuation === undefined
      && record.continuationProgress === undefined;
  }
  if (record.replayProof !== undefined || record.replayUsageClaim !== undefined) return false;
  if (record.continuation !== undefined || record.continuationProgress !== undefined) return false;
  if (!record.result || typeof record.result !== "object" || typeof record.result.ok !== "boolean"
      || typeof record.result.output !== "string" || record.result.output.length > JOURNAL_RECORD_BYTES
      || record.result.jobId !== undefined && (typeof record.result.jobId !== "string" || !record.result.jobId || record.result.jobId.length > 200)
      || record.result.error !== undefined && typeof record.result.error !== "string"
      || record.result.progressed !== undefined && record.result.progressed !== true
      || record.result.transport !== undefined && record.result.transport !== "native" && record.result.transport !== "portable"
      || record.result.advisorId !== undefined && (typeof record.result.advisorId !== "string" || !/^adv_[a-f0-9]{32}$/.test(record.result.advisorId))
      || record.result.advisorName !== undefined && typeof record.result.advisorName !== "string"
      || record.result.advisorLineage !== undefined && (!Number.isSafeInteger(record.result.advisorLineage) || record.result.advisorLineage < 0)
      || record.result.advisorGeneration !== undefined && (!Number.isSafeInteger(record.result.advisorGeneration) || record.result.advisorGeneration < 0)
      || record.result.queuedMs !== undefined && (typeof record.result.queuedMs !== "number" || !Number.isFinite(record.result.queuedMs) || record.result.queuedMs < 0)) return false;
  return record.state === "completed" ? record.result.ok : !record.result.ok;
}

async function appendJournalLine(path: string, record: WorkflowJournalRecord): Promise<void> {
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents) > JOURNAL_RECORD_BYTES) throw new Error("Workflow journal record exceeds the 1 MiB limit");
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Workflow journal is not a regular file");
    if (info.size + Buffer.byteLength(contents) > JOURNAL_FILE_BYTES) throw new Error("Workflow journal exceeds the 72 MiB limit");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function appendWorkflowJournal(root: string, runId: string, record: WorkflowJournalRecord): Promise<void> {
  if (!isWorkflowJournalRecord(record)) throw new Error("Invalid workflow journal record");
  const directory = await requireRunDirectory(root, runId);
  const path = join(directory, "journal.jsonl");
  const previous = journalWrites.get(path) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => appendJournalLine(path, record));
  journalWrites.set(path, write);
  try { await write; }
  finally { if (journalWrites.get(path) === write) journalWrites.delete(path); }
}

/** Load the durable prefix only. A partial tail from a crash is ignored; a
 * malformed or out-of-sequence complete line stops replay before corruption. */
export async function loadWorkflowJournal(root: string, runId: string): Promise<WorkflowJournalRecord[]> {
  const directory = await requireRunDirectory(root, runId);
  const path = join(directory, "journal.jsonl");
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Workflow journal is not a regular file: ${runId}`);
  if (info.size > JOURNAL_FILE_BYTES) throw new Error("Workflow journal exceeds the 72 MiB limit");
  const contents = await readFile(path, "utf8");
  const complete = contents.endsWith("\n") ? contents : contents.slice(0, contents.lastIndexOf("\n") + 1);
  const records: WorkflowJournalRecord[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    if (records.length >= MAX_JOURNAL_RECORDS || Buffer.byteLength(line) > JOURNAL_RECORD_BYTES) break;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { break; }
    if (!isWorkflowJournalRecord(parsed) || parsed.sequence !== records.length) break;
    records.push(parsed);
  }
  return records;
}

export async function createWorkflowArtifacts(
  root: string,
  input: CreateWorkflowArtifactsInput,
): Promise<WorkflowSnapshot> {
  const normalizedRoot = resolve(root);
  await ensurePrivateDirectory(normalizedRoot);

  let runId: string;
  let artifactDir: string;
  for (;;) {
    runId = `wf_${randomBytes(12).toString("hex")}`;
    artifactDir = runDirectory(normalizedRoot, runId);
    try {
      await mkdir(artifactDir, { mode: 0o700 });
      await chmod(artifactDir, 0o700);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const workflow: WorkflowSnapshot = { ...input.snapshot, runId, artifactDir };
  try {
    await atomicWrite(join(artifactDir, "script.js"), input.script);
    await atomicWriteJson(join(artifactDir, "args.json"), input.args, input.limits);
    await atomicWrite(join(artifactDir, "journal.jsonl"), "");
    await atomicWriteJson(join(artifactDir, "transcripts.json"), transcriptArtifact(workflow), { maxTotalBytes: 2 * 1024 * 1024 });
    await atomicWriteJson(join(artifactDir, "workflow.json"), workflow, input.limits);
    await atomicWriteJson(join(artifactDir, "result.json"), workflow.result ?? null, input.limits);
    return workflow;
  } catch (error) {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function checkpointWorkflow(
  root: string,
  snapshot: WorkflowSnapshot,
  limits: Partial<WorkflowSerializationLimits> = {},
): Promise<void> {
  const directory = await requireRunDirectory(root, snapshot.runId);
  const normalized: WorkflowSnapshot = { ...snapshot, artifactDir: directory, transcriptArtifact: "transcripts.json" };
  await atomicWriteJson(join(directory, "transcripts.json"), transcriptArtifact(normalized), { maxTotalBytes: 2 * 1024 * 1024 });
  // Never let a caller's tiny serialization override collapse the whole
  // summary into a truncation marker; structural validity outranks verbosity.
  const durable = durableWorkflowSnapshot(normalized);
  await atomicWriteJson(join(directory, "workflow.json"), durable, {
    ...limits,
    maxTotalBytes: Math.max(512 * 1024, limits.maxTotalBytes ?? 0),
  });
}

export async function writeWorkflowResult(
  root: string,
  runId: string,
  result: unknown,
  limits: Partial<WorkflowSerializationLimits> = {},
): Promise<void> {
  const directory = await requireRunDirectory(root, runId);
  await atomicWriteJson(join(directory, "result.json"), result, limits);
}

export async function writeWorkflowReport(root: string, snapshot: WorkflowSnapshot): Promise<void> {
  const directory = await requireRunDirectory(root, snapshot.runId);
  const agentUsage = snapshot.agents.reduce((total, agent) => ({
    input: total.input + agent.usage.input,
    output: total.output + agent.usage.output,
    cacheRead: total.cacheRead + agent.usage.cacheRead,
    cacheWrite: total.cacheWrite + agent.usage.cacheWrite,
    cost: total.cost + agent.usage.cost,
    turns: total.turns + agent.usage.turns,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
  const usage = (snapshot.advisorConsultations ?? []).reduce((total, advisor) => ({
    input: total.input + advisor.usage.input,
    output: total.output + advisor.usage.output,
    cacheRead: total.cacheRead + advisor.usage.cacheRead,
    cacheWrite: total.cacheWrite + advisor.usage.cacheWrite,
    cost: total.cost + advisor.usage.cost,
    turns: total.turns + advisor.usage.turns,
  }), agentUsage);
  const budget = formatWorkflowBudget(snapshot, usage);
  const lines = [
    `# ${snapshot.name}`,
    "",
    snapshot.description,
    "",
    `- Run: \`${snapshot.runId}\``,
    `- Status: **${snapshot.status}**`,
    ...(snapshot.status === "completed" ? [`- Task outcome: **${snapshot.taskOutcome ?? workflowTaskOutcome(snapshot.result)}**`] : []),
    `- Agents: ${snapshot.agents.length}`,
    `- Advisor consultations: ${snapshot.advisorConsultations?.length ?? 0}`,
    `- Usage: ${usage.input} fresh input / ${usage.output} output / ${usage.cacheRead} cache-read / ${usage.cacheWrite} cache-write tokens · ${usage.turns} turns · $${usage.cost.toFixed(4)}`,
    ...(budget ? [`- Budget: ${budget}`] : []),
    "",
    "## Phases",
    ...snapshot.phases.map((phase) => `- ${phase.name}: ${phase.status} (${phase.agents.length} agents, ${phase.advisorConsultations?.length ?? 0} advisor calls)`),
    "",
    ...(snapshot.convergence ? [
      "## Convergence",
      `- Loop: ${snapshot.convergence.name ? truncateUtf8(snapshot.convergence.name, 200) : "unnamed"}`,
      `- State: **${snapshot.convergence.state}**`,
      `- Rounds: ${snapshot.convergence.round}/${snapshot.convergence.maxRounds}`,
      ...(snapshot.convergence.verdict ? [`- Latest verdict: ${snapshot.convergence.verdict} (${snapshot.convergence.actionableCount ?? 0} actionable)`] : []),
      ...(snapshot.convergence.stoppingReason ? [`- Stopping reason: ${truncateUtf8(snapshot.convergence.stoppingReason, 2_000)}`] : []),
      ...snapshot.convergence.rounds.map((round) => `- Round ${round.round}: ${round.verdict} · ${round.actionableCount} actionable · fingerprint ${round.fingerprint}`),
      "",
    ] : []),
    ...(snapshot.logs?.length ? [
      "## Progress",
      ...snapshot.logs.slice(-32).map((entry) => `- ${truncateUtf8(entry.message, 4 * 1024)}`),
      "",
    ] : []),
    "## Agents",
    ...snapshot.agents.map((agent) => `### ${agent.name}\n\n- Access: ${agent.access}\n- Profile: ${agent.profile ?? "none"}\n- Independent: ${agent.independent ? "yes" : "no"}\n- Status: ${agent.state}\n- Route: ${agent.harness ?? "?"}/${agent.model ?? "?"}\n- Effort: ${agent.effort ?? "adaptive"}\n\n${truncateUtf8(String(agent.output ?? agent.preview ?? agent.error ?? "(no output)"), 8 * 1024)}\n`),
    ...(snapshot.advisorConsultations?.map((advisor) => `### Advisor · ${advisor.advisorName}\n\n- ID: ${advisor.advisorId}\n- Lineage/generation: ${advisor.lineage}/${advisor.generation ?? "?"}\n- Status: ${advisor.state}\n- Route: ${advisor.harness ?? "?"}/${advisor.model ?? "?"}\n- Replay: ${advisor.outputProvenance === "replay" ? "yes" : "no"}\n\n${truncateUtf8(String(advisor.output ?? advisor.error ?? "(no output)"), 8 * 1024)}\n`) ?? []),
    "## Result",
    "",
    "```json",
    JSON.stringify(serializeWorkflowValue(snapshot.result, { maxTotalBytes: 128 * 1024 }), null, 2),
    "```",
    "",
  ];
  await atomicWrite(join(directory, "report.md"), lines.join("\n"));
}

function normalizeToolResult(value: unknown): ToolResultSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return undefined;
  return {
    content: record.content
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        type: String(item.type ?? "text"),
        text: typeof item.text === "string" ? item.text : undefined,
        data: typeof item.data === "string" ? item.data : undefined,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      })),
    details: record.details,
    isError: record.isError === true,
  };
}

function normalizeTranscript(value: unknown): TranscriptEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: TranscriptEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "thinking") {
      if (typeof entry.text === "string") entries.push({ kind: entry.kind, text: entry.text, at: typeof entry.at === "number" ? entry.at : undefined });
    } else if (entry.kind === "tool" && typeof entry.toolId === "string" && typeof entry.name === "string") {
      const args = entry.args !== null && typeof entry.args === "object" && !Array.isArray(entry.args)
        ? entry.args as Record<string, unknown>
        : undefined;
      entries.push({
        kind: "tool",
        phase: entry.phase === "start" || entry.phase === "end" ? entry.phase : undefined,
        toolId: entry.toolId,
        name: entry.name,
        args,
        result: normalizeToolResult(entry.result),
        text: typeof entry.text === "string" ? entry.text : undefined,
        error: entry.error === true,
        at: typeof entry.at === "number" ? entry.at : undefined,
      });
    }
  }
  return boundedTranscript(entries);
}

function validReplacementReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.sourceRunId === "string"
    && RUN_ID_PATTERN.test(reference.sourceRunId)
    && Number.isSafeInteger(reference.sourceAgentIndex)
    && (reference.sourceAgentIndex as number) >= 0
    && (reference.sourceAgentIndex as number) < 32
    && (reference.sourceCallIndex === undefined || Number.isSafeInteger(reference.sourceCallIndex) && (reference.sourceCallIndex as number) >= 0 && (reference.sourceCallIndex as number) < 32)
    && (reference.sourceJobId === undefined || typeof reference.sourceJobId === "string" && reference.sourceJobId.length > 0 && reference.sourceJobId.length <= 200)
    && (reference.sourceHarness === undefined || reference.sourceHarness === "pi" || reference.sourceHarness === "claude" || reference.sourceHarness === "codex")
    && (reference.sourceModel === undefined || typeof reference.sourceModel === "string" && reference.sourceModel.length > 0 && reference.sourceModel.length <= 256)
    && ["queued", "running", "completed", "failed", "cancelled", "aborted"].includes(String(reference.sourceState))
    && (reference.sourceError === undefined || typeof reference.sourceError === "string" && reference.sourceError.length <= 2_000)
    && typeof reference.reason === "string"
    && reference.reason.length > 0
    && reference.reason.length <= 200;
}

function validReplayState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const replay = value as Record<string, unknown>;
  return typeof replay.sourceRunId === "string"
    && RUN_ID_PATTERN.test(replay.sourceRunId)
    && Number.isSafeInteger(replay.matchedCalls)
    && (replay.matchedCalls as number) >= 0
    && (replay.matchedCalls as number) <= 32
    && (replay.invalidatedAt === undefined || Number.isSafeInteger(replay.invalidatedAt)
      && (replay.invalidatedAt as number) >= 0 && (replay.invalidatedAt as number) < 32)
    && (replay.carriedUsage === undefined || isWorkflowUsage(replay.carriedUsage));
}

function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkflowSnapshot>;
  const plannedPhaseCount = candidate.plannedPhaseCount;
  const validPlannedPhaseCount = plannedPhaseCount === undefined
    || Number.isSafeInteger(plannedPhaseCount)
      && plannedPhaseCount >= 1
      && plannedPhaseCount <= 64
      && Array.isArray(candidate.phases)
      && candidate.phases.length === plannedPhaseCount;
  return typeof candidate.runId === "string"
    && RUN_ID_PATTERN.test(candidate.runId)
    && typeof candidate.sessionId === "string"
    && typeof candidate.name === "string"
    && typeof candidate.description === "string"
    && typeof candidate.background === "boolean"
    && typeof candidate.status === "string"
    && (candidate.taskOutcome === undefined || candidate.taskOutcome === "successful" || candidate.taskOutcome === "unsuccessful" || candidate.taskOutcome === "unspecified")
    && !!candidate.timestamps
    && typeof candidate.timestamps === "object"
    && typeof candidate.timestamps.createdAt === "number"
    && typeof candidate.timestamps.updatedAt === "number"
    && (candidate.approval === undefined || candidate.approval === "auto" || candidate.approval === "plan" || candidate.approval === "onMutate")
    && (candidate.replacementOf === undefined || validReplacementReference(candidate.replacementOf))
    && (candidate.replay === undefined || validReplayState(candidate.replay))
    && (candidate.convergence === undefined || isWorkflowConvergence(candidate.convergence))
    && (candidate.budget === undefined || !!candidate.budget && typeof candidate.budget === "object" && !Array.isArray(candidate.budget)
      && Object.keys(candidate.budget).every((key) => ["maxAgents", "maxConcurrency", "maxTokens", "maxTokensPerAgent", "maxCost", "maxTurns"].includes(key))
      && Object.values(candidate.budget).every((item) => item === undefined || typeof item === "number" && Number.isFinite(item) && item > 0))
    && validPlannedPhaseCount
    && Array.isArray(candidate.phases)
    && Array.isArray(candidate.agents)
    && candidate.agents.every((agent) => !!agent && typeof agent === "object"
      && typeof agent.name === "string"
      && (agent.access === "readOnly" || agent.access === "full")
      && (agent.speed === undefined || agent.speed === "standard" || agent.speed === "fast")
      && (agent.effectiveSpeed === undefined || agent.effectiveSpeed === "standard" || agent.effectiveSpeed === "fast")
      && typeof agent.independent === "boolean")
    && (candidate.advisors === undefined || Array.isArray(candidate.advisors)
      && candidate.advisors.length <= 16
      && candidate.advisors.every((advisorId) => typeof advisorId === "string" && /^adv_[a-f0-9]{32}$/.test(advisorId)))
    && (candidate.advisorConsultations === undefined || Array.isArray(candidate.advisorConsultations)
      && candidate.advisorConsultations.length <= 32
      && candidate.advisorConsultations.every((advisor) => !!advisor && typeof advisor === "object"
        && typeof advisor.advisorId === "string"
        && typeof advisor.advisorName === "string"
        && typeof advisor.prompt === "string"
        && isWorkflowUsage(advisor.usage)));
}

function withDefaultAgentSpeeds(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => ({ ...agent, speed: agent.speed ?? "standard" })),
  };
}

function currentPhasePosition(snapshot: WorkflowSnapshot): number | undefined {
  const currentPhase = snapshot.currentPhase;
  if (typeof currentPhase !== "number" || !Number.isSafeInteger(currentPhase) || currentPhase < 0) return undefined;
  // Phase indexes are the durable identity. Older snapshots may only have
  // recorded the array position, so fall back only when no index matches.
  const indexedPosition = snapshot.phases.findIndex((phase) => phase.index === currentPhase);
  if (indexedPosition >= 0) return indexedPosition;
  return currentPhase < snapshot.phases.length ? currentPhase : undefined;
}

function abortStaleWorkflow(snapshot: WorkflowSnapshot, now: number, staleAfterMs: number): WorkflowSnapshot {
  if (snapshot.status !== "running" && snapshot.status !== "paused") return snapshot;
  // staleAfterMs=0 is the explicit no-resume mode: every restored running
  // checkpoint is from a previous manager, even with equal/future timestamps.
  if (staleAfterMs > 0 && now - snapshot.timestamps.updatedAt <= staleAfterMs) return snapshot;
  const error = snapshot.error ?? "Workflow was aborted because its running checkpoint became stale.";
  const declared = snapshot.plannedPhaseCount !== undefined;
  const currentPosition = declared ? currentPhasePosition(snapshot) : undefined;
  return {
    ...snapshot,
    status: "aborted",
    error,
    timestamps: { ...snapshot.timestamps, updatedAt: now, pausedAt: undefined, endedAt: now },
    phases: snapshot.phases.map((phase, position) => {
      const stale = declared
        ? phase.status === "running" || phase.status === "paused"
          || (position === currentPosition && phase.status === "pending")
        : phase.status === "running" || phase.status === "pending";
      return stale ? {
        ...phase,
        status: "aborted",
        error: phase.error ?? error,
        timestamps: { ...phase.timestamps, updatedAt: now, endedAt: now },
      } : phase;
    }),
    interactions: snapshot.interactions?.map((interaction) =>
      interaction.state === "pending" || interaction.state === "answering"
        ? { ...interaction, state: "cancelled", answeredAt: now, error: interaction.error ?? error }
        : interaction),
    agents: snapshot.agents.map((agent) => {
      const cleared = { ...agent, waitingOn: undefined, answering: undefined };
      return agent.state === "running" || agent.state === "queued" || agent.state === "waiting" ? {
        ...cleared,
        state: "aborted",
        error: agent.error ?? error,
        providerWait: undefined,
        timestamps: { ...agent.timestamps, updatedAt: now, endedAt: now },
      } : cleared;
    }),
    advisorConsultations: snapshot.advisorConsultations?.map((advisor) =>
      advisor.state === "running" || advisor.state === "queued" || advisor.state === "waiting"
        ? {
            ...advisor,
            state: "aborted",
            error: advisor.error ?? error,
            timestamps: { ...advisor.timestamps, updatedAt: now, endedAt: now },
          }
        : advisor),
  };
}

export async function loadWorkflowSummaries(
  root: string,
  options: LoadWorkflowSummariesOptions = {},
): Promise<WorkflowSnapshot[]> {
  const normalizedRoot = resolve(root);
  await ensurePrivateDirectory(normalizedRoot);
  const now = options.now ?? Date.now();
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const entries = await readdir(normalizedRoot, { withFileTypes: true });
  const summaries: WorkflowSnapshot[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const directory = runDirectory(normalizedRoot, entry.name);
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, "workflow.json"), "utf8"));
      if (!isWorkflowSnapshot(parsed) || parsed.runId !== entry.name) continue;
      if (options.sessionId !== undefined && parsed.sessionId !== options.sessionId) continue;
      let authoritativeResult: unknown = parsed.result;
      if (parsed.status === "completed" && parsed.taskOutcome === undefined) {
        try { authoritativeResult = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as unknown; }
        catch { /* older or partial runs may only retain the bounded summary result */ }
      }
      let snapshot: WorkflowSnapshot = {
        ...parsed,
        artifactDir: directory,
        taskOutcome: parsed.taskOutcome ?? (parsed.status === "completed" ? workflowTaskOutcome(authoritativeResult) : undefined),
        agents: parsed.agents.map((agent) => ({ ...agent, activity: undefined })),
      };
      snapshot = withDefaultAgentSpeeds(snapshot);
      if (snapshot.transcriptArtifact) {
        try {
          const rawTranscripts = JSON.parse(await readFile(join(directory, snapshot.transcriptArtifact), "utf8")) as Record<string, unknown>;
          snapshot = {
            ...snapshot,
            agents: snapshot.agents.map((agent) => ({
              ...agent,
              transcript: normalizeTranscript(rawTranscripts[String(agent.index)]),
            })),
          };
        } catch { /* transcript artifact is optional; summary remains usable */ }
      }
      const aborted = abortStaleWorkflow(snapshot, now, staleAfterMs);
      if (aborted !== snapshot) {
        snapshot = aborted;
        await atomicWriteJson(join(directory, "workflow.json"), durableWorkflowSnapshot(snapshot), {
          ...options.limits,
          maxTotalBytes: Math.max(512 * 1024, options.limits?.maxTotalBytes ?? 0),
        });
      }
      summaries.push(snapshot);
    } catch {
      // A partial, corrupt, unreadable, or concurrently removed run is not a summary.
    }
  }

  return summaries.sort((left, right) => right.timestamps.updatedAt - left.timestamps.updatedAt);
}

/** Directory names under the artifact root that look like run IDs. Does not
 * validate their contents; a caller must still read and check `workflow.json`. */
export async function listWorkflowRunIds(root: string): Promise<string[]> {
  const normalizedRoot = resolve(root);
  let entries;
  try { entries = await readdir(normalizedRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
}

/** Reads only `workflow.json` for one run; undefined on any read, parse, or schema failure. */
export async function readWorkflowRunSummary(root: string, runId: string): Promise<WorkflowSnapshot | undefined> {
  try {
    const directory = runDirectory(root, runId);
    const parsed: unknown = JSON.parse(await readFile(join(directory, "workflow.json"), "utf8"));
    if (!isWorkflowSnapshot(parsed) || parsed.runId !== runId) return undefined;
    return withDefaultAgentSpeeds({ ...parsed, artifactDir: directory });
  } catch { return undefined; }
}

/** Deletes a run directory outright. Callers must verify retention eligibility first. */
export async function removeWorkflowRun(root: string, runId: string): Promise<void> {
  await rm(runDirectory(root, runId), { recursive: true, force: true });
}

/** Patches one agent's isolation result in the durable summary, applying the
 * same structural-validity floor as {@link checkpointWorkflow}. */
export async function updateWorkflowRunIsolation(
  root: string,
  runId: string,
  agentIndex: number,
  isolation: WorkflowWorktreeResult,
): Promise<void> {
  const directory = await requireRunDirectory(root, runId);
  const parsed: unknown = JSON.parse(await readFile(join(directory, "workflow.json"), "utf8"));
  if (!isWorkflowSnapshot(parsed) || parsed.runId !== runId) throw new Error(`Workflow run summary is invalid: ${runId}`);
  if (!parsed.agents[agentIndex]) throw new Error(`Unknown workflow agent: ${agentIndex}`);
  const next: WorkflowSnapshot = {
    ...parsed,
    artifactDir: directory,
    agents: parsed.agents.map((agent, index) => index === agentIndex ? { ...agent, isolation } : agent),
  };
  await atomicWriteJson(join(directory, "workflow.json"), durableWorkflowSnapshot(next), { maxTotalBytes: 512 * 1024 });
}
