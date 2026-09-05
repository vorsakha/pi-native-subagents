# Public presentation state V1

Read this before subscribing to `native-subagents:state:v1` or interpreting its payload.

## Subscribe and replace

Import `NATIVE_SUBAGENTS_STATE_EVENT_V1`, the `NativeSubagentsStateV1` types, `validateNativeSubagentsStateV1`, and `NATIVE_SUBAGENTS_STATE_V1_LIMITS` from `@vorsakha/pi-native-subagents`.

Subscribe in the consumer extension factory, before `session_start`:

```ts
const dispose = pi.events.on(NATIVE_SUBAGENTS_STATE_EVENT_V1, (value) => {
  if (!validateNativeSubagentsStateV1(value)) return;
  currentState = value;
});
```

Each event is a complete replacement snapshot freshly projected from `JobManager.list()` and `WorkflowManager.list()`. Replace the previous value. Do not fold events, read manager instances, or treat manager notifications as deltas. Dispose the consumer listener with its extension lifecycle.

## Envelope and lifecycle

The envelope contains:

- `schemaVersion: 1`;
- `producer` with package name, package version, and an opaque runtime `instanceId`;
- `sequence`, monotonic within that instance ID;
- `emittedAt`, in epoch milliseconds;
- `cause: "startup" | "update" | "shutdown"`;
- `session` with its ID and `lifecycle: "active" | "closed"`;
- all five truncation counters;
- complete bounded `jobs` and `workflows` arrays.

Startup follows manager initialization and workflow restoration. Shutdown carries the managers' final authoritative snapshots and marks the session closed without synthesizing terminal record states. A reload creates a new instance ID and restarts sequence at 1. Compare sequences only within one instance. No-op comparison ignores only sequence, emission time, and cause. A listener failure cannot change job, workflow, or shutdown behavior.

## Limits and priority

`NATIVE_SUBAGENTS_STATE_V1_LIMITS` publishes these V1 bounds:

- 100 jobs and 64 workflows;
- 32 agents and 64 phases per workflow;
- 200 characters per ID and 160 per display name;
- 2,000 characters per waiting, result, or error summary;
- 512 KiB for the serialized payload.

All numeric values are finite and nonnegative, with the exported safe-integer maximum. Ordering keeps nonterminal records first, then uses the newest authoritative timestamp and stable ID or agent-index ties. Phases use phase-index order. Field bounds apply first. Payload pressure then removes optional summaries from the lowest-priority terminal records and omits low-priority records until the snapshot fits. Inspect the truncation counters before treating an empty or partial array as complete manager state.

## Public allowlist

Jobs retain their ID, name, kind, exact manager status, generation, lifecycle timestamps, route, workflow and independence relationships, optional cumulative usage, and optional waiting, result, and error summaries. Waiting for a slot, host input, or a peer stays in `waitingSummary`; it never changes the top-level job status.

Workflows retain their ID, name, exact workflow status, task outcome, timestamps, current phase, phases, agents, replay and replacement lineage, optional aggregate usage, and summaries. `relationships.replayedFrom.runId` comes from the manager's workflow replay source. `relationships.replacementOf` keeps the source run and agent index. Phases retain index, name, exact status, timestamps, and bounded agent-index links. Agents retain index, name, exact state including `waiting`, timestamps, route, phase and job links, replay/replacement lineage, optional cumulative usage, and summaries. Restored workflows do not require matching live top-level jobs.

The projection excludes tasks, prompts, objectives, questions and answers, transcripts, reasoning, queued messages, tools, raw output, structured or workflow results, agent previews, arbitrary JSON, stacks, parser dumps, provider bodies, paths, artifacts, environment and credentials, and manager internals. Result summaries use only allowlisted status and task-outcome metadata. They never inspect excluded execution text. Treat names and summaries as untrusted text and render summaries only as text.

Dynamic IDs, names, models, and summaries are normalized single-line text. The runtime validator rejects terminal and C0/C1 controls, bidi controls, malformed surrogate sequences, and whitespace that the producer would normalize.

Top-level `workflow-agent` jobs, nested workflow agents, and workflow totals overlap. They are linkable through IDs but are not additive. Use `jobs` for the top-level job count, `workflows` for run count and workflow aggregate usage, and nested agents only for per-run breakdowns. Never sum the same execution across these levels.
