import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROVIDER_WAIT_CEILING_MS,
  normalizeRetryAt,
  providerUnavailabilityDetail,
  waitDecision,
  type ProviderUnavailability,
} from "../src/provider-unavailability.ts";

const NOW = 1_700_000_000_000;

test("normalizeRetryAt accepts seconds, milliseconds, and ISO strings within the ceiling", () => {
  const seconds = Math.floor((NOW + 60_000) / 1_000);
  assert.equal(normalizeRetryAt(seconds, NOW), seconds * 1_000);
  assert.equal(normalizeRetryAt(NOW + 60_000, NOW), NOW + 60_000);
  const iso = new Date(NOW + 90_000).toISOString();
  assert.equal(normalizeRetryAt(iso, NOW), NOW + 90_000);
});

test("normalizeRetryAt rejects past, implausible, absent, and out-of-bounds values", () => {
  assert.equal(normalizeRetryAt(undefined, NOW), undefined);
  assert.equal(normalizeRetryAt(null, NOW), undefined);
  assert.equal(normalizeRetryAt("not a date", NOW), undefined);
  assert.equal(normalizeRetryAt(NOW - 1_000, NOW), undefined, "past timestamps are not authoritative");
  assert.equal(normalizeRetryAt(NOW, NOW), undefined, "exactly now is not a future retry time");
  assert.equal(
    normalizeRetryAt(NOW + MAX_PROVIDER_WAIT_CEILING_MS + 1, NOW),
    undefined,
    "beyond the package wait ceiling is never authoritative, regardless of provider",
  );
  assert.equal(normalizeRetryAt(NOW + MAX_PROVIDER_WAIT_CEILING_MS, NOW), NOW + MAX_PROVIDER_WAIT_CEILING_MS);
});

test("providerUnavailabilityDetail masks embedded emails and bounds length", () => {
  const detail = providerUnavailabilityDetail(`Reported by someone@example.com   with   extra   spaces`, 40);
  assert.ok(!detail.includes("someone@example.com"));
  assert.ok(detail.includes("s***@example.com"));
  assert.ok(detail.length <= 40);
});

function fakeUnavailable(overrides: Partial<ProviderUnavailability> = {}): ProviderUnavailability {
  return {
    provider: "claude",
    kind: "quota",
    authoritative: true,
    retryAt: NOW + 60_000,
    detail: "Claude reported a rate_limit rejection",
    ...overrides,
  };
}

test("waitDecision refuses to wait when the unavailability is not authoritative", () => {
  const decision = waitDecision({
    unavailable: fakeUnavailable({ authoritative: false, retryAt: undefined }),
    now: NOW,
    attempt: 0,
    maxAttempts: 3,
    remainingWaitMs: 10 * 60_000,
  });
  assert.equal(decision.wait, false);
  if (!decision.wait) assert.match(decision.reason, /authoritative retry time/);
});

test("waitDecision refuses once attempts are exhausted", () => {
  const decision = waitDecision({
    unavailable: fakeUnavailable(),
    now: NOW,
    attempt: 2,
    maxAttempts: 2,
    remainingWaitMs: 10 * 60_000,
  });
  assert.equal(decision.wait, false);
  if (!decision.wait) assert.match(decision.reason, /attempt 2\/2/);
});

test("waitDecision refuses when the retry window exceeds the remaining wait budget", () => {
  const decision = waitDecision({
    unavailable: fakeUnavailable({ retryAt: NOW + 5 * 60_000 }),
    now: NOW,
    attempt: 0,
    maxAttempts: 3,
    remainingWaitMs: 60_000,
  });
  assert.equal(decision.wait, false);
  if (!decision.wait) assert.match(decision.reason, /maxWaitMs allowance/);
});

test("waitDecision approves an authoritative, in-budget, non-exhausted wait", () => {
  const decision = waitDecision({
    unavailable: fakeUnavailable({ retryAt: NOW + 5 * 60_000 }),
    now: NOW,
    attempt: 0,
    maxAttempts: 3,
    remainingWaitMs: 10 * 60_000,
  });
  assert.deepEqual(decision, { wait: true, until: NOW + 5 * 60_000 });
});
