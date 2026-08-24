import { maskEmbeddedEmails } from "./provider-status.ts";
import type { ProviderFamily } from "./types.ts";

/** Reserved for future temporary-unavailability kinds; only quota exhaustion is classified today. */
export type ProviderUnavailabilityKind = "quota";

/**
 * Provider-neutral, structured signal that a call was rejected because the
 * provider reports it is temporarily out of capacity. Never carries plan
 * names, account identifiers, or provider-specific window lengths — only a
 * bounded, masked `detail` string and an optional provider-supplied `scope`
 * label (e.g. Claude's `five_hour`).
 */
export interface ProviderUnavailability {
  provider: ProviderFamily;
  kind: ProviderUnavailabilityKind;
  /** Epoch ms; present only when the provider itself reported a plausible reset time. */
  retryAt?: number;
  /** True only when `retryAt` came from a structured provider field within sane bounds. */
  authoritative: boolean;
  /** Bounded provider-supplied window label. Never plan/account data. */
  scope?: string;
  /** Bounded, email-masked reason for display. */
  detail: string;
}

/**
 * Ceiling on how long this package will ever wait for any provider. This is a
 * safety bound on the scheduler's own patience, not a Claude/Codex window
 * length, and it applies identically to every provider.
 */
export const MAX_PROVIDER_WAIT_CEILING_MS = 6 * 60 * 60 * 1000;

/** Values below this, interpreted as milliseconds, would predate the year 2001; treat them as seconds instead. */
const SECONDS_VS_MS_THRESHOLD = 1e11;

/**
 * Normalizes a provider-reported retry time with no provider-specific
 * knowledge: accepts a finite epoch number (seconds or milliseconds) or an
 * ISO-8601 string, and rejects anything not strictly within
 * `(now, now + MAX_PROVIDER_WAIT_CEILING_MS]`. Returns `undefined` for any
 * value this package cannot trust, which callers must treat as non-authoritative.
 */
export function normalizeRetryAt(value: unknown, now: number): number | undefined {
  let ms: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value < SECONDS_VS_MS_THRESHOLD ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms <= now || ms > now + MAX_PROVIDER_WAIT_CEILING_MS) return undefined;
  return ms;
}

/** Bounded, whitespace-normalized, email-masked text safe to persist and render. */
export function providerUnavailabilityDetail(text: string, maxLength = 300): string {
  return maskEmbeddedEmails(text.replace(/\s+/g, " ").trim()).slice(0, maxLength);
}

export type ProviderWaitDecision = { wait: true; until: number } | { wait: false; reason: string };

/**
 * Whether a classified unavailability is eligible for an automatic wait, given
 * only provider-neutral facts: an authoritative retry time, attempts already
 * spent, and the wait budget remaining for this logical call. Callers are
 * responsible for additional workflow-specific safety checks (e.g. whether the
 * failed attempt produced observable model/tool progress) before honoring `wait: true`.
 */
export function waitDecision(input: {
  unavailable: ProviderUnavailability;
  now: number;
  attempt: number;
  maxAttempts: number;
  remainingWaitMs: number;
}): ProviderWaitDecision {
  const { unavailable, now, attempt, maxAttempts, remainingWaitMs } = input;
  if (!unavailable.authoritative || unavailable.retryAt === undefined) {
    return { wait: false, reason: `Provider ${unavailable.provider} reported unavailability without an authoritative retry time; not waiting automatically.` };
  }
  if (attempt >= maxAttempts) {
    return { wait: false, reason: `Workflow provider wait exhausted (attempt ${attempt}/${maxAttempts})` };
  }
  const waitMs = unavailable.retryAt - now;
  if (waitMs > remainingWaitMs) {
    return { wait: false, reason: `Provider ${unavailable.provider} retry window exceeds the workflow maxWaitMs allowance (needs ${waitMs}ms, ${remainingWaitMs}ms remaining)` };
  }
  return { wait: true, until: unavailable.retryAt };
}
