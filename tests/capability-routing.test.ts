import test from "node:test";
import assert from "node:assert/strict";
import { isRequestedHarness, routeCapabilities } from "../src/capability-routing.ts";
import type { CapabilityRouteRequest, CapabilityRouteResult, CapabilityRouter } from "../src/capability-service.ts";

function baseRequest(overrides: Partial<CapabilityRoutingBaseRequest> = {}): CapabilityRoutingBaseRequest {
  return {
    task: "do the thing",
    cwd: "/proj",
    trusted: true,
    ...overrides,
  };
}
interface CapabilityRoutingBaseRequest {
  task: string;
  cwd: string;
  trusted: boolean;
  harness?: "pi" | "claude" | "codex" | "auto";
  requires?: string[];
  independent?: boolean;
  independentOf?: string;
  parentProvider?: "claude" | "codex" | "other";
}

class RecordingRouter implements CapabilityRouter {
  readonly calls: CapabilityRouteRequest[] = [];
  #result: CapabilityRouteResult;
  constructor(result: CapabilityRouteResult) { this.#result = result; }
  async route(request: CapabilityRouteRequest): Promise<CapabilityRouteResult> {
    this.calls.push(request);
    return this.#result;
  }
}

function fakeResult(harness: "pi" | "claude" | "codex", matched: string[], auto?: boolean): CapabilityRouteResult {
  return {
    harness,
    auto: auto ?? false,
    catalog: { harness, cwd: "/proj", access: "full", discoveredAt: 1, revision: "sha256:fixture", capabilities: [], sources: [], warnings: [], health: "healthy", degraded: false },
    resolution: { satisfied: [], missing: [], blocked: [] },
    route: { harness, matched, revision: "sha256:fixture", discoveredAt: 1, auto },
  };
}

test("isRequestedHarness accepts pi/claude/codex/auto and rejects anything else", () => {
  for (const value of ["pi", "claude", "codex", "auto"]) assert.equal(isRequestedHarness(value), true);
  for (const value of ["gpt", "", undefined, null, 1]) assert.equal(isRequestedHarness(value), false);
});

test("a request with neither requires nor harness:auto passes through untouched and never calls the router", async () => {
  const router = new RecordingRouter(fakeResult("codex", []));
  const routing = await routeCapabilities(router, { request: baseRequest({ harness: "claude" }) });
  assert.deepEqual(routing, {});
  assert.equal(router.calls.length, 0);
});

test("harness:auto without requires is rejected before the router is consulted", async () => {
  const router = new RecordingRouter(fakeResult("codex", []));
  await assert.rejects(
    routeCapabilities(router, { request: baseRequest({ harness: "auto" }) }),
    /harness auto requires at least one capability in requires/,
  );
  assert.equal(router.calls.length, 0);
});

test("requires without a router configured fails closed", async () => {
  await assert.rejects(
    routeCapabilities(undefined, { request: baseRequest({ requires: ["codex:tool:lint"] }) }),
    /Capability requirements are unavailable in this session/,
  );
});

test("an explicit harness with requires resolves the harness through selectHarness and forwards it, not auto", async () => {
  const router = new RecordingRouter(fakeResult("codex", ["codex:tool:lint"]));
  const routing = await routeCapabilities(router, { request: baseRequest({ harness: "codex", requires: ["codex:tool:lint"] }) });
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0]!.harness, "codex");
  assert.equal(routing.harness, "codex");
  assert.deepEqual(routing.requires, ["codex:tool:lint"]);
  assert.deepEqual(routing.capabilityRoute?.matched, ["codex:tool:lint"]);
});

test("harness:auto forwards harness auto to the router and normalizes duplicate/whitespace requirements", async () => {
  const router = new RecordingRouter(fakeResult("claude", ["claude:skill:review"], true));
  const routing = await routeCapabilities(router, {
    request: baseRequest({ harness: "auto", requires: [" claude:skill:review ", "claude:skill:review"] }),
  });
  assert.equal(router.calls[0]!.harness, "auto");
  assert.deepEqual(router.calls[0]!.requires, ["claude:skill:review"]);
  assert.equal(routing.harness, "claude");
  assert.equal(routing.capabilityRoute?.auto, true);
});

test("harness:auto with independent:true restricts candidates to the provider opposite the parent", async () => {
  const router = new RecordingRouter(fakeResult("claude", ["claude:tool:lint"], true));
  await routeCapabilities(router, {
    request: baseRequest({ harness: "auto", requires: ["tool:lint"], independent: true, parentProvider: "codex" }),
  });
  assert.deepEqual(router.calls[0]!.candidates, ["claude"]);

  const router2 = new RecordingRouter(fakeResult("codex", ["codex:tool:lint"], true));
  await routeCapabilities(router2, {
    request: baseRequest({ harness: "auto", requires: ["tool:lint"], independent: true, parentProvider: "claude" }),
  });
  assert.deepEqual(router2.calls[0]!.candidates, ["codex"]);
});

test("harness:auto with independentOfProvider (durable replay) restricts candidates the same way as a live parent provider", async () => {
  const router = new RecordingRouter(fakeResult("codex", ["codex:tool:lint"], true));
  await routeCapabilities(router, {
    request: baseRequest({ harness: "auto", requires: ["tool:lint"], independentOf: "prior-job" }),
    independentOfProvider: "claude",
  });
  assert.deepEqual(router.calls[0]!.candidates, ["codex"]);
});

test("an unresolved independentOf target does not arbitrarily narrow auto candidates before JobManager validates it", async () => {
  const router = new RecordingRouter(fakeResult("claude", ["claude:tool:lint"], true));
  await routeCapabilities(router, {
    request: baseRequest({ harness: "auto", requires: ["tool:lint"], independentOf: "missing-job", parentProvider: "codex" }),
  });
  assert.equal(router.calls[0]!.candidates, undefined);
});

test("harness:auto without independence leaves candidates unrestricted (undefined)", async () => {
  const router = new RecordingRouter(fakeResult("claude", ["claude:tool:lint"], true));
  await routeCapabilities(router, { request: baseRequest({ harness: "auto", requires: ["tool:lint"] }) });
  assert.equal(router.calls[0]!.candidates, undefined);
});

test("harness:auto honors locked profiles and intersects them with profile independence", async () => {
  const locked = {
    name: "codex-only", description: "locked", access: "readOnly" as const,
    lockedHarness: "codex" as const, systemPrompt: "", filePath: "/profile.md", origin: "global" as const,
  };
  const router = new RecordingRouter(fakeResult("codex", ["codex:tool:lint"], true));
  await routeCapabilities(router, {
    request: baseRequest({ harness: "auto", requires: ["tool:lint"] }),
    profile: locked,
  });
  assert.deepEqual(router.calls[0]!.candidates, ["codex"]);
  assert.equal(router.calls[0]!.access, "readOnly");

  const independentRouter = new RecordingRouter(fakeResult("codex", ["codex:tool:lint"], true));
  await routeCapabilities(independentRouter, {
    request: baseRequest({ harness: "auto", requires: ["tool:lint"], parentProvider: "claude" }),
    profile: { ...locked, independent: true },
  });
  assert.deepEqual(independentRouter.calls[0]!.candidates, ["codex"]);
});

test("the preference list, cwd, customization, and abort signal are all forwarded to the router", async () => {
  const controller = new AbortController();
  const router = new RecordingRouter(fakeResult("pi", ["pi:tool:lint"], true));
  await routeCapabilities(router, {
    request: { ...baseRequest({ harness: "auto", requires: ["tool:lint"] }), cwd: "/work", customization: "isolated" },
    preference: ["pi", "codex"],
    signal: controller.signal,
  });
  const call = router.calls[0]!;
  assert.equal(call.cwd, "/work");
  assert.equal(call.customization, "isolated");
  assert.deepEqual(call.preference, ["pi", "codex"]);
  assert.equal(call.signal, controller.signal);
});
