# Worktree isolation and retention

Use `isolation: "worktree"` on a workflow `agent()` when authorized writers must run concurrently. Writers that share a checkout are serialized within a workflow. Isolation requires a clean source checkout at the trusted Git repository root. Keep the source clean while the isolated jobs run.

Each isolated call gets a branch named `pi-workflow/<runId>/<agentIndex>`. Ask the child to leave its changes uncommitted. Finalization checks for staged, unstaged, and untracked changes against the worktree's own HEAD. A clean worktree is removed along with its branch, even if the child committed its work there.

## Collect the work

Inspect `/workflows worktrees` for protected worktrees. Report the run ID, agent index, state, and recorded patch artifact when available.

| State | Meaning and action |
| --- | --- |
| `active` | The isolated job is still using the checkout. |
| `removed` | The runtime verified removal of the checkout, Git registration, and branch. |
| `preserved` | Changes were written to the private `agent-<index>.patch` artifact. Inspect the patch before integrating the work. |
| `orphaned` | Finalization failed. Inspect the error and worktree path to locate and salvage changed work. |

Finalization ends the isolated session's usefulness for `followUp()` and peer answers. Use a shared checkout for retained convergence rounds or progressed provider continuation.

## Reclaim a worktree

For a terminal run, `/workflows reclaim <runId> <agentIndex>` requests confirmation and removes the checkout, registration, and branch. The patch remains in the run artifacts. Verify that any changes you need are recoverable before reclaiming. For an orphaned checkout without a patch, the worktree may hold the **only copy**. Use `--force` only when discarding that copy is intended.

Retention keeps the newest 64 eligible runs. A terminal run, or a running/paused checkpoint stale for 24 hours, can become eligible once all its worktrees are removed. Open session leases, protected worktrees, and ambiguous checkout entries prevent deletion. Reclaiming the last protected worktree can make the run and its artifacts eligible for later removal.
