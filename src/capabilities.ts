import { createHash } from "node:crypto";
import type { AccessMode, HarnessName } from "./types.ts";

/** Normalized capability families shared by every harness. */
export type CapabilityKind = "tool" | "skill" | "command" | "plugin" | "mcp" | "hook" | "agent" | "context";

/**
 * What a capability can do once the child uses it. `unknown` fails closed under
 * read-only so an unclassified native surface can never widen the sandbox.
 */
export type CapabilityEffect =
  | "inspect"
  | "external-read"
  | "workspace-write"
  | "external-write"
  | "interactive"
  | "delegation"
  | "unknown";

export type CapabilityHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export const CAPABILITY_KINDS = ["tool", "skill", "command", "plugin", "mcp", "hook", "agent", "context"] as const;
export const CAPABILITY_EFFECTS = [
  "inspect", "external-read", "workspace-write", "external-write", "interactive", "delegation", "unknown",
] as const;
export const CAPABILITY_HEALTH = ["healthy", "degraded", "unavailable", "unknown"] as const;

/** Bounded catalog size; native installs with more surfaces are truncated with a warning. */
export const MAX_CATALOG_CAPABILITIES = 400;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_REQUIREMENTS = 16;
export const MAX_REQUIREMENT_LENGTH = 160;

/** Raw record produced by a harness adapter before normalization. */
export interface DiscoveredCapability {
  kind: CapabilityKind;
  name: string;
  description?: string;
  /** Native scope or provenance, e.g. `user`, `project`, `plugin:foo`, `parent`. */
  origin?: string;
  enabled?: boolean;
  health?: CapabilityHealth;
  /** Adapter-supplied effect when the native protocol states it (e.g. MCP readOnly annotations). */
  effect?: CapabilityEffect;
  detail?: string;
}

export interface HarnessCapability {
  id: string;
  harness: HarnessName;
  kind: CapabilityKind;
  name: string;
  description?: string;
  origin?: string;
  effect: CapabilityEffect;
  health: CapabilityHealth;
  enabled: boolean;
  /** Set when the orchestration/interactivity ceiling denies this surface in every access mode. */
  denied?: boolean;
  deniedReason?: string;
  detail?: string;
}

export interface CapabilitySourceStatus {
  source: string;
  health: CapabilityHealth;
  detail?: string;
}

export interface CapabilityCatalog {
  harness: HarnessName;
  cwd: string;
  access: AccessMode;
  discoveredAt: number;
  /** Stable hash over capability identity, health, and enablement. */
  revision: string;
  capabilities: HarnessCapability[];
  sources: CapabilitySourceStatus[];
  warnings: string[];
  /** Worst source health; `unavailable` means discovery itself failed. */
  health: CapabilityHealth;
  degraded: boolean;
  nativeVersion?: string;
}

export interface CapabilityAvailability {
  capability: HarnessCapability;
  available: boolean;
  reason?: string;
}

/**
 * Hard ceiling: nested orchestration, harness administration, and unattended
 * interactivity are denied in every access mode and on every harness.
 */
const DENIAL_RULES: Array<{ test: RegExp; effect: CapabilityEffect; reason: string }> = [
  { test: /(^|[^a-z])(agents?|tasks?)([^a-z]|$)/i, effect: "delegation", reason: "nested agent orchestration is denied" },
  { test: /sub[-_ ]?agent/i, effect: "delegation", reason: "nested agent orchestration is denied" },
  { test: /work[-_ ]?flow/i, effect: "delegation", reason: "nested workflow orchestration is denied" },
  { test: /session[-_ ]?peer/i, effect: "delegation", reason: "session-peer forking is denied" },
  { test: /\bdelegat/i, effect: "delegation", reason: "nested delegation is denied" },
  { test: /(plugin|marketplace|extension)[-_ /]?(install|uninstall|add|remove|upgrade|enable|disable|share)/i, effect: "external-write", reason: "plugin administration is denied" },
  { test: /(install|uninstall|upgrade)[-_ /]?(plugin|marketplace|extension|skill)/i, effect: "external-write", reason: "plugin administration is denied" },
  { test: /mcp[-_ /]?(add|remove|install|login|auth|oauth|reconnect|toggle)/i, effect: "external-write", reason: "MCP administration is denied" },
  { test: /(config|settings)[-_ /]?(write|set|batchwrite|update)/i, effect: "external-write", reason: "harness configuration writes are denied" },
  { test: /ask[-_ ]?user/i, effect: "interactive", reason: "unattended children must not prompt the user" },
  { test: /request[-_ ]?(approval|permission)/i, effect: "interactive", reason: "unattended children must not request approvals" },
  { test: /\belicit/i, effect: "interactive", reason: "unattended children must not run elicitation prompts" },
  { test: /(^|[^a-z])(login|logout|oauth)([^a-z]|$)/i, effect: "interactive", reason: "authentication flows are denied" },
  { test: /exit[-_ ]?plan[-_ ]?mode/i, effect: "interactive", reason: "unattended children must not request plan approval" },
];

const INSPECT_TOOLS = new Set([
  "read", "grep", "find", "ls", "glob", "notebookread", "bashoutput", "todowrite", "todoread",
  "listmcpresources", "readmcpresource", "view", "search",
]);
const EXTERNAL_READ_TOOLS = new Set(["websearch", "webfetch", "web_search", "web_fetch", "fetch", "browser"]);
const WORKSPACE_WRITE_TOOLS = new Set([
  "write", "edit", "multiedit", "bash", "shell", "notebookedit", "apply_patch", "applypatch",
  "killshell", "kill_shell", "patch", "run", "exec", "command",
]);

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

export function capabilityId(harness: HarnessName, kind: CapabilityKind, name: string): string {
  return `${harness}:${kind}:${slug(name) || "unnamed"}`;
}

/** Returns the denial reason when a native surface breaks the orchestration ceiling. */
export function capabilityDenial(kind: CapabilityKind, name: string): { effect: CapabilityEffect; reason: string } | undefined {
  if (kind === "agent") return { effect: "delegation", reason: "nested agent orchestration is denied" };
  const subject = name.trim();
  for (const rule of DENIAL_RULES) {
    if (rule.test.test(subject)) return { effect: rule.effect, reason: rule.reason };
  }
  return undefined;
}

export function classifyEffect(kind: CapabilityKind, name: string, declared?: CapabilityEffect): CapabilityEffect {
  const denial = capabilityDenial(kind, name);
  if (denial) return denial.effect;
  if (declared) return declared;
  const normalized = name.trim().toLowerCase();
  if (kind === "tool") {
    if (normalized.startsWith("mcp__") || normalized.startsWith("mcp/")) return "unknown";
    if (INSPECT_TOOLS.has(normalized)) return "inspect";
    if (EXTERNAL_READ_TOOLS.has(normalized)) return "external-read";
    if (WORKSPACE_WRITE_TOOLS.has(normalized)) return "workspace-write";
    return "unknown";
  }
  if (kind === "skill" || kind === "command" || kind === "context") return "inspect";
  if (kind === "mcp") return "external-write";
  if (kind === "plugin") return "unknown";
  if (kind === "hook") return "workspace-write";
  return "unknown";
}

export function normalizeCapability(harness: HarnessName, input: DiscoveredCapability): HarnessCapability {
  const name = input.name.trim().slice(0, 160) || "unnamed";
  const nameDenial = capabilityDenial(input.kind, name);
  const effect = classifyEffect(input.kind, name, input.effect);
  const effectDenial = effect === "delegation"
    ? "nested delegation is denied"
    : effect === "interactive" ? "unattended children must not prompt the user" : undefined;
  const deniedReason = nameDenial?.reason ?? effectDenial;
  return {
    id: capabilityId(harness, input.kind, name),
    harness,
    kind: input.kind,
    name,
    description: input.description ? bounded(input.description, 240) : undefined,
    origin: input.origin ? bounded(input.origin, 80) : undefined,
    effect,
    health: input.health ?? "healthy",
    enabled: input.enabled ?? true,
    denied: deniedReason ? true : undefined,
    deniedReason,
    detail: input.detail ? bounded(input.detail, 240) : undefined,
  };
}

function bounded(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Stable revision hash so routing decisions and replay records can cite an exact catalog state. */
export function catalogRevision(capabilities: HarnessCapability[]): string {
  const hash = createHash("sha256");
  for (const capability of [...capabilities].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    hash.update(`${capability.id} ${capability.health} ${capability.enabled ? 1 : 0} ${capability.effect}\n`);
  }
  return `sha256:${hash.digest("hex").slice(0, 32)}`;
}

export function buildCatalog(input: {
  harness: HarnessName;
  cwd: string;
  access: AccessMode;
  discoveredAt: number;
  capabilities: DiscoveredCapability[];
  sources: CapabilitySourceStatus[];
  warnings?: string[];
  nativeVersion?: string;
}): CapabilityCatalog {
  const warnings = [...(input.warnings ?? [])];
  const seen = new Set<string>();
  const capabilities: HarnessCapability[] = [];
  for (const raw of input.capabilities) {
    const capability = normalizeCapability(input.harness, raw);
    if (seen.has(capability.id)) continue;
    seen.add(capability.id);
    if (capabilities.length >= MAX_CATALOG_CAPABILITIES) {
      warnings.push(`Capability catalog truncated at ${MAX_CATALOG_CAPABILITIES} entries for ${input.harness}`);
      break;
    }
    capabilities.push(capability);
  }
  const health = worstHealth(input.sources.map((source) => source.health));
  return {
    harness: input.harness,
    cwd: input.cwd,
    access: input.access,
    discoveredAt: input.discoveredAt,
    revision: catalogRevision(capabilities),
    capabilities,
    sources: input.sources,
    warnings: warnings.slice(0, 20),
    health,
    degraded: health === "degraded" || health === "unknown" || input.sources.some((source) => source.health !== "healthy"),
    nativeVersion: input.nativeVersion,
  };
}

const HEALTH_ORDER: Record<CapabilityHealth, number> = { healthy: 0, degraded: 1, unknown: 2, unavailable: 3 };

export function worstHealth(values: CapabilityHealth[]): CapabilityHealth {
  let worst: CapabilityHealth = "healthy";
  for (const value of values) if (HEALTH_ORDER[value] > HEALTH_ORDER[worst]) worst = value;
  return worst;
}

/**
 * Access ceiling. Read-only children may load reasoning specialization and
 * read-safe integrations only; unknown effects fail closed.
 */
export function capabilityAvailability(capability: HarnessCapability, access: AccessMode): CapabilityAvailability {
  if (capability.denied) return { capability, available: false, reason: capability.deniedReason ?? "denied by policy" };
  if (capability.effect === "delegation" || capability.effect === "interactive") {
    return { capability, available: false, reason: capability.effect === "delegation" ? "nested delegation is denied" : "unattended children must not prompt the user" };
  }
  if (!capability.enabled) return { capability, available: false, reason: "disabled in the native harness" };
  if (capability.health === "unavailable") {
    return { capability, available: false, reason: capability.detail ? `unavailable: ${capability.detail}` : "unavailable in the native harness" };
  }
  if (access === "readOnly") {
    if (capability.effect === "workspace-write" || capability.effect === "external-write") {
      return { capability, available: false, reason: `read-only children cannot use ${capability.effect} capabilities` };
    }
    if (capability.effect === "unknown") {
      return { capability, available: false, reason: "unclassified effect fails closed under read-only access" };
    }
    if (capability.kind === "hook") return { capability, available: false, reason: "hooks do not execute in read-only children" };
  }
  return { capability, available: true };
}

export function availableCapabilities(catalog: CapabilityCatalog): HarnessCapability[] {
  return catalog.capabilities.filter((capability) => capabilityAvailability(capability, catalog.access).available);
}

export interface CapabilityQuery {
  query?: string;
  harness?: HarnessName;
  kind?: CapabilityKind;
  effect?: CapabilityEffect;
  health?: CapabilityHealth;
  /** When true, denied and access-blocked surfaces are included with their reason. */
  includeUnavailable?: boolean;
  limit?: number;
}

export interface CapabilityMatch extends CapabilityAvailability {
  catalog: CapabilityCatalog;
}

export function searchCapabilities(catalogs: CapabilityCatalog[], query: CapabilityQuery = {}): { matches: CapabilityMatch[]; total: number } {
  const needle = query.query?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, query.limit ?? DEFAULT_SEARCH_LIMIT));
  const matches: CapabilityMatch[] = [];
  for (const catalog of catalogs) {
    if (query.harness && catalog.harness !== query.harness) continue;
    for (const capability of catalog.capabilities) {
      if (query.kind && capability.kind !== query.kind) continue;
      if (query.effect && capability.effect !== query.effect) continue;
      if (query.health && capability.health !== query.health) continue;
      const availability = capabilityAvailability(capability, catalog.access);
      if (!availability.available && !query.includeUnavailable) continue;
      if (needle && !capabilityMatchesText(capability, needle)) continue;
      matches.push({ ...availability, catalog });
    }
  }
  matches.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.capability.id < b.capability.id ? -1 : a.capability.id > b.capability.id ? 1 : 0;
  });
  return { matches: matches.slice(0, limit), total: matches.length };
}

function capabilityMatchesText(capability: HarnessCapability, needle: string): boolean {
  return capability.id.includes(needle)
    || capability.name.toLowerCase().includes(needle)
    || (capability.description?.toLowerCase().includes(needle) ?? false)
    || (capability.origin?.toLowerCase().includes(needle) ?? false);
}

export function normalizeRequirements(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("requires must be an array of capability IDs");
  const requirements: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("requires must contain capability ID strings");
    const requirement = item.trim();
    if (!requirement || requirement.length > MAX_REQUIREMENT_LENGTH) {
      throw new Error(`Capability requirement must contain 1–${MAX_REQUIREMENT_LENGTH} characters`);
    }
    if (!requirements.includes(requirement)) requirements.push(requirement);
  }
  if (requirements.length > MAX_REQUIREMENTS) throw new Error(`At most ${MAX_REQUIREMENTS} capability requirements are supported`);
  return requirements.length ? requirements : undefined;
}

/** Requirements accept a full capability ID, `kind:name`, or a bare native name. */
export function findCapability(catalog: CapabilityCatalog, requirement: string): HarnessCapability | undefined {
  const wanted = requirement.trim().toLowerCase();
  const bare = slug(wanted.includes(":") ? wanted.slice(wanted.lastIndexOf(":") + 1) : wanted);
  const exact = catalog.capabilities.find((capability) => capability.id.toLowerCase() === wanted);
  if (exact) return exact;
  const qualified = catalog.capabilities.find((capability) => `${capability.kind}:${slug(capability.name)}` === wanted);
  if (qualified) return qualified;
  const available = catalog.capabilities.filter((capability) => slug(capability.name) === bare);
  return available.find((capability) => capabilityAvailability(capability, catalog.access).available) ?? available[0];
}

export interface RequirementResolution {
  satisfied: HarnessCapability[];
  /** Requirement strings with no matching native capability at all. */
  missing: string[];
  /** Requirements matched by a capability the current policy or health forbids. */
  blocked: Array<{ requirement: string; capability: HarnessCapability; reason: string }>;
}

export function resolveRequirements(catalog: CapabilityCatalog, requires: string[]): RequirementResolution {
  const satisfied: HarnessCapability[] = [];
  const missing: string[] = [];
  const blocked: RequirementResolution["blocked"] = [];
  for (const requirement of requires) {
    const capability = findCapability(catalog, requirement);
    if (!capability) {
      missing.push(requirement);
      continue;
    }
    const availability = capabilityAvailability(capability, catalog.access);
    if (availability.available) satisfied.push(capability);
    else blocked.push({ requirement, capability, reason: availability.reason ?? "denied by policy" });
  }
  return { satisfied, missing, blocked };
}

export function requirementsSatisfied(resolution: RequirementResolution): boolean {
  return resolution.missing.length === 0 && resolution.blocked.length === 0;
}

export function describeResolution(harness: HarnessName, resolution: RequirementResolution): string {
  const parts: string[] = [];
  if (resolution.missing.length) parts.push(`${harness} does not provide: ${resolution.missing.join(", ")}`);
  for (const item of resolution.blocked) parts.push(`${harness} cannot use ${item.capability.id} (${item.reason})`);
  return parts.join("; ");
}

export function formatFreshness(catalog: CapabilityCatalog, now: number): string {
  const age = Math.max(0, now - catalog.discoveredAt);
  const seconds = Math.round(age / 1000);
  const label = seconds < 1 ? "just now" : seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  return label;
}

export function formatCapabilityLine(match: CapabilityMatch, now: number): string {
  const capability = match.capability;
  const state = match.available ? "" : ` · unavailable: ${match.reason}`;
  const health = capability.health === "healthy" ? "" : ` · ${capability.health}`;
  const origin = capability.origin ? ` · ${capability.origin}` : "";
  const description = capability.description ? ` — ${capability.description}` : "";
  return `${capability.id} [${capability.effect}${health}${origin}${state}] (${formatFreshness(match.catalog, now)})${description}`;
}

export function formatCatalogSummary(catalog: CapabilityCatalog, now: number): string {
  const available = availableCapabilities(catalog).length;
  const version = catalog.nativeVersion ? ` ${catalog.nativeVersion}` : "";
  const warnings = catalog.warnings.length ? ` · ${catalog.warnings.length} warning(s)` : "";
  return `${catalog.harness}${version}: ${available}/${catalog.capabilities.length} usable under ${catalog.access}`
    + ` · health ${catalog.health} · discovered ${formatFreshness(catalog, now)} · revision ${catalog.revision.slice(7, 15)}${warnings}`;
}
