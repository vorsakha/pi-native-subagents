import type { AgentActivitySnapshot } from "../../src/types.ts";
import type { WorkflowAgentRecord, WorkflowSnapshot } from "../../src/workflows/types.ts";
import { formatDurationLabel } from "../dashboard-style.ts";
import { sanitizeInline } from "../subagents/render.ts";

function age(at: number, now: number): string {
  return formatDurationLabel(Math.max(0, now - at));
}

function toolVerb(tool: string): string {
  const kind = tool.toLowerCase();
  switch (kind) {
    case "read": return "Reading";
    case "write": return "Writing";
    case "edit": return "Editing";
    case "list": return "Listing";
    case "ls": return "Listing";
    case "find":
    case "grep":
    case "glob": return "Searching";
    default: return `Using ${sanitizeInline(tool) || "tool"}`;
  }
}

/** Formats bounded event evidence. It never reads transcripts, provider text, or tool arguments. */
export function formatAgentActivity(activity: AgentActivitySnapshot | undefined, now: number): string {
  if (!activity) return "Working · no describable activity reported yet";
  if (activity.kind === "reasoning") return `Reasoning · provider activity ${age(activity.at, now)} ago`;
  if (activity.kind === "responding") return `Drafting response · provider activity ${age(activity.at, now)} ago`;
  if (activity.kind !== "tool") return "Working · no describable activity reported yet";
  const action = toolVerb(activity.tool);
  const target = activity.target ? ` ${sanitizeInline(activity.target)}` : "";
  if (activity.state === "running") return `${action}${target} · started ${age(activity.at, now)} ago`;
  if (activity.state === "failed") return `Working after ${sanitizeInline(activity.tool) || "tool"} failed ${age(activity.at, now)} ago`;
  return `Working · last action finished ${age(activity.at, now)} ago`;
}

export function workflowAgentContext(snapshot: WorkflowSnapshot, agent: WorkflowAgentRecord): string {
  const phase = snapshot.phases.find((candidate) => candidate.index === agent.phase);
  const phasePosition = Math.max(0, snapshot.phases.findIndex((candidate) => candidate.index === agent.phase)) + 1;
  const phaseLabel = phase
    ? `phase ${snapshot.plannedPhaseCount ? `${phasePosition}/${snapshot.plannedPhaseCount} ` : ""}${sanitizeInline(phase.name)}`
    : "phase unavailable";
  const convergence = snapshot.convergence;
  if (!convergence) return `${sanitizeInline(agent.name)} · ${phaseLabel}`;
  const ids = [agent.logicalJobId, agent.jobId].filter(Boolean);
  const role = ids.includes(convergence.reviewerJobId) ? "reviewer"
    : ids.includes(convergence.implementerJobId) ? "implementer"
      : sanitizeInline(agent.name);
  return `${role} · round ${convergence.round}/${convergence.maxRounds} · ${phaseLabel}`;
}
