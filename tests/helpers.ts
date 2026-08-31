// Shared fixtures for the test suite: async utilities, temp directories, themes,
// fake backends, and the Pi extension-host doubles. Test files should import from
// here rather than re-declaring a backend or host stub.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DiscoveredCapability } from "../src/capabilities.ts";
import type {
  Backend,
  BackendEvent,
  BackendRequest,
  BackendRun,
  DiscoveryRequest,
  DiscoveryResult,
  HarnessName,
  JobSnapshot,
  StructuredOutputSupport,
  Usage,
} from "../src/types.ts";
import type { ProviderUnavailability } from "../src/provider-unavailability.ts";
import { normalizeTarget, type InteractionAskResult, type PendingInteraction } from "../src/interactions.ts";
import type { InteractionDeadlineClock } from "../src/manager.ts";
import type { WorkflowCheckoutProof } from "../src/workflows/checkout.ts";
import type { WorkflowCheckoutOperations } from "../src/workflows/manager.ts";
import type { ProviderStatus, ProviderStatusReader, ProviderStatusRequest } from "../src/provider-status.ts";
import type { ManagedProcess } from "../src/process-tree.ts";
import type { WorkflowJournalRecord, WorkflowSnapshot } from "../src/workflows/types.ts";
import { appendWorkflowJournal } from "../src/workflows/artifacts.ts";
import {
  harnessAvailability,
  type HarnessAvailability,
  type HarnessAvailabilityProbe,
} from "../src/harness-availability.ts";

/* ── async utilities ─────────────────────────────────────────────────────── */

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Advances only the event loop; unlike {@link waitFor}, this has no clock or sleep. */
export async function ticks(count = 1): Promise<void> {
  for (let index = 0; index < count; index++) await tick();
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Managed native process whose tree-termination proof is held until released. */
export class GatedManagedProcess implements ManagedProcess {
  readonly child = {
    stderr: { resume() {} },
  } as unknown as ManagedProcess["child"];
  #terminateReached = false;
  #terminateReachedResolve!: () => void;
  readonly #terminateReachedPromise = new Promise<void>((resolve) => { this.#terminateReachedResolve = resolve; });
  #release!: () => void;
  readonly #released = new Promise<void>((resolve) => { this.#release = resolve; });

  terminate(): Promise<void> {
    this.#terminateReached = true;
    this.#terminateReachedResolve();
    return this.#released;
  }

  waitUntilTerminate(): Promise<void> {
    return this.#terminateReached ? Promise.resolve() : this.#terminateReachedPromise;
  }

  release(): void {
    this.#release();
  }
}

/** Persists one selected peer-answer record, then holds its append promise. */
export class GatedWorkflowJournalAppender {
  #armed = false;
  #gateState: WorkflowJournalRecord["state"] = "completed";
  #reached = false;
  #failInvalidation = false;
  #failAcceptance = false;
  #resolveReached!: () => void;
  #resolveRelease!: () => void;
  readonly #reachedPromise = new Promise<void>((resolve) => { this.#resolveReached = resolve; });
  readonly #releasePromise = new Promise<void>((resolve) => { this.#resolveRelease = resolve; });

  readonly append = async (root: string, runId: string, record: WorkflowJournalRecord): Promise<void> => {
    if (this.#failAcceptance && record.kind === "peerQuestion" && record.state === "accepted") {
      this.#failAcceptance = false;
      throw new Error("controlled peer-answer acceptance persistence failure");
    }
    if (this.#failInvalidation && record.kind === "peerQuestion" && record.state === "failed") {
      this.#failInvalidation = false;
      throw new Error("controlled peer-answer invalidation persistence failure");
    }
    await appendWorkflowJournal(root, runId, record);
    if (!this.#armed || this.#reached || record.kind !== "peerQuestion" || record.state !== this.#gateState) return;
    this.#reached = true;
    this.#resolveReached();
    await this.#releasePromise;
  };

  arm(state: WorkflowJournalRecord["state"] = "completed"): void {
    this.#armed = true;
    this.#gateState = state;
  }

  failNextInvalidation(): void {
    this.#failInvalidation = true;
  }

  failNextAcceptance(): void {
    this.#failAcceptance = true;
  }

  waitUntilReached(): Promise<void> {
    return this.#reached ? Promise.resolve() : this.#reachedPromise;
  }

  release(): void {
    this.#resolveRelease();
  }
}

/** Controlled write for interaction persistence races. */
export class GatedWrite {
  #reached = false;
  #resolveReached!: () => void;
  #resolveRelease!: () => void;
  readonly #reachedPromise = new Promise<void>((resolve) => { this.#resolveReached = resolve; });
  readonly #releasePromise = new Promise<void>((resolve) => { this.#resolveRelease = resolve; });
  calls = 0;

  readonly persist = async (): Promise<void> => {
    this.calls++;
    this.#reached = true;
    this.#resolveReached();
    await this.#releasePromise;
  };

  waitUntilReached(): Promise<void> {
    return this.#reached ? Promise.resolve() : this.#reachedPromise;
  }

  release(): void {
    this.#resolveRelease();
  }
}

/** Deterministic deadline clock for interaction lifecycle tests. */
export class ControlledInteractionClock implements InteractionDeadlineClock {
  #now: number;
  #sequence = 0;
  readonly #scheduled = new Map<number, { at: number; callback: () => void }>();

  constructor(now = 1_000) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const id = this.#sequence++;
    this.#scheduled.set(id, { at: this.#now + Math.max(0, delayMs), callback });
    return () => { this.#scheduled.delete(id); };
  }

  advance(ms: number): void {
    this.#now += Math.max(0, ms);
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }
}

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(5);
  }
}

export async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs);
    timer.unref();
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Creates a unique temp directory. Callers are responsible for cleanup. */
export function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export interface HarnessAvailabilityFacts {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  detail: string;
  probeFailed: boolean;
  compatible: boolean;
  version: string;
}

/** Scripted live availability shared by direct-routing and workflow tests. */
export class ScriptedHarnessAvailability implements HarnessAvailabilityProbe {
  readonly asked: Array<{ harness: HarnessName; refresh?: boolean }> = [];
  readonly states: Map<HarnessName, HarnessAvailability>;

  constructor(states: Partial<Record<HarnessName, Partial<HarnessAvailabilityFacts> | HarnessAvailability>>) {
    this.states = new Map((Object.entries(states) as Array<[HarnessName, Partial<HarnessAvailabilityFacts> | HarnessAvailability]>).map(([harness, state]) => [
      harness,
      "status" in state
        ? state
        : availabilityFixture(harness, state),
    ]));
  }

  get harnesses(): HarnessName[] {
    return [...this.states.keys()];
  }

  async availability(harness: HarnessName, request: { refresh?: boolean }): Promise<HarnessAvailability> {
    this.asked.push({ harness, refresh: request.refresh });
    const state = this.states.get(harness);
    if (!state) throw new Error(`no scripted availability for ${harness}`);
    return state;
  }
}

/** Scripted availability with one provider probe held until a test releases it. */
export class GatedHarnessAvailability extends ScriptedHarnessAvailability {
  readonly #gated: HarnessName;
  #released = false;
  #reached = false;
  #release!: () => void;
  #reachedResolve!: () => void;
  #releasePromise!: Promise<void>;
  #reachedPromise!: Promise<void>;

  constructor(gated: HarnessName, states: Partial<Record<HarnessName, Partial<HarnessAvailabilityFacts> | HarnessAvailability>>) {
    super(states);
    this.#gated = gated;
    this.#resetGate();
  }

  override async availability(harness: HarnessName, request: { refresh?: boolean }): Promise<HarnessAvailability> {
    if (harness === this.#gated && !this.#released) {
      this.#reached = true;
      this.#reachedResolve();
      await this.#releasePromise;
    }
    return super.availability(harness, request);
  }

  waitUntilReached(): Promise<void> {
    return this.#reached ? Promise.resolve() : this.#reachedPromise;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#release();
  }

  /** Holds the next matching probe after a prior gate has been released. */
  gateNext(): void {
    if (!this.#released) throw new Error("Harness availability gate is already active");
    this.#resetGate();
  }

  #resetGate(): void {
    this.#released = false;
    this.#reached = false;
    this.#releasePromise = new Promise<void>((resolve) => { this.#release = resolve; });
    this.#reachedPromise = new Promise<void>((resolve) => { this.#reachedResolve = resolve; });
  }
}

/** Checkout proof double that blocks capture until its signal is cancelled. */
export class CancellationGatedWorkflowCheckout implements WorkflowCheckoutOperations {
  #reached = false;
  #reachedResolve!: () => void;
  readonly #reachedPromise = new Promise<void>((resolve) => { this.#reachedResolve = resolve; });

  capture(_cwd: string, signal: AbortSignal): Promise<WorkflowCheckoutProof> {
    this.#reached = true;
    this.#reachedResolve();
    return new Promise((_, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  async assert(_proof: WorkflowCheckoutProof, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }

  waitUntilReached(): Promise<void> {
    return this.#reached ? Promise.resolve() : this.#reachedPromise;
  }
}

/** Stable checkout proof double for tests whose risk boundary is not Git state. */
export class StaticWorkflowCheckout implements WorkflowCheckoutOperations {
  async capture(cwd: string, signal: AbortSignal): Promise<WorkflowCheckoutProof> {
    signal.throwIfAborted();
    return {
      cwd,
      root: cwd,
      gitDir: join(cwd, ".git"),
      head: "a".repeat(40),
      headRef: "refs/heads/main",
      changedPaths: 0,
      digest: `sha256:${"b".repeat(64)}`,
    };
  }

  async assert(_proof: WorkflowCheckoutProof, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
  }
}

/** Stable checkout proof whose capture is held until a test releases or cancels it. */
export class GatedWorkflowCheckout extends StaticWorkflowCheckout {
  #reached = false;
  #reachedResolve!: () => void;
  readonly #reachedPromise = new Promise<void>((resolve) => { this.#reachedResolve = resolve; });
  #release!: () => void;
  readonly #releasePromise = new Promise<void>((resolve) => { this.#release = resolve; });

  override async capture(cwd: string, signal: AbortSignal): Promise<WorkflowCheckoutProof> {
    this.#reached = true;
    this.#reachedResolve();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void this.#releasePromise.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
    return super.capture(cwd, signal);
  }

  waitUntilReached(): Promise<void> {
    return this.#reached ? Promise.resolve() : this.#reachedPromise;
  }

  release(): void {
    this.#release();
  }
}

/** Stable checkout proof whose scheduler-admission assertion is test-controlled. */
export class AdmissionGatedWorkflowCheckout extends StaticWorkflowCheckout {
  #assertions = 0;
  #admissionReached = false;
  #admissionReachedResolve!: () => void;
  readonly #admissionReachedPromise = new Promise<void>((resolve) => { this.#admissionReachedResolve = resolve; });
  #releaseAdmission!: () => void;
  readonly #admissionRelease = new Promise<void>((resolve) => { this.#releaseAdmission = resolve; });

  override async assert(proof: WorkflowCheckoutProof, signal: AbortSignal): Promise<void> {
    await super.assert(proof, signal);
    this.#assertions++;
    if (this.#assertions < 3) return;
    this.#admissionReached = true;
    this.#admissionReachedResolve();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
      const cleanup = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void this.#admissionRelease.then(() => {
        cleanup();
        resolve();
      });
    });
  }

  waitUntilAdmission(): Promise<void> {
    return this.#admissionReached ? Promise.resolve() : this.#admissionReachedPromise;
  }

  releaseAdmission(): void {
    this.#releaseAdmission();
  }
}

export function availabilityFixture(
  harness: HarnessName,
  overrides: Partial<HarnessAvailabilityFacts> = {},
): HarnessAvailability {
  return harnessAvailability({
    harness,
    installed: overrides.installed ?? true,
    authenticated: overrides.authenticated ?? true,
    ready: overrides.ready ?? true,
    detail: overrides.detail,
    probeFailed: overrides.probeFailed,
    compatible: overrides.compatible,
    version: overrides.version,
    checkedAt: 1_000,
    probe: "test",
  });
}

/** Turn-free reader for extension tests that are unrelated to login discovery. */
export function readyProviderStatusReader(): ProviderStatusReader {
  return {
    async statuses(request) {
      const harnesses = request.harnesses ?? ["pi", "claude", "codex"];
      return harnesses.map((harness) => ({
        harness,
        installed: true,
        authenticated: true,
        ready: true,
        checkedAt: 1_000,
        probe: "test ready provider",
      }));
    },
  };
}

/** Provider-status reader with per-harness queues, used to exercise stale revalidation. */
export class ScriptedProviderStatusReader implements ProviderStatusReader {
  readonly requests: ProviderStatusRequest[] = [];
  readonly script: Map<HarnessName, ProviderStatus[]>;
  invalidated = 0;

  constructor(script: Map<HarnessName, ProviderStatus[]>) {
    this.script = script;
  }

  async statuses(request: ProviderStatusRequest): Promise<ProviderStatus[]> {
    this.requests.push({ ...request });
    const wanted = request.harnesses ?? [...this.script.keys()];
    return wanted.map((harness) => {
      const queue = this.script.get(harness);
      if (!queue?.length) throw new Error(`no scripted status for ${harness}`);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    });
  }

  invalidate(): void {
    this.invalidated++;
  }
}

/* ── themes ──────────────────────────────────────────────────────────────── */

/** Identity theme: renders styled text unchanged so assertions can match plain strings. */
export const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Theme that emits real escape sequences, for asserting that styling is applied at all. */
export const ansiTheme = {
  fg: (color: string, text: string) => `\u001b[3${color.length % 8}m${text}\u001b[0m`,
  bg: (_color: string, text: string) => `\u001b[48;5;24m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
} as unknown as Theme;

/** Small live workflow snapshot shared by dashboard and pure outline tests. */
export function workflowSnapshotFixture(
  id: string,
  status: WorkflowSnapshot["status"] = "running",
): WorkflowSnapshot {
  const settledAgentState = status === "pending" ? "queued" as const : status === "paused" ? "running" as const : status;
  const terminal = status === "completed" || status === "failed" || status === "aborted";
  return {
    runId: id,
    sessionId: "session",
    name: `Release ${id}`,
    description: "Review and verify Unicode output 你好世界",
    background: true,
    status,
    timestamps: {
      createdAt: 1_000,
      updatedAt: 3_000,
      startedAt: 2_000,
      ...(status === "paused" ? { pausedAt: 3_000 } : {}),
      ...(terminal ? { endedAt: 4_000 } : {}),
    },
    currentPhase: 0,
    phases: [{
      index: 0,
      name: "Verification",
      status,
      timestamps: { createdAt: 1_000, updatedAt: 3_000 },
      agents: [0, 1],
    }],
    agents: [
      {
        index: 0,
        callIndex: 0,
        name: "review",
        access: "readOnly",
        independent: false,
        phase: 0,
        state: status === "running" || status === "paused" ? "completed" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000 },
        harness: "claude",
        model: "claude-fixture-model",
        effort: "high",
        jobId: "review-job-0001",
        prompt: "Review the implementation",
        tools: [{ id: "read-1", name: "read", summary: "src/index.ts", status: "completed" }],
        output: "review result",
        preview: "review result",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
      },
      {
        index: 1,
        callIndex: 1,
        name: "tests",
        access: "full",
        independent: false,
        phase: 0,
        state: status === "running" || status === "paused" ? "running" : settledAgentState,
        timestamps: { createdAt: 1_000, updatedAt: 3_000, startedAt: 2_000 },
        harness: "codex",
        model: "codex-fixture-model",
        effort: "medium",
        jobId: "tests-job-0002",
        prompt: "\u001b[31mRun the affected tests\u001b[0m",
        liveThinking: "\u001b]0;bad\u0007checking failures",
        activity: { kind: "tool", at: 64_000, tool: "read", state: "running", target: "tests/failures.test.ts" },
        tools: [{ id: "bash-1", name: "bash", summary: "npm test", status: "running" }],
        output: Array.from({ length: 60 }, (_, index) => `test result ${index}`).join("\n"),
        preview: "test result 59",
        usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0, cost: 0.02, turns: 2 },
      },
    ],
    result: "workflow result",
    artifactDir: `/private/${id}`,
  };
}

/* ── backends ────────────────────────────────────────────────────────────── */

function discovery(name: HarnessName, capabilities: DiscoveredCapability[]): DiscoveryResult {
  return { capabilities, sources: [{ source: `${name}-fixture`, health: "healthy" }] };
}

export interface ImmediateBackendOptions {
  /** Output text for the synthetic `completed` event. Defaults to `<harness>-ok`. */
  output?: (request: BackendRequest) => string;
  /** Usage emitted immediately before completion. */
  usage?: Partial<Usage>;
  /** When true, `send` re-completes the run with `<harness>-<message>`. */
  echoSend?: boolean;
  /** Native structured-output support this backend reports; absent means no `structuredOutputSupport` method at all. */
  structuredSupport?: StructuredOutputSupport;
}

/** Backend that completes every run synchronously inside `start`. */
export class ImmediateBackend implements Backend {
  readonly name: HarnessName;
  readonly requests: BackendRequest[] = [];
  readonly #options: ImmediateBackendOptions;

  constructor(name: HarnessName, options: ImmediateBackendOptions = {}) {
    this.name = name;
    this.#options = options;
  }

  /** Alias of {@link requests}, for call sites that read the recorded starts. */
  get starts(): BackendRequest[] {
    return this.requests;
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.requests.push(request);
    if (this.#options.usage) emit({ type: "usage", usage: this.#options.usage });
    emit({ type: "completed", output: this.#options.output?.(request) ?? `${this.name}-ok` });
    return {
      completed: Promise.resolve(),
      send: async (message: string) => {
        if (this.#options.echoSend) emit({ type: "completed", output: `${this.name}-${message}` });
      },
      async cancel() {},
      async close() {},
    };
  }

  /** Drives the normalized host ask callback exactly as a provider's client-hosted tool would. */
  ask(jobId: string, input: AskInput): Promise<InteractionAskResult> {
    return askThroughBackend(this.requests, jobId, input);
  }

  /** Same as {@link ask}, addressed by the task text that started the job. */
  askTask(task: string, input: AskInput): Promise<InteractionAskResult> {
    const request = this.requestForTask(task);
    assert.ok(request, `backend did not start task ${task}`);
    return askThroughBackend(this.requests, request.jobId, input);
  }

  requestForTask(task: string): BackendRequest | undefined {
    return this.requests.find((request) => request.task === task);
  }
}

/** {@link ImmediateBackend} that also answers capability discovery. */
export class DiscoverableBackend extends ImmediateBackend {
  readonly #capabilities: DiscoveredCapability[];
  readonly structuredOutputSupportCalls: DiscoveryRequest[] = [];
  /**
   * Present only when the fixture was constructed with `structuredSupport`,
   * exactly like a real adapter that may or may not implement this optional
   * method at all; an absent method must fail closed to portable, not throw.
   */
  structuredOutputSupport?: (request: DiscoveryRequest) => Promise<StructuredOutputSupport>;

  constructor(
    name: HarnessName,
    capabilities: DiscoveredCapability[] = [],
    options: ImmediateBackendOptions = {},
  ) {
    super(name, options);
    this.#capabilities = capabilities;
    if (options.structuredSupport) {
      const support = options.structuredSupport;
      this.structuredOutputSupport = async (request) => {
        this.structuredOutputSupportCalls.push(request);
        return support;
      };
    }
  }

  async discover(_request: DiscoveryRequest): Promise<DiscoveryResult> {
    return discovery(this.name, this.#capabilities);
  }

  setCapabilities(capabilities: DiscoveredCapability[]): void {
    this.#capabilities.splice(0, this.#capabilities.length, ...capabilities);
  }
}

/** Backend whose runs stay active until the test completes or fails them. */
export class HoldingBackend implements Backend {
  readonly name: HarnessName;
  readonly requests: BackendRequest[] = [];
  readonly #emitStarted: boolean;
  #emit: ((event: BackendEvent) => void) | undefined;
  #settle: (() => void) | undefined;

  constructor(name: HarnessName = "pi", options: { emitStarted?: boolean } = {}) {
    this.name = name;
    this.#emitStarted = options.emitStarted ?? false;
  }

  get starts(): number {
    return this.requests.length;
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.requests.push(request);
    this.#emit = emit;
    const completed = new Promise<void>((resolve) => { this.#settle = resolve; });
    if (this.#emitStarted) emit({ type: "started", backendSessionId: `${this.name}-session` });
    return {
      completed,
      async send() {},
      cancel: async (reason = "Cancelled") => {
        emit({ type: "cancelled", reason });
        this.#settle?.();
      },
      close: async () => { this.#settle?.(); },
    };
  }

  complete(output = "done"): void {
    this.#emit?.({ type: "completed", output });
    this.#settle?.();
  }

  fail(error: string): void {
    this.#emit?.({ type: "failed", error });
    this.#settle?.();
  }
}

export interface FakeRun {
  request: BackendRequest;
  emit: (event: BackendEvent) => void;
  settle: () => void;
  settled: boolean;
}

interface ControlledCancellationGate {
  usage?: Partial<Usage>;
  reached: boolean;
  reachedPromise: Promise<void>;
  reach: () => void;
  released: Promise<void>;
  release: () => void;
}

export interface ControlledCancellationHandle {
  waitUntilReached(): Promise<void>;
  release(): void;
}

/**
 * Backend giving the test full control over every run's lifecycle, addressable
 * either by job id ({@link complete}) or by task text ({@link completeTask}).
 */
export class ControlledBackend implements Backend {
  readonly name: HarnessName;
  readonly requests: BackendRequest[] = [];
  readonly runs = new Map<string, FakeRun>();
  readonly cancels: Array<{ jobId: string; reason?: string }> = [];
  readonly closes: string[] = [];
  readonly sends: Array<{ id: string; message: string; behavior: string }> = [];
  readonly #startWaiters = new Set<() => void>();
  readonly #sendWaiters = new Set<() => void>();
  readonly #cancellationGates = new Map<string, ControlledCancellationGate>();
  readonly #closeFailures = new Map<string, Error>();
  active = 0;
  maxActive = 0;

  constructor(name: HarnessName = "codex") {
    this.name = name;
  }

  /** Job ids in start order. */
  get starts(): string[] {
    return this.requests.map((request) => request.jobId);
  }

  get policies(): Array<BackendRequest["policy"]> {
    return this.requests.map((request) => request.policy);
  }

  /** Resolves from the backend's start event; no wall-clock polling is involved. */
  waitForStart(count = 1): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.requests.length < count) return;
        this.#startWaiters.delete(check);
        resolve();
      };
      this.#startWaiters.add(check);
    });
  }

  /** Resolves from a retained-session send event; no wall-clock polling is involved. */
  waitForSend(count = 1): Promise<void> {
    if (this.sends.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.sends.length < count) return;
        this.#sendWaiters.delete(check);
        resolve();
      };
      this.#sendWaiters.add(check);
    });
  }

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.requests.push(request);
    for (const waiter of [...this.#startWaiters]) waiter();
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    let finish!: () => void;
    const run: FakeRun = {
      request,
      emit,
      settled: false,
      settle: () => {
        if (run.settled) return;
        run.settled = true;
        this.active--;
        finish();
      },
    };
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    this.runs.set(request.jobId, run);
    return {
      completed,
      send: async (message: string, behavior = "steer") => {
        this.sends.push({ id: request.jobId, message, behavior });
        for (const waiter of [...this.#sendWaiters]) waiter();
      },
      cancel: async (reason) => {
        this.cancels.push({ jobId: request.jobId, reason });
        const gate = this.#cancellationGates.get(request.jobId);
        if (gate) {
          gate.reached = true;
          gate.reach();
          await gate.released;
          this.#cancellationGates.delete(request.jobId);
          if (gate.usage) emit({ type: "usage", usage: gate.usage });
        }
        emit({ type: "cancelled", reason });
        run.settle();
      },
      close: async () => {
        this.closes.push(request.jobId);
        const error = this.#closeFailures.get(request.jobId);
        if (error) throw error;
      },
    };
  }

  /** Drives the normalized host ask callback exactly as a provider's client-hosted tool would. */
  ask(jobId: string, input: AskInput): Promise<InteractionAskResult> {
    return askThroughBackend(this.requests, jobId, input);
  }

  /** Same as {@link ask}, addressed by the task text that started the job. */
  askTask(task: string, input: AskInput): Promise<InteractionAskResult> {
    const request = this.requestForTask(task);
    assert.ok(request, `backend did not start task ${task}`);
    return askThroughBackend(this.requests, request.jobId, input);
  }

  /** Holds one native cancellation and can emit final usage before it settles. */
  gateCancellation(jobId: string, usage?: Partial<Usage>): ControlledCancellationHandle {
    assert.ok(this.runs.has(jobId), `backend never started job ${jobId}`);
    assert.equal(this.#cancellationGates.has(jobId), false, `cancellation for ${jobId} is already gated`);
    let reach!: () => void;
    let release!: () => void;
    const gate: ControlledCancellationGate = {
      usage,
      reached: false,
      reachedPromise: new Promise<void>((resolve) => { reach = resolve; }),
      reach: () => reach(),
      released: new Promise<void>((resolve) => { release = resolve; }),
      release: () => release(),
    };
    this.#cancellationGates.set(jobId, gate);
    return {
      waitUntilReached: () => gate.reached ? Promise.resolve() : gate.reachedPromise,
      release: gate.release,
    };
  }

  /** Makes strict retained-session cleanup fail for one job. */
  failClose(jobId: string, message: string): void {
    assert.ok(this.runs.has(jobId), `backend never started job ${jobId}`);
    this.#closeFailures.set(jobId, new Error(message));
  }

  requestForTask(task: string): BackendRequest | undefined {
    return [...this.requests].reverse().find((request) => request.task === task);
  }

  activeRuns(): FakeRun[] {
    return [...this.runs.values()].filter((run) => !run.settled);
  }

  /**
   * Completes a run by job id. A settled run may be completed again so tests can
   * drive follow-ups on a retained native session; {@link settle} is idempotent.
   */
  complete(jobId: string, output = "ok", usage?: Partial<Usage>, structured?: unknown): void {
    const run = this.runs.get(jobId);
    assert.ok(run, `backend never started job ${jobId}`);
    if (usage) run.emit({ type: "usage", usage });
    run.emit({ type: "completed", output, ...(structured !== undefined ? { structured } : {}) });
    run.settle();
  }

  fail(jobId: string, error: string, unavailable?: ProviderUnavailability): void {
    const run = this.runs.get(jobId);
    assert.ok(run, `backend never started job ${jobId}`);
    run.emit({ type: "failed", error, unavailable });
    run.settle();
  }

  emit(jobId: string, event: BackendEvent): void {
    const run = this.runs.get(jobId);
    assert.ok(run, `backend never started job ${jobId}`);
    run.emit(event);
  }

  /** Resolves the most recent *active* run for a task, so typos fail loudly. */
  #activeRunForTask(task: string): FakeRun {
    const request = this.requestForTask(task);
    assert.ok(request, `backend did not start task ${task}`);
    const run = this.runs.get(request.jobId);
    assert.ok(run && !run.settled, `task ${task} is not active`);
    return run;
  }

  completeTask(task: string, output = `${task} output`, usage?: Partial<Usage>, structured?: unknown): void {
    const run = this.#activeRunForTask(task);
    if (usage) run.emit({ type: "usage", usage });
    run.emit({ type: "completed", output, ...(structured !== undefined ? { structured } : {}) });
    run.settle();
  }

  failTask(task: string, error: string, unavailable?: ProviderUnavailability): void {
    const run = this.#activeRunForTask(task);
    run.emit({ type: "failed", error, unavailable });
    run.settle();
  }
}

export interface AskInput {
  question: string;
  context?: string;
  target?: unknown;
}

/**
 * Calls the host ask callback a backend request was authorized with, exactly as
 * a provider's client-hosted tool would, so tests exercise the real routing path
 * instead of reaching into JobManager internals.
 */
function askThroughBackend(requests: BackendRequest[], jobId: string, input: AskInput): Promise<InteractionAskResult> {
  const request = requests.find((candidate) => candidate.jobId === jobId);
  assert.ok(request?.interactions, `job ${jobId} was not authorized to ask routed questions`);
  return request.interactions.ask({
    question: input.question,
    context: input.context,
    target: normalizeTarget(input.target),
  });
}

/* ── Pi extension host doubles ───────────────────────────────────────────── */

export interface FakePiOptions {
  /** Registers a `getAllTools` implementation. Omitted entirely when not supplied. */
  allTools?: Array<Record<string, unknown>>;
}

/**
 * Records everything `registerNativeSubagents` puts on the extension API.
 * Duplicate tool or command names throw, so double registration is caught.
 */
export function fakePi(options: FakePiOptions = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const messageRenderers = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const messageWaiters = new Set<{
    customType?: string;
    count: number;
    resolve: (entry: { message: any; options: any }) => void;
  }>();
  const entries: Array<{ id: string; customType: string; data: unknown }> = [];
  const api: Record<string, unknown> = {
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    registerTool(tool: any) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      if (commands.has(name)) throw new Error(`duplicate command: ${name}`);
      commands.set(name, command);
    },
    registerShortcut(name: string, shortcut: any) { shortcuts.set(name, shortcut); },
    registerMessageRenderer(name: string, renderer: any) { messageRenderers.set(name, renderer); },
    registerEntryRenderer(name: string, renderer: any) { entryRenderers.set(name, renderer); },
    sendMessage(message: any, opts: any) {
      const entry = { message, options: opts };
      messages.push(entry);
      for (const waiter of [...messageWaiters]) {
        if (waiter.customType && message.customType !== waiter.customType) continue;
        if (messages.filter((candidate) => !waiter.customType || candidate.message.customType === waiter.customType).length < waiter.count) continue;
        messageWaiters.delete(waiter);
        waiter.resolve(entry);
      }
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ id: `entry-${entries.length}`, customType, data });
    },
  };
  if (options.allTools) api.getAllTools = () => options.allTools;
  return {
    api: api as any,
    handlers,
    tools,
    commands,
    shortcuts,
    messageRenderers,
    entryRenderers,
    messages,
    entries,
    waitForMessage(customType?: string) {
      const found = messages.find((entry) => !customType || entry.message.customType === customType);
      if (found) return Promise.resolve(found);
      return new Promise<{ message: any; options: any }>((resolve) => {
        messageWaiters.add({ customType, count: 1, resolve });
      });
    },
    waitForMessages(customType: string, count: number) {
      const found = messages.find((entry) => entry.message.customType === customType);
      if (messages.filter((entry) => entry.message.customType === customType).length >= count) return Promise.resolve(found!);
      return new Promise<{ message: any; options: any }>((resolve) => {
        messageWaiters.add({ customType, count, resolve });
      });
    },
  };
}

export interface ContextOptions {
  /** Session branch returned by `getBranch`/`buildContextEntries`. */
  branch?: unknown[];
  /** Parent model provider; when set, `ctx.model` is populated. */
  provider?: string;
  trusted?: boolean;
  /** Adds `ui.confirm`. Omitted entirely when not supplied. */
  confirm?: () => Promise<boolean>;
  /** Adds `ctx.hasUI`. Omitted entirely when not supplied. */
  hasUI?: boolean;
  sessionId?: string;
  cwd?: string;
  /** Whether the parent turn is idle; drives deferred question/result delivery. */
  idle?: boolean;
}

/** Builds a Pi tool-execution context plus handles on the UI side effects it records. */
export function context(options: ContextOptions = {}) {
  const branch = options.branch ?? [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, unknown>();
  const ui: Record<string, unknown> = {
    setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
    setWidget(key: string, value: unknown) { widgets.set(key, value); },
    notify(message: string, type?: string) { notifications.push({ message, type }); },
  };
  if (options.confirm) ui.confirm = options.confirm;
  const ctx: Record<string, unknown> = {
    cwd: options.cwd ?? process.cwd(),
    model: options.provider ? { provider: options.provider, id: "parent-model" } : undefined,
    mode: "rpc",
    isProjectTrusted: () => options.trusted ?? true,
    isIdle: () => options.idle ?? false,
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => branch,
      getSessionId: () => options.sessionId ?? "test-session",
    },
    ui,
  };
  if (options.hasUI !== undefined) ctx.hasUI = options.hasUI;
  return { ctx: ctx as any, notifications, statuses, widgets };
}

/* ── snapshot builders ───────────────────────────────────────────────────── */

export function usage(overrides: Partial<JobSnapshot["usage"]> = {}): JobSnapshot["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...overrides };
}

/** A running full-access Codex job. Trailing fields are not overridable by design. */
export function jobSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "0123456789abcdef",
    name: "worker",
    access: "full",
    independent: false,
    harness: "codex",
    model: "fixture-model",
    task: "Implement the widget",
    cwd: "/tmp",
    status: "running",
    createdAt: 1_000,
    startedAt: 2_000,
    output: "",
    truncated: false,
    usage: usage(),
    tools: [],
    ...overrides,
    generation: overrides.generation ?? 0,
    transcript: overrides.transcript ?? [],
    liveThinking: overrides.liveThinking ?? "",
    queuedMessages: overrides.queuedMessages ?? [],
  };
}

/** A pending orchestrator question, as JobManager projects it to observers. */
export function interactionSnapshot(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    requestId: "req-1",
    sourceJobId: "0123456789abcdef",
    sourceName: "worker",
    sourceGeneration: 0,
    question: "Which compatibility behavior should stay?",
    createdAt: 1_000,
    expiresAt: 901_000,
    state: "pending",
    ...overrides,
    target: overrides.target ?? { kind: "orchestrator" },
  };
}
