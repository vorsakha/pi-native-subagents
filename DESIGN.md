# Design System

## Visual language

Inherit Pi's active theme and TUI vocabulary. Use semantic colors, compact bold titles, dim metadata, width-safe text, complete borders, visible focus, and status glyphs that do not rely on color alone.

## Subagent surfaces

The `/subagents` overlay contains title/status, keyboard guidance, a job list, selected-job detail, a bounded transcript viewport, and an exit/action footer. Rows and detail headers show generic agent name, access, optional profile, backend/model, effort, status, and elapsed time—never a role taxonomy.

Escape and Pi's cancel binding close the overlay. Arrow keys or `j`/`k` navigate; Shift+Up/Down and Page Up/Down scroll. Enter opens takeover; `s` steers, `f` queues a follow-up, and `x` cancels. Workflow-owned agents remain inspectable but cannot be steered.

Takeover normalizes bounded user, thinking, assistant, tool, live-thinking, and queued-message state. Active jobs accept steering; retained completed jobs accept follow-ups; failed/cancelled/expired jobs remain read-only.

Running glyphs use width-stable fade frames every 200 ms. Output is sanitized before Pi-native Markdown rendering. Cards are pinned to job id and generation so retained-session follow-ups do not rewrite historical rows.

## Tool rendering

Every direct tool has custom bounded rendering. Collapsed results are at most 10 lines; expanded results are at most 36. Lines truncate to actual width. Job cards prioritize status/policy, task, workflow ownership/error, outcome, recent activity, informational usage, and a single `/subagents` disclosure footer.

`subagent_spawn` owns the live card. Check/wait/send/cancel use one-line receipts when collapsed. List shows bounded rows. Unconsumed background completions reuse the same card as a single follow-up.

## Workflow surfaces

Workflow cards use the same sanitizers, colors, glyphs, 10/36-line budgets, and one `/workflows` pointer. They show phase position, generic agent count/state, access/profile/route/effort, informational aggregate usage, result, and errors.

There are no configured workflow token, turn, cost, or overall deadline limits. Usage is reporting only. The enforced workflow bounds are 512 KiB source, 256 KiB args, 1 MiB result, 32 agent calls, 128 phase events/64 retained phases, and four-way parallelism; backend lifecycle and shutdown deadlines remain separate and bounded.

The `/workflows` dashboard supports run/phase/agent navigation, status filtering, a read-only agent inspector, per-agent cancellation, and whole-run cancellation. The inspector separates caller prompt, thinking/tools, transcript, structured output, and result. Artifact paths and raw scripts are not shown in normal dashboard content.

## Policy and sandbox

Workflow JavaScript is control-plane code with no filesystem, network, subprocess, import, environment, or credential access. It can announce phases, request generic agents, and return JSON. Every request is validated by `WorkflowManager` and dispatched through the shared `JobManager`, preserving trust, profile ceilings, routing, subscription-auth sanitation, access sandboxes, the four-job cap, cancellation, and cleanup.

`agent(prompt, options?)` needs no role. Options are `name`/`label`, `access`, `backend`, `modelTier`, `effort`, `independent`, explicit `profile`, `phase`, and bounded `schema`. Profiles are human-selected overlays, not automatically chosen personas. Provider independence is an enforceable route constraint, not prompt wording.

Workflow artifacts are private operational state under the Pi agent directory. Terminal runs write compact summary/result/transcript/report artifacts. Background runs deliver one bounded follow-up; session shutdown aborts without delivery.
