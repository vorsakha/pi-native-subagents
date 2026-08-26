# Workflow authoring

Read this before writing or editing a workflow script. It covers the source contract, the sandbox API, phases, fan-out shapes, `followUp()`, and how a run's lifecycle differs from its task outcome.

## Source and input contract

The `workflow` tool accepts exactly one source:

- `script` — inline JavaScript;
- `workflowName` — a saved user/project definition;
- `scriptPath` — a trusted project-local script.

Use zero or one input form: structured `input` or the legacy JSON-string `args`, never both. The selected value is exposed to the script as the global `args`; omitting both exposes `null`. Workflows must be trusted and use a source contained by the trusted project rules.

`approval: "plan"` is for read-only planning; `approval: "onMutate"` requires a host confirmation before mutation; `approval: "auto"` is the unprompted default.

`background: true` returns a start snapshot; completion is delivered as one follow-up and remains inspectable with `/workflows`.

## Script shape and globals

A workflow script must export a default async function. The helpers are globals, not a context object:

- `args` — parsed workflow input;
- `phase(title)` — report bounded progress;
- `log(message)` — report bounded progress text;
- `agent(prompt, options)` — request one generic child and return a result object;
- `followUp(jobId, prompt, options)` — continue a completed `agent()` call's own retained native session and return the same result shape;
- `parallel(tasks, { concurrency })` — run deferred tasks with a bounded worker pool;
- `pipeline(items, ...stages)` — process independent items through ordered stages;
- `converge(options)` — run a bounded implement/review/fix loop over two retained sessions;
- `convergenceReviewSchema` — the review schema `converge()` validates every verdict against.

Do not write the function as if it receives a context object such as `async ({ phase, agent }) => ...`. Positional helper arguments are retained for compatibility, but the global API is the canonical form.

## Declared phases

For a workflow with a known plan, add `phases` to the exported metadata:

```js
export const meta = { name: "release review", phases: ["review", "verify", "summarize"] };
```

The plan accepts 1–64 unique names; names are trimmed and internal whitespace is collapsed, matching is case-sensitive, and each normalized name is limited to 160 characters. Declared phases appear as pending before the first `phase(title)` call, and `phase(title)` must activate them forward in plan order (conditional phases may be skipped). Repeating the active phase is harmless; use `phase(title)` to advance rather than `agent({ phase })`. Omit `meta.phases` when phases are discovered dynamically.

## parallel versus pipeline

`parallel` receives functions, not already-started promises — the runner owns invocation order, concurrency, call numbering, cancellation, and replay. Concurrency is an integer from 1 to 4 and defaults to 4. Use `parallel` when the next step needs the complete result set; check every returned result's `ok`.

`pipeline(items, ...stages)` accepts at most 4096 items, advances each item through the ordered stages independently with up to four concurrent lanes, and needs no global barrier between stages. **A stage that throws does not fail the run: that item's slot in the returned array becomes `null`.** Filter or branch on `null` explicitly, and never assume the returned array is item-shaped throughout:

```js
const processed = await pipeline(files, (file) => agent(`Summarize ${file}.`, { access: "readOnly" }));
const failed = files.filter((_, index) => processed[index] === null);
```

Always await every `agent()`/`followUp()` call before returning from the default function. A forgotten promise fails the workflow rather than silently losing the child result.

## Continuing a retained agent with followUp

`followUp(jobId, prompt, options?)` sends another turn to an `agent()` call this same workflow run already completed successfully, reusing its retained native session instead of starting a fresh child. This is the only supported way to return to earlier reasoning:

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

- The target must be a job this run's own `agent()` call started, still `completed`, with a retained session. Cross-workflow, direct `subagent_spawn`, expired, failed, cancelled, and not-yet-settled jobs are all rejected.
- `options` accepts only `phase` and `schema`. Harness, model, effort, access, cwd, trust, profile, capability route, and nesting policy are fixed at the original `agent()` call.
- A retained native structured session stays bound to its original schema. Every `followUp()` on that lineage is validated against the original schema and can return `structured` even when the call omits `schema`; a follow-up cannot replace the schema.
- An `agent()` call that used `isolation: "worktree"` can never be targeted: its worktree is finalized when the call returns, so the follow-up is rejected whether the recorded state is `preserved`, `removed`, or `orphaned`.
- Each `followUp()` consumes its own agent-call ordinal from the same 32-call budget and appears in `/workflows` as another generation under the same agent, not a new agent card.
- `followUp()` never waits out a provider-quota rejection, even under `retry.providerUnavailable: "wait"`. It always fails immediately; retry with a fresh `agent()` call instead.

## Sandbox limits and determinism

- The sandbox allows workflow orchestration only: no imports, filesystem, network, environment variables, subprocesses, credentials, `require`, `process`, or nested delegation.
- Workflows are deterministic: `Date.now()`, zero-argument `new Date()`, and `Math.random()` all throw.
- Results, metadata, agent requests, logs, phases, source, and arguments are bounded and must be JSON-serializable; a single agent request is capped at 512 KiB.
- A run may make at most 32 agent calls (`agent()` and `followUp()` share the budget) and use at most four concurrent workers. Routed questions are bounded separately at 32 per run and never consume a call ordinal.
- Mutating agents sharing one checkout are serialized; read-only and worktree-isolated calls are not.

## Lifecycle versus task outcome

Workflow lifecycle and task outcome are separate. Sandbox completion sets lifecycle `completed`. A top-level plain object with `ok: true` has outcome `successful`; `ok: false` has outcome `unsuccessful`; every other result is `unspecified`. Script and runtime errors still fail the run, while cancellation, shutdown, and stale restoration abort it. Completed child journal calls stay replayable even when the containing workflow outcome is unsuccessful.

## Authoring failures

- `Unexpected identifier` or another parse error: the script is JavaScript. Escape or avoid backticks and other template-literal delimiters in embedded prompts.
- `Cannot destructure ... of null`: use the default async function with the injected globals; do not assume a callback context object.
- `parallel tasks must be functions`: wrap every agent call in `() => agent(...)`.
- `Workflow returned before N agent call(s) settled`: await all calls, including calls started in loops or branches.
