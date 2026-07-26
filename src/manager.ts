import { randomUUID } from "node:crypto";
import { compilePolicy } from "./policy.ts";
import { emptyUsage, reduceJob } from "./reducer.ts";
import type { Backend, BackendEvent, BackendRun, JobSnapshot, ProfileDefinition, SendBehavior, SpawnRequest } from "./types.ts";

const GENERIC_SYSTEM_PROMPT = `You are an isolated, task-driven subagent. Work only on the supplied task and return a concise, evidence-based result. You do not have access to parent conversation context beyond the task. Do not spawn subagents or workflows.`;

const PEER_SYSTEM_PROMPT = `You are a read-only session peer: a fork of a saved Pi conversation, opened in the current trusted project so you retain that conversation's full context. Use that retained context to answer clarification questions about it. You have no tools, cannot modify files or any other system, and cannot spawn subagents or workflows. Reply only in this conversation.`;

interface InternalJob {
  snapshot: JobSnapshot;
  profile?: ProfileDefinition;
  request: SpawnRequest;
  policy: ReturnType<typeof compilePolicy>["policy"];
  run?: BackendRun;
  cancelRequested?: string;
  operation?: Promise<void>;
  cancelling?: boolean;
  deferredCancellation?: Extract<BackendEvent, { type: "cancelled" }>;
  runWaiters?: Set<(run?: BackendRun) => void>;
  startupController?: AbortController;
  pendingRestart?: { message: string; behavior: SendBehavior };
  /** Last observer-safe projection, used to reuse unchanged bounded collections on streaming events. */
  publishedSource?: JobSnapshot;
  publishedSnapshot?: JobSnapshot;
}

function clone(snapshot: JobSnapshot, previous?: { source: JobSnapshot; value: JobSnapshot }): JobSnapshot {
  return {
    ...snapshot,
    usage: previous?.source.usage === snapshot.usage ? previous.value.usage : { ...snapshot.usage },
    tools: previous?.source.tools === snapshot.tools ? previous.value.tools : snapshot.tools.map((tool) => ({ ...tool })),
    transcript: previous?.source.transcript === snapshot.transcript
      ? previous.value.transcript
      : snapshot.transcript.map((entry) => ({ ...entry })),
    queuedMessages: previous?.source.queuedMessages === snapshot.queuedMessages
      ? previous.value.queuedMessages
      : snapshot.queuedMessages.map((message) => ({ ...message })),
    workflow: snapshot.workflow ? { ...snapshot.workflow } : undefined,
    peer: snapshot.peer ? { ...snapshot.peer } : undefined,
  };
}

const MAX_RETAINED_JOBS = 100;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;

class OperationDeadlineError extends Error {}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OperationDeadlineError(`${label} timed out after ${timeoutMs}ms`)), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class JobManager {
  readonly #backends: Map<string, Backend>;
  readonly #profiles: Map<string, ProfileDefinition>;
  readonly #jobs = new Map<string, InternalJob>();
  readonly #queue: string[] = [];
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #listeners = new Set<(job: JobSnapshot, event: BackendEvent) => void>();
  readonly #launches = new Set<Promise<void>>();
  readonly #concurrency: number;
  readonly #startupTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  #active = 0;
  #closed = false;

  constructor(options: {
    backends: Backend[];
    profiles?: Map<string, ProfileDefinition>;
    concurrency?: number;
    startupTimeoutMs?: number;
    operationTimeoutMs?: number;
  }) {
    this.#backends = new Map(options.backends.map((backend) => [backend.name, backend]));
    this.#profiles = options.profiles ?? new Map();
    this.#concurrency = Math.max(1, Math.min(4, options.concurrency ?? 4));
    this.#startupTimeoutMs = Math.max(1, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    this.#operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
  }

  spawn(request: SpawnRequest): JobSnapshot {
    if (this.#closed) throw new Error("Job manager is closed");
    if (!request.task.trim()) throw new Error("Task must not be empty");
    const profileName = request.profile?.trim();
    if (request.profile !== undefined && !profileName) throw new Error("Profile must be a non-empty string");
    const independentOf = request.independentOf?.trim();
    if (request.independentOf !== undefined && (!independentOf || independentOf.length > 200)) {
      throw new Error("independentOf must be a job ID containing 1–200 characters");
    }
    const profile = profileName ? this.#profiles.get(profileName) : undefined;
    if (profileName && !profile) throw new Error(`Unknown subagent profile: ${profileName}`);
    const independenceTarget = independentOf ? this.#jobs.get(independentOf) : undefined;
    const replayProvider = request.independentOfProvider;
    if (replayProvider !== undefined && replayProvider !== "claude" && replayProvider !== "codex") {
      throw new Error("independentOfProvider must identify native Claude or Codex");
    }
    if (replayProvider !== undefined && !independentOf) throw new Error("independentOfProvider requires independentOf");
    if (independentOf && !independenceTarget && !replayProvider) throw new Error(`Unknown independence target job: ${independentOf}`);
    const targetHarness = independenceTarget?.snapshot.harness;
    if (targetHarness === "pi") {
      throw new Error("independentOf requires a target job using the native Claude or Codex harness");
    }
    const retainedProvider = targetHarness === "claude" || targetHarness === "codex" ? targetHarness : undefined;
    if (retainedProvider && replayProvider && retainedProvider !== replayProvider) {
      throw new Error("independentOfProvider does not match the retained independence target");
    }
    const independentOfProvider = retainedProvider ?? replayProvider;
    const compiled = compilePolicy(request, profile, independentOfProvider);
    if (!this.#backends.has(compiled.policy.harness)) throw new Error(`Harness is unavailable: ${compiled.policy.harness}`);
    if (request.peer) {
      if (compiled.policy.harness !== "pi") throw new Error("Session peers require the pi harness");
      if (compiled.independent) throw new Error("Session peers cannot be independent");
    }
    // Session peers are clarification-only: force read-only access and strip every tool,
    // regardless of what the generic readOnly policy would otherwise grant.
    const policy = request.peer ? { ...compiled.policy, access: "readOnly" as const, piTools: [] } : compiled.policy;
    const independent = compiled.independent;
    this.#evictOldJobs();
    const id = randomUUID();
    const name = request.name?.replace(/\s+/g, " ").trim().slice(0, 160) || `agent-${id.slice(0, 8)}`;
    const snapshot: JobSnapshot = {
      id,
      name,
      access: policy.access,
      profile: profile?.name,
      independent,
      independentOf,
      harness: policy.harness,
      model: policy.model ?? "default",
      effort: policy.effort,
      task: request.task,
      cwd: request.cwd,
      status: "queued",
      generation: 0,
      createdAt: Date.now(),
      output: "",
      truncated: false,
      usage: emptyUsage(),
      tools: [],
      transcript: [],
      liveThinking: "",
      queuedMessages: [],
      workflow: request.workflow ? { ...request.workflow } : undefined,
      sessionFile: request.peer?.sessionFile,
      peer: request.peer
        ? { sourceSessionId: request.peer.sourceSessionId, sourceCwd: request.peer.sourceCwd, sourceName: request.peer.sourceName }
        : undefined,
    };
    this.#jobs.set(id, { snapshot, profile, request, policy });
    this.#queue.push(id);
    this.#pump();
    return clone(snapshot);
  }

  check(id: string): JobSnapshot {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return clone(job.snapshot);
  }

  list(): JobSnapshot[] {
    return [...this.#jobs.values()].map((job) => clone(job.snapshot)).sort((a, b) => a.createdAt - b.createdAt);
  }

  subscribe(listener: (job: JobSnapshot, event: BackendEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(id: string, message: string, behavior: SendBehavior = "steer"): Promise<JobSnapshot> {
    if (!message.trim()) throw new Error("Subagent message must not be empty");
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    if (job.snapshot.workflow) {
      throw new Error(`Cannot send to ${id}: workflow-owned agents are controlled by their workflow; inspect or cancel them instead`);
    }
    if (job.snapshot.status === "failed" || job.snapshot.status === "cancelled") {
      throw new Error(`Cannot reuse ${id}: job is ${job.snapshot.status}`);
    }
    if (job.snapshot.status === "completed") {
      if (!job.run) throw new Error(`Cannot reuse ${id}: native session is no longer available`);
      if (job.pendingRestart) throw new Error(`Cannot reuse ${id}: a follow-up is already queued`);
      job.pendingRestart = { message, behavior: "followUp" };
      job.snapshot = {
        ...job.snapshot,
        status: "queued",
        generation: job.snapshot.generation + 1,
        endedAt: undefined,
        error: undefined,
        output: "",
        truncated: false,
        tools: [],
        liveThinking: "",
        queuedMessages: [{ text: message, behavior: "followUp" }],
      };
      this.#queue.push(id);
      this.#publish(job, { type: "queue_changed", messages: job.snapshot.queuedMessages });
      this.#pump();
      return clone(job.snapshot);
    }
    const run = job.run ?? await new Promise<BackendRun | undefined>((resolve) => {
      const waiters = job.runWaiters ??= new Set();
      const ready = (value?: BackendRun) => { clearTimeout(timer); waiters.delete(ready); resolve(value); };
      const timer = setTimeout(() => ready(undefined), 30_000);
      waiters.add(ready);
    });
    if (!run) throw new Error(`Cannot send to ${id}: harness did not become ready`);
    await this.#serialize(job, async () => {
      if (job.cancelRequested || isTerminal(job.snapshot.status) || job.run !== run) {
        throw new Error(`Cannot send to ${id}: job is cancelling or settled`);
      }
      await run.send(message, behavior);
    });
    return clone(job.snapshot);
  }

  async wait(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JobSnapshot> {
    const current = this.check(id);
    if (isTerminal(current.status)) return current;
    return new Promise<JobSnapshot>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        cleanup();
        resolve(this.check(id));
      };
      const abort = () => {
        cleanup();
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Wait aborted"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        this.#waiters.get(id)?.delete(finish);
      };
      const set = this.#waiters.get(id) ?? new Set<() => void>();
      set.add(finish);
      this.#waiters.set(id, set);
      if (options.timeoutMs !== undefined) timer = setTimeout(() => { cleanup(); resolve(this.check(id)); }, options.timeoutMs);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async cancel(id: string, reason = "Cancelled by parent"): Promise<JobSnapshot> {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    if (isTerminal(job.snapshot.status)) return clone(job.snapshot);
    if (job.snapshot.status === "queued") {
      const index = this.#queue.indexOf(id);
      if (index >= 0) this.#queue.splice(index, 1);
      job.pendingRestart = undefined;
      this.#emit(job, { type: "cancelled", reason });
      if (job.run) {
        await this.#serialize(job, () => job.run!.close()).catch(() => undefined);
        job.run = undefined;
      }
    } else {
      job.cancelRequested ??= reason;
      job.startupController?.abort(new Error(job.cancelRequested));
      const run = job.run ?? await this.#waitForRun(job, this.#operationTimeoutMs);
      if (run) {
        try {
          await withDeadline(this.#cancelRun(job, run, job.cancelRequested), this.#operationTimeoutMs, "Harness cancellation");
        } catch (error) {
          if (!(error instanceof OperationDeadlineError)) throw error;
          await withDeadline(run.forceClose?.() ?? run.close(), Math.min(1_000, this.#operationTimeoutMs), "Harness force-close").catch(() => undefined);
          if (!isTerminal(job.snapshot.status)) this.#emit(job, { type: "cancelled", reason: `${job.cancelRequested} (harness cancellation deadline exceeded)` });
        }
      } else if (!isTerminal(job.snapshot.status)) {
        this.#emit(job, { type: "cancelled", reason: `${job.cancelRequested} (harness startup cancellation deadline exceeded)` });
      }
    }
    return clone(job.snapshot);
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const operations: Promise<unknown>[] = [];
    for (const job of this.#jobs.values()) {
      operations.push((async () => {
        if (!isTerminal(job.snapshot.status)) await this.cancel(job.snapshot.id, "Session shutdown");
        const run = job.run;
        if (run) await this.#serialize(job, () => run.close());
      })());
    }
    operations.push(...this.#launches);
    let timer: NodeJS.Timeout | undefined;
    let deadlineHit = false;
    await Promise.race([
      Promise.allSettled(operations).then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(() => { deadlineHit = true; resolve(); }, Math.max(0, timeoutMs)); }),
    ]);
    if (timer) clearTimeout(timer);
    if (deadlineHit) {
      const forced = [...this.#jobs.values()].map((job) => job.run?.forceClose?.()).filter((value): value is Promise<void> => value !== undefined);
      let forceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(forced).then(() => undefined),
        new Promise<void>((resolve) => { forceTimer = setTimeout(resolve, 1_000); }),
      ]);
      if (forceTimer) clearTimeout(forceTimer);
      for (const job of this.#jobs.values()) {
        if (!isTerminal(job.snapshot.status)) this.#emit(job, { type: "cancelled", reason: "Session shutdown deadline exceeded" });
      }
    }
    for (const job of this.#jobs.values()) this.#resolveRunWaiters(job);
    this.#listeners.clear();
  }

  #waitForRun(job: InternalJob, timeoutMs: number): Promise<BackendRun | undefined> {
    if (job.run) return Promise.resolve(job.run);
    return new Promise<BackendRun | undefined>((resolve) => {
      const waiters = job.runWaiters ??= new Set();
      const ready = (run?: BackendRun) => {
        clearTimeout(timer);
        waiters.delete(ready);
        resolve(run);
      };
      const timer = setTimeout(() => ready(undefined), Math.max(0, timeoutMs));
      waiters.add(ready);
    });
  }

  #evictOldJobs(): void {
    if (this.#jobs.size < MAX_RETAINED_JOBS) return;
    const terminal = [...this.#jobs.values()]
      .filter((job) => isTerminal(job.snapshot.status))
      .sort((a, b) => (a.snapshot.endedAt ?? a.snapshot.createdAt) - (b.snapshot.endedAt ?? b.snapshot.createdAt));
    while (this.#jobs.size >= MAX_RETAINED_JOBS && terminal.length > 0) {
      const job = terminal.shift()!;
      if (job.run) void job.run.close().catch(() => undefined);
      this.#jobs.delete(job.snapshot.id);
      this.#waiters.delete(job.snapshot.id);
    }
    if (this.#jobs.size >= MAX_RETAINED_JOBS) throw new Error(`Job retention limit reached (${MAX_RETAINED_JOBS}); wait for or cancel existing jobs`);
  }

  #pump(): void {
    while (!this.#closed && this.#active < this.#concurrency && this.#queue.length > 0) {
      // Interactive/direct work gets the next available slot instead of
      // sitting behind a workflow's entire fan-out. Workflows still use every
      // idle slot when no direct job is waiting.
      const directIndex = this.#queue.findIndex((id) => {
        const candidate = this.#jobs.get(id);
        return candidate?.snapshot.status === "queued" && !candidate.snapshot.workflow;
      });
      const [id] = this.#queue.splice(directIndex >= 0 ? directIndex : 0, 1);
      const job = id ? this.#jobs.get(id) : undefined;
      if (!job || job.snapshot.status !== "queued") continue;
      this.#active++;
      const launch = job.run && job.pendingRestart ? this.#restart(job) : this.#launch(job);
      this.#launches.add(launch);
      void launch.finally(() => this.#launches.delete(launch));
    }
  }

  async #launch(job: InternalJob): Promise<void> {
    const backend = this.#backends.get(job.policy.harness)!;
    const startupController = new AbortController();
    job.startupController = startupController;
    this.#emit(job, { type: "started" });
    try {
      const basePrompt = job.request.peer ? PEER_SYSTEM_PROMPT : GENERIC_SYSTEM_PROMPT;
      const systemPrompt = [basePrompt, job.profile?.systemPrompt].filter(Boolean).join("\n\n");
      const startup = backend.start({
        jobId: job.snapshot.id,
        name: job.snapshot.name,
        task: job.request.task,
        systemPrompt,
        cwd: job.request.cwd,
        policy: job.policy,
        env: process.env,
        signal: startupController.signal,
        resumeSessionFile: job.request.peer?.sessionFile,
        rawInitialMessage: job.request.peer ? true : undefined,
      }, (event) => this.#handleBackendEvent(job, event));
      let startedRun: BackendRun;
      try {
        startedRun = await withDeadline(startup, this.#startupTimeoutMs, "Harness startup");
      } catch (error) {
        if (error instanceof OperationDeadlineError) {
          startupController.abort(error);
          void startup.then((lateRun) => (lateRun.forceClose?.() ?? lateRun.close()).catch(() => undefined), () => undefined);
        }
        throw error;
      }
      if (this.#closed || this.#jobs.get(job.snapshot.id) !== job) {
        await (startedRun.forceClose?.() ?? startedRun.close()).catch(() => undefined);
        return;
      }
      job.run = startedRun;
      job.startupController = undefined;
      this.#resolveRunWaiters(job, job.run);
      if (job.cancelRequested && isTerminal(job.snapshot.status)) {
        await (job.run.forceClose?.() ?? job.run.close());
        return;
      }
      if (job.cancelRequested) await this.#cancelRun(job, job.run, job.cancelRequested);
      await job.run.completed;
      if (!isTerminal(job.snapshot.status) && !job.cancelRequested) this.#emit(job, { type: "completed" });
    } catch (error) {
      if (!isTerminal(job.snapshot.status)) {
        const startupTimedOut = startupController.signal.reason instanceof OperationDeadlineError;
        if (job.cancelRequested || startupController.signal.aborted && !startupTimedOut) {
          this.#emit(job, { type: "cancelled", reason: job.cancelRequested ?? "Harness startup aborted" });
        } else this.#emit(job, { type: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      job.startupController = undefined;
      this.#resolveRunWaiters(job);
      const run = job.run;
      if (job.snapshot.status !== "completed" || !run || job.cancelRequested || job.snapshot.workflow) {
        if (run) await this.#serialize(job, () => run.close()).catch(() => undefined);
        job.run = undefined;
      }
      this.#active--;
      this.#pump();
    }
  }

  async #restart(job: InternalJob): Promise<void> {
    const run = job.run;
    const pending = job.pendingRestart;
    job.pendingRestart = undefined;
    if (!run || !pending) {
      this.#emit(job, { type: "failed", error: "Native session is no longer available" });
      this.#active--;
      this.#pump();
      return;
    }
    try {
      this.#emit(job, { type: "started" });
      await this.#serialize(job, () => run.send(pending.message, pending.behavior));
      await this.#waitForTerminal(job);
    } catch (error) {
      if (!isTerminal(job.snapshot.status)) this.#emit(job, { type: "failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (job.snapshot.status !== "completed" || job.run !== run || job.snapshot.workflow) {
        await this.#serialize(job, () => run.close()).catch(() => undefined);
        if (job.run === run) job.run = undefined;
      }
      this.#active--;
      this.#pump();
    }
  }

  #waitForTerminal(job: InternalJob): Promise<void> {
    if (isTerminal(job.snapshot.status)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = () => resolve();
      const set = this.#waiters.get(job.snapshot.id) ?? new Set<() => void>();
      set.add(waiter);
      this.#waiters.set(job.snapshot.id, set);
    });
  }

  #handleBackendEvent(job: InternalJob, event: BackendEvent): void {
    if (job.cancelRequested && event.type === "completed") return;
    if (job.cancelling && event.type === "cancelled") {
      job.deferredCancellation = event;
      return;
    }
    this.#emit(job, event);
  }

  async #cancelRun(job: InternalJob, run: BackendRun, reason: string): Promise<void> {
    await this.#serialize(job, async () => {
      if (isTerminal(job.snapshot.status) || job.run !== run) return;
      job.cancelling = true;
      try {
        await run.cancel(reason);
      } catch (error) {
        job.deferredCancellation = undefined;
        this.#emit(job, { type: "failed", error: `Harness cancellation failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      } finally {
        job.cancelling = false;
      }
      if (!isTerminal(job.snapshot.status)) this.#emit(job, job.deferredCancellation ?? { type: "cancelled", reason });
      job.deferredCancellation = undefined;
    });
  }

  #serialize<T>(job: InternalJob, operation: () => Promise<T>): Promise<T> {
    const current = (job.operation ?? Promise.resolve()).catch(() => undefined).then(operation);
    job.operation = current.then(() => undefined, () => undefined);
    return current;
  }

  #emit(job: InternalJob, event: BackendEvent): void {
    if (isTerminal(job.snapshot.status)) return;
    job.snapshot = reduceJob(job.snapshot, event);
    this.#publish(job, event);
    if (isTerminal(job.snapshot.status)) {
      this.#resolveRunWaiters(job);
      for (const waiter of this.#waiters.get(job.snapshot.id) ?? []) waiter();
      this.#waiters.delete(job.snapshot.id);
    }
  }

  #publish(job: InternalJob, event: BackendEvent): void {
    const source = job.snapshot;
    const snapshot = clone(source, job.publishedSource && job.publishedSnapshot
      ? { source: job.publishedSource, value: job.publishedSnapshot }
      : undefined);
    job.publishedSource = source;
    job.publishedSnapshot = snapshot;
    for (const listener of this.#listeners) {
      try { listener(snapshot, event); } catch { /* observers cannot break lifecycle */ }
    }
  }

  #resolveRunWaiters(job: InternalJob, run?: BackendRun): void {
    for (const waiter of job.runWaiters ?? []) waiter(run);
    job.runWaiters?.clear();
  }
}

export function isTerminal(status: JobSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
