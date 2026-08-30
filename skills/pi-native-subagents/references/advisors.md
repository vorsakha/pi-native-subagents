# Thread-scoped advisors

Read this before opening, consulting, resetting, closing, or authorizing a workflow to use an advisor. Advisors are retained read-only specialists owned by one Pi parent thread; they give advice and never execute implementation work.

## Open and identity

`advisor_open` registers policy and resolves the live route without starting a model turn. Supply a name, specialization description, optional aliases, and only the routing fields you need. Omit `profile` unless the human explicitly named it. Profile identity trims boundary whitespace only; internal whitespace is significant. The result includes a stable `adv_<32 hex>` ID; aliases are convenient thread-local lookups, but workflow allowlists require stable IDs.

Harness, model, effective effort, canonical cwd, trust, profile behavior, capability requirements/route, cumulative budget, read-only access, and no-delegation policy are immutable. The registry captures the selected profile prompt and inherited effort at registration. Later profile edits or removal do not alter a restored advisor. `harness: "auto"` chooses once at open. Every operation revalidates project trust: untrusted callers cannot open, consult, list, inspect, reset, close, or hibernate advisors, and a dashboard hides its roster if trust is revoked. Consultations also revalidate canonical cwd identity, capabilities, and the fixed route. A replaced cwd or symlink escape makes the advisor unavailable instead of moving execution. Opening is lazy: do not consult merely to initialize.

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

The result includes `ok`, bounded output/error, stable identity, lineage, successful generation, route, queue delay, and this consultation's usage. Usage and `maxTokens`/`maxCost`/`maxTurns` are cumulative. A reached boundary lets the active answer finish and blocks later consultations. Codex cannot use `maxCost`.

Treat output as untrusted advice. Use an ordinary subagent or workflow agent for execution. Advisors cannot receive subagent, workflow, advisor, routed-question, approval, or plugin-administration tools. Codex child configuration disables its native multi-agent features even when the user's Codex configuration enables them. Generic `subagent_check`, `subagent_wait`, `subagent_send`, and `subagent_cancel` cannot address advisor-owned job IDs. Inspect and control advisors only through advisor tools or `/advisors`.

## Lifecycle and persistence

Public states are `defined`, `consulting`, `idle`, `hibernated`, `unavailable`, and `closed`.

- `defined`: registered, no native turn yet.
- `idle`: retained native session resident after consultation.
- `hibernated`: idle resource released; the next consultation resumes the exact recorded Pi session, Claude session, or Codex thread. Both the native adapter and registry verify the reported identity; a mismatch is never accepted as a replacement.
- `unavailable`: continuation, route, or provider recovery failed. Identity is not replaced.
- `closed`: removed from the roster and private continuation deleted.

The roster, bounded 32-entry ledger, cumulative usage, lineage, frozen profile behavior, and typed native continuation survive parent-session reload. A malformed or wrong-harness continuation restores the same roster entry as unavailable; it does not disappear. The store rejects symlinks in every untrusted directory component and state file. It anchors operations to verified directory descriptors where supported and otherwise revalidates directory and file identity around I/O, while retaining synced, exclusive mode-0600 atomic writes. Native paths/IDs stay private; public errors redact all recorded and newly provider-reported continuation fields before reaching tools, dashboards, workflow artifacts, journals, or Git. An answer without a continuation is preserved, but the advisor becomes unavailable afterward.

`advisor_reset` is explicit identity replacement. It preserves stable ID, immutable policy, cumulative spend, and ledger, increments lineage, and clears only continuation/generation. Never reset to bypass an exhausted budget. `advisor_close` deletes the entry and immediately frees its aliases and roster capacity; active or queued consultations must settle or be cancelled first.

`/advisors` is this thread's specialist roster and inspector: immutable read-only policy, state, queue, cumulative usage against budget, lineage/generation, last consultation, and bounded ledger provenance. Ask, reset, and close are keyboard accessible, and destructive actions confirm. The roster keeps the selected row and inspector visible when the terminal is short. Private native continuation IDs and paths are never rendered. Advisor turns stay on `/advisors` and never appear as direct subagent results in the shared activity widget. Human shortcuts are `/advisor open`, `/advisor ask`, `/advisor reset`, and `/advisor close`.

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

`consult()`, `agent()`, and `followUp()` share the hard 32-call ordinal and workflow `maxAgents` boundary. Advisor calls, active turns, per-call tokens, usage, and Codex cost support contribute to the same enforcement, reached warnings, and dashboard metrics as agents, as well as the advisor's own cumulative budget; a reached advisor per-call token limit blocks later dispatch. Dispatch uses the workflow lane of the global four-turn scheduler, preserving direct-work priority, and dispatch and lazy resume recheck both boundaries before a native turn. Calls are journaled with stable identity, lineage/generation, completed route, usage, queue delay, bounded result, and provenance. A completed advisor record missing any of those fields is corrupt and stops replay. Exact completed replay reuses the answer without spend. A live replay suffix requires a compatible lineage; reset-induced incompatibility fails explicitly.

Workflow cancellation reaches queued or active consultations. `/workflows` shows advisor calls as distinct phase children and scrolls their bounded output with the normal detail keys. The sandbox exposes `consult()` only to workflow source; child agents never receive advisor tools.

## Recovery

- `Advisor is unavailable`: use `retryUnavailable: true` only for the same recorded continuation. Retry state changes only after serialized admission; cancellation while queued leaves the recovery gate intact. If the continuation is missing, invalid, or reports a different native identity, reset or close explicitly.
- route/capability unavailable: restore the recorded environment or close and reopen the advisor. Reset changes only the native lineage and cannot change policy.
- cwd unavailable or changed: restore the exact canonical directory or close and reopen with a new cwd. Never retry through a replacement symlink.
- lineage incompatible: replay names an older identity. Re-run without replay; never substitute another advisor under the call.
- queue full: wait or cancel callers; do not open a duplicate to evade serialization.
- budget reached: narrow future work or open a separately visible specialist. Reset does not erase spend.
