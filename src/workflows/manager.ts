import { resolve } from "node:path";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { JobManager } from "../manager.ts";
import { isTerminal } from "../manager.ts";
import type { AccessMode, BackendEvent, BackendName, EffortLevel, JobSnapshot, ModelTier, ProviderFamily, Usage } from "../types.ts";
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
  WorkflowPhase,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowUsage,
} from "./types.ts";

const BACKENDS = new Set<BackendName>(["pi", "claude", "codex"]);
const TIERS = new Set<ModelTier>(["economy", "balanced", "quality"]);
const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
const ACCESS = new Set<AccessMode>(["readOnly", "full"]);
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
  cwd: string;
  trusted: boolean;
  parentProvider?: ProviderFamily;
  defaultBackend?: BackendName;
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
  readonly #sessionId: string;
  readonly #runs = new Map<string, RunEntry>();
  readonly #jobOwners = new Map<string, { runId: string; agentIndex: number }>();
  readonly #listeners = new Set<(snapshot: WorkflowSnapshot) => void>();
  readonly #unsubscribeJobs: () => void;
  #initializing?: Promise<void>;
  #closed = false;

  constructor(options: { jobs: JobManager; artifactRoot: string; sessionId: string }) {
    this.#jobs = options.jobs;
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#sessionId = options.sessionId;
    this.#unsubscribeJobs = this.#jobs.subscribe((job, event) => this.#updateAgentFromJob(job, event));
  }

  async initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      const restored = await loadWorkflowSummaries(this.#artifactRoot, { staleAfterMs: 0, sessionId: this.#sessionId });
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
    const snapshot = clone(entry.snapshot);
    snapshot.agents = snapshot.agents.map((agent) => this.#projectAgent(agent));
    return snapshot;
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

  async cancelAgent(runId: string, agentIndex: number, reason = "Workflow agent cancelled by user"): Promise<WorkflowSnapshot> {
    const entry = this.#runs.get(runId);
    if (!entry) throw new Error(`Unknown workflow: ${runId}`);
    const agent = entry.snapshot.agents.find((candidate) => candidate.index === agentIndex);
    if (!agent) throw new Error(`Unknown workflow agent: ${agentIndex}`);
    if (!agent.jobId) throw new Error(`Workflow agent ${agent.name} has not started`);
    if (["completed", "failed", "cancelled", "aborted"].includes(agent.state)) return this.check(runId);
    await this.#jobs.cancel(agent.jobId, reason);
    return this.check(runId);
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
    try {
      const sandbox = await runWorkflowSandbox({
        source: request.script,
        args: request.args ?? null,
        cwd: request.cwd,
        signal: entry.controller.signal,
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
    if (["role", "agent", "tier", "modelProfile"].some((key) => Object.hasOwn(options, key))) {
      return { ok: false, output: "", error: "Legacy workflow role, agent, tier, and modelProfile options are not supported" };
    }
    const backend = options.backend === undefined ? undefined : String(options.backend) as BackendName;
    if (backend && !BACKENDS.has(backend)) return { ok: false, output: "", error: `Unknown backend: ${backend}` };
    const tier = options.modelTier === undefined ? undefined : String(options.modelTier) as ModelTier;
    if (tier && !TIERS.has(tier)) return { ok: false, output: "", error: `Unknown model tier: ${tier}` };
    const effortValue = options.effort;
    const effort = effortValue === undefined ? undefined : String(effortValue) as EffortLevel;
    if (effort && !EFFORTS.has(effort)) return { ok: false, output: "", error: `Unknown effort: ${effort}` };
    const access = options.access === undefined ? undefined : String(options.access) as AccessMode;
    if (access && !ACCESS.has(access)) return { ok: false, output: "", error: `Unknown access: ${access}` };
    if (options.independent !== undefined && typeof options.independent !== "boolean") return { ok: false, output: "", error: "independent must be boolean" };
    if (options.profile !== undefined && (typeof options.profile !== "string" || !options.profile.trim())) return { ok: false, output: "", error: "profile must be a non-empty string" };

    const phase = typeof options.phase === "string"
      ? this.#ensurePhase(entry, options.phase)
      : entry.snapshot.currentPhase ?? this.#ensurePhase(entry, "Agents");
    this.#markPhaseRunning(entry, phase);
    const index = entry.snapshot.agents.length;
    const name = label(options.name ?? options.label, `agent-${index + 1}`);
    const now = Date.now();
    const record: WorkflowAgentRecord = {
      index,
      name,
      access: access ?? "full",
      profile: typeof options.profile === "string" ? options.profile.trim() : undefined,
      independent: options.independent === true,
      phase,
      state: "queued",
      timestamps: { createdAt: now, updatedAt: now },
      prompt: boundedText(prompt, 2 * 1024),
      effort,
      tools: [],
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
        name,
        task,
        cwd: request.cwd,
        trusted: request.trusted,
        backend,
        modelTier: tier,
        effort,
        access,
        independent: options.independent === true,
        profile: record.profile,
        defaultBackend: request.defaultBackend,
        parentProvider: request.parentProvider,
        workflow: {
          runId: entry.snapshot.runId,
          agentIndex: index,
          label: record.name,
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
    record.name = job.name;
    record.access = job.access;
    record.profile = job.profile;
    record.independent = job.independent;
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

  #projectAgent(agent: WorkflowAgentRecord): WorkflowAgentRecord {
    if (!agent.jobId || ["completed", "failed", "cancelled", "aborted"].includes(agent.state)) return agent;
    let job: JobSnapshot;
    try { job = this.#jobs.check(agent.jobId); }
    catch { return agent; }
    return {
      ...agent,
      name: job.name,
      access: job.access,
      profile: job.profile,
      independent: job.independent,
      state: agentState(job),
      backend: job.backend,
      model: job.model,
      effort: job.effort,
      preview: job.output.slice(-500),
      output: isTerminal(job.status) ? job.output : agent.output,
      transcript: job.transcript.map((item) => ({ ...item })),
      tools: job.tools.slice(-8).map((tool) => ({ ...tool })),
      liveThinking: job.liveThinking,
      truncated: job.truncated,
      error: job.error,
      usage: workflowUsage(job.usage),
      timestamps: {
        ...agent.timestamps,
        updatedAt: Date.now(),
        startedAt: agent.timestamps.startedAt ?? job.startedAt,
        endedAt: job.endedAt,
      },
    };
  }

  #updateAgentFromJob(job: JobSnapshot, event: BackendEvent = { type: "started" }): void {
    const owner = this.#jobOwners.get(job.id);
    if (!owner) return;
    const entry = this.#runs.get(owner.runId);
    const agent = entry?.snapshot.agents[owner.agentIndex];
    if (!entry || !agent) return;

    // Streaming deltas stay authoritative in JobManager and are projected by check().
    // Persisting and cloning the full workflow on every token is both redundant and quadratic.
    if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "queue_changed") return;

    const now = Date.now();
    agent.state = agentState(job);
    agent.name = job.name;
    agent.access = job.access;
    agent.profile = job.profile;
    agent.independent = job.independent;
    agent.backend = job.backend;
    agent.model = job.model;
    agent.effort = job.effort;
    agent.preview = job.output.slice(-500);
    agent.error = job.error;
    agent.usage = workflowUsage(job.usage);
    agent.timestamps.updatedAt = now;
    agent.timestamps.startedAt ??= job.startedAt;
    agent.timestamps.endedAt = job.endedAt;

    if (event.type === "user_message" || event.type === "thinking_message" || event.type === "message"
        || event.type === "tool_start" || event.type === "tool_end" || isTerminal(job.status)) {
      agent.transcript = job.transcript.map((item) => ({ ...item }));
      agent.tools = job.tools.slice(-8).map((tool) => ({ ...tool }));
      agent.truncated = job.truncated;
    }
    if (isTerminal(job.status)) agent.output = job.output;
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
