import { readFileSync } from "node:fs";
import type { BackendName, ModelTier } from "./types.ts";

export type TierModelMap = Readonly<Record<ModelTier, string>>;
export type ModelTierMappings = Readonly<Record<BackendName, TierModelMap>>;
type MutableModelTierMappings = Record<BackendName, Record<ModelTier, string>>;

export const BUILT_IN_MODEL_TIERS: ModelTierMappings = Object.freeze({
  codex: Object.freeze({ economy: "gpt-5.6-luna", balanced: "gpt-5.6-terra", quality: "gpt-5.6-sol" }),
  claude: Object.freeze({ economy: "haiku", balanced: "sonnet", quality: "opus" }),
  pi: Object.freeze({ economy: "openai-codex/gpt-5.6-luna", balanced: "openai-codex/gpt-5.6-terra", quality: "openai-codex/gpt-5.6-sol" }),
});

export interface ModelRoutingWarning {
  path: string;
  code: "read_error" | "invalid_json" | "invalid_shape";
  message: string;
}

export interface ModelRoutingConfig {
  mappings: ModelTierMappings;
  source: "built-in" | "global";
  path: string;
  warnings: ModelRoutingWarning[];
}

const BACKENDS = ["codex", "claude", "pi"] as const;
const TIERS = ["economy", "balanced", "quality"] as const;
const MAX_MODEL_LENGTH = 256;

function fallback(path: string, warning?: ModelRoutingWarning): ModelRoutingConfig {
  return { mappings: structuredClone(BUILT_IN_MODEL_TIERS), source: "built-in", path, warnings: warning ? [warning] : [] };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Loads only the administrator-owned global config path supplied by the extension. */
export function loadModelRouting(path: string): ModelRoutingConfig {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback(path);
    return fallback(path, { path, code: "read_error", message: error instanceof Error ? error.message : String(error) });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { return fallback(path, { path, code: "invalid_json", message: error instanceof Error ? error.message : String(error) }); }
  if (!object(parsed) || !exactKeys(parsed, ["modelTiers"]) || !object(parsed.modelTiers) || !exactKeys(parsed.modelTiers, BACKENDS)) {
    return fallback(path, { path, code: "invalid_shape", message: "Expected exactly { modelTiers: { codex, claude, pi } }." });
  }
  const mappings = {} as MutableModelTierMappings;
  for (const backend of BACKENDS) {
    const tiers = parsed.modelTiers[backend];
    if (!object(tiers) || !exactKeys(tiers, TIERS)) {
      return fallback(path, { path, code: "invalid_shape", message: `modelTiers.${backend} must contain exactly economy, balanced, and quality.` });
    }
    mappings[backend] = {} as Record<ModelTier, string>;
    for (const tier of TIERS) {
      const rawValue = tiers[tier];
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!value || value.length > MAX_MODEL_LENGTH) {
        return fallback(path, { path, code: "invalid_shape", message: `modelTiers.${backend}.${tier} must be non-empty after trimming and no longer than ${MAX_MODEL_LENGTH} characters.` });
      }
      mappings[backend][tier] = value;
    }
  }
  return { mappings, source: "global", path, warnings: [] };
}
