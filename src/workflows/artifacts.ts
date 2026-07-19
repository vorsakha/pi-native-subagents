import { randomBytes } from "node:crypto";
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
import type { TranscriptEntry } from "../types.ts";
import type { WorkflowSnapshot } from "./types.ts";

const RUN_ID_PATTERN = /^wf_[a-f0-9]+$/;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const TRANSCRIPT_ENTRY_BYTES = 4 * 1_024;
const TRANSCRIPT_AGENT_BYTES = 32 * 1_024;

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
  })) as TranscriptEntry[];
  const size = (items: TranscriptEntry[]) => Buffer.byteLength(JSON.stringify(items));
  if (size(bounded) <= TRANSCRIPT_AGENT_BYTES) return bounded;
  const first = bounded[0];
  const tail: TranscriptEntry[] = [];
  for (let index = bounded.length - 1; index > 0; index--) {
    const candidate = [
      ...(first ? [first] : []),
      { kind: "tool", toolId: "transcript", name: "transcript", text: "[older transcript entries omitted]" } as TranscriptEntry,
      ...[...tail].reverse(),
      bounded[index]!,
    ];
    if (size(candidate) > TRANSCRIPT_AGENT_BYTES) break;
    tail.push(bounded[index]!);
  }
  return [
    ...(first ? [first] : []),
    { kind: "tool", toolId: "transcript", name: "transcript", text: "[older transcript entries omitted]" },
    ...tail.reverse(),
  ];
}

function transcriptArtifact(snapshot: WorkflowSnapshot): Record<string, TranscriptEntry[]> {
  return Object.fromEntries(snapshot.agents.slice(0, 32).map((agent) => [String(agent.index), boundedTranscript(agent.transcript)]));
}

/** Keep the workflow summary structurally valid even when 32 agents each
 * produce their maximum retained output. Full native transcripts remain in
 * backend session files; workflow.json is an inspectable bounded summary. */
export function durableWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const compact = serializeWorkflowValue({
    ...snapshot,
    name: truncateUtf8(snapshot.name, 1_000),
    description: truncateUtf8(snapshot.description, 4_000),
    error: snapshot.error ? truncateUtf8(snapshot.error, 4_000) : undefined,
    transcriptArtifact: "transcripts.json",
    reportArtifact: snapshot.reportArtifact,
    result: serializeWorkflowValue(snapshot.result, { maxNodes: 4_000, maxStringBytes: 16 * 1024, maxTotalBytes: 64 * 1024 }),
    phases: snapshot.phases.slice(0, 64).map((phase) => ({
      ...phase,
      name: truncateUtf8(phase.name, 1_000),
      description: phase.description ? truncateUtf8(phase.description, 2_000) : undefined,
      error: phase.error ? truncateUtf8(phase.error, 2_000) : undefined,
      agents: phase.agents.slice(0, 32),
      result: serializeWorkflowValue(phase.result, { maxNodes: 256, maxStringBytes: 4 * 1024, maxTotalBytes: 8 * 1024 }),
    })),
    agents: snapshot.agents.slice(0, 32).map((agent) => ({
      ...agent,
      name: truncateUtf8(agent.name, 1_000),
      prompt: agent.prompt ? truncateUtf8(agent.prompt, 2 * 1024) : undefined,
      tools: agent.tools?.slice(-8).map((tool) => ({
        ...tool,
        name: truncateUtf8(tool.name, 512),
        summary: tool.summary ? truncateUtf8(tool.summary, 1_000) : undefined,
      })),
      liveThinking: undefined,
      preview: agent.preview ? truncateUtf8(agent.preview, 1_000) : undefined,
      output: serializeWorkflowValue(agent.output, { maxNodes: 256, maxStringBytes: 4 * 1024, maxTotalBytes: 6 * 1024 }),
      structured: serializeWorkflowValue(agent.structured, { maxNodes: 512, maxStringBytes: 8 * 1024, maxTotalBytes: 16 * 1024 }),
      transcript: undefined,
      error: agent.error ? truncateUtf8(agent.error, 2_000) : undefined,
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
  const usage = snapshot.agents.reduce((total, agent) => ({
    input: total.input + agent.usage.input,
    output: total.output + agent.usage.output,
    cost: total.cost + agent.usage.cost,
    turns: total.turns + agent.usage.turns,
  }), { input: 0, output: 0, cost: 0, turns: 0 });
  const lines = [
    `# ${snapshot.name}`,
    "",
    snapshot.description,
    "",
    `- Run: \`${snapshot.runId}\``,
    `- Status: **${snapshot.status}**`,
    `- Agents: ${snapshot.agents.length}`,
    `- Usage: ${usage.input} input / ${usage.output} output tokens · ${usage.turns} turns · $${usage.cost.toFixed(4)}`,
    "",
    "## Phases",
    ...snapshot.phases.map((phase) => `- ${phase.name}: ${phase.status} (${phase.agents.length} agents)`),
    "",
    "## Agents",
    ...snapshot.agents.map((agent) => `### ${agent.name}\n\n- Access: ${agent.access}\n- Profile: ${agent.profile ?? "none"}\n- Independent: ${agent.independent ? "yes" : "no"}\n- Status: ${agent.state}\n- Route: ${agent.backend ?? "?"}/${agent.model ?? "?"}\n- Effort: ${agent.effort ?? "adaptive"}\n\n${truncateUtf8(String(agent.output ?? agent.preview ?? agent.error ?? "(no output)"), 8 * 1024)}\n`),
    "## Result",
    "",
    "```json",
    JSON.stringify(serializeWorkflowValue(snapshot.result, { maxTotalBytes: 128 * 1024 }), null, 2),
    "```",
    "",
  ];
  await atomicWrite(join(directory, "report.md"), lines.join("\n"));
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
      entries.push({ kind: "tool", toolId: entry.toolId, name: entry.name, text: typeof entry.text === "string" ? entry.text : undefined, error: entry.error === true, at: typeof entry.at === "number" ? entry.at : undefined });
    }
  }
  return boundedTranscript(entries);
}

function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkflowSnapshot>;
  return typeof candidate.runId === "string"
    && RUN_ID_PATTERN.test(candidate.runId)
    && typeof candidate.sessionId === "string"
    && typeof candidate.name === "string"
    && typeof candidate.description === "string"
    && typeof candidate.background === "boolean"
    && typeof candidate.status === "string"
    && !!candidate.timestamps
    && typeof candidate.timestamps === "object"
    && typeof candidate.timestamps.createdAt === "number"
    && typeof candidate.timestamps.updatedAt === "number"
    && Array.isArray(candidate.phases)
    && Array.isArray(candidate.agents)
    && candidate.agents.every((agent) => !!agent && typeof agent === "object"
      && typeof agent.name === "string"
      && (agent.access === "readOnly" || agent.access === "full")
      && typeof agent.independent === "boolean");
}

function abortStaleWorkflow(snapshot: WorkflowSnapshot, now: number, staleAfterMs: number): WorkflowSnapshot {
  if (snapshot.status !== "running") return snapshot;
  // staleAfterMs=0 is the explicit no-resume mode: every restored running
  // checkpoint is from a previous manager, even with equal/future timestamps.
  if (staleAfterMs > 0 && now - snapshot.timestamps.updatedAt <= staleAfterMs) return snapshot;
  const error = snapshot.error ?? "Workflow was aborted because its running checkpoint became stale.";
  return {
    ...snapshot,
    status: "aborted",
    error,
    timestamps: { ...snapshot.timestamps, updatedAt: now, endedAt: now },
    phases: snapshot.phases.map((phase) => phase.status === "running" || phase.status === "pending" ? {
      ...phase,
      status: "aborted",
      error: phase.error ?? error,
      timestamps: { ...phase.timestamps, updatedAt: now, endedAt: now },
    } : phase),
    agents: snapshot.agents.map((agent) => agent.state === "running" || agent.state === "queued" ? {
      ...agent,
      state: "aborted",
      error: agent.error ?? error,
      timestamps: { ...agent.timestamps, updatedAt: now, endedAt: now },
    } : agent),
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
      let snapshot: WorkflowSnapshot = { ...parsed, artifactDir: directory };
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
