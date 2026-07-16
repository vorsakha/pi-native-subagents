import type { BackendName, BackendPolicy, ModelTier, RoleDefinition, SpawnRequest } from "./types.ts";

const TIER_MODELS: Record<ModelTier, { codex: string; pi: string; thinking: BackendPolicy["thinking"]; effort: BackendPolicy["effort"] }> = {
  economy: { codex: "gpt-5.6-luna", pi: "openai-codex/gpt-5.6-luna", thinking: "low", effort: "low" },
  balanced: { codex: "gpt-5.6-terra", pi: "openai-codex/gpt-5.6-terra", thinking: "medium", effort: "medium" },
  quality: { codex: "gpt-5.6-sol", pi: "openai-codex/gpt-5.6-sol", thinking: "high", effort: "high" },
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

  const route = { ...role.routes[selected] };
  if (request.tier && selected !== "claude") {
    const tier = TIER_MODELS[request.tier];
    route.model = selected === "pi" ? tier.pi : tier.codex;
    route.thinking = tier.thinking;
    route.effort = tier.effort;
  }

  const readOnly = role.access === "readOnly";
  return {
    role,
    policy: {
      backend: selected,
      access: role.access,
      model: route.model,
      thinking: route.thinking,
      effort: route.effort,
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
