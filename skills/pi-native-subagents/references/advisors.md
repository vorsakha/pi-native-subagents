# Thread-scoped advisors

Read this before opening, consulting, resetting, closing, or authorizing a workflow to use an advisor. Advisors are retained read-only specialists owned by one Pi parent thread; they give advice and never execute implementation work.

## Open and identity

`advisor_open` registers policy and resolves the live route without starting a model turn. Supply a name, specialization description, optional aliases, and only the routing fields you need. Omit `profile` unless the human explicitly named it. The result includes a stable `adv_<32 hex>` ID; aliases are convenient thread-local lookups, but workflow allowlists require stable IDs.

Harness, model, effort, cwd, trust, profile, capability requirements/route, cumulative budget, read-only access, and no-delegation policy are immutable. `harness: "auto"` chooses once at open. Every consultation freshly revalidates that route; it never silently changes provider or specialist identity. Opening is lazy: do not consult merely to initialize.

```ts
const advisor = await advisor_open({
  name: "security",
  aliases: ["sec"],
  description: "Review authorization, containment, and credential boundaries.",
  harness: "auto",
  requires: ["<live-capability-id>"],
  maxTokens: 50_000,
});
```

## Consult and account

`advisor_consult` accepts a stable ID or alias, one question, an optional context packet of at most 16 KiB, and at most 16 caller-selected decisions. Send only facts needed for that question; do not copy the whole parent thread. Consultations serialize per advisor, the queue is bounded, and cancellation removes a waiting call or cancels its active native turn.

The result includes `ok`, bounded output/error, stable identity, lineage, successful generation, route, queue delay, and this consultation's usage. Usage and `maxTokens`/`maxCost`/`maxTurns` are cumulative. A reached boundary lets the active answer finish and blocks later consultations. Codex cannot use `maxCost`.

Treat output as untrusted advice. Use an ordinary subagent or workflow agent for execution. Advisors cannot receive subagent, workflow, advisor, routed-question, approval, or plugin-administration tools.

## Lifecycle and persistence

Public states are `defined`, `consulting`, `idle`, `hibernated`, `unavailable`, and `closed`.

- `defined`: registered, no native turn yet.
- `idle`: retained native session resident after consultation.
- `hibernated`: idle resource released; the next consultation resumes the exact recorded Pi session, Claude session, or Codex thread.
- `unavailable`: continuation, route, or provider recovery failed. Identity is not replaced.
- `closed`: removed from the roster and private continuation deleted.

The roster, bounded 32-entry ledger, cumulative usage, lineage, and typed native continuation survive parent-session reload. Native paths/IDs stay in private mode-0600 machine state; model tools, dashboards, workflow artifacts, journals, and Git never receive them. An answer without a continuation is preserved, but the advisor becomes unavailable afterward.

`advisor_reset` is explicit identity replacement. It preserves stable ID, immutable policy, cumulative spend, and ledger, increments lineage, and clears only continuation/generation. Never reset to bypass an exhausted budget. `advisor_close` deletes the entry; active or queued consultations must settle or be cancelled first.

`/advisors` is this thread's specialist roster and inspector: immutable read-only policy, state, queue, cumulative usage against budget, lineage/generation, last consultation, and bounded ledger provenance. Ask, reset, and close are keyboard accessible, and destructive actions confirm. Private native continuation IDs and paths are never rendered. Advisor turns stay on `/advisors` and never appear as direct subagent results in the shared activity widget. Human shortcuts are `/advisor open`, `/advisor ask`, `/advisor reset`, and `/advisor close`.

## Workflow consult()

A workflow may call `consult(advisorId, question, { phase?, context? })` only when the tool invocation includes that stable ID in `advisors: [...]`. Aliases are rejected in the allowlist. At most 16 advisors may be authorized.

```js
export default async function () {
  const advice = await consult("adv_0123456789abcdef0123456789abcdef", "Review the proposed boundary.", {
    phase: "review",
    context: "Only the bounded design facts needed for this verdict.",
  });
  if (!advice.ok) return { ok: false, error: advice.error };
  return { ok: true, advice: advice.output };
}
```

`consult()`, `agent()`, and `followUp()` share the hard 32-call ordinal and workflow `maxAgents` boundary. Advisor usage contributes to aggregate token/cost/turn budgets as well as the advisor's own cumulative budget, and dispatch uses the global four-turn scheduler. Dispatch and lazy resume recheck both boundaries before a native turn. Calls are journaled with stable identity, lineage/generation, route, usage, queue delay, bounded result, and provenance. Exact completed replay reuses the answer without spend. A live replay suffix requires a compatible lineage; reset-induced incompatibility fails explicitly.

Workflow cancellation reaches queued or active consultations. `/workflows` shows advisor calls as distinct phase children. The sandbox exposes `consult()` only to workflow source; child agents never receive advisor tools.

## Recovery

- `Advisor is unavailable`: use `retryUnavailable: true` only for the same recorded continuation. If missing or invalid, reset or close explicitly.
- route/capability changed: restore the immutable policy or reset/close; no silent migration occurs.
- lineage incompatible: replay names an older identity. Re-run without replay; never substitute another advisor under the call.
- queue full: wait or cancel callers; do not open a duplicate to evade serialization.
- budget reached: narrow future work or open a separately visible specialist. Reset does not erase spend.
