# Bounded implementation and review

Use `converge()` when a read-only reviewer can assess an implementation in the shared checkout and send actionable findings back to the same implementer. Use a single review for one-shot work or when a human must decide how to proceed.

```js
export default async function () {
  return await converge({
    maxRounds: 3,
    implement: "Implement the agreed changes in docs/plan.md. Report how you verified them.",
    review: "Inspect the working tree against docs/plan.md. Cite actionable findings.",
  });
}
```

One round runs implementation and review. Two or more rounds leave room for fixes. Both sessions are retained. Each fix and re-review consumes another workflow call. If omitted, `maxRounds` is derived from remaining calls at two per round, capped at 16. The helper checks capacity for both calls and both phases before mutation.

## Configure the loop

- Each step takes a prompt string or `{ prompt, options }` with ordinary `agent()` routing options. Keep the implementer able to mutate and the reviewer read-only. Omit per-step `schema`, `phase`, and `isolation`. The helper supplies the review schema, owns phase ordering, and needs both sessions to remain usable.
- For a reviewer on a different provider, route the implementer to native Claude or Codex and set `independentReview: true`. The helper sets the reviewer's `independentOf` to the implementer's ID.
- Use `fixInstructions` or `reviewInstructions` for standing guidance on later rounds (2,000 characters each). Set `includeSuggestions: true` only if suggestions must be resolved. `stallTolerance` allows 0–4 repeated rounds of the same actionable findings and defaults to 0.
- With a declared phase plan, include `implement 1`, `review 1`, `fix 1`, `review 2`, and subsequent applicable names. Setting `name` prefixes each title with `<name> · `. Use `phases: false` to manage phases outside the loop.
- A step may declare one eligible `continuationFallback` or explicitly opt into Codex Fast. The two are incompatible. Retained rounds inherit the original policy. A provider handoff carries the current round, pending findings, and effective schema.

## Judge the result

The reviewer returns `verdict`, `summary`, and up to 32 `findings` under `convergenceReviewSchema`. Give each finding a stable, unique `id`, a `severity` of `blocker`, `issue`, or `suggestion`, and a `body`. Include `filePath`, `startLine`, and `endLine` when available. A request for changes needs at least one actionable finding. Approval requires zero actionable findings. The helper sends the bounded findings and summary to the implementer.

Read `outcome`, `stoppingReason`, and `finalReview` before reporting completion. Only `approved` has `ok: true`. Report the reviewer's external boundary for `blocked`, repeated unresolved findings for `stalled`, and the remaining review after `limit-reached`. A failed call or unusable verdict yields `failed`. Cancellation, pause, and shutdown remain workflow lifecycle states.
