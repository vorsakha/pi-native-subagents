import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  buildCatalog,
  describeResolution,
  requirementsSatisfied,
  resolveRequirements,
  searchCapabilities,
  type CapabilityCatalog,
  type CapabilityQuery,
  type CapabilityMatch,
  type RequirementResolution,
} from "./capabilities.ts";
import type { AccessMode, Backend, CustomizationMode, HarnessName, JobCapabilityRoute } from "./types.ts";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 20_000;

export interface CapabilityRequest {
  cwd: string;
  access: AccessMode;
  customization?: CustomizationMode;
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface CapabilityRouteRequest extends CapabilityRequest {
  /** Explicit harness, or `auto` to choose among capable healthy routes. */
  harness?: HarnessName | "auto";
  requires?: string[];
  /** Preference order used by `auto`; the configured default harness comes first. */
  preference?: HarnessName[];
  /** Routes excluded by other policy (independence, profile locks). */
  candidates?: HarnessName[];
}

export interface CapabilityRouteResult {
  harness: HarnessName;
  auto: boolean;
  catalog: CapabilityCatalog;
  resolution: RequirementResolution;
  route: JobCapabilityRoute;
}

interface CacheEntry {
  key: string;
  generation: number;
  fingerprint: string;
  catalog: CapabilityCatalog;
}

/**
 * Narrow pre-dispatch routing dependency. Direct tools and workflow `agent()`
 * calls depend on this instead of the whole service so both stay testable.
 */
export interface CapabilityRouter {
  route(request: CapabilityRouteRequest): Promise<CapabilityRouteResult>;
}

export interface CapabilityServiceOptions {
  backends: Backend[];
  ttlMs?: number;
  discoveryTimeoutMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /**
   * Configuration/skill-root fingerprint used to invalidate dormant cache
   * entries. Only directory and config metadata is inspected; contents and auth
   * files are never read.
   */
  fingerprint?: (harness: HarnessName, cwd: string) => string;
}

/**
 * Live, model-free capability discovery with a bounded browse cache and
 * mandatory revalidation before any requirement-carrying dispatch.
 */
export class CapabilityService {
  readonly #backends: Map<HarnessName, Backend>;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<CapabilityCatalog>>();
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fingerprint: (harness: HarnessName, cwd: string) => string;
  #generation = 0;

  constructor(options: CapabilityServiceOptions) {
    this.#backends = new Map(options.backends.map((backend) => [backend.name, backend]));
    this.#ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#timeoutMs = Math.max(1_000, options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#fingerprint = options.fingerprint ?? ((harness, cwd) => configFingerprint(harness, cwd, this.#env));
  }

  get harnesses(): HarnessName[] {
    return [...this.#backends.keys()];
  }

  /** Drop cached catalogs after a harness reports a resource/skill change. */
  invalidate(harness?: HarnessName): void {
    if (!harness) return void this.#cache.clear();
    for (const [key, entry] of this.#cache) if (entry.catalog.harness === harness) this.#cache.delete(key);
  }

  async catalog(harness: HarnessName, request: CapabilityRequest): Promise<CapabilityCatalog> {
    const customization = request.customization ?? "native";
    const key = `${harness}|${request.cwd}|${request.access}|${customization}`;
    const fingerprint = this.#fingerprint(harness, request.cwd);
    const cached = this.#cache.get(key);
    if (!request.refresh && cached && cached.fingerprint === fingerprint && this.#now() - cached.catalog.discoveredAt < this.#ttlMs) {
      return cached.catalog;
    }
    const pending = this.#inflight.get(key);
    if (pending && !request.refresh) return pending;
    const generation = ++this.#generation;
    const discovery = this.#discover(harness, request, customization)
      .then((catalog) => {
        const existing = this.#cache.get(key);
        if (!existing || existing.generation <= generation) this.#cache.set(key, { key, generation, fingerprint, catalog });
        return catalog;
      })
      .finally(() => {
        if (this.#inflight.get(key) === discovery) this.#inflight.delete(key);
      });
    this.#inflight.set(key, discovery);
    return discovery;
  }

  async catalogs(request: CapabilityRequest & { harnesses?: HarnessName[] }): Promise<CapabilityCatalog[]> {
    const wanted = request.harnesses?.filter((harness) => this.#backends.has(harness)) ?? this.harnesses;
    return Promise.all(wanted.map((harness) => this.catalog(harness, request)));
  }

  async search(request: CapabilityRequest & CapabilityQuery): Promise<{ matches: CapabilityMatch[]; total: number; catalogs: CapabilityCatalog[] }> {
    const catalogs = await this.catalogs({
      cwd: request.cwd,
      access: request.access,
      customization: request.customization,
      refresh: request.refresh,
      signal: request.signal,
      harnesses: request.harness ? [request.harness] : undefined,
    });
    const { matches, total } = searchCapabilities(catalogs, request);
    return { matches, total, catalogs };
  }

  /**
   * Resolve an explicit or automatic route. Explicit routes must satisfy every
   * requirement; `auto` filters candidates by capability, access, and health and
   * then follows the configured preference order.
   */
  async resolveRoute(request: CapabilityRouteRequest): Promise<CapabilityRouteResult> {
    const requires = request.requires ?? [];
    const auto = request.harness === "auto";
    const explicit: HarnessName | undefined = auto ? undefined : request.harness as HarnessName | undefined;
    if (explicit && !this.#backends.has(explicit)) {
      throw new Error(`Harness is unavailable: ${explicit}`);
    }
    if (!auto && !explicit) throw new Error("Capability routing requires an explicit harness or harness auto");
    const candidates = auto
      ? orderCandidates(request.candidates ?? this.harnesses, request.preference ?? [])
        .filter((harness) => this.#backends.has(harness))
      : [explicit as HarnessName];
    if (!candidates.length) throw new Error("No harness candidate remains after policy filtering");

    const failures: string[] = [];
    for (const harness of candidates) {
      const catalog = await this.catalog(harness, request);
      if (catalog.health === "unavailable") {
        failures.push(`${harness} capability discovery is unavailable${catalog.warnings[0] ? `: ${catalog.warnings[0]}` : ""}`);
        continue;
      }
      const resolution = resolveRequirements(catalog, requires);
      if (!requirementsSatisfied(resolution)) {
        failures.push(describeResolution(harness, resolution));
        continue;
      }
      return {
        harness,
        auto,
        catalog,
        resolution,
        route: {
          harness,
          matched: resolution.satisfied.map((capability) => capability.id),
          revision: catalog.revision,
          discoveredAt: catalog.discoveredAt,
          auto: auto ? true : undefined,
          warnings: catalog.warnings.length ? [...catalog.warnings] : undefined,
        },
      };
    }
    const alternatives = requires.length && !request.refresh ? await this.#alternatives(request, requires, candidates) : [];
    throw new Error(
      `${auto ? "No harness satisfies" : "Selected harness cannot satisfy"} the required capabilities: ${requires.join(", ")}`
      + (failures.length ? ` — ${failures.join("; ")}` : "")
      + (alternatives.length ? `; available on: ${alternatives.join(", ")}` : ""),
    );
  }

  /** Authoritative recheck immediately before dispatch; never served from cache. */
  async revalidate(request: CapabilityRouteRequest & { harness: HarnessName }): Promise<CapabilityRouteResult> {
    return this.resolveRoute({ ...request, refresh: true });
  }

  /**
   * Pre-dispatch route: choose a harness (browse cache is enough to compare
   * candidates), then revalidate the winner live so the recorded route always
   * cites an inventory observed after the caller's last chance to change it.
   */
  async route(request: CapabilityRouteRequest): Promise<CapabilityRouteResult> {
    let chosen = await this.resolveRoute(request);
    if (request.refresh) return chosen;
    const excluded = new Set<HarnessName>();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.harnesses.length; attempt++) {
      try {
        const live = await this.revalidate({ ...request, harness: chosen.harness });
        return chosen.auto ? { ...live, auto: true, route: { ...live.route, auto: true } } : live;
      } catch (error) {
        if (request.signal?.aborted) throw error;
        lastError = error;
        // A cached browse result can become invalid between selection and the
        // authoritative pre-dispatch check (most commonly auth expiry). For
        // auto routes, refresh the remaining candidate set and exclude every
        // provider that already failed live validation so an auth failure does
        // not immediately retry the same provider. Explicit routes retain
        // fail-closed semantics.
        if (!chosen.auto) throw error;
        excluded.add(chosen.harness);
        const remaining = (request.candidates ?? this.harnesses).filter((harness) => !excluded.has(harness));
        if (!remaining.length) break;
        chosen = await this.resolveRoute({ ...request, refresh: true, candidates: remaining });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "No healthy harness remains"));
  }

  async #alternatives(request: CapabilityRequest, requires: string[], tried: HarnessName[]): Promise<HarnessName[]> {
    const others = this.harnesses.filter((harness) => !tried.includes(harness));
    const capable: HarnessName[] = [];
    for (const harness of others) {
      try {
        const catalog = await this.catalog(harness, request);
        if (requirementsSatisfied(resolveRequirements(catalog, requires))) capable.push(harness);
      } catch { /* alternatives are advisory */ }
    }
    return capable;
  }

  async #discover(harness: HarnessName, request: CapabilityRequest, customization: CustomizationMode): Promise<CapabilityCatalog> {
    const backend = this.#backends.get(harness);
    const discoveredAt = this.#now();
    if (!backend?.discover) {
      return buildCatalog({
        harness,
        cwd: request.cwd,
        access: request.access,
        discoveredAt,
        capabilities: [],
        sources: [{ source: harness, health: "unknown", detail: "this harness adapter does not support capability discovery" }],
        warnings: [`${harness} does not expose a capability inventory; requirements cannot be verified`],
      });
    }
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason ?? new Error("Capability discovery aborted"));
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`${harness} capability discovery timed out after ${this.#timeoutMs}ms`)), this.#timeoutMs);
    try {
      const result = await backend.discover({
        cwd: request.cwd,
        access: request.access,
        customization,
        env: this.#env,
        signal: controller.signal,
        refresh: request.refresh === true,
      });
      return buildCatalog({
        harness,
        cwd: request.cwd,
        access: request.access,
        discoveredAt,
        capabilities: result.capabilities,
        sources: result.sources,
        warnings: result.warnings,
        nativeVersion: result.nativeVersion,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return buildCatalog({
        harness,
        cwd: request.cwd,
        access: request.access,
        discoveredAt,
        capabilities: [],
        sources: [{ source: harness, health: "unavailable", detail }],
        warnings: [`${harness} capability discovery failed: ${detail}`],
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}

function orderCandidates(candidates: HarnessName[], preference: HarnessName[]): HarnessName[] {
  const ordered: HarnessName[] = [];
  for (const harness of [...preference, ...candidates]) {
    if (candidates.includes(harness) && !ordered.includes(harness)) ordered.push(harness);
  }
  return ordered;
}

/**
 * Metadata-only fingerprint of the configuration and customization roots that
 * decide a harness inventory. Only `stat` is used: no file content, credential,
 * or session data is read.
 */
export function configFingerprint(harness: HarnessName, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const roots = harness === "claude"
    ? [resolve(home, ".claude"), resolve(home, ".claude/settings.json"), resolve(home, ".claude/skills"), resolve(cwd, ".claude"), resolve(cwd, ".mcp.json")]
    : harness === "codex"
      ? [resolve(home, ".codex"), resolve(home, ".codex", "config.toml"), resolve(cwd, ".codex"), resolve(cwd, ".agents")]
      : [resolve(home, ".pi"), resolve(home, ".pi/agent/skills"), resolve(home, ".pi/agent/extensions"), resolve(cwd, ".pi")];
  return roots.map((root) => {
    try {
      const stat = statSync(root);
      return `${root}:${Math.round(stat.mtimeMs)}:${stat.size}`;
    } catch {
      return `${root}:absent`;
    }
  }).join("|");
}
