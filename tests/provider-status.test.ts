import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, type CapabilitySourceStatus } from "../src/capabilities.ts";
import {
  claudeStatus,
  codexStatus,
  formatProviderStatusReport,
  maskEmail,
  maskEmbeddedEmails,
  parseClaudeAuthStatus,
  parseCodexAccount,
  piStatusFromCatalog,
  ProviderStatusService,
  type ProviderStatus,
} from "../src/provider-status.ts";

function piCatalog(sources: CapabilitySourceStatus[], warnings: string[] = []) {
  return buildCatalog({
    harness: "pi",
    cwd: "/proj",
    access: "full",
    discoveredAt: 1_000,
    capabilities: [],
    sources,
    warnings,
  });
}

test("claude auth status yields masked account metadata and subscription-only readiness", () => {
  const facts = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "engineer@example.com",
    subscriptionType: "max",
    organization: { name: "Acme Engineering", uuid: "org-123" },
    accessToken: "sk-ant-oat-super-secret",
    oauthAccount: { refreshToken: "refresh-super-secret" },
  }));
  const status = claudeStatus(facts, 5_000);
  assert.equal(status.ready, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.installed, true);
  assert.deepEqual(status.account, {
    email: "e***@example.com",
    plan: "max",
    authMethod: "claude.ai",
    organization: "Acme Engineering",
  });
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes("engineer@example.com"), "the full address is never retained");
  assert.ok(!/secret|accessToken|refreshToken/i.test(serialized), "credential fields are dropped by the parser");

  // Shape emitted by the installed CLI: a flat record with orgId/orgName.
  const flat = claudeStatus(parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true, authMethod: "claude.ai", apiProvider: "anthropic",
    email: "pilot@example.org", orgId: "org-abc", orgName: "Acme", subscriptionType: "pro",
  })), 5_000);
  assert.deepEqual(flat.account, { email: "p***@example.org", plan: "pro", authMethod: "claude.ai", organization: "Acme" });
  assert.ok(!JSON.stringify(flat).includes("org-abc"), "opaque account identifiers are not displayed");

  const apiKey = claudeStatus(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "apiKey", email: "b@c.io" })), 5_000);
  assert.equal(apiKey.authenticated, true, "an API-key login is still an authenticated CLI");
  assert.equal(apiKey.ready, false, "subagents require the claude.ai subscription route");
  assert.match(apiKey.detail ?? "", /claude\.ai subscription login/);

  const loggedOut = claudeStatus(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false })), 5_000);
  assert.deepEqual(
    [loggedOut.installed, loggedOut.authenticated, loggedOut.ready],
    [true, false, false],
    "an installed CLI that is logged out stays installed",
  );
  assert.equal(loggedOut.account?.email, undefined);
  assert.throws(() => parseClaudeAuthStatus("not json"), /invalid JSON/);
});

test("codex account/read yields account type and plan without credentials", () => {
  const status = codexStatus(parseCodexAccount({
    account: { type: "chatgpt", email: "pilot@openai.com", planType: "pro", tokens: { idToken: "secret" } },
  }), 7_000);
  assert.equal(status.ready, true);
  assert.deepEqual(status.account, { email: "p***@openai.com", plan: "pro", authMethod: "chatgpt" });
  assert.ok(!JSON.stringify(status).includes("secret"), "token payloads never reach the status");

  const apiKey = codexStatus(parseCodexAccount({ account: { type: "apikey" } }), 7_000);
  assert.equal(apiKey.authenticated, true);
  assert.equal(apiKey.ready, false);
  assert.match(apiKey.detail ?? "", /ChatGPT login/);

  const none = codexStatus(parseCodexAccount({}), 7_000);
  assert.deepEqual([none.installed, none.authenticated, none.ready], [true, false, false]);
  assert.match(none.detail ?? "", /not logged in/);
});

test("pi readiness reuses the zero-turn catalog and never invents an account", () => {
  const ready = piStatusFromCatalog(piCatalog([
    { source: "pi-parent", health: "healthy" },
    { source: "pi-child", health: "healthy" },
    { source: "pi-model", health: "healthy", detail: "anthropic/claude-opus-5" },
  ]), 9_000);
  assert.deepEqual([ready.installed, ready.authenticated, ready.ready], [true, true, true]);
  assert.equal(ready.model, "anthropic/claude-opus-5");
  assert.equal(ready.account?.email, undefined);
  assert.match(ready.account?.unavailable ?? "", /does not expose an account email/);

  const unauthenticated = piStatusFromCatalog(piCatalog([
    { source: "pi-child", health: "healthy" },
    { source: "pi-model", health: "unavailable", detail: "Pi has no selected authenticated model" },
  ]), 9_000);
  assert.deepEqual([unauthenticated.installed, unauthenticated.authenticated, unauthenticated.ready], [true, false, false]);
  assert.equal(unauthenticated.model, undefined, "an unusable model is never reported as selected and ready");
  assert.match(unauthenticated.detail ?? "", /no selected authenticated model/);

  const missing = piStatusFromCatalog(piCatalog([
    { source: "pi-child", health: "unavailable", detail: "spawn pi ENOENT" },
  ]), 9_000);
  assert.deepEqual([missing.installed, missing.authenticated, missing.ready], [false, false, false]);
});

test("the service caches statuses, refreshes on demand, and turns probe failures into unready statuses", async () => {
  const calls = { claude: 0, codex: 0, pi: 0 };
  let now = 1_000;
  const service = new ProviderStatusService({
    now: () => now,
    ttlMs: 30_000,
    piReadiness: {
      async catalog() {
        calls.pi++;
        return piCatalog([{ source: "pi-model", health: "healthy", detail: "anthropic/claude-opus-5" }]);
      },
    },
    readClaudeAuth: async () => {
      calls.claude++;
      return JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "engineer@example.com", subscriptionType: "max" });
    },
    readCodexAccount: async () => {
      calls.codex++;
      return { account: { type: "chatgpt", email: "pilot@openai.com", planType: "pro" } };
    },
  });

  const first = await service.statuses({ cwd: "/proj" });
  assert.deepEqual(first.map((status) => status.harness), ["pi", "claude", "codex"]);
  assert.ok(first.every((status) => status.ready));

  await service.statuses({ cwd: "/proj" });
  assert.deepEqual(calls, { claude: 1, codex: 1, pi: 1 }, "a repeat inside the TTL is served from cache");

  await service.statuses({ cwd: "/proj", refresh: true });
  assert.deepEqual(calls, { claude: 2, codex: 2, pi: 2 }, "refresh bypasses the cache");

  now += 60_000;
  await service.statuses({ cwd: "/proj", harnesses: ["claude"] });
  assert.deepEqual(calls, { claude: 3, codex: 2, pi: 2 }, "an expired entry is reprobed for the requested harness only");
});

test("a slow probe that settles after a refresh cannot restore the older status", async () => {
  const pending: Array<(payload: string) => void> = [];
  const service = new ProviderStatusService({
    ttlMs: 30_000,
    readClaudeAuth: () => new Promise<string>((resolve) => pending.push(resolve)),
  });

  const stale = service.status("claude", { cwd: "/proj" });
  const fresh = service.status("claude", { cwd: "/proj", refresh: true });
  assert.equal(pending.length, 2, "a refresh bypasses the in-flight probe instead of joining it");

  // The refresh answers first; the older probe settles afterwards with the
  // login state that was already superseded.
  pending[1](JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  assert.equal((await fresh).ready, true);
  pending[0](JSON.stringify({ loggedIn: false }));
  assert.equal((await stale).ready, false, "each caller still receives its own probe result");

  const cached = await service.status("claude", { cwd: "/proj" });
  assert.equal(cached.ready, true, "the cache keeps the newest observation");
  assert.equal(cached.account?.plan, "max");
});

test("a missing CLI and a failing probe stay distinguishable and never reject", async () => {
  const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const service = new ProviderStatusService({
    now: () => 2_000,
    piReadiness: { async catalog() { throw new Error("pi probe crashed"); } },
    readClaudeAuth: async () => { throw missing; },
    readCodexAccount: async () => { throw new Error("JSON-RPC request timed out: account/read"); },
  });
  const [pi, claude, codex] = await service.statuses({ cwd: "/proj" });
  assert.deepEqual([claude.installed, claude.authenticated, claude.ready], [false, false, false]);
  assert.match(claude.detail ?? "", /not found on PATH/);
  assert.equal(codex.installed, true, "a timeout means the CLI ran, not that it is absent");
  assert.equal(codex.ready, false);
  assert.match(codex.detail ?? "", /timed out/);
  assert.equal(pi.ready, false);
  assert.match(pi.detail ?? "", /pi probe crashed/);
});

test("an aborted request fails the probe instead of hanging", async () => {
  const service = new ProviderStatusService({
    readClaudeAuth: async () => "{}",
    readCodexAccount: async () => ({}),
  });
  const [status] = await service.statuses({ cwd: "/proj", harnesses: ["claude"], signal: AbortSignal.abort() });
  assert.equal(status.ready, false);
  assert.match(status.detail ?? "", /probe failed/);
});

test("addresses embedded in free-text provider fields are masked too", () => {
  // A personal Claude account names its org after the full login address.
  const status = claudeStatus(parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "engineer@example.com",
    orgName: "engineer@example.com's Organization",
    subscriptionType: "pro",
  })), 1_000);
  assert.equal(status.account?.organization, "e***@example.com's Organization");
  const rendered = `${JSON.stringify(status)}${formatProviderStatusReport([status], 1_000)}`;
  assert.ok(!rendered.includes("engineer@example.com"), "no retained or rendered field carries the full address");

  const failed = piStatusFromCatalog(piCatalog(
    [{ source: "pi-child", health: "unavailable", detail: "pi is not logged in as engineer@example.com" }],
  ), 1_000);
  assert.match(failed.detail ?? "", /e\*\*\*@example\.com/);
  assert.equal(maskEmbeddedEmails("plain text without an address"), "plain text without an address");
});

test("email masking keeps the domain and hides the address", () => {
  assert.equal(maskEmail("engineer@example.com"), "e***@example.com");
  assert.equal(maskEmail("a@b.io"), "***@b.io", "a one-character local part reveals nothing");
  assert.equal(maskEmail(undefined), undefined);
  assert.equal(maskEmail("not-an-address"), undefined);
  assert.equal(maskEmail("@example.com"), undefined);
  assert.equal(maskEmail("has space@example.com"), undefined);
});

test("the report states the readiness stages without claiming a model request", () => {
  const statuses: ProviderStatus[] = [
    piStatusFromCatalog(piCatalog([{ source: "pi-model", health: "healthy", detail: "anthropic/claude-opus-5" }]), 1_000),
    claudeStatus(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "engineer@example.com", subscriptionType: "max" })), 1_000),
    codexStatus(parseCodexAccount({ account: { type: "apikey" } }), 1_000),
  ];
  const report = formatProviderStatusReport(statuses, 4_000);
  assert.match(report, /no model request was made/);
  assert.match(report, /pi\s+ready · model anthropic\/claude-opus-5 · account email unavailable/);
  assert.match(report, /claude\s+ready · account e\*\*\*@example\.com · plan max · auth claude\.ai/);
  assert.match(report, /codex\s+authenticated, not ready/);
  assert.match(report, /Checked 3s ago/);
  assert.ok(!report.includes("engineer@example.com"), "the report never prints a full address");
});
