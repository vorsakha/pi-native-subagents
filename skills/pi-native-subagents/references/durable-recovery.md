# Durable execution and recovery

Read this before recovering an interrupted workflow or replaying a settled run.

## Runtime ownership

Workflows use pinned Durable/code-mode 1.3.0 with a QuickJS worker and one private SQLite database per run. Durable owns tasks, call results, execution replay, and interrupted-task recovery. The existing native job manager owns Pi, Claude, and Codex execution and the shared four-turn scheduler. No coordinator model turn is added.

`runtime.sqlite` contains execution state plus bounded application history for inspection, finished-run replay, and suffix restart. JSON summaries, transcripts, results, and reports are inspection exports. Task-scoped code-mode journals retire at settlement; application history remains until run retention removes it. Keep databases and their sidecars private and out of Git. Only one process may schedule or write a run's database; passive inspection never enables scheduling.

## Recover an interrupted host

A restored stale projection is shown as aborted. Repeat the `workflow` call with its original source, input, project, route, approval, and budget, adding `resumeFromRunId`. If its Durable task is still pending, the runtime recovers that task under the same run ID.

Completed calls return their persisted results without native dispatch. A native call interrupted after intent returns an interruption failure and is never automatically redispatched, even if no progress was observed. Inspect partial effects before choosing manual recovery. Native commands, hooks, plugins, MCP calls, and file mutations are not exactly-once. Recovery does not reattach provider processes or restore their retained sessions. A later `followUp()` can therefore fail because the native session no longer exists.

The script may handle that failed result and continue with later calls. Native admission persists agent state before execution. Each application-history commit also stores bounded inspection, transcripts, and usage, so completed results cannot outrun their accounting projection. An unresolved script promise with no host call that could settle it fails as stalled. Active calls may run until completion or explicit cancellation; there is no overall workflow deadline.

## Replay a settled run

For a settled task, `resumeFromRunId` starts a replacement run. The application matches completed calls against bounded persisted proofs, including independently completed parallel lanes. Failed or incomplete work may run again only when no interrupted native intent or progressed-work proof forbids it. Compatible budget increases remain supported for finished replay. Interrupted recovery requires the original budget.

Restarting an eligible selected agent also starts a replacement run, reuses its valid prefix, and invalidates its suffix. It cannot discard progressed or interrupted native work. The dashboard hides restart for those agents; use the recorded handoff where eligible, or inspect partial effects and recover manually. Replaying an interruption preserves its failure and never makes that native intent safe to dispatch.

Old Node VM/checkpoint runs are not migrated or resumable. Start a fresh run after inspecting their partial effects.

## Failures

- Database already has a live owner: inspect the active workflow owner. Do not delete its owner file or open a second scheduler.
- Interrupted call may have partially run: inspect the workspace and external effects. Choose any fresh work explicitly.
- Execution context or budget mismatch: supply the original values for interrupted recovery. A fresh run is a separate dispatch decision.
- Missing or inconsistent application history: no unsafe primary replay or continuation is authorized.
- Sandbox host-call limit: use the documented helpers. The host caps all script-to-host calls at 600, in addition to the 32 native-call limit and individual event/payload bounds.
