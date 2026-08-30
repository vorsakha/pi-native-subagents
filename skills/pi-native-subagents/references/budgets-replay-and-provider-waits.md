# Budgets, replay, and provider waits

Read this before setting spend limits, replay, waiting, or fallback. These options change dispatch and accounting.

## Direct-job budgets

Direct limits are optional and cumulative across the retained session and its follow-ups. Omit them for an open budget.

Reaching a direct spend boundary never cancels the active turn or changes its result. The active turn finishes, usage may overshoot, and later retained follow-ups are rejected. A follow-up submitted during an active generation waits for settlement and a cumulative-budget recheck; steering the active generation stays immediate.

Fresh input plus output consumes `maxTokens`; cache reads do not. Never infer a spend limit from a profile, route, model, or environment.

## Workflow budgets

- `maxAgents` and `maxConcurrency` limit work shape. `maxTokens` limits aggregate fresh input plus output; cached reads remain visible but do not consume that budget. `maxTokensPerAgent` applies the same ceiling to one child. `maxCost` and `maxTurns` are aggregate, and `maxTurns` is not a per-agent allowance.
- Workflow budgets are optional. An omitted or empty budget leaves spend open while the hard ceilings — 32 calls, four workers, global concurrency four, watchdogs, provider/context limits, bounded persistence, cancellation, and shutdown — remain in force.
- Spend limits are soft dispatch boundaries. The runtime warns once per reached metric, lets already-running calls finish, accepts asynchronous overshoot, preserves natural child success, and blocks only later fresh dispatches. Workflow-owned jobs recheck the boundary when a global scheduler slot opens, so queued children cannot slip through after another child settles. A replayable completed journal call is replayed before fresh-dispatch budget checks. `maxTokensPerAgent` follows the same rule.
- Use `>=` semantics: observed usage at the exact limit counts as reached. Workflow aggregate usage is cumulative across children; replayed calls do not spend again.

## Cost reporting is provider-dependent

Pi and Claude report token, turn, and cost metrics. Codex reports tokens and turns but not cost, so a Codex route with `maxCost` is rejected before dispatch — both directly and in a workflow. The runtime validates the final live route, including the provider opposite an `independentOf` producer, instead of comparing the limit with a synthetic zero. Never treat Codex's absent cost metric as zero.

## Replay with resumeFromRunId

`resumeFromRunId` replays every independently matching completed call, including later calls from a parallel batch when an earlier lane failed. Failed, incomplete, duplicated, or fingerprint-mismatched ordinals rerun live.

- Keep source, input, project, and routing context identical; only increase replay budgets when the runtime permits it.
- A terminal retained source can be looked up by run ID across Pi sessions; the source summary and journal are read under the retention lock before replay starts.
- New journal records add route evidence when available: the requested and resolved harness, normalized availability checks for auto candidates, executable version, selected model, and capability-catalog fingerprint. Older journals omit these fields and still load. A matched completed call reuses its recorded result and evidence; only an explicit replay invalidation or mismatch causes a fresh dispatch that may resolve `harness: "auto"` again.
- `retry` is not part of the replay definition fingerprint, so changing it does not invalidate a prior run for `resumeFromRunId`.

## Opt-in provider waits

`retry: { providerUnavailable: "wait", maxWaitMs?, maxAttempts? }` is opt-in on `start`. The default — `retry` omitted, or `providerUnavailable: "fail"` — fails an `agent()` call immediately on provider exhaustion.

**Scope: fresh `agent()` calls only.** A `followUp()` resumes a native session the job manager has already closed once its generation fails, so there is nothing left to redispatch; it always fails immediately regardless of the policy. Retry with a fresh `agent()` call instead.

Even for `agent()`, waiting applies only when:

- the harness is Claude or Codex and it reported a recognized quota rejection with an authoritative retry time. For Claude, recognized session-limit boilerplate on the terminal refusal counts as metadata only when it is the entire assistant content; genuine text, thinking, or tool activity still blocks automatic replay. Unsupported providers or rejections without enough retry information fail immediately;
- the failed attempt produced no model or tool activity — replaying observable work could duplicate side effects;
- the failed attempt used no isolated worktree that had not fully finalized.

Either refusal is terminal and actionable, not a silent fallthrough.

Bounds and accounting:

- `maxWaitMs` (default 30 minutes, up to 6 hours) bounds the total wait allowance for the whole run, shared across concurrent calls. `maxAttempts` (default 1) bounds retries per fresh `agent()` call.
- Waiting occupies no native inference slot and holds no workflow concurrency lane, so sibling agents and other direct or workflow work can still dispatch.
- Routing stays pinned to the harness the first attempt resolved to. Waiting never reroutes Claude to Codex or back.
- A retried call keeps its original call ordinal and never consumes another of the 32 agent calls. Usage that a retried attempt actually spent counts toward `maxTokens`/`maxCost`/`maxTurns` and per-agent budgets.
- Waiting is session-local: a live, in-memory schedule, not a durable or detached runner. A session shutdown aborts a pending wait exactly like any other in-flight work, and cancelling a waiting agent settles it immediately as a terminal failure while the run continues.

## Explicit provider fallback

`providerFallback: { harness: "claude" | "codex", model?: string }` names one opposite native route for a fresh `agent()` call and overrides wait.

After dispatch it requires `readOnly`, authoritative pre-inference proof, zero usage, and a freshly ready target. Safe missing/login/incompatibility readiness may fall back under either access. Other errors, cancellation, policy rejection, worktrees, waits, retries, and another fallback are terminal.

Both attempts share one ordinal and cumulative usage; budget preflight runs again. The journal and `/workflows` retain the declaration, trigger, attempts, and route. Exact completion replays without probing; an incomplete pre-inference attempt restarts at its primary.

## Progressed continuation accounting

`continuationFallback` opts into one opposite-provider handoff after authoritative unavailability and observed progress. It owns recovery: ineligible or pre-inference failure is terminal, never a same-provider wait. Usage stays cumulative on one stable logical ID; archived attempts store only their generation delta, including on handoff replay. Original budgets remain fixed and are checked before replacement.

A pre-settlement progressed record forbids primary replay but cannot authorize replacement. The durable handoff proves the index/worktree checkout before target dispatch and again at scheduler admission. Completed replay spends nothing; interrupted handoff replay runs only the replacement. Missing/diverged proof fails closed. Manual suffix restart cannot discard a progressed checkpoint. Cancellation covers records, admission, replacement, and retained calls. `/workflows` separates continued, fallback, and waiting routes.

## Recovery

- `Workflow ... budget exhausted`: narrow the lane or replay with a larger compatible budget; completed calls remain reusable.
- `Budget maxCost is unsupported`: remove the cost boundary or select Pi/Claude.
- "...already produced model or tool activity": without an eligible continuation checkpoint, inspect partial effects and recover manually; replay never reruns that progressed primary.
- Provider wait exhausted: raise the explicit attempt/time bound and replay, or retry manually later.
- A started full-access pre-inference fallback stays terminal. Inspect possible side effects before manual recovery.
