// This worker alone intercepts the pinned public QuickJS factory. Code-mode still
// owns transport, VM driving, lockdown, deterministic scheduling, and termination.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { QuickJS } from "quickjs-wasi";

const require = createRequire(import.meta.url);
const codemodeRequire = createRequire(import.meta.resolve("@earendil-works/pi-codemode"));
if (realpathSync(require.resolve("quickjs-wasi")) !== realpathSync(codemodeRequire.resolve("quickjs-wasi"))) {
  throw new Error("Workflow guards require the same pinned QuickJS module as code-mode");
}
const policy = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const create = QuickJS.create.bind(QuickJS);
QuickJS.create = async (...args) => {
  const vm = await create(...args);
  try {
    vm.evalCode(`
      (() => {
        const NativeDate = globalThis.Date;
        function WorkflowDate(...values) {
          if (!new.target || values.length === 0) {
            throw new Error("new Date() is not available in deterministic workflows; pass an explicit value");
          }
          return Reflect.construct(NativeDate, values, new.target);
        }
        Object.defineProperties(WorkflowDate, {
          prototype: { value: NativeDate.prototype },
          now: { value() { throw new Error("Date.now() is not available in deterministic workflows"); } },
          parse: { value: NativeDate.parse },
          UTC: { value: NativeDate.UTC },
        });
        Object.defineProperty(NativeDate.prototype, "constructor", { value: WorkflowDate, writable: false });
        Object.defineProperty(globalThis, "Date", { value: WorkflowDate });
        Object.defineProperty(Math, "random", {
          value() { throw new Error("Math.random() is not available in deterministic workflows"); },
        });
        Object.defineProperty(globalThis, "__workflowGuardPolicy", { value: ${JSON.stringify(policy)} });
      })();
    `, "workflow-global-guards.js").dispose();
    return vm;
  } catch (error) {
    vm.dispose();
    throw error;
  }
};

await import("@earendil-works/pi-codemode/worker");
