import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  resolveRequirements,
  requirementsSatisfied,
  type CapabilityCatalog,
} from "../src/capabilities.ts";
import { compilePolicy, isIndependent, selectAccess, selectHarness } from "../src/policy.ts";
import type { ProfileDefinition, SpawnRequest } from "../src/types.ts";

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return { task: "do the thing", cwd: "/proj", trusted: true, ...overrides };
}

test("selectHarness applies caller > profile > default > pi precedence and honors a locked profile harness", () => {
  assert.equal(selectHarness(request()), "pi");
  assert.equal(selectHarness(request({ defaultHarness: "codex" })), "codex");
  const profile: ProfileDefinition = { name: "p", description: "", systemPrompt: "", filePath: "p.md", origin: "global", harness: "claude" };
  assert.equal(selectHarness(request(), profile), "claude");
  assert.equal(selectHarness(request({ harness: "codex" }), profile), "codex", "an explicit caller harness outranks a profile default");
  const locked: ProfileDefinition = { ...profile, lockedHarness: "codex" };
  assert.equal(selectHarness(request(), locked), "codex");
  assert.throws(() => selectHarness(request({ harness: "claude" }), locked), /locks its harness to codex/);
});

test("selectHarness routes independence to the opposite native provider and rejects a same-provider explicit route", () => {
  assert.equal(selectHarness(request({ independent: true, parentProvider: "codex" })), "claude");
  assert.equal(selectHarness(request({ independent: true, parentProvider: "claude" })), "codex");
  assert.throws(
    () => selectHarness(request({ independent: true, harness: "pi" })),
    /independent agents require a native Claude or Codex harness/,
  );
  assert.throws(
    () => selectHarness(request({ independent: true, harness: "claude", parentProvider: "claude" })),
    /independent agent must use a provider different from the parent claude model/,
  );
  assert.equal(selectHarness(request({ independentOf: "job-1" }), undefined, "claude"), "codex", "independentOfProvider is threaded as an explicit parameter, not read off the request");
});

test("selectAccess treats a profile's readOnly access as an unelevatable ceiling", () => {
  assert.equal(selectAccess(request()), "full");
  assert.equal(selectAccess(request({ access: "readOnly" })), "readOnly");
  const readOnlyProfile: ProfileDefinition = { name: "audit", description: "", systemPrompt: "", filePath: "a.md", origin: "global", access: "readOnly" };
  assert.equal(selectAccess(request({ access: "full" }), readOnlyProfile), "readOnly", "a full-access call cannot elevate past a readOnly profile");
  const fullProfile: ProfileDefinition = { ...readOnlyProfile, access: "full" };
  assert.equal(selectAccess(request(), fullProfile), "full");
});

test("isIndependent is true from an explicit flag, a profile default, or a durable independentOfProvider hint", () => {
  assert.equal(isIndependent(request()), false);
  assert.equal(isIndependent(request({ independent: true })), true);
  assert.equal(isIndependent(request(), { name: "p", description: "", systemPrompt: "", filePath: "p.md", origin: "global", independent: true }), true);
  assert.equal(isIndependent(request(), undefined, "claude"), true);
});

test("compilePolicy rejects untrusted requests before computing any policy", () => {
  assert.throws(() => compilePolicy(request({ trusted: false })), /Subagents are disabled for untrusted projects/);
});

test("compilePolicy defaults customization to native and normalizes requires", () => {
  const untouched = compilePolicy(request());
  assert.equal(untouched.policy.customization, "native");
  assert.equal(untouched.policy.requires, undefined);

  const isolated = compilePolicy(request({ customization: "isolated" }));
  assert.equal(isolated.policy.customization, "isolated");

  const withRequirements = compilePolicy(request({ requires: [" codex:tool:lint ", "codex:tool:lint"] }));
  assert.deepEqual(withRequirements.policy.requires, ["codex:tool:lint"]);
  const routed = compilePolicy(request({
    requires: ["tool:lint"],
    capabilityRoute: { harness: "codex", matched: ["codex:tool:lint"], revision: "sha256:fixture", discoveredAt: 1 },
  }));
  assert.deepEqual(routed.policy.requires, ["codex:tool:lint"], "adapters receive live-normalized IDs rather than ambiguous caller aliases");
  assert.throws(() => compilePolicy(request({ requires: [42] as unknown as string[] })), /requires must contain capability ID strings/);
});

test("compilePolicy's read-only/full base piTools sets never contain a delegation-shaped tool (the recursion ceiling)", () => {
  const readOnly = compilePolicy(request({ access: "readOnly" })).policy.piTools;
  const full = compilePolicy(request({ access: "full" })).policy.piTools;
  for (const tools of [readOnly, full]) {
    for (const tool of tools) assert.doesNotMatch(tool, /task|agent|workflow|delegat/i, `${tool} must not resemble a nested-orchestration surface`);
  }
});

test("full human Pi jobs inherit permitted parent tools while read-only and non-human jobs do not", () => {
  const inventory = ["mcp", "browser", "subagent_spawn", "workflow", "ask_user"];
  const fullHuman = compilePolicy(request({
    harness: "pi",
    access: "full",
    humanVisible: true,
    humanPiTools: inventory,
  })).policy.piTools;
  assert.ok(fullHuman.includes("mcp"));
  assert.ok(fullHuman.includes("browser"));
  assert.ok(!fullHuman.includes("subagent_spawn"));
  assert.ok(!fullHuman.includes("workflow"));
  assert.ok(!fullHuman.includes("ask_user"));

  const readOnlyHuman = compilePolicy(request({
    harness: "pi",
    access: "readOnly",
    humanVisible: true,
    humanPiTools: inventory,
  })).policy.piTools;
  assert.deepEqual(readOnlyHuman, ["read", "grep", "find", "ls"]);

  const ordinary = compilePolicy(request({ harness: "pi", access: "full", humanPiTools: inventory })).policy.piTools;
  assert.ok(!ordinary.includes("mcp"), "only the human command widens the Pi tool surface automatically");
});

test("compilePolicy activates required pi:tool: capabilities on top of the base allowlist, deduplicated, only for the pi harness", () => {
  const routedToPi = compilePolicy(request({
    harness: "pi",
    access: "readOnly",
    capabilityRoute: { harness: "pi", matched: ["pi:tool:lint", "pi:skill:review", "pi:tool:read"], revision: "sha256:fixture", discoveredAt: 1 },
  })).policy.piTools;
  assert.deepEqual([...routedToPi].sort(), ["find", "grep", "lint", "ls", "read"], "a matched pi:tool: capability is added once, and a non-tool match is ignored");

  const routedToCodex = compilePolicy(request({
    harness: "codex",
    capabilityRoute: { harness: "codex", matched: ["codex:tool:lint"], revision: "sha256:fixture", discoveredAt: 1 },
  })).policy.piTools;
  assert.deepEqual([...routedToCodex].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"], "a capability route for a different harness never leaks into piTools");
});

test("end-to-end: a real capability catalog can never let a delegation-denied requirement reach the matched route or piTools", () => {
  const catalog: CapabilityCatalog = buildCatalog({
    harness: "pi",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1,
    capabilities: [
      { kind: "tool", name: "lint" },
      { kind: "tool", name: "task" },
    ],
    sources: [{ source: "pi-fixture", health: "healthy" }],
  });
  const resolution = resolveRequirements(catalog, ["pi:tool:lint", "pi:tool:task"]);
  assert.equal(requirementsSatisfied(resolution), false);
  assert.equal(resolution.satisfied.map((c) => c.id).join(","), "pi:tool:lint");
  assert.match(resolution.blocked[0]!.reason, /nested agent orchestration is denied/);

  const policy = compilePolicy(request({
    harness: "pi",
    capabilityRoute: {
      harness: "pi",
      matched: resolution.satisfied.map((capability) => capability.id),
      revision: catalog.revision,
      discoveredAt: catalog.discoveredAt,
    },
  })).policy;
  assert.ok(policy.piTools.includes("lint"));
  assert.ok(!policy.piTools.includes("task"), "a denied capability can never reach the compiled tool set because it was never in matched");
});
