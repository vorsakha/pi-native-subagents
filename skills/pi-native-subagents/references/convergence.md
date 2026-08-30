# Bounded convergence with converge()

Read this before calling `converge()`. It runs the iterative implement → review → fix lifecycle inside one workflow run instead of stopping at the first review: one mutating implementer and one read-only reviewer are started with `agent()`, then both retained sessions are continued across rounds with `followUp()`.

```js
export default async function () {
  const result = await converge({
    name: "issue 24",
    maxRounds: 3,
    implement: {
      prompt: "Implement the plan in docs/plan.md. Report what you changed and how you verified it.",
      options: { name: "implementer" },
    },
    review: {
      prompt: "Review the working tree against docs/plan.md. Return your structured verdict.",
      options: { name: "reviewer" },
    },
    independentReview: true,
  });

  phase("summarize");
  log(`convergence ${result.outcome} after ${result.roundsAttempted} round(s)`);
  return result;
}
```

## When to use it

Use bounded convergence when implementation is followed by a machine-verifiable review, findings can go back to the same retained implementer, and the reviewer can reassess the shared checkout without mutating it. Unless the caller explicitly asks for a one-shot review, give an implementation/review workflow at least one bounded fix round.

Prefer a single `agent()` call, or a plain loop, when the work is one-shot research or synthesis, when a human must judge between rounds, when each attempt needs a clean isolated worktree, when acceptance cannot be expressed as a bounded structured verdict, or when further work would touch production or another approval-gated surface.

## Options

`implement` and `review` each take a prompt string or a `{ prompt, options }` object, where `options` are ordinary `agent()` options. Other options:

- `maxRounds` — an integer from 1 to 16. Omitted, it is derived from the run's remaining agent-call budget at two calls per round, capped at 16.
- `stallTolerance` — 0–4; allows that many repeated rounds before stopping.
- `includeSuggestions` — counts `suggestion` findings as actionable.
- `independentReview` — makes the reviewer `independentOf` the implementer's job.
- `fixInstructions` / `reviewInstructions` — bounded standing guidance (at most 2000 characters each) prepended to every fix and re-review prompt.
- `phases: false` — suppresses the helper's own phase calls.
- `name` — a non-empty string used to prefix the emitted phases.

## Rejected before dispatch

These are validated before any model call, and apply to **both** the `implement` and `review` steps unless stated otherwise:

- `isolation` on either step — a worktree-isolated call is finalized when it returns and can never be continued by `followUp()`, so the loop could not run.
- `phase` on either step — `converge()` owns the implement/review phase sequence so it can validate both activations before mutation.
- `schema` on either step — an implement schema is refused outright, and the review verdict is always validated against `convergenceReviewSchema`, which cannot be replaced.
- `access` on the review step when it is anything other than `readOnly`. The reviewer is always dispatched read-only.

## Result and outcomes

The result is `{ ok, outcome, roundsAttempted, maxRounds, implementerJobId, reviewerJobId, finalReview, implementationOutput, stoppingReason, rounds }`, where `outcome` is one of:

- `approved` — the reviewer returned `approve`; the only `ok: true` outcome;
- `blocked` — the reviewer reported an external or policy boundary;
- `stalled` — a round repeated the previous round's actionable findings unchanged;
- `limit-reached` — `maxRounds`, the 32-call ceiling, or a workflow budget stopped the loop; the last review is preserved;
- `failed` — a call failed, or a review returned an unusable structured verdict.

## Loop rules

- Every review is validated against `convergenceReviewSchema`: `verdict` (`approve`, `request_changes`, or `blocked`), `summary`, and `findings[]` with a stable `id`, `severity` (`blocker`, `issue`, or `suggestion`), `body`, and optional `filePath`/`startLine`/`endLine`, capped at 32 findings. A missing, malformed, or duplicate-id verdict, `request_changes` without an actionable finding, or `approve` with actionable findings ends the loop as `failed`. Suggestions count as actionable for this check only when `includeSuggestions` is true.
- Only bounded review evidence — the summary plus every actionable finding — is sent back to the implementer. The helper preserves every finding ID while bounding individual locations and bodies to fit the prompt limit.
- Every implementation and review turn is an ordinary agent call: it consumes a call ordinal, counts toward every workflow and per-agent budget, is journaled and replayable, and is cancelled with the run. Cancellation, pause, and shutdown stay lifecycle states and never become a convergence outcome.
- Either initial step may explicitly declare `continuationFallback`. After eligible current-turn progress and provider unavailability, the bounded handoff keeps the current round, pending findings, and the review schema when applicable. Later rounds target that lineage's replacement session. A failed or unsafe handoff ends convergence as `failed`, never as a fresh round or provider loop.
- Stall detection is deterministic and advisory: it compares normalized actionable finding IDs and bodies between consecutive rounds. It never spends a model call and never infers progress from prose or token counts.
- The loop preflights both agent-call and phase capacity before each round's mutation, and returns `limit-reached` rather than starting a round it cannot finish. No workflow runs indefinitely because a reviewer keeps requesting another round.
- The helper emits `implement 1`, `review 1`, `fix 1`, `review 2`, … phases, prefixed with `name` when given. With a declared `meta.phases` plan, either declare those names or pass `phases: false`.
