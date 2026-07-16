# Pi Native Subagents

Standalone Pi package for native Pi, Claude Code, and Codex subagents plus sandboxed multi-agent workflows.

## What it provides

- Normalized `Backend` / `BackendEvent` API.
- Session-scoped `JobManager` with a hard concurrency cap of four.
- Background `subagent_spawn`, `subagent_wait`, `subagent_check`, `subagent_send`, `subagent_cancel`, and `subagent_list` tools.
- Compatibility foreground `subagent` tool plus native steering/follow-up control.
- Slowly pulsing active-job dots in conversation thread cards, `/subagents`, and takeover, with live status, cancellation, steering, queued follow-ups, and normalized user/assistant/thinking/tool state.
- Sandboxed `workflow` orchestration with phases, sequential and bounded-parallel role-based agents, structured schemas, usage budgets, foreground/background execution, durable artifacts, automatic background result delivery, and `/workflows` inspection.
- Unconsumed ordinary background results are delivered once as bounded parent follow-ups; `subagent_wait`, foreground runs, and workflow-owned jobs consume or suppress duplicate delivery.
- Bounded in-memory subagent state. Workflow scripts, checkpoints, results, normalized transcripts, and generated reports are stored privately under `~/.pi/agent/workflows/`, never in the project tree.
- Process-group teardown with TERM/KILL escalation.
- Markdown role loader, backend routing, model tiers, nested-agent allowlists, and policy compiler.
- Native backends:
  - Pi persistent JSONL RPC subprocess.
  - Claude Code through the official Agent SDK and installed `claude` CLI.
  - Codex through the installed `codex app-server` JSON-RPC protocol.
- Abortable backend startup plus hard lifecycle deadlines and bounded process-tree shutdown, so cancellation cannot leave delayed starts or unsettled top-level awaits.

## Security model

Subagents are denied unless Pi reports the current project as trusted. Requested child working directories must exist inside that trusted project tree.

`worker` jobs receive autonomous full access with no per-command prompts. Read-only roles are deny-by-construction:

- Pi receives only `read`, `grep`, `find`, and `ls` where configured.
- Claude receives an exact read/web tool allowlist, explicit mutating-tool denylist, and `dontAsk` mode.
- Codex receives `approvalPolicy: never` and a `readOnly` sandbox.

Full-access Claude uses `bypassPermissions` only after Pi trust has been established. Full-access Codex uses `dangerFullAccess` only under the same trust gate.

Claude children do not inherit Anthropic endpoint/header overrides, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, cloud-provider credential selectors, API keys, or OAuth-token overrides that can take precedence over claude.ai login. Generic process variables such as `PATH`, `HOME`, locale, and terminal settings remain available. Before starting the Agent SDK, the backend requires `claude auth status` to report a logged-in `claude.ai` subscription; current native CLI builds may then report the init-frame key source as `none` because OAuth is not an API key. Codex children and Pi children routed through `openai-codex` do not inherit credential-shaped variables (including unknown/custom `*_API_KEY`, `*_AUTH_TOKEN`, and `*_ACCESS_TOKEN`) or OpenAI, Codex, Azure OpenAI, and model-provider billing selectors. Native Codex pins `thread/start.modelProvider` to the built-in `openai` provider and rejects `account/read` unless the installed CLI reports a `chatgpt` account. Credential files and token values are never read, copied, logged, or packaged.

Nested delegation is capped at depth two. The worker may delegate only to `scout` and `researcher`; the allowlist is carried in child environment metadata. A Pi child is approved only because its parent already passed Pi's project-trust gate, and it loads only this package extension rather than unrelated global extensions. Native Claude/Codex agents do not receive this package's subagent tool, so nested package delegation is available only through Pi.

Workflow JavaScript runs in a separate Node process with the permission model enabled, 128 MiB memory, a hard deadline, authenticated and size-bounded IPC, no inherited environment, no imports, and no filesystem/network/subprocess access. The sandbox can only announce phases, request role-based agents, and return JSON. Every requested agent still passes through the same trusted-project gate, `JobManager`, global four-job cap, role policy compiler, and backend sandbox. Limits are 256 KiB source, 128 KiB args, 1 MiB result, 32 agent calls, 128 phase events/64 retained unique phases, and four-way `parallel()` concurrency.

## Roles and defaults

| Role | Default backend | Access | Route |
| --- | --- | --- | --- |
| `scout` | Codex | read-only | Luna / low |
| `researcher` | Claude | read/web-only | Sonnet / medium |
| `worker` | Codex | full | Terra / medium |
| `reviewer` | Codex | read-only | Sol / medium |
| `brainstormer` | Codex | read-only | Sol / medium (Claude Sonnet/high available) |
| `claudio` | Claude (locked) | read/web-only | Sonnet / medium |
| `adversary` | Claude (locked) | read-only | Opus / high |

`adversary` intentionally maps directly to the native Claude backend instead of preserving the old Codex-wrapper-plus-special-review-tool implementation. `image-composer` is intentionally omitted because its old controlled image-generation tool is outside this package. These are the two compatibility exceptions required to avoid depending on unimplemented tools from the local extension.

Codex tier overrides preserve the previous routing vocabulary:

- `economy` → `gpt-5.6-luna`, low
- `balanced` → `gpt-5.6-terra`, medium
- `quality` → `gpt-5.6-sol`, high

Role prompts live in `agents/*.md` and contain backend-specific model/tool frontmatter. Roles known to be reviewers/scouts are forced read-only even if frontmatter is accidentally loosened.

## Installation

Review the package first; Pi extensions execute with user permissions.

Requires Node.js 22.19.0 or newer.

```bash
npm install
pi install /absolute/path/to/pi-native-subagents
```

This repository does not install itself. The package manifest exposes `extensions/subagents/index.ts` through the Pi package system.

### Migrating from the legacy extension

Do not load this package alongside the old `~/.pi/agent/extensions/subagents` tree. Before installing, move or remove that legacy tree (preserve a backup outside Pi's extension search path), then install this package and restart Pi. If both copies are loaded, the extension now fails immediately with a duplicate-install error naming both roots rather than registering duplicate tools and managers. Likewise, if two Pi package entries point at this repository, uninstall one of them and restart. Role files belong to this package after migration; do not keep a second active copy as an override.

Open the interactive dashboard with `/subagents`. Switch the compatibility tool's session default with:

```text
/subagents status
/subagents codex
/subagents claude
/subagents pi
/subagents-config codex
```

The argument-taking `/subagents` forms remain compatible, including legacy `/subagents --use-codex` and `/subagents --use-claude`; `/subagents-config` is the explicit configuration command. During migration, legacy `PI_SUBAGENTS_PROFILE` is accepted when `PI_NATIVE_SUBAGENTS_BACKEND` is unset, and session entries of custom type `subagents-profile` with `{ profile }` are restored. New writes use `native-subagents-profile` with `{ backend }`.

The session backend is a compatibility default for the foreground `subagent` tool only. `subagent_spawn` with no `backend` preserves the selected role's `defaultBackend`; an explicit per-call `backend` overrides it, and `modelTier` forces the native Codex route. Successfully completed ordinary jobs retain their native Pi/Claude/Codex session for 15 minutes: `subagent_send(..., behavior: "followUp")` or takeover input reopens another turn on the same job and native session. Failed, cancelled, expired, evicted, and workflow-owned sessions are not reusable.

## Workflows

The `workflow` tool accepts a name, optional description and JSON args, a sandboxed module script, an optional deadline, and `background`. Scripts export a default async function and may export JSON metadata:

```js
export const meta = { name: "implement-and-review" };

export default async function () {
  phase("Investigate");
  const findings = await parallel([
    () => agent("Inspect the architecture", { role: "scout", label: "architecture" }),
    () => agent("Identify implementation risks", { role: "researcher", label: "risks" }),
  ], { concurrency: 2 });

  phase("Implement");
  const implementation = await agent(JSON.stringify(findings), {
    role: "worker",
    label: "implementation",
  });

  phase("Review");
  return agent(implementation.output, { role: "reviewer", label: "review" });
}
```

`agent()` always resolves to `{ ok, output, structured?, jobId?, error?, usage? }`; scripts branch explicitly on `ok`. Each call requires a role. Optional `backend`, `modelTier`, `label`, `phase`, and bounded JSON `schema` cannot loosen that role's policy. Schema requests instruct the native agent to return JSON and validate it before exposing `structured`. `parallel()` accepts task functions and enforces concurrency 1–4 while the shared `JobManager` remains the authoritative global scheduler.

The workflow tool accepts optional `budget` limits for input tokens, output tokens, turns, and cost. Crossing a reported limit aborts the run and cancels remaining members; parallel work can overshoot by the usage of already-running members.

Foreground runs update one bounded tool card. Background runs return immediately and deliver one follow-up result when settled. `/workflows` opens the persistent run dashboard with normalized agent transcript drill-down; active runs can be cancelled there. Terminal runs generate `report.md` alongside `workflow.json`, `result.json`, and bounded `transcripts.json`. V1 persists inspection artifacts but deliberately does not resume interrupted execution after Pi exits—stale running checkpoints become `aborted`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run pack:check
npm run check
```

The intentionally thin, risk-based suite keeps roughly 55–70 tests. It favors broad invariants over branch/permutation coverage: trust/read-only/subscription auth, shared scheduling, cancellation/process cleanup, protocol framing, normalized transcript bounds, one-shot result delivery, sandbox capability denial, workflow persistence/recovery, and one renderer/dashboard contract per surface. Provider compatibility remains in opt-in live smokes rather than duplicated mock permutations.

### Opt-in live smoke tests

Auth-only checks do not invoke a model:

```bash
npm run smoke
```

Run no-tools, read-only prompts through installed subscription-authenticated CLIs:

```bash
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke:pi
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke:claude
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke:codex
```

Run controlled access proofs for the Claude and Codex native policies:

```bash
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke:access
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke:access:claude
PI_NATIVE_SUBAGENTS_LIVE=1 npm run smoke:access:codex
```

The access proof explicitly asks a read-only reviewer-like run to write and verifies that no file appears. Claude additionally validates the installed CLI's init inventory exposes no mutating tools; Codex additionally executes a direct `command/exec` write attempt under the same installed `{ type: "readOnly", networkAccess: false }` sandbox. It then asks a full worker-like run to create one exact proof file and verifies its contents. Every case gets a separate temporary working directory, every await has a hard deadline, and the entire temporary tree is removed in `finally` even on failure.

The live script verifies Claude `claude.ai` login and Codex ChatGPT login without printing account details or credentials. Pi is pinned to `openai-codex` with API-key environment selectors removed. Basic live prompts run in empty temporary directories and ask only for `SMOKE_OK`.

## Architecture

- `extensions/subagents/index.ts`, `dashboard.ts`, `takeover.ts` — Pi tools, one-shot completion delivery, operational dashboard, normalized interactive transcript, trust/cwd gate, and session lifecycle.
- `src/manager.ts` — queue, concurrency, wait/check/cancel/list, shutdown.
- `src/types.ts`, `src/reducer.ts` — normalized contracts and bounded state machine.
- `src/roles.ts`, `src/policy.ts` — role parsing and backend policy compilation.
- `src/backends/` — Pi RPC, Claude Agent SDK, and Codex app-server adapters.
- `src/jsonrpc.ts`, `src/framing.ts` — protocol peers and strict LF JSONL framing.
- `src/process-tree.ts`, `src/env.ts` — bounded teardown and subscription-auth environment policy.
- `src/workflows/` — workflow domain, shared-manager orchestration, sandbox process, and private atomic artifacts.
- `extensions/workflows/` — `workflow` tool, deferred background delivery, bounded rendering, and `/workflows` dashboard.
- `tests/` — deterministic unit/integration tests with fake backends.

## Known compatibility boundaries

Child-native Pi, Claude, and Codex sessions use each CLI's own private session storage. Ordinary subagents create no parallel logs, transcript files, or project-local runtime state; normalized takeover state remains bounded in memory while native harness session files stay private to their CLIs. Workflows intentionally create private, mode-restricted artifacts under `~/.pi/agent/workflows/`; they contain the submitted script/args, bounded checkpoints/results/transcripts, and generated report, and must not be synchronized as Pi configuration.

Codex app-server is experimental and versioned with the installed CLI. The adapter intentionally uses a small stable protocol surface (`initialize`, `account/read`, `thread/start`, `turn/start`, `turn/interrupt`, and lifecycle notifications) and fails closed on unknown server approval requests. Run the Codex live smoke after CLI upgrades.

Model aliases are installation/account dependent. A missing Luna/Terra/Sol or Claude alias fails the job rather than silently switching billing or backend.

## License

MIT.
