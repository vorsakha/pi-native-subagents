import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobManager } from "../../src/manager.ts";
import { aggregateWorkflowUsage, WorkflowManager } from "../../src/workflows/manager.ts";
import { ControlledBackend } from "../helpers.ts";

const [mode, directory] = process.argv.slice(2);
if (!directory || !["run", "recover"].includes(mode)) throw new Error("Expected crash-fixture mode and directory");
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
      const interrupted = await agent("interrupted", { access: "readOnly" });
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
    await backend.waitForStart(2);
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
    const replay = await workflows.start({ ...request, resumeFromRunId: runId });
    const replayed = await replay.completion;
    if (JSON.stringify(replayed.result) !== JSON.stringify(final.result)) throw new Error("Finished replay changed public values");
    if (backend.requests.length !== 1 || replayed.status !== "completed") throw new Error("Finished replay redispatched interrupted native work");
    process.stdout.write(JSON.stringify({ status: final.status, result: final.result, agents: final.agents.map((agent) => agent.state), usage: aggregateWorkflowUsage(final) }) + "\n");
  }
} finally {
  await workflows.shutdown();
  await jobs.shutdown();
}
