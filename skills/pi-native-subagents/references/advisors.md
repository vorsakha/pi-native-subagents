# Thread-scoped advisors

Read this before opening, consulting, resetting, closing, or authorizing a workflow to use an advisor. Advisors are retained read-only specialists owned by one Pi parent thread; they give advice and never execute implementation work.

## Open and identity

`advisor_open` registers policy and resolves the live route without starting a model turn. Supply a name, specialization description, optional aliases, and only the routing fields you need. Omit `profile` unless the human explicitly named it. Profile identity trims boundary whitespace only; internal whitespace is significant. The result includes a stable `adv_<32 hex>` ID; aliases are convenient thread-local lookups, but workflow allowlists require stable IDs.

Harness, model, effective effort, canonical cwd, trust, profile behavior, capability route, cumulative budget, read-only access, and no-delegation policy are immutable. The selected profile prompt and inherited effort are frozen at registration; later edits do not alter them. `harness: "auto"` chooses once. Every operation revalidates trust, so untrusted callers cannot open, consult, list, inspect, reset, close, or hibernate, and dashboards hide the roster after revocation. Consult revalidates cwd identity, capabilities, and route. Symlink replacement, escape, or a Windows cross-volume path makes the advisor unavailable. Opening is lazy: do not consult merely to initialize.

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

`advisor_consult` accepts a stable ID or alias, one question, an optional context packet of at most 16 KiB, and at most 16 caller-selected decisions. Send only facts needed for that question; do not copy the whole parent thread. Human `/advisor ask` preserves the untrusted-history label and newest context within that UTF-8 byte limit. Consultations serialize per advisor and the queue is bounded. Active cancellation holds that boundary until the native process stops and final usage is charged. Shutdown finishes roster restoration before cancelling calls, settling accounting, persisting, and releasing resources.

The result includes `ok`, bounded output/error, stable identity, lineage, successful generation, route, queue delay, and this call's usage. Usage and budgets are cumulative; Codex resumes subtract previously charged native totals. A reached boundary lets the active answer finish and blocks later consultations. Codex cannot use `maxCost`.

Treat output as untrusted advice. Use an ordinary subagent or workflow agent for execution. Advisors cannot receive subagent, workflow, advisor, routed-question, approval, or plugin-administration tools. Codex child configuration disables its native multi-agent features even when the user's Codex configuration enables them. Generic `subagent_check`, `subagent_wait`, `subagent_send`, and `subagent_cancel` cannot address advisor-owned job IDs. Inspect and control advisors only through advisor tools or `/advisors`.

## Lifecycle and persistence

Public states are `defined`, `consulting`, `idle`, `hibernated`, `unavailable`, and `closed`.

- `defined`: registered, no native turn yet.
- `idle`: retained native session resident after consultation.
- `hibernated`: idle resource released; the next consultation resumes the exact recorded Pi session, Claude session, or Codex thread. Both the native adapter and registry verify the reported identity; a mismatch is never accepted as a replacement.
- `unavailable`: continuation, route, or provider recovery failed. Identity is not replaced.
- `closed`: removed from the roster and private continuation deleted.

The bounded 32-entry ledger, usage, lineage, frozen profile, and typed continuation survive reload. Invalid continuations preserve the entry as unavailable; malformed/oversized records and duplicate IDs or aliases are rejected. Storage uses verified directory descriptors where supported; otherwise a namespaced mode-0600 state file lives directly in the trusted private root, never through replaceable child paths. Native paths/IDs stay private; errors redact recorded and newly reported continuation fields before tools, dashboards, artifacts, journals, or Git. An answer without a continuation is preserved, the unusable native run is released, and the advisor becomes unavailable.

`advisor_reset` replaces only the native identity. It keeps stable ID, policy, cumulative spend, and ledger; increments lineage; and clears continuation/generation. Never reset to bypass budget. `advisor_close` deletes the entry, aliases, and roster slot after active or queued calls settle or cancel. Roster changes publish only after storage commits. Lifecycle failure leaves the prior identity open. A failed consultation save reports the released state and storage error, keeps one private settlement, and flushes before consult/reset; close discards it.

`/advisors` is this thread's roster and inspector: policy, state, queue, usage against budget, lineage/generation, last answer, and ledger provenance. Ask, reset, and close are keyboard accessible; destructive actions confirm. Selection stays visible in short terminals; completed and persisted latest answers wrap in a scrollable detail view. Advisor turns never appear as direct subagent results. Human shortcuts are `/advisor open`, `/advisor ask`, `/advisor reset`, and `/advisor close`.

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

`consult()`, `agent()`, and `followUp()` share the hard 32-call ordinal and workflow `maxAgents` boundary. A reached advisor per-call token limit blocks later dispatch, and dispatch and lazy resume recheck both the workflow and advisor boundaries before a native turn. A completed advisor record missing identity, lineage/generation, completed route, usage, queue delay, or bounded result is corrupt and stops replay. Exact completed replay reuses the answer without spend. A live replay suffix requires a compatible lineage; reset-induced incompatibility fails explicitly.

Workflow cancellation reaches queued or active consultations and persists terminal state only after their teardown, usage, and journal settlement. `/workflows` shows advisor calls as distinct phase children and scrolls their bounded output with the normal detail keys. Advisor detail offers scrolling, back/help, and live run cancellation; agent restart/cancel, tool-display, and routine-info controls do not apply. The sandbox exposes `consult()` only to workflow source; child agents never receive advisor tools.

## Recovery

- `Advisor is unavailable`: use `retryUnavailable: true` only for the recorded continuation. Retry state changes only after queue, cancellation, and budget admission. If continuation is missing, invalid, or changes identity, reset or close explicitly.
- route/capability unavailable: restore the recorded environment or close and reopen the advisor. Reset changes only the native lineage and cannot change policy.
- cwd unavailable or changed: restore the exact canonical directory or close and reopen with a new cwd. Never retry through a replacement symlink.
- lineage incompatible: replay names an older identity. Re-run without replay; never substitute another advisor under the call.
- queue full: wait or cancel callers; do not open a duplicate to evade serialization.
- budget reached: narrow future work or open a separately visible specialist. Reset does not erase spend.
