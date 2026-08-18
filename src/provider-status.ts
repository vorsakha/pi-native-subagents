import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_CLIENT_INFO } from "./backends/codex.ts";
import type { CapabilityCatalog } from "./capabilities.ts";
import { sanitizeSubscriptionEnv } from "./env.ts";
import { asObject, JsonRpcPeer } from "./jsonrpc.ts";
import { spawnManaged } from "./process-tree.ts";
import type { AccessMode, HarnessName } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
export const PI_ACCOUNT_UNAVAILABLE = "Pi does not expose an account email";

/**
 * Account metadata that is safe to display. Only whitelisted identity fields are
 * ever retained: tokens, keys, and raw provider payloads never reach this shape,
 * and `email` is masked by the parser so the full address is never stored.
 */
export interface ProviderAccount {
  /** Masked address, e.g. `a***@example.com`. */
  email?: string;
  /** Subscription or plan label reported by the provider. */
  plan?: string;
  /** Native auth method, e.g. `claude.ai` or `chatgpt`. */
  authMethod?: string;
  organization?: string;
  /** Reason the provider genuinely exposes no account identity. */
  unavailable?: string;
}

/**
 * Readiness of one native provider. The three states are deliberately distinct:
 * `installed` means the CLI ran, `authenticated` means it reports a logged-in
 * account, and `ready` means this package would accept it for a subagent. None
 * of them implies a model request was made — every probe is turn-free.
 */
export interface ProviderStatus {
  harness: HarnessName;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  account?: ProviderAccount;
  /** Model the provider already reports as selected; never requested from a model. */
  model?: string;
  /** Why the provider is not ready, or another non-fatal observation. */
  detail?: string;
  checkedAt: number;
  /** Where the status came from, e.g. `claude auth status --json`. */
  probe: string;
}

export interface ProviderStatusRequest {
  cwd: string;
  /** Bypass the bounded status cache. */
  refresh?: boolean;
  signal?: AbortSignal;
  harnesses?: HarnessName[];
}

/** Narrow dependency used by the command surface so tests never spawn a provider. */
export interface ProviderStatusReader {
  statuses(request: ProviderStatusRequest): Promise<ProviderStatus[]>;
  /** Drops cached statuses, e.g. when a new session may have changed logins. */
  invalidate?(): void;
}

interface ProbeContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Returns raw `claude auth status --json` stdout. */
export type ClaudeAuthProbe = (context: ProbeContext) => Promise<string>;
/** Returns the raw Codex `account/read` result. */
export type CodexAccountProbe = (context: ProbeContext) => Promise<unknown>;

/** Zero-turn Pi readiness source; `CapabilityService` satisfies it structurally. */
export interface PiReadinessSource {
  catalog(harness: HarnessName, request: { cwd: string; access: AccessMode; refresh?: boolean; signal?: AbortSignal }): Promise<CapabilityCatalog>;
}

export interface ProviderStatusOptions {
  /** Reused zero-turn capability discovery; Pi readiness comes from its source health. */
  piReadiness?: PiReadinessSource;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  claudeCommand?: string;
  codexCommand?: string;
  readClaudeAuth?: ClaudeAuthProbe;
  readCodexAccount?: CodexAccountProbe;
}

const PROVIDER_ORDER: HarnessName[] = ["pi", "claude", "codex"];

interface CacheEntry {
  /** Monotonic probe order, so a late older probe cannot replace a newer status. */
  generation: number;
  status: ProviderStatus;
}

/**
 * Bounded, cached provider readiness. Every probe is model-free: Claude reads its
 * auth status command, Codex reads its app-server account record without
 * refreshing a token, and Pi reuses the existing zero-turn readiness discovery.
 */
export class ProviderStatusService implements ProviderStatusReader {
  readonly #pi?: PiReadinessSource;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #claudeCommand: string;
  readonly #codexCommand: string;
  readonly #readClaudeAuth: ClaudeAuthProbe;
  readonly #readCodexAccount: CodexAccountProbe;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<ProviderStatus>>();
  #generation = 0;

  constructor(options: ProviderStatusOptions = {}) {
    this.#pi = options.piReadiness;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#claudeCommand = options.claudeCommand ?? "claude";
    this.#codexCommand = options.codexCommand ?? "codex";
    this.#readClaudeAuth = options.readClaudeAuth ?? readClaudeAuthStatus;
    this.#readCodexAccount = options.readCodexAccount ?? readCodexAccount;
  }

  invalidate(): void {
    this.#cache.clear();
  }

  async statuses(request: ProviderStatusRequest): Promise<ProviderStatus[]> {
    const wanted = request.harnesses?.length
      ? PROVIDER_ORDER.filter((harness) => request.harnesses!.includes(harness))
      : PROVIDER_ORDER;
    return Promise.all(wanted.map((harness) => this.status(harness, request)));
  }

  async status(harness: HarnessName, request: ProviderStatusRequest): Promise<ProviderStatus> {
    const key = `${harness}|${request.cwd}`;
    const cached = this.#cache.get(key);
    if (!request.refresh && cached && this.#now() - cached.status.checkedAt < this.#ttlMs) return cached.status;
    const pending = this.#inflight.get(key);
    if (pending && !request.refresh) return pending;
    // A refresh deliberately bypasses an in-flight probe, so a slower older
    // probe can still settle last. Generations keep the newest observation.
    const generation = ++this.#generation;
    const probe = this.#probe(harness, request)
      .then((status) => {
        const existing = this.#cache.get(key);
        if (!existing || existing.generation <= generation) this.#cache.set(key, { generation, status });
        return status;
      })
      .finally(() => {
        if (this.#inflight.get(key) === probe) this.#inflight.delete(key);
      });
    this.#inflight.set(key, probe);
    return probe;
  }

  async #probe(harness: HarnessName, request: ProviderStatusRequest): Promise<ProviderStatus> {
    if (harness === "pi") return this.#piStatus(request);
    const checkedAt = this.#now();
    const probeName = harness === "claude" ? "claude auth status --json" : "codex app-server account/read";
    try {
      if (harness === "claude") {
        const stdout = await this.#bounded(request, (signal) => this.#readClaudeAuth({
          command: this.#claudeCommand,
          cwd: request.cwd,
          env: sanitizeSubscriptionEnv(this.#env, "claude"),
          signal,
          timeoutMs: this.#timeoutMs,
        }));
        return claudeStatus(parseClaudeAuthStatus(stdout), checkedAt);
      }
      const account = await this.#bounded(request, (signal) => this.#readCodexAccount({
        command: this.#codexCommand,
        cwd: request.cwd,
        env: sanitizeSubscriptionEnv(this.#env, "codex"),
        signal,
        timeoutMs: this.#timeoutMs,
      }));
      return codexStatus(parseCodexAccount(account), checkedAt);
    } catch (error) {
      const detail = maskEmbeddedEmails(errorMessage(error));
      return {
        harness,
        installed: !isMissingCommand(error),
        authenticated: false,
        ready: false,
        detail: isMissingCommand(error)
          ? `${harness} CLI was not found on PATH`
          : `${harness} status probe failed: ${detail}`,
        checkedAt,
        probe: probeName,
      };
    }
  }

  async #piStatus(request: ProviderStatusRequest): Promise<ProviderStatus> {
    const checkedAt = this.#now();
    if (!this.#pi) {
      return {
        harness: "pi",
        installed: false,
        authenticated: false,
        ready: false,
        account: { unavailable: PI_ACCOUNT_UNAVAILABLE },
        detail: "Pi readiness discovery is not configured",
        checkedAt,
        probe: "pi readiness",
      };
    }
    try {
      const catalog = await this.#pi.catalog("pi", {
        cwd: request.cwd,
        access: "full",
        refresh: request.refresh,
        signal: request.signal,
      });
      return piStatusFromCatalog(catalog, checkedAt);
    } catch (error) {
      return {
        harness: "pi",
        installed: !isMissingCommand(error),
        authenticated: false,
        ready: false,
        account: { unavailable: PI_ACCOUNT_UNAVAILABLE },
        detail: `pi status probe failed: ${maskEmbeddedEmails(errorMessage(error))}`,
        checkedAt,
        probe: "pi readiness",
      };
    }
  }

  /**
   * Hard deadline around one probe. The inner protocol timeouts are the normal
   * path; this backstop also covers a spawn that never answers, and always
   * aborts so the probe tears its child process down.
   */
  async #bounded<T>(request: ProviderStatusRequest, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason ?? new Error("Provider status probe aborted"));
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("Provider status probe aborted");
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`provider status probe timed out after ${this.#timeoutMs * 2}ms`)),
      this.#timeoutMs * 2,
    );
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

export interface ClaudeAuthFacts {
  loggedIn: boolean;
  authMethod?: string;
  account: ProviderAccount;
}

export interface CodexAccountFacts {
  /** Native account type, e.g. `chatgpt` or `apikey`. */
  type?: string;
  account: ProviderAccount;
}

/**
 * Reads only the identity fields of `claude auth status --json`. Unknown fields,
 * including anything token-shaped, are discarded rather than displayed.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthFacts {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("claude auth status returned invalid JSON"); }
  const record = asObject(parsed);
  const nested = asObject(record.account ?? record.user);
  const organization = asObject(record.organization ?? nested.organization);
  const authMethod = text(record.authMethod ?? nested.authMethod);
  return {
    loggedIn: record.loggedIn === true,
    authMethod,
    account: {
      email: maskEmail(text(record.email ?? nested.email)),
      plan: text(record.subscriptionType ?? record.plan ?? nested.subscriptionType ?? nested.plan),
      authMethod,
      organization: text(organization.name ?? record.orgName ?? nested.orgName ?? record.organizationName),
    },
  };
}

/** Reads only the identity fields of the Codex `account/read` result. */
export function parseCodexAccount(result: unknown): CodexAccountFacts {
  const record = asObject(result);
  const account = asObject(record.account ?? record);
  return {
    type: text(account.type),
    account: {
      email: maskEmail(text(account.email)),
      plan: text(account.planType ?? account.plan ?? account.subscriptionPlan),
      authMethod: text(account.type),
    },
  };
}

export function claudeStatus(facts: ClaudeAuthFacts, checkedAt: number): ProviderStatus {
  // Subscription OAuth is the only route this package launches Claude with, so a
  // valid API-key login is authenticated but still not ready for a subagent.
  const subscription = facts.authMethod === "claude.ai";
  return {
    harness: "claude",
    installed: true,
    authenticated: facts.loggedIn,
    ready: facts.loggedIn && subscription,
    account: facts.account,
    detail: !facts.loggedIn
      ? "Claude Code is not logged in"
      : subscription
        ? undefined
        : `Claude reports auth method ${facts.authMethod ?? "unknown"}; subagents require a claude.ai subscription login`,
    checkedAt,
    probe: "claude auth status --json",
  };
}

export function codexStatus(facts: CodexAccountFacts, checkedAt: number): ProviderStatus {
  const chatgpt = facts.type === "chatgpt";
  return {
    harness: "codex",
    installed: true,
    authenticated: !!facts.type && facts.type !== "none",
    ready: chatgpt,
    account: facts.account,
    detail: !facts.type || facts.type === "none"
      ? "Codex is not logged in"
      : chatgpt
        ? undefined
        : `Codex reports account type ${facts.type}; subagents require a ChatGPT login`,
    checkedAt,
    probe: "codex app-server account/read",
  };
}

/**
 * Pi readiness from the existing zero-turn capability catalog: `pi-model`
 * reports whether the selected model is usable with the current credentials.
 */
export function piStatusFromCatalog(catalog: CapabilityCatalog, checkedAt: number): ProviderStatus {
  const model = catalog.sources.find((source) => source.source === "pi-model");
  const failure = catalog.sources.find((source) => source.health === "unavailable" && source.source !== "pi-model");
  const ready = model?.health === "healthy";
  return {
    harness: "pi",
    installed: !failure || !isMissingCommand(failure.detail),
    authenticated: ready,
    ready,
    account: { unavailable: PI_ACCOUNT_UNAVAILABLE },
    model: ready ? text(model?.detail) : undefined,
    detail: ready ? undefined : text(model?.detail ?? failure?.detail ?? catalog.warnings[0]) ?? "Pi readiness is unknown",
    checkedAt,
    probe: "pi zero-turn readiness",
  };
}

/**
 * Masks an address so output identifies the account without reproducing it:
 * one leading character, a fixed-width mask that hides the real length, and the
 * domain. Anything that is not an address is dropped.
 */
export function maskEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || /\s/.test(value)) return undefined;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.length > 1 ? local[0] : ""}***@${domain}`;
}

const EMBEDDED_EMAIL = /[^\s<>@,;'"]+@[^\s<>@,;'"]+\.[^\s<>@,;'"]+/g;

/**
 * Masks addresses that appear inside free text. Providers embed them in
 * human-readable fields — a personal Claude org is literally
 * `<address>'s Organization` — so every displayed string is scrubbed, not just
 * the dedicated email field.
 */
export function maskEmbeddedEmails(value: string): string {
  return value.replace(EMBEDDED_EMAIL, (match) => maskEmail(match) ?? match);
}

/* ── default probes ──────────────────────────────────────────────────────── */

async function readClaudeAuthStatus(context: ProbeContext): Promise<string> {
  const { stdout } = await execFileAsync(context.command, ["auth", "status", "--json"], {
    cwd: context.cwd,
    env: context.env,
    encoding: "utf8",
    timeout: context.timeoutMs,
    signal: context.signal,
  });
  return stdout;
}

/**
 * Reads the Codex account record over the app-server protocol with no thread and
 * no turn. `refreshToken: false` keeps the probe from mutating stored
 * credentials, and the peer is always closed so the process tree is reaped.
 */
async function readCodexAccount(context: ProbeContext): Promise<unknown> {
  const managed = spawnManaged(context.command, ["app-server", "--stdio"], { cwd: context.cwd, env: context.env });
  const peer = new JsonRpcPeer({
    process: managed,
    // The probe is unattended: never answer an interactive server request.
    onRequest: (_id, method) => { throw new Error(`Interactive request denied during provider status: ${method}`); },
  });
  const abort = () => void peer.close();
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    await peer.request("initialize", { clientInfo: CODEX_CLIENT_INFO }, context.timeoutMs);
    peer.notify("initialized");
    return await peer.request("account/read", { refreshToken: false }, context.timeoutMs);
  } finally {
    context.signal.removeEventListener("abort", abort);
    await peer.close().catch(() => undefined);
  }
}

/* ── formatting ──────────────────────────────────────────────────────────── */

export function providerStatusLabel(status: ProviderStatus): string {
  if (status.ready) return "ready";
  if (status.authenticated) return "authenticated, not ready";
  if (status.installed) return "installed, not authenticated";
  return "not installed";
}

export function formatProviderStatus(status: ProviderStatus): string {
  const account = status.account ?? {};
  const fields = [
    account.email ? `account ${account.email}` : undefined,
    account.plan ? `plan ${account.plan}` : undefined,
    account.authMethod ? `auth ${account.authMethod}` : undefined,
    account.organization ? `org ${account.organization}` : undefined,
    status.model ? `model ${status.model}` : undefined,
    !account.email && account.unavailable ? `account email unavailable (${account.unavailable})` : undefined,
    status.detail,
  ].filter(Boolean);
  return `${status.harness.padEnd(6)} ${providerStatusLabel(status)}${fields.length ? ` · ${fields.join(" · ")}` : ""}`;
}

/** Full `/subagents providers` report. Emails are masked; credentials are never read. */
export function formatProviderStatusReport(statuses: ProviderStatus[], now: number): string {
  const oldest = statuses.reduce((value, status) => Math.min(value, status.checkedAt), now);
  return [
    "Native provider readiness (account and auth state only; no model request was made):",
    ...statuses.map(formatProviderStatus),
    `Checked ${formatAge(Math.max(0, now - oldest))}. Emails are masked and credentials are never read or displayed.`,
  ].join("\n");
}

function formatAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 1) return "just now";
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Bounded text with any embedded address masked, so no retained field can leak one. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = maskEmbeddedEmails(value.replace(/\s+/g, " ").trim());
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the failure means the CLI itself is absent rather than unauthenticated. */
function isMissingCommand(error: unknown): boolean {
  if (typeof error === "string") return /ENOENT|not found|not recognized/i.test(error);
  if (!error || typeof error !== "object") return false;
  const record = error as NodeJS.ErrnoException & { cause?: unknown };
  if (record.code === "ENOENT") return true;
  if (record.cause && record.cause !== error && isMissingCommand(record.cause)) return true;
  return typeof record.message === "string" && /ENOENT|not found|not recognized/i.test(record.message);
}
