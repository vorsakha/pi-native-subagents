import { randomUUID } from "node:crypto";
import { childDelegationEnv } from "./env.ts";
import { compilePolicy } from "./policy.ts";
import { emptyUsage, reduceJob } from "./reducer.ts";
import type { Backend, BackendEvent, BackendRun, JobSnapshot, RoleDefinition, SendBehavior, SpawnRequest } from "./types.ts";

interface InternalJob {
  snapshot: JobSnapshot;
  role: RoleDefinition;
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
  idleTimer?: NodeJS.Timeout;
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
  };
}

const MAX_RETAINED_JOBS = 100;
const REUSABLE_SESSION_TTL_MS = 15 * 60_000;

export class JobManager {
  readonly #backends: Map<string, Backend>;
  readonly #roles: Map<string, RoleDefinition>;
  readonly #jobs = new Map<string, InternalJob>();
  readonly #queue: string[] = [];
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #listeners = new Set<(job: JobSnapshot, event: BackendEvent) => void>();
  readonly #launches = new Set<Promise<void>>();
  readonly #concurrency: number;
  readonly #maxDepth: number;
  #active = 0;
  #closed = false;

  constructor(options: { backends: Backend[]; roles: Map<string, RoleDefinition>; concurrency?: number; maxDepth?: number }) {
    this.#backends = new Map(options.backends.map((backend) => [backend.name, backend]));
    this.#roles = options.roles;
    this.#concurrency = Math.max(1, Math.min(4, options.concurrency ?? 4));
    this.#maxDepth = options.maxDepth ?? 2;
  }

  spawn(request: SpawnRequest): JobSnapshot {
    if (this.#closed) throw new Error("Job manager is closed");
    if (!request.task.trim()) throw new Error("Task must not be empty");
    const role = this.#roles.get(request.role);
    if (!role) throw new Error(`Unknown subagent role: ${request.role}`);
    const { policy } = compilePolicy(role, request, this.#maxDepth);
    if (!this.#backends.has(policy.backend)) throw new Error(`Backend is unavailable: ${policy.backend}`);
    this.#evictOldJobs();
    const id = randomUUID();
    const snapshot: JobSnapshot = {
      id,
      role: role.name,
      backend: policy.backend,
      model: policy.model,
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
    };
    this.#jobs.set(id, { snapshot, role, request, policy });
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
      if (!job.run) throw new Error(`Cannot reuse ${id}: native session retention expired`);
      if (job.pendingRestart) throw new Error(`Cannot reuse ${id}: a follow-up is already queued`);
      if (job.idleTimer) clearTimeout(job.idleTimer);
      job.idleTimer = undefined;
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
    if (!run) throw new Error(`Cannot send to ${id}: backend did not become ready`);
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
      const run = job.run ?? await new Promise<BackendRun | undefined>((resolve) => {
        const waiters = job.runWaiters ??= new Set();
        waiters.add(resolve);
      });
      if (run) await this.#cancelRun(job, run, job.cancelRequested);
      else if (!isTerminal(job.snapshot.status)) this.#emit(job, { type: "cancelled", reason: job.cancelRequested });
    }
    return clone(job.snapshot);
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const operations: Promise<unknown>[] = [];
    for (const job of this.#jobs.values()) {
      if (job.idleTimer) clearTimeout(job.idleTimer);
      job.idleTimer = undefined;
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

  #evictOldJobs(): void {
    if (this.#jobs.size < MAX_RETAINED_JOBS) return;
    const terminal = [...this.#jobs.values()]
      .filter((job) => isTerminal(job.snapshot.status))
      .sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt);
    while (this.#jobs.size >= MAX_RETAINED_JOBS && terminal.length > 0) {
      const job = terminal.shift()!;
      if (job.idleTimer) clearTimeout(job.idleTimer);
      if (job.run) void job.run.close().catch(() => undefined);
      this.#jobs.delete(job.snapshot.id);
      this.#waiters.delete(job.snapshot.id);
    }
    if (this.#jobs.size >= MAX_RETAINED_JOBS) throw new Error(`Job retention limit reached (${MAX_RETAINED_JOBS}); wait for or cancel existing jobs`);
  }

  #pump(): void {
    while (!this.#closed && this.#active < this.#concurrency && this.#queue.length > 0) {
      const id = this.#queue.shift();
      const job = id ? this.#jobs.get(id) : undefined;
      if (!job || job.snapshot.status !== "queued") continue;
      this.#active++;
      const launch = job.run && job.pendingRestart ? this.#restart(job) : this.#launch(job);
      this.#launches.add(launch);
      void launch.finally(() => this.#launches.delete(launch));
    }
  }

  async #launch(job: InternalJob): Promise<void> {
    const backend = this.#backends.get(job.policy.backend)!;
    const startupController = new AbortController();
    job.startupController = startupController;
    this.#emit(job, { type: "started" });
    try {
      const env = childDelegationEnv(process.env, job.policy.depth, job.policy.nestedAgents);
      job.run = await backend.start({
        jobId: job.snapshot.id,
        role: job.role.name,
        task: job.request.task,
        systemPrompt: job.role.systemPrompt,
        cwd: job.request.cwd,
        policy: job.policy,
        env,
        signal: startupController.signal,
      }, (event) => this.#handleBackendEvent(job, event));
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
        if (job.cancelRequested || startupController.signal.aborted) this.#emit(job, { type: "cancelled", reason: job.cancelRequested ?? "Backend startup aborted" });
        else this.#emit(job, { type: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      job.startupController = undefined;
      this.#resolveRunWaiters(job);
      const run = job.run;
      if (job.snapshot.status === "completed" && run && !job.cancelRequested && !job.snapshot.workflow) {
        this.#scheduleIdleClose(job, run);
      } else {
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
      if (job.snapshot.status === "completed" && job.run === run && !job.snapshot.workflow) this.#scheduleIdleClose(job, run);
      else {
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

  #scheduleIdleClose(job: InternalJob, run: BackendRun): void {
    if (job.idleTimer) clearTimeout(job.idleTimer);
    job.idleTimer = setTimeout(() => {
      job.idleTimer = undefined;
      if (job.run !== run || job.snapshot.status !== "completed") return;
      void this.#serialize(job, () => run.close()).finally(() => {
        if (job.run === run) job.run = undefined;
      });
    }, REUSABLE_SESSION_TTL_MS);
    job.idleTimer.unref();
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
        this.#emit(job, { type: "failed", error: `Backend cancellation failed: ${error instanceof Error ? error.message : String(error)}` });
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
