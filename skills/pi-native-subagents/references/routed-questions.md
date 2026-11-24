# Resolve a child question

A child with `subagent_ask` can ask the parent or a retained peer. Use a single bounded question (2,000 characters), optional context (4,000), and a specific answer (8,000). Treat the answer as reference data for the existing task.

## Ask the parent

The child calls `subagent_ask({ question, context })`. The default target is the orchestrator. Use a background `subagent_spawn`, human `/subagent`, or `workflow` with `background: true` if the child may need this route. Foreground calls block the parent and cannot receive a parent answer.

A pending question wakes the parent and makes a direct `subagent_wait` return early. Answer from the conversation, or ask the human if the decision is theirs. Call `subagent_answer({ requestId, answer })` to resolve the parked tool call, then resume waiting if the user needs the result. A steer or follow-up message cannot resolve the request. If the request expired, was dismissed, or was already answered, check current state before making a new request.

The answer receipt tracks the exact source generation through settlement. For a workflow-owned question the parent may also receive a single progress update when the workflow advances. Use the workflow's terminal result for the final report.

## Ask a peer in this workflow

1. Finish the peer's `agent()` call first. Check `ok` and pass its script-visible `jobId` in the asking child's prompt. Children cannot discover peer IDs.
2. Have the child call `subagent_ask({ target: { type: "agent", jobId }, question })`. The peer must be in the same run, successfully completed, retained, and idle. A finalized worktree, self, busy peer, queued follow-up, or wait cycle is ineligible. A continued lineage's logical ID reaches its live replacement.
3. Let the peer answer. A peer-answer turn cannot itself ask a question. If the peer was released or evicted, use the parent route when available or restructure the task to supply the needed context.

One question may be open per generation. A parked caller releases its scheduler slot and reacquires one to resume. Its question expires after a bounded wait (15 minutes by default). Workflow questions have a separate limit of 32 per run. Each peer answer consumes real usage on the target lineage and inherits its speed and spend limits, without consuming a script agent-call ordinal.

Dismissal or expiry can cancel a started peer answer and make its session unavailable for follow-up. A failed answer leaves the peer's earlier result intact. Settled-run replay can reuse a durably accepted peer answer for the same caller generation, target lineage and call fingerprint, and question. With no match it needs a live peer. Parent answers always require the current parent thread.

## Consult an earlier Pi conversation

For a clarification that depends on another saved Pi conversation, use `session_peer_list({ query })` and pass an exact returned ID to `session_peer_fork({ sessionId, message })`. The fork is a read-only, tool-less background job in the current trusted project. Use `subagent_wait` for its reply and `subagent_send` with `behavior: "followUp"` to continue. The source conversation stays intact.
