import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";

/** Stop before Durable admits oversized or unbounded tool tasks, including direct calls bypassing helpers. */
export class WorkflowCodemodeSandbox extends CodemodeSandbox {
  readonly #onFailure: (message: string) => Promise<void>;

  constructor(options: CodemodeSandboxOptions, onFailure: (message: string) => Promise<void>) {
    super(options);
    this.#onFailure = onFailure;
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let calls = 0;
    let failure: string | undefined;
    const run = super.start(code, {
      ...options,
      signal,
      onCall(call) {
        const input = call.args;
        const operation = input && typeof input === "object" && "operation" in input ? input.operation : undefined;
        const maximum = operation === "result" ? 1024 * 1024 + 128 : 512 * 1024;
        if (++calls > 600) failure = "Workflow sandbox exceeded its 600 host-call limit";
        else if (Buffer.byteLength(JSON.stringify(input) ?? "null") > maximum) {
          failure = operation === "result" ? "Workflow result exceeds the 1 MiB limit" : "Workflow request exceeds the 512 KiB limit";
        }
        if (failure) controller.abort();
        else options.onCall(call);
      },
    });
    return {
      get finished() { return run.finished; },
      deliver: run.deliver.bind(run),
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
