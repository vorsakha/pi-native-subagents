# Pi Native Subagents

Standalone Pi package for generic task-driven Pi, Claude Code, and Codex subagents plus sandboxed multi-agent workflows.

## What it provides

- Normalized native harness adapters and events plus a session-scoped `JobManager` with a hard four-job concurrency cap.
- Background `subagent_spawn`, `subagent_wait`, `subagent_check`, `subagent_send`, `subagent_cancel`, and `subagent_list` tools.
- A foreground `subagent` convenience tool using the same generic request contract.
- Native session steering and retained-session follow-ups, plus one-shot delivery of unconsumed background results.
- Bounded conversation cards, `/subagents` supervision, and normalized user/assistant/thinking/tool/queued-message state.
- Sandboxed `workflow` orchestration with phases, sequential or bounded-parallel `agent()` calls, structured schemas, foreground/background execution, private artifacts, and `/workflows` inspection.
- Pi persistent JSONL RPC, Claude Code through the official Agent SDK and installed CLI, and Codex through the installed app-server.
- Abortable startup, bounded shutdown, and process-tree cleanup.

Behavior comes from the task plus a short isolation baseline. Give every child a complete task containing the relevant paths, requirements, constraints, and verification expectations.

## Generic request contract

`subagent_spawn` and foreground `subagent` accept:

- required `task`;
- optional `name`, `cwd`, `harness`, exact harness-local `model`, `effort`, `access`, `independent`, and `profile`.

`access` is `readOnly` or `full` and defaults to `full` only after Pi's project-trust gate succeeds. The configured harness defaults to Codex. `model` never selects or changes a harness; it is forwarded only to the chosen native harness. Omitting it uses that harness's configured default. Claude and Codex also omit effort by default so provider behavior remains adaptive; callers may set `low`, `medium`, `high`, `xhigh`, or `max`.

The extension contains no concrete model names or model recommendation table. The separately installed, easy-to-edit `subagents` skill owns current cost/capability guidance and supplies exact models when useful. Runtime code remains responsible for trust, access, provider diversity, subscription authentication, sandboxing, and lifecycle constraints.

`independent: true` forces a different native provider from the parent: OpenAI/GPT/Codex parent → Claude, Claude parent → Codex. Explicit Pi or same-provider routes are rejected. For an unknown parent provider, Claude is the native fallback.

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

Full-access Claude uses `bypassPermissions`, and full-access Codex uses `dangerFullAccess`, only after trust succeeds. Generic children cannot delegate: Pi starts with no extensions, Claude never receives the Agent tool, and no child receives this package's subagent/workflow surface.

Subscription-authenticated children do not inherit API keys, OAuth-token overrides, custom endpoints, cloud provider selectors, or provider billing selectors that could silently change authentication mode. Claude must report a logged-in `claude.ai` subscription. Codex pins the built-in OpenAI provider and requires a ChatGPT account. Credentials are never read, copied, logged, or packaged.

Workflow JavaScript runs in a separate permission-restricted Node process with 128 MiB memory, authenticated size-bounded IPC, no inherited environment, imports, filesystem, network, subprocess, or credential access. Every `agent()` request still crosses the trust gate, generic policy compiler, shared scheduler, and harness sandbox. Limits remain 512 KiB source, 256 KiB args, 1 MiB result, 32 agent calls, 128 phase events/64 retained phases, and four-way `parallel()` concurrency. Workflows and native turns have no overall wall-clock deadline. Each native harness instead uses a 15-minute inactivity watchdog that resets on provider activity; protocol requests, cancellation, and process shutdown remain separately bounded.

## Configuration and supervision

```text
/subagents
/subagents status
/subagents profiles
/subagents codex
/subagents claude
/subagents pi
/subagents-config codex
/workflows
```

The default harness applies to both direct tools and workflow `agent()` calls. Exact model selection stays request-scoped; `/subagents status` reports that models are caller-selected or native-default. Successfully completed ordinary jobs retain their native session for the parent Pi session, bounded by the 100-job capacity; follow-up sends reopen the same job/session. At capacity, the oldest terminal jobs and their native sessions are evicted before new spawns. Failed, cancelled, evicted, and workflow-owned sessions are not reusable.

Workflow scripts compose task-driven agents directly:

```js
export default async function () {
  phase("Investigate");
  const findings = await parallel([
    () => agent("Inspect the architecture", { name: "architecture", access: "readOnly" }),
    () => agent("Identify implementation risks", { name: "risks", independent: true, access: "readOnly" }),
  ], { concurrency: 2 });

  phase("Implement");
  return agent(JSON.stringify(findings), { name: "implementation", access: "full" });
}
```

`agent(prompt, options?)` resolves to `{ ok, output, structured?, jobId?, error?, usage? }`. Options support `name`/`label`, `access`, `harness`, exact harness-local `model`, `effort`, `independent`, `profile`, `phase`, and bounded JSON `schema`. `parallel()` accepts task functions with concurrency 1–4; the shared manager remains the authoritative global scheduler.

Workflow scripts, checkpoints, results, bounded transcripts, and reports are private under `~/.pi/agent/workflows/`, never the project. V1 does not resume interrupted execution; stale running checkpoints become `aborted`.

## Installation and development

Requires Node.js 22.19.0 or newer. Pi extensions execute with user permissions, so review the package first.

```bash
npm install
pi install /absolute/path/to/pi-native-subagents
npm run typecheck
npm test
npm run pack:check
```

The suite intentionally stays around 55–70 broad, risk-based tests. Opt-in subscription-auth smoke commands are `npm run smoke`, `npm run smoke:{pi,claude,codex}`, and `npm run smoke:access:{claude,codex}`; set `PI_NATIVE_SUBAGENTS_LIVE=1` to invoke models.

## Architecture

- `extensions/subagents/` — direct tools, trust/cwd gate, delivery, cards, dashboard, and takeover.
- `src/manager.ts`, `src/types.ts`, `src/reducer.ts` — generic lifecycle contracts and bounded state.
- `src/profiles.ts`, `src/policy.ts` — explicit profile loading and composable harness policy.
- `src/backends/` — native Pi, Claude, and Codex adapters.
- `src/workflows/`, `extensions/workflows/` — sandboxed orchestration, private artifacts, rendering, and supervision.
- `src/env.ts`, `src/process-tree.ts` — subscription-auth sanitation and bounded cleanup.

## License

MIT.
