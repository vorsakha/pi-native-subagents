import { normalizeRequirements } from "./capabilities.ts";
import type { CapabilityRouter } from "./capability-service.ts";
import {
  explicitBlocked,
  HarnessAutoUnavailableError,
  HarnessUnavailableError,
  type HarnessAvailability,
  type HarnessAvailabilityProbe,
} from "./harness-availability.ts";
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
  /**
   * Optional read-only availability probe. When present, availability is
   * revalidated immediately before dispatch: a selected non-auto harness fails
   * closed unless it is ready and never reroutes, and `auto`
   * keeps only currently-ready harnesses.
   */
  availability?: HarnessAvailabilityProbe;
  /** Fail closed unless the resolved explicit route receives a fresh ready result. */
  requireAvailability?: boolean;
  signal?: AbortSignal;
}

export interface CapabilityRouting {
  /** Concrete harness to dispatch on, or undefined to keep the caller's implicit route. */
  harness?: HarnessName;
  requires?: string[];
  capabilityRoute?: JobCapabilityRoute;
  /**
   * Normalized availability of the resolved harness, observed by the live
   * pre-dispatch recheck. Present only when an availability probe ran, so the
   * workflow journal can record why a route was accepted or refused.
   */
  availability?: HarnessAvailability;
  /** Bounded candidate evidence for an auto route. */
  availabilityChecks?: HarnessAvailability[];
}

export function isRequestedHarness(value: unknown): value is RequestedHarness {
  return value === "pi" || value === "claude" || value === "codex" || value === "auto";
}

/**
 * Resolve and live-revalidate a capability route before dispatch. Every
 * selected route is revalidated when an availability probe is configured.
 * `harness: "auto"` may omit `requires` when the caller wants readiness-based
 * provider selection.
 */
export async function routeCapabilities(
  router: CapabilityRouter | undefined,
  input: CapabilityRoutingRequest,
): Promise<CapabilityRouting> {
  const { request } = input;
  const auto = request.harness === "auto";
  const requires = normalizeRequirements(request.requires);
  if (auto && request.model) throw new Error("harness:auto cannot use a harness-local model override; omit model or choose an explicit harness");

  const explicit = auto
    ? undefined
    : selectHarness({ ...request, harness: request.harness as HarnessName | undefined }, input.profile, input.independentOfProvider);

  // Resolve profile/default/independence policy before probing, then revalidate
  // that exact route. This covers implicit defaults as well as caller-named
  // harnesses. Every non-ready state, including unknown, fails closed.
  let explicitAvailability: HarnessAvailability | undefined;
  if (input.requireAvailability && !auto && explicit && !input.availability) {
    throw new Error(`Live availability validation is required for explicit ${explicit} dispatch`);
  }
  if (input.availability && !auto && explicit) {
    explicitAvailability = await input.availability.availability(explicit, { cwd: request.cwd, refresh: true, signal: input.signal });
    if (explicitBlocked(explicitAvailability.status)) throw new HarnessUnavailableError(explicitAvailability);
  }

  if (!auto && !requires) return explicitAvailability ? { harness: explicit, availability: explicitAvailability } : {};
  if (!router) throw new Error("Capability requirements are unavailable in this session (capability routing is unavailable)");

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
  // `harness: "auto"` considers only active harnesses: exclude every candidate a
  // live probe does not report as ready before the capability router narrows the
  // remainder by required capabilities and provider independence. `unknown`,
  // `unhealthy`, `missing`, `unauthenticated`, and `incompatible` are all
  // non-ready and therefore not active.
  const probedByHarness = new Map<HarnessName, HarnessAvailability>();
  if (auto && input.availability) {
    const base = candidates ?? input.availability.harnesses;
    if (!base.length) throw new Error("harness:auto found no eligible harness after policy filtering");
    const probed = await Promise.all(
      base.map((harness) => input.availability!.availability(harness, { cwd: request.cwd, refresh: true, signal: input.signal })),
    );
    for (const availability of probed) probedByHarness.set(availability.harness, availability);
    const ready = probed.filter((availability) => availability.ready).map((availability) => availability.harness);
    if (!ready.length) {
      throw new HarnessAutoUnavailableError(probed);
    }
    candidates = ready;
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
  return {
    harness: routed.harness,
    requires,
    capabilityRoute: routed.route,
    availability: explicitAvailability ?? probedByHarness.get(routed.harness),
    availabilityChecks: auto ? [...probedByHarness.values()] : undefined,
  };
}
