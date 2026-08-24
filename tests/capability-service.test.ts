import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityService } from "../src/capability-service.ts";
import type { DiscoveredCapability } from "../src/capabilities.ts";
import type { Backend, DiscoveryRequest, DiscoveryResult, HarnessName, StructuredOutputSupport } from "../src/types.ts";

class FakeBackend implements Backend {
  readonly name: HarnessName;
  calls = 0;
  refreshFlags: boolean[] = [];
  #capabilities: DiscoveredCapability[];
  #healthy: boolean;
  #hang = false;
  #abortedCalls = 0;

  constructor(name: HarnessName, capabilities: DiscoveredCapability[] = [], options: { healthy?: boolean; hang?: boolean } = {}) {
    this.name = name;
    this.#capabilities = capabilities;
    this.#healthy = options.healthy ?? true;
    this.#hang = options.hang ?? false;
  }

  async start(): Promise<never> {
    throw new Error("not used by capability-service tests");
  }

  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    this.calls++;
    this.refreshFlags.push(request.refresh);
    if (this.#hang) {
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => { this.#abortedCalls++; reject(request.signal.reason); }, { once: true });
      });
    }
    if (!this.#healthy) throw new Error("discovery backend exploded");
    return { capabilities: this.#capabilities, sources: [{ source: `${this.name}-fixture`, health: "healthy" }] };
  }

  get abortedCalls(): number {
    return this.#abortedCalls;
  }
}

function request(overrides: Partial<{ cwd: string; access: "readOnly" | "full" }> = {}) {
  return { cwd: overrides.cwd ?? "/proj", access: overrides.access ?? "full" as const };
}

test("catalog serves from cache within the TTL and refetches once the fingerprint changes", async () => {
  const backend = new FakeBackend("codex", [{ kind: "tool", name: "Read" }]);
  let fingerprint = "v1";
  const service = new CapabilityService({ backends: [backend], fingerprint: () => fingerprint, ttlMs: 60_000 });
  const first = await service.catalog("codex", request());
  const second = await service.catalog("codex", request());
  assert.equal(backend.calls, 1, "an unchanged fingerprint within the TTL is served from cache");
  assert.equal(first, second, "cached catalogs are referentially identical");

  fingerprint = "v2";
  const third = await service.catalog("codex", request());
  assert.equal(backend.calls, 2, "a changed fingerprint invalidates the cache entry");
  assert.notEqual(third, second);
});

test("catalog expires by TTL and refresh:true always bypasses the cache", async () => {
  const backend = new FakeBackend("codex", []);
  let now = 0;
  const service = new CapabilityService({ backends: [backend], now: () => now, ttlMs: 1_000, fingerprint: () => "stable" });
  await service.catalog("codex", request());
  now = 500;
  await service.catalog("codex", request());
  assert.equal(backend.calls, 1, "a request inside the TTL window is cached");
  now = 1_500;
  await service.catalog("codex", request());
  assert.equal(backend.calls, 2, "a request past the TTL refetches");
  await service.catalog("codex", { ...request(), refresh: true });
  assert.equal(backend.calls, 3, "refresh:true always bypasses the cache");
});

test("concurrent catalog calls for the same key share one in-flight discovery", async () => {
  const backend = new FakeBackend("codex", []);
  const service = new CapabilityService({ backends: [backend], fingerprint: () => "stable" });
  const [a, b] = await Promise.all([service.catalog("codex", request()), service.catalog("codex", request())]);
  assert.equal(backend.calls, 1, "two concurrent requests for the same cache key share one discovery call");
  assert.equal(a, b);
});

test("a slower stale discovery cannot overwrite a newer forced refresh", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const backend: Backend = {
    name: "codex",
    async start() { throw new Error("unused"); },
    async discover() {
      calls++;
      if (calls === 1) {
        await firstGate;
        return { capabilities: [{ kind: "tool", name: "Old" }], sources: [{ source: "fixture", health: "healthy" }] };
      }
      return { capabilities: [{ kind: "tool", name: "New" }], sources: [{ source: "fixture", health: "healthy" }] };
    },
  };
  const service = new CapabilityService({ backends: [backend], fingerprint: () => "stable", ttlMs: 60_000 });
  const stale = service.catalog("codex", request());
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
  const fresh = await service.catalog("codex", { ...request(), refresh: true });
  releaseFirst();
  await stale;
  const cached = await service.catalog("codex", request());
  assert.equal(fresh.capabilities[0]!.name, "New");
  assert.equal(cached.capabilities[0]!.name, "New", "the older completion must not replace the refreshed cache entry");
});

test("invalidate clears one harness or the whole cache", async () => {
  const codex = new FakeBackend("codex", []);
  const claude = new FakeBackend("claude", []);
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
  await service.catalog("codex", request());
  await service.catalog("claude", request());
  service.invalidate("codex");
  await service.catalog("codex", request());
  await service.catalog("claude", request());
  assert.equal(codex.calls, 2, "invalidating one harness drops only its cache entries");
  assert.equal(claude.calls, 1);

  service.invalidate();
  await service.catalog("codex", request());
  await service.catalog("claude", request());
  assert.equal(codex.calls, 3);
  assert.equal(claude.calls, 2, "invalidate() with no argument clears every harness");
});

test("catalog degrades to an unknown, empty catalog with a warning when a backend has no discover()", async () => {
  const backend: Backend = { name: "pi", async start() { throw new Error("unused"); } };
  const service = new CapabilityService({ backends: [backend] });
  const catalog = await service.catalog("pi", request());
  assert.equal(catalog.capabilities.length, 0);
  assert.equal(catalog.health, "unknown");
  assert.match(catalog.warnings.join(" "), /does not expose a capability inventory/);
});

test("catalog reports unavailable health and a warning when discovery throws", async () => {
  const backend = new FakeBackend("codex", [], { healthy: false });
  const service = new CapabilityService({ backends: [backend], fingerprint: () => "stable" });
  const catalog = await service.catalog("codex", request());
  assert.equal(catalog.health, "unavailable");
  assert.match(catalog.warnings.join(" "), /capability discovery failed: discovery backend exploded/);
});

test("discovery is bounded by an internal timeout that aborts the backend", async () => {
  const backend = new FakeBackend("codex", [], { hang: true });
  const service = new CapabilityService({ backends: [backend], fingerprint: () => "stable", discoveryTimeoutMs: 1_000 });
  const catalog = await service.catalog("codex", request());
  assert.equal(catalog.health, "unavailable");
  assert.match(catalog.warnings.join(" "), /timed out after 1000ms/);
  assert.equal(backend.abortedCalls, 1);
});

test("catalogs() aggregates every configured backend or a requested subset", async () => {
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Read" }]);
  const claude = new FakeBackend("claude", [{ kind: "tool", name: "Write" }]);
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
  const all = await service.catalogs(request());
  assert.deepEqual(all.map((catalog) => catalog.harness).sort(), ["claude", "codex"]);
  const scoped = await service.catalogs({ ...request(), harnesses: ["claude"] });
  assert.deepEqual(scoped.map((catalog) => catalog.harness), ["claude"]);
});

test("search() aggregates catalogs and defers filtering to searchCapabilities", async () => {
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Read", description: "read files" }]);
  const claude = new FakeBackend("claude", [{ kind: "tool", name: "Write" }]);
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
  const result = await service.search({ ...request(), query: "read" });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.capability.harness, "codex");
  assert.equal(result.catalogs.length, 2, "search still returns every discovered catalog for summary reporting");
});

test("resolveRoute rejects unavailable explicit harnesses while allowing auth/health-based auto selection", async () => {
  const codex = new FakeBackend("codex", []);
  const service = new CapabilityService({ backends: [codex], fingerprint: () => "stable" });
  await assert.rejects(service.resolveRoute({ ...request(), harness: "claude", requires: [] }), /Harness is unavailable: claude/);
  const auto = await service.resolveRoute({ ...request(), harness: "auto", requires: [] });
  assert.equal(auto.harness, "codex", "auto selection can use a healthy catalog even without a capability requirement");
  assert.equal(auto.auto, true);
  await assert.rejects(service.resolveRoute({ ...request(), requires: ["codex:tool:read"] }), /explicit harness or harness auto/);
});

test("resolveRoute on an explicit harness returns matched capabilities and fails closed with alternatives when unsatisfied", async () => {
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Read" }]);
  const claude = new FakeBackend("claude", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });

  const resolved = await service.resolveRoute({ ...request(), harness: "codex", requires: ["codex:tool:read"] });
  assert.equal(resolved.harness, "codex");
  assert.deepEqual(resolved.route.matched, ["codex:tool:read"]);
  assert.equal(resolved.route.auto, undefined);
  assert.equal(resolved.route.revision, resolved.catalog.revision);

  await assert.rejects(
    service.resolveRoute({ ...request(), harness: "codex", requires: ["codex:tool:lint"] }),
    /Selected harness cannot satisfy the required capabilities: codex:tool:lint.*available on: claude/s,
  );
});

test("resolveRoute with harness auto follows the preference order among capable, healthy candidates", async () => {
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const claude = new FakeBackend("claude", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });

  const preferClaude = await service.resolveRoute({ ...request(), harness: "auto", requires: ["tool:lint"], preference: ["claude"] });
  assert.equal(preferClaude.harness, "claude");
  assert.equal(preferClaude.auto, true);
  assert.equal(preferClaude.route.auto, true);

  const preferCodex = await service.resolveRoute({ ...request(), harness: "auto", requires: ["tool:lint"], preference: ["codex"] });
  assert.equal(preferCodex.harness, "codex");
});

test("resolveRoute with harness auto skips a candidate whose discovery is unavailable and one with only a partial match", async () => {
  const brokenCodex = new FakeBackend("codex", [], { healthy: false });
  const partialClaude = new FakeBackend("claude", [{ kind: "tool", name: "Read" }]);
  const capableCodexAlt = new FakeBackend("pi", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [brokenCodex, partialClaude, capableCodexAlt], fingerprint: () => "stable" });
  const routed = await service.resolveRoute({ ...request(), harness: "auto", requires: ["tool:lint"] });
  assert.equal(routed.harness, "pi");
});

test("resolveRoute honors a restricted candidate list from independence/profile filtering", async () => {
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const claude = new FakeBackend("claude", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
  const routed = await service.resolveRoute({ ...request(), harness: "auto", requires: ["tool:lint"], candidates: ["claude"] });
  assert.equal(routed.harness, "claude");
  await assert.rejects(
    service.resolveRoute({ ...request(), harness: "auto", requires: ["tool:lint"], candidates: [] }),
    /No harness candidate remains after policy filtering/,
  );
});

test("revalidate always bypasses the cache even when called immediately after a cached catalog() read", async () => {
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [codex], fingerprint: () => "stable" });
  await service.catalog("codex", request());
  assert.equal(codex.calls, 1);
  await service.revalidate({ ...request(), harness: "codex", requires: ["tool:lint"] });
  assert.equal(codex.calls, 2, "revalidate performs a fresh, uncached discovery");
  assert.equal(codex.refreshFlags.at(-1), true, "the backend receives refresh:true on revalidation");
});

test("route() compares candidates from the browse cache, then live-revalidates only the winner before dispatch", async () => {
  const claude = new FakeBackend("claude", []);
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [claude, codex], fingerprint: () => "stable" });
  const routed = await service.route({ ...request(), harness: "auto", requires: ["tool:lint"], preference: ["claude", "codex"] });
  assert.equal(routed.harness, "codex");
  assert.equal(claude.calls, 1, "the losing candidate ahead in preference order is only browsed, never revalidated");
  assert.equal(codex.calls, 2, "the winning candidate is browsed once and then revalidated live");
  assert.equal(codex.refreshFlags.at(-1), true);
  assert.equal(routed.route.auto, true, "auto provenance survives the live revalidation pass");
});

test("route() failover refreshes the candidate set when the preferred auto route becomes unhealthy", async () => {
  let calls = 0;
  const flaky = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const fallback = new FakeBackend("claude", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const original = flaky.discover.bind(flaky);
  flaky.discover = async (req) => {
    calls++;
    if (calls === 1) return original(req);
    throw new Error("authentication_failed");
  };
  const service = new CapabilityService({ backends: [flaky, fallback], fingerprint: () => "stable" });
  const routed = await service.route({ ...request(), harness: "auto", requires: ["tool:lint"], preference: ["codex", "claude"] });
  assert.equal(routed.harness, "claude");
  assert.equal(calls, 2, "the unhealthy preferred provider is refreshed once and then skipped");
  assert.equal(flaky.calls, 1, "the unhealthy preferred provider is not retried after live failure");
  assert.equal(fallback.calls, 2, "the fallback provider is browsed and live revalidated");
});

test("route() keeps explicit auth failures fail-closed", async () => {
  let discoveries = 0;
  const claude = new FakeBackend("claude", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const codex = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  codex.discover = async (request) => {
    discoveries++;
    if (discoveries > 1) throw new Error("authentication_failed");
    return { capabilities: [{ kind: "tool", name: "Lint", effect: "inspect" }], sources: [{ source: "codex-fixture", health: "healthy" }] };
  };
  const service = new CapabilityService({ backends: [codex, claude], fingerprint: () => "stable" });
  await assert.rejects(
    service.route({ ...request(), harness: "codex", requires: ["tool:lint"] }),
    /Selected harness cannot satisfy the required capabilities/,
  );
  assert.equal(claude.calls, 0, "an explicit provider failure never falls over to another provider");
});

test("route() failover also covers auto routing without explicit requirements", async () => {
  let flakyDiscoveries = 0;
  const flaky = new FakeBackend("codex", []);
  const fallback = new FakeBackend("claude", []);
  flaky.discover = async (request) => {
    flakyDiscoveries++;
    if (flakyDiscoveries > 1) throw new Error("authentication_failed");
    return { capabilities: [], sources: [{ source: "codex-fixture", health: "healthy" }] };
  };
  const service = new CapabilityService({ backends: [flaky, fallback], fingerprint: () => "stable" });
  const routed = await service.route({ ...request(), harness: "auto", preference: ["codex", "claude"] });
  assert.equal(routed.harness, "claude");
  assert.equal(flakyDiscoveries, 2, "auth failure is not retried after the initial live route check");
  assert.equal(fallback.calls, 2, "the fallback route is browsed and live revalidated");
});

test("route() live-revalidation catches a capability that disappeared between browse and dispatch", async () => {
  const flaky = new FakeBackend("codex", [{ kind: "tool", name: "Lint", effect: "inspect" }]);
  const service = new CapabilityService({ backends: [flaky], fingerprint: () => "stable" });
  const original = flaky.discover.bind(flaky);
  let call = 0;
  flaky.discover = async (req) => {
    call++;
    if (call === 1) return original(req);
    return { capabilities: [], sources: [{ source: "codex-fixture", health: "healthy" }] };
  };
  await assert.rejects(
    service.route({ ...request(), harness: "codex", requires: ["codex:tool:lint"] }),
    /Selected harness cannot satisfy the required capabilities/,
  );
});

class StructuredOutputBackend extends FakeBackend {
  calls = 0;
  #support: StructuredOutputSupport;

  constructor(name: HarnessName, support: StructuredOutputSupport) {
    super(name);
    this.#support = support;
  }

  async structuredOutputSupport(): Promise<StructuredOutputSupport> {
    this.calls++;
    return this.#support;
  }
}

test("structuredOutput serves from cache within the TTL and refetches once the fingerprint changes", async () => {
  const backend = new StructuredOutputBackend("claude", { supported: true, mechanism: "fixture" });
  let fingerprint = "v1";
  const service = new CapabilityService({ backends: [backend], fingerprint: () => fingerprint, ttlMs: 60_000 });
  const first = await service.structuredOutput("claude", request());
  const second = await service.structuredOutput("claude", request());
  assert.equal(backend.calls, 1, "an unchanged fingerprint within the TTL is served from cache");
  assert.deepEqual(first, second);

  fingerprint = "v2";
  await service.structuredOutput("claude", request());
  assert.equal(backend.calls, 2, "a changed fingerprint invalidates the cached probe");
});

test("structuredOutput reports unsupported without throwing when the backend has no probe, the probe throws, or it times out", async () => {
  const noProbe: Backend = { name: "pi", async start() { throw new Error("unused"); } };
  const noProbeService = new CapabilityService({ backends: [noProbe], fingerprint: () => "stable" });
  const noProbeResult = await noProbeService.structuredOutput("pi", request());
  assert.equal(noProbeResult.supported, false);
  assert.match(noProbeResult.detail ?? "", /does not expose native structured-result detection/);

  const throwing: Backend = {
    name: "codex",
    async start() { throw new Error("unused"); },
    async structuredOutputSupport() { throw new Error("probe exploded"); },
  };
  const throwingService = new CapabilityService({ backends: [throwing], fingerprint: () => "stable" });
  const throwingResult = await throwingService.structuredOutput("codex", request());
  assert.equal(throwingResult.supported, false);
  assert.match(throwingResult.detail ?? "", /probe exploded/);

  const hanging: Backend = {
    name: "claude",
    async start() { throw new Error("unused"); },
    async structuredOutputSupport(discoveryRequest) {
      return new Promise((_resolve, reject) => {
        discoveryRequest.signal.addEventListener("abort", () => reject(discoveryRequest.signal.reason), { once: true });
      });
    },
  };
  const hangingService = new CapabilityService({ backends: [hanging], fingerprint: () => "stable", discoveryTimeoutMs: 1_000 });
  const hangingResult = await hangingService.structuredOutput("claude", request());
  assert.equal(hangingResult.supported, false);
  assert.match(hangingResult.detail ?? "", /timed out after 1000ms/);
});

test("structuredOutput de-duplicates concurrent probes for the same key and invalidate() clears its cache too", async () => {
  const backend = new StructuredOutputBackend("claude", { supported: true });
  const service = new CapabilityService({ backends: [backend], fingerprint: () => "stable" });
  const [a, b] = await Promise.all([service.structuredOutput("claude", request()), service.structuredOutput("claude", request())]);
  assert.equal(backend.calls, 1, "two concurrent probes for the same cache key share one call");
  assert.deepEqual(a, b);

  service.invalidate("claude");
  await service.structuredOutput("claude", request());
  assert.equal(backend.calls, 2, "invalidate() drops the cached probe result too");
});
