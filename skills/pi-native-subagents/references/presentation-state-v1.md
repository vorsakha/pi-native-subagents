# Consume public presentation state V1

Subscribe to `native-subagents:state:v1` in the consumer extension factory before `session_start`. Use the event constant, validator, types, and limits exported by `@vorsakha/pi-native-subagents`.

```ts
const dispose = pi.events.on(NATIVE_SUBAGENTS_STATE_EVENT_V1, (value) => {
  if (validateNativeSubagentsStateV1(value)) {
    currentState = value;
  }
});
```

Replace the previous snapshot on each valid event. Dispose the listener with the consumer's lifecycle. The envelope includes `schemaVersion: 1`, producer and session identity, sequence, emission time, cause, truncation counts, jobs, and workflows.

## Track the session

Startup follows workflow restoration. Compare sequence numbers only within one `producer.instanceId`. Reload creates a new instance and restarts numbering at 1. Keep the last valid snapshot until the replacement publishes. A shutdown event marks the session closed and carries final record states as observed. If a final manager read fails, the event may be absent. Never synthesize terminal jobs from a missing event or closed session.

## Interpret the records

- Use `jobs` for top-level job counts. Each job carries its exact status, generation, route, timestamps, and relationships. Use `waitingSummary` for a job waiting on a slot or a question. Workflow agents can additionally have the explicit state `waiting` for a provider retry.
- Use `workflows` for run status, task outcome, and aggregate usage. Use nested agents for a per-run breakdown. A top-level workflow-owned job and its nested agent describe the same execution. Summing usage across both counts it twice.
- Follow `relationships.replayedFrom.runId` and `relationships.replacementOf` when showing replay or restart. Interrupted recovery keeps its run ID. Finished replay creates a replacement run. Restored records do not establish that a native session is still live.
- Render names and bounded summaries as untrusted text. Public result summaries describe lifecycle and task outcome. Keep prompts, questions and answers, transcripts, raw tool output, structured results, paths, and credentials out of this surface.

## Handle partial snapshots

Inspect the truncation counters before presenting counts as complete. `NATIVE_SUBAGENTS_STATE_V1_LIMITS` caps a snapshot at 100 jobs, 64 workflows, 32 agents and 64 phases per run, and 512 KiB overall. IDs are bounded to 200 characters, names to 160, and each summary to 2,000. Summaries and low-priority records may be omitted under the size limit. Nonterminal records take priority, followed by recent activity. Render missing optional values as unknown where the distinction matters.
