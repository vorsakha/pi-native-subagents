# Pi Native Subagents

Delegate work from Pi to background coding agents — running on Pi, Claude Code, or Codex — and orchestrate them with sandboxed, replayable workflows.

- **Direct subagents** for one job or a small fan-out, with live cards and a `/subagents` supervision dashboard.
- **Workflows** for phases, bounded parallelism, budgets, approvals, and durable replay.
- **Capability routing** that discovers each harness's real tools, skills, and MCP servers without spending a model turn.

Every child runs under an explicit access policy inside a trusted project, and cannot delegate further.

## Install

Requires Node.js 22.19.0 or newer. Pi extensions execute with your user permissions, so review the package before installing it.

```bash
npm install
pi install /absolute/path/to/pi-native-subagents
```

## Try it

Ask Pi to delegate, and the model calls `subagent_spawn`:

> Spawn a read-only subagent to review `src/auth.ts` for missing error handling.

Or start one yourself — `/subagent` is human-only and always runs in the background:

```text
/subagent --access readOnly "Review src/auth.ts for missing error handling"
```

Then run `/subagents` to watch it, steer it, or take over its session.

For anything with phases or fan-in, use a workflow:

```js
export const meta = { name: "parallel-review" };

export default async function () {
  phase("review");
  const reviews = await parallel([
    () => agent("Review the API for correctness.", { access: "readOnly" }),
    () => agent("Review the API for security risks.", { access: "readOnly", independent: true }),
  ], { concurrency: 2 });
  return { ok: reviews.every((review) => review.ok), reviews };
}
```

## Commands

```text
/subagent [--harness pi|claude|codex] [--model ID] [--effort LEVEL]
          [--access readOnly|full] [--cwd DIR] [--profile NAME]
          [--max-tokens N] [--max-cost USD] [--max-turns N]
          [--independent] [--independent-of JOB] <task>
/subagents [status|profiles|providers|capabilities|pi|claude|codex]
/subagents-config [pi|claude|codex]
/workflows
```

## Tool reference

`subagent_spawn` (background) and `subagent` (foreground) take a required `task` plus:

| Option | Meaning |
| --- | --- |
| `harness` | `pi` (default), `claude`, `codex`, or `auto` to pick a healthy route. A model never selects a harness. |
| `access` | `readOnly` or `full`. Full access requires a trusted project. |
| `model` | Exact harness-local ID. Omit to use the harness's native default. |
| `effort` | `low`…`max`. Omit to use each provider's adaptive default. |
| `requires` | Live capability IDs from `subagent_capabilities`. Pair with `harness: "auto"`. |
| `independent` | Forces a different native provider from the parent. |
| `independentOf` | Forces a different provider from an existing producer job. |
| `profile` | Applied only when named explicitly; may impose access/harness ceilings. |
| `maxTokens`, `maxCost`, `maxTurns` | Optional cumulative spend boundaries. Omit them for an open spend budget. Reached limits block retained follow-ups after active work finishes. |

Manage running jobs with `subagent_wait`, `subagent_check`, `subagent_send`, `subagent_cancel`, and `subagent_list`. Completed ordinary jobs keep their native session for follow-ups, bounded at 100 retained jobs.

`workflow` takes exactly one source — inline `script`, saved `workflowName`, or a trusted project-local `scriptPath`. Inside a workflow the globals are `args`, `phase()`, `log()`, `agent()`, `followUp()`, `parallel()`, and `pipeline()`. `followUp(jobId, prompt)` continues a completed `agent()` call's own retained session, for example returning to an earlier planner for review. Await every `agent()`/`followUp()` call before returning.

Workflow spend budgets are also optional. Explicit token, cost, turn, and per-agent token limits stop later dispatches once observed usage reaches the boundary; they do not cancel active agents or change successful child results. A completed workflow reports its task outcome separately: `{ ok: true }` is successful, `{ ok: false }` is unsuccessful, and other results are unspecified.

`subagent_capabilities` lists each harness's native tools, skills, commands, plugins, MCP servers, and hooks, filtered by `query`, `harness`, `kind`, `effect`, and `access`.

Other surfaces: `session_peer_list` / `session_peer_fork` fork a read-only, tool-less peer from a saved session; `parent_thread_context` lets a human-started child pull a bounded snapshot of the parent thread.

Usage guidance for agents lives in [`skills/pi-native-subagents/SKILL.md`](skills/pi-native-subagents/SKILL.md).

## Security model

Execution requires a trusted project, and child working directories must stay inside it.

- Read-only children are sandboxed by construction: Pi gets `read`/`grep`/`find`/`ls`, Claude a read/web allowlist, Codex `approvalPolicy: never` plus a read-only sandbox.
- Children can never delegate, answer interactive approvals, escalate permissions, or administer plugins and MCP.
- Native routes sanitize API keys, OAuth overrides, custom endpoints, and billing selectors. Claude requires a `claude.ai` subscription; Codex requires a ChatGPT account; Pi inherits Pi's provider configuration.
- Workflow code runs in a separate 128 MiB, permission-restricted Node process with no imports, filesystem, network, environment, subprocess, or credential access.
- Transcripts, artifacts, credentials, and machine-local runtime state stay private and out of Git.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Architecture

| Path | Responsibility |
| --- | --- |
| `extensions/subagents/` | Direct tools, trust/cwd gate, delivery, cards, dashboard, takeover |
| `extensions/workflows/` | Workflow rendering and supervision |
| `src/manager.ts`, `src/types.ts`, `src/reducer.ts` | Lifecycle contracts, scheduling, bounded state |
| `src/backends/` | Native Pi, Claude, and Codex adapters |
| `src/workflows/` | Sandboxed orchestration, journals, artifacts |
| `src/profiles.ts`, `src/policy.ts` | Profile resolution and harness policy |
| `src/env.ts`, `src/process-tree.ts` | Subscription-auth sanitation and cleanup |

## Contributing

```bash
npm run check     # typecheck + tests + pack check
```

Keep changes focused and explain the motivation in the pull request. `npm run smoke` and `npm run smoke:{pi,claude,codex}` verify authentication; `npm run smoke:access:{claude,codex}` verify access policy. These do not spend model turns unless you set `PI_NATIVE_SUBAGENTS_LIVE=1`.

This project is experimental — please avoid claiming compatibility that has not been tested. Contributor conventions are in [AGENTS.md](AGENTS.md).

## License

MIT.
