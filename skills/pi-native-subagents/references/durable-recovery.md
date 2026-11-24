# Recover or replay a workflow

Open `/workflows`, identify the run ID, and inspect the last calls and their effects. A stale restored run can appear aborted even when its Durable task is still pending.

Repeat the original `workflow` invocation with `resumeFromRunId`. Keep the script, input, trusted project, routing context, and approval mode the same. Use the original budget for interrupted recovery. For a settled run, the original or a compatible larger budget is accepted.

| State of the source | What to expect |
| --- | --- |
| Pending Durable task | Recovery keeps the run ID. Completed calls return their saved results. An interrupted native intent returns its recorded interruption failure, even if progress was never observed. |
| Settled task with retained history | Replay creates a replacement run. Matching completions, including completed parallel lanes, can be reused without dispatch. Eligible unfinished work may run. |
| Selected agent eligible for restart in `/workflows` | Restart creates a replacement run, reuses the valid prefix, and invalidates calls from the selected one onward. |
| Legacy Node VM run | Inspect partial effects before starting a fresh workflow. Legacy runs cannot be resumed. |

Recovery restores script execution and saved results. It cannot reattach native processes or restore their sessions. A new `followUp()` against a replayed job can therefore fail. Branch on each call's `ok` before starting dependent work.

An interrupted native intent may already have changed files or external services. Inspect those effects before choosing fresh work. Replay preserves the interruption error, and a manual restart cannot discard interrupted or progressed native work. For a progressed call with a valid original handoff, only the declared replacement is eligible. Missing or inconsistent history cannot authorize a dispatch.

## When recovery is refused

- **Definition, execution context, or budget mismatch.** Use the original request. Starting over can repeat effects.
- **Database already owned.** Inspect the active run in its owning session. Leave its owner file in place. Only one process may schedule a run. Passive inspection is safe.
- **Session reload.** Inspect the replacement session's history. Pending mutation approvals and restoration callbacks belonged to the previous session.
- **Stalled script.** A pending promise needs a host call that can settle it. Await all agent calls before returning. A script also has a 600 host-call ceiling.

Keep the private per-run Durable database, sidecars, transcripts, and result exports out of Git. A JSON summary is for inspection. Recovery uses retained execution history.
