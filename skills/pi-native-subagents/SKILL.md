---
name: pi-native-subagents
description: Use when invoking the Pi Native Subagents extension or writing a sandboxed workflow. Covers direct native subagent spawning, capability requirements, provider independence, workflow script shape, deferred parallel tasks, budgets, isolation, replay, and failure recovery.
---

# Pi Native Subagents

Use this skill whenever the task calls `subagent_spawn`, `subagent_capabilities`, `workflow`, or another tool from the Pi Native Subagents extension. This skill documents the package contract; the host's routing skill decides model, harness, effort, and quota preferences.

## Choose the smallest orchestration surface

- Use `subagent_spawn` for one job or a small independent fan-out. Use `subagent_wait`, `subagent_check`, `subagent_send`, and `subagent_cancel` with the returned job ID when the parent must manage the jobs explicitly.
- Use `workflow` for phases, bounded parallelism, pipelines, structured fan-in, saved definitions, background execution, replay, or durable progress. Do not wrap a simple two-agent review in a workflow only to run two calls.
- Use `subagent_capabilities` before setting `requires`. Capability IDs are live values; never invent them.
- A child cannot delegate again. Do not ask a child to call subagent or workflow tools.

## Direct native subagents

Give every child a self-contained task packet:

- objective and relevant paths;
- current facts and constraints;
- required access level;
- expected result format;
- focused acceptance checks and verification evidence.

Usage rules:

- Use `access: "readOnly"` for inspection, review, and planning. Request `full` only when mutation is required and the project is trusted.
- Omit `model` unless a concrete harness-local override is needed. A model name is not a cross-harness tier, and `harness: "auto"` rejects harness-local model overrides.
- Use `harness: "auto"` when capability or provider failover may choose the route. Auto routing live-checks native model/auth readiness before dispatch; an explicit harness remains fail-closed.
- Use `requires` only with IDs returned by `subagent_capabilities`; pair it with `harness: "auto"` when any capable harness is acceptable.
- Use `independent: true` only when the child must use a different native provider from the parent. A different model on the same provider is not independent.
- Use `independentOf: "<producer-job-id>"` when a reviewer must differ from the provider that produced the reviewed work. The target must be an existing job.
- Omit `profile` unless the human explicitly names one. Profiles may impose access, harness, or routing ceilings.
- At most four jobs run concurrently. Prefer direct spawning over manually recreating workflow scheduling.

Example:

```ts
const capabilities = await subagent_capabilities({
  query: "browser",
  access: "readOnly",
});

const review = await subagent_spawn({
  name: "security-review",
  task: "Review src/auth.ts for privilege-escalation risks. Return findings with file paths, severity, and focused verification steps.",
  access: "readOnly",
  harness: "auto",
  requires: ["<capability-id-from-discovery>"],
});

await subagent_wait({ jobId: review.jobId, timeoutMs: 600_000 });
```

## Workflow input and source contract

The `workflow` tool accepts exactly one source:

- `script`: inline JavaScript;
- `workflowName`: a saved definition;
- `scriptPath`: a trusted project-local script.

Use either structured `input` or legacy JSON-string `args`, never both. The selected value is exposed to the script as the global `args` object. Workflows must be trusted and use a source contained by the trusted project rules.

A workflow script must export a default async function. Workflow helpers are globals: use phase(), log(), agent(), and parallel(). The available globals are:

- `args` — parsed workflow input;
- `phase(title)` — report bounded progress;
- `log(message)` — report bounded progress text;
- `agent(prompt, options)` — request one generic child and return a result object;
- `parallel(tasks, { concurrency })` — run deferred tasks with a bounded worker pool;
- `pipeline(items, ...stages)` — process independent items through ordered stages.

Use the globals directly. Do not write the function as if it receives a context object such as `async ({ phase, agent }) => ...`. Positional helper arguments are retained for compatibility, but the global API is the canonical form.

Canonical workflow:

```js
export const meta = { name: "parallel-review" };

export default async function () {
  phase("review");

  const reviews = await parallel(
    [
      () => agent("Review the API for correctness. Return concise findings and verification evidence.", {
        name: "correctness",
        access: "readOnly",
      }),
      () => agent("Review the API for security and isolation risks. Return concise findings and verification evidence.", {
        name: "security",
        access: "readOnly",
        independent: true,
      }),
    ],
    { concurrency: 2 },
  );

  const failures = reviews.filter((review) => !review.ok);
  if (failures.length) return { ok: false, failures, reviews };
  return { ok: true, reviews };
}
```

## Deferred parallel tasks are mandatory

`parallel` receives functions, not already-started promises.

Correct:

```js
await parallel([
  () => agent("first", { access: "readOnly" }),
  () => agent("second", { access: "readOnly" }),
]);
```

Incorrect:

```js
await parallel([
  agent("first", { access: "readOnly" }),
  agent("second", { access: "readOnly" }),
]);
```

The workflow runner owns invocation order, concurrency, call numbering, cancellation, and replay. Always await every `agent()` call before returning from the default function. A forgotten promise causes the workflow to fail rather than silently losing the child result.

Use `parallel` when the next step needs the complete result set. Use `pipeline` when each item can advance through its own stages without a global barrier. Check every returned agent result's `ok` field and preserve bounded error details in the final result.

## Dashboard supervision

- `/subagents` opens the adaptive dashboard through Pi's public overlay API; fullscreen mode uses the available terminal height without replacing Pi's host layout root.
- Wide terminals show a jobs rail beside the selected inspector; narrower terminals stack or drill into a single pane. `j/k` or arrows select, `Enter` enters in-panel takeover, and `Esc` backs out before closing.
- Fullscreen-safe transcript navigation is `Shift+↑↓`, `Ctrl+U/D`, and `g/G`; Page Up/Down are compatibility aliases only and are not the primary fullscreen controls.
- Cancellation is intentionally two-step: press `x` once to arm it and again to confirm. Failed steer/follow-up submissions retain the draft when the request fails.
- `/subagents providers` reports each native provider as installed, authenticated, or ready, with the masked account email, plan, auth method, and Pi's selected model. `/subagents providers refresh` re-probes. It reads account and auth state only: no model request is made, credentials are never displayed, and Pi exposes no account email.

## Runtime limits and lifecycle

- The sandbox allows workflow orchestration only; it does not allow imports, filesystem, network, environment variables, subprocesses, credentials, `require`, `process`, or nested delegation.
- Workflows are deterministic: do not use `Date.now()`, zero-argument `new Date()`, or `Math.random()`.
- Results, metadata, agent requests, logs, phases, source, and arguments are bounded and must be JSON-serializable.
- A workflow may make at most 32 agent calls and use at most four concurrent workers.
- `background: true` returns a start snapshot; completion is delivered as one follow-up and remains inspectable with `/workflows`.
- `resumeFromRunId` replays every independently matching completed call, including later calls from a parallel batch when an earlier lane failed. Failed, incomplete, duplicated, or fingerprint-mismatched ordinals rerun. Keep source, input, project, and routing context identical; only increase replay budgets when the runtime permits it.
- `approval: "plan"` is for read-only planning. Use `approval: "onMutate"` when a workflow may mutate and host approval is required.
- Mutating agents sharing one checkout are serialized. Use `isolation: "worktree"` for explicit clean-worktree concurrency and preserve the resulting patch metadata.
- `maxAgents` and `maxConcurrency` limit work shape. `maxTokens` limits aggregate fresh input plus output; cached reads remain visible but do not consume that budget. `maxTokensPerAgent` applies the same ceiling to one child. `maxCost` and `maxTurns` remain aggregate, and `maxTurns` is not a per-agent allowance. Native context occupancy is displayed separately when exposed by the harness.

## Common failures and corrections

- `Unexpected identifier` or another parse error: the script is JavaScript. Escape or avoid backticks and other template-literal delimiters in embedded prompts.
- `Cannot destructure ... of null`: use the default async function with the injected globals; do not assume a callback context object.
- `parallel tasks must be functions`: wrap every agent call in `() => agent(...)`.
- `Workflow returned before N agent call(s) settled`: await all calls, including calls started in loops or branches.
- `Workflow token budget exceeded`: narrow the offending lane before raising the aggregate fresh-input/output allowance; use `maxTokensPerAgent` to contain one runaway child.
- `Workflow turn budget exceeded`: the budget covers aggregate child turns. Increase it with realistic orchestration overhead, or use direct `subagent_spawn` for a small fan-out.
- `independent` rejected for the same provider: independence means provider diversity, not model escalation. Omit it for same-provider escalation or route to the opposite provider.
- Requirement rejected: rediscover capabilities with `subagent_capabilities`, use the returned ID, and keep the access ceiling consistent.
- A harness rejected for login or readiness: check `/subagents providers` to see which provider is authenticated and ready before retrying, and switch routes rather than guessing at the account state.
- A workflow or child fails: inspect the returned `ok`, `error`, route, and job ID; use `/workflows` for durable workflow state. Do not hide a failed route behind a success-only summary.

## Safe routing defaults

- Prefer generic task-driven children over role-specific prompts or fixed model tiers.
- Keep reviewers read-only unless mutation is explicitly required.
- Make harness, model, effort, access, independence, and verification requirements explicit when the human asks for them.
- Keep private transcripts and workflow artifacts out of Git. The extension's durable artifacts are for bounded inspection, not for copying into prompts wholesale.
