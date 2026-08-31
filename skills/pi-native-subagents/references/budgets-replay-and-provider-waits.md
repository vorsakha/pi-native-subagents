# Budgets, replay, and provider waits

Read this before setting budgets, replay, waits, or fallback.

## Direct-job budgets

Direct limits are optional and cumulative across a retained lineage. Omit them for an open budget.

A reached direct limit never cancels or changes the active turn. It may overshoot, then blocks later follow-ups. A follow-up queued mid-generation waits for settlement and a cumulative recheck; steering stays immediate.

Fresh input plus output consumes `maxTokens`; cache reads do not. Never infer a spend limit from a profile, route, model, or environment.

## Workflow budgets

- `maxAgents` and `maxConcurrency` limit work shape. `maxTokens` counts aggregate fresh input plus output, not cache reads. `maxTokensPerAgent` applies that ceiling per child. `maxCost` and `maxTurns` are aggregate.
- Omitted workflow budgets leave spend open. Hard ceilings remain: 32 calls, four workers, global concurrency four, watchdogs, provider/context limits, bounded persistence, cancellation, and shutdown.
- Spend limits are soft dispatch boundaries. The runtime warns once per metric, lets running calls finish and overshoot, then blocks fresh dispatches. Queued jobs recheck on admission. Replayable completions bypass fresh checks; `maxTokensPerAgent` does too.
- `>=` is reached. Aggregate usage spans children. Exact replay is free; handoff admission adds carried source spend to checkpointed and journal-only current usage.

## Cost reporting is provider-dependent

Pi and Claude report tokens, turns, and cost. Codex omits cost, so its routes reject `maxCost` before dispatch. Validation uses the final live route, including the provider opposite an `independentOf` producer. Never treat absent cost as zero.

Codex Fast requires `speed: "fast"` on the direct request or workflow `agent()` call. Profiles may permit or constrain it, but never opt in. The adapter reports no exact credits or monetary cost. Cards say `Codex credits apply · monetary cost unreported`; no estimate or budget is synthesized.

## Replay with resumeFromRunId

`resumeFromRunId` replays each matching completion, including later parallel calls after an earlier lane failed. Failed, incomplete, duplicated, or mismatched ordinals rerun live.

- Keep source, input, project, and route identical; increase replay budgets only when permitted.
- A terminal retained source can be looked up by run ID across Pi sessions; the source summary and journal are read under the retention lock before replay starts.
- New journal records add available route evidence: requested and resolved harness, normalized auto-candidate checks, executable version, model, and capability fingerprint. Older journals still load without it. A matched completion reuses its result and evidence; invalidation or mismatch dispatches fresh and may resolve `harness: "auto"` again.
- Requested speed is replay identity. Explicit `standard` matches a legacy omitted value; `fast` does not. Exact Fast replay dispatches nothing and consumes no new credits. Effective speed is telemetry and never changes continuation identity.
- `retry` is not part of the replay definition fingerprint, so changing it does not invalidate a prior run for `resumeFromRunId`.

## Opt-in provider waits

`retry: { providerUnavailable: "wait", maxWaitMs?, maxAttempts? }` is opt-in on `start`. The default — `retry` omitted, or `providerUnavailable: "fail"` — fails an `agent()` call immediately on provider exhaustion.

**Scope: fresh `agent()` calls only.** A `followUp()` resumes a native session the job manager has already closed once its generation fails, so there is nothing left to redispatch; it always fails immediately regardless of the policy. Retry with a fresh `agent()` call instead.

Waiting applies only when:

- Claude or Codex reports recognized quota rejection with an authoritative retry time. Claude limit boilerplate counts only when it is the entire assistant content;
- the failed attempt produced no model or tool activity — replaying observable work could duplicate side effects;
- the failed attempt used no isolated worktree that had not fully finalized.

Either refusal is terminal and actionable, not a silent fallthrough.

Bounds and accounting:

- `maxWaitMs` defaults to 30 minutes, caps at 6 hours, and is shared by the run. `maxAttempts` defaults to 1 per fresh call.
- Waiting occupies no native inference slot and holds no workflow concurrency lane, so sibling agents and other direct or workflow work can still dispatch.
- Routing stays pinned to the harness the first attempt resolved to. Waiting never reroutes Claude to Codex or back.
- Requested speed stays pinned across every same-provider retry.
- A retried call keeps its original call ordinal and never consumes another of the 32 agent calls. Usage that a retried attempt actually spent counts toward `maxTokens`/`maxCost`/`maxTurns` and per-agent budgets.
- While waiting, the agent has no current error. Summaries expose only bounded provider/window/retry/attempt data. Raw errors stay private; durable attempts keep route, job, usage, and disposition provenance. Exhaustion fails with the wait-policy reason and recovery.
- Waiting is session-local: a live, in-memory schedule, not a durable or detached runner. A session shutdown aborts a pending wait exactly like any other in-flight work, and cancelling a waiting agent settles it immediately as a terminal failure while the run continues.

## Explicit provider fallback

`providerFallback: { harness: "claude" | "codex", model?: string }` names one opposite native route for a fresh `agent()` call and overrides wait.

Fast speed cannot combine with `providerFallback` or `continuationFallback`; the declaration fails before primary dispatch because an opposite provider cannot preserve Fast policy.

After dispatch it requires `readOnly`, authoritative pre-inference proof, zero usage, and a freshly ready target. Safe missing/login/incompatibility readiness may fall back under either access. Other errors, cancellation, policy rejection, worktrees, waits, retries, and another fallback are terminal.

Attempts share one ordinal and cumulative usage. Journals retain declaration, trigger, attempts, and route. Exact completion replays without probing.

## Progressed continuation accounting

`continuationFallback` opts into one opposite-provider handoff after authoritative unavailability and progress. Ineligible or pre-inference failure is terminal, never a same-provider wait. Usage stays cumulative on one logical ID, including retained-call refusal; attempts store only their generation delta. Budgets stay fixed.

A progressed record forbids primary replay but cannot authorize replacement. The handoff proves checkout before dispatch. Admission rechecks readiness and capabilities, then checkout and budget under the startup deadline. Only a bound completion replays free; copied proof never dispatches, while an interrupted original handoff runs only the replacement. Carried, checkpointed, and journal-only usage all count once. Later ordinal corruption cannot erase durable progress and rerun the primary. Cancellation covers admission, replacement, and retained calls. `/workflows` keeps continued, fallback, and waiting distinct.

## Recovery

- `Workflow ... budget exhausted`: narrow the lane or replay with a larger compatible budget; completed calls remain reusable.
- `Budget maxCost is unsupported`: remove the cost boundary or select Pi/Claude.
- "...already produced model or tool activity": without an eligible continuation checkpoint, inspect partial effects and recover manually; replay never reruns that progressed primary.
- Provider wait exhausted: raise the explicit attempt/time bound and replay, or retry manually later.
- A started full-access pre-inference fallback stays terminal. Inspect possible side effects before manual recovery.
