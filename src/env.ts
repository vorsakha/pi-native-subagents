const API_KEY_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
]);

// These variables select a non-claude.ai provider or supply credentials to it.
// Claude Code gives them precedence over subscription OAuth, so a subscription
// child must never inherit them even when `claude auth status` itself is valid.
const CLAUDE_PROVIDER_ENV = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
]);

const CREDENTIAL_SUFFIX = /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/;
const CODEX_PROVIDER_ENV = new Set([
  "MODEL_PROVIDER",
  "OPENAI_PROVIDER",
  "CODEX_MODEL_PROVIDER",
  "CODEX_HOME",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
]);

function isClaudeProviderOverride(key: string): boolean {
  return key.startsWith("ANTHROPIC_")
    || key.startsWith("CLAUDE_CODE_USE_")
    || key.startsWith("ANTHROPIC_VERTEX_")
    || key.startsWith("ANTHROPIC_FOUNDRY_")
    || CLAUDE_PROVIDER_ENV.has(key);
}

function isCodexProviderOverride(key: string): boolean {
  return key.startsWith("OPENAI_")
    || key.startsWith("AZURE_OPENAI_")
    || key.startsWith("AZURE_AI_")
    || CODEX_PROVIDER_ENV.has(key);
}

export function sanitizeSubscriptionEnv(
  source: NodeJS.ProcessEnv,
  backend: "claude" | "codex" | "pi",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  if (backend === "pi") return env;
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      API_KEY_ENV.has(normalized)
      || CREDENTIAL_SUFFIX.test(normalized)
      || backend === "claude" && isClaudeProviderOverride(normalized)
      || backend === "codex" && isCodexProviderOverride(normalized)
    ) delete env[key];
  }
  return env;
}
