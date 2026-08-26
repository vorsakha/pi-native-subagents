# Supervision surfaces and telemetry

Read this when reporting on a running job, interpreting usage or model numbers, or telling a human where to look. Do not narrate key bindings: every dashboard has a contextual, pane-aware `?` legend that is authoritative for its current pane.

## Surfaces

- `/subagents` opens the adaptive dashboard for direct jobs: bounded cards, a transcript, in-panel takeover for steering or following up, and confirmed cancellation. It adapts to terminal width and height on its own.
- `/workflows` is the durable surface for workflow runs: phases, the agent roster, per-agent transcripts, pause/resume, agent restart, and confirmed agent or run cancellation. Workflow agents stay controlled through `/workflows`, not `/subagents`.
- Workflow-owned jobs stay listed and tagged in `/subagents` too, and the editor activity widget counts direct and workflow-owned agents separately.
- Transcripts default to a compact mode that collapses consecutive tool calls into one bounded indicator with counts and running/failed visibility; full native tool rendering is a toggle. Workflow inspection preserves run IDs, phase indexes, and agent indexes through refreshed snapshots, sorting, filtering, and reordering.
- `/subagents providers` reports each native provider as installed, authenticated, or ready, with the masked account email, plan, auth method, and Pi's selected model. `/subagents providers refresh` re-probes. It reads account and auth state only: no model request is made, credentials are never displayed, and Pi exposes no account email.

## Distinguishing waits

Four non-failure states are reported separately and must not be summarized as failures or as each other:

- **needs input** — a job parked on a routed question. `/subagents` and `/workflows` name the source, target, elapsed wait, answer state, and bounded question, and pin it in the inspector. Steer and follow-up controls are withdrawn while a caller is parked; cancellation stays available. In `/subagents` a human can answer a question their own `/subagent` job asked; a question routed to the orchestrator is read-only there, because the parent thread answers it with `subagent_answer`.
- **waiting** — an agent waiting out a provider-quota window, with the bounded provider, window label, retry time, and attempt count. Cancelling it fails that agent terminally while the run continues.
- **paused** — a user-paused run.
- **queued** — a scheduler-queued agent with no slot yet.

## Four telemetry concepts stay distinct

- **Configured model** — routing intent recorded on the job at spawn time.
- **Effective serving model** (`serving …`) — the model identity the native runtime itself reports for the current turn. Codex reports it only via `model`/`rerouted`; `thread/start`'s model field just echoes the requested or resolved routing intent, not observed serving behavior. Claude reports it on init, assistant, and refusal-fallback events. Pi reports it as `responseModel`, never its `model` alias. When the runtime does not report it, it is omitted — never guessed from the configured model.
- **Aggregate usage** — cumulative across every retained follow-up, and what budgets bind.
- **Context occupancy** — the latest request/turn gauge. It is replaced rather than summed on each reading, cleared at the start of every retained follow-up so a prior generation's reading is never shown as current, and shown as `unknown` rather than zero when the runtime omits it.

## Reporting rules

- Report a failed route, `ok: false`, and its bounded `error` and job ID plainly. Do not hide a failed route behind a success-only summary.
- Keep private transcripts and workflow artifacts out of Git. The extension's durable artifacts are for bounded inspection, not for copying into prompts wholesale.
