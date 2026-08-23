import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import type { Backend } from "../src/types.ts";
import { ControlledBackend, HoldingBackend, ImmediateBackend, context, fakePi, tempDir, theme, waitFor } from "./helpers.ts";

/** Workflow agents echo `<name>:<task>` and report usage so cards have content to render. */
const WORKFLOW_BACKENDS = ["pi", "claude", "codex"] as const;
const workflowBackend = (name: (typeof WORKFLOW_BACKENDS)[number]) => new ImmediateBackend(name, {
  output: (request) => `${request.name}:${request.task}`,
  usage: { input: 12, output: 3, cost: 0.01, turns: 1 },
});

async function setup(options: {
  backends?: Backend[];
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
} = {}) {
  const root = join(await tempDir("workflow-extension"), "runs");
  const globalProfilesDir = join(await tempDir("workflow-extension-profiles"), "profiles");
  const savedWorkflowRoot = join(await tempDir("workflow-extension-saved"), "definitions");
  await mkdir(savedWorkflowRoot, { recursive: true });
  const pi = fakePi();
  const backends = options.backends ?? WORKFLOW_BACKENDS.map(workflowBackend);
  registerNativeSubagents(pi.api, {
    registry: {}, legacyRoot: false, backends, workflowArtifactRoot: root, globalProfilesDir, savedWorkflowRoot,
    setInterval: options.setInterval, clearInterval: options.clearInterval,
  });
  return { root, savedWorkflowRoot, pi };
}

test("direct and workflow agents use Pi by default and forward exact models or native defaults", async () => {
  const piBackend = workflowBackend("pi");
  const { pi } = await setup({ backends: [piBackend] });
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const direct = await pi.tools.get("subagent").execute("direct", { task: "direct", model: "direct-model" }, undefined, undefined, ctx);
  assert.equal(direct.details.job.model, "direct-model");
  const workflow = await pi.tools.get("workflow").execute("wf", {
    name: "routing",
    script: `export default async () => agent("workflow " + args.subject, { model: "workflow-model" })`,
    input: { subject: "agent" },
  }, undefined, undefined, ctx);
  assert.equal(workflow.details.workflow.agents[0].model, "workflow-model");
  assert.equal(workflow.details.workflow.agents[0].harness, "pi");
  assert.equal(piBackend.requests.at(-1)?.policy.model, "workflow-model");
  assert.equal(piBackend.requests.at(-1)?.task, "workflow agent");
  const requestsBeforeResume = piBackend.requests.length;
  const resumed = await pi.tools.get("workflow").execute("wf-resume", {
    name: "routing",
    script: `export default async () => agent("workflow " + args.subject, { model: "workflow-model" })`,
    input: { subject: "agent" },
    resumeFromRunId: workflow.details.workflow.runId,
  }, undefined, undefined, ctx);
  assert.equal(resumed.details.workflow.replay.matchedCalls, 1);
  assert.equal(piBackend.requests.length, requestsBeforeResume, "resuming an exact completed workflow replays without dispatch");
  const nativeDefault = await pi.tools.get("subagent").execute("default", { task: "default" }, undefined, undefined, ctx);
  assert.equal(nativeDefault.details.job.harness, "pi");
  assert.equal(nativeDefault.details.job.model, "default");
  assert.equal(piBackend.requests.at(-1)?.policy.model, undefined);
  await pi.handlers.get("session_shutdown")?.();
});

test("background workflows return immediately and deliver one follow-up result for success or failure", async () => {
  const { pi } = await setup();
  const { ctx } = context({ hasUI: true });
  assert.equal(pi.tools.get("workflow").renderShell, "self", "workflow should use the inline trace shell");
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("wf", {
    name: "Background review",
    script: `export default async () => agent("inspect", { name: "reviewer", access: "readOnly" })`,
    background: true,
  }, new AbortController().signal, undefined, ctx);
  assert.match(result.content[0].text, /Workflow started/);

  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0]?.message.customType, "native-workflow-result");
  assert.equal(pi.messages[0]?.options.deliverAs, "followUp");
  assert.equal(pi.messages[0]?.options.triggerTurn, true);
  assert.equal(pi.messages[0]?.message.details.workflow.status, "completed");
  assert.doesNotMatch(pi.messages[0]?.message.content ?? "", /Artifacts:|workflow-extension-/i, "model-facing results omit machine-local artifact paths");
  assert.equal(pi.messages[0]?.message.details.workflow.agents[0]?.prompt, undefined, "model-facing compact details exclude agent prompts");
  assert.equal(pi.messages[0]?.message.details.workflow.agents[0]?.tools, undefined, "model-facing compact details exclude supervision traces");
  await pi.handlers.get("session_shutdown")?.();

  const failed = await setup();
  const failedContext = context({ hasUI: true });
  failed.pi.handlers.get("session_start")?.({}, failedContext.ctx);
  await failed.pi.tools.get("workflow").execute("wf", {
    name: "Background failure",
    script: `export default async () => { throw new Error("script exploded") }`,
    background: true,
  }, new AbortController().signal, undefined, failedContext.ctx);
  for (let index = 0; index < 500 && failed.pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(failed.pi.messages.length, 1);
  assert.equal(failed.pi.messages[0]?.message.details.workflow.status, "failed");
  assert.match(failed.pi.messages[0]?.message.details.workflow.error ?? "", /script exploded/);
  await failed.pi.handlers.get("session_shutdown")?.();
});

test("terminal delivery includes budget warnings and status retains unsuccessful completions", async () => {
  const piBackend = workflowBackend("pi");
  const { pi } = await setup({ backends: [piBackend] });
  const session = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, session.ctx);

  const direct = await pi.tools.get("subagent").execute("direct-budget", {
    task: "direct warning",
    maxTokens: 5,
  }, undefined, undefined, session.ctx);
  assert.match(direct.content[0].text, /Warnings:\n- Subagent budget tokens limit reached/);

  await pi.tools.get("subagent_spawn").execute("direct-background-budget", {
    task: "direct background warning",
    maxTokens: 5,
  }, undefined, undefined, session.ctx);
  await pi.handlers.get("agent_settled")?.();
  assert.match(pi.messages[0]?.message.content ?? "", /Warnings:\n- Subagent budget tokens limit reached/);
  pi.messages.length = 0;

  const workflowForeground = await pi.tools.get("workflow").execute("workflow-foreground-budget", {
    name: "Foreground budget warning",
    script: `export default async () => agent("workflow foreground warning", { access: "readOnly" })`,
    budget: { maxTokens: 5, maxCost: 0.005, maxTurns: 1, maxTokensPerAgent: 5 },
  }, undefined, undefined, session.ctx);
  const terminalText = workflowForeground.content[0].text;
  for (const warning of [
    "Workflow budget tokens limit reached",
    "Workflow budget cost limit reached",
    "Workflow budget turns limit reached",
    "Workflow budget agent tokens limit reached",
  ]) assert.match(terminalText, new RegExp(warning));

  await pi.tools.get("workflow").execute("workflow-budget", {
    name: "Budget warning",
    script: `export default async () => agent("workflow warning", { access: "readOnly" })`,
    budget: { maxTokens: 5 },
    background: true,
  }, new AbortController().signal, undefined, session.ctx);
  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(pi.messages[0]?.message.content ?? "", /Warnings:\n- Workflow budget tokens limit reached/);

  const unsuccessful = await pi.tools.get("workflow").execute("unsuccessful", {
    name: "Rejected review",
    script: `export default async () => ({ ok: false })`,
  }, undefined, undefined, session.ctx);
  assert.equal(unsuccessful.details.workflow.status, "completed");
  assert.equal(unsuccessful.details.workflow.taskOutcome, "unsuccessful");
  assert.match(session.statuses.get("native-workflows") ?? "", /1!/);
  await pi.handlers.get("session_shutdown")?.();
});

test("background workflow cards follow live state without periodic rerenders", async () => {
  const backend = new HoldingBackend();
  const timers = new Map<object, () => void>();
  let blinkDelay = 0;
  const fakeSetInterval = ((callback: () => void, delay: number) => {
    blinkDelay = delay;
    const timer = { unref() {} };
    timers.set(timer, callback);
    return timer;
  }) as unknown as typeof setInterval;
  const fakeClearInterval = ((timer: object) => { timers.delete(timer); }) as unknown as typeof clearInterval;
  const { pi } = await setup({ backends: [backend], setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("wf-live", {
    name: "Live review",
    script: `export default async () => agent("inspect", { name: "inspection", access: "readOnly" })`,
    background: true,
  }, new AbortController().signal, undefined, ctx);
  for (let index = 0; index < 500 && backend.starts === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(backend.starts, 1);

  let invalidations = 0;
  const renderContext = { args: {}, state: {}, invalidate: () => { invalidations++; } };
  const activeCard = pi.tools.get("workflow").renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(activeCard.render(100).some((line: string) => line.includes("running")));
  assert.equal(timers.size, 0);
  assert.equal(blinkDelay, 0);
  assert.equal(invalidations, 0);

  backend.complete("review complete");
  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(timers.size, 0, "terminal workflow state leaves no periodic render timer");
  assert.ok(invalidations > 0, "workflow events still invalidate the existing card");
  const settledCard = pi.tools.get("workflow").renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(100).some((line: string) => line.includes("completed")));
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow tool resolves saved definitions and enforces one script source", async () => {
  const { pi, savedWorkflowRoot } = await setup();
  await writeFile(join(savedWorkflowRoot, "saved-review.js"), `export default async () => agent("saved " + args.subject, { access: "readOnly" });`);
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute("saved", {
    workflowName: "saved-review",
    input: { subject: "workflow" },
  }, undefined, undefined, ctx);
  assert.equal(result.details.workflow.name, "saved-review");
  assert.equal(result.details.workflow.status, "completed");
  await assert.rejects(pi.tools.get("workflow").execute("ambiguous", {
    script: `export default null`, workflowName: "saved-review",
  }, undefined, undefined, ctx), /exactly one/);
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow onMutate approval is decided by the host UI", async () => {
  const { pi } = await setup();
  let confirmations = 0;
  const approved = context({ hasUI: true, confirm: async () => { confirmations++; return true; } });
  pi.handlers.get("session_start")?.({}, approved.ctx);
  const result = await pi.tools.get("workflow").execute("approved", {
    name: "approved", script: `export default async () => agent("mutate", {})`, approval: "onMutate",
  }, undefined, undefined, approved.ctx);
  assert.equal(result.details.workflow.status, "completed");
  assert.equal(confirmations, 1);
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow tool rejects invalid JSON args and untrusted projects", async () => {
  const invalid = await setup();
  const trusted = context({ hasUI: true });
  invalid.pi.handlers.get("session_start")?.({}, trusted.ctx);
  await assert.rejects(
    invalid.pi.tools.get("workflow").execute("wf", { name: "bad", script: "export default async () => null", args: "{" }, undefined, undefined, trusted.ctx),
    /valid JSON/,
  );
  await assert.rejects(
    invalid.pi.tools.get("workflow").execute("wf", {
      name: "ambiguous",
      script: "export default async () => null",
      args: "{}",
      input: {},
    }, undefined, undefined, trusted.ctx),
    /either structured input or legacy JSON args/i,
  );
  await invalid.pi.handlers.get("session_shutdown")?.();

  const denied = await setup();
  const untrusted = context({ hasUI: true, trusted: false });
  denied.pi.handlers.get("session_start")?.({}, untrusted.ctx);
  await assert.rejects(
    denied.pi.tools.get("workflow").execute("wf", { name: "denied", script: "export default async () => null" }, undefined, undefined, untrusted.ctx),
    /disabled for untrusted projects/,
  );
  await denied.pi.commands.get("workflows").handler("", untrusted.ctx);
  assert.match(untrusted.notifications.at(-1)?.message ?? "", /unavailable for untrusted projects/);
  await denied.pi.handlers.get("session_shutdown")?.();
});

test("the activity widget distinguishes direct and workflow-owned jobs and points at both dashboards", async () => {
  const directBackend = new HoldingBackend("codex");
  const workflowAgentBackend = new HoldingBackend("pi");
  const { pi } = await setup({ backends: [directBackend, workflowAgentBackend] });
  const session = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, session.ctx);
  assert.equal(session.widgets.get("native-subagents-active"), undefined);

  await pi.tools.get("subagent_spawn").execute("direct", { name: "direct", task: "direct work", harness: "codex" }, undefined, undefined, session.ctx);
  await waitFor(() => directBackend.starts >= 1, "direct job dispatched");
  const started = await pi.tools.get("workflow").execute("wf-live", {
    name: "Background hold",
    script: `export default async () => agent("hold", { name: "held", access: "readOnly" })`,
    background: true,
  }, new AbortController().signal, undefined, session.ctx);
  assert.match(started.content[0].text, /Workflow started/);
  await waitFor(() => workflowAgentBackend.starts >= 1, "workflow agent dispatched");

  const widgetFactory = session.widgets.get("native-subagents-active") as (tui: unknown, theme: unknown) => { render(width: number): string[] };
  assert.ok(widgetFactory, "widget is set while both direct and workflow-owned jobs are active");
  const line = widgetFactory(undefined, theme).render(120).join("\n");
  assert.match(line, /1 subagent running/);
  assert.match(line, /1 workflow agent running/);
  assert.match(line, /\/subagents/);
  assert.match(line, /\/workflows/);

  await pi.handlers.get("session_shutdown")?.();
  assert.equal(session.widgets.get("native-subagents-active"), undefined);
});

test("the activity widget reflects a workflow agent still queued behind a full four-job scheduler budget", async () => {
  const backend = new ControlledBackend("codex");
  const { pi } = await setup({ backends: [backend] });
  const session = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, session.ctx);

  for (let index = 0; index < 4; index++) {
    await pi.tools.get("subagent_spawn").execute(`hold-${index}`, { name: `hold-${index}`, task: `hold ${index}`, harness: "codex" }, undefined, undefined, session.ctx);
  }
  await waitFor(() => backend.starts.length === 4, "four direct jobs occupy the entire scheduler budget");

  const started = await pi.tools.get("workflow").execute("wf-queued", {
    name: "Queued behind direct jobs",
    script: `export default async () => agent("queued", { name: "queued", access: "readOnly", harness: "codex" })`,
    background: true,
  }, new AbortController().signal, undefined, session.ctx);
  assert.match(started.content[0].text, /Workflow started/);

  // The queued workflow agent never dispatches (no `started` event), so the widget
  // must pick it up from the spawn-time notification rather than a scheduler event.
  let line = "";
  await waitFor(() => {
    const widgetFactory = session.widgets.get("native-subagents-active") as
      ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
    if (!widgetFactory) return false;
    line = widgetFactory(undefined, theme).render(120).join("\n");
    return /workflow agent/.test(line);
  }, "widget reflects the newly queued workflow agent without waiting for another scheduler event");

  assert.equal(backend.starts.length, 4, "the fifth job stays queued rather than dispatching");
  assert.match(line, /4 subagents running/);
  assert.match(line, /1 workflow agent queued/);
  assert.match(line, /\/subagents/);
  assert.match(line, /\/workflows/);

  for (const jobId of backend.starts) backend.complete(jobId, "done");
  await pi.handlers.get("session_shutdown")?.();
});

test("/workflows worktrees reports an empty inventory and reclaim refuses without host confirmation", async () => {
  const { pi } = await setup();
  const plain = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, plain.ctx);

  await pi.commands.get("workflows").handler("worktrees", plain.ctx);
  assert.match(plain.notifications.at(-1)?.message ?? "", /No protected worktrees/);

  await pi.commands.get("workflows").handler("reclaim wf_deadbeef 0", plain.ctx);
  assert.match(plain.notifications.at(-1)?.message ?? "", /requires host confirmation/);
  await pi.handlers.get("session_shutdown")?.();

  const confirmable = context({ hasUI: true, confirm: async () => true });
  pi.handlers.get("session_start")?.({}, confirmable.ctx);
  await pi.commands.get("workflows").handler("reclaim wf_deadbeef 0", confirmable.ctx);
  assert.match(confirmable.notifications.at(-1)?.message ?? "", /No protected worktree for/);

  await pi.commands.get("workflows").handler("reclaim not-a-run-id", confirmable.ctx);
  assert.match(confirmable.notifications.at(-1)?.message ?? "", /Usage: \/workflows reclaim/);

  await pi.handlers.get("session_shutdown")?.();
});
