# Workflow authoring

Read this before editing a workflow. It covers sources, sandbox APIs, phases, fan-out, retained calls, and task outcome.

## Source and input contract

The `workflow` tool accepts exactly one source: inline `script`, saved `workflowName`, or trusted project-local `scriptPath`.

Use zero or one input form: structured `input` or the legacy JSON-string `args`, never both. The selected value is exposed to the script as the global `args`; omitting both exposes `null`. Workflows must be trusted and use a source contained by the trusted project rules.

`approval: "plan"` is for read-only planning; `approval: "onMutate"` requires a host confirmation before mutation; `approval: "auto"` is the unprompted default.

`background: true` returns a start snapshot; completion is delivered as one follow-up and remains inspectable with `/workflows`.

## Script shape and globals

A workflow script must export a default async function. The helpers are globals, not a context object:

- `args` — parsed input;
- `phase(title)` / `log(message)` — report bounded progress;
- `agent(prompt, options)` — run one generic child;
- `followUp(jobId, prompt, options)` — continue this run's retained child;
- `consult(advisorId, question, options)` — consult an allowlisted thread advisor;
- `parallel(tasks, { concurrency })` — run deferred tasks in a bounded pool;
- `pipeline(items, ...stages)` — process items through stages;
- `converge(options)` and `convergenceReviewSchema` — run and validate bounded fix loops.

Do not write the function as if it receives a context object such as `async ({ phase, agent }) => ...`. Positional helper arguments are retained for compatibility, but the global API is the canonical form.

## Declared phases

For a workflow with a known plan, add `phases` to the exported metadata:

```js
export const meta = { name: "release review", phases: ["review", "verify", "summarize"] };
```

The plan accepts 1–64 unique normalized names of at most 160 characters. Matching is case-sensitive. Activate them forward with `phase(title)`; conditional phases may be skipped. Omit `meta.phases` for dynamic phases.

## parallel versus pipeline

`parallel` receives functions, not started promises. The runner owns order, concurrency, call numbers, cancellation, and replay. Concurrency is 1 to 4 and defaults to 4. Use it when the next step needs all results; check every result's `ok`.

`pipeline(items, ...stages)` accepts at most 4096 items and up to four lanes. **A thrown stage makes that item's result `null`; it does not fail the run.** Branch on `null`:

```js
const processed = await pipeline(files, (file) => agent(`Summarize ${file}.`, { access: "readOnly" }));
const failed = files.filter((_, index) => processed[index] === null);
```

Always await every `agent()`, `followUp()`, and `consult()` call before returning from the default function. A forgotten promise fails the workflow rather than silently losing the child result.

`agent("task", { harness: "codex", speed: "fast" })` explicitly opts one Codex lineage into Fast mode. Omit `speed` for standard policy. A selected profile never supplies this opt-in. Fast is unsupported by Pi and Claude, does not choose a route for `harness: "auto"`, and cannot combine with provider or continuation fallback.

## Continuing a retained agent with followUp

`followUp(jobId, prompt, options?)` reuses a successfully completed `agent()` call's retained session. It is the only supported return to earlier reasoning:

```js
phase("plan");
const planner = await agent("Plan the change.", { name: "planner", access: "readOnly" });

phase("implement");
const implementation = await agent(`Implement this plan:\n${planner.output}`, { name: "implementer", access: "full" });

phase("review");
const review = await followUp(planner.jobId, "Review the current implementation against your plan.");
if (!review.ok) return { ok: false, error: review.error };
```

Rules:

- The target must be this run's completed retained `agent()` lineage. Its logical ID is stable across continuation and follow-ups. Cross-workflow, direct, expired, failed, cancelled and unsettled jobs are rejected.
- `options` accepts only `phase` and `schema`. Harness, model, effort, speed, access, cwd, trust, profile, capability route, and nesting policy are fixed at the original `agent()` call.
- A retained native structured session stays bound to its original schema. Every `followUp()` on that lineage is validated against the original schema and can return `structured` even when the call omits `schema`; a follow-up cannot replace the schema.
- An `agent()` call that used `isolation: "worktree"` can never be targeted: its worktree is finalized when the call returns, so the follow-up is rejected whether the recorded state is `preserved`, `removed`, or `orphaned`.
- Each `followUp()` consumes its own agent-call ordinal from the same 32-call budget and appears in `/workflows` as another generation under the same agent, not a new agent card.
- `followUp()` never provider-waits. It fails immediately unless its original `agent()` explicitly opted into eligible progressed continuation.

## Provider recovery

A fresh explicit Claude/Codex `agent()` may set one opposite native route. `providerFallback: { harness, model? }` handles authoritative pre-inference failure with zero usage; after dispatch it also requires `readOnly`.

`continuationFallback: { harness, model? }` permits one handoff after authoritative unavailability and current-turn progress, including follow-ups. Progress proof blocks primary replay. Queued admission rechecks readiness and requirements, then checkout and budget under the startup deadline. Schema, policy, budgets, usage, cancellation, logical ID, and provider independence stay fixed, including on replay. Unsafe state, unavailable target, isolation, or replacement failure is terminal; no wait or loop.

## Consulting an advisor

`consult(advisorId, question, { phase?, context? })` reaches a thread advisor whose stable ID is in the tool's `advisors` allowlist. Advisor calls, active turns, per-call tokens, usage, and Codex cost support meet the same enforcement, warnings, and dashboard metrics as agents, and dispatch uses the workflow lane of the global four-turn scheduler so direct work keeps priority. Calls are journaled with identity, lineage/generation, completed route, usage, queue delay, bounded result, and provenance; cancellation reaches queued and active calls.

## Sandbox limits and determinism

- The sandbox exposes only orchestration: no imports, I/O, environment, processes, credentials, or nested delegation.
- Workflows are deterministic: `Date.now()`, zero-argument `new Date()`, and `Math.random()` all throw.
- Workflow data is bounded and JSON-serializable; one agent request is capped at 512 KiB.
- A run may make at most 32 calls (`agent()`, `followUp()`, and `consult()` share the budget) and use at most four concurrent workers. Routed questions are bounded separately at 32 per run and never consume a call ordinal.
- Mutating agents sharing one checkout are serialized; read-only and worktree-isolated calls are not.

## Lifecycle versus task outcome

Workflow lifecycle and task outcome are separate. Sandbox completion sets lifecycle `completed`. A top-level plain object with `ok: true` has outcome `successful`; `ok: false` has outcome `unsuccessful`; every other result is `unspecified`. Script and runtime errors still fail the run, while cancellation, shutdown, and stale restoration abort it. Completed child journal calls stay replayable even when the containing workflow outcome is unsuccessful.

## Authoring failures

- `Unexpected identifier` or another parse error: the script is JavaScript. Escape or avoid backticks and other template-literal delimiters in embedded prompts.
- `Cannot destructure ... of null`: use the default async function with the injected globals; do not assume a callback context object.
- `parallel tasks must be functions`: wrap every agent call in `() => agent(...)`.
- `Workflow returned before N agent call(s) settled`: await all calls, including calls started in loops or branches.
