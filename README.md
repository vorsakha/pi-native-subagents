# Pi Native Subagents

Standalone Pi package for generic task-driven Pi, Claude Code, and Codex subagents plus sandboxed multi-agent workflows.

## What it provides

- Normalized native harness adapters and events plus a session-scoped `JobManager` with a hard four-job concurrency cap.
- Background `subagent_spawn`, `subagent_wait`, `subagent_check`, `subagent_send`, `subagent_cancel`, and `subagent_list` tools.
- A foreground `subagent` convenience tool using the same generic request contract.
- Live, model-free `subagent_capabilities` discovery of each harness's real native tools, skills, commands, plugins, MCP servers, and hooks, with the access ceiling already applied; `requires` and `harness: "auto"` route to a harness proven to actually have a capability, live-revalidated right before dispatch.
- Native customization parity by default inside the access ceiling: children load harness-native context and skills; full-access routes may use installed extension/plugin/MCP surfaces, while read-only routes keep those executable integrations isolated unless the adapter can prove them read-safe.
- Native session steering and retained-session follow-ups, plus one-shot delivery of unconsumed background results.
- Forked Pi session peers: discover a saved thread, fork it immutably, ask it clarifying questions, and continue through the same managed send/wait lifecycle.
- Bounded conversation cards, `/subagents` supervision, and normalized user/assistant/thinking/tool/queued-message state.
- Sandboxed `workflow` orchestration with phases, sequential or bounded-parallel `agent()` calls, structured schemas, foreground/background execution, private artifacts, and `/workflows` inspection.
- Pi persistent JSONL RPC, Claude Code through the official Agent SDK and installed CLI, and Codex through the installed app-server.
- Abortable startup, bounded shutdown, and process-tree cleanup.

Behavior comes from the task plus a short isolation baseline. Give every child a complete task containing the relevant paths, requirements, constraints, and verification expectations.

## Generic request contract

### Forked session peers

`session_peer_list` returns a bounded, optionally filtered set of saved Pi sessions, excluding the current thread. `session_peer_fork` accepts one exact session ID from that list plus an initial clarification question. It copies the source thread's active context into a new persisted session under the current trusted project; the source file is never mutated.

The fork is registered as a Pi-backed managed job. Its returned `jobId` works with `subagent_send`, `subagent_wait`, `subagent_check`, and `subagent_cancel`, enabling a real multi-turn exchange rather than one-time context injection. Session peers are intentionally read-only and tool-less: they can reason from retained conversation context but cannot read or modify either project's files, delegate, or perform external actions. Arbitrary session paths are never accepted, and the feature is denied in untrusted projects.

### Generic request contract

`subagent_spawn` and foreground `subagent` accept:

- required `task`;
- optional `name`, `cwd`, `harness`, `requires`, exact harness-local `model`, `effort`, `access`, `independent`, `independentOf`, and `profile`.

`access` is `readOnly` or `full` and defaults to `full` only after Pi's project-trust gate succeeds. The configured harness defaults to Pi, which delegates through the user's existing Pi provider and model configuration. Native Codex and Claude execution remain equal explicit choices through `harness`. `model` never selects or changes a harness; it is forwarded only to the chosen harness. Omitting it uses that harness's configured default. Claude and Codex also omit effort by default so provider behavior remains adaptive; callers may set `low`, `medium`, `high`, `xhigh`, or `max`.

The extension contains no concrete model names or model recommendation table. The separately installed, easy-to-edit `subagents` skill owns current cost/capability guidance and supplies exact models when useful. Runtime code remains responsible for trust, access, provider diversity, subscription authentication, sandboxing, and lifecycle constraints.

`independent: true` forces a different native provider from the parent: OpenAI/GPT/Codex parent → Claude, Claude parent → Codex. `independentOf: <jobId>` instead forces a different provider from the referenced session-scoped producer job, so delegated implementation and review cannot silently land on the same provider. The target must be an existing native Claude or Codex job; unknown, evicted, or Pi-backed targets fail closed. Explicit Pi or same-provider routes are rejected. For an unknown parent provider, `independent: true` falls back to Claude.

### Capability-aware routing

`subagent_capabilities` returns a live, per-harness inventory of native tools, skills, commands, plugins, MCP servers, and hooks, filtered by the same access ceiling a real child would get (`query`, `harness`, `kind`, `effect`, `access`, `includeUnavailable`, `limit`, `refresh`). `/subagents capabilities [refresh]` reports the same inventory as text. Discovery never sends a model turn: it reads a harness's own initialization/introspection surface (Claude Agent SDK `initializationResult`, a conservative core-tool inventory, live skill/plugin reload inventories, and `mcpServerStatus`; Codex app-server `skills/list`/`plugin/installed`/`hooks/list`/`mcpServerStatus/list`; Pi's live parent tool/command inventory plus a tool-less child's `get_commands`). Results are cached per harness/cwd/access/customization for 60 seconds and invalidated early by a metadata-only (`stat`, never content) fingerprint of each harness's config and skill directories; `refresh: true` always bypasses the cache. A harness whose adapter has no `discover()`, or whose discovery call errors or times out (20s), reports an empty catalog with `unknown`/`unavailable` health and a warning instead of failing the caller.

`requires` on `subagent_spawn`/`subagent`/workflow `agent()` names capability IDs (from `subagent_capabilities`, or `kind:name`, or a bare native name) the child must really have. Pairing `requires` with `harness: "auto"` picks the first harness, in configured-default-first preference order, whose live catalog actually satisfies every requirement; an explicit `harness` with `requires` instead fails closed if that harness cannot satisfy them. Either way the winning route is revalidated with a fresh, uncached discovery immediately before dispatch, so the capability route recorded on the job (`capabilities: { harness, matched, revision, discoveredAt, auto }`) reflects an inventory observed after the caller's last chance to change it, not a stale browse. A request with neither `requires` nor `harness: "auto"` is unaffected and never pays for discovery. Nested orchestration (agent/task/subagent/workflow/session-peer/delegation-shaped capabilities) and harness/plugin/MCP administration and interactive-prompt surfaces are denied on every harness and access mode and can never be required or routed to; read-only children are additionally restricted to non-mutating, classified-effect capabilities, so an unclassified (`unknown`-effect) native surface fails closed read-only even though it is visible in discovery.

### Native customization parity

Children default to `customization: "native"`, but parity is bounded by access. Pi loads native skills/templates in both modes and extensions only for full access; a required full-access Pi extension tool is added to the child's explicit tool allowlist. Claude loads user/project/local context and skills in both modes, while read-only keeps its fixed read/web tool allowlist, disables hooks, and uses strict MCP isolation. Codex retains its native skill surface but starts read-only/isolated threads with MCP and hooks disabled. Full-access native routes may use installed plugin/MCP surfaces, subject to the fixed orchestration and interactivity ceiling. Only tool-less Pi session peers use the historical fully `isolated` launch. Native parity is best-effort and harness-version-dependent: introspection methods that an older CLI does not expose degrade to a warning instead of a false inventory, and a Codex thread whose optional MCP/plugin/hook integration fails to start emits a `degraded` job warning and retries with those integrations disabled unless the failed integration was itself required. Degraded or unauthenticated MCP servers, disabled plugins, and untrusted hooks remain visible in discovery rather than being hidden.

## Optional profiles

Profiles are optional human-authored policy and instruction overlays selected only by explicit name. Model guidance says to omit `profile` unless the human explicitly requests one.

Global profiles load from `getAgentDir()/subagents/*.md` (normally `~/.pi/agent/subagents/`). Trusted-project profiles load from `<cwd>/.pi/subagents/*.md` and override global profiles by name. `/subagents profiles` lists resolved names, origins, paths, and validation warnings.

```markdown
---
name: security-audit
description: Read-only security review policy
access: readOnly
harness: claude
effort: high
independent: true
---
Focus on concrete security boundaries and evidence. Do not suggest unrelated changes.
```

Supported fields are `name`, `description`, `access`, `harness`, `effort`, `independent`, and optional `locked_harness`. The body is appended to the durable system instructions. A profile's `readOnly` access is a ceiling and cannot be elevated per call. Locked-harness and independence contradictions fail before dispatch.

## Security model

Subagents are denied unless Pi reports the project as trusted. Requested child working directories must exist inside that trusted project tree.

Read-only execution is deny-by-construction:

- Pi receives only `read`, `grep`, `find`, and `ls`.
- Claude receives a read/web allowlist, an explicit mutating-tool denylist, and `dontAsk` mode.
- Codex receives `approvalPolicy: never` and a `readOnly` sandbox.

Full-access Claude uses `bypassPermissions`, and full-access Codex uses `dangerFullAccess`, only after trust succeeds. Generic children cannot delegate, in every access mode and independent of native parity: Claude denies the Agent/Workflow/Task*/AskUserQuestion/EnterPlanMode/ExitPlanMode tools and this is asserted at startup as a fail-closed check, Codex never answers an interactive server request, and Pi children are launched with an internal marker so this package refuses to register its own subagent/workflow surface a second time inside a Pi child — there is no nested subagent stack. The same denial ceiling applies to capability discovery and `requires`: any capability whose kind or name resembles nested orchestration, harness/plugin/MCP administration, or an interactive prompt is reported as denied and can never be routed to, regardless of access mode.

Native Claude and Codex children do not inherit API keys, OAuth-token overrides, custom endpoints, cloud provider selectors, or provider billing selectors that could silently change subscription authentication mode. Claude must report a logged-in `claude.ai` subscription. Codex pins the built-in OpenAI provider and requires a ChatGPT account. Pi children inherit the parent environment and use Pi's own provider/auth configuration, preserving provider neutrality for the default route. The package does not inspect, log, or package credentials.

Workflow JavaScript runs in a separate permission-restricted Node process with 128 MiB memory, authenticated size-bounded IPC, no inherited environment, imports, filesystem, network, subprocess, or credential access. Every `agent()` request still crosses the trust gate, generic policy compiler, shared scheduler, and harness sandbox. Limits remain 512 KiB source, 256 KiB args, 1 MiB result, 32 agent calls, 128 phase events/64 retained phases, and four-way `parallel()` concurrency. Workflows and native turns have no overall wall-clock deadline. Each native harness instead uses a 15-minute inactivity watchdog that resets on provider activity; protocol requests, cancellation, and process shutdown remain separately bounded.

## Configuration and supervision

```text
/subagents
/subagents status
/subagents profiles
/subagents capabilities [refresh]
/subagents codex
/subagents claude
/subagents pi
/subagents-config codex
/subagent [--harness pi|claude|codex] [--model ID] [--name NAME] <task>
/workflows
```

`/subagent` is a human-only background spawn command. It does not inject a
message into the orchestrator's context. The job appears as one TUI-only card
that settles in place from queued/running state to its terminal result, while
`/subagents` remains the live dashboard for inspection, cancellation, steering,
and follow-ups.
Omitting `--harness` and `--model` uses the configured default harness and its
native model default. A full-access human Pi job automatically receives every
loaded parent Pi tool permitted by the hard safety ceiling, including configured
MCP and extension gateways; nested delegation, administration, and interactive
prompt surfaces remain denied. Read-only jobs keep the fixed core read tool set.
Additional policy flags include `--effort`, `--access`, `--cwd`, `--profile`,
`--independent`, and `--independent-of`.

The default Pi harness applies to both direct tools and workflow `agent()` calls and can be changed with `/subagents-config` or `PI_NATIVE_SUBAGENTS_HARNESS`. Exact model selection stays request-scoped; `/subagents status` reports that models are caller-selected or native-default. Successfully completed ordinary jobs retain their native session for the parent Pi session, bounded by the 100-job capacity; follow-up sends reopen the same job/session. At capacity, the oldest terminal jobs and their native sessions are evicted before new spawns. Failed, cancelled, evicted, and workflow-owned sessions are not reusable.

Workflow scripts compose task-driven agents directly:

```js
export default async function () {
  phase("Investigate");
  log("Inspecting architecture and implementation risks");
  const findings = await pipeline(
    ["architecture", "risks"],
    (lens) => agent(`Inspect the ${lens}`, { name: `inspect:${lens}`, access: "readOnly" }),
    (inspection, lens) => agent(`Verify the ${lens} findings:\n${inspection.output}`, {
      name: `verify:${lens}`,
      access: "readOnly",
      independentOf: inspection.jobId,
    }),
  );

  phase("Implement");
  return agent(JSON.stringify(findings), { name: "implementation", access: "full" });
}
```

`agent(prompt, options?)` resolves to `{ ok, output, structured?, jobId?, error?, usage? }`. Options support `name`/`label`, `access`, `harness` (an explicit route or `"auto"`), `requires`, exact harness-local `model`, `effort`, `independent`, `independentOf`, `profile`, `phase`, and bounded JSON `schema`. `requires` and `harness: "auto"` resolve and live-revalidate a capability route the same way as the direct tools; a call with neither is unaffected. A sequential workflow can pass an implementation result's `jobId` as the reviewer's `independentOf`. `pipeline(items, ...stages)` advances each item through its stages without waiting for unrelated items; failed stage functions drop only that item to `null`. `parallel()` remains the explicit barrier and accepts task functions with concurrency 1–4. Read-only agents can use all four shared slots; mutating workflow agents targeting the same checkout are serialized unless they request `isolation: "worktree"`. Worktree isolation requires a clean Git source checkout, creates a private per-agent branch/worktree, automatically removes unchanged work, and preserves changed work with branch plus patch metadata for explicit integration. `log(message)` emits bounded progress retained in artifacts and workflow cards. Exported `meta` name/description is published before the default workflow function settles. The shared manager remains the authoritative global scheduler and gives queued direct work the next available slot ahead of workflow fan-out.

The workflow tool accepts structured JSON through `input`. Its legacy `args` field remains available for callers that already pass a JSON-encoded string; callers must not provide both. Provide exactly one source: inline `script`, a saved `workflowName`, or a trusted project-local `scriptPath`. Saved definitions load from user `~/.pi/agent/workflow-definitions` and project `.pi/workflows`, with trusted-project precedence. `resumeFromRunId` starts a new auditable run, replays the source run's contiguous prefix of successfully completed calls, and reruns the first incomplete call plus its suffix. Replay is accepted only when the script, input, project cwd, approval, budget, and default routing context match exactly. Replayed calls retain their original result and route but add no usage to the new run.

Workflow approval is host-enforced: `auto` uses trusted-project policy, `plan` rejects mutating agents, and `onMutate` requires one Pi UI confirmation before the run's first mutation and fails closed without an interactive host. Optional budgets bound agent calls, per-workflow concurrency, combined input/output tokens, turns, and cost. Token/turn/cost overruns abort the workflow and cancel active members; generous allowances are surfaced as advisory warnings.

Each run keeps a private, append-only `journal.jsonl` with call ordinals, canonical prompt/options fingerprints, lifecycle transitions, results, routes, and usage. Journal appends are flushed before a call returns to the sandbox; a partial crash tail is ignored during recovery. `Date.now()`, zero-argument `new Date()`, and `Math.random()` are unavailable in workflow scripts so replay does not silently depend on local time or randomness. `/workflows` uses `p` to pause/resume at the next agent-dispatch boundary and `r` to restart the selected agent by replaying its prefix into a new run. Already-running provider turns finish while paused. Child-model and replay output provenance is retained, and instruction-shaped output is visibly flagged as untrusted data.

Workflow scripts, journals, checkpoints, results, bounded transcripts, and reports are private under `~/.pi/agent/workflows/`, never the project. Restored running checkpoints become `aborted` and may then be resumed through their journal.

## Installation and development

Requires Node.js 22.19.0 or newer. Pi extensions execute with user permissions, so review the package first.

```bash
npm install
pi install /absolute/path/to/pi-native-subagents
npm run typecheck
npm test
npm run pack:check
```

The suite uses broad, risk-based tests around the package's security and lifecycle contracts. Opt-in authentication smoke commands are `npm run smoke`, `npm run smoke:{pi,claude,codex}`, and `npm run smoke:access:{claude,codex}`; set `PI_NATIVE_SUBAGENTS_LIVE=1` to invoke models.

## Architecture

- `extensions/subagents/` — direct tools, trust/cwd gate, delivery, cards, dashboard, and takeover.
- `src/manager.ts`, `src/types.ts`, `src/reducer.ts` — generic lifecycle contracts and bounded state.
- `src/profiles.ts`, `src/policy.ts` — explicit profile loading and composable harness policy.
- `src/backends/` — native Pi, Claude, and Codex adapters.
- `src/workflows/`, `extensions/workflows/` — sandboxed orchestration, private artifacts, rendering, and supervision.
- `src/env.ts`, `src/process-tree.ts` — subscription-auth sanitation and bounded cleanup.

## License

MIT.
