# Supervision surfaces and telemetry

Read this when reporting on a running job, interpreting usage or model numbers, or telling a human where to look. Do not narrate key bindings: every dashboard has a contextual, focus-aware `?` legend that is authoritative for its current focus.

## Surfaces

- `/subagents` has `job-list`, `job-detail`, and `composer` focus. Enter or Right inspects; `a`, `s`, and `f` answer, steer, and follow up. Escape or Left backs out one layer. `j/k` selects in the list and scrolls in detail. Drafts and tail-follow state survive focus and layout changes. Cancellation requires the exact eligible job in the latest view.
- `/workflows` has `runs`, `outline`, and `agent-detail` focus. Its bounded outline models every recorded or planned phase and expands the selected phase's filtered agents. Agent rows show lifecycle state and semantic progress; phase rows remain visible under filters. Control workflow agents through `/workflows`, not `/subagents`.
- Direct-job and workflow-agent transcript labels show the visible line range. Scrolling away from the tail marks the viewport `paused`; press `G` to resume live tail-following.
- Direct jobs and workflow-owned child jobs remain in the shared editor activity widget. Workflow runs use one session-level widget keyed by stable run ID. Opening it uses `/workflows`; it never creates a second dashboard.
- Workflow tool calls and results keep durable transcript cards, run IDs, and artifact references. Activity remains keyboard reachable, textual, and narrow-width safe.
- Workflow-owned jobs stay tagged in `/subagents`; the activity widget counts them separately.
- A direct-job or workflow-agent inspector defaults to its state preview plus transcript or result. Press `i` to show or hide routine route/model, usage/budget, context, capability/availability, provenance, isolation, replay, and replacement telemetry. Errors, questions, provider waits, warnings, and recovery stay pinned. Short inspectors reserve a label and one transcript/result row. Previews do not repeat full tool calls or result bodies.
- Transcripts default to compact tool-call groups with counts and running/failed visibility; full native tool rendering is a toggle. Workflow inspection preserves run and node identities through refresh, filtering, reordering, replacement, and resize. Missing nodes fall back to their phase, then the current phase, then the first visible node.
- Wide dashboards keep the grouped run rail beside either the outline or agent detail. Medium dashboards keep a short grouped run list above it. Narrow dashboards show one focus layer at a time. Backtracking restores the prior node identity; no layout adds a permanent third column.
- Phase rows, omission rows, headers, and filtered or hidden agents are never agent-action targets. Restart and agent cancellation require an eligible selected agent that survived the final rendered outline/detail viewport. Run cancellation remains a separate confirmed action.
- `/subagents providers` reports each native harness twice: a normalized availability line — `ready`, `missing executable`, `login required`, `incompatible`, `temporarily unhealthy`, `status unknown`, or `disabled by user`, with an actionable reason and whether the harness is currently `active` — and then the raw provider readiness (installed / authenticated / ready) with masked account email, plan, auth method, and Pi's selected model. The listed active set is exactly the enabled harnesses a live probe reports ready. This package currently enables every registered adapter; the normalized view can represent a host-supplied disabled state, but discovery does not mutate configuration. `/subagents providers refresh` re-probes. Discovery is read-only and turn-free: no model request is made, no CLI is installed or logged in, no configuration is changed, credentials are never displayed, and Pi exposes no account email. State is carried by the status bar, dashboard header, text labels, and reasons, never by color alone. Availability is a snapshot; the runtime revalidates the selected route immediately before each dispatch.
- A version appears only when a safe probe reports one. Pi, Claude, and Codex do not run a separate version command. Do not infer compatibility from an absent version.

## Distinguishing waits

Four non-failure states are reported separately and must not be summarized as failures or as each other:

- **needs input** — a job parked on a routed question. `/subagents` and `/workflows` pin the bounded question, elapsed wait, source, target, and one next action. A human-owned direct `/subagent` question is answered inline with `a`. An orchestrator-owned question is answered from the parent thread with `subagent_answer`; steering is not an answer. A peer-owned question names the peer and requires no human action. A workflow-owned job shown in `/subagents` names its workflow and sends supervision to `/workflows`; it offers no answer, steer, takeover, or follow-up there. Cancellation remains available for a live caller.
- **waiting** — a workflow agent waiting out a provider window. The preview names the agent, provider, window, retry countdown, and attempt count, and says retry is automatic. No human action is required. This remains distinct from routed input, scheduler queueing, and pause. Cancelling a waiting agent fails that agent terminally while the run continues.
- **paused** — an operator-paused run. Resume it with `p` in `/workflows`; human action is required.
- **queued** — a scheduler-queued direct job or workflow agent with no slot yet. Dispatch is automatic when a slot opens; no human action is required.

## State previews and recovery

- A running entity with no question shows `Latest` from bounded semantic activity. Use `s` only for a steerable direct job. Workflow agents have no steer or takeover action; monitor them in `/workflows`.
- A failed direct session pins its bounded error. Failed and cancelled direct sessions cannot continue, so the inspector does not offer follow-up, restart, or takeover. A workflow-owned direct row sends recovery to `/workflows`.
- A failed workflow run pins its bounded error. There is no run restart action. Inspect the failed agent and use `r` only when that agent has a recorded call that `/workflows` can restart as a replacement run.
- A failed, cancelled, or aborted workflow agent names `r` only when that selected agent can be restarted. Otherwise the inspector says no restart action is available.
- A completed entity shows one concise result preview. Use `f` for a retained direct session when more work is needed. Completed workflow runs and agents require no action; `r` on an eligible workflow agent starts a replacement run rather than continuing the completed session.

## Four telemetry concepts stay distinct

- **Configured model** — routing intent recorded on the job at spawn time.
- **Effective serving model** (`serving …`) — the model identity the native runtime itself reports for the current turn. Codex reports it only via `model`/`rerouted`; `thread/start`'s model field just echoes the requested or resolved routing intent, not observed serving behavior. Claude reports it on init, assistant, and refusal-fallback events. Pi reports it as `responseModel`, never its `model` alias. When the runtime does not report it, it is omitted — never guessed from the configured model.
- **Aggregate usage** — cumulative across every retained follow-up, and what budgets bind.
- **Context occupancy** — the latest request/turn gauge. It is replaced rather than summed on each reading, cleared at the start of every retained follow-up so a prior generation's reading is never shown as current, and shown as `unknown` rather than zero when the runtime omits it.

## Reporting rules

- Report a failed route, `ok: false`, and its bounded `error` and job ID plainly. Do not hide a failed route behind a success-only summary.
- Keep private transcripts and workflow artifacts out of Git. The extension's durable artifacts are for bounded inspection, not for copying into prompts wholesale.
