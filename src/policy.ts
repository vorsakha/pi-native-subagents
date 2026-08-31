import { capabilityDenial, normalizeRequirements } from "./capabilities.ts";
import { PARENT_THREAD_TOOL_NAME } from "./parent-thread-context.ts";
import { SUBAGENT_ASK_TOOL_NAME } from "./interactions.ts";
import type { AccessMode, AgentSpeed, HarnessName, BackendPolicy, ProfileDefinition, ProviderFamily, SpawnRequest } from "./types.ts";

export function selectSpeed(request: { speed?: unknown }, profile?: ProfileDefinition): AgentSpeed {
  const speed = request.speed ?? "standard";
  if (speed !== "standard" && speed !== "fast") throw new Error(`Unknown speed: ${String(speed)}`);
  if (speed === "fast" && profile?.speed === "standard") {
    throw new Error(`Profile ${profile.name} constrains speed to standard`);
  }
  return speed;
}

export function normalizeModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Model ID must be a string containing 1–256 characters");
  const model = value.trim();
  if (!model || model.length > 256) throw new Error("Model ID must be a string containing 1–256 characters");
  return model;
}

export function providerFamily(provider: unknown): ProviderFamily {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "claude";
  if (normalized.includes("openai") || normalized.includes("codex")) return "codex";
  return "other";
}

export interface CompiledJob {
  profile?: ProfileDefinition;
  policy: BackendPolicy;
  independent: boolean;
}

export function isIndependent(request: SpawnRequest, profile?: ProfileDefinition, independentOfProvider?: ProviderFamily): boolean {
  return request.independent === true || profile?.independent === true || independentOfProvider !== undefined;
}

/** Harness a request resolves to before dispatch. Shared with pre-dispatch capability routing. */
export function selectHarness(
  request: SpawnRequest,
  profile?: ProfileDefinition,
  independentOfProvider?: ProviderFamily,
): HarnessName {
  let selected: HarnessName = request.harness ?? profile?.harness ?? request.defaultHarness ?? "pi";
  if (profile?.lockedHarness) {
    if (request.harness && request.harness !== profile.lockedHarness) {
      throw new Error(`Profile ${profile.name} locks its harness to ${profile.lockedHarness}`);
    }
    selected = profile.lockedHarness;
  }
  if (isIndependent(request, profile, independentOfProvider)) {
    if (request.harness === "pi" || profile?.lockedHarness === "pi") throw new Error("independent agents require a native Claude or Codex harness");
    const target = independentOfProvider ?? request.parentProvider;
    const targetLabel = independentOfProvider ? "referenced job" : "parent";
    const explicitRoute = request.harness !== undefined || profile?.lockedHarness !== undefined;
    if (explicitRoute && target !== "other" && selected === target) {
      throw new Error(`independent agent must use a provider different from the ${targetLabel} ${target} model`);
    }
    if (!explicitRoute) selected = target === "claude" ? "codex" : "claude";
  }
  return selected;
}

/** Effective access ceiling. A profile's readOnly access cannot be elevated per call. */
export function selectAccess(request: SpawnRequest, profile?: ProfileDefinition): AccessMode {
  if (request.advisor) return "readOnly";
  return profile?.access === "readOnly" ? "readOnly" : request.access ?? profile?.access ?? "full";
}

export function compilePolicy(
  request: SpawnRequest,
  profile?: ProfileDefinition,
  independentOfProvider?: ProviderFamily,
): CompiledJob {
  if (!request.trusted) throw new Error("Subagents are disabled for untrusted projects");
  const independent = isIndependent(request, profile, independentOfProvider);
  const selected = selectHarness(request, profile, independentOfProvider);
  const speed = selectSpeed(request, profile);
  if (speed === "fast" && selected !== "codex") {
    throw new Error(`Fast speed is unsupported by the ${selected} route`);
  }

  const model = normalizeModel(request.model);
  const access = selectAccess(request, profile);
  const readOnly = access === "readOnly";
  const requires = normalizeRequirements(request.requires);
  const requiredPiTools = selected === "pi"
    ? (request.capabilityRoute?.matched ?? [])
      .filter((id) => id.startsWith("pi:tool:"))
      .map((id) => id.slice("pi:tool:".length))
    : [];
  const humanPiTools = selected === "pi" && !readOnly && request.humanVisible
    ? normalizeHumanPiTools(request.humanPiTools)
    : [];
  return {
    profile,
    independent,
    policy: {
      harness: selected,
      access,
      // Native customization is the default; only explicitly isolated launches
      // (tool-less session peers) opt out.
      customization: request.customization ?? "native",
      requires: request.capabilityRoute?.matched ?? requires,
      model,
      thinking: "medium",
      effort: request.effort ?? profile?.effort,
      speed,
      piTools: [...new Set([
        ...(readOnly ? ["read", "grep", "find", "ls"] : ["read", "write", "edit", "bash", "grep", "find", "ls"]),
        ...requiredPiTools,
        ...humanPiTools,
        ...(request.parentThread ? [PARENT_THREAD_TOOL_NAME] : []),
        // Injected only for an explicitly authorized job; never inherited from
        // the user's own tool inventory or from a capability route.
        ...(request.interaction ? [SUBAGENT_ASK_TOOL_NAME] : []),
      ])],
      claudeTools: readOnly
        ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
        : ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
      approvalPolicy: "never",
      codexSandbox: readOnly
        ? { type: "readOnly", networkAccess: false }
        : { type: "dangerFullAccess" },
      structuredOutput: request.structuredOutput,
    },
  };
}

/** Defense-in-depth for the trusted extension-provided human tool inventory. */
function normalizeHumanPiTools(value: string[] | undefined): string[] {
  if (!value) return [];
  return value
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0 && tool.length <= 160 && !capabilityDenial("tool", tool));
}
