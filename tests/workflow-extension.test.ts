import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Check } from "typebox/value";
import { registerNativeSubagents } from "../extensions/subagents/index.ts";
import { DEFAULT_WORKFLOWS_SHORTCUT, WORKFLOWS_SHORTCUT_ENV } from "../extensions/workflows/index.ts";
import type { Backend } from "../src/types.ts";
import type { WorkflowSnapshot } from "../src/workflows/types.ts";
import {
  ControlledBackend,
  HoldingBackend,
  ImmediateBackend,
  context,
  fakePi,
  readyProviderStatusReader,
  tempDir,
  theme,
  waitFor,
} from "./helpers.ts";

/** Workflow agents echo `<name>:<task>` and report usage so cards have content to render. */
const WORKFLOW_BACKENDS = ["pi", "claude", "codex"] as const;
const workflowBackend = (name: (typeof WORKFLOW_BACKENDS)[number]) =>
  new ImmediateBackend(name, {
    output: (request) => `${request.name}:${request.task}`,
    usage: { input: 12, output: 3, cost: 0.01, turns: 1 },
  });

async function setup(
  options: {
    backends?: Backend[];
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const root = join(await tempDir("workflow-extension"), "runs");
  const globalProfilesDir = join(await tempDir("workflow-extension-profiles"), "profiles");
  const savedWorkflowRoot = join(await tempDir("workflow-extension-saved"), "definitions");
  await mkdir(savedWorkflowRoot, { recursive: true });
  const pi = fakePi();
  const backends = options.backends ?? WORKFLOW_BACKENDS.map(workflowBackend);
  registerNativeSubagents(pi.api, {
    registry: {},
    legacyRoot: false,
    backends,
    workflowArtifactRoot: root,
    globalProfilesDir,
    savedWorkflowRoot,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    providerStatus: readyProviderStatusReader(),
    env: options.env ?? { ...process.env, [WORKFLOWS_SHORTCUT_ENV]: undefined },
  });

  return { root, savedWorkflowRoot, pi };
}

test("direct and workflow agents use Pi by default and forward exact models or native defaults", async () => {
  const piBackend = workflowBackend("pi");
  const { pi } = await setup({ backends: [piBackend] });
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const direct = await pi.tools
    .get("subagent")
    .execute("direct", { task: "direct", model: "direct-model" }, undefined, undefined, ctx);
  assert.equal(direct.details.job.model, "direct-model");
  const workflow = await pi.tools.get("workflow").execute(
    "wf",
    {
      name: "routing",
      script: `export default async () => agent("workflow " + args.subject, { model: "workflow-model" })`,
      input: { subject: "agent" },
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(workflow.details.workflow.agents[0].model, "workflow-model");
  assert.equal(workflow.details.workflow.agents[0].harness, "pi");
  assert.equal(piBackend.requests.at(-1)?.policy.model, "workflow-model");
  assert.equal(piBackend.requests.at(-1)?.task, "workflow agent");
  const requestsBeforeResume = piBackend.requests.length;
  const resumed = await pi.tools.get("workflow").execute(
    "wf-resume",
    {
      name: "routing",
      script: `export default async () => agent("workflow " + args.subject, { model: "workflow-model" })`,
      input: { subject: "agent" },
      resumeFromRunId: workflow.details.workflow.runId,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(resumed.details.workflow.replay.matchedCalls, 1);
  assert.equal(
    piBackend.requests.length,
    requestsBeforeResume,
    "resuming an exact completed workflow replays without dispatch",
  );
  const nativeDefault = await pi.tools
    .get("subagent")
    .execute("default", { task: "default" }, undefined, undefined, ctx);
  assert.equal(nativeDefault.details.job.harness, "pi");
  assert.equal(nativeDefault.details.job.model, "default");
  assert.equal(piBackend.requests.at(-1)?.policy.model, undefined);
  await pi.handlers.get("session_shutdown")?.();
});

test("the workflow tool's retry schema accepts opt-in wait policies and rejects out-of-range or unknown values", async () => {
  const { pi } = await setup();
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const tool = pi.tools.get("workflow");
  const schema = tool.parameters;
  assert.ok(Object.hasOwn(schema.properties, "retry"), "workflow exposes a retry field");
  const base = { name: "wf", script: "export default async () => 1;" };
  assert.ok(Check(schema, base), "retry is optional");
  assert.ok(Check(schema, { ...base, retry: {} }), "an empty retry object is valid");
  assert.ok(Check(schema, { ...base, retry: { providerUnavailable: "fail" } }));
  assert.ok(Check(schema, { ...base, retry: { providerUnavailable: "wait", maxWaitMs: 1_000, maxAttempts: 1 } }));
  assert.ok(Check(schema, { ...base, retry: { providerUnavailable: "wait", maxWaitMs: 21_600_000, maxAttempts: 8 } }));
  assert.ok(
    !Check(schema, { ...base, retry: { providerUnavailable: "retry" } }),
    "unknown providerUnavailable values are rejected",
  );
  assert.ok(!Check(schema, { ...base, retry: { maxWaitMs: 999 } }), "maxWaitMs below 1000 is rejected");
  assert.ok(
    !Check(schema, { ...base, retry: { maxWaitMs: 21_600_001 } }),
    "maxWaitMs above the 6h ceiling is rejected",
  );
  assert.ok(!Check(schema, { ...base, retry: { maxAttempts: 0 } }), "maxAttempts below 1 is rejected");
  assert.ok(!Check(schema, { ...base, retry: { maxAttempts: 9 } }), "maxAttempts above 8 is rejected");
  await pi.handlers.get("session_shutdown")?.();
});

test("background workflows return immediately and deliver one follow-up result for success or failure", async () => {
  const { pi } = await setup();
  const { ctx } = context({ hasUI: true });
  assert.equal(pi.tools.get("workflow").renderShell, "self", "workflow should use the inline trace shell");
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute(
    "wf",
    {
      name: "Background review",
      script: `export default async () => agent("inspect", { name: "reviewer", access: "readOnly" })`,
      background: true,
    },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /Workflow started/);

  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(pi.messages.length, 1);
  const { message, options } = pi.messages[0]!;
  assert.equal(message.customType, "native-workflow-result");
  assert.equal(options?.deliverAs, "followUp");
  assert.equal(options?.triggerTurn, true);
  const { workflow } = message.details as { workflow: WorkflowSnapshot };
  assert.equal(workflow.status, "completed");
  assert.doesNotMatch(
    (message.content ?? "") as string,
    /Artifacts:|workflow-extension-/i,
    "model-facing results omit machine-local artifact paths",
  );
  assert.equal(workflow.agents[0]?.prompt, undefined, "model-facing compact details exclude agent prompts");
  assert.equal(workflow.agents[0]?.tools, undefined, "model-facing compact details exclude supervision traces");
  await pi.handlers.get("session_shutdown")?.();

  const failed = await setup();
  const failedContext = context({ hasUI: true });
  failed.pi.handlers.get("session_start")?.({}, failedContext.ctx);
  await failed.pi.tools.get("workflow").execute(
    "wf",
    {
      name: "Background failure",
      script: `export default async () => { throw new Error("script exploded") }`,
      background: true,
    },
    new AbortController().signal,
    undefined,
    failedContext.ctx,
  );

  for (let index = 0; index < 500 && failed.pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(failed.pi.messages.length, 1);
  const failureDetails = failed.pi.messages[0]?.message.details as { workflow: WorkflowSnapshot };
  assert.equal(failureDetails.workflow.status, "failed");
  assert.match(failureDetails.workflow.error ?? "", /script exploded/);
  await failed.pi.handlers.get("session_shutdown")?.();
});

test("terminal delivery includes budget warnings and status retains unsuccessful completions", async () => {
  const piBackend = workflowBackend("pi");
  const { pi } = await setup({ backends: [piBackend] });
  const session = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, session.ctx);

  const direct = await pi.tools.get("subagent").execute(
    "direct-budget",
    {
      task: "direct warning",
      maxTokens: 5,
    },
    undefined,
    undefined,
    session.ctx,
  );
  assert.match(direct.content[0].text, /Warnings:\n- Subagent budget tokens limit reached/);

  await pi.tools.get("subagent_spawn").execute(
    "direct-background-budget",
    {
      task: "direct background warning",
      maxTokens: 5,
    },
    undefined,
    undefined,
    session.ctx,
  );
  await pi.handlers.get("agent_settled")?.();
  assert.match((pi.messages[0]?.message.content ?? "") as string, /Warnings:\n- Subagent budget tokens limit reached/);
  pi.messages.length = 0;

  const workflowForeground = await pi.tools.get("workflow").execute(
    "workflow-foreground-budget",
    {
      name: "Foreground budget warning",
      script: `export default async () => agent("workflow foreground warning", { access: "readOnly" })`,
      budget: { maxTokens: 5, maxCost: 0.005, maxTurns: 1, maxTokensPerAgent: 5 },
    },
    undefined,
    undefined,
    session.ctx,
  );
  const terminalText = workflowForeground.content[0].text;

  for (const warning of [
    "Workflow budget tokens limit reached",
    "Workflow budget cost limit reached",
    "Workflow budget turns limit reached",
    "Workflow budget agent tokens limit reached",
  ]) {
    assert.match(terminalText, new RegExp(warning));
  }

  await pi.tools.get("workflow").execute(
    "workflow-budget",
    {
      name: "Budget warning",
      script: `export default async () => agent("workflow warning", { access: "readOnly" })`,
      budget: { maxTokens: 5 },
      background: true,
    },
    new AbortController().signal,
    undefined,
    session.ctx,
  );

  for (let index = 0; index < 500 && pi.messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.match((pi.messages[0]?.message.content ?? "") as string, /Warnings:\n- Workflow budget tokens limit reached/);

  const unsuccessful = await pi.tools.get("workflow").execute(
    "unsuccessful",
    {
      name: "Rejected review",
      script: `export default async () => ({ ok: false })`,
    },
    undefined,
    undefined,
    session.ctx,
  );
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
  const fakeClearInterval = ((timer: object) => {
    timers.delete(timer);
  }) as unknown as typeof clearInterval;
  const { pi } = await setup({ backends: [backend], setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute(
    "wf-live",
    {
      name: "Live review",
      script: `export default async () => agent("inspect", { name: "inspection", access: "readOnly" })`,
      background: true,
    },
    new AbortController().signal,
    undefined,
    ctx,
  );

  for (let index = 0; index < 500 && backend.starts === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(backend.starts, 1);

  let invalidations = 0;
  const renderContext = {
    args: {},
    state: {},
    invalidate: () => {
      invalidations++;
    },
  };
  const activeCard = pi.tools
    .get("workflow")
    .renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
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
  const settledCard = pi.tools
    .get("workflow")
    .renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(100).some((line: string) => line.includes("completed")));
  await pi.handlers.get("session_shutdown")?.();
});

test("inline workflow cards keep live activity through compact projection but discard replayed activity", async () => {
  const backend = new ControlledBackend("pi");
  const { pi } = await setup({ backends: [backend] });
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute(
    "wf-live-activity",
    {
      name: "Live activity",
      script: `export default async () => agent("inspect", { name: "inspection", access: "readOnly" })`,
      background: true,
    },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await backend.waitForStart();
  backend.emit(backend.starts[0]!, {
    type: "tool_start",
    id: "read-live",
    name: "Read",
    args: { path: "src/live-policy.ts" },
    at: Date.now(),
  });

  const liveCards: Array<{ expanded: boolean; lines: string }> = [];
  let liveCompactSnapshot: typeof result.details.workflow | undefined;

  for (const expanded of [false, true]) {
    const renderContext = { args: {}, state: {}, invalidate() {} };
    const lines = pi.tools
      .get("workflow")
      .renderResult(result, { expanded, isPartial: false }, theme, renderContext)
      .render(120)
      .join("\n");
    liveCards.push({ expanded, lines });
    liveCompactSnapshot = structuredClone(
      (renderContext.state as { nativeWorkflowSnapshot?: typeof result.details.workflow }).nativeWorkflowSnapshot,
    );
  }

  const replayDetails = structuredClone(result);
  assert.ok(liveCompactSnapshot?.agents[0], "live compact projection includes the active agent");
  replayDetails.details.workflow = liveCompactSnapshot;
  replayDetails.details.workflow.runId = `wf_${"f".repeat(24)}`;
  replayDetails.details.workflow.agents[0]!.activity = {
    kind: "tool",
    at: Date.now(),
    tool: "Read",
    state: "running",
    target: "REPLAYED_SECRET.ts",
  };
  const replayContext = { args: {}, state: {}, invalidate() {} };
  const replayCards: Array<{ expanded: boolean; lines: string }> = [];

  for (const expanded of [false, true]) {
    const lines = pi.tools
      .get("workflow")
      .renderResult(replayDetails, { expanded, isPartial: false }, theme, replayContext)
      .render(120)
      .join("\n");
    replayCards.push({ expanded, lines });
  }

  backend.complete(backend.starts[0]!, "done");
  await waitFor(() => pi.messages.length === 1, "live activity workflow delivery");
  await pi.handlers.get("session_shutdown")?.();

  assert.ok(
    result.details.workflow.agents.every((agent: { activity?: unknown }) => agent.activity === undefined),
    "durable tool details never receive live activity",
  );

  for (const { expanded, lines } of liveCards) {
    assert.match(
      lines,
      /Reading src\/live-policy\.ts/,
      `${expanded ? "expanded" : "collapsed"} live card retains activity`,
    );
  }

  for (const { expanded, lines } of replayCards) {
    assert.doesNotMatch(
      lines,
      /REPLAYED_SECRET|Reading/,
      `${expanded ? "expanded" : "collapsed"} replay card drops stale activity`,
    );
  }
});

test("workflow tool resolves saved definitions and enforces one script source", async () => {
  const { pi, savedWorkflowRoot } = await setup();
  await writeFile(
    join(savedWorkflowRoot, "saved-review.js"),
    `export default async () => agent("saved " + args.subject, { access: "readOnly" });`,
  );
  const { ctx } = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, ctx);
  const result = await pi.tools.get("workflow").execute(
    "saved",
    {
      workflowName: "saved-review",
      input: { subject: "workflow" },
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.workflow.name, "saved-review");
  assert.equal(result.details.workflow.status, "completed");
  await assert.rejects(
    pi.tools.get("workflow").execute(
      "ambiguous",
      {
        script: `export default null`,
        workflowName: "saved-review",
      },
      undefined,
      undefined,
      ctx,
    ),
    /exactly one/,
  );
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow onMutate approval is decided by the host UI", async () => {
  const { pi } = await setup();
  let confirmations = 0;
  const approved = context({
    hasUI: true,
    confirm: async () => {
      confirmations++;

      return true;
    },
  });
  pi.handlers.get("session_start")?.({}, approved.ctx);
  const result = await pi.tools.get("workflow").execute(
    "approved",
    {
      name: "approved",
      script: `export default async () => agent("mutate", {})`,
      approval: "onMutate",
    },
    undefined,
    undefined,
    approved.ctx,
  );
  assert.equal(result.details.workflow.status, "completed");
  assert.equal(confirmations, 1);
  await pi.handlers.get("session_shutdown")?.();
});

test("workflow tool rejects invalid JSON args and untrusted projects", async () => {
  const invalid = await setup();
  const trusted = context({ hasUI: true });
  invalid.pi.handlers.get("session_start")?.({}, trusted.ctx);
  await assert.rejects(
    invalid.pi.tools
      .get("workflow")
      .execute(
        "wf",
        { name: "bad", script: "export default async () => null", args: "{" },
        undefined,
        undefined,
        trusted.ctx,
      ),
    /valid JSON/,
  );
  await assert.rejects(
    invalid.pi.tools.get("workflow").execute(
      "wf",
      {
        name: "ambiguous",
        script: "export default async () => null",
        args: "{}",
        input: {},
      },
      undefined,
      undefined,
      trusted.ctx,
    ),
    /either structured input or legacy JSON args/i,
  );
  await invalid.pi.handlers.get("session_shutdown")?.();

  const denied = await setup();
  const untrusted = context({ hasUI: true, trusted: false });
  denied.pi.handlers.get("session_start")?.({}, untrusted.ctx);
  await assert.rejects(
    denied.pi.tools
      .get("workflow")
      .execute(
        "wf",
        { name: "denied", script: "export default async () => null" },
        undefined,
        undefined,
        untrusted.ctx,
      ),
    /disabled for untrusted projects/,
  );
  await denied.pi.commands.get("workflows")!.handler("", untrusted.ctx);
  assert.match(untrusted.notifications.at(-1)?.message ?? "", /unavailable for untrusted projects/);
  await denied.pi.handlers.get("session_shutdown")?.();
});

test("the configured workflow shortcut reports the session runs in RPC mode", async () => {
  const { pi } = await setup({
    backends: [new ControlledBackend("codex")],
    env: { ...process.env, [WORKFLOWS_SHORTCUT_ENV]: "Shift+Ctrl+W" },
  });
  const session = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, session.ctx);

  assert.equal(pi.shortcuts.has(DEFAULT_WORKFLOWS_SHORTCUT), false, "the default is replaced by the override");
  assert.ok(pi.shortcuts.get("ctrl+shift+w"), "the override is normalized to canonical modifier order");

  await pi.tools.get("workflow").execute(
    "wf-override",
    {
      name: "Override workflow",
      script: `export default async () => agent("task", { name: "agent", access: "readOnly", harness: "codex" })`,
      background: true,
    },
    undefined,
    undefined,
    session.ctx,
  );

  await pi.shortcuts.get("ctrl+shift+w")?.handler(session.ctx);
  assert.match(String(pi.messages.at(-1)?.message.content), /Override workflow/);
  await pi.handlers.get("session_shutdown")?.();
});

test("/workflows worktrees reports an empty inventory and reclaim refuses without host confirmation", async () => {
  const { pi } = await setup();
  const plain = context({ hasUI: true });
  pi.handlers.get("session_start")?.({}, plain.ctx);

  await pi.commands.get("workflows")!.handler("worktrees", plain.ctx);
  assert.match(plain.notifications.at(-1)?.message ?? "", /No protected worktrees/);

  await pi.commands.get("workflows")!.handler("reclaim wf_deadbeef 0", plain.ctx);
  assert.match(plain.notifications.at(-1)?.message ?? "", /requires host confirmation/);
  await pi.handlers.get("session_shutdown")?.();

  const confirmable = context({ hasUI: true, confirm: async () => true });
  pi.handlers.get("session_start")?.({}, confirmable.ctx);
  await pi.commands.get("workflows")!.handler("reclaim wf_deadbeef 0", confirmable.ctx);
  assert.match(confirmable.notifications.at(-1)?.message ?? "", /No protected worktree for/);

  await pi.commands.get("workflows")!.handler("reclaim not-a-run-id", confirmable.ctx);
  assert.match(confirmable.notifications.at(-1)?.message ?? "", /Usage: \/workflows reclaim/);

  await pi.handlers.get("session_shutdown")?.();
});
