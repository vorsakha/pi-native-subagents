# Pi Native Subagents

## Purpose

Build a standalone Pi extension providing first-class generic subagent lifecycle management across native Pi, Claude Code, and Codex harnesses.

## Required behavior

- Use generic task-driven agents by default.
- Keep access, harness, optional exact model, effort, provider independence, and optional explicit profiles as composable policy fields.
- Load global profiles from the Pi agent directory and trusted project profiles from `.pi/subagents`, with project precedence and validation warnings.
- Keep concrete model names and recommendations out of runtime code and profiles; the editable routing skill supplies request-scoped harness-local IDs, while omission uses native harness defaults.
- Default to the Pi harness so provider and model choice come from the user's Pi configuration; keep native Claude and Codex as equal explicit routes.
- Preserve subscription authentication for native Claude and Codex and never inherit environment state that could silently switch billing modes; Pi children inherit Pi's provider environment.
- Provide background spawn/wait/check/send/cancel/list, retained-session follow-up, foreground `subagent`, and one-shot delivery for unconsumed background results.
- Provide sandboxed workflows with phases, sequential/bounded-parallel generic agents, schemas, foreground/background execution, private durable artifacts, delivery, and `/workflows` inspection.
- Disable nested child delegation. Children must not receive subagent or workflow capabilities.
- Default-deny untrusted execution and constrain child working directories to the trusted project.
- Preserve four concurrent jobs, bounded output/shutdown, cancellation, process-tree cleanup, and workflow source/args/result limits.
- Keep full transcripts and workflow runtime artifacts private and out of Git.

## Engineering constraints

- Plain TypeScript; prefer explicit interfaces, reducers/state machines, and dependency-injected harness adapters.
- No credentials, auth files, transcripts, runtime state, or machine-local paths in commits.
- Keep focused, risk-based tests. Favor broad invariants over helper/status/cosmetic permutations.
- Preserve high-value contracts: trust/read-only/subscription auth, generic routing and profile ceilings, shared scheduling, cancellation/process cleanup, sandbox capability denial, persistence recovery, result-delivery deduplication, and one renderer/dashboard contract per surface.
- Use opt-in live smoke tests for provider compatibility.
- Required release checks: typecheck, thin tests, package dry-run, and available-harness live smokes before installation.
- Keep changes reviewable and modular. Do not commit or push unless explicitly requested.
