# Supervise a job or workflow

Use `subagent_check({ jobId })` for a direct job's current status. In the terminal, open `/subagents` for direct jobs and `/workflows` for a workflow's runs, phases, and agents. When a workflow-owned job appears in `/subagents`, open its workflow to act on it. Outside the terminal, the commands return a session summary.

Use `?` for the current pane's bindings and `i` for route, usage, context, isolation, and replay details. Enter or Right opens detail. Escape backs out. In a transcript, scrolling away from the tail pauses the viewport. Press `G` to return to the end.

## Decide who needs to act

| State | Action |
| --- | --- |
| **Needs input** | Inspect the question's target. Answer a human-started job in the conversation or with `a` in its inspector. For a model-owned parent question, call `subagent_answer` with the request ID. A peer question is routed automatically. |
| **Waiting** | Read the provider, quota window, retry time, and attempt count. Retry is automatic. Cancelling a waiting agent fails that call while the workflow continues. |
| **Paused** | An operator paused the workflow. Use `p` to resume it. |
| **Queued** | The scheduler will dispatch the job when a slot opens. |

For an active direct job, use `s` to steer. Use `f` for another turn on a completed retained session. Answer a pending question before submitting a draft. Failed or cancelled direct sessions are closed. For an eligible selected workflow agent, `r` starts a replacement run from that agent. Only use actions offered for the visible selection. Restart cannot discard progressed or interrupted native work.

Use the workflow's `Now` line for live activity and `Context` for the phase or convergence round. A question, provider wait, queue, or failure takes precedence over routine activity. A replayed record has no live activity. When a provider reports activity without details, use the displayed status. Never infer an action from private reasoning, response text, raw commands, or credentials.

## Interpret routing and usage

- `/subagents providers` shows which harnesses are active and the reason for each readiness state. Use `/subagents providers refresh` to re-probe after a configuration change. Probes use no model turns and do not install or authenticate a provider. A missing version is inconclusive.
- Report the **configured model** as routing intent. Report a **serving model** only when the provider observed it. A clean mid-turn Codex app-server exit is a job failure and does not establish that a required capability is missing.
- Requested speed stays fixed across a lineage. Effective speed requires a served-tier receipt. Codex can accept Fast and still show effective speed unknown. Codex credits apply and monetary cost is unreported.
- Usage is cumulative across retained turns. Context occupancy is the latest turn's gauge. Missing occupancy means unknown. Avoid summing gauges across turns.
- A route marked `(continued)` identifies a progressed cross-provider handoff. Inspect its trigger, checkpoint, and attempt history. A recorded job ID alone does not establish a live session.

For completed work, report the task outcome and evidence. For failures, include the bounded error, route, and job or run ID. Keep private transcripts and artifact contents out of routine status reports.
