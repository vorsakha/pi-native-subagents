import { maskEmbeddedEmails, type ProviderStatus, type ProviderStatusReader } from "./provider-status.ts";
import type { HarnessName } from "./types.ts";

const DEFAULT_AVAILABILITY_TIMEOUT_MS = 25_000;

/**
 * Normalized runtime availability of one supported harness, derived entirely
 * from the existing side-effect-free {@link ProviderStatusReader} probes. The
 * states are deliberately distinct and never collapse to a boolean:
 *
 * - `ready` — detected, compatible, authenticated where safely checkable, usable.
 * - `missing` — the expected executable did not resolve locally.
 * - `unauthenticated` — the CLI ran but reports no usable login.
 * - `incompatible` — the CLI is logged in but with an auth method/plan this
 *   package cannot launch a subagent under.
 * - `unhealthy` — a bounded probe ran the CLI but failed for a transient reason.
 * - `unknown` — readiness genuinely could not be determined by a safe probe and
 *   is deferred until dispatch. Guaranteeing every CLI can prove readiness
 *   without a model turn is an explicit non-goal.
 */
export type HarnessAvailabilityStatus =
  | "ready"
  | "missing"
  | "unauthenticated"
  | "incompatible"
  | "unhealthy"
  | "unknown";

export interface HarnessAvailability {
  harness: HarnessName;
  status: HarnessAvailabilityStatus;
  /** True when the expected executable resolved locally ("detected"). */
  detected: boolean;
  /** Convenience for `status === "ready"`. */
  ready: boolean;
  /** Version string, only when the adapter's safe probe reports one. */
  version?: string;
  /** Bounded, email-masked reason the harness is not ready, or a non-fatal note. */
  reason?: string;
  checkedAt: number;
}

/**
 * The five distinct lifecycle concepts the issue keeps separate. `supported`
 * means an adapter ships; `detected` that its executable resolved; `ready` that
 * a safe probe accepts it; `enabled` that the user has not disabled it; and
 * `active` that it is both enabled and ready. Only `active` harnesses are
 * eligible for `harness: "auto"` routing.
 */
export interface HarnessActivation {
  harness: HarnessName;
  supported: boolean;
  detected: boolean;
  ready: boolean;
  enabled: boolean;
  active: boolean;
  availability: HarnessAvailability;
}

/** Human-facing label for each normalized state; never color-only in a surface. */
const AVAILABILITY_LABELS: Record<HarnessAvailabilityStatus, string> = {
  ready: "ready",
  missing: "missing executable",
  unauthenticated: "login required",
  incompatible: "incompatible",
  unhealthy: "temporarily unhealthy",
  unknown: "status unknown",
};

const DEFAULT_REASONS: Record<HarnessAvailabilityStatus, string> = {
  ready: "",
  missing: "the expected executable was not found on PATH",
  unauthenticated: "the CLI is not logged in",
  incompatible: "the CLI login is not usable for a subagent",
  unhealthy: "a bounded readiness probe failed",
  unknown: "readiness is deferred until dispatch",
};

export function availabilityLabel(status: HarnessAvailabilityStatus): string {
  return AVAILABILITY_LABELS[status];
}

/**
 * Explicitly selected harnesses fail closed unless a live probe reports ready.
 * Unknown remains a useful status for display and adapters whose safe probes
 * cannot decide, but it is not dispatch authority. Auto is equally strict.
 */
export function explicitBlocked(status: HarnessAvailabilityStatus): boolean {
  return status !== "ready";
}

/**
 * Classify a provider status into a normalized availability state without any
 * new probe. Every input field already comes from a zero-model-turn source, so
 * this mapping is pure and side-effect-free.
 */
export function harnessAvailabilityStatus(status: ProviderStatus): HarnessAvailabilityStatus {
  if (status.ready) return "ready";
  // A probe that ran the CLI but threw is transiently unhealthy; a probe that
  // could not find the CLI at all is missing.
  if (status.probeFailed) return status.installed ? "unhealthy" : "missing";
  if (!status.installed) return "missing";
  if (status.compatible === false) return "incompatible";
  if (!status.authenticated) {
    // Pi has no interactive account to check: an installed-but-unready Pi is a
    // deferred-readiness signal, never a "log in" instruction.
    return status.harness === "pi" ? "unknown" : "unauthenticated";
  }
  // Installed and authenticated but still not ready means the login itself is
  // incompatible (wrong auth method or plan for a launched subagent).
  return "incompatible";
}

/** Normalized availability for a single provider status. Reason is email-masked and bounded. */
export function harnessAvailability(status: ProviderStatus): HarnessAvailability {
  const normalized = harnessAvailabilityStatus(status);
  return {
    harness: status.harness,
    status: normalized,
    detected: status.installed,
    ready: normalized === "ready",
    version: status.version,
    reason: normalized === "ready" ? undefined : availabilityReason(status, normalized),
    checkedAt: status.checkedAt,
  };
}

function availabilityReason(status: ProviderStatus, normalized: HarnessAvailabilityStatus): string {
  const base = status.detail?.trim() || DEFAULT_REASONS[normalized] || "not ready";
  return maskEmbeddedEmails(base.replace(/\s+/g, " ").trim()).slice(0, 300);
}

/** Combine a probe result with the user's enable state into the full lifecycle view. */
export function harnessActivation(availability: HarnessAvailability, enabled: boolean): HarnessActivation {
  return {
    harness: availability.harness,
    supported: true,
    detected: availability.detected,
    ready: availability.ready,
    enabled,
    active: enabled && availability.ready,
    availability,
  };
}

/** The active harness set: enabled adapters whose live probe reports ready. */
export function activeHarnesses(activations: HarnessActivation[]): HarnessName[] {
  return activations.filter((activation) => activation.active).map((activation) => activation.harness);
}

/**
 * Project already-probed provider statuses into the full lifecycle view without
 * any new probe, folding in the user's enable state. Callers that already hold a
 * status list reuse it here rather than re-probing.
 */
export function harnessActivations(statuses: ProviderStatus[], disabled: Iterable<HarnessName> = []): HarnessActivation[] {
  const off = new Set(disabled);
  return statuses.map((status) => harnessActivation(harnessAvailability(status), !off.has(status.harness)));
}

/**
 * One accessible status line per harness. Every state is carried by its text
 * label and reason, never by color alone, so the dashboard and the plain-text
 * report communicate the same normalized state to a screen reader or a narrow
 * terminal. `disabled` is surfaced distinctly from any probe result.
 */
export function formatHarnessAvailabilityLine(activation: HarnessActivation): string {
  const { availability } = activation;
  const state = !activation.enabled ? "disabled by user" : availabilityLabel(availability.status);
  const marker = activation.active ? "active" : "inactive";
  const version = availability.version ? ` · version ${availability.version}` : "";
  const reason = !activation.enabled
    ? " — the harness is turned off in this session"
    : availability.reason ? ` — ${availability.reason}. ${availabilityGuidance(availability.status)}` : "";
  return `${activation.harness.padEnd(6)} ${marker.padEnd(8)} ${state}${version}${reason}`;
}

/** Full harness-availability report for `/subagents providers`; read-only and turn-free. */
export function formatHarnessAvailabilityReport(activations: HarnessActivation[], now: number): string {
  const oldest = activations.reduce((value, activation) => Math.min(value, activation.availability.checkedAt), now);
  const active = activeHarnesses(activations);
  return [
    "Native harness availability (read-only discovery; no model request was made):",
    ...activations.map(formatHarnessAvailabilityLine),
    `Active harnesses: ${active.length ? active.join(", ") : "none"}.`,
    `Checked ${formatAvailabilityAge(Math.max(0, now - oldest))}. Availability is revalidated again immediately before each dispatch.`,
  ].join("\n");
}

function formatAvailabilityAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 1) return "just now";
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/**
 * Thrown when a harness cannot be routed to because of its normalized
 * availability. Carries the classification so callers (workflow journal,
 * dashboard) can record structured evidence rather than reparsing a message.
 */
export class HarnessUnavailableError extends Error {
  readonly harness: HarnessName;
  readonly status: HarnessAvailabilityStatus;
  readonly availability: HarnessAvailability;
  constructor(availability: HarnessAvailability) {
    super(describeUnavailable(availability));
    this.name = "HarnessUnavailableError";
    this.harness = availability.harness;
    this.status = availability.status;
    this.availability = availability;
  }
}

/** Structured evidence when auto routing has no ready candidate. */
export class HarnessAutoUnavailableError extends Error {
  readonly availabilities: HarnessAvailability[];

  constructor(availabilities: HarnessAvailability[]) {
    super(`harness:auto found no ready harness — ${availabilities.map(describeUnavailable).join("; ")}`);
    this.name = "HarnessAutoUnavailableError";
    this.availabilities = availabilities;
  }
}

/** Actionable, provider-neutral one-liner for an explicit fail-closed route. */
export function describeUnavailable(availability: HarnessAvailability): string {
  const label = availabilityLabel(availability.status);
  const reason = availability.reason ? `: ${availability.reason}` : "";
  return `${availability.harness} is not ready (${label})${reason}. ${availabilityGuidance(availability.status)}`;
}

/** Safe remediation text. Discovery reports actions but never performs them. */
export function availabilityGuidance(status: HarnessAvailabilityStatus): string {
  switch (status) {
    case "ready": return "No action is required.";
    case "missing": return "Install the native CLI and ensure its executable is on PATH, then retry.";
    case "unauthenticated": return "Authenticate with the native CLI, then retry.";
    case "incompatible": return "Use a supported native login or CLI version, then retry.";
    case "unhealthy": return "Retry the status check and inspect the native CLI directly if the failure persists.";
    case "unknown": return "Run /subagents providers refresh and retry when readiness can be confirmed.";
  }
}

export interface HarnessAvailabilityRequest {
  cwd: string;
  /** Bypass the bounded status cache — used for the authoritative pre-dispatch recheck. */
  refresh?: boolean;
  signal?: AbortSignal;
  harnesses?: HarnessName[];
  /**
   * Harnesses the user has explicitly disabled. Enabled is "not disabled": a
   * disabled harness is reported distinctly and never counted active, even when
   * its probe reports ready.
   */
  disabled?: Iterable<HarnessName>;
}

/**
 * Read-only, zero-model-turn availability discovery layered on the existing
 * {@link ProviderStatusReader}. It adds no new subsystem: every probe is the
 * same cached, bounded provider-status probe, reprojected into the normalized
 * availability shape. Startup uses {@link discover}; dispatch uses
 * {@link availability} with `refresh` to revalidate the selected harness.
 */
export class HarnessAvailabilityService {
  readonly #status: ProviderStatusReader;
  readonly #harnesses: HarnessName[];
  readonly #timeoutMs: number;
  readonly #now: () => number;
  constructor(status: ProviderStatusReader, options: {
    harnesses?: HarnessName[];
    timeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.#status = status;
    this.#harnesses = [...new Set(options.harnesses ?? ["pi", "claude", "codex"])] as HarnessName[];
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS);
    this.#now = options.now ?? Date.now;
  }

  get harnesses(): HarnessName[] {
    return [...this.#harnesses];
  }

  /** Normalized availability for one harness, revalidated live when `refresh` is set. */
  async availability(harness: HarnessName, request: { cwd: string; refresh?: boolean; signal?: AbortSignal }): Promise<HarnessAvailability> {
    try {
      const statuses = await this.#boundedStatuses([harness], request);
      const status = statuses.find((candidate) => candidate.harness === harness);
      if (!status) throw new Error(`availability probe returned no status for ${harness}`);
      return harnessAvailability(status);
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      return this.#unknown(harness, error);
    }
  }

  /** Bounded, read-only startup scan across supported harnesses. */
  async discover(request: HarnessAvailabilityRequest): Promise<HarnessAvailability[]> {
    const harnesses = request.harnesses ?? this.#harnesses;
    try {
      const statuses = await this.#boundedStatuses(harnesses, request);
      return harnesses.map((harness) => {
        const status = statuses.find((candidate) => candidate.harness === harness);
        return status ? harnessAvailability(status) : this.#unknown(harness, `availability probe returned no status for ${harness}`);
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      return harnesses.map((harness) => this.#unknown(harness, error));
    }
  }

  /**
   * Full lifecycle view across supported harnesses, folding in the user's enable
   * state so callers can read the active set and render a status surface from a
   * single bounded scan. Startup discovery and the dashboard both use this.
   */
  async activations(request: HarnessAvailabilityRequest): Promise<HarnessActivation[]> {
    const disabled = new Set(request.disabled ?? []);
    const availabilities = await this.discover(request);
    return availabilities.map((availability) => harnessActivation(availability, !disabled.has(availability.harness)));
  }

  invalidate(): void {
    this.#status.invalidate?.();
  }

  async #boundedStatuses(
    harnesses: HarnessName[],
    request: { cwd: string; refresh?: boolean; signal?: AbortSignal },
  ): Promise<ProviderStatus[]> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("Availability probe aborted");
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason ?? new Error("Availability probe aborted"));
    request.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      // Keep the timer referenced: it is the only thing that can settle the race
      // when the reader never resolves, so unref'ing it would let the event loop
      // drain and leave this promise pending. The `finally` always clears it, so
      // the reference is bounded by `#timeoutMs` and never leaks past the probe.
      timer = setTimeout(() => {
        const error = new Error(`${harnesses.join(", ")} availability probe timed out after ${this.#timeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([
        this.#status.statuses({
          cwd: request.cwd,
          refresh: request.refresh,
          signal: controller.signal,
          harnesses,
        }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  #unknown(harness: HarnessName, error: unknown): HarnessAvailability {
    return {
      harness,
      status: "unknown",
      detected: false,
      ready: false,
      reason: maskEmbeddedEmails(error instanceof Error ? error.message : String(error)).slice(0, 300),
      checkedAt: this.#now(),
    };
  }
}

/** Structural probe used by capability routing so callers depend on a narrow surface. */
export interface HarnessAvailabilityProbe {
  /** Supported adapter names, exposed without running discovery. */
  readonly harnesses: HarnessName[];
  availability(harness: HarnessName, request: { cwd: string; refresh?: boolean; signal?: AbortSignal }): Promise<HarnessAvailability>;
}
