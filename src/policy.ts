import type { BackendName, BackendPolicy, ModelTier, ProfileDefinition, ProviderFamily, SpawnRequest } from "./types.ts";

export function providerFamily(provider: unknown): ProviderFamily {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "claude";
  if (normalized.includes("openai") || normalized.includes("codex")) return "codex";
  return "other";
}

const TIER_MODELS: Record<ModelTier, { codex: string; claude: string; pi: string }> = {
  economy: { codex: "gpt-5.6-luna", claude: "haiku", pi: "openai-codex/gpt-5.6-luna" },
  balanced: { codex: "gpt-5.6-terra", claude: "sonnet", pi: "openai-codex/gpt-5.6-terra" },
  quality: { codex: "gpt-5.6-sol", claude: "opus", pi: "openai-codex/gpt-5.6-sol" },
};

export interface CompiledJob {
  profile?: ProfileDefinition;
  policy: BackendPolicy;
  independent: boolean;
}

export function compilePolicy(request: SpawnRequest, profile?: ProfileDefinition): CompiledJob {
  if (!request.trusted) throw new Error("Subagents are disabled for untrusted projects");
  const independent = request.independent === true || profile?.independent === true;
  let selected: BackendName = request.backend ?? profile?.backend ?? request.defaultBackend ?? "codex";
  if (profile?.lockedBackend) {
    if (request.backend && request.backend !== profile.lockedBackend) {
      throw new Error(`Profile ${profile.name} locks its backend to ${profile.lockedBackend}`);
    }
    selected = profile.lockedBackend;
  }
  if (independent) {
    if (request.backend === "pi" || profile?.lockedBackend === "pi") throw new Error("independent agents require a native Claude or Codex backend");
    const parent = request.parentProvider;
    const explicitRoute = request.backend !== undefined || profile?.lockedBackend !== undefined;
    if (explicitRoute && parent !== "other" && selected === parent) {
      throw new Error(`independent agent must use a provider different from the parent ${parent} model`);
    }
    if (!explicitRoute) selected = parent === "claude" ? "codex" : "claude";
  }

  const tierName = request.modelTier ?? profile?.modelTier ?? "balanced";
  const tier = TIER_MODELS[tierName];
  const model = selected === "pi" ? tier.pi : selected === "claude" ? tier.claude : tier.codex;
  const access = profile?.access === "readOnly" ? "readOnly" : request.access ?? profile?.access ?? "full";
  const readOnly = access === "readOnly";
  return {
    profile,
    independent,
    policy: {
      backend: selected,
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
