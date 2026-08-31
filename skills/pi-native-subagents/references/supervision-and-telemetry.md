# Supervision surfaces and telemetry

Read this when supervising work or interpreting telemetry. Each dashboard's `?` legend owns bindings.

## Surfaces

- `/subagents` has job-list, job-detail, and composer focus. Enter or Right inspects; `a`, `s`, and `f` answer, steer, and follow up. Escape backs out; `j/k` selects or scrolls. A routed question blocks draft submission. Cancellation requires the eligible job in the latest view.
- `/workflows` has `runs`, `outline`, and `agent-detail` focus. Its bounded outline models every recorded or planned phase and expands the selected phase's filtered agents. Agent rows show lifecycle state and semantic progress; phase rows remain visible under filters. Control workflow agents through `/workflows`, not `/subagents`.
- Direct-job and workflow-agent transcript labels show the visible line range. Scrolling away from the tail marks the viewport `paused`; press `G` to resume the live tail or a terminal transcript's end.
- Direct jobs and workflow-owned child jobs remain in the shared editor activity widget. Workflow runs use one session-level widget keyed by stable run ID. Opening it uses `/workflows`; it never creates a second dashboard.
- Workflow calls and results keep durable transcript cards, run IDs, and artifact references.
- Workflow-owned jobs stay tagged in `/subagents`; the activity widget counts them separately.
- Inspectors default to state plus outline, transcript, or result. Press `i` for route/model, usage/budget, context, provenance, isolation, replay, and replacement telemetry. Errors, questions, waits, warnings, and recovery stay pinned. Previews omit full tool calls and result bodies.
- Continued routes read `primary → replacement (continued)`. A durable handoff marks the declaration used. Detail shows trigger, checkout, attempts, and replacement history; it never calls a closed or persisted job retained.
- Transcripts default to compact tool-call groups; full native rendering is a toggle. Selection survives refresh, filtering, reordering, replacement, and resize.
- Wide dashboards use a rail; medium stacks the list; narrow shows one focus layer. No layout adds a permanent third column.
- Phase rows, omission rows, headers, and filtered or hidden agents are never agent-action targets. Restart and agent cancellation require an eligible selected agent that survived the final rendered outline/detail viewport. Run cancellation remains a separate confirmed action.
- Headers keep needs-input, active, and failed counts under width pressure. Very short panels expose only close and ignore hidden actions.
- `/subagents providers` shows normalized state, reason, and active status. Email is masked. Refresh re-probes without model calls, installation, login, configuration changes, or credentials.
- A version appears only when a safe probe reports one. Pi, Claude, and Codex do not run a separate version command. Do not infer compatibility from an absent version.

## Distinguishing waits

Four non-failure states are reported separately and must not be summarized as failures or as each other:

- **needs input** — a job parked on a routed question. `/subagents` and `/workflows` pin the bounded question, elapsed wait, source, target, and one next action. A human-owned direct `/subagent` question is answered inline with `a`. An orchestrator-owned question is answered from the parent thread with `subagent_answer`; steering is not an answer. A peer-owned question names the peer and requires no human action. A workflow-owned job shown in `/subagents` names its workflow and sends supervision to `/workflows`; it offers no answer, steer, takeover, or follow-up there. Cancellation remains available for a live caller.
- **waiting** — a workflow agent waiting out a provider window. This state outranks stale legacy error fields. The preview names the agent, provider, window, retry countdown, and attempt count, and says retry is automatic; it never renders the failed attempt's raw error. No human action is required. This remains distinct from routed input, scheduler queueing, and pause. Cancelling a waiting agent fails that agent terminally while the run continues.
- **paused** — an operator-paused run. Resume it with `p` in `/workflows`; human action is required.
- **queued** — a scheduler-queued direct job or workflow agent with no slot yet. Dispatch is automatic when a slot opens; no human action is required.

## State previews and recovery

- A running workflow agent pins `Now`, then `Context`. `Context` uses the recorded phase plus convergence role and round when present. Rows use the same compressed activity. Questions, failures, peer answers, provider waits, and scheduler queueing displace routine activity.
- `Now` is live-only operational evidence. Reasoning and response events expose only `Reasoning · provider activity … ago` or `Drafting response · provider activity … ago`. Recognized file tools may show a bounded project-relative target, such as `Reading src/policy.ts · started … ago`; external targets become `[outside workspace]`. Completed and failed actions use fixed wording. With no evidence, show `Working · no describable activity reported yet`.
- Never derive `Now` from thought text, response previews, transcript entries, tool summaries, raw commands, queries, results, credentials, or absolute machine paths. It is not journaled or replayed, clears between generations and attempts, and disappears at terminal settlement. Updates come from manager events without polling or provider turns.
- Failed or cancelled direct sessions pin their error and offer no follow-up, restart, or takeover. Workflow-owned rows send recovery to `/workflows`.
- Failed workflow runs pin their error and have no run restart action. Use `r` only on an agent that `/workflows` can restart in a replacement run.
- Failed, cancelled, or aborted agents show `r` only when restart cannot discard progressed agent or follow-up work. Exact replay restores that proof. Peer-answer progress does not block safe suffix restart. Progressed failures and continued agents require the handoff or manual recovery.
- A completed entity shows one concise result preview. Use `f` for a retained direct session when more work is needed. Completed workflow runs and agents require no action; `r` on an eligible workflow agent starts a replacement run rather than continuing the completed session.

## Telemetry concepts stay distinct

- **Configured model** — routing intent recorded on the job at spawn time.
- **Effective serving model** (`serving …`) — the model identity the native runtime itself reports for the current turn. Codex reports it only via `model`/`rerouted`; `thread/start`'s model field just echoes the requested or resolved routing intent, not observed serving behavior. Claude reports it on init, assistant, and refusal-fallback events. Pi reports it as `responseModel`, never its `model` alias. When the runtime does not report it, it is omitted — never guessed from the configured model.
- **Requested speed** is fixed policy. Omitted means standard; Fast is an explicit Codex-only opt-in. **Effective speed** is separate native telemetry: Codex `default` is standard and `priority`/`fast` is fast. Unknown values stay absent. Requested standard may show effective fast because native configuration still applies.
- **Aggregate usage** — cumulative across follow-ups and bound by budgets.
- **Context occupancy** — the latest request/turn gauge. It is replaced rather than summed on each reading, cleared at the start of every retained follow-up so a prior generation's reading is never shown as current, and shown as `unknown` rather than zero when the runtime omits it.
- A requested or effective Fast tier shows `Codex credits apply · monetary cost unreported`. This is a warning, not a receipt or spend estimate.

## Reporting rules

- Report a failed route, `ok: false`, and its bounded `error` and job ID plainly. Do not hide a failed route behind a success-only summary.
- Keep private transcripts and workflow artifacts out of Git. The extension's durable artifacts are for bounded inspection, not for copying into prompts wholesale.
