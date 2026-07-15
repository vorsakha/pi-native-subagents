"use strict";

const vm = require("node:vm");

const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_SOURCE_BYTES = 256 * KIB;
const MAX_ARGS_BYTES = 128 * KIB;
const MAX_RESULT_BYTES = MIB;
const MAX_IPC_BYTES = 512 * KIB;
const MAX_AGENT_CALLS = 32;
const MAX_PHASE_EVENTS = 128;
const RESULT_CHUNK_BYTES = 256 * KIB;

const token = process.argv[2];
if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || typeof process.send !== "function") {
  process.exitCode = 1;
  return;
}

let initialized = false;
let finished = false;
let nextAgentId = 1;
let agentCalls = 0;
let phaseEvents = 0;
const pendingAgents = new Map();

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function frameSize(message) {
  try { return byteLength(JSON.stringify(message)); }
  catch { return MAX_IPC_BYTES + 1; }
}

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

function send(message) {
  const authenticated = { token, ...message };
  if (frameSize(authenticated) > MAX_IPC_BYTES || !process.connected) return false;
  try { return process.send(authenticated); }
  catch { return false; }
}

function failure(message) {
  return JSON.stringify({ ok: false, output: "", error: message });
}

function finishError(error) {
  if (finished) return;
  finished = true;
  const message = errorMessage(error).slice(0, 32 * KIB);
  send({ type: "error", message });
  for (const resolve of pendingAgents.values()) resolve(failure("Workflow sandbox stopped"));
  pendingAgents.clear();
  if (process.connected) process.disconnect();
}

function bridge(operation, payloadJson, resolve) {
  if (finished) {
    if (typeof resolve === "function") resolve(failure("Workflow sandbox stopped"));
    return;
  }
  if (operation === "phase") {
    if (++phaseEvents > MAX_PHASE_EVENTS) return `Workflow phase event limit exceeded (${MAX_PHASE_EVENTS})`;
    if (typeof payloadJson !== "string" || byteLength(payloadJson) > MAX_IPC_BYTES) return "Phase message exceeds the 512 KiB IPC limit";
    let payload;
    try { payload = JSON.parse(payloadJson); }
    catch { return "Phase message is not valid JSON"; }
    if (typeof payload.title !== "string") return "phase requires a string title";
    if (!send({ type: "phase", title: payload.title })) return "Phase message exceeds the 512 KiB IPC limit";
    return undefined;
  }
  if (operation !== "agent" || typeof resolve !== "function") return;
  if (agentCalls >= MAX_AGENT_CALLS) {
    resolve(failure(`Agent call limit exceeded (${MAX_AGENT_CALLS})`));
    return;
  }
  if (typeof payloadJson !== "string" || byteLength(payloadJson) > MAX_IPC_BYTES) {
    resolve(failure("Agent request exceeds the 512 KiB IPC limit"));
    return;
  }
  let payload;
  try { payload = JSON.parse(payloadJson); }
  catch (error) { resolve(failure(`Agent request is not JSON-serializable: ${errorMessage(error)}`)); return; }
  if (typeof payload.prompt !== "string" || !payload.options || typeof payload.options !== "object" || Array.isArray(payload.options)) {
    resolve(failure("agent requires a string prompt and an options object"));
    return;
  }
  const id = nextAgentId++;
  agentCalls++;
  const request = { type: "agent", id, prompt: payload.prompt, options: payload.options };
  if (frameSize({ token, ...request }) > MAX_IPC_BYTES || !send(request)) {
    resolve(failure("Agent request exceeds the 512 KiB IPC limit"));
    return;
  }
  pendingAgents.set(id, resolve);
}
Object.setPrototypeOf(bridge, null);

function installApi(context, argsJson) {
  Object.defineProperty(context, "__workflowBridge", {
    value: bridge,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(context, "__workflowArgsJson", {
    value: argsJson,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  const setup = new vm.Script(`
    (() => {
      "use strict";
      const callHost = globalThis.__workflowBridge;
      const workflowArgs = JSON.parse(globalThis.__workflowArgsJson);
      delete globalThis.__workflowBridge;
      delete globalThis.__workflowArgsJson;
      const asFailure = (error) => ({
        ok: false,
        output: "",
        error: error && typeof error.message === "string" ? error.message : String(error),
      });
      const phaseApi = (title) => {
        if (typeof title !== "string") throw new TypeError("phase requires a string title");
        const error = callHost("phase", JSON.stringify({ title }));
        if (typeof error === "string") throw new Error(error);
      };
      const agentApi = async (prompt, options = {}) => {
        try {
          if (typeof prompt !== "string" || options === null || typeof options !== "object" || Array.isArray(options)) {
            return asFailure(new TypeError("agent requires a string prompt and an options object"));
          }
          const payload = JSON.stringify({ prompt, options });
          if (payload === undefined) return asFailure(new TypeError("Agent request is not JSON-serializable"));
          return await new Promise((resolve) => {
            callHost("agent", payload, (responseJson) => {
              try { resolve(JSON.parse(responseJson)); }
              catch (error) { resolve(asFailure(error)); }
            });
          });
        } catch (error) {
          return asFailure(error);
        }
      };
      const parallelApi = async (items, workerOrConcurrency, maybeConcurrency) => {
        if (!Array.isArray(items)) throw new TypeError("parallel requires an array");
        const hasWorker = typeof workerOrConcurrency === "function";
        const worker = hasWorker ? workerOrConcurrency : (task) => {
          if (typeof task !== "function") throw new TypeError("parallel tasks must be functions");
          return task();
        };
        const specification = hasWorker ? maybeConcurrency : workerOrConcurrency;
        const concurrency = specification === undefined
          ? 4
          : (specification !== null && typeof specification === "object"
            ? specification.concurrency
            : specification);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
          throw new RangeError("parallel concurrency must be an integer from 1 to 4");
        }
        const results = new Array(items.length);
        let cursor = 0;
        const run = async () => {
          while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
        return results;
      };
      Object.defineProperties(globalThis, {
        args: { value: workflowArgs, writable: false, configurable: false },
        phase: { value: phaseApi, writable: false, configurable: false },
        agent: { value: agentApi, writable: false, configurable: false },
        parallel: { value: parallelApi, writable: false, configurable: false },
      });
      for (const name of ["require", "process", "global", "module"]) {
        Object.defineProperty(globalThis, name, {
          configurable: false,
          get() { throw new Error(name + " is not available in workflow sandbox"); },
          set() { throw new Error(name + " is not available in workflow sandbox"); },
        });
      }
      // Structured stack traces can otherwise expose function objects belonging
      // to callers outside the VM realm through V8 CallSite#getFunction().
      Object.defineProperties(Error, {
        prepareStackTrace: { value: undefined, writable: false, configurable: false },
        captureStackTrace: { value: undefined, writable: false, configurable: false },
      });
    })();
  `, { filename: "workflow-sandbox-api.js" });
  setup.runInContext(context);
}

async function execute(source, argsJson) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "workflow-sandbox",
    codeGeneration: { strings: false, wasm: false },
  });
  installApi(context, argsJson);
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: "workflow.js",
    initializeImportMeta(meta) { Object.freeze(meta); },
  });
  await module.link(() => { throw new Error("Workflow imports are not allowed"); });
  await module.evaluate();
  const defaultExport = module.namespace.default;
  if (typeof defaultExport !== "function") throw new TypeError("Workflow must export a default async function");
  const result = await Reflect.apply(defaultExport, undefined, [
    sandbox.args,
    sandbox.phase,
    sandbox.agent,
    sandbox.parallel,
  ]);
  if (pendingAgents.size > 0) {
    throw new Error(`Workflow returned before ${pendingAgents.size} agent call${pendingAgents.size === 1 ? "" : "s"} settled; await every agent() call`);
  }
  const hasMeta = Object.prototype.hasOwnProperty.call(module.namespace, "meta");
  const meta = hasMeta ? module.namespace.meta : undefined;
  let payload;
  try {
    payload = JSON.stringify({
      hasMeta,
      metaUndefined: hasMeta && meta === undefined,
      resultUndefined: result === undefined,
      ...(meta === undefined ? {} : { meta }),
      ...(result === undefined ? {} : { result }),
    });
  } catch (error) {
    throw new TypeError(`Workflow result must be JSON-serializable: ${errorMessage(error)}`);
  }
  if (payload === undefined) throw new TypeError("Workflow result must be JSON-serializable");
  const bytes = byteLength(payload);
  if (bytes > MAX_RESULT_BYTES) throw new RangeError("Workflow result exceeds the 1 MiB limit");
  const buffer = Buffer.from(payload, "utf8");
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += RESULT_CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + RESULT_CHUNK_BYTES).toString("base64"));
  }
  if (chunks.length === 0) chunks.push("");
  if (!send({ type: "result-start", chunks: chunks.length, bytes })) throw new Error("Unable to send workflow result");
  for (let index = 0; index < chunks.length; index++) {
    if (!send({ type: "result-chunk", index, data: chunks[index] })) throw new Error("Unable to send workflow result chunk");
  }
  if (!send({ type: "result-end" })) throw new Error("Unable to finish workflow result");
  finished = true;
  if (process.connected) process.disconnect();
}

process.on("message", (message) => {
  if (!message || typeof message !== "object" || message.token !== token || frameSize(message) > MAX_IPC_BYTES) return;
  if (message.type === "agent-result") {
    const resolve = pendingAgents.get(message.id);
    if (!resolve) return;
    pendingAgents.delete(message.id);
    let response;
    try { response = JSON.stringify(message.result); }
    catch (error) { response = failure(`Agent result is not JSON-serializable: ${errorMessage(error)}`); }
    if (response === undefined) response = failure("Agent returned undefined");
    resolve(response);
    return;
  }
  if (message.type === "cancel") {
    finishError("Workflow sandbox cancelled");
    return;
  }
  if (message.type !== "init" || initialized) return;
  initialized = true;
  if (typeof message.source !== "string" || byteLength(message.source) > MAX_SOURCE_BYTES ||
      typeof message.argsJson !== "string" || byteLength(message.argsJson) > MAX_ARGS_BYTES) {
    finishError("Invalid or oversized workflow initialization");
    return;
  }
  void execute(message.source, message.argsJson).catch(finishError);
});
