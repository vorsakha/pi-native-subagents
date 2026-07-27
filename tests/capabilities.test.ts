import test from "node:test";
import assert from "node:assert/strict";
import {
  availableCapabilities,
  buildCatalog,
  capabilityAvailability,
  capabilityDenial,
  capabilityId,
  catalogRevision,
  classifyEffect,
  describeResolution,
  findCapability,
  formatCapabilityLine,
  formatCatalogSummary,
  formatFreshness,
  MAX_CATALOG_CAPABILITIES,
  MAX_REQUIREMENTS,
  MAX_REQUIREMENT_LENGTH,
  normalizeCapability,
  normalizeRequirements,
  requirementsSatisfied,
  resolveRequirements,
  searchCapabilities,
  worstHealth,
  type CapabilityCatalog,
  type DiscoveredCapability,
  type HarnessCapability,
} from "../src/capabilities.ts";

test("capabilityId normalizes name into a stable, bounded slug", () => {
  assert.equal(capabilityId("claude", "tool", "Read"), "claude:tool:read");
  assert.equal(capabilityId("codex", "mcp", "  My Server! "), "codex:mcp:my-server");
  assert.equal(capabilityId("pi", "tool", "***"), "pi:tool:unnamed", "an all-punctuation name falls back to unnamed");
  const long = "a".repeat(200);
  assert.equal(capabilityId("pi", "tool", long).length, "pi:tool:".length + 120, "slug is bounded to 120 characters");
});

test("capabilityDenial enforces the orchestration/interactivity ceiling by name pattern and kind", () => {
  assert.equal(capabilityDenial("agent", "anything")?.reason, "nested agent orchestration is denied", "every agent-kind capability is denied regardless of name");
  assert.equal(capabilityDenial("tool", "Task")?.effect, "delegation");
  assert.equal(capabilityDenial("tool", "task_list")?.effect, "delegation", "a word-boundary-delimited task name is denied");
  assert.equal(capabilityDenial("tool", "sub_agent")?.reason, "nested agent orchestration is denied");
  assert.equal(capabilityDenial("command", "workflow-start")?.reason, "nested workflow orchestration is denied");
  assert.equal(capabilityDenial("tool", "session-peer-fork")?.reason, "session-peer forking is denied");
  assert.equal(capabilityDenial("tool", "delegate-to-worker")?.reason, "nested delegation is denied");
  assert.equal(capabilityDenial("command", "plugin-install")?.effect, "external-write");
  assert.equal(capabilityDenial("command", "install-plugin")?.effect, "external-write");
  assert.equal(capabilityDenial("tool", "mcp-add")?.reason, "MCP administration is denied");
  assert.equal(capabilityDenial("tool", "settings-write")?.reason, "harness configuration writes are denied");
  assert.equal(capabilityDenial("tool", "AskUserQuestion")?.reason, "unattended children must not prompt the user");
  assert.equal(capabilityDenial("tool", "request_approval")?.reason, "unattended children must not request approvals");
  assert.equal(capabilityDenial("tool", "elicit")?.reason, "unattended children must not run elicitation prompts");
  assert.equal(capabilityDenial("tool", "login")?.reason, "authentication flows are denied");
  assert.equal(capabilityDenial("tool", "ExitPlanMode")?.reason, "unattended children must not request plan approval");
  assert.equal(capabilityDenial("tool", "Read"), undefined, "an ordinary read tool is not denied");
  assert.equal(capabilityDenial("tool", "loginTimeout"), undefined, "a substring match must still respect word boundaries");
});

test("classifyEffect prefers denial, then a declared effect, then the built-in tool/kind tables", () => {
  assert.equal(classifyEffect("tool", "Task", "inspect"), "delegation", "denial always wins over a declared effect");
  assert.equal(classifyEffect("tool", "custom-thing", "external-read"), "external-read", "a declared effect is honored when there is no denial");
  assert.equal(classifyEffect("tool", "Read"), "inspect");
  assert.equal(classifyEffect("tool", "grep"), "inspect");
  assert.equal(classifyEffect("tool", "WebSearch"), "external-read");
  assert.equal(classifyEffect("tool", "Bash"), "workspace-write");
  assert.equal(classifyEffect("tool", "mcp__server__thing"), "unknown", "MCP-namespaced tools fail closed without a declared effect");
  assert.equal(classifyEffect("tool", "some-unknown-tool"), "unknown");
  assert.equal(classifyEffect("skill", "anything"), "inspect");
  assert.equal(classifyEffect("command", "anything"), "inspect");
  assert.equal(classifyEffect("context", "anything"), "inspect");
  assert.equal(classifyEffect("mcp", "server"), "external-write");
  assert.equal(classifyEffect("plugin", "thing"), "unknown");
  assert.equal(classifyEffect("hook", "thing"), "workspace-write");
});

test("normalizeCapability produces a bounded, denial-aware HarnessCapability", () => {
  const capability = normalizeCapability("claude", {
    kind: "tool",
    name: "Write",
    description: `  ${"padded description   with   extra   spaces".repeat(10)}  `,
    origin: "native",
  });
  assert.equal(capability.id, "claude:tool:write");
  assert.equal(capability.effect, "workspace-write");
  assert.equal(capability.enabled, true);
  assert.equal(capability.health, "healthy");
  assert.equal(capability.denied, undefined);
  assert.ok(capability.description && capability.description.length <= 240);
  assert.ok(capability.description?.endsWith("…"), "an oversized description is truncated with an ellipsis");

  const denied = normalizeCapability("codex", { kind: "tool", name: "Task" });
  assert.equal(denied.denied, true);
  assert.equal(denied.deniedReason, "nested agent orchestration is denied");

  const blank = normalizeCapability("pi", { kind: "tool", name: "   " });
  assert.equal(blank.name, "unnamed");

  const disabled = normalizeCapability("codex", { kind: "mcp", name: "server", enabled: false, health: "degraded" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.health, "degraded");
});

test("worstHealth orders unavailable > unknown > degraded > healthy", () => {
  assert.equal(worstHealth([]), "healthy");
  assert.equal(worstHealth(["healthy", "degraded"]), "degraded");
  assert.equal(worstHealth(["healthy", "unknown", "degraded"]), "unknown");
  assert.equal(worstHealth(["healthy", "unavailable", "unknown"]), "unavailable");
});

test("buildCatalog deduplicates by id, truncates at the bounded catalog size, and derives degraded/health", () => {
  const many: DiscoveredCapability[] = Array.from({ length: MAX_CATALOG_CAPABILITIES + 5 }, (_, index) => ({
    kind: "tool" as const,
    name: `tool-${index}`,
  }));
  const truncated = buildCatalog({
    harness: "claude",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1_000,
    capabilities: many,
    sources: [{ source: "claude-init", health: "healthy" }],
  });
  assert.equal(truncated.capabilities.length, MAX_CATALOG_CAPABILITIES);
  assert.match(truncated.warnings.join(" "), /truncated at 400 entries/);
  assert.equal(truncated.degraded, false);
  assert.equal(truncated.health, "healthy");

  const deduped = buildCatalog({
    harness: "codex",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1_000,
    capabilities: [{ kind: "tool", name: "Read" }, { kind: "tool", name: "read" }],
    sources: [{ source: "codex-app-server", health: "healthy" }],
  });
  assert.equal(deduped.capabilities.length, 1, "capabilities normalize and dedupe to the same id");

  const degradedSource = buildCatalog({
    harness: "codex",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1_000,
    capabilities: [],
    sources: [{ source: "codex-mcp", health: "degraded", detail: "1 server not connected" }],
  });
  assert.equal(degradedSource.degraded, true);
  assert.equal(degradedSource.health, "degraded");

  const unavailable = buildCatalog({
    harness: "codex",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1_000,
    capabilities: [],
    sources: [{ source: "codex-app-server", health: "unavailable", detail: "spawn failed" }],
  });
  assert.equal(unavailable.health, "unavailable");
  assert.equal(unavailable.degraded, true);
});

test("catalogRevision is a stable order-independent hash over identity, health, enablement, and effect", () => {
  const a = normalizeCapability("claude", { kind: "tool", name: "Read" });
  const b = normalizeCapability("claude", { kind: "tool", name: "Write" });
  const revisionAB = catalogRevision([a, b]);
  const revisionBA = catalogRevision([b, a]);
  assert.equal(revisionAB, revisionBA, "revision does not depend on input order");
  assert.match(revisionAB, /^sha256:[0-9a-f]{32}$/);

  const changedHealth = { ...b, health: "degraded" as const };
  assert.notEqual(catalogRevision([a, b]), catalogRevision([a, changedHealth]), "revision changes when a capability's health changes");
});

test("capabilityAvailability denies by policy, disablement, unavailability, and the read-only ceiling", () => {
  const access = (capability: HarnessCapability, mode: "readOnly" | "full") => capabilityAvailability(capability, mode);

  const deniedCapability = normalizeCapability("claude", { kind: "agent", name: "reviewer" });
  assert.equal(access(deniedCapability, "full").available, false);
  assert.match(access(deniedCapability, "full").reason ?? "", /nested agent orchestration is denied/);

  const disabledCapability = normalizeCapability("codex", { kind: "mcp", name: "server", enabled: false });
  assert.equal(access(disabledCapability, "full").available, false);
  assert.match(access(disabledCapability, "full").reason ?? "", /disabled in the native harness/);

  const unavailableCapability = normalizeCapability("codex", { kind: "mcp", name: "server", health: "unavailable", detail: "spawn failed" });
  assert.equal(access(unavailableCapability, "full").available, false);
  assert.match(access(unavailableCapability, "full").reason ?? "", /unavailable: spawn failed/);

  const writeTool = normalizeCapability("claude", { kind: "tool", name: "Write" });
  assert.equal(access(writeTool, "full").available, true);
  assert.equal(access(writeTool, "readOnly").available, false);
  assert.match(access(writeTool, "readOnly").reason ?? "", /read-only children cannot use workspace-write capabilities/);

  const unknownEffect = normalizeCapability("claude", { kind: "tool", name: "mcp__server__thing" });
  assert.equal(access(unknownEffect, "full").available, true);
  assert.equal(access(unknownEffect, "readOnly").available, false);
  assert.match(access(unknownEffect, "readOnly").reason ?? "", /unclassified effect fails closed under read-only access/);

  const hook = normalizeCapability("codex", { kind: "hook", name: "post-edit" });
  assert.equal(access(hook, "full").available, true);
  assert.equal(access(hook, "readOnly").available, false, "hooks never execute in read-only children even though the effect is only workspace-write");

  const declaredDelegation = normalizeCapability("codex", { kind: "tool", name: "orchestra-runner", effect: "delegation" });
  assert.equal(access(declaredDelegation, "full").available, false, "adapter-declared delegation is denied even when its name avoids the deny patterns");
  const declaredInteractive = normalizeCapability("codex", { kind: "tool", name: "dialog", effect: "interactive" });
  assert.equal(access(declaredInteractive, "full").available, false, "adapter-declared interactivity is denied in full access too");
  const describedDelegation = normalizeCapability("claude", {
    kind: "command", name: "batch", description: "Execute work in parallel across isolated worktree agents",
  });
  assert.equal(access(describedDelegation, "full").available, false, "described nested orchestration is denied even when the command name is generic");
  const adminCommand = normalizeCapability("claude", { kind: "command", name: "config", description: "Set a setting by key" });
  assert.equal(access(adminCommand, "full").available, false, "harness administration commands are denied");

  const readTool = normalizeCapability("claude", { kind: "tool", name: "Read" });
  assert.equal(access(readTool, "readOnly").available, true);
});

function catalog(overrides: Partial<CapabilityCatalog> & { capabilities: HarnessCapability[] }): CapabilityCatalog {
  return {
    harness: "claude",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1_000,
    revision: "sha256:fixture",
    sources: [],
    warnings: [],
    health: "healthy",
    degraded: false,
    ...overrides,
  };
}

test("availableCapabilities filters by the catalog's own access mode", () => {
  const readOnlyCatalog = catalog({
    access: "readOnly",
    capabilities: [
      normalizeCapability("claude", { kind: "tool", name: "Read" }),
      normalizeCapability("claude", { kind: "tool", name: "Write" }),
    ],
  });
  assert.deepEqual(availableCapabilities(readOnlyCatalog).map((capability) => capability.name), ["Read"]);
});

test("searchCapabilities filters by harness/kind/effect/health/query and text, then sorts available-first by id", () => {
  const claudeCatalog = catalog({
    harness: "claude",
    access: "full",
    capabilities: [
      normalizeCapability("claude", { kind: "tool", name: "Read", description: "read files" }),
      normalizeCapability("claude", { kind: "tool", name: "Task" }),
      normalizeCapability("claude", { kind: "skill", name: "code-review", description: "review code" }),
    ],
  });
  const codexCatalog = catalog({
    harness: "codex",
    access: "full",
    capabilities: [normalizeCapability("codex", { kind: "tool", name: "Read" })],
  });

  const byHarness = searchCapabilities([claudeCatalog, codexCatalog], { harness: "codex" });
  assert.equal(byHarness.matches.length, 1);
  assert.equal(byHarness.matches[0]!.catalog.harness, "codex");

  const byKind = searchCapabilities([claudeCatalog], { kind: "skill" });
  assert.equal(byKind.matches.length, 1);
  assert.equal(byKind.matches[0]!.capability.name, "code-review");

  const byQuery = searchCapabilities([claudeCatalog], { query: "review" });
  assert.equal(byQuery.matches.length, 1);
  assert.equal(byQuery.matches[0]!.capability.name, "code-review");

  const excludesUnavailable = searchCapabilities([claudeCatalog], {});
  assert.ok(!excludesUnavailable.matches.some((match) => match.capability.name === "Task"), "denied capabilities are excluded by default");

  const includesUnavailable = searchCapabilities([claudeCatalog], { includeUnavailable: true });
  assert.equal(includesUnavailable.total, 3);
  assert.ok(includesUnavailable.matches.some((match) => match.capability.name === "Task" && match.available === false));
  assert.equal(includesUnavailable.matches[includesUnavailable.matches.length - 1]!.capability.name, "Task", "unavailable matches sort after available ones");

  const limited = searchCapabilities([claudeCatalog], { includeUnavailable: true, limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.total, 3, "total reports every match even when limit truncates the returned page");
});

test("normalizeRequirements validates array shape, trims, dedupes, and bounds length/size", () => {
  assert.equal(normalizeRequirements(undefined), undefined);
  assert.throws(() => normalizeRequirements("nope"), /requires must be an array/);
  assert.throws(() => normalizeRequirements([1, 2]), /requires must contain capability ID strings/);
  assert.throws(() => normalizeRequirements([""]), new RegExp(`1–${MAX_REQUIREMENT_LENGTH}`));
  assert.throws(() => normalizeRequirements(["a".repeat(MAX_REQUIREMENT_LENGTH + 1)]), new RegExp(`1–${MAX_REQUIREMENT_LENGTH}`));
  assert.deepEqual(normalizeRequirements([" a ", "a", "b"]), ["a", "b"], "requirements are trimmed and deduplicated");
  assert.throws(
    () => normalizeRequirements(Array.from({ length: MAX_REQUIREMENTS + 1 }, (_, index) => `req-${index}`)),
    new RegExp(`At most ${MAX_REQUIREMENTS}`),
  );
  assert.equal(normalizeRequirements([])?.length ?? 0, 0, "an empty array normalizes to undefined-equivalent (no requirements)");
});

test("findCapability resolves a full ID, a kind:name pair, or a bare native name, preferring an available match", () => {
  const readOnlyCatalog = catalog({
    access: "readOnly",
    capabilities: [
      normalizeCapability("claude", { kind: "tool", name: "Read" }),
      normalizeCapability("claude", { kind: "tool", name: "Write" }),
    ],
  });
  assert.equal(findCapability(readOnlyCatalog, "claude:tool:read")?.name, "Read", "full capability ID matches exactly");
  assert.equal(findCapability(readOnlyCatalog, "tool:write")?.name, "Write", "kind:name matches without the harness prefix");
  assert.equal(findCapability(readOnlyCatalog, "Read")?.name, "Read", "a bare native name resolves by slug");
  assert.equal(findCapability(readOnlyCatalog, "missing"), undefined);

  const bothNamesake = catalog({
    access: "readOnly",
    capabilities: [
      normalizeCapability("claude", { kind: "mcp", name: "search" }),
      normalizeCapability("claude", { kind: "tool", name: "search" }),
    ],
  });
  const resolved = findCapability(bothNamesake, "search");
  assert.equal(resolved?.kind, "tool", "an available match (the read-only usable tool) is preferred over a same-named blocked MCP server");
});

test("resolveRequirements / requirementsSatisfied / describeResolution classify missing vs. blocked requirements", () => {
  const readOnlyCatalog = catalog({
    access: "readOnly",
    capabilities: [
      normalizeCapability("claude", { kind: "tool", name: "Read" }),
      normalizeCapability("claude", { kind: "tool", name: "Write" }),
    ],
  });
  const resolution = resolveRequirements(readOnlyCatalog, ["claude:tool:read", "claude:tool:write", "claude:tool:nonexistent"]);
  assert.equal(resolution.satisfied.length, 1);
  assert.equal(resolution.satisfied[0]!.name, "Read");
  assert.equal(resolution.missing.length, 1);
  assert.equal(resolution.missing[0], "claude:tool:nonexistent");
  assert.equal(resolution.blocked.length, 1);
  assert.equal(resolution.blocked[0]!.requirement, "claude:tool:write");
  assert.match(resolution.blocked[0]!.reason, /read-only children cannot use workspace-write/);
  assert.equal(requirementsSatisfied(resolution), false);

  const fullySatisfied = resolveRequirements(readOnlyCatalog, ["claude:tool:read"]);
  assert.equal(requirementsSatisfied(fullySatisfied), true);

  const description = describeResolution("claude", resolution);
  assert.match(description, /claude does not provide: claude:tool:nonexistent/);
  assert.match(description, /claude cannot use claude:tool:write/);
});

test("formatFreshness/formatCapabilityLine/formatCatalogSummary render bounded, human-legible text", () => {
  const now = 5_000 + 125_000;
  const readTool = normalizeCapability("claude", { kind: "tool", name: "Read", description: "read files" });
  const claudeCatalog = catalog({ harness: "claude", access: "full", discoveredAt: 5_000, capabilities: [readTool], nativeVersion: "1.2.3" });

  assert.equal(formatFreshness(claudeCatalog, 5_100), "just now");
  assert.equal(formatFreshness(claudeCatalog, 5_000 + 30_000), "30s ago");
  assert.equal(formatFreshness(claudeCatalog, now), "2m ago");

  const [match] = searchCapabilities([claudeCatalog]).matches;
  const line = formatCapabilityLine(match!, now);
  assert.match(line, /^claude:tool:read \[inspect\] \(2m ago\) — read files$/);

  const summary = formatCatalogSummary(claudeCatalog, now);
  assert.match(summary, /^claude 1\.2\.3: 1\/1 usable under full · health healthy · discovered 2m ago · revision fixture$/);
});
