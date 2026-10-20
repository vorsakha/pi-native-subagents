import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";

const workerUrl = new URL("./worker.mjs", import.meta.url);
const guardPolicy = createHash("sha256").update(readFileSync(workerUrl)).digest("hex");

/** Stop before Durable admits oversized or unbounded tool tasks, including direct calls bypassing helpers. */
export class WorkflowCodemodeSandbox extends CodemodeSandbox {
  readonly #onFailure: (message: string) => Promise<void>;

  constructor(options: CodemodeSandboxOptions, onFailure: (message: string) => Promise<void>) {
    super({ ...options, workerUrl });
    this.#onFailure = onFailure;
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let calls = 0;
    const nativeCalls = new Set<number>();
    let failure: string | undefined;
    const run = super.start(`if (globalThis.__workflowGuardPolicy !== ${JSON.stringify(guardPolicy)}) throw new Error("Workflow global guards were not installed");\n${code}`, {
      ...options,
      signal,
      onStarted(fingerprint) {
        options.onStarted?.(`workflow-guards ${guardPolicy}; ${fingerprint}`);
      },
      onCall(call) {
        const input = call.args;
        const operation = input && typeof input === "object" && "operation" in input ? input.operation : undefined;
        const maximum = operation === "result" ? 1024 * 1024 + 128 : 512 * 1024;
        if (++calls > 600) failure = "Workflow sandbox exceeded its 600 host-call limit";
        else if (Buffer.byteLength(JSON.stringify(input) ?? "null") > maximum) {
          failure = operation === "result" ? "Workflow result exceeds the 1 MiB limit" : "Workflow request exceeds the 512 KiB limit";
        }
        if (call.name === "workflow_agent") nativeCalls.add(call.id);
        if (call.name === "workflow_event" && operation === "result" && nativeCalls.size > 0) {
          failure = "Workflow returned before native calls settled; await every agent() or direct tool call";
        }
        if (failure) controller.abort();
        else options.onCall(call);
      },
    });
    return {
      get finished() { return run.finished; },
      deliver(seq, now, id, outcome) {
        nativeCalls.delete(id);
        run.deliver(seq, now, id, outcome);
      },
      result: run.result.then(async (result): Promise<CodemodeResult> => {
        const normalized: CodemodeResult = failure
          ? { ok: false, error: { kind: "sandbox", message: failure }, output: result.output, calls: result.calls }
          : result;
        if (!normalized.ok) await this.#onFailure(normalized.error.message);
        return normalized;
      }),
    };
  }
}
