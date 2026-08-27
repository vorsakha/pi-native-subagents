import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderStatus } from "../src/provider-status.ts";
import {
  activeHarnesses,
  availabilityLabel,
  describeUnavailable,
  explicitBlocked,
  formatHarnessAvailabilityReport,
  harnessActivation,
  harnessActivations,
  harnessAvailability,
  harnessAvailabilityStatus,
  HarnessAvailabilityService,
  HarnessUnavailableError,
} from "../src/harness-availability.ts";
import type { HarnessName } from "../src/types.ts";
import { ScriptedProviderStatusReader } from "./helpers.ts";

function status(overrides: Partial<ProviderStatus> & { harness: HarnessName }): ProviderStatus {
  return {
    installed: true,
    authenticated: false,
    ready: false,
    checkedAt: 1_000,
    probe: "test",
    ...overrides,
  };
}

test("provider status normalizes into distinct availability states without a new probe", () => {
  assert.equal(harnessAvailabilityStatus(status({ harness: "claude", installed: false })), "missing");
  assert.equal(harnessAvailabilityStatus(status({ harness: "codex", installed: true, probeFailed: true })), "unhealthy");
  assert.equal(harnessAvailabilityStatus(status({ harness: "claude", installed: true, authenticated: false })), "unauthenticated");
  assert.equal(harnessAvailabilityStatus(status({ harness: "codex", installed: true, authenticated: true, ready: false })), "incompatible");
  assert.equal(harnessAvailabilityStatus(status({
    harness: "claude", installed: true, authenticated: false, compatible: false, version: "0.1.0",
  })), "incompatible", "an authoritative version incompatibility wins over auth state");
  assert.equal(harnessAvailabilityStatus(status({ harness: "claude", ready: true, installed: true, authenticated: true })), "ready");
  // Pi exposes no interactive account, so an installed-but-unready Pi is deferred, never "log in".
  assert.equal(harnessAvailabilityStatus(status({ harness: "pi", installed: true, authenticated: false })), "unknown");
  // A probe that never found the CLI is missing even if it also flagged a failure.
  assert.equal(harnessAvailabilityStatus(status({ harness: "codex", installed: false, probeFailed: true })), "missing");
});

test("availability carries the detected flag, ready convenience, and a bounded email-masked reason", () => {
  const missing = harnessAvailability(status({ harness: "claude", installed: false, detail: "claude CLI was not found on PATH" }));
  assert.equal(missing.detected, false);
  assert.equal(missing.ready, false);
  assert.equal(missing.status, "missing");

  const ready = harnessAvailability(status({ harness: "claude", installed: true, authenticated: true, ready: true }));
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, undefined, "a ready harness carries no failure reason");

  const versioned = harnessAvailability(status({
    harness: "codex", installed: true, authenticated: true, ready: true, version: "1.2.3",
  }));
  assert.equal(versioned.version, "1.2.3");

  // Sanitation: any address embedded in a provider detail is masked in the reason.
  const leaky = harnessAvailability(status({
    harness: "codex", installed: true, authenticated: true, ready: false,
    detail: "login engineer@example.com is not usable   for a subagent",
  }));
  assert.ok(!leaky.reason?.includes("engineer@example.com"), "the reason never reproduces a full address");
  assert.match(leaky.reason ?? "", /e\*\*\*@example\.com/);
  assert.ok(!/\s{2,}/.test(leaky.reason ?? ""), "the reason is whitespace-normalized");
});

test("explicit routes fail closed on every state except ready", () => {
  for (const blocked of ["missing", "unauthenticated", "incompatible", "unhealthy", "unknown"] as const) assert.equal(explicitBlocked(blocked), true);
  assert.equal(explicitBlocked("ready"), false);
});

test("active harnesses are exactly the enabled and ready ones", () => {
  const readyClaude = harnessActivation(harnessAvailability(status({ harness: "claude", installed: true, authenticated: true, ready: true })), true);
  const disabledCodex = harnessActivation(harnessAvailability(status({ harness: "codex", installed: true, authenticated: true, ready: true })), false);
  const unreadyPi = harnessActivation(harnessAvailability(status({ harness: "pi", installed: true })), true);
  assert.equal(readyClaude.active, true);
  assert.equal(disabledCodex.active, false, "a disabled harness is never active even when ready");
  assert.equal(disabledCodex.ready, true);
  assert.equal(unreadyPi.active, false, "an enabled but unready harness is not active");
  assert.deepEqual(activeHarnesses([readyClaude, disabledCodex, unreadyPi]), ["claude"]);
});

test("the service reprobes on refresh so a stale startup readiness cannot outlive a logout", async () => {
  const reader = new ScriptedProviderStatusReader(new Map([
    ["claude", [
      status({ harness: "claude", installed: true, authenticated: true, ready: true, checkedAt: 1_000 }),
      status({ harness: "claude", installed: true, authenticated: false, ready: false, checkedAt: 2_000, detail: "Claude Code is not logged in" }),
    ]],
  ]));
  const service = new HarnessAvailabilityService(reader);

  const [startup] = await service.discover({ cwd: "/proj", harnesses: ["claude"] });
  assert.equal(startup!.status, "ready");

  const live = await service.availability("claude", { cwd: "/proj", refresh: true });
  assert.equal(live.status, "unauthenticated", "the pre-dispatch recheck observes the logout the startup scan missed");
  assert.equal(reader.requests.at(-1)?.refresh, true, "the recheck bypasses the cache");

  service.invalidate();
  assert.equal(reader.invalidated, 1);
});

test("availability discovery has an outer deadline even when an injected reader never settles", async () => {
  const service = new HarnessAvailabilityService({
    statuses: async () => new Promise<ProviderStatus[]>(() => undefined),
  }, { harnesses: ["claude"], timeoutMs: 5, now: () => 9_000 });
  const started = Date.now();
  const [availability] = await service.discover({ cwd: "/proj" });
  assert.ok(Date.now() - started < 500, "startup discovery returns within its configured deadline");
  assert.equal(availability?.status, "unknown");
  assert.match(availability?.reason ?? "", /timed out after 5ms/);
});

test("the availability report states every normalized state accessibly and never by color alone", async () => {
  const activations = harnessActivations([
    status({ harness: "pi", installed: true, authenticated: true, ready: true }),
    status({ harness: "claude", installed: true, authenticated: false, detail: "Claude Code is not logged in" }),
    status({ harness: "codex", installed: false, detail: "codex CLI was not found on PATH" }),
  ], ["codex"]);
  const report = formatHarnessAvailabilityReport(activations, 1_000);
  assert.match(report, /no model request was made/);
  assert.match(report, /pi\s+active\s+ready/);
  assert.match(report, /claude\s+inactive\s+login required/);
  assert.match(report, /codex\s+inactive\s+disabled by user/, "a disabled harness is labeled distinctly from its probe result");
  assert.match(report, /Active harnesses: pi\./);
  assert.match(report, /revalidated again immediately before each dispatch/);
  // Labels are the accessible carrier of state; none of them is color markup.
  assert.equal(availabilityLabel("missing"), "missing executable");
  assert.equal(availabilityLabel("incompatible"), "incompatible");
});

test("HarnessUnavailableError carries structured classification and an actionable one-liner", () => {
  const availability = harnessAvailability(status({ harness: "claude", installed: true, authenticated: false, detail: "Claude Code is not logged in" }));
  const error = new HarnessUnavailableError(availability);
  assert.equal(error.harness, "claude");
  assert.equal(error.status, "unauthenticated");
  assert.equal(error.availability, availability);
  assert.match(describeUnavailable(availability), /claude is not ready \(login required\): Claude Code is not logged in/);
  assert.match(error.message, /Authenticate with the native CLI, then retry/);
});
