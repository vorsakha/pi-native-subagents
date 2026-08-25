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

/* ── async utilities ─────────────────────────────────────────────────────── */

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Creates a unique temp directory. Callers are responsible for cleanup. */
export function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
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

  async start(request: BackendRequest, emit: (event: BackendEvent) => void): Promise<BackendRun> {
    this.requests.push(request);
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
      },
      cancel: async (reason) => {
        this.cancels.push({ jobId: request.jobId, reason });
        emit({ type: "cancelled", reason });
        run.settle();
      },
      close: async () => { this.closes.push(request.jobId); },
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
  const messageRenderers = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
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
    registerMessageRenderer(name: string, renderer: any) { messageRenderers.set(name, renderer); },
    registerEntryRenderer(name: string, renderer: any) { entryRenderers.set(name, renderer); },
    sendMessage(message: any, opts: any) { messages.push({ message, options: opts }); },
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
    messageRenderers,
    entryRenderers,
    messages,
    entries,
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
