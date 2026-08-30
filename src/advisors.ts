import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { firstReachedSpendWarning, validateSpendBudget, type SpendBudget } from "./budget.ts";
import type { JobManager } from "./manager.ts";
import { emptyUsage } from "./reducer.ts";
import type {
  EffortLevel,
  HarnessName,
  JobCapabilityRoute,
  NativeContinuation,
  Usage,
} from "./types.ts";

export const MAX_ADVISORS_PER_THREAD = 16;
export const MAX_ADVISOR_QUEUE = 8;
export const MAX_ADVISOR_LEDGER = 32;
export const MAX_ADVISOR_CONTEXT_BYTES = 16 * 1024;
export const MAX_ADVISOR_PROFILE_PROMPT_BYTES = 64 * 1024;
export const DEFAULT_ADVISOR_IDLE_MS = 10 * 60_000;

export type AdvisorState = "defined" | "consulting" | "idle" | "hibernated" | "unavailable" | "closed";
export type AdvisorSender = "human" | "orchestrator" | "workflow";

export interface AdvisorPolicy {
  cwd: string;
  trusted: true;
  harness: HarnessName;
  model?: string;
  effort?: EffortLevel;
  profile?: string;
  requires: string[];
  capabilityRoute?: JobCapabilityRoute;
  budget?: SpendBudget;
}

export interface AdvisorLedgerEntry {
  index: number;
  lineage: number;
  generation: number;
  sender: AdvisorSender | "system";
  question: string;
  context?: string;
  state: "completed" | "failed" | "cancelled" | "reset";
  output?: string;
  error?: string;
  usage?: Usage;
  startedAt: number;
  endedAt: number;
  workflow?: { runId: string; phase?: string; callIndex: number };
}

export interface AdvisorSnapshot {
  id: string;
  threadId: string;
  name: string;
  aliases: string[];
  description: string;
  state: AdvisorState;
  policy: AdvisorPolicy;
  lineage: number;
  generation: number;
  usage: Usage;
  createdAt: number;
  updatedAt: number;
  lastConsultedAt?: number;
  queued: number;
  ledger: AdvisorLedgerEntry[];
  error?: string;
}

export interface AdvisorOpenRequest {
  threadId: string;
  name: string;
  aliases?: string[];
  description: string;
  cwd: string;
  trusted: boolean;
  harness?: HarnessName | "auto";
  requires?: string[];
  model?: string;
  effort?: EffortLevel;
  profile?: string;
  budget?: SpendBudget;
  signal?: AbortSignal;
}

export interface AdvisorConsultRequest {
  threadId: string;
  advisorId: string;
  question: string;
  sender: AdvisorSender;
  trusted: boolean;
  context?: string;
  decisions?: string[];
  signal?: AbortSignal;
  retryUnavailable?: boolean;
  requiredLineage?: number;
  workflow?: { runId: string; phase?: string; callIndex: number };
}

export interface AdvisorConsultResult {
  ok: boolean;
  advisorId: string;
  advisorName: string;
  lineage: number;
  generation?: number;
  output: string;
  error?: string;
  usage?: Usage;
  route: { harness: HarnessName; model?: string };
  queuedMs: number;
}

export interface AdvisorRouteResolution {
  harness: HarnessName;
  requires: string[];
  capabilityRoute?: JobCapabilityRoute;
  effort?: EffortLevel;
  profileBinding?: AdvisorProfileBinding;
}

export interface AdvisorProfileBinding {
  name: string;
  systemPrompt: string;
}

export interface AdvisorRouteResolver {
  resolve(request: AdvisorOpenRequest, expectedHarness: HarnessName | undefined): Promise<AdvisorRouteResolution>;
}

interface StoredAdvisor extends Omit<AdvisorSnapshot, "queued"> {
  continuation?: NativeContinuation;
  profileBinding?: AdvisorProfileBinding;
  /** Set only while normalizing a malformed private continuation from disk. */
  invalidContinuation?: true;
}

interface AdvisorStorePayload {
  version: 1;
  threadId: string;
  advisors: StoredAdvisor[];
}

export interface AdvisorStore {
  load(threadId: string): Promise<StoredAdvisor[]>;
  save(threadId: string, advisors: StoredAdvisor[]): Promise<void>;
}

/** Extension-private, mode-0600 storage keyed by a hash of the parent thread ID. */
export class FileAdvisorStore implements AdvisorStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async load(threadId: string): Promise<StoredAdvisor[]> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await requirePrivateDirectory(this.#root);
      handle = await open(this.#path(threadId), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Advisor state path is not a regular file");
      const parsed = JSON.parse(await handle.readFile("utf8")) as AdvisorStorePayload;
      if (parsed.version !== 1 || parsed.threadId !== threadId || !Array.isArray(parsed.advisors)) return [];
      return parsed.advisors
        .slice(0, MAX_ADVISORS_PER_THREAD)
        .filter(validStoredAdvisor)
        .map((record) => {
          const invalidContinuation = record.continuation !== undefined
            && !validContinuation(record.continuation, record.policy.harness);
          const cloned = cloneStored({
            ...record,
            continuation: invalidContinuation ? undefined : record.continuation,
          });
          if (invalidContinuation) cloned.invalidContinuation = true;
          return cloned;
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async save(threadId: string, advisors: StoredAdvisor[]): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    const payload: AdvisorStorePayload = {
      version: 1,
      threadId,
      advisors: advisors.slice(0, MAX_ADVISORS_PER_THREAD).map((record) => {
        const cloned = cloneStored(record);
        delete cloned.invalidContinuation;
        return cloned;
      }),
    };
    await atomicPrivateWrite(this.#path(threadId), JSON.stringify(payload));
  }

  #path(threadId: string): string {
    const key = createHash("sha256").update(threadId).digest("hex");
    return join(this.#root, `${key}.json`);
  }
}

interface InternalAdvisor extends StoredAdvisor {
  queued: number;
  jobId?: string;
  tail: Promise<void>;
  idleTimer?: NodeJS.Timeout;
}

export class AdvisorRegistry {
  readonly #jobs: JobManager;
  readonly #threadId: string;
  readonly #projectRoot: string;
  readonly #store: AdvisorStore;
  readonly #router: AdvisorRouteResolver;
  readonly #idleMs: number;
  readonly #records = new Map<string, InternalAdvisor>();
  readonly #listeners = new Set<(snapshot: AdvisorSnapshot) => void>();
  readonly #shutdownController = new AbortController();
  #persistChain: Promise<void> = Promise.resolve();
  #initializing?: Promise<void>;
  #initialized = false;
  #closed = false;

  constructor(options: {
    jobs: JobManager;
    threadId: string;
    projectRoot: string;
    store: AdvisorStore;
    router: AdvisorRouteResolver;
    idleMs?: number;
  }) {
    this.#jobs = options.jobs;
    this.#threadId = requireText(options.threadId, "Thread ID", 200);
    this.#projectRoot = realpathSync(options.projectRoot);
    this.#store = options.store;
    this.#router = options.router;
    this.#idleMs = Math.max(1, options.idleMs ?? DEFAULT_ADVISOR_IDLE_MS);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initializing ??= this.#restore();
    await this.#initializing;
  }

  async #restore(): Promise<void> {
    const stored = await this.#store.load(this.#threadId);
    for (const value of stored) {
      if (value.threadId !== this.#threadId) continue;
      const record: InternalAdvisor = { ...cloneStored(value), queued: 0, tail: Promise.resolve() };
      if (record.state === "closed") continue;
      const storedUnavailable = record.state === "unavailable";
      try {
        record.policy.cwd = await containedCwd(this.#projectRoot, record.policy.cwd, true);
      } catch (error) {
        record.state = "unavailable";
        record.error = `Stored advisor cwd is unavailable or changed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (record.state === "unavailable" && record.error?.startsWith("Stored advisor cwd")) {
        // Keep the roster entry visible, but never dispatch it from a changed path.
      } else if (record.invalidContinuation) {
        record.state = "unavailable";
        record.error = "Stored native continuation is invalid; explicitly reset or close this advisor.";
      } else if (record.generation > 0 && !record.continuation) {
        record.state = "unavailable";
        record.error = "Native continuation is missing; explicitly reset or close this advisor.";
      } else if (storedUnavailable) {
        record.state = "unavailable";
        record.error = publicAdvisorError(record.error ?? "Advisor is unavailable", record.continuation);
      } else if (record.continuation) {
        record.state = "hibernated";
        record.error = undefined;
      } else {
        record.state = "defined";
      }
      this.#records.set(record.id, record);
    }
    this.#initialized = true;
  }

  subscribe(listener: (snapshot: AdvisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(threadId = this.#threadId): AdvisorSnapshot[] {
    this.#assertThread(threadId);
    return [...this.#records.values()]
      .filter((record) => record.state !== "closed")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicSnapshot);
  }

  get(threadId: string, idOrAlias: string): AdvisorSnapshot {
    return publicSnapshot(this.#resolve(threadId, idOrAlias));
  }

  async open(request: AdvisorOpenRequest): Promise<AdvisorSnapshot> {
    await this.initialize();
    this.#assertThread(request.threadId);
    if (this.#closed) throw new Error("Advisor registry is closed");
    if (!request.trusted) throw new Error("Advisors are disabled for untrusted projects");
    if (this.#records.size >= MAX_ADVISORS_PER_THREAD) throw new Error(`Advisor limit reached (${MAX_ADVISORS_PER_THREAD} per thread)`);
    const name = requireText(request.name, "Advisor name", 160);
    const description = requireText(request.description, "Advisor description", 4_000);
    const aliases = normalizeAliases(name, request.aliases);
    for (const alias of aliases) {
      if ([...this.#records.values()].some((record) => record.id === alias || record.aliases.includes(alias))) {
        throw new Error(`Advisor alias is already in use in this thread: ${alias}`);
      }
    }
    const cwd = await containedCwd(this.#projectRoot, request.cwd);
    const budget = validateSpendBudget(request.budget, "Advisor budget");
    const resolution = await this.#router.resolve({ ...request, cwd }, undefined);
    const policy: AdvisorPolicy = {
      cwd,
      trusted: true,
      harness: resolution.harness,
      model: request.model,
      effort: request.effort,
      profile: request.profile,
      requires: [...resolution.requires],
      capabilityRoute: resolution.capabilityRoute ? cloneCapabilityRoute(resolution.capabilityRoute) : undefined,
      budget,
    };
    policy.effort = resolution.effort ?? policy.effort;
    if (request.profile && !validProfileBinding(resolution.profileBinding, request.profile.trim())) {
      throw new Error(`Advisor profile binding was not resolved for ${request.profile}`);
    }
    if (!request.profile && resolution.profileBinding) throw new Error("Advisor route returned an unexpected profile binding");
    this.#jobs.assertSpendBudgetSupported({
      ...spawnRequestForPolicy(policy, "advisor policy validation"),
      profile: undefined,
    }, budget);
    const now = Date.now();
    const id = `adv_${randomUUID().replaceAll("-", "")}`;
    const record: InternalAdvisor = {
      id,
      threadId: this.#threadId,
      name,
      aliases,
      description,
      state: "defined",
      policy,
      lineage: 0,
      generation: 0,
      usage: emptyUsage(),
      createdAt: now,
      updatedAt: now,
      queued: 0,
      ledger: [],
      profileBinding: resolution.profileBinding ? cloneProfileBinding(resolution.profileBinding) : undefined,
      tail: Promise.resolve(),
    };
    this.#records.set(id, record);
    await this.#persist();
    this.#publish(record);
    return publicSnapshot(record);
  }

  async consult(request: AdvisorConsultRequest): Promise<AdvisorConsultResult> {
    await this.initialize();
    if (this.#closed) throw new Error("Advisor registry is closed");
    if (!request.trusted) throw new Error("Advisor consultation is disabled for untrusted projects");
    const record = this.#resolve(request.threadId, request.advisorId);
    const question = requireText(request.question, "Advisor question", 100_000);
    const context = boundedOptional(request.context, MAX_ADVISOR_CONTEXT_BYTES, "Advisor context");
    const decisions = (request.decisions ?? []).slice(0, 16).map((decision) => requireText(decision, "Advisor decision", 1_000));
    if (record.queued >= MAX_ADVISOR_QUEUE) throw new Error(`Advisor consultation queue is full (${MAX_ADVISOR_QUEUE})`);
    if (request.requiredLineage !== undefined && request.requiredLineage !== record.lineage) {
      throw new Error(`Advisor lineage is incompatible: workflow requires ${request.requiredLineage}, current lineage is ${record.lineage}`);
    }
    if (record.state === "unavailable" && !request.retryUnavailable) {
      throw new Error(`${record.error ?? "Advisor is unavailable"} Pass retryUnavailable only to retry the recorded continuation, or reset explicitly.`);
    }
    if (record.state === "unavailable" && !record.continuation) {
      throw new Error("Advisor continuation is missing; retry cannot reconstruct it. Reset or close the advisor explicitly.");
    }
    if (record.state === "closed") throw new Error("Advisor is closed");

    const queuedAt = Date.now();
    record.queued++;
    record.updatedAt = queuedAt;
    this.#publish(record);
    const previous = record.tail.catch(() => undefined);
    let settle!: () => void;
    record.tail = new Promise<void>((resolveTail) => { settle = resolveTail; });
    let dequeued = false;
    const signal = request.signal
      ? AbortSignal.any([request.signal, this.#shutdownController.signal])
      : this.#shutdownController.signal;
    try {
      await abortable(previous, signal, "Advisor consultation cancelled while queued");
      record.queued--;
      dequeued = true;
      return await this.#runConsult(record, { ...request, question, context, decisions, signal }, queuedAt);
    } finally {
      if (!dequeued) record.queued--;
      settle();
      this.#publish(record);
    }
  }

  async reset(threadId: string, idOrAlias: string): Promise<AdvisorSnapshot> {
    await this.initialize();
    const record = this.#resolve(threadId, idOrAlias);
    if (record.state === "consulting" || record.queued) throw new Error("Cannot reset an advisor with an active or queued consultation");
    if (record.jobId) await this.#jobs.releaseAdvisorRun(record.jobId, record.id);
    const now = Date.now();
    record.jobId = undefined;
    record.continuation = undefined;
    record.invalidContinuation = undefined;
    record.lineage++;
    record.generation = 0;
    record.state = "defined";
    record.error = undefined;
    record.updatedAt = now;
    record.ledger.push({
      index: record.ledger.length ? record.ledger.at(-1)!.index + 1 : 0,
      lineage: record.lineage,
      generation: 0,
      sender: "system",
      question: "Explicit advisor lineage reset",
      state: "reset",
      startedAt: now,
      endedAt: now,
    });
    record.ledger = record.ledger.slice(-MAX_ADVISOR_LEDGER);
    await this.#persist();
    this.#publish(record);
    return publicSnapshot(record);
  }

  async close(threadId: string, idOrAlias: string): Promise<AdvisorSnapshot> {
    await this.initialize();
    const record = this.#resolve(threadId, idOrAlias);
    if (record.state === "consulting" || record.queued) {
      throw new Error("Cannot close an advisor with an active or queued consultation; cancel the caller first");
    }
    if (record.jobId) {
      try {
        const job = this.#jobs.checkAdvisorJob(record.jobId, record.id);
        if (job.status === "queued" || job.status === "running") await this.#jobs.cancelAdvisorJob(record.jobId, record.id, "Advisor closed");
        await this.#jobs.releaseAdvisorRun(record.jobId, record.id);
      } catch { /* the job may already be evicted */ }
    }
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    record.jobId = undefined;
    record.continuation = undefined;
    record.state = "closed";
    record.updatedAt = Date.now();
    await this.#persist();
    this.#records.delete(record.id);
    this.#publish(record);
    return publicSnapshot(record);
  }

  async hibernate(threadId: string, idOrAlias: string): Promise<AdvisorSnapshot> {
    const record = this.#resolve(threadId, idOrAlias);
    if (record.state === "consulting" || record.queued) throw new Error("Cannot hibernate an active advisor");
    if (record.jobId) await this.#jobs.releaseAdvisorRun(record.jobId, record.id);
    record.jobId = undefined;
    record.state = record.continuation ? "hibernated" : record.generation ? "unavailable" : "defined";
    if (record.state === "unavailable") record.error = "Native continuation is missing; explicitly reset or close this advisor.";
    record.updatedAt = Date.now();
    await this.#persist();
    this.#publish(record);
    return publicSnapshot(record);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdownController.abort(new Error("Advisor registry shutdown"));
    await Promise.allSettled([...this.#records.values()].map((record) => record.tail));
    for (const record of this.#records.values()) {
      if (record.idleTimer) clearTimeout(record.idleTimer);
      if (record.jobId) await this.#jobs.releaseAdvisorRun(record.jobId, record.id);
      record.jobId = undefined;
      if (record.state !== "closed" && record.state !== "unavailable") {
        record.state = record.continuation ? "hibernated" : record.generation ? "unavailable" : "defined";
        if (record.state === "unavailable") record.error = "Native continuation is missing; explicitly reset or close this advisor.";
      }
    }
    await this.#persist();
    this.#listeners.clear();
  }

  async #runConsult(
    record: InternalAdvisor,
    request: AdvisorConsultRequest & { decisions: string[] },
    queuedAt: number,
  ): Promise<AdvisorConsultResult> {
    request.signal?.throwIfAborted();
    try {
      record.policy.cwd = await containedCwd(this.#projectRoot, record.policy.cwd, true);
    } catch (error) {
      return this.#unavailable(record, `Advisor cwd is unavailable or changed: ${error instanceof Error ? error.message : String(error)}`, queuedAt);
    }
    if (record.state === "unavailable") {
      if (!request.retryUnavailable) return this.#unavailable(record, record.error ?? "Advisor is unavailable", queuedAt);
      if (!record.continuation) return this.#unavailable(record, "Advisor continuation is missing; retry cannot reconstruct it. Reset or close the advisor explicitly.", queuedAt);
      record.state = "hibernated";
      record.error = undefined;
    }
    const budgetError = firstReachedSpendWarning(record.policy.budget, record.usage, record.policy.harness, "Advisor budget");
    if (budgetError) throw new Error(budgetError);
    if (record.generation > 0 && !record.jobId && !record.continuation) {
      return this.#unavailable(record, "Native continuation is missing; explicitly reset or close this advisor.", queuedAt);
    }
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    record.state = "consulting";
    record.error = undefined;
    record.updatedAt = Date.now();
    this.#publish(record);
    const startedAt = Date.now();
    const beforeUsage = { ...record.usage };
    const prompt = consultationPrompt(record, request);
    const previousContinuation = record.continuation;
    let jobId = record.jobId;
    try {
      const liveRoute = await this.#router.resolve({
        threadId: record.threadId,
        name: record.name,
        aliases: record.aliases,
        description: record.description,
        cwd: record.policy.cwd,
        trusted: true,
        harness: record.policy.harness,
        requires: record.policy.requires,
        model: record.policy.model,
        effort: record.policy.effort,
        profile: record.policy.profile,
        budget: record.policy.budget,
        signal: request.signal,
      }, record.policy.harness);
      if (liveRoute.harness !== record.policy.harness) {
        throw new Error(`Advisor route changed from ${record.policy.harness} to ${liveRoute.harness}; silent provider migration is forbidden.`);
      }
      if (!sameStrings(liveRoute.requires, record.policy.requires)) {
        throw new Error("Advisor capability requirements changed; immutable advisor policy forbids silent replacement.");
      }
      if (jobId) {
        try {
          const current = this.#jobs.checkAdvisorJob(jobId, record.id);
          if (current.status !== "completed") throw new Error(`Advisor retained job is ${current.status}`);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("Unknown job:")) throw error;
          jobId = undefined;
          record.jobId = undefined;
        }
      }
      if (jobId) {
        await this.#jobs.continueAdvisorJob(
          jobId,
          record.id,
          prompt,
          request.workflow ? { runId: request.workflow.runId, callIndex: request.workflow.callIndex } : undefined,
        );
      } else {
        const spawned = this.#jobs.spawn({
          ...spawnRequestForPolicy(record.policy, prompt, record.name, record.profileBinding),
          capabilityRoute: liveRoute.capabilityRoute,
          requires: liveRoute.requires,
          continuation: record.continuation,
          initialUsage: record.usage,
          initialGeneration: record.generation,
          advisor: {
            advisorId: record.id,
            threadId: record.threadId,
            ...(request.workflow ? {
              workflow: { runId: request.workflow.runId, callIndex: request.workflow.callIndex },
            } : {}),
          },
        });
        jobId = spawned.id;
        record.jobId = jobId;
      }
      let cancellation: Promise<void> | undefined;
      let cancellationError: unknown;
      const abort = () => {
        if (!jobId || cancellation) return;
        cancellation = this.#jobs.cancelAdvisorJob(jobId, record.id, "Advisor consultation cancelled")
          .then(() => undefined, (error) => { cancellationError = error; });
      };
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
      let final;
      try {
        final = await this.#jobs.waitAdvisorJob(jobId, record.id);
        await cancellation;
        if (cancellationError) throw cancellationError;
      }
      finally { request.signal?.removeEventListener("abort", abort); }
      record.usage = { ...final.usage };
      const usage = subtractUsage(record.usage, beforeUsage);
      const endedAt = Date.now();
      if (final.status !== "completed") {
        record.continuation = previousContinuation;
        record.jobId = undefined;
        record.state = "unavailable";
        record.error = publicAdvisorError(final.error ?? `Advisor consultation ${final.status}`, previousContinuation);
        this.#appendLedger(record, request, request.signal?.aborted ? "cancelled" : "failed", startedAt, endedAt, usage, final.output, record.error);
        await this.#persist();
        return resultFor(record, false, final.output, record.error, usage, Date.now() - queuedAt);
      }
      const observedContinuation = this.#jobs.continuation(jobId, record.id);
      if (previousContinuation) {
        if (!observedContinuation || !sameNativeIdentity(previousContinuation, observedContinuation)) {
          throw new Error("Provider resumed a different native advisor identity; explicitly reset or close this advisor.");
        }
        record.continuation = previousContinuation;
      } else {
        record.continuation = observedContinuation;
      }
      record.generation++;
      record.lastConsultedAt = endedAt;
      record.updatedAt = endedAt;
      record.state = record.continuation ? "idle" : "unavailable";
      record.error = record.continuation
        ? undefined
        : "The provider returned no native continuation identity; this answer is preserved, but the advisor must be reset or closed before another consultation.";
      this.#appendLedger(record, request, "completed", startedAt, endedAt, usage, final.output);
      await this.#persist();
      if (record.continuation) this.#scheduleIdle(record);
      this.#publish(record);
      return resultFor(record, true, final.output, undefined, usage, startedAt - queuedAt);
    } catch (error) {
      const endedAt = Date.now();
      const message = publicAdvisorError(error, previousContinuation);
      if (jobId) {
        try { record.usage = { ...this.#jobs.checkAdvisorJob(jobId, record.id).usage }; }
        catch { /* a released/evicted job leaves the last persisted cumulative usage */ }
      }
      record.continuation = previousContinuation;
      record.jobId = undefined;
      record.state = "unavailable";
      record.error = message;
      this.#appendLedger(record, request, request.signal?.aborted ? "cancelled" : "failed", startedAt, endedAt, subtractUsage(record.usage, beforeUsage), undefined, message);
      await this.#persist();
      this.#publish(record);
      return resultFor(record, false, "", message, subtractUsage(record.usage, beforeUsage), startedAt - queuedAt);
    }
  }

  async #unavailable(record: InternalAdvisor, message: string, queuedAt: number): Promise<AdvisorConsultResult> {
    record.state = "unavailable";
    record.error = message;
    record.updatedAt = Date.now();
    await this.#persist();
    this.#publish(record);
    return resultFor(record, false, "", message, undefined, Date.now() - queuedAt);
  }

  #appendLedger(
    record: InternalAdvisor,
    request: AdvisorConsultRequest,
    state: AdvisorLedgerEntry["state"],
    startedAt: number,
    endedAt: number,
    usage: Usage,
    output?: string,
    error?: string,
  ): void {
    record.ledger.push({
      index: record.ledger.length ? record.ledger.at(-1)!.index + 1 : 0,
      lineage: record.lineage,
      generation: state === "completed" ? record.generation : record.generation + 1,
      sender: request.sender,
      question: boundedText(request.question, 2_000),
      context: request.context ? boundedText(request.context, 2_000) : undefined,
      state,
      output: output ? boundedText(output, 4_000) : undefined,
      error: error ? boundedText(error, 1_000) : undefined,
      usage: { ...usage },
      startedAt,
      endedAt,
      workflow: request.workflow ? { ...request.workflow } : undefined,
    });
    record.ledger = record.ledger.slice(-MAX_ADVISOR_LEDGER);
  }

  #scheduleIdle(record: InternalAdvisor): void {
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      void this.hibernate(record.threadId, record.id).catch((error) => {
        record.state = "unavailable";
        record.error = error instanceof Error ? error.message : String(error);
        this.#publish(record);
      });
    }, this.#idleMs);
    record.idleTimer.unref?.();
  }

  #resolve(threadId: string, idOrAlias: string): InternalAdvisor {
    this.#assertThread(threadId);
    const key = requireText(idOrAlias, "Advisor ID or alias", 200).toLocaleLowerCase("en-US");
    const record = this.#records.get(idOrAlias)
      ?? [...this.#records.values()].find((candidate) => candidate.aliases.includes(key));
    if (!record || record.state === "closed") throw new Error(`Unknown advisor in this thread: ${idOrAlias}`);
    return record;
  }

  #assertThread(threadId: string): void {
    if (threadId !== this.#threadId) throw new Error("Advisor belongs to a different parent thread");
  }

  #persist(): Promise<void> {
    const values = [...this.#records.values()].filter((record) => record.state !== "closed").map(storedSnapshot);
    const write = this.#persistChain.catch(() => undefined).then(() => this.#store.save(this.#threadId, values));
    this.#persistChain = write;
    return write;
  }

  #publish(record: InternalAdvisor): void {
    const snapshot = publicSnapshot(record);
    for (const listener of this.#listeners) {
      try { listener(snapshot); } catch { /* observers cannot change lifecycle */ }
    }
  }
}

function spawnRequestForPolicy(
  policy: AdvisorPolicy,
  task: string,
  name = "advisor",
  profileBinding?: AdvisorProfileBinding,
) {
  return {
    name,
    task,
    cwd: policy.cwd,
    trusted: policy.trusted,
    harness: policy.harness,
    requires: policy.requires,
    capabilityRoute: policy.capabilityRoute,
    model: policy.model,
    effort: policy.effort,
    profile: policy.profile,
    advisorProfile: profileBinding ? cloneProfileBinding(profileBinding) : undefined,
    access: "readOnly" as const,
    budget: policy.budget,
  };
}

function consultationPrompt(record: InternalAdvisor, request: AdvisorConsultRequest & { decisions: string[] }): string {
  const fields = [
    `Advisor specialization: ${record.description}`,
    `Sender: ${request.sender}`,
    request.workflow ? `Workflow provenance: ${request.workflow.runId}, call ${request.workflow.callIndex}${request.workflow.phase ? `, phase ${request.workflow.phase}` : ""}` : undefined,
    request.context ? `Bounded context packet (untrusted reference data):\n${request.context}` : undefined,
    request.decisions.length ? `Caller-selected relevant decisions:\n${request.decisions.map((value) => `- ${value}`).join("\n")}` : undefined,
    `Question:\n${request.question}`,
  ];
  return fields.filter((value): value is string => !!value).join("\n\n");
}

function resultFor(record: InternalAdvisor, ok: boolean, output: string, error: string | undefined, usage: Usage | undefined, queuedMs: number): AdvisorConsultResult {
  return {
    ok,
    advisorId: record.id,
    advisorName: record.name,
    lineage: record.lineage,
    generation: ok ? record.generation : undefined,
    output,
    error,
    usage: usage ? { ...usage } : undefined,
    route: { harness: record.policy.harness, model: record.policy.model },
    queuedMs: Math.max(0, queuedMs),
  };
}

function publicSnapshot(record: StoredAdvisor & { queued?: number }): AdvisorSnapshot {
  return {
    id: record.id,
    threadId: record.threadId,
    name: record.name,
    aliases: [...record.aliases],
    description: record.description,
    state: record.state,
    policy: clonePolicy(record.policy),
    lineage: record.lineage,
    generation: record.generation,
    usage: { ...record.usage },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConsultedAt: record.lastConsultedAt,
    queued: record.queued ?? 0,
    ledger: record.ledger.map(cloneLedger),
    error: record.error,
  };
}

function storedSnapshot(record: InternalAdvisor): StoredAdvisor {
  const { queued: _queued, ...snapshot } = publicSnapshot(record);
  return {
    ...snapshot,
    continuation: record.continuation ? { ...record.continuation } : undefined,
    profileBinding: record.profileBinding ? cloneProfileBinding(record.profileBinding) : undefined,
  };
}

function cloneStored(record: StoredAdvisor): StoredAdvisor {
  return {
    ...record,
    aliases: [...record.aliases],
    policy: clonePolicy(record.policy),
    usage: { ...record.usage },
    ledger: record.ledger.map(cloneLedger),
    continuation: record.continuation ? { ...record.continuation } : undefined,
    profileBinding: record.profileBinding ? cloneProfileBinding(record.profileBinding) : undefined,
  };
}

function cloneProfileBinding(binding: AdvisorProfileBinding): AdvisorProfileBinding {
  return { name: binding.name, systemPrompt: binding.systemPrompt };
}

function clonePolicy(policy: AdvisorPolicy): AdvisorPolicy {
  return {
    ...policy,
    requires: [...policy.requires],
    capabilityRoute: policy.capabilityRoute ? cloneCapabilityRoute(policy.capabilityRoute) : undefined,
    budget: policy.budget ? { ...policy.budget } : undefined,
  };
}

function cloneCapabilityRoute(route: JobCapabilityRoute): JobCapabilityRoute {
  return { ...route, matched: [...route.matched], warnings: route.warnings ? [...route.warnings] : undefined };
}

function cloneLedger(entry: AdvisorLedgerEntry): AdvisorLedgerEntry {
  return { ...entry, usage: entry.usage ? { ...entry.usage } : undefined, workflow: entry.workflow ? { ...entry.workflow } : undefined };
}

function validStoredAdvisor(value: unknown): value is StoredAdvisor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredAdvisor>;
  return typeof record.id === "string" && /^adv_[a-f0-9]{32}$/.test(record.id)
    && typeof record.threadId === "string"
    && typeof record.name === "string"
    && Array.isArray(record.aliases) && record.aliases.every((alias) => typeof alias === "string")
    && typeof record.description === "string"
    && ["defined", "consulting", "idle", "hibernated", "unavailable", "closed"].includes(record.state ?? "")
    && validPolicy(record.policy)
    && validUsage(record.usage)
    && Number.isSafeInteger(record.lineage) && record.lineage! >= 0
    && Number.isSafeInteger(record.generation) && record.generation! >= 0
    && Array.isArray(record.ledger) && record.ledger.length <= MAX_ADVISOR_LEDGER
    && (record.policy!.profile === undefined
      ? record.profileBinding === undefined
      : validProfileBinding(record.profileBinding, record.policy!.profile));
}

function validProfileBinding(value: unknown, profileName: string): value is AdvisorProfileBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<AdvisorProfileBinding>;
  return binding.name === profileName
    && typeof binding.systemPrompt === "string"
    && Buffer.byteLength(binding.systemPrompt) <= MAX_ADVISOR_PROFILE_PROMPT_BYTES;
}

function validPolicy(value: unknown): value is AdvisorPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<AdvisorPolicy>;
  return typeof policy.cwd === "string" && policy.trusted === true
    && ["pi", "claude", "codex"].includes(policy.harness ?? "")
    && (policy.model === undefined || typeof policy.model === "string")
    && (policy.effort === undefined || ["low", "medium", "high", "xhigh", "max"].includes(policy.effort))
    && (policy.profile === undefined || typeof policy.profile === "string")
    && Array.isArray(policy.requires) && policy.requires.every((requirement) => typeof requirement === "string")
    && validCapabilityRoute(policy.capabilityRoute)
    && validBudget(policy.budget);
}

function validCapabilityRoute(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Partial<JobCapabilityRoute>;
  return ["pi", "claude", "codex"].includes(route.harness ?? "")
    && Array.isArray(route.matched) && route.matched.every((item) => typeof item === "string")
    && typeof route.revision === "string"
    && typeof route.discoveredAt === "number" && Number.isFinite(route.discoveredAt)
    && (route.warnings === undefined || Array.isArray(route.warnings) && route.warnings.every((item) => typeof item === "string"));
}

function validBudget(value: unknown): boolean {
  if (value === undefined) return true;
  try { validateSpendBudget(value as SpendBudget, "Stored advisor budget"); return true; }
  catch { return false; }
}

function validContinuation(value: unknown, harness: HarnessName): value is NativeContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const continuation = value as Record<string, unknown>;
  if (continuation.harness !== harness) return false;
  if (harness === "pi") {
    return Object.keys(continuation).every((key) => key === "harness" || key === "sessionFile")
      && privateContinuationValue(continuation.sessionFile, 4_096);
  }
  if (harness === "claude") {
    return Object.keys(continuation).every((key) => key === "harness" || key === "sessionId")
      && privateContinuationValue(continuation.sessionId, 1_000);
  }
  return Object.keys(continuation).every((key) => key === "harness" || key === "threadId" || key === "sessionFile")
    && privateContinuationValue(continuation.threadId, 1_000)
    && (continuation.sessionFile === undefined || privateContinuationValue(continuation.sessionFile, 4_096));
}

function privateContinuationValue(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function sameNativeIdentity(expected: NativeContinuation, observed: NativeContinuation): boolean {
  if (expected.harness !== observed.harness) return false;
  if (expected.harness === "pi") {
    return observed.harness === "pi" && observed.sessionFile === expected.sessionFile;
  }
  if (expected.harness === "claude") {
    return observed.harness === "claude" && observed.sessionId === expected.sessionId;
  }
  return observed.harness === "codex" && observed.threadId === expected.threadId;
}

function publicAdvisorError(error: unknown, continuation: NativeContinuation | undefined): string {
  let message = error instanceof Error ? error.message : String(error);
  if (continuation) {
    const privateValues = continuation.harness === "pi"
      ? [continuation.sessionFile]
      : continuation.harness === "claude"
        ? [continuation.sessionId]
        : [continuation.threadId, continuation.sessionFile];
    for (const value of privateValues) {
      if (value) message = message.split(value).join("[redacted native continuation]");
    }
  }
  return boundedText(message, 2_000);
}

function validUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Partial<Usage>;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, usage.turns]
    .every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeAliases(name: string, values: string[] | undefined): string[] {
  const aliases = [name, ...(values ?? [])]
    .map((value) => requireText(value, "Advisor alias", 160).toLocaleLowerCase("en-US"))
    .filter((value, index, all) => all.indexOf(value) === index);
  if (aliases.length > 8) throw new Error("Advisor accepts at most 8 aliases");
  return aliases;
}

async function containedCwd(root: string, value: string, requireStableIdentity = false): Promise<string> {
  const requested = resolve(value);
  const cwd = await realpath(requested);
  const relation = relative(root, cwd);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Advisor cwd must stay within the trusted project directory");
  }
  if (requireStableIdentity && cwd !== requested) {
    throw new Error("Advisor cwd identity changed after registration");
  }
  return cwd;
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Advisor state path is not a private directory: ${path}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(path);
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(path: string, contents: string): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw new Error(`Advisor state path is not a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
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

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must contain 1–${max} characters`);
  return normalized;
}

function boundedOptional(value: string | undefined, maxBytes: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function boundedText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function subtractUsage(total: Usage, base: Usage): Usage {
  return {
    input: Math.max(0, total.input - base.input),
    output: Math.max(0, total.output - base.output),
    cacheRead: Math.max(0, total.cacheRead - base.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - base.cacheWrite),
    cost: Math.max(0, total.cost - base.cost),
    turns: Math.max(0, total.turns - base.turns),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(message));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => {
      cleanup();
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error(message));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolvePromise(value); }, (error) => { cleanup(); rejectPromise(error); });
  });
}
