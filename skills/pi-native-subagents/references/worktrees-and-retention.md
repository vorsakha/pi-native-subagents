# Worktree isolation and run retention

Read this before using `isolation: "worktree"` and before reclaiming or discarding any protected worktree. **A reclaim can destroy the only copy of a child's changed work.**

## isolation: "worktree"

Mutating agents that share one checkout are serialized. Use `isolation: "worktree"` when two mutating agents must run concurrently instead:

- The source checkout must be clean. Isolation is refused otherwise, so the isolated base cannot silently omit uncommitted work.
- Each isolated call gets its own Git worktree on a `pi-workflow/<runId>/<agentIndex>` branch.
- When the call returns, the worktree is finalized. If the child changed nothing, cleanup removes the checkout, Git registration, and branch. The runtime records `removed` only after it verifies all three are absent, whether cleanup came from normal finalization or explicit reclaim. If the child changed something, the diff is written as an `agent-<index>.patch` run artifact and the state becomes `preserved`. A finalization that could not complete cleanly is recorded as `orphaned`.
- **A finalized worktree can never be continued.** An isolated `agent()` call can never be targeted by `followUp()`, can never answer a peer's routed question, and cannot be used inside `converge()`.
- `continuationFallback` is also rejected with worktree isolation. Progressed continuation requires one provable shared Git checkout; it never transfers an isolated checkout or patch to another provider.
- Preserve the resulting patch metadata in the workflow result. The patch is the durable record of what the isolated child produced.

## Inspecting and reclaiming

`/workflows worktrees` enumerates every protected worktree with its run ID, agent index, state, branch, worktree path, patch artifact (if any), and orphaning error.

`/workflows reclaim <runId> <agentIndex> [--force]` is explicit and confirmation-gated. It removes the Git worktree registration and the `pi-workflow/<runId>/<agentIndex>` branch, refuses a non-terminal run, and refuses to discard an orphaned checkout that has no patch artifact unless `--force` is passed. It never deletes a patch.

When reclaim refuses with "no patch artifact", the orphaned checkout is the only copy of its changed work. Inspect it at the printed worktree path and salvage what you need **before** passing `--force` to discard it.

Reclaiming a run's last protected worktree is what makes that run eligible for the retention cap below.

## Run retention

Workflow run artifacts are bounded to the newest 64 eligible runs on disk, the same cap as in-session run history.

A run is only reclaimed once it is terminal (or a `running`/`paused` checkpoint has gone stale for 24 hours) **and** every isolated worktree it used has reached `removed`. An empty (or absent) `worktrees/` directory is unprotected either way: normal finalization of an unchanged worktree removes only that agent's own checkout, not the parent `worktrees/` directory, so the directory commonly survives on disk after every worktree it held is `removed`.

Never deleted:

- active runs;
- runs leased by an open session. Each open manager writes a durable process-backed lease for the run IDs it holds, and retention reads leases from every session before deleting, so a terminal run held by another open session stays resumable;
- any run with an `active`, `preserved`, or `orphaned` worktree, including an unfinalized checkout with no isolation record at all.

Worktree scan failures, unrecognized entries, and ambiguous agent directory names fail closed and are reported rather than treated as an empty directory.
