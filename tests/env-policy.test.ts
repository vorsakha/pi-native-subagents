import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSubscriptionEnv } from "../src/env.ts";
import { compilePolicy, providerFamily } from "../src/policy.ts";
import type { ProfileDefinition } from "../src/types.ts";

const profile: ProfileDefinition = {
  name: "audit", description: "", access: "readOnly", backend: "claude", modelTier: "quality",
  systemPrompt: "audit carefully", filePath: "audit.md", origin: "global",
};
const request = { task: "x", cwd: "/tmp", trusted: true } as const;

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
  for (const key of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_ACCESS_KEY_ID", "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "ANTHROPIC_VERTEX_PROJECT_ID", "AZURE_CLIENT_SECRET",
    "ANTHROPIC_FOUNDRY_API_KEY", "anthropic_api_key", "claude_code_use_bedrock", "openai_api_key",
  ]) assert.equal(claude[key], undefined, `${key} must not reach Claude`);
  for (const key of [
    "OPENAI_API_KEY", "openai_api_key", "ANTHROPIC_API_KEY", "CUSTOM_VENDOR_API_KEY", "another_auth_token",
    "THIRD_PARTY_ACCESS_TOKEN", "OPENAI_PROJECT_ID", "model_provider", "AZURE_OPENAI_ENDPOINT",
  ]) assert.equal(codex[key], undefined, `${key} must not reach Codex`);
  assert.equal(codex.PATH, "/bin");
  assert.equal(codex.HOME, "/home/test");
  assert.equal(codex.KEEP_ME, "yes");
  assert.equal(claude.KEEP_ME, "yes");
  assert.equal(source.ANTHROPIC_API_KEY, "secret-a");
});

test("generic policy defaults to trusted full Codex with the balanced fallback mapping", () => {
  assert.throws(() => compilePolicy({ ...request, trusted: false }), /untrusted/);
  const compiled = compilePolicy(request);
  assert.equal(compiled.policy.backend, "codex");
  assert.equal(compiled.policy.model, "gpt-5.6-terra");
  assert.equal(compiled.policy.access, "full");
  assert.deepEqual(compiled.policy.codexSandbox, { type: "dangerFullAccess" });
  assert.ok(!("nestedAgents" in compiled.policy));

  const claude = compilePolicy({ ...request, defaultBackend: "claude", modelTier: "economy", effort: "high" });
  assert.equal(claude.policy.backend, "claude");
  assert.equal(claude.policy.model, "haiku");
  assert.equal(claude.policy.effort, "high");
  const pi = compilePolicy({ ...request, backend: "pi", modelTier: "quality" });
  assert.equal(pi.policy.model, "openai-codex/gpt-5.6-sol");
});

test("profiles compose defaults while read-only and locked backend constraints fail closed", () => {
  const compiled = compilePolicy({ ...request, access: "full", modelTier: "economy" }, profile);
  assert.equal(compiled.policy.backend, "claude");
  assert.equal(compiled.policy.model, "haiku", "per-call tier overrides the profile default within its provider");
  assert.equal(compiled.policy.access, "readOnly", "profile read-only access is a ceiling");
  assert.deepEqual(compiled.policy.codexSandbox, { type: "readOnly", networkAccess: false });
  assert.deepEqual(compiled.policy.piTools, ["read", "grep", "find", "ls"]);

  const locked = { ...profile, lockedBackend: "claude" as const };
  assert.throws(() => compilePolicy({ ...request, backend: "codex" }, locked), /locks its backend to claude/);
});

test("independent forces a different native provider and rejects contradictions", () => {
  assert.equal(compilePolicy({ ...request, independent: true, parentProvider: "codex" }).policy.backend, "claude");
  assert.equal(compilePolicy({ ...request, independent: true, parentProvider: "claude" }).policy.backend, "codex");
  assert.throws(() => compilePolicy({ ...request, independent: true, parentProvider: "claude", backend: "claude" }), /different from the parent claude/);
  assert.throws(() => compilePolicy({ ...request, independent: true, parentProvider: "codex", backend: "pi" }), /native Claude or Codex/);
  assert.throws(() => compilePolicy({ ...request, parentProvider: "claude" }, { ...profile, independent: true, lockedBackend: "claude" }), /different from the parent claude/);
  assert.equal(providerFamily("openai-codex"), "codex");
  assert.equal(providerFamily("anthropic"), "claude");
  assert.equal(providerFamily("google"), "other");
});
