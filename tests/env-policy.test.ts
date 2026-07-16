import test from "node:test";
import assert from "node:assert/strict";
import { childDelegationEnv, sanitizeSubscriptionEnv } from "../src/env.ts";
import { compilePolicy, providerFamily } from "../src/policy.ts";
import type { RoleDefinition } from "../src/types.ts";

const role: RoleDefinition = {
  name: "worker", description: "", access: "full", defaultBackend: "pi", nestedAgents: ["scout", "researcher"],
  piTools: ["read", "write", "bash", "subagent"], claudeTools: ["Read", "Write", "Bash"],
  routes: {
    pi: { model: "pi-model", thinking: "medium", effort: "medium" },
    claude: { model: "sonnet", thinking: "medium", effort: "medium" },
    codex: { model: "codex-model", thinking: "medium", effort: "medium" },
  },
  systemPrompt: "worker", filePath: "worker.md",
};

test("subscription environments remove billing-switch credentials without mutating input", () => {
  const source = {
    PATH: "/bin", HOME: "/home/test", ANTHROPIC_API_KEY: "secret-a", ANTHROPIC_AUTH_TOKEN: "secret-b",
    ANTHROPIC_BASE_URL: "https://gateway.invalid", ANTHROPIC_CUSTOM_HEADERS: "secret-headers",
    CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1", AWS_ACCESS_KEY_ID: "secret-aws", AWS_PROFILE: "billing-profile",
    GOOGLE_APPLICATION_CREDENTIALS: "/secret/google.json", GOOGLE_CLOUD_PROJECT: "billing-project",
    ANTHROPIC_VERTEX_PROJECT_ID: "billing-project", AZURE_CLIENT_SECRET: "secret-azure",
    ANTHROPIC_FOUNDRY_API_KEY: "secret-foundry", OPENAI_API_KEY: "secret-c",
    CODEX_ACCESS_TOKEN: "secret-d", anthropic_api_key: "secret-lower-anthropic",
    claude_code_use_bedrock: "1", openai_api_key: "secret-lower-openai",
    CUSTOM_VENDOR_API_KEY: "secret-custom", another_auth_token: "secret-custom-token",
    THIRD_PARTY_ACCESS_TOKEN: "secret-custom-access", OPENAI_PROJECT_ID: "billing-project",
    model_provider: "custom-provider", AZURE_OPENAI_ENDPOINT: "https://azure.invalid", KEEP_ME: "yes",
  };
  const claude = sanitizeSubscriptionEnv(source, "claude");
  const codex = sanitizeSubscriptionEnv(source, "codex");
  assert.equal(claude.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.OPENAI_API_KEY, undefined);
  for (const key of [
    "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_ACCESS_KEY_ID", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
    "ANTHROPIC_VERTEX_PROJECT_ID", "AZURE_CLIENT_SECRET", "ANTHROPIC_FOUNDRY_API_KEY",
    "anthropic_api_key", "claude_code_use_bedrock", "openai_api_key",
  ]) assert.equal(claude[key], undefined, `${key} must not reach Claude`);
  assert.equal(codex.OPENAI_API_KEY, undefined);
  assert.equal(codex.openai_api_key, undefined);
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  for (const key of [
    "CUSTOM_VENDOR_API_KEY", "another_auth_token", "THIRD_PARTY_ACCESS_TOKEN",
    "OPENAI_PROJECT_ID", "model_provider", "AZURE_OPENAI_ENDPOINT",
  ]) assert.equal(codex[key], undefined, `${key} must not reach Codex`);
  assert.equal(codex.PATH, "/bin");
  assert.equal(codex.HOME, "/home/test");
  assert.equal(codex.KEEP_ME, "yes");
  assert.equal(claude.KEEP_ME, "yes");
  assert.equal(source.ANTHROPIC_API_KEY, "secret-a");
});

test("delegation environment carries only current depth and explicit allowlist", () => {
  const inherited = { PI_NATIVE_SUBAGENTS_ALLOWED: "old", PI_SUBAGENTS_ALLOWED: "legacy", PI_SUBAGENT_ALLOWED: "older", pi_subagents_allowed: "lower", pi_native_subagents_depth: "99" };
  const env = childDelegationEnv(inherited, 2, ["scout"]);
  assert.equal(env.PI_NATIVE_SUBAGENTS_DEPTH, "2");
  assert.equal(env.PI_NATIVE_SUBAGENTS_ALLOWED, "scout");
  assert.equal(env.PI_SUBAGENTS_ALLOWED, undefined);
  assert.equal(env.PI_SUBAGENT_ALLOWED, undefined);
  assert.equal(env.pi_subagents_allowed, undefined);
  assert.equal(env.pi_native_subagents_depth, undefined);
  const denied = childDelegationEnv(inherited, 2, []);
  assert.equal(denied.PI_NATIVE_SUBAGENTS_ALLOWED, undefined);
  assert.equal(denied.PI_SUBAGENTS_ALLOWED, undefined);
  assert.equal(denied.PI_SUBAGENT_ALLOWED, undefined);
  assert.equal(denied.pi_subagents_allowed, undefined);
});

test("policy denies untrusted work and depth overflow", () => {
  assert.throws(() => compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: false }), /untrusted/);
  assert.throws(() => compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: true, depth: 2 }), /depth limit/);
});

test("explicit backend outranks tier while backend-less tiers select Codex", () => {
  const compiled = compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: true, tier: "quality", depth: 0 });
  assert.equal(compiled.policy.backend, "codex");
  assert.equal(compiled.policy.model, "gpt-5.6-sol");
  assert.equal(compiled.policy.thinking, "medium", "tier changes the model without rewriting role thinking policy");
  assert.equal(compiled.policy.access, "full");
  assert.deepEqual(compiled.policy.codexSandbox, { type: "dangerFullAccess" });
  assert.deepEqual(compiled.policy.nestedAgents, ["scout", "researcher"]);

  const claude = compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: true, backend: "claude", tier: "economy" });
  assert.equal(claude.policy.backend, "claude");
  assert.equal(claude.policy.model, "haiku", "Claude resolves the tier within its own model family");
  assert.equal(claude.policy.thinking, "medium");
  assert.equal(claude.policy.effort, undefined, "tiers do not force provider effort");
  const claudeExplicitEffort = compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: true, backend: "claude", tier: "economy", effort: "high" });
  assert.equal(claudeExplicitEffort.policy.model, "haiku");
  assert.equal(claudeExplicitEffort.policy.effort, "high");

  const pi = compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: true, backend: "pi", tier: "economy" });
  assert.equal(pi.policy.backend, "pi");
  assert.equal(pi.policy.model, "openai-codex/gpt-5.6-luna");
  assert.equal(pi.policy.effort, undefined);

  const lockedClaude = { ...role, name: "fixed-claude", lockedBackend: "claude" as const, routes: { ...role.routes, claude: { model: "opus", thinking: "high" as const, effort: "high" as const } } };
  const fixedDefault = compilePolicy(lockedClaude, { role: "fixed-claude", task: "x", cwd: "/tmp", trusted: true, backend: "claude" });
  assert.equal(fixedDefault.policy.backend, "claude");
  assert.equal(fixedDefault.policy.model, "opus");
  assert.equal(fixedDefault.policy.effort, undefined, "legacy role effort metadata is not enforced");
  const fixedEconomy = compilePolicy(lockedClaude, { role: "fixed-claude", task: "x", cwd: "/tmp", trusted: true, backend: "claude", tier: "economy" });
  assert.equal(fixedEconomy.policy.model, "haiku", "an orchestrator-selected tier may override the role's default model");
  assert.equal(fixedEconomy.policy.thinking, "high", "tier preserves the role's thinking policy");
  assert.throws(() => compilePolicy(lockedClaude, { role: "fixed-claude", task: "x", cwd: "/tmp", trusted: true, backend: "codex" }), /locks its backend to claude/);

  const adversary = { ...role, name: "adversary", defaultBackend: "claude" as const, differentProviderFromParent: true, routes: { ...role.routes, claude: { model: "opus", thinking: "high" as const, effort: "high" as const }, codex: { model: "gpt-5.6-sol", thinking: "high" as const, effort: "high" as const } } };
  assert.equal(compilePolicy(adversary, { role: "adversary", task: "x", cwd: "/tmp", trusted: true, parentProvider: "codex" }).policy.backend, "claude");
  assert.equal(compilePolicy(adversary, { role: "adversary", task: "x", cwd: "/tmp", trusted: true, parentProvider: "claude" }).policy.backend, "codex");
  assert.equal(compilePolicy(adversary, { role: "adversary", task: "x", cwd: "/tmp", trusted: true, parentProvider: "other" }).policy.model, "opus");
  assert.throws(() => compilePolicy(adversary, { role: "adversary", task: "x", cwd: "/tmp", trusted: true, parentProvider: "claude", backend: "claude" }), /different from the parent claude/);
  assert.throws(() => compilePolicy(adversary, { role: "adversary", task: "x", cwd: "/tmp", trusted: true, parentProvider: "codex", backend: "pi" }), /native Claude or Codex/);
  assert.equal(providerFamily("openai-codex"), "codex");
  assert.equal(providerFamily("anthropic"), "claude");
  assert.equal(providerFamily("google"), "other");

  const nested = compilePolicy(role, { role: "worker", task: "x", cwd: "/tmp", trusted: true, depth: 1 });
  assert.deepEqual(nested.policy.nestedAgents, []);
});

test("read-only policy strips mutating tools and compiles sandbox deny-by-construction", () => {
  const reviewer = { ...role, name: "reviewer", access: "readOnly" as const };
  const compiled = compilePolicy(reviewer, { role: "reviewer", task: "x", cwd: "/tmp", trusted: true, backend: "claude" });
  assert.deepEqual(compiled.policy.piTools, ["read"]);
  assert.deepEqual(compiled.policy.claudeTools, ["Read"]);
  assert.deepEqual(compiled.policy.codexSandbox, { type: "readOnly", networkAccess: false });
});
