# Design System

## Visual language

Inherit Pi's active theme and TUI vocabulary. Use semantic colors, compact bold titles, dim metadata, width-safe text, complete borders, visible focus, and status glyphs that do not rely on color alone.

## Subagent surfaces

The `/subagents` overlay contains title/status, keyboard guidance, a job list, selected-job detail, a bounded transcript viewport, and an exit/action footer. Rows and detail headers show agent name, access, optional profile, harness/requested model (or `default`), effort, status, and elapsed time. Concrete model recommendations live in the separately editable `subagents` skill; the runtime accepts a bounded harness-local ID or omits model selection so the native harness chooses its configured default.

Escape and Pi's cancel binding close the overlay. Arrow keys or `j`/`k` navigate; Shift+Up/Down and Page Up/Down scroll. Enter opens takeover; `s` steers, `f` queues a follow-up, and `x` cancels. Workflow-owned agents remain inspectable but cannot be steered.

Takeover normalizes bounded user, thinking, assistant, tool, live-thinking, and queued-message state. Active jobs accept steering; retained completed jobs accept follow-ups; failed/cancelled/expired jobs remain read-only.

Running glyphs use a width-stable 500 ms blink. Output is sanitized before Pi-native Markdown rendering. Cards are pinned to job id and generation so retained-session follow-ups do not rewrite historical rows.

## Tool rendering

Every direct tool uses the inline trace shell: `⌁` opens the call row and `│` carries result rows. Collapsed results are at most 10 lines; expanded results are at most 36. Lines truncate to actual width. Job cards prioritize status, policy, outcome, recent activity, informational usage, and a single `/subagents` disclosure footer. Task text stays on the call row unless expanded.

`subagent_spawn` owns the live card. Check/wait/send/cancel use one-line outcome receipts when collapsed. Wait identifies the agent once on the call row, then reports only state and elapsed time. List shows bounded rows. Unconsumed background completions reuse the same card as a single follow-up.

## Workflow surfaces

Workflow calls and results use the same `⌁`/`│` trace grammar, sanitizers, colors, glyphs, 10/36-line budgets, and one `/workflows` pointer. Collapsed cards show the current phase, active agent, result preview, and essential policy; expanded cards reveal description, summaries, and phase history.

There are no configured workflow token, turn, cost, or overall deadline limits. Usage is reporting only. The enforced workflow bounds are 512 KiB source, 256 KiB args, 1 MiB result, 32 agent calls, 128 phase events/64 retained phases, and four-way parallelism; harness lifecycle and shutdown deadlines remain separate and bounded.

The `/workflows` dashboard supports run/phase/agent navigation, status filtering, a read-only agent inspector, per-agent cancellation, and whole-run cancellation. The inspector separates caller prompt, thinking/tools, transcript, structured output, and result. Artifact paths and raw scripts are not shown in normal dashboard content.

## Policy and sandbox

Workflow JavaScript is control-plane code with no filesystem, network, subprocess, import, environment, or credential access. It can announce phases, request generic agents, and return JSON. Every request is validated by `WorkflowManager` and dispatched through the shared `JobManager`, preserving trust, profile ceilings, routing, subscription-auth sanitation, access sandboxes, the four-job cap, cancellation, and cleanup.

`agent(prompt, options?)` accepts `name`/`label`, `access`, `harness`, exact harness-local `model`, `effort`, `independent`, explicit `profile`, `phase`, and bounded `schema`. Profiles are human-selected overlays. Provider independence is an enforceable route constraint, not prompt wording.

Workflow artifacts are private operational state under the Pi agent directory. Terminal runs write compact summary/result/transcript/report artifacts. Background runs deliver one bounded follow-up; session shutdown aborts without delivery.
