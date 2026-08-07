import { normalizeRequirements } from "./capabilities.ts";
import type { CapabilityRouter } from "./capability-service.ts";
import { selectAccess, selectHarness } from "./policy.ts";
import type { HarnessName, JobCapabilityRoute, ProfileDefinition, ProviderFamily, SpawnRequest } from "./types.ts";

/** Caller-facing harness field: an explicit route, or `auto` capability-based selection. */
export type RequestedHarness = HarnessName | "auto";

export interface CapabilityRoutingRequest {
  /** Spawn request as written by the caller, with `harness` still possibly `auto`. */
  request: Omit<SpawnRequest, "harness"> & { harness?: RequestedHarness };
  profile?: ProfileDefinition;
  independentOfProvider?: ProviderFamily;
  /** Preference order for `auto`; the configured default harness comes first. */
  preference?: HarnessName[];
  signal?: AbortSignal;
}

export interface CapabilityRouting {
  /** Concrete harness to dispatch on, or undefined to keep the caller's implicit route. */
  harness?: HarnessName;
  requires?: string[];
  capabilityRoute?: JobCapabilityRoute;
}

export function isRequestedHarness(value: unknown): value is RequestedHarness {
  return value === "pi" || value === "claude" || value === "codex" || value === "auto";
}

/**
 * Resolve and live-revalidate a capability route before dispatch. Requests
 * without `requires` and without `harness: "auto"` keep their existing routing
 * untouched, so ordinary delegation never pays for discovery. `harness: "auto"`
 * may omit `requires` when the caller wants health/auth-based provider selection.
 */
export async function routeCapabilities(
  router: CapabilityRouter | undefined,
  input: CapabilityRoutingRequest,
): Promise<CapabilityRouting> {
  const { request } = input;
  const auto = request.harness === "auto";
  const requires = normalizeRequirements(request.requires);
  if (auto && request.model) throw new Error("harness:auto cannot use a harness-local model override; omit model or choose an explicit harness");
  if (!auto && !requires) return {};
  if (!router) throw new Error("Capability requirements are unavailable in this session (capability routing is unavailable)");

  const explicit = auto
    ? undefined
    : selectHarness({ ...request, harness: request.harness as HarnessName | undefined }, input.profile, input.independentOfProvider);
  const independenceTarget = input.independentOfProvider ?? request.parentProvider;
  // independentOf only constrains routing after its provider has been resolved;
  // unknown/evicted/Pi targets fail closed later in JobManager rather than
  // arbitrarily excluding a capable harness during catalog selection.
  const independent = request.independent === true || input.independentOfProvider !== undefined || input.profile?.independent === true;
  let candidates: HarnessName[] | undefined = auto && independent
    ? independenceTarget === "claude" ? ["codex"]
      : independenceTarget === "codex" ? ["claude"]
      : ["claude", "codex"]
    : undefined;
  if (auto && input.profile?.lockedHarness) {
    candidates = candidates
      ? candidates.filter((harness) => harness === input.profile!.lockedHarness)
      : [input.profile.lockedHarness];
  }
  const routed = await router.route({
    cwd: request.cwd,
    access: selectAccess({ ...request, harness: undefined }, input.profile),
    customization: request.customization,
    model: request.model,
    harness: explicit ?? "auto",
    requires,
    preference: input.preference,
    candidates,
    signal: input.signal,
  });
  return { harness: routed.harness, requires, capabilityRoute: routed.route };
}
