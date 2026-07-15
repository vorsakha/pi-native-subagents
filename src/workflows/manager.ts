import { resolve } from "node:path";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { JobManager } from "../manager.ts";
import { isTerminal } from "../manager.ts";
import type { BackendName, JobSnapshot, ModelTier, Usage } from "../types.ts";
import {
  checkpointWorkflow,
  createWorkflowArtifacts,
  loadWorkflowSummaries,
  writeWorkflowReport,
  writeWorkflowResult,
} from "./artifacts.ts";
import { runWorkflowSandbox, type WorkflowAgentResult } from "./sandbox.ts";
import type {
  WorkflowAgentRecord,
  WorkflowAgentState,
  WorkflowBudget,
  WorkflowPhase,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowUsage,
} from "./types.ts";

const BACKENDS = new Set<BackendName>(["pi", "claude", "codex"]);
const TIERS = new Set<ModelTier>(["economy", "balanced", "quality"]);
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const CHECKPOINT_DELAY_MS = 150;
const MAX_RETAINED_RUNS = 64;
export const MAX_WORKFLOW_PHASES = 64;

export interface StartWorkflowRequest {
  sessionId: string;
  name: string;
  description?: string;
  script: string;
  args?: unknown;
  background?: boolean;
  timeoutMs?: number;
  cwd: string;
  trusted: boolean;
  depth?: number;
  budget?: WorkflowBudget;
}

export interface StartedWorkflow {
  snapshot: WorkflowSnapshot;
  completion: Promise<WorkflowSnapshot>;
}

interface RunEntry {
  snapshot: WorkflowSnapshot;
  controller: AbortController;
  completion: Promise<WorkflowSnapshot>;
  checkpointTimer?: NodeJS.Timeout;
  persistChain: Promise<void>;
}

function workflowUsage(usage?: Partial<Usage>): WorkflowUsage {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: usage?.cost ?? 0,
    turns: usage?.turns ?? 0,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedText(value: unknown, max = 16_384): string {
  return String(value instanceof Error ? value.message : value ?? "").slice(0, max);
}

function label(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 160);
}

function agentState(job: JobSnapshot): WorkflowAgentState {
  switch (job.status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "running": return "running";
    default: return "queued";
  }
}

function terminalWorkflow(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

export class WorkflowManager {
  readonly #jobs: JobManager;
  readonly #artifactRoot: string;
  readonly #runs = new Map<string, RunEntry>();
  readonly #jobOwners = new Map<string, { runId: string; agentIndex: number }>();
  readonly #listeners = new Set<(snapshot: WorkflowSnapshot) => void>();
  readonly #unsubscribeJobs: () => void;
  #initializing?: Promise<void>;
  #closed = false;

  constructor(options: { jobs: JobManager; artifactRoot: string }) {
    this.#jobs = options.jobs;
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#unsubscribeJobs = this.#jobs.subscribe((job) => this.#updateAgentFromJob(job));
  }

  async initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      const restored = await loadWorkflowSummaries(this.#artifactRoot, { staleAfterMs: 0 });
      for (const snapshot of restored.slice(0, MAX_RETAINED_RUNS)) {
        if (this.#runs.has(snapshot.runId)) continue;
        const controller = new AbortController();
        const completion = Promise.resolve(clone(snapshot));
        this.#runs.set(snapshot.runId, {
          snapshot,
          controller,
          completion,
          persistChain: Promise.resolve(),
        });
      }
    })();
    return this.#initializing;
  }

  list(): WorkflowSnapshot[] {
    return [...this.#runs.values()]
      .map((entry) => clone(entry.snapshot))
      .sort((left, right) => right.timestamps.createdAt - left.timestamps.createdAt);
  }

  check(runId: string): WorkflowSnapshot {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    return clone(entry.snapshot);
  }

  subscribe(listener: (snapshot: WorkflowSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(request: StartWorkflowRequest): Promise<StartedWorkflow> {
    if (!request.trusted) throw new Error("Workflows are disabled for untrusted projects");
    await this.initialize();
    if (this.#closed) throw new Error("Workflow manager is closed");
    if (!request.script.trim()) throw new Error("Workflow script must not be empty");
    const now = Date.now();
    const base: Omit<WorkflowSnapshot, "runId" | "artifactDir"> = {
      sessionId: request.sessionId,
      name: label(request.name, "workflow"),
      description: label(request.description, ""),
      background: request.background ?? false,
      status: "running",
      timestamps: { createdAt: now, updatedAt: now, startedAt: now },
      currentPhase: null,
      phases: [],
      agents: [],
      budget: request.budget,
    };
    const snapshot = await createWorkflowArtifacts(this.#artifactRoot, {
      script: request.script,
      args: request.args ?? null,
      snapshot: base,
    });
    this.#evictOldRuns();
    const controller = new AbortController();
    const entry: RunEntry = {
      snapshot,
      controller,
      completion: Promise.resolve(snapshot),
      persistChain: Promise.resolve(),
    };
    this.#runs.set(snapshot.runId, entry);
    entry.completion = this.#execute(entry, request);
    this.#publish(entry);
    return { snapshot: clone(snapshot), completion: entry.completion };
  }

  async cancel(runId: string, reason = "Cancelled by parent"): Promise<WorkflowSnapshot> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    if (terminalWorkflow(entry.snapshot.status)) return clone(entry.snapshot);
    entry.snapshot.error = boundedText(reason);
    entry.controller.abort(new Error(reason));
    return entry.completion;
  }

  async shutdown(timeoutMs = 8_000): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#initializing?.catch(() => undefined);
    const active = [...this.#runs.values()].filter((entry) => !terminalWorkflow(entry.snapshot.status));
    for (const entry of active) {
      entry.snapshot.error = "Session shutdown";
      entry.controller.abort(new Error("Session shutdown"));
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(active.map((entry) => entry.completion)).then(() => undefined),
      new Promise<void>((resolveDeadline) => { timer = setTimeout(resolveDeadline, Math.max(0, timeoutMs)); }),
    ]);
    if (timer) clearTimeout(timer);
    this.#unsubscribeJobs();
    for (const entry of this.#runs.values()) {
      if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
      entry.checkpointTimer = undefined;
    }
    this.#listeners.clear();
  }

  async #execute(entry: RunEntry, request: StartWorkflowRequest): Promise<WorkflowSnapshot> {
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, request.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    try {
      const sandbox = await runWorkflowSandbox({
        source: request.script,
        args: request.args ?? null,
        cwd: request.cwd,
        signal: entry.controller.signal,
        timeoutMs,
        onPhase: (title) => this.#activatePhase(entry, title),
        onAgent: (prompt, options, signal) => this.#runAgent(entry, request, prompt, options, signal),
      });
      const meta = sandbox.meta && typeof sandbox.meta === "object" && !Array.isArray(sandbox.meta)
        ? sandbox.meta as Record<string, unknown>
        : undefined;
      if (meta?.name !== undefined) entry.snapshot.name = label(meta.name, entry.snapshot.name);
      if (meta?.description !== undefined) entry.snapshot.description = label(meta.description, entry.snapshot.description);
      entry.snapshot.result = sandbox.result;
      entry.snapshot.status = "completed";
      this.#finishPhases(entry, "completed");
      await writeWorkflowResult(this.#artifactRoot, entry.snapshot.runId, sandbox.result);
    } catch (error) {
      const aborted = entry.controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      entry.snapshot.status = aborted ? "aborted" : "failed";
      entry.snapshot.error = boundedText(entry.snapshot.error || error);
      await this.#cancelMemberJobs(entry, entry.snapshot.error);
      this.#finishPhases(entry, entry.snapshot.status);
    } finally {
      const now = Date.now();
      entry.snapshot.timestamps.updatedAt = now;
      entry.snapshot.timestamps.endedAt = now;
      try {
        entry.snapshot.reportArtifact = "report.md";
        await writeWorkflowReport(this.#artifactRoot, entry.snapshot);
        await this.#flushCheckpoint(entry);
      } catch (error) {
        // Artifact failure is a workflow failure, not a rejected lifecycle
        // promise. Foreground cards and background follow-ups must still get
        // exactly one structured terminal result.
        entry.snapshot.status = "failed";
        const detail = `Artifact persistence failed: ${boundedText(error)}`;
        entry.snapshot.error = entry.snapshot.error ? `${entry.snapshot.error}; ${detail}` : detail;
        this.#finishPhases(entry, "failed");
      }
      this.#publish(entry);
    }
    return clone(entry.snapshot);
  }

  async #runAgent(
    entry: RunEntry,
    request: StartWorkflowRequest,
    prompt: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkflowAgentResult> {
    if (!prompt.trim()) return { ok: false, output: "", error: "agent() requires a non-empty prompt" };
    const existingBudgetError = workflowBudgetError(entry.snapshot);
    if (existingBudgetError) return { ok: false, output: "", error: existingBudgetError };
    const role = typeof options.role === "string" ? options.role.trim() : "";
    if (!role) return { ok: false, output: "", error: "agent() requires options.role" };
    const backend = options.backend === undefined ? undefined : String(options.backend) as BackendName;
    if (backend && !BACKENDS.has(backend)) return { ok: false, output: "", error: `Unknown backend: ${backend}` };
    const tierValue = options.modelTier ?? options.tier;
    const tier = tierValue === undefined ? undefined : String(tierValue) as ModelTier;
    if (tier && !TIERS.has(tier)) return { ok: false, output: "", error: `Unknown model tier: ${tier}` };

    const phase = typeof options.phase === "string"
      ? this.#ensurePhase(entry, options.phase)
      : entry.snapshot.currentPhase ?? this.#ensurePhase(entry, "Agents");
    this.#markPhaseRunning(entry, phase);
    const index = entry.snapshot.agents.length;
    const now = Date.now();
    const record: WorkflowAgentRecord = {
      index,
      label: label(options.label, `${role}-${index + 1}`),
      role,
      phase,
      state: "queued",
      timestamps: { createdAt: now, updatedAt: now },
      usage: workflowUsage(),
    };
    entry.snapshot.agents.push(record);
    entry.snapshot.phases[phase]?.agents.push(index);
    this.#touch(entry);

    const schema = options.schema === undefined ? undefined : workflowSchema(options.schema);
    if (options.schema !== undefined && !schema) {
      record.state = "failed";
      record.error = "agent schema must be a bounded JSON Schema object";
      record.timestamps.updatedAt = Date.now();
      record.timestamps.endedAt = record.timestamps.updatedAt;
      this.#touch(entry);
      return { ok: false, output: "", error: record.error };
    }
    const task = schema
      ? `${prompt}\n\nReturn ONLY valid JSON matching this JSON Schema (no markdown fences):\n${JSON.stringify(schema)}`
      : prompt;

    let job: JobSnapshot;
    try {
      job = this.#jobs.spawn({
        role,
        task,
        cwd: request.cwd,
        trusted: request.trusted,
        backend,
        tier,
        depth: request.depth,
        workflow: {
          runId: entry.snapshot.runId,
          agentIndex: index,
          label: record.label,
          phase: entry.snapshot.phases[phase]?.name,
        },
      });
    } catch (error) {
      record.state = "failed";
      record.error = boundedText(error);
      record.timestamps.updatedAt = Date.now();
      record.timestamps.endedAt = record.timestamps.updatedAt;
      this.#touch(entry);
      return { ok: false, output: "", error: record.error };
    }

    record.jobId = job.id;
    record.backend = job.backend;
    record.model = job.model;
    record.timestamps.updatedAt = Date.now();
    this.#jobOwners.set(job.id, { runId: entry.snapshot.runId, agentIndex: index });
    // spawn() may synchronously pump the job to running before ownership is
    // registered, so re-read the authoritative snapshot instead of applying
    // the stale queued value returned to the caller.
    this.#updateAgentFromJob(this.#jobs.check(job.id));

    const abort = () => { void this.#jobs.cancel(job.id, "Workflow agent cancelled").catch(() => undefined); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      const final = await this.#jobs.wait(job.id, { signal });
      this.#updateAgentFromJob(final);
      const budgetError = workflowBudgetError(entry.snapshot);
      if (budgetError) {
        entry.snapshot.error = budgetError;
        entry.controller.abort(new Error(budgetError));
        return { ok: false, output: final.output, jobId: final.id, error: budgetError, usage: clone(final.usage) };
      }
      if (final.status === "completed") {
        if (schema) {
          const structured = parseStructuredOutput(final.output);
          if (structured === undefined || !Check(schema, structured)) {
            record.state = "failed";
            record.error = "Agent output did not match the requested JSON Schema";
            record.timestamps.updatedAt = Date.now();
            record.timestamps.endedAt = record.timestamps.updatedAt;
            record.structured = undefined;
            this.#touch(entry);
            return { ok: false, output: final.output, jobId: final.id, error: record.error, usage: clone(final.usage) };
          }
          record.structured = structured;
          this.#touch(entry);
          return { ok: true, output: final.output, structured, jobId: final.id, usage: clone(final.usage) };
        }
        return { ok: true, output: final.output, jobId: final.id, usage: clone(final.usage) };
      }
      return { ok: false, output: final.output, jobId: final.id, error: final.error ?? `Agent ${final.status}`, usage: clone(final.usage) };
    } catch (error) {
      await this.#jobs.cancel(job.id, "Workflow agent wait aborted").catch(() => undefined);
      const final = this.#jobs.check(job.id);
      this.#updateAgentFromJob(final);
      return { ok: false, output: final.output, jobId: final.id, error: boundedText(error), usage: clone(final.usage) };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  #updateAgentFromJob(job: JobSnapshot): void {
    const owner = this.#jobOwners.get(job.id);
    if (!owner) return;
    const entry = this.#runs.get(owner.runId);
    const agent = entry?.snapshot.agents[owner.agentIndex];
    if (!entry || !agent) return;
    const now = Date.now();
    agent.state = agentState(job);
    agent.backend = job.backend;
    agent.model = job.model;
    agent.preview = job.output.slice(-200);
    agent.output = isTerminal(job.status) ? job.output : undefined;
    agent.transcript = job.transcript.map((item) => ({ ...item }));
    agent.error = job.error;
    agent.usage = workflowUsage(job.usage);
    agent.timestamps.updatedAt = now;
    agent.timestamps.startedAt ??= job.startedAt;
    agent.timestamps.endedAt = job.endedAt;
    this.#touch(entry);
  }

  #ensurePhase(entry: RunEntry, rawTitle: string): number {
    const name = label(rawTitle, "Phase");
    const existing = entry.snapshot.phases.find((phase) => phase.name === name);
    if (existing) return existing.index;
    if (entry.snapshot.phases.length >= MAX_WORKFLOW_PHASES) {
      throw new Error(`Workflow phase limit exceeded (${MAX_WORKFLOW_PHASES})`);
    }
    const now = Date.now();
    const phase: WorkflowPhase = {
      index: entry.snapshot.phases.length,
      name,
      status: "pending",
      timestamps: { createdAt: now, updatedAt: now },
      agents: [],
    };
    entry.snapshot.phases.push(phase);
    return phase.index;
  }

  #markPhaseRunning(entry: RunEntry, index: number): void {
    const phase = entry.snapshot.phases[index];
    if (!phase || phase.status !== "pending") return;
    const now = Date.now();
    phase.status = "running";
    phase.timestamps.startedAt ??= now;
    phase.timestamps.updatedAt = now;
    entry.snapshot.currentPhase ??= index;
    this.#touch(entry);
  }

  #activatePhase(entry: RunEntry, title: string): void {
    const index = this.#ensurePhase(entry, title);
    const now = Date.now();
    const current = entry.snapshot.currentPhase === null ? undefined : entry.snapshot.phases[entry.snapshot.currentPhase];
    if (current && current.index !== index && current.status === "running") {
      current.status = "completed";
      current.timestamps.updatedAt = now;
      current.timestamps.endedAt = now;
    }
    const phase = entry.snapshot.phases[index]!;
    phase.status = "running";
    phase.timestamps.startedAt ??= now;
    phase.timestamps.updatedAt = now;
    entry.snapshot.currentPhase = index;
    this.#touch(entry);
  }

  #finishPhases(entry: RunEntry, status: "completed" | "failed" | "aborted"): void {
    const now = Date.now();
    for (const phase of entry.snapshot.phases) {
      if (phase.status === "completed") continue;
      phase.status = phase.status === "pending" && status === "completed" ? "completed" : status;
      phase.timestamps.updatedAt = now;
      phase.timestamps.endedAt = now;
      if (status !== "completed") phase.error ??= entry.snapshot.error;
    }
  }

  async #cancelMemberJobs(entry: RunEntry, reason: string): Promise<void> {
    const jobs = entry.snapshot.agents
      .map((agent) => agent.jobId)
      .filter((id): id is string => id !== undefined)
      .map((id) => this.#jobs.check(id))
      .filter((job) => !isTerminal(job.status));
    await Promise.allSettled(jobs.map((job) => this.#jobs.cancel(job.id, reason)));
  }

  #touch(entry: RunEntry): void {
    entry.snapshot.timestamps.updatedAt = Date.now();
    this.#publish(entry);
    if (entry.checkpointTimer) return;
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = undefined;
      entry.persistChain = entry.persistChain
        .then(() => checkpointWorkflow(this.#artifactRoot, clone(entry.snapshot)))
        .catch(() => undefined);
    }, CHECKPOINT_DELAY_MS);
    entry.checkpointTimer.unref();
  }

  async #flushCheckpoint(entry: RunEntry): Promise<void> {
    if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = undefined;
    await entry.persistChain.catch(() => undefined);
    await checkpointWorkflow(this.#artifactRoot, clone(entry.snapshot));
  }

  #publish(entry: RunEntry): void {
    const snapshot = clone(entry.snapshot);
    for (const listener of this.#listeners) {
      try { listener(snapshot); } catch { /* observers cannot corrupt lifecycle state */ }
    }
  }

  #evictOldRuns(): void {
    if (this.#runs.size < MAX_RETAINED_RUNS) return;
    const terminal = [...this.#runs.values()]
      .filter((entry) => terminalWorkflow(entry.snapshot.status))
      .sort((left, right) => left.snapshot.timestamps.updatedAt - right.snapshot.timestamps.updatedAt);
    while (this.#runs.size >= MAX_RETAINED_RUNS && terminal.length) {
      this.#runs.delete(terminal.shift()!.snapshot.runId);
    }
    if (this.#runs.size >= MAX_RETAINED_RUNS) throw new Error(`Workflow retention limit reached (${MAX_RETAINED_RUNS})`);
  }
}

export function aggregateWorkflowUsage(snapshot: WorkflowSnapshot): WorkflowUsage {
  return snapshot.agents.reduce((total, agent) => ({
    input: total.input + agent.usage.input,
    output: total.output + agent.usage.output,
    cacheRead: total.cacheRead + agent.usage.cacheRead,
    cacheWrite: total.cacheWrite + agent.usage.cacheWrite,
    cost: total.cost + agent.usage.cost,
    turns: total.turns + agent.usage.turns,
  }), workflowUsage());
}

export function workflowBudgetError(snapshot: WorkflowSnapshot): string | undefined {
  const budget = snapshot.budget;
  if (!budget) return undefined;
  const usage = aggregateWorkflowUsage(snapshot);
  if (budget.maxInputTokens !== undefined && usage.input > budget.maxInputTokens) return `Workflow input-token budget exceeded (${usage.input}/${budget.maxInputTokens})`;
  if (budget.maxOutputTokens !== undefined && usage.output > budget.maxOutputTokens) return `Workflow output-token budget exceeded (${usage.output}/${budget.maxOutputTokens})`;
  if (budget.maxTurns !== undefined && usage.turns > budget.maxTurns) return `Workflow turn budget exceeded (${usage.turns}/${budget.maxTurns})`;
  if (budget.maxCost !== undefined && usage.cost > budget.maxCost) return `Workflow cost budget exceeded ($${usage.cost.toFixed(4)}/$${budget.maxCost.toFixed(4)})`;
  return undefined;
}

function workflowSchema(value: unknown): TSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  const annotations = new Set(["$id", "$schema", "title", "description", "default", "examples", "readOnly", "writeOnly"]);
  const numeric = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const nonnegative = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const seen = new WeakSet<object>();
  let nodes = 0;
  const schema = (current: unknown, depth: number): boolean => {
    if (current === true || current === false) return true;
    if (!current || typeof current !== "object" || Array.isArray(current) || seen.has(current) || ++nodes > 2_000 || depth > 16) return false;
    seen.add(current);
    let constraint = false;
    for (const [key, item] of Object.entries(current)) {
      if (["__proto__", "prototype", "constructor", "$ref", "$dynamicRef"].includes(key)) return false;
      if (annotations.has(key)) {
        if (["$id", "$schema", "title", "description"].includes(key) && typeof item !== "string") return false;
        continue;
      }
      if (key === "type") {
        const values = Array.isArray(item) ? item : [item];
        if (!values.length || !values.every((entry) => typeof entry === "string" && types.has(entry))) return false;
        constraint = true;
      } else if (["properties", "patternProperties", "$defs", "dependentSchemas"].includes(key)) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !Object.values(item).every((entry) => schema(entry, depth + 1))) return false;
        constraint = true;
      } else if (["items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else"].includes(key)) {
        if (!schema(item, depth + 1)) return false;
        constraint = true;
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (!Array.isArray(item) || !item.length || !item.every((entry) => schema(entry, depth + 1))) return false;
        constraint = true;
      } else if (key === "required" || key === "dependentRequired") {
        const valid = key === "required"
          ? Array.isArray(item) && item.every((entry) => typeof entry === "string")
          : !!item && typeof item === "object" && !Array.isArray(item) && Object.values(item).every((entry) => Array.isArray(entry) && entry.every((name) => typeof name === "string"));
        if (!valid) return false;
        constraint = true;
      } else if (key === "enum") {
        if (!Array.isArray(item) || !item.length) return false;
        constraint = true;
      } else if (key === "const") {
        constraint = true;
      } else if (numeric.has(key)) {
        if (typeof item !== "number" || !Number.isFinite(item) || nonnegative.has(key) && (!Number.isInteger(item) || item < 0) || key === "multipleOf" && item <= 0) return false;
        constraint = true;
      } else if (key === "pattern") {
        if (typeof item !== "string") return false;
        try { new RegExp(item); } catch { return false; }
        constraint = true;
      } else if (key === "format") {
        if (typeof item !== "string") return false;
        constraint = true;
      } else if (key === "uniqueItems") {
        if (typeof item !== "boolean") return false;
        constraint = true;
      } else {
        return false;
      }
    }
    seen.delete(current);
    return constraint;
  };
  return schema(value, 0) ? value as TSchema : undefined;
}

function parseStructuredOutput(output: string): unknown {
  const text = output.trim();
  const candidate = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : text;
  try { return JSON.parse(candidate); } catch { return undefined; }
}

export function workflowIsTerminal(status: WorkflowStatus): boolean {
  return terminalWorkflow(status);
}
