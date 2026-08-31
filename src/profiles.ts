import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type {
  AccessMode,
  AgentSpeed,
  HarnessName,
  EffortLevel,
  ProfileDefinition,
  ProfileOrigin,
  ProfileValidationWarning,
} from "./types.ts";

const HARNESSES = new Set<HarnessName>(["pi", "claude", "codex"]);
const ACCESS = new Set<AccessMode>(["readOnly", "full"]);
const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
const SPEEDS = new Set<AgentSpeed>(["standard", "fast"]);

export interface ProfileCatalog {
  profiles: Map<string, ProfileDefinition>;
  warnings: ProfileValidationWarning[];
}

function splitFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("Profile must contain YAML frontmatter");
  const parsed: unknown = YAML.parse(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid profile frontmatter");
  return { meta: parsed as Record<string, unknown>, body: match[2] ?? "" };
}

function optionalEnum<T extends string>(meta: Record<string, unknown>, key: string, values: Set<T>): T | undefined {
  if (meta[key] === undefined) return undefined;
  const value = String(meta[key]);
  if (!values.has(value as T)) throw new Error(`Invalid ${key}: ${value}`);
  return value as T;
}

function readDirectory(directory: string, origin: ProfileOrigin, catalog: ProfileCatalog): void {
  if (!existsSync(directory)) return;
  let entries: string[];
  try { entries = readdirSync(directory).filter((entry) => entry.endsWith(".md")).sort(); }
  catch (error) {
    catalog.warnings.push({ filePath: directory, origin, message: error instanceof Error ? error.message : String(error) });
    return;
  }
  for (const entry of entries) {
    const filePath = join(directory, entry);
    try {
      const { meta, body } = splitFrontmatter(readFileSync(filePath, "utf8"));
      const name = String(meta.name ?? "").trim();
      if (!name) throw new Error("Profile name is required");
      if (["model", "modelTier", "tier", "backend", "locked_backend"].some((key) => Object.hasOwn(meta, key))) {
        throw new Error("Profile uses an obsolete routing field; use harness/locked_harness and request-scoped model selection");
      }
      if (meta.independent !== undefined && typeof meta.independent !== "boolean") throw new Error("Invalid independent: expected boolean");
      const harness = optionalEnum(meta, "harness", HARNESSES);
      const lockedHarness = optionalEnum(meta, "locked_harness", HARNESSES);
      const profile: ProfileDefinition = {
        name,
        description: String(meta.description ?? "").trim(),
        access: optionalEnum(meta, "access", ACCESS),
        harness,
        effort: optionalEnum(meta, "effort", EFFORTS),
        speed: optionalEnum(meta, "speed", SPEEDS),
        independent: meta.independent as boolean | undefined,
        lockedHarness,
        systemPrompt: body.trim(),
        filePath,
        origin,
      };
      if (profile.independent && profile.lockedHarness === "pi") {
        throw new Error("independent profiles cannot lock harness to pi");
      }
      catalog.profiles.set(name, profile);
    } catch (error) {
      catalog.warnings.push({ filePath, origin, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Project profiles are loaded second and intentionally override global profiles by name. */
export function loadProfiles(globalDirectory: string, projectDirectory?: string): ProfileCatalog {
  const catalog: ProfileCatalog = { profiles: new Map(), warnings: [] };
  readDirectory(globalDirectory, "global", catalog);
  if (projectDirectory) readDirectory(projectDirectory, "project", catalog);
  return catalog;
}
