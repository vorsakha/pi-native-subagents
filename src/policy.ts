import type { HarnessName, BackendPolicy, ProfileDefinition, ProviderFamily, SpawnRequest } from "./types.ts";

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

export function compilePolicy(request: SpawnRequest, profile?: ProfileDefinition): CompiledJob {
  if (!request.trusted) throw new Error("Subagents are disabled for untrusted projects");
  const independent = request.independent === true || profile?.independent === true;
  let selected: HarnessName = request.harness ?? profile?.harness ?? request.defaultHarness ?? "codex";
  if (profile?.lockedHarness) {
    if (request.harness && request.harness !== profile.lockedHarness) {
      throw new Error(`Profile ${profile.name} locks its harness to ${profile.lockedHarness}`);
    }
    selected = profile.lockedHarness;
  }
  if (independent) {
    if (request.harness === "pi" || profile?.lockedHarness === "pi") throw new Error("independent agents require a native Claude or Codex harness");
    const parent = request.parentProvider;
    const explicitRoute = request.harness !== undefined || profile?.lockedHarness !== undefined;
    if (explicitRoute && parent !== "other" && selected === parent) {
      throw new Error(`independent agent must use a provider different from the parent ${parent} model`);
    }
    if (!explicitRoute) selected = parent === "claude" ? "codex" : "claude";
  }

  const model = normalizeModel(request.model);
  const access = profile?.access === "readOnly" ? "readOnly" : request.access ?? profile?.access ?? "full";
  const readOnly = access === "readOnly";
  return {
    profile,
    independent,
    policy: {
      harness: selected,
      access,
      model,
      thinking: "medium",
      effort: request.effort ?? profile?.effort,
      piTools: readOnly ? ["read", "grep", "find", "ls"] : ["read", "write", "edit", "bash", "grep", "find", "ls"],
      claudeTools: readOnly
        ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
        : ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
      approvalPolicy: "never",
      codexSandbox: readOnly
        ? { type: "readOnly", networkAccess: false }
        : { type: "dangerFullAccess" },
    },
  };
}
