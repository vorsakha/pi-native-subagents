# Pi Native Subagents

## Purpose

Build a standalone, independently installable Pi extension that provides first-class subagent lifecycle management across native Pi, Claude Code, and Codex backends.

## Required behavior

- Preserve role-based prompts, model routing, explicit profiles/tiers, and nested-agent allowlists from `~/.pi/agent/extensions/subagents`.
- Support native backends:
  - Pi through a persistent subprocess protocol.
  - Claude Code through the installed Claude CLI / official Agent SDK so Claude subscription authentication is preserved.
  - Codex through the installed Codex CLI app-server so ChatGPT subscription authentication is preserved.
- Normalize backend events behind one manager API.
- Provide background spawn, wait, check, cancel, list, and retained native-session follow-up operations plus a compatibility foreground `subagent` operation and automatic one-shot delivery for unconsumed background results.
- Provide sandboxed JavaScript workflows with phases, sequential/bounded-parallel role-based agents, structured-output schemas, explicit usage budgets, foreground/background execution, private durable summary/transcript/report artifacts, automatic background result delivery, and `/workflows` inspection.
- Normalize bounded user, assistant, thinking, tool, and queued-message state for interactive takeover and persisted workflow inspection.
- Workflow scripts must never bypass project trust, role access, routing, nesting depth, subscription-auth safeguards, the shared four-job cap, or process-tree cleanup.
- Workers/general agents run autonomously with full access and no per-command prompts in trusted workspaces.
- Reviewers/scouts remain automatically read-only without prompting.
- Never inherit API-key environment variables into subscription-authenticated Claude/Codex children when that could silently switch billing modes.
- Default-deny untrusted project execution or require the parent Pi trust decision.
- Enforce concurrency limits, nested delegation depth, bounded output, bounded shutdown, and process-tree cleanup.
- Keep full transcripts private and out of Git. Workflow artifacts belong under the private Pi agent directory, never the project or configuration backup repository.

## Engineering constraints

- Plain TypeScript. Do not add Effect or another framework solely for lifecycle management.
- Prefer explicit interfaces, reducers/state machines, and dependency-injected backends that are testable with fakes.
- Do not copy code from repositories without a compatible license. The Davis setup may be studied for concepts only; its repository currently has no license file.
- No credentials, auth files, transcripts, runtime state, or machine-local paths in commits.
- Keep tests deliberately thin and risk-based. Prefer one broad invariant test over branch-by-branch or permutation coverage.
- Maintain roughly 55–70 focused tests for the package. Preserve only high-value contracts: trust/read-only/subscription auth, shared scheduling, cancellation/process cleanup, sandbox capability denial, persistence recovery, result-delivery deduplication, and one renderer/dashboard contract per surface.
- Do not add a test for every helper, status, width, empty state, protocol spelling, or cosmetic branch. Extend an existing invariant test when practical; delete superseded or duplicative cases.
- Opt-in live smoke tests cover provider compatibility that unit tests should not imitate exhaustively.
- Required release checks: typecheck, the thin test suite, package dry-run, and live smoke tests for available backends before installation.
- Keep changes small enough to review; prefer modules over a monolithic extension entrypoint.
