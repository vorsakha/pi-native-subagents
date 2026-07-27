# Product

## Users

Pi users supervising native coding subagents and repeatable multi-agent workflows from a terminal while staying inside their primary session.

## Product purpose

Provide a reliable control surface for starting generic task-driven agents, inspecting their policy and progress, steering retained native sessions, and safely orchestrating phased workflows.

## Principles

- Make the task the unit of delegation.
- Keep access, provider, optional exact model, effort, independence, and optional human profile explicit and composable.
- Default ordinary delegation to the provider-agnostic Pi harness; expose native Claude and Codex as equal explicit routes.
- Treat each harness as a capability-bearing runtime, not only a model launcher: discover its live native tools, skills, plugins, MCP, hooks, and health without spending a model turn.
- Let callers require discovered capabilities and explicitly request automatic capability routing; revalidate requirements live immediately before dispatch.
- Preserve native customization inside the access ceiling while always denying recursive agents/workflows, unattended user interaction, permission escalation, and harness administration.
- Keep concrete model recommendations in the editable routing skill; runtime accepts harness-local IDs or uses native defaults.
- Default trusted generic agents to autonomous full access; make read-only an enforceable sandbox policy.
- Keep optional profiles explicitly human-selected and visible.
- Preserve one global four-job budget whether work starts directly or through a workflow.
- Use progressive disclosure: bounded cards → operational dashboard → normalized transcript/takeover.
- Make name, access, optional profile, harness/model, effort, usage, and result state legible.
- Keep private scripts/transcripts/artifacts out of the project and out of ordinary model-facing results.

## Accessibility

All functionality must be keyboard accessible, support Pi's cancel bindings plus Escape, preserve visible focus and selection, avoid color-only status communication, and render correctly with Unicode and narrow terminal widths.
