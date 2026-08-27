import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerParentThreadChildTool } from "../extensions/parent-thread/index.ts";
import { configuredHarnessFromEnv, parseHumanSubagentCommand, permittedHumanPiToolNames, registerNativeSubagents, summarizeSubagentActivity } from "../extensions/subagents/index.ts";
import { PI_CHILD_MARKER } from "../src/backends/pi-rpc.ts";
import { PI_PARENT_THREAD_FILE } from "../src/parent-thread-context.ts";
import { buildCatalog } from "../src/capabilities.ts";
import { claudeStatus, codexStatus, parseClaudeAuthStatus, parseCodexAccount, piStatusFromCatalog } from "../src/provider-status.ts";
import type { HarnessName } from "../src/types.ts";
import { ControlledBackend, HoldingBackend, ImmediateBackend, context, fakePi, jobSnapshot, readyProviderStatusReader, tempDir, theme, tick } from "./helpers.ts";

/** The parent session's tool inventory, including surfaces children must never inherit. */
const PARENT_TOOLS = [
  { name: "mcp", description: "MCP gateway", sourceInfo: { source: "npm:pi-mcp-adapter" } },
  { name: "browser", description: "Browser automation", sourceInfo: { source: "npm:pi-agent-browser" } },
  { name: "subagent_spawn", description: "Spawn a nested subagent", sourceInfo: { source: "extension" } },
  { name: "workflow", description: "Run a nested workflow", sourceInfo: { source: "extension" } },
  { name: "ask_user", description: "Prompt the user", sourceInfo: { source: "extension" } },
];

test("a Pi child with a parent snapshot registers only parent_thread_context", async (t) => {
  const root = await tempDir("parent-thread-child");
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = join(root, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({
    capturedAt: 1_000,
    totalMessages: 1,
    truncated: false,
    messages: [{ role: "user", text: "Analyze this decision" }],
  }));
  const child = fakePi();
  registerParentThreadChildTool(child.api, { [PI_CHILD_MARKER]: "1", [PI_PARENT_THREAD_FILE]: snapshotPath });
  assert.deepEqual([...child.tools.keys()], ["parent_thread_context"]);
  assert.deepEqual([...child.commands.keys()], []);
  const result = await child.tools.get("parent_thread_context").execute("context", {}, undefined, undefined, context().ctx);
  assert.match(result.content[0].text, /Analyze this decision/);
});

test("the subagent extension surface", async (t) => {
  const pi = fakePi({ allTools: PARENT_TOOLS });
  const registry = {};
  const backends = ["pi", "claude", "codex"].map((name) => new ImmediateBackend(name as any, { echoSend: true }));
  const extensionRoot = await tempDir("extension-workflows");
  const workflowArtifactRoot = join(extensionRoot, "runs");
  const globalProfilesDir = join(extensionRoot, "profiles");
  await mkdir(globalProfilesDir);
  await writeFile(join(globalProfilesDir, "audit.md"), "---\nname: audit\naccess: readOnly\n---\nAudit carefully.\n");
  const peerForks: Array<{ sourcePath: string; targetCwd: string }> = [];
  const sessionPeerSource = {
    listAll: async () => [{
      id: "saved-session", path: "/sessions/saved.jsonl", cwd: "/projects/source", name: "Saved design thread",
      createdAt: 1_000, modifiedAt: 2_000, messageCount: 6, firstMessage: "design the session bridge",
    }],
    fork: (sourcePath: string, targetCwd: string) => {
      peerForks.push({ sourcePath, targetCwd });
      return { sessionFile: "/sessions/forked.jsonl", sessionId: "forked-session" };
    },
  };
  const providerStatusRequests: Array<{ cwd: string; refresh?: boolean; harnesses?: HarnessName[] }> = [];
  const providerStatus = {
    async statuses(request: { cwd: string; refresh?: boolean; harnesses?: HarnessName[] }) {
      providerStatusRequests.push({ cwd: request.cwd, refresh: request.refresh, harnesses: request.harnesses });
      const statuses = [
        piStatusFromCatalog(buildCatalog({
          harness: "pi", cwd: request.cwd, access: "full", discoveredAt: 1_000, capabilities: [],
          sources: [{ source: "pi-model", health: "healthy", detail: "anthropic/claude-opus-5" }],
        }), 1_000),
        claudeStatus(parseClaudeAuthStatus(JSON.stringify({
          loggedIn: true, authMethod: "claude.ai", email: "engineer@example.com", subscriptionType: "max",
        })), 1_000),
        codexStatus(parseCodexAccount({ account: { type: "chatgpt" } }), 1_000),
      ];
      return request.harnesses?.length
        ? statuses.filter((status) => request.harnesses!.includes(status.harness))
        : statuses;
    },
  };
  registerNativeSubagents(pi.api, { registry, legacyRoot: false, backends, workflowArtifactRoot, globalProfilesDir, sessionPeerSource, providerStatus });

  const { ctx, notifications, statuses } = context({ sessionId: "extension-session", branch: [
    { type: "message", message: { role: "user", content: "Discuss the parent-thread bridge", timestamp: 1_000 } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Use a pull-based tool." }], timestamp: 2_000 } },
    { type: "custom", customType: "native-subagents-harness", data: { harness: "pi" } },
  ] });
  ctx.cwd = extensionRoot;
  pi.handlers.get("session_start")?.({}, ctx);
  await tick();
  assert.deepEqual(providerStatusRequests[0], {
    cwd: extensionRoot,
    refresh: undefined,
    harnesses: ["pi", "claude", "codex"],
  }, "trusted session startup prewarms every supported harness without a model turn");
  assert.equal(statuses.get("native-subagents"), "subagents:pi:ready", "the non-color status text reflects startup readiness");

  await t.test("registers the generic tool and command surface exactly once", async () => {
    assert.equal(configuredHarnessFromEnv({ PI_NATIVE_SUBAGENTS_HARNESS: "claude" }), "claude");
    assert.equal(configuredHarnessFromEnv({}), "pi", "Pi is the provider-agnostic default harness");
    assert.equal(configuredHarnessFromEnv({ PI_NATIVE_SUBAGENTS_BACKEND: "codex" }), "pi", "obsolete backend env is ignored");
    assert.deepEqual([...pi.tools.keys()].sort(), [
      "session_peer_fork", "session_peer_list",
      "subagent", "subagent_answer", "subagent_cancel", "subagent_capabilities", "subagent_check", "subagent_list", "subagent_send", "subagent_spawn", "subagent_wait", "workflow",
    ]);
    assert.deepEqual([...pi.commands.keys()].sort(), ["subagent", "subagents", "subagents-config", "workflows"]);
    assert.deepEqual(parseHumanSubagentCommand('--harness claude --model opus --name "auth review" --effort high --access readOnly "Review the auth flow"'), {
      harness: "claude",
      model: "opus",
      name: "auth review",
      effort: "high",
      access: "readOnly",
      task: "Review the auth flow",
    });
    assert.throws(() => parseHumanSubagentCommand("--harness nope investigate"), /Unknown harness/);
    assert.throws(() => parseHumanSubagentCommand("--model opus"), /A task is required/);
    assert.deepEqual(permittedHumanPiToolNames([
      { name: "mcp", description: "MCP gateway", source: "extension" },
      { name: "browser", description: "Browser automation", source: "extension" },
      { name: "subagent_spawn", description: "nested delegation", source: "extension" },
      { name: "workflow", source: "extension" },
      { name: "ask_user", source: "extension" },
    ]), ["mcp", "browser"]);
    const spawnTool = pi.tools.get("subagent_spawn");
    const spawnProperties = spawnTool.parameters.properties;
    assert.ok(spawnProperties.harness);
    assert.ok(spawnProperties.model);
    assert.equal(spawnProperties.backend, undefined, "backend compatibility is intentionally absent");
    assert.equal(spawnProperties.modelTier, undefined, "tier compatibility is intentionally absent");
    assert.ok(pi.messageRenderers.has("native-workflow-result"));
    assert.ok(pi.messageRenderers.has("native-subagent-result"));
    assert.ok(pi.entryRenderers.has("native-human-subagent"));
    assert.throws(() => registerNativeSubagents(fakePi().api, { registry, legacyRoot: false, backends }), /loaded more than once/);
  });

  await t.test("resolves global profiles and forks read-only session peers", async () => {
    await pi.commands.get("subagents").handler("profiles", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /audit \(global\)/);

    const listedPeers = await pi.tools.get("session_peer_list").execute("peer-list", { query: "design" }, undefined, undefined, ctx);
    assert.equal(listedPeers.details.peers[0].sessionId, "saved-session");
    await assert.rejects(
      pi.tools.get("session_peer_list").execute("untrusted-list", {}, undefined, undefined, context({ trusted: false }).ctx),
      /disabled for untrusted projects/,
    );
    const peer = await pi.tools.get("session_peer_fork").execute("peer-fork", {
      sessionId: "saved-session", message: "What trade-off did you settle on?", name: "design-peer",
    }, undefined, undefined, ctx);
    assert.equal(peer.details.job.peer.sourceSessionId, "saved-session");
    assert.equal(peer.details.job.access, "readOnly");
    assert.deepEqual(peerForks, [{ sourcePath: "/sessions/saved.jsonl", targetCwd: extensionRoot }]);
    await pi.tools.get("subagent_wait").execute("peer-wait", { jobId: peer.details.job.id }, undefined, undefined, ctx);
    const peerRequest = backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.resumeSessionFile === "/sessions/forked.jsonl");
    assert.equal(peerRequest?.rawInitialMessage, true, "peer questions are sent without the generic Task prefix");
    assert.deepEqual(peerRequest?.policy.piTools, [], "session peers cannot access child tools");
    await pi.tools.get("subagent_send").execute("peer-follow-up", {
      jobId: peer.details.job.id, message: "Why?", behavior: "followUp",
    }, undefined, undefined, ctx);
    await pi.tools.get("subagent_wait").execute("peer-follow-up-wait", { jobId: peer.details.job.id }, undefined, undefined, ctx);
    assert.match(backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.resumeSessionFile === "/sessions/forked.jsonl")?.systemPrompt ?? "", /read-only session peer/);
  });

  await t.test("reports masked provider readiness and gates it on project trust", async () => {
    const requestsBeforeReport = providerStatusRequests.length;
    await pi.commands.get("subagents").handler("providers", ctx);
    const report = notifications.at(-1)?.message ?? "";
    assert.match(report, /no model request was made/);
    // Normalized, non-color-only availability precedes the raw provider readiness.
    assert.match(report, /Native harness availability/);
    assert.match(report, /pi\s+active\s+ready/);
    assert.match(report, /codex\s+active\s+ready/);
    assert.match(report, /Active harnesses: pi, claude, codex\./);
    assert.match(report, /claude\s+ready · account e\*\*\*@example\.com · plan max/);
    assert.match(report, /codex\s+ready/);
    assert.ok(!report.includes("engineer@example.com"), "the command output never prints a full address");
    assert.equal(providerStatusRequests.length, requestsBeforeReport + 1);
    assert.deepEqual(providerStatusRequests.at(-1), { cwd: extensionRoot, refresh: false, harnesses: ["pi", "claude", "codex"] });

    await pi.commands.get("subagents").handler("providers refresh", ctx);
    assert.equal(providerStatusRequests.at(-1)?.refresh, true, "the refresh argument bypasses the status cache");

    const untrusted = context({ trusted: false });
    await pi.commands.get("subagents").handler("providers", untrusted.ctx);
    assert.match(untrusted.notifications.at(-1)?.message ?? "", /disabled for untrusted projects/);
    assert.equal(providerStatusRequests.length, requestsBeforeReport + 2, "an untrusted project never probes a provider");

    const completions = pi.commands.get("subagents").getArgumentCompletions("prov").map((item: { value: string }) => item.value);
    assert.deepEqual(completions, ["providers", "providers refresh"]);
  });

  await t.test("delivers an unconsumed background result exactly once", async () => {
    const background = await pi.tools.get("subagent_spawn").execute("spawn", { name: "research", task: "background" }, undefined, undefined, ctx);
    assert.equal(background.details.job.harness, "pi", "background spawn uses the configured harness");
    assert.equal(background.details.job.model, "default", "omitted models use the native harness default");
    assert.equal(background.details.job.access, "full", "trusted generic agents default to full access");
    const ordinaryBackgroundRequest = backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.task === "background");
    assert.ok(!ordinaryBackgroundRequest?.policy.piTools.includes("mcp"), "model-triggered spawns keep the explicit capability contract");
    assert.equal(ordinaryBackgroundRequest?.parentThread, undefined, "model-triggered spawns do not receive parent-thread content");
    await new Promise((resolve) => setImmediate(resolve));
    pi.handlers.get("agent_settled")?.();
    assert.equal(pi.messages[0]?.message.customType, "native-subagent-result", "unconsumed background result is delivered once");
  });

  await t.test("human jobs persist cards and receive a filtered parent snapshot", async () => {
    const entriesBeforeHumanCommand = pi.entries.length;
    const messagesBeforeHumanCommand = pi.messages.length;
    await pi.commands.get("subagent").handler('--harness claude --model caller-model --name "human review" "human task"', ctx);
    assert.equal(pi.messages.length, messagesBeforeHumanCommand, "human-triggered jobs do not notify the orchestrator");
    assert.equal(pi.entries.length, entriesBeforeHumanCommand + 2, "human jobs persist one card anchor and one hidden terminal update");
    const humanStart = pi.entries[entriesBeforeHumanCommand];
    const humanResult = pi.entries[entriesBeforeHumanCommand + 1];
    assert.equal(humanStart.customType, "native-human-subagent");
    assert.equal((humanStart.data as any).kind, "anchor");
    assert.equal((humanStart.data as any).job.status, "queued");
    assert.equal((humanStart.data as any).job.humanVisible, true);
    assert.equal((humanResult.data as any).kind, "update");
    assert.equal((humanResult.data as any).job.status, "completed");
    assert.equal((humanResult.data as any).job.output, "claude-ok");
    const humanRequest = backends.find((backend) => backend.name === "claude")?.starts.find((request) => request.task === "human task");
    assert.equal(humanRequest?.policy.model, "caller-model");
    assert.deepEqual(humanRequest?.parentThread?.messages.map((message) => [message.role, message.text]), [
      ["user", "Discuss the parent-thread bridge"],
      ["assistant", "Use a pull-based tool."],
    ], "human jobs receive a filtered spawn-time snapshot without assistant thinking");
    const humanCard = pi.entryRenderers.get("native-human-subagent")(humanStart, { expanded: true }, theme).render(120).join("\n");
    assert.match(humanCard, /claude\/caller-model/);
    assert.match(humanCard, /claude-ok/, "the original card settles with the terminal output");
    assert.deepEqual(
      pi.entryRenderers.get("native-human-subagent")(humanResult, { expanded: true }, theme).render(120),
      [],
      "the durable terminal update does not create a second visible card",
    );
  });

  await t.test("human jobs inherit permitted parent tools, bounded by access", async () => {
    const entriesBeforeDefaultHumanCommand = pi.entries.length;
    await pi.commands.get("subagent").handler("default human task", ctx);
    assert.equal(pi.entries.length, entriesBeforeDefaultHumanCommand + 2);
    const defaultHumanRequest = backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.task === "default human task");
    assert.equal(defaultHumanRequest?.policy.model, undefined, "an omitted human model uses the native default");
    assert.ok(defaultHumanRequest?.policy.piTools.includes("mcp"), "full human Pi jobs inherit permitted MCP/extension gateways");
    assert.ok(defaultHumanRequest?.policy.piTools.includes("browser"));
    assert.ok(defaultHumanRequest?.policy.piTools.includes("parent_thread_context"));
    assert.ok(!defaultHumanRequest?.policy.piTools.includes("subagent_spawn"));
    assert.ok(!defaultHumanRequest?.policy.piTools.includes("workflow"));
    assert.ok(!defaultHumanRequest?.policy.piTools.includes("ask_user"));

    await pi.commands.get("subagent").handler("--access readOnly read-only human task", ctx);
    const readOnlyHumanRequest = backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.task === "read-only human task");
    assert.deepEqual(
      readOnlyHumanRequest?.policy.piTools,
      ["read", "grep", "find", "ls", "parent_thread_context", "subagent_ask"],
      "a read-only human job keeps its host-owned parent-thread and routed-question tools and nothing else",
    );
  });

  await t.test("wait consumes delivery once per retained-session generation", async () => {
    const consumed = await pi.tools.get("subagent_spawn").execute("spawn", { name: "reader", task: "consumed", access: "readOnly", effort: "high" }, undefined, undefined, ctx);
    assert.equal(consumed.details.job.effort, "high");
    const waitCall = pi.tools.get("subagent_wait").renderCall({ jobId: consumed.details.job.id, timeoutMs: 600_000 }, theme).render(100);
    assert.deepEqual(waitCall, [], "wait orchestration does not create a second transcript block");
    const waited = await pi.tools.get("subagent_wait").execute("wait", { jobId: consumed.details.job.id }, undefined, undefined, ctx);
    const waitReceipt = pi.tools.get("subagent_wait").renderResult(waited, { expanded: false, isPartial: false }, theme, { args: {} }).render(100);
    assert.deepEqual(waitReceipt, [], "successful completion stays on the original live job card");
    pi.handlers.get("agent_settled")?.();
    assert.equal(pi.messages.length, 1, "wait consumes deferred delivery without duplication");
    const historicalContext = { args: {}, state: {}, invalidate() {} };
    const generationZero = pi.tools.get("subagent_spawn").renderResult(consumed, { expanded: true, isPartial: false }, theme, historicalContext).render(100).join("\n");
    assert.match(generationZero, /pi-ok/);
    const reused = await pi.tools.get("subagent_send").execute("send", { jobId: consumed.details.job.id, message: "second generation", behavior: "followUp" }, undefined, undefined, ctx);
    assert.equal(reused.details.job.effort, "high", "retained-session generations preserve request effort metadata");
    await new Promise((resolve) => setImmediate(resolve));
    pi.handlers.get("agent_settled")?.();
    assert.equal(pi.messages.length, 2, "consumption is scoped to one generation; reused-session output still delivers once");
    const historicalAfterFollowUp = pi.tools.get("subagent_spawn").renderResult(consumed, { expanded: true, isPartial: false }, theme, historicalContext).render(100).join("\n");
    assert.match(historicalAfterFollowUp, /pi-ok/);
    assert.doesNotMatch(historicalAfterFollowUp, /second generation/, "older thread cards stay pinned to their own generation");
  });

  await t.test("routes explicit harness, model, and effort, and independence against a producer", async () => {
    const explicitClaude = await pi.tools.get("subagent_spawn").execute("claude-model", {
      name: "implementation", task: "explicit Claude model", harness: "claude", model: "caller-model", effort: "max",
    }, undefined, undefined, ctx);
    assert.equal(explicitClaude.details.job.harness, "claude");
    assert.equal(explicitClaude.details.job.model, "caller-model");
    await pi.tools.get("subagent_wait").execute("wait-claude-model", { jobId: explicitClaude.details.job.id }, undefined, undefined, ctx);
    const explicitRequest = backends.find((backend) => backend.name === "claude")?.starts.find((request) => request.task === "explicit Claude model");
    assert.equal(explicitRequest?.policy.model, "caller-model");
    assert.equal(explicitRequest?.policy.effort, "max");
    const producerAdversary = await pi.tools.get("subagent_spawn").execute("producer-adversary", {
      name: "producer-adversary", task: "review the delegated implementation", independentOf: explicitClaude.details.job.id, access: "readOnly",
    }, undefined, undefined, ctx);
    assert.equal(producerAdversary.details.job.harness, "codex", "independentOf routes opposite the producer instead of the unknown parent fallback");
    assert.equal(producerAdversary.details.job.independentOf, explicitClaude.details.job.id);
    await pi.tools.get("subagent_wait").execute("wait-producer-adversary", { jobId: producerAdversary.details.job.id }, undefined, undefined, ctx);
    await assert.rejects(
      pi.tools.get("subagent_spawn").execute("blank-model", { task: "invalid", model: "   " }, undefined, undefined, ctx),
      /1–256/,
    );
  });

  await t.test("applies profiles as an access ceiling in direct tools", async () => {
    const profiled = await pi.tools.get("subagent").execute("profiled", { task: "profiled audit", profile: "audit", access: "full" }, undefined, undefined, ctx);
    assert.equal(profiled.details.job.access, "readOnly", "profile access is a ceiling in direct tools");
    assert.match(backends.find((backend) => backend.name === "pi")?.starts.find((request) => request.task === "profiled audit")?.systemPrompt ?? "", /Audit carefully/);
  });

  await t.test("resolves independence against the parent provider and rejects stale schemas", async () => {
    const foreground = await pi.tools.get("subagent").execute("foreground", { name: "foreground", task: "foreground" }, undefined, undefined, ctx);
    assert.equal(foreground.details.job.harness, "pi", "foreground uses the same configured generic route");
    const independentDefault = await pi.tools.get("subagent").execute("foreground-independent", { name: "independent", independent: true, task: "cross-provider default" }, undefined, undefined, ctx);
    assert.equal(independentDefault.details.job.harness, "claude", "unknown parent provider uses native Claude for independent work");
    assert.equal(independentDefault.details.job.model, "default");
    const { ctx: claudeParent } = context({ provider: "anthropic" });
    const independentAgainstClaude = await pi.tools.get("subagent_spawn").execute("independent-codex", { name: "second-opinion", independent: true, task: "review Claude independently" }, undefined, undefined, claudeParent);
    assert.equal(independentAgainstClaude.details.job.harness, "codex");
    assert.equal(independentAgainstClaude.details.job.model, "default");
    await assert.rejects(
      pi.tools.get("subagent_spawn").execute("independent-same", { independent: true, harness: "claude", task: "invalid same provider" }, undefined, undefined, claudeParent),
      /different from the parent claude/,
    );
    for (const stale of [{ role: "worker" }, { backend: "codex" }]) {
      await assert.rejects(
        pi.tools.get("subagent_spawn").execute("schema-mismatch", { ...stale, task: "wrong schema" }, undefined, undefined, ctx),
        /Subagent API schema mismatch: reload Pi to use the current task-driven schema\./,
      );
    }
  });

  await pi.handlers.get("session_shutdown")?.();
});

test("thread and human cards follow live job state without periodic rerenders", async () => {
  const blinkPi = fakePi({ allTools: PARENT_TOOLS });
  const blinkTimers = new Map<object, () => void>();
  let blinkDelay = 0;
  const fakeSetInterval = ((callback: () => void, delay: number) => {
    blinkDelay = delay;
    const timer = { unref() {} };
    blinkTimers.set(timer, callback);
    return timer;
  }) as unknown as typeof setInterval;
  const fakeClearInterval = ((timer: object) => { blinkTimers.delete(timer); }) as unknown as typeof clearInterval;
  registerNativeSubagents(blinkPi.api, {
    registry: {},
    legacyRoot: false,
    backends: ["pi", "claude", "codex"].map((name) => new HoldingBackend(name as any, { emitStarted: true })),
    workflowArtifactRoot: join(await tempDir("extension-blink-workflows"), "runs"),
    globalProfilesDir: join(await tempDir("extension-blink-profiles"), "profiles"),
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    providerStatus: readyProviderStatusReader(),
  });
  const { ctx: blinkCtx } = context();
  blinkPi.handlers.get("session_start")?.({}, blinkCtx);
  const active = await blinkPi.tools.get("subagent_spawn").execute("blink", { name: "blink", task: "show blink" }, undefined, undefined, blinkCtx);
  await new Promise((resolve) => setImmediate(resolve));
  let invalidations = 0;
  const renderContext = { args: {}, state: {}, invalidate: () => { invalidations++; } };
  const activeCard = blinkPi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(activeCard.render(80).some((line: string) => line.includes("running")), "background thread card follows the live job");
  assert.equal(blinkTimers.size, 0, "active thread cards do not schedule periodic rerenders");
  assert.equal(blinkDelay, 0);
  assert.equal(invalidations, 0);
  const timedWait = blinkPi.tools.get("subagent_wait").execute("wait-blink", { jobId: active.details.job.id, timeoutMs: 10 }, undefined, undefined, blinkCtx);
  const waitingCard = blinkPi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(waitingCard.render(80).some((line: string) => line.includes("waiting")), "the original job card owns the parent wait lifecycle");
  const timedOut = await timedWait;
  const timeoutNotice = blinkPi.tools.get("subagent_wait").renderResult(timedOut, { expanded: false, isPartial: false }, theme, { args: { timeoutMs: 10 }, state: {}, invalidate() {} }).render(100).join("\n");
  assert.match(timeoutNotice, /running after <1s wait timeout/, "non-terminal wait timeouts remain visible as exceptional outcomes");
  await blinkPi.tools.get("subagent_cancel").execute("cancel-blink", { jobId: active.details.job.id }, undefined, undefined, blinkCtx);
  assert.equal(blinkTimers.size, 0, "manager settlement does not leave a periodic render timer");
  const settledCard = blinkPi.tools.get("subagent_spawn").renderResult(active, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(settledCard.render(80).some((line: string) => line.includes("cancelled")), "thread card settles from remembered manager state");

  const humanEntryCount = blinkPi.entries.length;
  await blinkPi.commands.get("subagent").handler('--name "human live card" "wait for cancellation"', blinkCtx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blinkPi.entries.length, humanEntryCount + 1, "an active human job has only its visible anchor entry");
  const humanAnchor = blinkPi.entries[humanEntryCount];
  const humanLiveCard = blinkPi.entryRenderers.get("native-human-subagent")(humanAnchor, { expanded: false }, theme);
  assert.match(humanLiveCard.render(100).join("\n"), /running/);
  const humanJobs = (await blinkPi.tools.get("subagent_list").execute()).details.jobs;
  const humanJob = humanJobs.find((job: any) => job.humanVisible && job.name === "human live card");
  await blinkPi.tools.get("subagent_cancel").execute("cancel-human", { jobId: humanJob.id }, undefined, undefined, blinkCtx);
  assert.equal(blinkPi.entries.length, humanEntryCount + 2, "settlement adds only a hidden durable update");
  assert.match(humanLiveCard.render(100).join("\n"), /cancelled/, "the existing component settles in place");
  const humanUpdate = blinkPi.entries[humanEntryCount + 1];
  assert.deepEqual(blinkPi.entryRenderers.get("native-human-subagent")(humanUpdate, { expanded: false }, theme).render(100), []);
});

test("summarizeSubagentActivity distinguishes direct and workflow-owned jobs", () => {
  const workflowRef = { runId: "wf-1", agentIndex: 0, label: "build" };

  const inactive = summarizeSubagentActivity([
    jobSnapshot({ status: "completed" }),
    jobSnapshot({ status: "failed" }),
    jobSnapshot({ status: "cancelled" }),
  ]);
  assert.deepEqual(inactive.segments, []);
  assert.deepEqual(inactive.pointers, []);

  const directRunning = summarizeSubagentActivity([jobSnapshot({ status: "running" })]);
  assert.equal(directRunning.segments[0].summary, "1 subagent running");
  assert.equal(directRunning.segments[0].breakdown, "");
  assert.deepEqual(directRunning.pointers, ["/subagents"]);

  const directQueued = summarizeSubagentActivity([
    jobSnapshot({ status: "queued" }),
    jobSnapshot({ status: "queued" }),
  ]);
  assert.equal(directQueued.segments[0].summary, "2 subagents queued");
  assert.deepEqual(directQueued.pointers, ["/subagents"]);

  const directMixed = summarizeSubagentActivity([
    jobSnapshot({ status: "running" }),
    jobSnapshot({ status: "running" }),
    jobSnapshot({ status: "queued" }),
  ]);
  assert.equal(directMixed.segments[0].summary, "3 subagents active");
  assert.equal(directMixed.segments[0].breakdown, " · 2 running · 1 queued");
  assert.deepEqual(directMixed.pointers, ["/subagents"]);

  const workflowOnly = summarizeSubagentActivity([
    jobSnapshot({ status: "running", workflow: workflowRef }),
  ]);
  assert.equal(workflowOnly.segments[0].summary, "1 workflow agent running");
  assert.deepEqual(workflowOnly.pointers, ["/workflows"]);
  assert.doesNotMatch(workflowOnly.text, /\/subagents/);

  const mixed = summarizeSubagentActivity([
    jobSnapshot({ status: "running" }),
    jobSnapshot({ status: "running", workflow: workflowRef }),
    jobSnapshot({ status: "queued", workflow: workflowRef }),
  ]);
  assert.equal(mixed.segments.length, 2);
  assert.equal(mixed.segments[0].owner, "direct");
  assert.equal(mixed.segments[0].summary, "1 subagent running");
  assert.equal(mixed.segments[1].owner, "workflow");
  assert.equal(mixed.segments[1].summary, "2 workflow agents active");
  assert.equal(mixed.segments[1].breakdown, " (1 running · 1 queued)");
  assert.deepEqual(mixed.pointers, ["/subagents", "/workflows"]);

  const directKey = summarizeSubagentActivity([jobSnapshot({ status: "running" })]).key;
  const workflowKey = summarizeSubagentActivity([jobSnapshot({ status: "running", workflow: workflowRef })]).key;
  assert.notEqual(directKey, workflowKey, "ownership must be part of the widget dedup key");
});
test("routed questions wake the parent thread once and resolve through subagent_answer", async () => {
  const pi = fakePi({ allTools: PARENT_TOOLS });
  const backend = new ControlledBackend("pi");
  registerNativeSubagents(pi.api, {
    registry: {},
    legacyRoot: false,
    backends: [backend],
    workflowArtifactRoot: join(await tempDir("extension-question-workflows"), "runs"),
    globalProfilesDir: join(await tempDir("extension-question-profiles"), "profiles"),
    providerStatus: readyProviderStatusReader(),
  });
  const { ctx } = context({ sessionId: "question-session" });
  pi.handlers.get("session_start")?.({}, ctx);

  const first = await pi.tools.get("subagent_spawn").execute("s1", { name: "first", task: "first task" }, undefined, undefined, ctx);
  const second = await pi.tools.get("subagent_spawn").execute("s2", { name: "second", task: "second task" }, undefined, undefined, ctx);
  await tick();
  // Settle-shaped so a rejection observed later in the test is never reported
  // as an unhandled rejection by the runner.
  const settle = (promise: Promise<{ answer: string }>) => promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
  );
  const asks = [
    settle(backend.ask(first.details.job.id, { question: "Which compatibility behavior stays?" })),
    settle(backend.ask(second.details.job.id, { question: "Which fixture is authoritative?" })),
  ];
  await tick();
  assert.equal(pi.messages.length, 0, "a busy parent turn is never re-entered mid-turn");

  pi.handlers.get("agent_settled")?.();
  const questions = pi.messages.filter((entry) => entry.message.customType === "native-subagent-question");
  assert.equal(questions.length, 2);
  assert.deepEqual(questions.map((entry) => entry.options.triggerTurn), [false, true],
    "a deliverable batch wakes exactly one parent turn");
  assert.match(questions[0]!.message.content, /Which compatibility behavior stays\?/);

  // Re-delivery must not happen for an already-delivered request.
  pi.handlers.get("agent_settled")?.();
  assert.equal(pi.messages.filter((entry) => entry.message.customType === "native-subagent-question").length, 2);

  const requestId = (questions[0]!.message.details as { interaction: { requestId: string } }).interaction.requestId;
  const answered = await pi.tools.get("subagent_answer").execute("a1", { requestId, answer: "keep the legacy flag" }, undefined, undefined, ctx);
  assert.equal(answered.details.interaction.state, "answered");
  const resumed = await asks[0]!;
  assert.ok(resumed.ok && /keep the legacy flag/.test(resumed.value.answer));
  await assert.rejects(
    pi.tools.get("subagent_answer").execute("a2", { requestId, answer: "again" }, undefined, undefined, ctx),
    /Unknown or already-resolved question/,
  );

  const card = pi.messageRenderers.get("native-subagent-question")(questions[0]!.message, { expanded: true }, theme).render(100).join("\n");
  assert.match(card, /asks the orchestrator/);
  assert.match(card, /Which compatibility behavior stays\?/);
  assert.match(card, /answered/, "a settled question stops advertising itself as pending in the transcript");
  assert.match(card, /keep the legacy flag/, "the delivered answer stays auditable next to the question");

  await pi.handlers.get("session_shutdown")?.();
  const abandoned = await asks[1]!;
  assert.ok(!abandoned.ok && /Session shutdown/.test(abandoned.error), "shutdown rejects every still-parked tool callback");
});

test("a wait-consumed job still delivers its question, and human jobs keep theirs off the parent thread", async () => {
  const pi = fakePi({ allTools: PARENT_TOOLS });
  const backend = new ControlledBackend("pi");
  registerNativeSubagents(pi.api, {
    registry: {},
    legacyRoot: false,
    backends: [backend],
    workflowArtifactRoot: join(await tempDir("extension-question2-workflows"), "runs"),
    globalProfilesDir: join(await tempDir("extension-question2-profiles"), "profiles"),
    providerStatus: readyProviderStatusReader(),
  });
  const { ctx } = context({ sessionId: "question-session-2", idle: true });
  pi.handlers.get("session_start")?.({}, ctx);

  const spawned = await pi.tools.get("subagent_spawn").execute("s1", { name: "watched", task: "watched task" }, undefined, undefined, ctx);
  await tick();
  const waiting = pi.tools.get("subagent_wait").execute("w1", { jobId: spawned.details.job.id, timeoutMs: 5_000 }, undefined, undefined, ctx);
  const asked = backend.ask(spawned.details.job.id, { question: "Do we keep the old header?" });
  await tick();
  assert.equal(pi.messages.filter((entry) => entry.message.customType === "native-subagent-question").length, 1,
    "subagent_wait consumes the eventual result, never the question that unblocks it");

  await pi.commands.get("subagent").handler('--name "human job" "human task"', ctx);
  await tick();
  const humanJob = (await pi.tools.get("subagent_list").execute()).details.jobs.find((job: any) => job.humanVisible);
  const humanAsk = backend.ask(humanJob.id, { question: "Which directory did you mean?" });
  await tick();
  assert.equal(pi.messages.filter((entry) => entry.message.customType === "native-subagent-question").length, 1,
    "a human /subagent question stays in /subagents instead of notifying the orchestrator");
  const parked = (await pi.tools.get("subagent_list").execute()).details.jobs.find((job: any) => job.id === humanJob.id);
  assert.equal(parked.interaction.humanVisible, true);
  assert.equal(parked.interaction.state, "pending");

  const requestId = (pi.messages.find((entry) => entry.message.customType === "native-subagent-question")!
    .message.details as { interaction: { requestId: string } }).interaction.requestId;
  await pi.tools.get("subagent_answer").execute("a1", { requestId, answer: "yes, keep it" }, undefined, undefined, ctx);
  assert.match((await asked).answer, /yes, keep it/);
  backend.complete(spawned.details.job.id, "finished");
  await waiting;
  const humanOutcome = humanAsk.then(() => undefined, (error: Error) => error.message);
  await pi.handlers.get("session_shutdown")?.();
  assert.match(await humanOutcome ?? "", /Session shutdown/);
});
