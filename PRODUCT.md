# Product

## Register

product

## Users
Pi users supervising native coding subagents and repeatable multi-agent workflows from a terminal while staying inside their primary working session.

## Product Purpose
Provide a reliable, glanceable control surface for inspecting, steering, following up with, and cancelling subagents, plus safely orchestrating them through sandboxed phased workflows without leaving Pi or losing keyboard control.

## Brand Personality
Focused, operational, familiar.

## Anti-references
Flat unframed debug output, modal traps, hidden exit behavior, decorative terminal chrome, noisy dashboards, and interfaces that invent keyboard conventions when Pi already provides them.

## Design Principles
- Match Pi's established TUI vocabulary so controls feel native.
- Make escape routes obvious and reliable before adding secondary actions.
- Separate job navigation, selected-job detail, and action guidance with clear hierarchy.
- Use color only for focus, selection, and lifecycle status.
- Keep every line width-safe and useful on constrained terminals.
- Make workflow phase, agent, policy, and result state legible without exposing raw scripts or transcripts by default.
- Preserve role policy and one global concurrency budget regardless of whether work starts manually or through a workflow.

## Accessibility & Inclusion
All functionality must be keyboard accessible, support standard Pi cancel keybindings plus Escape, preserve visible focus and selection, avoid color-only status communication, and render correctly with Unicode and narrow terminal widths.
