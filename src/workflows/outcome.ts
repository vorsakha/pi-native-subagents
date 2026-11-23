import type { WorkflowTaskOutcome } from "./types.ts";

export function workflowTaskOutcome(result: unknown): WorkflowTaskOutcome {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "unspecified";
  }

  const ok = (result as Record<string, unknown>).ok;

  if (ok === true) {
    return "successful";
  }

  return ok === false ? "unsuccessful" : "unspecified";
}
