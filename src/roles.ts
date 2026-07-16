import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { AccessMode, BackendName, RoleDefinition, RoleRoute, ThinkingLevel } from "./types.ts";

const BACKENDS: BackendName[] = ["pi", "claude", "codex"];
const THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const READ_ONLY_ROLES = new Set(["scout", "researcher", "reviewer", "brainstormer", "adversary"]);

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function splitFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Agent file must contain YAML frontmatter");
  const parsed: unknown = YAML.parse(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid agent frontmatter");
  return { meta: parsed as Record<string, unknown>, body: match[2] ?? "" };
}

function backend(value: unknown, fallback: BackendName): BackendName {
  return BACKENDS.includes(value as BackendName) ? value as BackendName : fallback;
}

function access(value: unknown, name: string): AccessMode {
  if (READ_ONLY_ROLES.has(name)) return "readOnly";
  return value === "readOnly" ? "readOnly" : "full";
}

function route(meta: Record<string, unknown>, name: BackendName): RoleRoute {
  const defaults: Record<BackendName, RoleRoute> = {
    pi: { model: "openai-codex/gpt-5.6-terra", thinking: "medium", effort: "medium" },
    claude: { model: "sonnet", thinking: "medium", effort: "medium" },
    codex: { model: "gpt-5.6-terra", thinking: "medium", effort: "medium" },
  };
  const thinkingValue = String(meta[`${name}_thinking`] ?? defaults[name].thinking) as ThinkingLevel;
  const effortValue = String(meta[`${name}_effort`] ?? defaults[name].effort) as RoleRoute["effort"];
  return {
    model: String(meta[`${name}_model`] ?? defaults[name].model),
    thinking: THINKING.has(thinkingValue) ? thinkingValue : defaults[name].thinking,
    effort: ["low", "medium", "high", "xhigh", "max"].includes(effortValue) ? effortValue : defaults[name].effort,
  };
}

export function loadRoles(directory: string, allowed?: string[]): Map<string, RoleDefinition> {
  const allow = allowed && allowed.length > 0 ? new Set(allowed) : undefined;
  const roles = new Map<string, RoleDefinition>();
  for (const entry of readdirSync(directory).filter((name) => name.endsWith(".md")).sort()) {
    const filePath = join(directory, entry);
    const { meta, body } = splitFrontmatter(readFileSync(filePath, "utf8"));
    const name = String(meta.name ?? "").trim();
    if (!name || allow && !allow.has(name)) continue;
    const defaultBackend = backend(meta.backend, "codex");
    const locked = meta.locked_backend === undefined ? undefined : backend(meta.locked_backend, defaultBackend);
    roles.set(name, {
      name,
      description: String(meta.description ?? ""),
      access: access(meta.access, name),
      defaultBackend,
      lockedBackend: locked,
      differentProviderFromParent: meta.provider_strategy === "different_from_parent",
      nestedAgents: csv(meta.nested_agents ?? meta.subagent_agents),
      piTools: csv(meta.pi_tools ?? meta.tools),
      claudeTools: csv(meta.claude_tools),
      routes: { pi: route(meta, "pi"), claude: route(meta, "claude"), codex: route(meta, "codex") },
      systemPrompt: body.trim(),
      filePath,
    });
  }
  return roles;
}

export function parseAllowedRoles(env: NodeJS.ProcessEnv): string[] | undefined {
  const values = csv(env.PI_NATIVE_SUBAGENTS_ALLOWED ?? env.PI_SUBAGENTS_ALLOWED ?? env.PI_SUBAGENT_ALLOWED);
  return values.length > 0 ? values : undefined;
}
