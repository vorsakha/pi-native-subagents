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
- the runtime has proved the failed native process group is absent and its retained resources are closed; bounded cleanup failure authorizes no replacement;
- the target freshly reports ready and satisfies the original fixed policy, including every required capability;
- the shared cwd is a provable Git checkout whose commit, symbolic branch or detached HEAD state, staged entries, index flags, status, and changed contents can be checkpointed; assume-unchanged, skip-worktree, and fsmonitor-valid flags are unsupported;
- this logical lineage has not already used its one continuation.

Ordinary errors, cancellation, missing or ambiguous evidence, a provider mismatch, pre-inference rejection, unsupported isolation, target unavailability, unsafe or changing checkout state, and a failed replacement are terminal. There is no reverse route, chained route, wait, or loop. `providerFallback` remains the pre-inference option; provider waiting retries the same provider and only fresh `agent()` calls.

Continuation never widens trust, access, cwd, profile, capabilities, approval mode, nesting, effort, schema, independence, or workflow/per-agent budgets. The effective native or portable schema is carried into the handoff and replacement unchanged. The target may use its declared exact model or native default. Budget preflight runs again and all usage already spent remains charged.

## Handoff semantics

The replacement continues the same workflow call and logical lineage in the same cwd and current checkout. It does **not** receive a blind replay of the original task. The bounded handoff includes:

- durable original objective and current turn;
- authoritative failure evidence and phase;
- bounded failed output plus recent tool names, states, and summaries;
- current convergence round and pending findings when present;
- the durable checkout digest and a direction to inspect existing state first.

Each required section has its own bound, so large objective, prompt, output, or tool evidence cannot truncate the phase, convergence state, checkout digest, or final continue-from-existing-state direction.

External commands, hooks, plugins, MCP calls, and services may have completed before the failed provider stopped. Continuation cannot guarantee exactly-once behavior for those effects. The replacement must inspect state and continue remaining work, not repeat commands merely because it did not author the partial result.

When a queued replacement wins a global scheduler slot, admission revalidates target readiness and required capabilities, then proves the checkout and checks workflow budgets before native startup. Admission and backend startup share one deadline. After replacement starts, future `followUp()` calls, peer questions addressed to the logical ID, and later `converge()` rounds target its retained session, including after handoff replay. Every result keeps the original script-visible job ID. `independentOf` and `independentReview` resolve against the replacement provider, not the closed primary. Cancellation covers settlement, checkout capture, handoff creation, admission, replacement execution, and retained follow-ups.

## Durability, accounting, and inspection

The journal stores progress proof before settlement or checkout. It blocks primary replay but cannot authorize replacement. After settlement, a durable handoff stores trigger, schema, checkout proof, bounded prompt, target, and usage. Replay atomically rebinds the checkpoint's agent index, immutable call ordinal, lineage generation, and native job ownership before events or settlement masks publish. Later output stays on that call's generation. A successful terminal, including terminal-only replay, must bind its route to the handoff; `replayedFrom` is checked against an accepted ancestor chain. Copied checkpoints are provenance-only, so a crash before their terminal cannot create another live handoff. A progressed failure or validated continuation terminal remains a replay refusal if a later record corrupts its ordinal. Missing, duplicate, or inconsistent records authorize no primary replay, replacement, or success once progress is durable.

On exact `resumeFromRunId` replay:

- a completed continuation is replayed without provider dispatch or new usage;
- an interrupted durable handoff revalidates the checkout and dispatches only the replacement;
- a progressed-primary record with no safe handoff is returned as failed and is never rerun;
- missing proof or checkout divergence fails closed without either provider dispatch.

Usage is cumulative across the failed turn, replacement, and later generations. Follow-up and peer-answer journals include failed-primary usage plus usage reported during settlement. Attempts keep their own delta. Exact replay adds none. Interrupted-handoff admission adds replay-carried source spend to checkpointed current lineages and journal-only deltas when `workflow.json` lags. Resumed checkpoints durably claim usage moved out of the carried ledger, preventing both omission and double counting after a crash. Reconstructed calls retain capability requirements. Call ordinals, cancellation, approvals, journal order, convergence, and replay provenance stay on the logical call. Manual suffix restart cannot discard an agent-call progressed checkpoint. Exact replay restores that guard for progressed follow-ups. Cancelling the current progressed turn preserves it. Earlier generations and auxiliary peer answers never mark a later call progressed. Peer-question ordinals do not affect this decision.

`/workflows` marks the declaration used as soon as the durable handoff claims it, then shows `claude → codex (continued)` (or the reverse), trigger, checkpoint, failed/replacement job provenance, and attempts. Replacement IDs are historical; persisted or terminal jobs are not called retained. Waiting and pre-inference fallback keep separate labels.

## Recovery

- `requires a provable Git checkout`: continuation did not dispatch. Inspect the partial work and continue manually or move it into a safe Git checkout.
- `checkout is missing or diverged`: the durable handoff no longer describes the current checkout. Do not force replay; inspect the source run and current changes, then choose a manual recovery.
- target readiness or policy error: the replacement did not start. Restore the declared target or continue manually; the one route never silently changes.
- failed process-tree cleanup: the bound includes cleanup already queued on the job. Descendants may remain; no replacement started. Inspect and terminate the failed provider tree before manual recovery.
- replacement provider failure: inspect its cumulative partial state. The automatic route is exhausted and cannot loop back.
