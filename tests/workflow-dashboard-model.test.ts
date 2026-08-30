import test from "node:test";
import assert from "node:assert/strict";
import {
  boundWorkflowOutline,
  buildWorkflowOutline,
  type WorkflowOutlineSelection,
} from "../extensions/workflows/dashboard-model.ts";
import { workflowSnapshotFixture } from "./helpers.ts";

test("workflow outline construction includes planned phases and expands only the selected phase's filtered agents", () => {
  const run = workflowSnapshotFixture("model");
  const template = run.phases[0]!;
  run.plannedPhaseCount = 4;
  run.currentPhase = 1;
  run.phases = [
    { ...template, index: 0, name: "Inspect", status: "completed", agents: [0] },
    { ...template, index: 1, name: "Verify", status: "running", agents: [1] },
    { ...template, index: 2, name: "Ship", status: "pending", agents: [] },
  ];
  run.agents[0]!.phase = 0;
  run.agents[1]!.phase = 1;

  const all = buildWorkflowOutline(run, "all", undefined, 65_000);
  assert.deepEqual(all.phases.map((phase) => ({
    key: phase.key,
    position: phase.position,
    name: phase.name,
    status: phase.status,
    progress: `${phase.completedAgents}/${phase.agentCount}`,
  })), [
    { key: "phase:0", position: 1, name: "Inspect", status: "completed", progress: "1/1" },
    { key: "phase:1", position: 2, name: "Verify", status: "running", progress: "0/1" },
    { key: "phase:2", position: 3, name: "Ship", status: "pending", progress: "0/0" },
    { key: "phase:3", position: 4, name: "Planned phase 4", status: "pending", progress: "0/0" },
  ]);
  assert.deepEqual(all.nodes.map((node) => node.key), ["phase:0", "phase:1", "agent:1", "phase:2", "phase:3"]);
  const expandedAgent = all.nodes.find((node) => node.kind === "agent");
  assert.ok(expandedAgent?.kind === "agent");
  assert.match(expandedAgent.summary.text, /checking failures/);

  const completed = buildWorkflowOutline(run, "completed", all.selected, 65_000);
  assert.deepEqual(completed.phases.map((phase) => phase.key), ["phase:0", "phase:1", "phase:2", "phase:3"], "filters never remove phases");
  assert.equal(completed.nodes.filter((node) => node.kind === "agent").length, 0);
  assert.equal(completed.phases[1]!.hiddenAgentCount, 1);
});

test("workflow outline phase labels preserve declared, dynamic-active, terminal, and no-current semantics", () => {
  const dynamic = workflowSnapshotFixture("dynamic-progress");
  const template = dynamic.phases[0]!;
  dynamic.phases = [
    { ...template, index: 0, name: "First", agents: [0] },
    { ...template, index: 1, name: "Second", agents: [1] },
  ];
  dynamic.currentPhase = 0;
  dynamic.agents[0]!.phase = 0;
  dynamic.agents[1]!.phase = 1;

  const active = buildWorkflowOutline(dynamic, "all", undefined, 65_000);
  assert.deepEqual(active.phases.map((phase) => phase.progressLabel), ["1/?", "2/?"]);
  assert.equal(active.phaseProgress.label, "1/?");

  dynamic.currentPhase = null;
  const noCurrent = buildWorkflowOutline(dynamic, "all", undefined, 65_000);
  assert.equal(noCurrent.phaseProgress.label, "waiting");
  assert.deepEqual(noCurrent.phases.map((phase) => phase.progressLabel), ["1/?", "2/?"]);

  dynamic.status = "completed";
  const terminal = buildWorkflowOutline(dynamic, "all", undefined, 65_000);
  assert.equal(terminal.phaseProgress.label, "2/2");
  assert.deepEqual(terminal.phases.map((phase) => phase.progressLabel), ["1/2", "2/2"]);
});

test("workflow outline selection follows stable node identity and applies the documented fallback order", () => {
  const run = workflowSnapshotFixture("identity");
  const template = run.phases[0]!;
  run.currentPhase = 20;
  run.phases = [
    { ...template, index: 10, name: "Inspect", agents: [0] },
    { ...template, index: 20, name: "Verify", agents: [1] },
  ];
  run.agents[0]!.phase = 10;
  run.agents[1]!.phase = 20;
  const selected: WorkflowOutlineSelection = { kind: "agent", key: "agent:1", phaseKey: "phase:20" };

  run.phases.unshift({ ...template, index: 5, name: "Inserted", agents: [] });
  run.phases = [run.phases[2]!, run.phases[0]!, run.phases[1]!];
  run.agents.reverse();
  const reordered = buildWorkflowOutline(run, "all", selected, 65_000);
  assert.deepEqual(reordered.selected, selected, "phase insertion and agent reordering preserve the same agent key");

  const hidden = buildWorkflowOutline(run, "completed", selected, 65_000);
  assert.deepEqual(hidden.selected, { kind: "phase", key: "phase:20", phaseKey: "phase:20" }, "a filtered agent falls back to its containing phase");

  run.phases = run.phases.filter((phase) => phase.index !== 20);
  run.agents = run.agents.filter((agent) => agent.index !== 1);
  run.currentPhase = 10;
  const current = buildWorkflowOutline(run, "all", selected, 65_000);
  assert.deepEqual(current.selected, { kind: "phase", key: "phase:10", phaseKey: "phase:10" }, "a removed containing phase falls back to the current phase");

  run.currentPhase = null;
  const first = buildWorkflowOutline(run, "all", selected, 65_000);
  assert.equal(first.selected?.key, first.phases[0]?.key, "without a current phase the first visible node wins");
});

test("workflow outline bounding never hides selection and gives current and attention nodes the remaining slots", () => {
  const run = workflowSnapshotFixture("bounded");
  const template = run.phases[0]!;
  run.currentPhase = 4;
  run.phases = Array.from({ length: 7 }, (_, index) => ({
    ...template,
    index,
    name: `Phase ${index}`,
    status: index === 1 ? "failed" as const : index === 4 ? "running" as const : "completed" as const,
    agents: index === 6 ? [1] : [],
  }));
  run.agents = [run.agents[1]!];
  run.agents[0]!.phase = 6;
  const selected: WorkflowOutlineSelection = { kind: "agent", key: "agent:1", phaseKey: "phase:6" };
  const model = buildWorkflowOutline(run, "all", selected, 65_000);

  const tiny = boundWorkflowOutline(model, 1);
  assert.deepEqual(tiny.map((row) => row.kind === "node" ? row.node.key : row.key), ["agent:1"]);

  const bounded = boundWorkflowOutline(model, 4);
  const keys = bounded.filter((row) => row.kind === "node").map((row) => row.node.key);
  assert.ok(keys.includes("agent:1"), "the selected node is always present");
  assert.ok(keys.includes("phase:6"), "a selected agent keeps its containing phase under pressure");
  assert.ok(keys.includes("phase:4") || keys.includes("phase:1"), "current and failed phases win the remaining node slot");
  const omission = bounded.find((row) => row.kind === "omission");
  assert.ok(omission && omission.omitted > 0);
  assert.equal(bounded.length, 4);
});
