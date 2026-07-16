import type { BackendName, BackendPolicy, ModelTier, ProviderFamily, RoleDefinition, SpawnRequest } from "./types.ts";

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
  role: RoleDefinition;
  policy: BackendPolicy;
}

export function compilePolicy(role: RoleDefinition, request: SpawnRequest, maxDepth = 2): CompiledJob {
  if (!request.trusted) throw new Error("Subagents are disabled for untrusted projects");
  const parentDepth = request.depth ?? 0;
  if (!Number.isInteger(parentDepth) || parentDepth < 0 || parentDepth >= maxDepth) {
    throw new Error(`Nested subagent depth limit reached (${maxDepth})`);
  }

  // Explicit routing is authoritative. A tier selects native Codex only when the caller
  // did not choose a backend; this prevents `{ backend: "claude", tier: "economy" }`
  // from silently crossing providers.
  let selected: BackendName = request.backend ?? (request.tier ? "codex" : role.defaultBackend);
  if (role.lockedBackend) {
    if (request.backend && request.backend !== role.lockedBackend) {
      throw new Error(`${role.name} locks its backend to ${role.lockedBackend}`);
    }
    selected = role.lockedBackend;
  }
  if (role.differentProviderFromParent) {
    if (role.lockedBackend) throw new Error(`${role.name} cannot lock a backend and require cross-provider routing`);
    if (request.backend === "pi") throw new Error(`${role.name} requires a native Claude or Codex backend`);
    const parent = request.parentProvider;
    if (request.backend && parent !== "other" && request.backend === parent) {
      throw new Error(`${role.name} must use a provider different from the parent ${parent} model`);
    }
    selected = request.backend
      ?? (parent === "claude" ? "codex" : parent === "codex" ? "claude" : role.defaultBackend === "codex" ? "codex" : "claude");
  }

  const route = { ...role.routes[selected] };
  if (request.tier) {
    const tier = TIER_MODELS[request.tier];
    route.model = selected === "pi" ? tier.pi : selected === "claude" ? tier.claude : tier.codex;
  }

  const readOnly = role.access === "readOnly";
  return {
    role,
    policy: {
      backend: selected,
      access: role.access,
      model: route.model,
      thinking: route.thinking,
      effort: request.effort,
      piTools: readOnly
        ? role.piTools.filter((tool) => ["read", "grep", "find", "ls"].includes(tool))
        : [...new Set(role.piTools)],
      claudeTools: readOnly
        ? role.claudeTools.filter((tool) => ["Read", "Glob", "Grep", "WebSearch", "WebFetch"].includes(tool))
        : [...new Set(role.claudeTools)],
      approvalPolicy: "never",
      codexSandbox: readOnly
        ? { type: "readOnly", networkAccess: false }
        : { type: "dangerFullAccess" },
      nestedAgents: parentDepth + 1 < maxDepth ? role.nestedAgents : [],
      depth: parentDepth + 1,
      maxDepth,
    },
  };
}
