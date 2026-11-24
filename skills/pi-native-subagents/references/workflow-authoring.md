# Workflow authoring

Pass exactly one source to the `workflow` tool. Use `script` for inline JavaScript, `scriptPath` for a trusted project-local `.js` or `.mjs` file, or `workflowName` for a saved definition. A project definition in `.pi/workflows/` takes precedence over a user definition with the same name.

Pass structured JSON as `input`, or use `args` for a legacy JSON string. Both expose the decoded value as the global `args` in the script. Omit both for `null`. Use `background: true` for work that should return a run ID immediately or may need a parent answer. Completion arrives as a follow-up.

Approval defaults to `"auto"`. Use `approval: "plan"` and explicitly give every child `access: "readOnly"` for read-only planning. Use `approval: "onMutate"` when the host should confirm before the first mutating call.

## Collect parallel reviews

Export a default async function. Call the helpers as globals. This script reviews two modules and returns each review, including any failed call's error.

```js
export const meta = { name: "retry-review", phases: ["review"] };

export default async function () {
  phase("review");
  const files = ["src/manager.ts", "src/workflows/manager.ts"];
  const reviews = await parallel(
    files.map((file) => () => agent(`Review retry handling in ${file}. Cite each finding.`, {
      name: file,
      access: "readOnly",
    })),
    { concurrency: 2 },
  );

  return { ok: reviews.every((review) => review.ok), reviews };
}
```

Declare `meta.phases` when the plan is known. Use 1–64 distinct names of up to 160 characters. Call `phase(title)` in declared order with matching case. Conditional phases may be skipped. Omit the list for dynamic phases. Use `log(message)` for brief progress updates.

Use `parallel(tasks, { concurrency })` when the next step needs all the results. Pass functions that start the work when called. Concurrency is 1–4 and defaults to 4. For independent multi-stage items, use `pipeline(items, ...stages)`. Each stage receives the previous value, original item, and index. A thrown stage leaves that item as `null`. A failed agent call returns an object with `ok: false`. Handle both before consuming the result. Pipelines accept up to 4,096 items across four lanes.

## Use the result

An `agent()` or `followUp()` call resolves to `{ ok, output, structured?, jobId?, error?, usage? }`. Check `ok` before using `output` or starting dependent work. For a schema-constrained call, use the validated `structured` value directly. Let the runtime handle native and portable JSON transport. Invalid or missing data yields a failed call.

Use `followUp(jobId, prompt, options?)` to reuse a successfully completed, retained session from this run. Check the producer's `ok` and `jobId` first. The only follow-up options are `phase` and `schema`. A native schema-bound session keeps its original schema even if omitted. A follow-up inherits access and routing policy and consumes another call. Finalized worktrees, failed or evicted jobs, and jobs from other runs cannot be continued.

```js
export default async function () {
  const plan = await agent("Plan the retry change described in docs/retry.md.", { access: "readOnly" });
  if (!plan.ok || !plan.jobId) {
    return { ok: false, error: plan.error ?? "Planner has no retained job", jobId: plan.jobId };
  }

  const change = await agent(`Implement this plan and verify the changes:\n${plan.output}`, { access: "full" });
  if (!change.ok) {
    return change;
  }

  return await followUp(plan.jobId, "Review the working tree against your plan. Report unresolved findings.");
}
```

Return a top-level object with `ok: true` for a successful task or `ok: false` with bounded failure evidence for an unsuccessful one. Other results leave the task outcome unspecified. An exception or stalled promise fails the run itself.

## Sandbox boundaries

- Keep orchestration deterministic. The script has no imports, filesystem, network, environment, credentials, or subprocesses. Reading the current time or using `Math.random()` throws. Pass needed data through JSON input or validated child results.
- Await every native call, including calls launched in loops. Returning early fails the run. A run permits 32 native calls, four concurrent jobs, and 600 script-to-host calls. An agent request is capped at 512 KiB.
- Writers in the same workflow sharing a checkout are serialized. Use clean-source worktree isolation for concurrent writers only when their work can finish in one call.
