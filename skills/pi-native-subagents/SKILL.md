---
name: pi-native-subagents
description: Use when invoking the Pi Native Subagents extension or writing a sandboxed workflow. Covers direct native subagent spawning, capability requirements, provider independence, workflow script shape, deferred parallel tasks, budgets, isolation, replay, and failure recovery.
---

# Pi Native Subagents

Use this skill whenever the task calls any tool from the Pi Native Subagents extension. This skill documents the package contract. The host's routing skill, not this package contract, decides model, harness, effort, and quota preferences.

## Read the right reference before acting

Paths are relative to this file. Read the reference **before** you write the call, not after it fails.

| Before you… | Read |
| --- | --- |
| write or edit a workflow script, call a saved `workflowName`, declare `meta.phases`, call `followUp()`, or set `approval`/`background`/`pipeline` | `references/workflow-authoring.md` |
| call `converge()` | `references/convergence.md` |
| opt into cross-provider continuation after progressed native failure | `references/progressed-continuation.md` |
| let a child use `subagent_ask`, or answer with `subagent_answer` | `references/routed-questions.md` |
| set spend limits, send a limited retained follow-up, set a workflow `budget`, use `resumeFromRunId`, `providerFallback`, or `retry` | `references/budgets-replay-and-provider-waits.md` |
| use `isolation: "worktree"`, or run `/workflows reclaim` | `references/worktrees-and-retention.md` |
| run `/subagents providers` or `/subagents providers refresh`, supervise or recover a selected job/workflow/agent, report on running work, or interpret usage and model numbers | `references/supervision-and-telemetry.md` |

## Choose the smallest orchestration surface

- Use `subagent_spawn` for one job or a small independent fan-out. Use `subagent_wait`, `subagent_check`, `subagent_send`, and `subagent_cancel` with the returned job ID when the parent must manage the jobs explicitly.
- Use `workflow` for phases, bounded parallelism, pipelines, structured fan-in, saved definitions, background execution, replay, or durable progress. Do not wrap a simple two-agent review in a workflow only to run two calls.
- Use `subagent_capabilities` before setting `requires`. Capability IDs are live values; never invent them.
- A child cannot delegate again. Do not ask a child to call subagent or workflow tools. It may have only one outstanding bounded routed question at a time.

## Direct native subagents

Give every child a self-contained task packet:

- objective and relevant paths;
- current facts and constraints;
- required access level;
- expected result format;
- focused acceptance checks and verification evidence.

Usage rules:

- Use `access: "readOnly"` for inspection, review, and planning. Request `full` only when mutation is required and the project is trusted. Read-only children are sandboxed by construction, not by instruction.
- Omit `model` unless a concrete harness-local override is needed. A model name is not a cross-harness tier, and `harness: "auto"` rejects harness-local model overrides.
- `harness: "auto"` selects an initial ready route; it is not failover. Explicit routes fail closed except for the workflow opt-ins below. Availability checks are read-only and never install, log in, or reconfigure providers.
- Use `requires` only with IDs returned by `subagent_capabilities`; pair it with `harness: "auto"` when any capable harness is acceptable.
- Use `independent: true` only when the child must use a different native provider from the parent. A different model on the same provider is not independent.
- Use `independentOf: "<producer-job-id>"` when a reviewer must differ from the provider that produced the reviewed work. The target must be an existing job.
- Omit `profile` unless the human explicitly names one. Profiles may impose access, harness, or routing ceilings.
- At most four jobs run concurrently, globally, whether work starts directly or through a workflow. Prefer direct spawning over manually recreating workflow scheduling.
- `maxTokens`, `maxCost`, and `maxTurns` are optional; omit all three for an open spend budget. They bind the retained session cumulatively across every follow-up, never just the current turn, and reaching one blocks later follow-ups instead of cancelling active work. Codex reports no cost, so a Codex route with `maxCost` is rejected before dispatch.

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

## Workflow shape

Read `references/workflow-authoring.md` before writing a script. The essentials:

The `workflow` tool accepts exactly one source — `script` (inline JavaScript), `workflowName` (a saved definition), or `scriptPath` (a trusted project-local script) — and zero or one input form, either structured `input` or the legacy JSON-string `args`, never both. The selected value reaches the script as the global `args`; omitting both exposes `null`.

A workflow script must export a default async function and use the injected globals: `args`, `phase()`, `log()`, `agent()`, `followUp()`, `parallel()`, `pipeline()`, `converge()`, and `convergenceReviewSchema`. Do not write it as if it receives a context object such as `async ({ phase, agent }) => ...`.

Pick the right call before you write it. Use `agent(prompt, options)` for new work. Use `followUp(jobId, prompt)` with a `jobId` from this run's completed `agent()` call to return to that child's retained session. Use `converge()` when findings should drive bounded fix rounds.

A fresh workflow call may declare one opposite native fallback:

```js
agent("task", {
  harness: "claude",
  access: "readOnly",
  model: "exact-primary-model",
  providerFallback: { harness: "codex", model: "exact-fallback-model" },
});
```

The primary must explicitly name Claude or Codex and the fallback must name the other. After dispatch this requires `readOnly`, authoritative pre-inference proof, and zero usage; full-access rejection stays terminal. Pre-dispatch missing, unauthenticated, or incompatible readiness may fall back under either access. The target must freshly be ready. Fallback never applies to `followUp()`, ordinary failures, cancellation, worktrees, or a failed fallback, and overrides provider waiting. Read the budget reference first.

A progressed native call needs a different explicit opt-in:

```js
agent("task", {
  harness: "claude",
  continuationFallback: { harness: "codex", model: "exact-replacement-model" },
});
```

This permits one handoff after authoritative unavailability with observed progress. It fails closed unless process cleanup, symbolic/detached HEAD, checkout, capability, and budget proofs hold; replay accepts a continued terminal only from its bound handoff chain. The logical job ID survives replacement and follow-ups, while the primary never replays or falls through to waiting. Do not combine it with `providerFallback` or worktree isolation. Read `references/progressed-continuation.md` first.

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

```js
// Correct
await parallel([
  () => agent("first", { access: "readOnly" }),
  () => agent("second", { access: "readOnly" }),
]);

// Incorrect
await parallel([
  agent("first", { access: "readOnly" }),
  agent("second", { access: "readOnly" }),
]);
```

The workflow runner owns invocation order, concurrency, call numbering, cancellation, and replay. Always await every `agent()` and `followUp()` call before returning from the default function; a forgotten promise fails the workflow rather than silently losing the child result.

Use `parallel` when the next step needs the complete result set. Use `pipeline` when each item can advance through its own stages without a global barrier — but note that **a `pipeline` stage that throws makes that item's result `null` instead of failing the run**, so check for `null` before using an item's result.

## Result semantics

Every `agent()`/`followUp()` call resolves to `{ ok, output, structured?, jobId?, error?, usage? }`.

`output` is always a string of the child's narrative text. On the portable structured path it may be JSON text, but never parse it yourself.

When a call is schema-constrained, supported runtimes may use native structured output and others use the portable JSON fallback. Both paths apply the same schema validation, fail clearly on invalid or missing results, and preserve transport metadata through persistence and replay. This is the same caller-facing contract regardless of which transport was actually selected.

`structured` is the authoritative schema data: it is present when the call succeeded under an effective schema, and it is the already-validated value, ready to use directly. A `followUp()` on a native schema-bound lineage inherits the original `agent()` schema and can return `structured` even when that `followUp()` omitted `schema`. A missing or schema-invalid result is reported as `ok: false` with `structured` left `undefined`, never as a success with narrative-only output. Consume it like this:

```js
const review = await agent("Return a structured verdict.", { name: "reviewer", access: "readOnly", schema });
if (!review.ok || review.structured === undefined) return { ok: false, error: review.error ?? "reviewer returned no structured result" };
const { findings } = review.structured;
```

For schema-validated fields such as `findings`, use `review.structured`; use `review.output` only when you intentionally need the agent's narrative text.

Check every returned result's `ok` field and preserve bounded error details in the final result. Workflow lifecycle and task outcome are separate: a top-level plain object with `ok: true` has outcome `successful`, `ok: false` is `unsuccessful`, and every other result is `unspecified`.

## Hard limits and safety rules

These are enforced by the runtime. Do not design around them.

- **No nested delegation.** Children never receive subagent or workflow capabilities, and cannot answer interactive approvals, escalate permissions, or administer plugins and MCP.
- **Trusted project and cwd containment.** Execution requires a trusted project, and child working directories must stay inside it. Workflow sources must be contained by the same rules.
- **Deny-by-construction read-only.** A read-only child is sandboxed by the native runtime, not asked to behave.
- **Deterministic sandbox.** Workflow code has no imports, filesystem, network, environment variables, subprocesses, credentials, `require`, or `process`. `Date.now()`, zero-argument `new Date()`, and `Math.random()` all throw. Results, metadata, requests, logs, phases, source, and arguments are bounded and must be JSON-serializable.
- **Bounded run shape.** At most 32 agent calls per run (`agent()` and `followUp()` share the budget), at most four concurrent workers, and at most four concurrent jobs globally. Routed questions are bounded separately at 32 per run and never consume a call ordinal.
- **One outstanding routed question per generation.** A turn may have exactly one question open at a time; a second ask is refused until the first settles.
- **Provider independence is provider diversity.** `independent`/`independentOf` select a different native provider, never a bigger model on the same one.
- **Worktree isolation is one-shot and can destroy work.** A finalized worktree can never be continued by `followUp()`, answer a peer question, or be used inside `converge()`. Read `references/worktrees-and-retention.md` before reclaiming or `--force`-discarding any worktree: it may hold the only copy of a child's changed work.
- **Retained sessions are policy-fixed.** Harness, model, effort, access, cwd, trust, profile, capability route, and nesting policy are fixed at the original call; a follow-up may only change `phase` and `schema`.
- **Privacy.** Keep private transcripts, artifacts, credentials, and machine-local runtime state out of Git and out of ordinary model-facing results. Durable artifacts are for bounded inspection, not for copying into prompts wholesale.

## Common failures and corrections

- `Unexpected identifier` or another parse error: the script is JavaScript. Escape or avoid backticks and other template-literal delimiters in embedded prompts.
- `Cannot destructure ... of null`: use the default async function with the injected globals; do not assume a callback context object.
- `parallel tasks must be functions`: wrap every agent call in `() => agent(...)`.
- `Workflow returned before N agent call(s) settled`: await all calls, including calls started in loops or branches.
- `Workflow ... budget exhausted`: active calls have already finished. Narrow the offending lane, raise the explicit boundary, or replay with a compatible larger budget so completed calls can be reused.
- `Budget maxCost is unsupported`: remove the cost boundary or select Pi/Claude. Do not treat Codex's absent cost metric as zero.
- `independent` rejected for the same provider: independence means provider diversity, not model escalation. Omit it for same-provider escalation, or route to the opposite provider.
- Requirement rejected: rediscover capabilities with `subagent_capabilities`, use the returned ID, and keep the access ceiling consistent.
- `Codex app-server exited (0) during an in-progress turn with no terminal result`: a clean mid-turn app-server exit is a Codex lifecycle/result-propagation failure, not proof a `requires` capability is unsupported — pre-dispatch revalidation only confirms the capability was discovered and healthy, not that the turn would exercise it successfully. Retry the job before dropping the requirement.
- A harness rejected for login or readiness: the error names the normalized state (missing executable, login required, incompatible, temporarily unhealthy, or status unknown). Check `/subagents providers` for the active set and each harness's actionable reason, then switch routes or use `harness: "auto"` rather than guessing at the account state. The extension never logs in or installs a CLI for you.
- A workflow or child fails: inspect the returned `ok`, `error`, route, and job ID; use `/workflows` for durable workflow state. Do not hide a failed route behind a success-only summary.
- `/subagents` and `/workflows` use explicit focus layers. Use each contextual `?` legend, press `i` for routine inspector telemetry, and back out one layer at a time. Left edits composer drafts normally. Agent actions require an eligible selected entity that the current view visibly rendered.
- A provider-quota, replay, worktree, or routed-question error: the matching reference above lists the exact message and its recovery.

## Safe routing defaults

- Prefer generic task-driven children over role-specific prompts or fixed model tiers.
- Keep reviewers read-only unless mutation is explicitly required.
- Make harness, model, effort, access, independence, and verification requirements explicit when the human asks for them.
- Unless the caller explicitly asks for a one-shot review, give an implementation/review workflow at least one bounded fix round.
