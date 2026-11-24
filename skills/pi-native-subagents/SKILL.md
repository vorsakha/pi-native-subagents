---
name: pi-native-subagents
description: Use when delegating a task, supervising a job, or working with a sandboxed workflow through Pi Native Subagents.
---

# Pi Native Subagents

Use `subagent_spawn` for one task or a few unrelated jobs. Use the foreground `subagent` for self-contained work that can block the parent until it finishes. Choose `workflow` when later steps depend on earlier results, or when you need bounded parallelism, phases, or replay.

## Dispatch a job

Give the child the objective, relevant paths, constraints, and evidence to return. Model-spawned children have no parent thread context. A human-started `/subagent` job may request a bounded, read-only snapshot. Children cannot delegate, approve escalation, or administer plugins or MCP servers.

Work in a trusted project and keep the child cwd inside it. Trusted jobs default to full access. Set `access: "readOnly"` for reviews, planning, and inspection so the harness enforces the boundary. Direct and workflow jobs share four active slots.

```json
{
  "task": "Review the retry logic in src/manager.ts. Identify any path that could run a job twice and cite the relevant lines.",
  "access": "readOnly"
}
```

Pass this shape to `subagent_spawn`. Omit routing options for the configured default harness (initially Pi) and its native model. Use the host's routing skill, when present, for model and effort preferences.

- If the child needs a particular tool or integration, call `subagent_capabilities` with the child's access level. Pass returned IDs in `requires`. Use `harness: "auto"` to select a ready route at dispatch. Auto excludes harness-local model overrides and does not provide failover.
- Use `independent: true` for a provider different from the parent's. To review a particular native Claude or Codex producer, pass its job ID in `independentOf`.
- Set `profile` only when the human names it. Set `speed: "fast"` only for an explicitly requested Codex Fast job. It uses Codex credits and reports no monetary cost.

## Deliver the result

Use the job ID from the spawn receipt. Call `subagent_wait({ jobId })` when the caller needs the result now. On timeout, keep waiting if the job is still running. For background work, the extension delivers an unconsumed terminal result once. Use `subagent_check` for a status request and `subagent_cancel` to stop the job.

If the child asks the parent a question, answer from the conversation. Ask the human only for a decision that belongs to them. Call `subagent_answer({ requestId, answer })`, then resume waiting. To steer an active job or continue a completed retained session, use `subagent_send` with `behavior: "steer"` or `"followUp"` respectively.

Report the requested result and verification. For a failed route include the job ID, route, and bounded error when available. Keep private prompts, transcripts, artifacts, and credentials out of Git and ordinary results.

## Write a workflow

Export a default async JavaScript function and use the injected globals. The script has no filesystem, network, imports, or subprocesses. Use `agent(prompt, options)` for new work and `followUp(jobId, prompt)` for a successful retained child from this run. Pass deferred functions such as `() => agent(...)` to `parallel`. Await every call before returning. Budget for at most 32 calls including follow-ups. Serialize writers sharing a checkout. Isolated worktrees are one-shot.

Check each call's `ok` before using its result. Use `output` for narrative and `structured` for schema-validated data. Invalid or missing schema output fails the call. A native schema-bound follow-up inherits its schema. Return a JSON object with a boolean `ok` to record the task outcome. A completed run can still have an unsuccessful task outcome.

## Read when needed

| Before you… | Read |
| --- | --- |
| Write a script, call a saved workflow, or choose input, approvals, phases, parallelism, or retained follow-ups | [Workflow authoring](references/workflow-authoring.md) |
| Send review findings back to the same implementer for bounded fix rounds | [Convergence](references/convergence.md) |
| Set spend limits, Codex Fast, quota waits, or pre-inference provider fallback | [Budgets and provider waits](references/budgets-replay-and-provider-waits.md) |
| Allow another provider to continue a partially executed call | [Progressed continuation](references/progressed-continuation.md) |
| Recover an interrupted run, replay completed calls, or restart from a selected agent | [Durable recovery](references/durable-recovery.md) |
| Run writers in parallel worktrees or reclaim a checkout that may hold the only copy of changed work | [Worktrees and retention](references/worktrees-and-retention.md) |
| Route a question to a peer, consult a saved Pi session, or resolve an expired question | [Routed questions](references/routed-questions.md) |
| Inspect provider readiness, supervise a job, or report progress and usage | [Supervision and telemetry](references/supervision-and-telemetry.md) |
| Consume `native-subagents:state:v1` in another extension | [Presentation state V1](references/presentation-state-v1.md) |

If a route is rejected, check `/subagents providers` for its readiness reason and rediscover required capability IDs at the requested access level. For an interrupted native call, inspect partial effects before starting fresh work. Recovery can reuse a completed call without restoring its native session.
