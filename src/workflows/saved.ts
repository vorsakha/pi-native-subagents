import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const MAX_SCRIPT_BYTES = 512 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs"]);

export interface SavedWorkflowDefinition {
  name: string;
  path: string;
  origin: "project" | "global";
}

function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function definitions(directory: string, origin: SavedWorkflowDefinition["origin"]): Promise<SavedWorkflowDefinition[]> {
  let entries;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Saved workflow directory is not a regular directory: ${directory}`);
    entries = await readdir(directory, { withFileTypes: true });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: SavedWorkflowDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !SCRIPT_EXTENSIONS.has(extname(entry.name))) continue;
    const name = basename(entry.name, extname(entry.name));
    if (!NAME_PATTERN.test(name)) continue;
    result.push({ name, path: join(directory, entry.name), origin });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export async function listSavedWorkflows(input: {
  cwd: string;
  trusted: boolean;
  globalRoot: string;
}): Promise<SavedWorkflowDefinition[]> {
  const global = await definitions(resolve(input.globalRoot), "global");
  let project: SavedWorkflowDefinition[] = [];
  if (input.trusted) {
    const trustedRoot = await realpath(resolve(input.cwd));
    const projectDirectory = resolve(trustedRoot, ".pi", "workflows");
    try {
      const canonicalProjectDirectory = await realpath(projectDirectory);
      if (!within(trustedRoot, canonicalProjectDirectory)) throw new Error("Project saved workflow directory escapes the trusted project");
      project = await definitions(canonicalProjectDirectory, "project");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const merged = new Map(global.map((item) => [item.name, item]));
  for (const item of project) merged.set(item.name, item);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function loadBounded(path: string): Promise<string> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Saved workflow must be a regular non-symlink file");
    if (info.size > MAX_SCRIPT_BYTES) throw new Error("Saved workflow script exceeds the 512 KiB limit");
    const script = await handle.readFile("utf8");
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error("Saved workflow script exceeds the 512 KiB limit");
    return script;
  } finally { await handle.close(); }
}

export async function loadSavedWorkflow(input: {
  cwd: string;
  trusted: boolean;
  globalRoot: string;
  name: string;
}): Promise<{ definition: SavedWorkflowDefinition; script: string }> {
  if (!input.trusted) throw new Error("Saved workflows are disabled for untrusted projects");
  if (!NAME_PATTERN.test(input.name)) throw new Error("Saved workflow name must contain 1–80 letters, numbers, dots, underscores, or hyphens");
  const definition = (await listSavedWorkflows(input)).find((item) => item.name === input.name);
  if (!definition) throw new Error(`Unknown saved workflow: ${input.name}`);
  return { definition, script: await loadBounded(definition.path) };
}

export async function loadWorkflowScriptPath(input: {
  cwd: string;
  trusted: boolean;
  scriptPath: string;
}): Promise<{ path: string; script: string }> {
  if (!input.trusted) throw new Error("Workflow scriptPath is disabled for untrusted projects");
  const root = await realpath(resolve(input.cwd));
  const candidate = await realpath(resolve(root, input.scriptPath));
  if (!within(root, candidate)) throw new Error("Workflow scriptPath escapes the trusted project");
  if (!SCRIPT_EXTENSIONS.has(extname(candidate))) throw new Error("Workflow scriptPath must reference a .js or .mjs file");
  return { path: candidate, script: await loadBounded(candidate) };
}
