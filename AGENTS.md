# Pi Native Subagents

Standalone Pi extension for generic task-driven subagents and sandboxed workflows across Pi, Claude Code, and Codex.

## Working rules

- Keep the API generic and provider-neutral: default to Pi; expose Claude/Codex explicitly; compose harness, access, model, effort, independence, and profiles. Do not add roles, model tiers, concrete model IDs, recommendation tables, or private routing.
- Runtime policy, schemas, and lifecycle code are authoritative. If a change affects tool contracts, workflow mechanics, routing, access/approval, child capabilities, CLI commands, or user-facing recovery, update `skills/pi-native-subagents/SKILL.md` in the same change. Keep the skill concise; do not add tests for prose or skill contents.
- Keep the README package-generic. Do not document local/private skill or routing assumptions there.
- Preserve trusted-project and cwd containment, subscription-auth sanitation, deny-by-construction read-only execution, and the no-nested-delegation boundary. Children must not receive subagent/workflow capabilities.
- Human `/subagent` jobs may pull only a bounded, read-only `parent_thread_context` snapshot. Model-spawned children receive no parent content.
- Preserve bounded lifecycle and scheduler guarantees: four concurrent jobs, direct-job priority, startup/output/cancel/shutdown deadlines, process-tree cleanup, retained-session follow-ups, and one-shot delivery.
- Keep workflows sandboxed and durable: bounded phases/agents/logs, deferred `parallel` tasks, structured input/schema, journals/replay/restart, approvals/budgets, private artifacts, and foreground/background inspection. Serialize shared-checkout mutations; worktree isolation requires a clean source and explicit preservation metadata.
- Keep transcripts, artifacts, credentials, auth files, and machine-local runtime state out of Git.

## Engineering

- Use plain TypeScript with explicit interfaces/state transitions and dependency-injected adapters.
- Add focused, risk-based tests for security, routing, scheduling, lifecycle, persistence, and sandbox invariants—not helper, status, cosmetic, prose, or skill-content permutations.
- Release checks: `npm run typecheck`, `npm test`, `npm run pack:check`, and available opt-in live provider smokes.
- Keep changes modular and reviewable. Do not commit or push unless explicitly requested.
