# Pi Native Subagents

Standalone Pi package for generic task-driven subagents and sandboxed multi-agent workflows across Pi, Claude Code, and Codex.

## Features

- Native Pi, Claude, and Codex adapters with normalized lifecycle events and a shared four-job scheduler.
- Background `subagent_spawn`, `subagent_wait`, `subagent_check`, `subagent_send`, `subagent_cancel`, and `subagent_list` tools, plus foreground `subagent`.
- Live, model-free `subagent_capabilities` discovery with access-aware requirements and automatic healthy-route selection.
- Retained native sessions, follow-ups, one-shot background-result delivery, `/subagents` supervision, bounded cards, and forked read-only Pi session peers.
- Pull-based `parent_thread_context` for human `/subagent` jobs; model-spawned children never receive parent-thread content.
- Sandboxed `workflow` orchestration with phases, pipelines, bounded parallelism, schemas, approvals, budgets, replay, private artifacts, background execution, and `/workflows` supervision.
- Native customization within the access ceiling, abortable startup, bounded shutdown, and process-tree cleanup.

Every child gets a self-contained task with its paths, facts, constraints, access level, expected result, and verification requirements.

## Direct subagents

`subagent_spawn` and `subagent` accept:

- required `task`;
- optional `name`, `cwd`, `harness`, `requires`, `model`, `effort`, `access`, `independent`, `independentOf`, and `profile`.

Defaults and routing:

- `harness` defaults to Pi and `model` defaults to the selected harness's native model. A model never selects a harness.
- `access` is `readOnly` or `full`; full access requires a trusted project. Use read-only for inspection and review.
- `effort` is optional (`low`, `medium`, `high`, `xhigh`, or `max`); Claude and Codex use their adaptive defaults when omitted.
- `independent: true` requires a different native provider from the parent (Codex/Pi → Claude, Claude → Codex). It does not mean a different model on the same provider.
- `independentOf: <jobId>` requires a provider different from an existing native Claude/Codex producer job; unknown, evicted, Pi-backed, or same-provider targets fail closed. An unknown parent provider with `independent: true` falls back to Claude.
- `profile` is applied only when explicitly requested. A profile may impose access, harness, or independence ceilings.

Completed ordinary jobs retain their native session for follow-ups, bounded by 100 retained jobs. Failed, cancelled, evicted, and workflow-owned sessions are not reusable. Direct jobs get priority when a scheduler slot opens.

### Forked session peers

`session_peer_list` finds a bounded set of saved sessions, excluding the current thread. `session_peer_fork` accepts one returned ID, copies the source context without mutating it, and registers a read-only, tool-less Pi job whose `jobId` works with the normal send/wait/check/cancel tools. The peer can answer clarifying questions from retained context but cannot access files, delegate, or perform external actions. Arbitrary paths are rejected and the feature is disabled in untrusted projects.

## Capability-aware routing

`subagent_capabilities` and `/subagents capabilities [refresh]` expose each harness's native tools, skills, commands, plugins, MCP servers, and hooks. Filters include `query`, `harness`, `kind`, `effect`, `access`, `includeUnavailable`, `limit`, and `refresh`.

Discovery does not spend a model turn. It uses each harness's introspection surface, caches results for 60 seconds, invalidates on metadata-only config/skill changes, and treats missing, timed-out, or failed discovery as an empty catalog with a warning. `refresh: true` bypasses the cache.

`requires` accepts live capability IDs, `kind:name`, or a bare native name. `harness: "auto"` selects the preferred healthy/authenticated harness that satisfies all requirements, or a healthy/authenticated route when none are supplied, and can fail over after live revalidation. Explicit harnesses fail closed when requirements are unavailable. Requests without `requires` or `harness: "auto"` do not pay the discovery cost.

Nested delegation, administration, and interactive-prompt capabilities are denied and cannot be required. Read-only children additionally reject unclassified or mutating capabilities. Disabled, degraded, unauthenticated, and untrusted integrations remain visible in discovery. The winning route records its harness, matched capabilities, revision, discovery time, and whether it was automatic.

## Native customization

Children use native customization by default, bounded by access and harness support:

- Pi loads native skills/templates; installed extensions, plugins, and MCP surfaces are available only to full-access children.
- Claude loads native context and skills; read-only jobs use a fixed read/web allowlist, disable hooks, and isolate MCP.
- Codex keeps its native skills; read-only/isolated jobs disable MCP and hooks.

Optional integration failures produce a degraded warning and retry without the failed integration unless it was required. Older harnesses may expose less introspection; the package reports that limitation instead of inventing capabilities. Tool-less Pi session peers use the fully isolated launch.

## Profiles

Profiles are optional and selected only by explicit name. Global profiles load from `~/.pi/agent/subagents/*.md`; trusted projects may override them from `<cwd>/.pi/subagents/*.md`. `/subagents profiles` lists resolved names, origins, paths, and validation warnings.

Supported frontmatter: `name`, `description`, `access`, `harness`, `effort`, `independent`, and optional `locked_harness`. The body becomes additional system guidance. A profile's read-only access is a ceiling, and locked-harness or independence contradictions fail before dispatch.

## Security and isolation

- Execution requires a trusted project; child `cwd` values must remain inside it.
- Read-only Pi children receive `read`, `grep`, `find`, and `ls`; Claude uses a read/web allowlist and denylist; Codex uses `approvalPolicy: never` and a read-only sandbox.
- Full-access Claude/Codex policies are enabled only after trust succeeds. Children cannot delegate, answer interactive approvals, or register this package's orchestration surface again.
- Native Claude/Codex routes sanitize API keys, OAuth overrides, custom endpoints, cloud selectors, and billing selectors. Claude requires a `claude.ai` subscription; Codex requires a ChatGPT account. Pi inherits Pi's provider configuration.
- Workflow code runs in a separate 128 MiB, permission-restricted Node process with authenticated bounded IPC and no imports, filesystem, network, environment, subprocess, or credential access.
- Workflow caps are 512 KiB source, 256 KiB arguments, 1 MiB result, 32 agent calls, 128 phase events, 64 retained phases, and four-way `parallel()` concurrency. Workflows and native turns have no overall wall-clock deadline; native harnesses use a 15-minute inactivity watchdog plus bounded protocol/cancellation/shutdown timeouts.
- Transcripts, workflow artifacts, credentials, auth files, and machine-local runtime state stay private and out of Git.

## Workflows

Use `workflow` for phases, durable progress, pipelines, structured fan-in, saved definitions, background runs, replay, or more than a small direct fan-out. Provide exactly one source: inline `script`, saved `workflowName`, or trusted project-local `scriptPath`; saved definitions load from `~/.pi/agent/workflow-definitions` or trusted-project `.pi/workflows`, with project precedence. Use structured `input` or legacy JSON-string `args`, never both.

Helpers are globals in the default async function:

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

Available globals are `args`, `phase(title)`, `log(message)`, `agent(prompt, options)`, `parallel(tasks, { concurrency })`, and `pipeline(items, ...stages)`. `parallel` requires deferred task functions and is the barrier form; `pipeline` advances independent items without a global stage barrier. Await every agent call before returning. `agent()` returns `{ ok, output, structured?, jobId?, error?, usage? }`; options add the direct-job fields plus `phase` and bounded JSON `schema`.

Workflows are deterministic and JSON-bounded: no imports, `require`, `process`, time, randomness, filesystem, network, or nested delegation. `background: true` returns a start snapshot and delivers one inspectable completion. `resumeFromRunId` replays a prefix only when source, input, project, approval, and default routing match, then reruns the first incomplete call; only permitted monotonic budget increases are accepted. Replay retains route/provenance and adds no usage for replayed calls. `approval: "auto"` follows trusted-project policy, `plan` rejects mutations, and `onMutate` requires one host confirmation. Budgets bound calls, concurrency, tokens, aggregate native-provider turns, and cost; overruns cancel active members. Shared-checkout mutations serialize, while `isolation: "worktree"` requires a clean source and preserves explicit patch metadata.

Each run keeps a private append-only journal with call fingerprints, lifecycle, routes, results, errors, replacement provenance, and usage. Journals flush before calls return; partial crash tails are ignored. `meta` is published before the workflow settles, logs are bounded and retained in artifacts/cards, and instruction-shaped child output is marked untrusted. `/workflows` supports inspection, `p` pause/resume at the next dispatch boundary, and `r` restart of a selected agent by replaying its prefix. Checkpoints, transcripts, reports, and results remain under `~/.pi/agent/workflows/`; restored running checkpoints become aborted and can be resumed.

## Commands

```text
/subagents [status|profiles|capabilities|pi|claude|codex]
/subagents-config [pi|claude|codex]
/subagent [--harness pi|claude|codex] [--model ID] [--effort LEVEL] [--access readOnly|full] [--cwd DIR] [--profile NAME] [--independent] [--independent-of JOB] <task>
/workflows
```

`/subagent` is human-only and runs in the background. It does not inject parent messages automatically; the child may call `parent_thread_context` to search a bounded spawn-time snapshot that excludes thinking, tool calls/results, system/developer prompts, and extension-only state. Full-access human Pi jobs inherit permitted parent tools; read-only jobs keep the fixed read set. Delegation, administration, and interactive-prompt tools remain denied.

## Installation and development

Requires Node.js 22.19.0 or newer. Pi extensions execute with user permissions, so review the package first.

```bash
npm install
pi install /absolute/path/to/pi-native-subagents
npm run typecheck
npm test
npm run pack:check
```

Use `npm run smoke` or `npm run smoke:{pi,claude,codex}` for authentication checks, and `npm run smoke:access:{claude,codex}` for access checks. Set `PI_NATIVE_SUBAGENTS_LIVE=1` to invoke models; otherwise the smoke commands do not spend model turns. The default harness can also be set with `/subagents-config` or `PI_NATIVE_SUBAGENTS_HARNESS`.

## Architecture

- `extensions/subagents/` — direct tools, trust/cwd gate, delivery, cards, dashboard, and takeover.
- `src/manager.ts`, `src/types.ts`, `src/reducer.ts` — lifecycle contracts, scheduling, and bounded state.
- `src/profiles.ts`, `src/policy.ts` — profile resolution and harness policy.
- `src/backends/` — native Pi, Claude, and Codex adapters.
- `src/workflows/`, `extensions/workflows/` — sandboxed orchestration, artifacts, rendering, and supervision.
- `src/env.ts`, `src/process-tree.ts` — subscription-auth sanitation and cleanup.

## License

MIT.
