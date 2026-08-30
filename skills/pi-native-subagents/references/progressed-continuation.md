# Progressed cross-provider continuation

Read this before setting `continuationFallback`. It is an explicit recovery route for a workflow-native Claude or Codex call that became authoritatively unavailable after producing model or tool progress. It is distinct from initial `harness: "auto"` routing, pre-inference `providerFallback`, and same-provider quota waiting.

```js
const worker = await agent("Implement the change and verify it.", {
  name: "implementer",
  harness: "claude",
  model: "exact-primary-model",
  effort: "high",
  continuationFallback: {
    harness: "codex",
    model: "exact-replacement-model",
  },
});
```

The primary must explicitly be `claude` or `codex`; the target must be the other. The object accepts only `harness` and optional exact `model`. It cannot be combined with `providerFallback`, `harness: "auto"`, Pi, nesting, multiple targets, or `isolation: "worktree"`. Omit it unless the human accepts cross-provider continuation and the exactly-once limitation below.

## Eligibility and safety

Continuation opens only when all of these are true:

- the failed fresh `agent()` or retained `followUp()` reported structured, authoritative provider unavailability for the provider actually running it;
- the failed generation itself recorded model or tool progress, and the failure is not marked pre-inference; activity from an earlier retained generation never qualifies a new turn;
- the failed native process has settled and its retained resources are closed;
- the target freshly reports ready and satisfies the original fixed policy;
- the shared cwd is a provable Git checkout whose HEAD, staged entries, index flags, status, and changed worktree contents can be checkpointed; assume-unchanged, skip-worktree, and fsmonitor-valid flags are unsupported;
- this logical lineage has not already used its one continuation.

Ordinary errors, cancellation, missing or ambiguous evidence, a provider mismatch, pre-inference rejection, unsupported isolation, target unavailability, unsafe or changing checkout state, and a failed replacement are terminal. There is no reverse route, chained route, wait, or loop. `providerFallback` remains the pre-inference option; provider waiting retries the same provider and only fresh `agent()` calls.

Continuation never widens trust, access, cwd, profile, capabilities, approval mode, nesting, effort, schema, independence, or workflow/per-agent budgets. The effective native or portable schema is carried into the handoff and replacement unchanged. The target may use its declared exact model or native default. Budget preflight runs again and all usage already spent remains charged.

## Handoff semantics

The replacement continues the same workflow call and logical lineage in the same cwd and current checkout. It does **not** receive a blind replay of the original task. The bounded internal handoff includes:

- original objective and current turn;
- authoritative failure evidence and phase;
- bounded failed output plus recent tool names, states, and summaries;
- current convergence round and pending findings when present;
- the durable checkout digest and a direction to inspect existing state first.

Each required section has its own bound, so large objective, prompt, output, or tool evidence cannot truncate the phase, convergence state, checkout digest, or final continue-from-existing-state direction.

External commands, hooks, plugins, MCP calls, and services may have completed before the failed provider stopped. Continuation cannot guarantee exactly-once behavior for those effects. The replacement must inspect state and continue remaining work, not repeat commands merely because it did not author the partial result.

The checkout is revalidated after target probing and again when a queued replacement wins a global scheduler slot, immediately before native startup. After replacement starts, future `followUp()` calls and later `converge()` rounds target its retained session, and every result keeps the original script-visible job ID. `independentOf` and `independentReview` resolve against the replacement provider, not the closed primary. Cancellation covers settlement, checkout capture, handoff creation, queued admission, replacement execution, and retained follow-ups.

## Durability, accounting, and inspection

The journal first stores progressed-primary proof before process settlement, scheduler admission, locking, or checkout capture. That record forbids replay of the primary but does not authorize replacement. After the process is settled, a second durable handoff stores the structured trigger, effective schema, checkout proof, bounded prompt, target route, and usage before replacement dispatch. Replacement job ID and validated terminal result follow.

On exact `resumeFromRunId` replay:

- a completed continuation is replayed without provider dispatch or new usage;
- an interrupted durable handoff revalidates the checkout and dispatches only the replacement;
- a progressed-primary record with no safe handoff is returned as failed and is never rerun;
- missing proof or checkout divergence fails closed without either provider dispatch.

Usage is cumulative across the failed turn, replacement, and later logical generations. Archived attempts show their own delta, including after handoff replay; replay adds no usage and earlier generations are never counted twice. Reconstructed calls retain the original capability requirements. Call ordinals, budgets, cancellation, approvals, journal order, convergence state, and replay provenance remain attached to the logical call. Manual suffix restart is refused if it would discard any progressed checkpoint; use its durable handoff or recover manually.

`/workflows` shows the declaration as unused or used, `claude → codex (continued)` (or the reverse), the trigger, checkpoint, failed and replacement job provenance, and attempts. Replacement IDs are historical provenance; the dashboard does not claim a persisted or terminal replacement is retained. Provider waiting and pre-inference fallback keep separate labels.

## Recovery

- `requires a provable Git checkout`: continuation did not dispatch. Inspect the partial work and continue manually or move it into a safe Git checkout.
- `checkout is missing or diverged`: the durable handoff no longer describes the current checkout. Do not force replay; inspect the source run and current changes, then choose a manual recovery.
- target readiness or policy error: the replacement did not start. Restore the declared target or continue manually; the one route never silently changes.
- replacement provider failure: inspect its cumulative partial state. The automatic route is exhausted and cannot loop back.
