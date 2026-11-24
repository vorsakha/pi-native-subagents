# Budgets and provider waits

## Set a spend boundary

For a direct job, pass `maxTokens`, `maxCost`, or `maxTurns` at spawn. They apply cumulatively across the retained session. When a limit is reached, the active turn can finish and overshoot. Queued and later follow-ups recheck the total before starting. Steering an active turn stays available.

For a workflow, pass limits in `budget`. Use `maxAgents` for the number of calls (including follow-ups) and `maxConcurrency` for simultaneous work. Use `maxTokens`, `maxCost`, and `maxTurns` for aggregate spend across all children. `maxTokensPerAgent` checks each child's cumulative usage. Once any child reaches this limit, the workflow can refuse further fresh calls. Token limits count fresh input plus output and exclude cache reads.

Omit spend limits for an open budget. Running work can overshoot before new dispatches are blocked. For an exhausted workflow budget, inspect which child or aggregate hit the limit. A settled run can replay matching completions under a compatible larger budget. A pending Durable task requires the original budget.

Set `maxCost` only on routes that report cost (Pi or Claude). Codex rejects it before dispatch, including when selected through provider independence. When the human requests Fast, pass `harness: "codex", speed: "fast"` on the direct request or workflow child. Fast uses Codex credits. Exact credits and monetary cost are unreported. A profile can constrain speed. Only the request opts in. Retained turns and retries keep that speed.

## Wait for the same provider

Set `retry: { providerUnavailable: "wait", maxWaitMs, maxAttempts }` on the workflow to wait for a recognized Claude or Codex quota rejection with an authoritative retry time. Omit `retry` for immediate failure. Only fresh `agent()` calls can wait. A failed attempt must have produced no model or tool activity. If it used an isolated worktree, that worktree must have reached `removed`.

- `maxWaitMs` is shared by the run, defaults to 30 minutes, and accepts 1 second to 6 hours. `maxAttempts` allows 1–8 retries per fresh call and defaults to 1.
- Waiting releases the execution slot and concurrency lane. A retry keeps its call number, resolved harness, speed, and cumulative usage. The dashboard shows the retry time and attempt count.
- Cancelling a waiting child settles that call as failed and lets the script handle the result. Waits end when the Pi session shuts down. If a window exceeds the configured time or attempts, inspect the result before choosing a later retry.

## Switch providers before inference

Set `providerFallback` on a fresh workflow child to permit **one** attempt on the other native provider. For example, pass `{ harness: "claude", access: "readOnly", providerFallback: { harness: "codex" } }` as the options to `agent()`. Each route may name its own exact model. The fallback target must be ready and satisfy the request.

| Primary failed | When fallback is eligible |
| --- | --- |
| Before dispatch | Missing executable, login required, or incompatible provider. Either access level is eligible. |
| After dispatch | Enforced read-only access, authoritative pre-inference unavailability, zero usage, and no observed progress. A started full-access session may already have caused side effects. |

An unremoved isolated worktree, cancellation, or ordinary failure ends the attempt. Declaring fallback overrides waiting for this call. Both attempts share a call number. A fallback cannot itself fall back. Pre-inference fallback does not apply to retained follow-ups. Fast cannot be combined with either cross-provider policy.

Replay of an exact completion incurs no new dispatch or spend. Requested speed is part of the call identity (omitted and standard match). Changing the run's retry policy alone does not invalidate matching completions.
