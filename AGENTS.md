# Pi Native Subagents

Standalone Pi extension for generic task-driven subagents and sandboxed workflows across Pi, Claude Code, and Codex.

Users are Pi developers supervising native coding subagents and repeatable multi-agent workflows from a terminal, without leaving their primary session. The goal is a reliable control surface for starting generic task-driven agents, inspecting their policy and progress, steering retained native sessions, and safely orchestrating phased workflows.

## Product principles

- Make the task the unit of delegation.
- Keep access, provider, optional exact model, effort, independence, and optional human profile explicit and composable.
- Default ordinary delegation to the provider-agnostic Pi harness; expose native Claude and Codex as equal explicit routes.
- Treat each harness as a capability-bearing runtime, not only a model launcher: discover its live native tools, skills, plugins, MCP, hooks, and health without spending a model turn.
- Let callers require discovered capabilities and explicitly request automatic capability routing; revalidate requirements live immediately before dispatch.
- Default trusted generic agents to autonomous full access; make read-only an enforceable sandbox policy.
- Keep optional profiles explicitly human-selected and visible.
- Preserve one global four-job budget whether work starts directly or through a workflow.
- Use progressive disclosure: bounded cards → operational dashboard → normalized transcript/takeover.
- Keep private scripts, transcripts, and artifacts out of the project and out of ordinary model-facing results.

## Working rules

- Keep the API generic and provider-neutral: default to Pi; expose Claude/Codex explicitly; compose harness, access, model, effort, independence, and profiles. Do not add roles, model tiers, concrete model IDs, recommendation tables, or private routing. Concrete model recommendations belong in the editable routing skill, not the runtime.
- Runtime policy, schemas, and lifecycle code are authoritative. If a change affects tool contracts, workflow mechanics, routing, access/approval, child capabilities, CLI commands, or user-facing recovery, update the whole `skills/pi-native-subagents/` bundle — `SKILL.md` and every affected file under `references/` — in the same change. Do not add tests for prose or skill contents.
- Placement rule for that bundle: `SKILL.md` stays model-hot and under 16 KiB, carrying only pre-call decisions, common syntax, high-risk safety rules, canonical result semantics, and common recovery. Everything else belongs in a focused `references/*.md` file under 8 KiB, reached from an imperative trigger cue in `SKILL.md`. References resolve relative to `SKILL.md`, must stay independently useful, and must not chain to one another.
- Keep the README package-generic and quickstart-first. Do not document local/private skill or routing assumptions there, and do not restate runtime invariants that the code and the skill already own.
- Preserve trusted-project and cwd containment, subscription-auth sanitation, deny-by-construction read-only execution, and the no-nested-delegation boundary. Children must not receive subagent/workflow capabilities.
- Human `/subagent` jobs may pull only a bounded, read-only `parent_thread_context` snapshot. Model-spawned children receive no parent content.
- Preserve bounded lifecycle and scheduler guarantees: four concurrent jobs, direct-job priority, startup/output/cancel/shutdown deadlines, process-tree cleanup, retained-session follow-ups, and one-shot delivery.
- Keep workflows sandboxed and durable: bounded phases/agents/logs, deferred `parallel` tasks, structured input/schema, journals/replay/restart, approvals/budgets, private artifacts, and foreground/background inspection. Serialize shared-checkout mutations; worktree isolation requires a clean source and explicit preservation metadata.
- Keep transcripts, artifacts, credentials, auth files, and machine-local runtime state out of Git.

## Interface conventions

Surfaces inherit Pi's active theme and TUI vocabulary. The two visual grammars are documented where they are maintained, not in a separate design document:

- Trace shell for tool calls and results — `extensions/subagents/render.ts`.
- Dashboard panel shell for `/subagents` and `/workflows` — `extensions/dashboard-style.ts`.

All functionality must be keyboard accessible, support Pi's cancel bindings plus Escape, preserve visible focus and selection, avoid color-only status communication, and render correctly with Unicode and narrow terminal widths.

## Engineering

- Use plain TypeScript with explicit interfaces/state transitions and dependency-injected adapters.
- Add focused, risk-based tests for security, routing, scheduling, lifecycle, persistence, and sandbox invariants—not helper, status, cosmetic, prose, or skill-content permutations.
- Shared test fakes (backends, Pi host doubles, snapshot builders, async utilities) live in `tests/helpers.ts`. Extend that file rather than re-declaring a fake inside a test.
- Release checks: `npm run typecheck`, `npm test`, `npm run pack:check`, and available opt-in live provider smokes.
- Keep changes modular and reviewable. Do not commit or push unless explicitly requested.
