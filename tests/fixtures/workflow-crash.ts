import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobManager } from "../../src/manager.ts";
import { aggregateWorkflowUsage, WorkflowManager } from "../../src/workflows/manager.ts";
import { ControlledBackend } from "../helpers.ts";

const [mode, directory, operation = "agent"] = process.argv.slice(2);
if (!directory || !["run", "recover"].includes(mode) || !["agent", "followUp"].includes(operation)) {
  throw new Error("Expected crash-fixture mode, directory, and native operation");
}
const backend = new ControlledBackend("codex");
const jobs = new JobManager({ backends: [backend] });
const workflows = new WorkflowManager({ jobs, artifactRoot: join(directory, "runs"), sessionId: "crash-session" });
const request = {
  sessionId: "crash-session", name: "crash recovery", cwd: directory, trusted: true,
  defaultHarness: "codex" as const,
  script: `export const meta = { phases: ["before", "after"] };
    export default async () => {
      const guards = [];
      for (const operation of [
        () => globalThis.Date.now(),
        () => new globalThis.Date(),
        () => globalThis.Math.random(),
        () => Function("return globalThis.Math.random()")(),
        () => (async function () {}).constructor("return Date.now()")(),
      ]) {
        try { await operation(); throw new Error("Deterministic guard escaped"); }
        catch (error) {
          if (!error.message.includes("not available in deterministic workflows")) throw error;
          guards.push(error.message);
        }
      }
      phase("before");
      const done = await agent("done", { access: "readOnly" });
      const interrupted = await ${operation === "followUp"
        ? 'followUp(done.jobId, "interrupted")'
        : 'agent("interrupted", { access: "readOnly" })'};
      phase("after");
      const after = await agent("after " + JSON.stringify({ interrupted, guards }), { access: "readOnly" });
      return { done, interrupted, after };
    };`,
};
try {
  if (mode === "run") {
    const started = await workflows.start(request);
    await writeFile(join(directory, "run-id"), started.snapshot.runId);
    await backend.waitForStart(1);
    await appendFile(join(directory, "calls"), "done\n");
    backend.complete(backend.starts[0]!, "done", { input: 7, output: 3, turns: 1 });
    if (operation === "followUp") await backend.waitForSend(1);
    else await backend.waitForStart(2);
    await appendFile(join(directory, "calls"), "interrupted\n");
    process.stdout.write("READY\n");
    await started.completion;
  } else {
    const runId = await readFile(join(directory, "run-id"), "utf8");
    const started = await workflows.start({ ...request, resumeFromRunId: runId });
    if (started.snapshot.runId !== runId) throw new Error("Recovery replaced the run instead of recovering its Durable task");
    await backend.waitForStart(1);
    if (!backend.requests[0]?.task.startsWith("after {")) throw new Error("Recovery redispatched completed or interrupted native work");
    await appendFile(join(directory, "calls"), "after\n");
    backend.complete(backend.starts[0]!, "after");
    const final = await started.completion;
    const originalInterrupted = final.agents[operation === "followUp" ? 0 : 1];
    const originalJobId = originalInterrupted?.logicalJobId ?? originalInterrupted?.jobId;
    assert.ok(originalJobId, "inspection retains the interrupted native lineage");
    await assert.rejects(workflows.start({
      ...request, resumeFromRunId: runId, restartFromCallIndex: 1,
    }), /interrupted native work/, "recovery retains the unsafe native intent");
    const unexpectedDispatch = backend.waitForStart(2).then(() => {
      throw new Error("Finished replay redispatched completed downstream work");
    });
    let replayed = final;
    for (let replayIndex = 0; replayIndex < 2; replayIndex++) {
      const replay = await workflows.start({ ...request, resumeFromRunId: replayed.runId });
      replayed = await Promise.race([replay.completion, unexpectedDispatch]);
      assert.equal(JSON.stringify(replayed.result), JSON.stringify(final.result), "finished replay preserves whole public values");
      assert.equal(replayed.status, "completed");
      assert.equal(backend.requests.length, 1, "finished replay dispatches no native work");
      const interrupted = replayed.agents.find((agent) => agent.callIndex === 1);
      assert.equal(interrupted?.unsafeToReplay, true, "replay retains the unsafe native intent");
      assert.equal(interrupted?.logicalJobId ?? interrupted?.jobId, originalJobId, "replay retains internal lineage identity");
      await assert.rejects(workflows.start({
        ...request, resumeFromRunId: replayed.runId, restartFromCallIndex: 1,
      }), /interrupted native work/, "suffix restart cannot discard the copied unsafe proof");
    }
    process.stdout.write(JSON.stringify({ status: final.status, result: final.result, agents: final.agents.map((agent) => agent.state), usage: aggregateWorkflowUsage(final) }) + "\n");
  }
} finally {
  await workflows.shutdown();
  await jobs.shutdown();
}
