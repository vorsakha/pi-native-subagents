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
- Provide background spawn, wait, check, cancel, and list operations plus a compatibility foreground `subagent` operation.
- Workers/general agents run autonomously with full access and no per-command prompts in trusted workspaces.
- Reviewers/scouts remain automatically read-only without prompting.
- Never inherit API-key environment variables into subscription-authenticated Claude/Codex children when that could silently switch billing modes.
- Default-deny untrusted project execution or require the parent Pi trust decision.
- Enforce concurrency limits, nested delegation depth, bounded output, bounded shutdown, and process-tree cleanup.
- Keep full transcripts private and out of Git.

## Engineering constraints

- Plain TypeScript. Do not add Effect or another framework solely for lifecycle management.
- Prefer explicit interfaces, reducers/state machines, and dependency-injected backends that are testable with fakes.
- Do not copy code from repositories without a compatible license. The Davis setup may be studied for concepts only; its repository currently has no license file.
- No credentials, auth files, transcripts, runtime state, or machine-local paths in commits.
- Add unit, integration/fake-backend, and opt-in live smoke tests.
- Required release checks: format/lint if configured, typecheck, tests, package dry-run, and live smoke tests for available backends before installation.
- Keep changes small enough to review; prefer modules over a monolithic extension entrypoint.
