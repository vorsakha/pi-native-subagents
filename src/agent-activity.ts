import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentActivitySnapshot, BackendEvent, JobSnapshot } from "./types.ts";

const MAX_TOOL_CHARS = 120;
const MAX_TARGET_CHARS = 300;
const CONTROL_OR_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))|[\u0000-\u001f\u007f-\u009f]/g;
const PATH_FIELDS = {
  read: ["file_path", "path"],
  write: ["file_path", "path"],
  edit: ["file_path", "path"],
  list: ["path", "directory"],
  ls: ["path", "directory"],
  find: ["path", "directory"],
  grep: ["path", "directory"],
  glob: ["path", "directory"],
} as const;

function clean(value: string, limit: number): string {
  return value.replace(CONTROL_OR_ESCAPE, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function toolKind(name: string): keyof typeof PATH_FIELDS | undefined {
  const normalized = name.toLowerCase();
  return normalized && normalized in PATH_FIELDS ? normalized as keyof typeof PATH_FIELDS : undefined;
}

function safeTarget(job: JobSnapshot, event: Extract<BackendEvent, { type: "tool_start" }>): string | undefined {
  const kind = toolKind(event.name);
  if (!kind || !event.args) return undefined;
  const candidate = PATH_FIELDS[kind]
    .map((field) => event.args?.[field])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!candidate) return undefined;
  // Filesystem tools occasionally receive URI-shaped input from plugins or
  // provider mistakes. Never reinterpret a credential-bearing URL as a local
  // path and expose it through the bounded activity projection.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate.trim())) return undefined;

  const root = resolve(job.cwd);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const projectRelative = relative(root, absolute);
  if (!projectRelative || projectRelative === ".") return ".";
  if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
    return "[outside workspace]";
  }
  return clean(projectRelative.replaceAll("\\", "/"), MAX_TARGET_CHARS);
}

/** Derive semantic activity without retaining provider text, results, or arbitrary arguments. */
export function activityFromEvent(job: JobSnapshot, event: BackendEvent, now = Date.now()): AgentActivitySnapshot | undefined {
  const at = event.at ?? now;
  switch (event.type) {
    case "thinking_delta":
    case "thinking_message":
      return { kind: "reasoning", at };
    case "text_delta":
    case "message":
      return job.status === "running" ? { kind: "responding", at } : job.activity;
    case "tool_start":
      return {
        kind: "tool",
        at,
        tool: clean(event.name, MAX_TOOL_CHARS) || "tool",
        state: "running",
        target: safeTarget(job, event),
      };
    case "tool_end": {
      const active = job.activity?.kind === "tool" ? job.activity : undefined;
      const trace = [...job.tools].reverse().find((tool) => tool.id === event.id);
      const tool = trace?.name ?? event.name ?? active?.tool ?? "tool";
      const target = trace?.args
        ? safeTarget(job, { type: "tool_start", id: event.id, name: trace.name, args: trace.args })
        : active?.target;
      return {
        kind: "tool",
        at,
        tool: clean(tool, MAX_TOOL_CHARS) || "tool",
        state: event.error === true || event.result?.isError === true ? "failed" : "completed",
        target,
      };
    }
    case "completed":
    case "failed":
    case "cancelled":
      return undefined;
    default:
      return job.activity;
  }
}
