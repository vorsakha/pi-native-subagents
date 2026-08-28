import type { DashboardSummary } from "../dashboard-style.ts";
import type {
  WorkflowAgentRecord,
  WorkflowAgentState,
  WorkflowPhase,
  WorkflowSnapshot,
  WorkflowStatus,
} from "../../src/workflows/types.ts";
import { workflowAgentDashboardSummary, workflowPhaseProgress } from "./render.ts";

export type WorkflowDashboardFocus = "runs" | "outline" | "agent-detail";
export type WorkflowAgentFilter = "all" | "active" | "failed" | "completed";
export type WorkflowOutlinePhaseKey = `phase:${number}`;
export type WorkflowOutlineAgentKey = `agent:${number}`;
export type WorkflowOutlineNodeKey = WorkflowOutlinePhaseKey | WorkflowOutlineAgentKey;

interface WorkflowOutlineNodeBase {
  key: WorkflowOutlineNodeKey;
  phaseKey: WorkflowOutlinePhaseKey;
  phaseIndex: number;
  attention: boolean;
}

export interface WorkflowOutlinePhaseNode extends WorkflowOutlineNodeBase {
  kind: "phase";
  key: WorkflowOutlinePhaseKey;
  position: number;
  total?: number;
  progressLabel: string;
  name: string;
  status: WorkflowStatus;
  current: boolean;
  recorded: boolean;
  completedAgents: number;
  agentCount: number;
  hiddenAgentCount: number;
  phase?: WorkflowPhase;
}

export interface WorkflowOutlineAgentNode extends WorkflowOutlineNodeBase {
  kind: "agent";
  key: WorkflowOutlineAgentKey;
  agentIndex: number;
  name: string;
  state: WorkflowAgentState;
  summary: DashboardSummary;
  agent: WorkflowAgentRecord;
}

export type WorkflowOutlineNode = WorkflowOutlinePhaseNode | WorkflowOutlineAgentNode;

export type WorkflowOutlineSelection =
  | { kind: "phase"; key: WorkflowOutlinePhaseKey; phaseKey: WorkflowOutlinePhaseKey }
  | { kind: "agent"; key: WorkflowOutlineAgentKey; phaseKey: WorkflowOutlinePhaseKey };

export interface WorkflowOutlineModel {
  nodes: readonly WorkflowOutlineNode[];
  phases: readonly WorkflowOutlinePhaseNode[];
  phaseProgress: ReturnType<typeof workflowPhaseProgress>;
  selected?: WorkflowOutlineSelection;
  selectedIndex: number;
  expandedPhaseKey?: WorkflowOutlinePhaseKey;
}

export type WorkflowOutlineRow =
  | { kind: "node"; node: WorkflowOutlineNode }
  | {
    kind: "omission";
    key: string;
    omitted: number;
    omittedPhases: number;
    omittedAgents: number;
  };

export function workflowPhaseNodeKey(phaseIndex: number): WorkflowOutlinePhaseKey {
  return `phase:${phaseIndex}`;
}

export function workflowAgentNodeKey(agentIndex: number): WorkflowOutlineAgentKey {
  return `agent:${agentIndex}`;
}

export function buildWorkflowOutline(
  run: WorkflowSnapshot,
  filter: WorkflowAgentFilter,
  requested: WorkflowOutlineSelection | undefined,
  now: number,
): WorkflowOutlineModel {
  const phaseProgress = workflowPhaseProgress(run);
  const phaseRecords = plannedAndRecordedPhases(run);
  const phaseAgents = new Map<WorkflowOutlinePhaseKey, readonly WorkflowAgentRecord[]>();
  const phases = phaseRecords.map(({ phase, phaseIndex, position }): WorkflowOutlinePhaseNode => {
    const key = workflowPhaseNodeKey(phaseIndex);
    const agents = agentsForPhase(run, phaseIndex, phase);
    phaseAgents.set(key, agents);
    const visibleAgents = agents.filter((agent) => workflowAgentMatchesFilter(agent, filter));
    const status = phase?.status ?? "pending";
    const current = run.currentPhase === phaseIndex;
    return {
      kind: "phase",
      key,
      phaseKey: key,
      phaseIndex,
      position,
      total: phaseProgress.total,
      progressLabel: `${position}/${phaseProgress.total ?? "?"}`,
      name: phase?.name ?? `Planned phase ${position}`,
      status,
      current,
      recorded: !!phase,
      completedAgents: agents.filter((agent) => agent.state === "completed").length,
      agentCount: agents.length,
      hiddenAgentCount: agents.length - visibleAgents.length,
      attention: current || phaseNeedsAttention(status),
      phase,
    };
  });

  const phaseByKey = new Map(phases.map((phase) => [phase.key, phase]));
  const requestedAgent = requested?.kind === "agent"
    ? run.agents.find((agent) => workflowAgentNodeKey(agent.index) === requested.key)
    : undefined;
  const requestedAgentPhase = requestedAgent
    ? phaseForAgent(phases, phaseAgents, requestedAgent)
    : undefined;
  const requestedPhase = requested?.kind === "phase"
    ? phaseByKey.get(requested.phaseKey)
    : requestedAgentPhase ?? (requested ? phaseByKey.get(requested.phaseKey) : undefined);
  const currentPhase = phases.find((phase) => phase.current);
  const expandedPhase = requestedPhase ?? currentPhase ?? phases[0];
  const visibleAgents = expandedPhase
    ? (phaseAgents.get(expandedPhase.key) ?? []).filter((agent) => workflowAgentMatchesFilter(agent, filter))
    : [];
  const agentNodes = expandedPhase
    ? visibleAgents.map((agent): WorkflowOutlineAgentNode => ({
      kind: "agent",
      key: workflowAgentNodeKey(agent.index),
      phaseKey: expandedPhase.key,
      phaseIndex: expandedPhase.phaseIndex,
      agentIndex: agent.index,
      name: agent.name,
      state: agent.state,
      summary: workflowAgentDashboardSummary(agent, now),
      attention: agentNeedsAttention(agent),
      agent,
    }))
    : [];

  const nodes: WorkflowOutlineNode[] = [];
  for (const phase of phases) {
    nodes.push(phase);
    if (phase.key === expandedPhase?.key) nodes.push(...agentNodes);
  }

  const sameNode = requested?.kind === "agent"
    ? agentNodes.find((node) => node.key === requested.key)
    : requested?.kind === "phase"
      ? phaseByKey.get(requested.key)
      : undefined;
  const selectedNode = sameNode ?? requestedPhase ?? currentPhase ?? phases[0] ?? nodes[0];
  const selected = selectedNode ? selectionForNode(selectedNode) : undefined;

  return {
    nodes,
    phases,
    phaseProgress,
    selected,
    selectedIndex: selected ? nodes.findIndex((node) => node.key === selected.key) : -1,
    expandedPhaseKey: expandedPhase?.key,
  };
}

/**
 * Bounds outline rows by semantic priority instead of slicing one positional
 * window. The selected node always survives. Its phase, the current phase, and
 * attention states take the remaining slots before routine nodes.
 */
export function boundWorkflowOutline(model: WorkflowOutlineModel, rows: number): readonly WorkflowOutlineRow[] {
  const budget = Math.max(0, Math.floor(rows));
  if (!budget || !model.nodes.length) return [];
  if (model.nodes.length <= budget) return model.nodes.map((node) => ({ kind: "node", node }));

  const selectedIndex = model.selectedIndex >= 0 ? model.selectedIndex : 0;
  if (budget === 1) return [{ kind: "node", node: model.nodes[selectedIndex]! }];

  const nodeBudget = budget - 1;
  const candidates = model.nodes.map((node, index) => ({
    node,
    index,
    score: outlineNodePriority(node, model.selected, selectedIndex, index),
  }));
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const included = new Set(candidates.slice(0, nodeBudget).map((candidate) => candidate.index));
  included.add(selectedIndex);

  const selected = [...included]
    .sort((left, right) => left - right)
    .slice(0, nodeBudget)
    .map((index) => ({ index, node: model.nodes[index]! }));
  if (!selected.some(({ index }) => index === selectedIndex)) {
    selected[selected.length - 1] = { index: selectedIndex, node: model.nodes[selectedIndex]! };
    selected.sort((left, right) => left.index - right.index);
  }

  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const omittedNodes = model.nodes.filter((_, index) => !selectedIndexes.has(index));
  const omission: WorkflowOutlineRow = {
    kind: "omission",
    key: `omission:${omittedNodes.length}:${selected.map(({ node }) => node.key).join(",")}`,
    omitted: omittedNodes.length,
    omittedPhases: omittedNodes.filter((node) => node.kind === "phase").length,
    omittedAgents: omittedNodes.filter((node) => node.kind === "agent").length,
  };
  const firstOmitted = model.nodes.findIndex((_, index) => !selectedIndexes.has(index));
  const insertion = selected.findIndex(({ index }) => index > firstOmitted);
  const bounded: WorkflowOutlineRow[] = selected.map(({ node }) => ({ kind: "node", node }));
  bounded.splice(insertion < 0 ? bounded.length : insertion, 0, omission);
  return bounded;
}

export function selectionForNode(node: WorkflowOutlineNode): WorkflowOutlineSelection {
  return node.kind === "phase"
    ? { kind: "phase", key: node.key, phaseKey: node.phaseKey }
    : { kind: "agent", key: node.key, phaseKey: node.phaseKey };
}

export function workflowAgentMatchesFilter(agent: WorkflowAgentRecord, filter: WorkflowAgentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return agent.state === "queued" || agent.state === "running" || agent.state === "waiting";
  if (filter === "failed") return agent.state === "failed" || agent.state === "cancelled" || agent.state === "aborted";
  return agent.state === "completed";
}

function plannedAndRecordedPhases(run: WorkflowSnapshot): Array<{
  phase?: WorkflowPhase;
  phaseIndex: number;
  position: number;
}> {
  const phaseCount = Math.max(run.phases.length, run.plannedPhaseCount ?? 0);
  const usedIndexes = new Set(run.phases.map((phase) => phase.index));
  return Array.from({ length: phaseCount }, (_, offset) => {
    const phase = run.phases[offset];
    let phaseIndex = phase?.index ?? offset;
    while (!phase && usedIndexes.has(phaseIndex)) phaseIndex++;
    usedIndexes.add(phaseIndex);
    return { phase, phaseIndex, position: offset + 1 };
  });
}

function agentsForPhase(
  run: WorkflowSnapshot,
  phaseIndex: number,
  phase: WorkflowPhase | undefined,
): readonly WorkflowAgentRecord[] {
  const referenced = new Set(phase?.agents ?? []);
  return run.agents.filter((agent) => agent.phase === phaseIndex || referenced.has(agent.index));
}

function phaseForAgent(
  phases: readonly WorkflowOutlinePhaseNode[],
  phaseAgents: ReadonlyMap<WorkflowOutlinePhaseKey, readonly WorkflowAgentRecord[]>,
  agent: WorkflowAgentRecord,
): WorkflowOutlinePhaseNode | undefined {
  return phases.find((phase) => phase.phaseIndex === agent.phase)
    ?? phases.find((phase) => (phaseAgents.get(phase.key) ?? []).some((candidate) => candidate.index === agent.index));
}

function phaseNeedsAttention(status: WorkflowStatus): boolean {
  return status === "failed" || status === "aborted" || status === "paused";
}

function agentNeedsAttention(agent: WorkflowAgentRecord): boolean {
  return !!agent.waitingOn
    || agent.state === "running"
    || agent.state === "waiting"
    || agent.state === "failed"
    || agent.state === "cancelled"
    || agent.state === "aborted";
}

function outlineNodePriority(
  node: WorkflowOutlineNode,
  selected: WorkflowOutlineSelection | undefined,
  selectedIndex: number,
  index: number,
): number {
  if (node.key === selected?.key) return 10_000;
  if (selected?.kind === "agent" && node.kind === "phase" && node.key === selected.phaseKey) return 9_000;
  if (node.kind === "phase" && node.current) return 8_000;
  if (node.attention) return 7_000;
  return 1_000 - Math.abs(selectedIndex - index);
}
