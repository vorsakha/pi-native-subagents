# Continue a partially executed call on another provider

Use `continuationFallback` when the caller accepts cross-provider continuation and the task can safely resume after checking for partial effects. Hooks, commands, plugins, and external services may already have performed work. The handoff does not guarantee exactly-once external effects.

Declare it on the original workflow `agent()` options. For example, use `{ harness: "claude", continuationFallback: { harness: "codex" } }`. The target takes `harness` and an optional exact `model`. Choose explicit opposite native routes (Claude and Codex), standard speed, and a shared Git checkout. Worktree isolation and `providerFallback` are incompatible.

## When a replacement can start

- The active provider must report authoritative unavailability **after model or tool progress in this generation**. Earlier turns cannot qualify a failed follow-up. Pre-inference rejection, cancellation, and ordinary errors end the call.
- The runtime must confirm cleanup of the failed process tree and retained session. It must be able to verify the checkout's HEAD, branch, index, status, and changed contents. Assume-unchanged, skip-worktree, and fsmonitor-valid index flags prevent verification.
- At admission the replacement must still be ready, satisfy required capabilities, match the saved checkout, and fit the remaining budget. The original access, trust, effort, schema, approvals, independence constraints, and spend limits carry over.

The replacement receives the objective, current turn, failure evidence, bounded prior output and tool activity, and checkout evidence. A convergence handoff also carries the round and pending findings. Inspect existing state before repeating any action. Each lineage permits one handoff, including across retained follow-ups. An ineligible or failed handoff is terminal and does not enter a provider wait.

Keep using the script-visible job ID. A successful replacement receives later follow-ups, peer questions, and convergence rounds. Provider independence is checked against the replacement provider. Usage includes the primary, replacement, and retained turns. In `/workflows`, inspect the route marked `(continued)`, trigger, checkpoint, and attempts.

## Recover after interruption

| Evidence for this call in a settled run | What replay can do |
| --- | --- |
| Verified completed continuation | Return the recorded result without new usage. |
| Original interrupted handoff with a matching checkout | Revalidate admission and dispatch only the replacement. |
| Progress without a valid handoff, copied checkpoint alone, or diverged checkout | Preserve the failure. Inspect partial work and recover manually. |

Once progress is recorded, replay or suffix restart cannot rerun that primary from its original prompt. If cleanup failed, inspect the failed process tree before resuming work. If checkout verification failed, inspect the recorded changes and current checkout. If target readiness failed, inspect the target provider. A replacement failure requires a fresh assessment of what both attempts may have completed.
