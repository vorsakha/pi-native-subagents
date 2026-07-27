# Design System

## Visual language

Inherit Pi's active theme and TUI vocabulary. Use semantic colors, compact bold titles, dim metadata, width-safe text, complete borders, visible focus, and status glyphs that do not rely on color alone.

Operational dashboards share the `/ps` visual grammar: a title and count above the panel, one rounded border, titled internal dividers, selection markers and status glyphs on the left, right-aligned operational metadata, and keyboard guidance below the panel. Dashboards use the full available width, cap themselves at 80% of terminal height, and keep the established interaction model for each surface.

## Subagent surfaces

The `/subagents` overlay contains a job list and selected-job detail inside one calm inspector panel, with title/count above and context-aware keyboard guidance below. The established combined list/detail interaction remains intact. List rows prioritize agent name, access, effort, harness, status, and elapsed time; the selected detail header carries optional profile, exact requested model (or `default`), independence, and workflow ownership without crushing the job name. Concrete model recommendations live in the separately editable `subagents` skill; the runtime accepts a bounded harness-local ID or omits model selection so the native harness chooses its configured default.

Escape and Pi's cancel binding close the overlay. Arrow keys or `j`/`k` navigate; Shift+Up/Down and Page Up/Down scroll. Enter opens takeover; `s` steers, `f` queues a follow-up, and `x` cancels. Workflow-owned agents remain inspectable but cannot be steered.

Takeover normalizes bounded user, thinking, assistant, tool, live-thinking, and queued-message state. Active jobs accept steering; completed ordinary jobs retain follow-up-capable native sessions until parent-session shutdown or oldest-terminal eviction at the 100-job capacity. Failed, cancelled, evicted, and workflow-owned jobs remain read-only.

Running glyphs use a width-stable 500 ms blink. Output is sanitized before Pi-native Markdown rendering. Cards are pinned to job id and generation so retained-session follow-ups do not rewrite historical rows.

## Tool rendering

Every direct tool uses the inline trace shell: `⌁` opens the call row and `│` carries result rows. Collapsed results are at most 10 lines; expanded results are at most 36. Lines truncate to actual width. Job cards prioritize status, policy, outcome, recent activity, informational usage, and a single `/subagents` disclosure footer. Task text stays on the call row unless expanded.

`subagent_spawn` owns the live card. Check/wait/send/cancel use one-line outcome receipts when collapsed. Wait identifies the agent once on the call row, then reports only state and elapsed time. List shows bounded rows. Unconsumed background completions reuse the same card as a single follow-up.

## Workflow surfaces

Workflow calls and results use the same `⌁`/`│` trace grammar, sanitizers, colors, glyphs, 10/36-line budgets, and one `/workflows` pointer. Collapsed cards show the current phase, active agent, result preview, and essential policy; expanded cards reveal description, summaries, and phase history.

There are no configured workflow token, turn, cost, or overall wall-clock deadline limits. Native turns likewise have no total-duration cap; Pi, Claude, and Codex reset a 15-minute inactivity watchdog on provider activity. Usage is reporting only. The enforced workflow bounds are 512 KiB source, 256 KiB args, 1 MiB result, 32 agent calls, 128 phase events/64 retained phases, and four-way parallelism; protocol, cancellation, and shutdown deadlines remain separate and bounded.

The `/workflows` dashboard uses the same panel shell as `/subagents`: runs remain visible above a titled detail region, while phase, agent, filter, inspection, and cancellation behavior stays in place. It supports run/phase/agent navigation, status filtering, a read-only agent inspector, cooperative pause/resume (`p`), selected-agent journal restart (`r`), per-agent cancellation, and whole-run cancellation. Pause gates the next provider dispatch rather than interrupting a turn already running. The inspector separates caller prompt, thinking/tools, transcript, structured output, provenance, and result; instruction-shaped child output is visibly flagged as untrusted data. Artifact paths and raw scripts are not shown in normal dashboard content.

## Capability discovery and native parity

Harness capability discovery is model-free and cwd/access aware. `CapabilityService` normalizes adapter inventories into stable IDs with kind, origin, effect, health, enablement, and denial state. Browse results use a short metadata-fingerprinted cache; explicit `refresh` bypasses it, and every requirement-bearing route performs an uncached revalidation before dispatch. Missing introspection degrades to `unknown` with a warning rather than inventing availability.

Adapters retain native specialization within the policy ceiling. Pi inventories the parent runtime plus a tool-less child RPC command list, loads native skills/templates in both modes, and loads extensions only for full access; the child marker prevents this package from registering recursively. Claude loads native setting sources and skills, but read-only retains a fixed read/web allowlist with hooks and MCP isolated. Codex inventories its live app-server skill/plugin/hook/MCP methods and disables MCP/hooks in read-only or isolated threads. Full native integrations remain health-gated. Optional integration failure may degrade an unrelated Codex job, but a capability explicitly named in `requires` may never be silently removed.

`harness: "auto"` is opt-in and requires at least one explicit capability requirement. Runtime code does not classify arbitrary task prose. Candidate routes are filtered by access, profile ceilings, and provider independence, then follow configured harness preference. Jobs retain the matched IDs and catalog revision as capability provenance; workflow fingerprints already bind the complete agent options, including requirements, and journal routes retain the concrete selected harness.

The orchestration ceiling is independent of access: provider-native Agent/Workflow/Task surfaces, this package's own tools, session peers, plugin/MCP administration, authentication, permission escalation, and unattended user prompts remain unavailable. Read-only additionally rejects workspace/external writes and unknown-effect native capabilities. Native customization never weakens trust gating, subscription-auth sanitation, or process cleanup.

## Policy and sandbox

Workflow JavaScript is control-plane code with no filesystem, network, subprocess, import, environment, or credential access. It can publish bounded static metadata, announce phases, emit bounded logs, request generic agents sequentially, in parallel, or through a pipeline, and return JSON. Wall-clock time and randomness are unavailable so journal replay remains deterministic. Every fresh request is validated by `WorkflowManager` and dispatched through the shared `JobManager`, preserving trust, profile ceilings, routing, subscription-auth sanitation, access sandboxes, the four-job cap, bounded startup/cancellation, direct-job queue priority, and cleanup. Read-only fan-out can fill the scheduler; mutating workflow calls sharing a checkout are serialized until isolated worktrees exist.

`agent(prompt, options?)` accepts `name`/`label`, `access`, `harness`, exact harness-local `model`, `effort`, `independent`, `independentOf`, explicit `profile`, `phase`, bounded `schema`, and optional `isolation: "worktree"`. Profiles are human-selected overlays. Provider independence is an enforceable route constraint, not prompt wording: `independent` differs from the parent, while `independentOf` resolves an existing producer job and differs from that job's native provider.

Workflow approval is host-enforced. `auto` retains trusted-project behavior, `plan` refuses full-access calls, and `onMutate` opens one abortable Pi confirmation before the run's first mutation and fails closed without UI. Budgets cap calls, active dispatches, combined input/output tokens, turns, and cost; usage overruns abort the sandbox and cancel members. Saved definitions load from a private user directory and trusted `.pi/workflows` project scope with project precedence, while explicit `scriptPath` is realpath-contained and bounded.

Workflow artifacts are private operational state under the Pi agent directory. Every `agent()` call is assigned a sandbox invocation ordinal and durably records started/settled transitions in an append-only, fsynced `journal.jsonl`. Explicit `resumeFromRunId` creates a new run, replays only the contiguous matching successful prefix, and reruns the first incomplete call plus its suffix; script, arguments, cwd, and routing context must match the source run. Terminal runs write compact summary/result/transcript/report artifacts. Background runs deliver one bounded follow-up without exposing machine-local artifact paths; session shutdown aborts without delivery.
