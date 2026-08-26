"use strict";

const vm = require("node:vm");

const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_SOURCE_BYTES = 512 * KIB;
const MAX_ARGS_BYTES = 256 * KIB;
const MAX_RESULT_BYTES = MIB;
const MAX_IPC_BYTES = 512 * KIB;
const MAX_AGENT_CALLS = 32;
const MAX_PHASE_EVENTS = 128;
const MAX_LOG_EVENTS = 256;
const MAX_CONVERGENCE_EVENTS = 64;
const MAX_PHASE_CAPACITY_REQUESTS = 64;
const MAX_PHASE_CAPACITY_TITLES = 2;
const MAX_CONVERGENCE_ROUNDS = 16;
const MAX_CONVERGENCE_FINDINGS = 32;
const MAX_LOG_MESSAGE_BYTES = 4 * KIB;
const MAX_PIPELINE_ITEMS = 4096;
const MAX_PIPELINE_CONCURRENCY = 4;
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
let agentCallBudget = MAX_AGENT_CALLS;
let phaseEvents = 0;
let logEvents = 0;
let convergenceEvents = 0;
let nextPhaseCapacityId = 1;
const pendingAgents = new Map();
const pendingPhaseCapacity = new Map();

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

function formatWorkflowError(error) {
  const message = errorMessage(error);
  if (/Cannot destructure property ['"](?:phase|log|agent|followUp|parallel|converge)['"]/.test(message)) {
    return `${message}. Workflow helpers are globals: use phase(), log(), agent(), followUp(), parallel(), and converge().`;
  }
  return message;
}

function finishError(error) {
  if (finished) return;
  finished = true;
  const message = formatWorkflowError(error).slice(0, 32 * KIB);
  send({ type: "error", message });
  for (const resolve of pendingAgents.values()) resolve(failure("Workflow sandbox stopped"));
  pendingAgents.clear();
  for (const resolve of pendingPhaseCapacity.values()) resolve(JSON.stringify({ ok: false, reason: "Workflow sandbox stopped" }));
  pendingPhaseCapacity.clear();
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
  if (operation === "log") {
    if (++logEvents > MAX_LOG_EVENTS) return `Workflow log event limit exceeded (${MAX_LOG_EVENTS})`;
    if (typeof payloadJson !== "string" || byteLength(payloadJson) > MAX_LOG_MESSAGE_BYTES) return "Log message exceeds the 4 KiB limit";
    let payload;
    try { payload = JSON.parse(payloadJson); }
    catch { return "Log message is not valid JSON"; }
    if (typeof payload.message !== "string") return "log requires a string message";
    if (!send({ type: "log", message: payload.message })) return "Unable to emit workflow log message";
    return undefined;
  }
  if (operation === "limits") {
    // Remaining sandbox capacity, so converge() can stop at a bounded
    // limit-reached outcome instead of dispatching a call that must fail.
    return JSON.stringify({
      agentCalls: Math.max(0, agentCallBudget - agentCalls),
    });
  }
  if (operation === "phaseCapacity") {
    if (typeof resolve !== "function") return;
    let payload;
    try { payload = JSON.parse(payloadJson); }
    catch { resolve(JSON.stringify({ ok: false, reason: "the phase preflight request is invalid" })); return; }
    if (!payload || !Array.isArray(payload.titles) || payload.titles.length < 1 ||
        payload.titles.length > MAX_PHASE_CAPACITY_TITLES || !payload.titles.every((item) => typeof item === "string")) {
      resolve(JSON.stringify({ ok: false, reason: "the phase preflight request is invalid" }));
      return;
    }
    if (nextPhaseCapacityId > MAX_PHASE_CAPACITY_REQUESTS) {
      resolve(JSON.stringify({ ok: false, reason: "the workflow phase preflight limit was reached" }));
      return;
    }
    const id = nextPhaseCapacityId++;
    if (!send({ type: "phase-capacity", id, titles: payload.titles })) {
      resolve(JSON.stringify({ ok: false, reason: "Unable to preflight workflow phase capacity" }));
      return;
    }
    pendingPhaseCapacity.set(id, resolve);
    return;
  }
  if (operation === "convergence") {
    if (++convergenceEvents > MAX_CONVERGENCE_EVENTS) return `Workflow convergence event limit exceeded (${MAX_CONVERGENCE_EVENTS})`;
    if (typeof payloadJson !== "string" || byteLength(payloadJson) > MAX_LOG_MESSAGE_BYTES) return "Convergence progress exceeds the 4 KiB limit";
    let payload;
    try { payload = JSON.parse(payloadJson); }
    catch { return "Convergence progress is not valid JSON"; }
    if (!send({ type: "convergence", progress: payload })) return "Unable to emit workflow convergence progress";
    return undefined;
  }
  if ((operation !== "agent" && operation !== "followUp") || typeof resolve !== "function") return;
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
  if (operation === "followUp" && (typeof payload.jobId !== "string" || !payload.jobId.trim())) {
    resolve(failure("followUp requires a job ID, a string prompt, and an options object"));
    return;
  }
  const id = nextAgentId++;
  agentCalls++;
  const request = operation === "followUp"
    ? { type: "followUp", id, jobId: payload.jobId, prompt: payload.prompt, options: payload.options }
    : { type: "agent", id, prompt: payload.prompt, options: payload.options };
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
      const NativeDate = Date;
      class WorkflowDate extends NativeDate {
        constructor(...values) {
          if (values.length === 0) throw new Error("new Date() is not available in deterministic workflows; pass an explicit value");
          super(...values);
        }
        static now() { throw new Error("Date.now() is not available in deterministic workflows"); }
      }
      Object.defineProperty(Math, "random", {
        value() { throw new Error("Math.random() is not available in deterministic workflows"); },
        writable: false,
        configurable: false,
      });
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
      const logApi = (message) => {
        if (typeof message !== "string") throw new TypeError("log requires a string message");
        const error = callHost("log", JSON.stringify({ message }));
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
      const followUpApi = async (jobId, prompt, options = {}) => {
        try {
          if (typeof jobId !== "string" || !jobId.trim() || typeof prompt !== "string" || options === null || typeof options !== "object" || Array.isArray(options)) {
            return asFailure(new TypeError("followUp requires a job ID, a string prompt, and an options object"));
          }
          const payload = JSON.stringify({ jobId, prompt, options });
          if (payload === undefined) return asFailure(new TypeError("Follow-up request is not JSON-serializable"));
          return await new Promise((resolve) => {
            callHost("followUp", payload, (responseJson) => {
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
          if (typeof task !== "function") throw new TypeError("parallel() requires deferred functions: () => agent(...); do not pass already-started promises");
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
      const pipelineApi = async (items, ...stages) => {
        if (!Array.isArray(items)) throw new TypeError("pipeline requires an array");
        if (items.length > ${MAX_PIPELINE_ITEMS}) throw new RangeError("pipeline accepts at most ${MAX_PIPELINE_ITEMS} items");
        if (!stages.length || !stages.every((stage) => typeof stage === "function")) {
          throw new TypeError("pipeline requires one or more stage functions");
        }
        const results = new Array(items.length);
        let cursor = 0;
        const run = async () => {
          while (cursor < items.length) {
            const index = cursor++;
            const original = items[index];
            let value = original;
            try {
              for (const stage of stages) value = await stage(value, original, index);
              results[index] = value;
            } catch {
              results[index] = null;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(${MAX_PIPELINE_CONCURRENCY}, items.length) }, run));
        return results;
      };
      // --- Bounded convergence -------------------------------------------
      // converge() is an ordinary loop over agent()/followUp(): every call it
      // makes is a normal workflow call subject to the same scheduler, budget,
      // journal, replay, and cancellation rules. It adds only the contract:
      // a validated review verdict, deterministic stall detection, explicit
      // round bounds, and bounded progress the host can display and persist.
      const deepFreeze = (value) => {
        if (value && typeof value === "object") for (const item of Object.values(value)) deepFreeze(item);
        return Object.freeze(value);
      };
      const CONVERGENCE_REVIEW_SCHEMA = deepFreeze({
        type: "object",
        required: ["verdict", "summary", "findings"],
        properties: {
          verdict: { type: "string", enum: ["approve", "request_changes", "blocked"] },
          summary: { type: "string", minLength: 1, maxLength: 4000 },
          findings: {
            type: "array",
            maxItems: ${MAX_CONVERGENCE_FINDINGS},
            items: {
              type: "object",
              required: ["id", "severity", "body"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 128 },
                severity: { type: "string", enum: ["blocker", "issue", "suggestion"] },
                body: { type: "string", minLength: 1, maxLength: 4000 },
                filePath: { type: "string", maxLength: 1024 },
                startLine: { type: "integer", minimum: 0 },
                endLine: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      });
      const VERDICTS = ["approve", "request_changes", "blocked"];
      const SEVERITIES = ["blocker", "issue", "suggestion"];
      const collapse = (value) => String(value).replace(/\\s+/g, " ").trim();
      const convergenceFingerprint = (text) => {
        // Two FNV-1a passes: a deterministic, dependency-free round marker.
        // Only ever used as durable evidence and for display; stall detection
        // itself compares the full canonical string, never the hash.
        let a = 0x811c9dc5;
        let b = 0x01000193;
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          a = Math.imul(a ^ code, 16777619) >>> 0;
          b = Math.imul(b ^ (code + index), 2166136261) >>> 0;
        }
        return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
      };
      const validateReview = (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { ok: false, error: "the review returned no structured verdict object" };
        }
        if (!VERDICTS.includes(value.verdict)) {
          return { ok: false, error: "verdict must be approve, request_changes, or blocked" };
        }
        const summary = typeof value.summary === "string" ? collapse(value.summary) : "";
        if (!summary) return { ok: false, error: "summary must be a non-empty string" };
        const raw = value.findings === undefined ? [] : value.findings;
        if (!Array.isArray(raw) || raw.length > ${MAX_CONVERGENCE_FINDINGS}) {
          return { ok: false, error: "findings must be an array of at most " + ${MAX_CONVERGENCE_FINDINGS} + " entries" };
        }
        const findings = [];
        const ids = new Set();
        for (const item of raw) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return { ok: false, error: "every finding must be an object" };
          }
          const id = typeof item.id === "string" ? collapse(item.id) : "";
          if (!id || id.length > 128) return { ok: false, error: "every finding needs a stable id of 1-128 characters" };
          if (ids.has(id)) return { ok: false, error: "finding ids must be unique; " + id + " repeats" };
          ids.add(id);
          if (!SEVERITIES.includes(item.severity)) return { ok: false, error: "finding " + id + " has an unknown severity" };
          const body = typeof item.body === "string" ? item.body.trim() : "";
          if (!body) return { ok: false, error: "finding " + id + " needs a non-empty body" };
          const finding = { id, severity: item.severity, body: body.slice(0, 4000) };
          if (typeof item.filePath === "string" && item.filePath.trim()) finding.filePath = collapse(item.filePath).slice(0, 1024);
          if (Number.isSafeInteger(item.startLine)) finding.startLine = item.startLine;
          if (Number.isSafeInteger(item.endLine)) finding.endLine = item.endLine;
          findings.push(finding);
        }
        return { ok: true, value: { verdict: value.verdict, summary: summary.slice(0, 4000), findings } };
      };
      const convergenceStep = (value, label) => {
        const step = typeof value === "string" ? { prompt: value } : value;
        if (!step || typeof step !== "object" || Array.isArray(step)) {
          throw new TypeError("converge " + label + " must be a prompt string or a { prompt, options } object");
        }
        if (typeof step.prompt !== "string" || !step.prompt.trim()) {
          throw new TypeError("converge " + label + " requires a non-empty prompt");
        }
        const options = step.options === undefined ? {} : step.options;
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("converge " + label + " options must be an object");
        }
        if (options.isolation !== undefined) {
          throw new TypeError("converge cannot use isolation: a worktree-isolated call is finalized when it returns and can never be continued by followUp()");
        }
        if (options.phase !== undefined) {
          throw new TypeError("converge " + label + " options cannot set phase; converge owns its implement/review phase sequence");
        }
        if (options.schema !== undefined && label !== "review") {
          throw new TypeError("converge does not accept an implement schema; only the review verdict is structured");
        }
        return { prompt: step.prompt, options: { ...options } };
      };
      const convergenceInstructions = (value, label) => {
        if (value === undefined) return "";
        if (typeof value !== "string" || value.length > 2000) {
          throw new TypeError("converge " + label + " must be a string of at most 2000 characters");
        }
        return value.trim();
      };
      const convergeApi = async (options) => {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new TypeError("converge requires an options object with implement and review prompts");
        }
        const implementSpec = convergenceStep(options.implement, "implement");
        const reviewSpec = convergenceStep(options.review, "review");
        if (reviewSpec.options.access !== undefined && reviewSpec.options.access !== "readOnly") {
          throw new TypeError('converge reviewers are always access: "readOnly" and cannot mutate the checkout');
        }
        if (reviewSpec.options.schema !== undefined) {
          throw new TypeError("converge always validates reviews with convergenceReviewSchema; do not pass a review schema");
        }
        if (options.stallTolerance !== undefined
          && (!Number.isInteger(options.stallTolerance) || options.stallTolerance < 0 || options.stallTolerance > 4)) {
          throw new RangeError("converge stallTolerance must be an integer from 0 to 4");
        }
        if (options.includeSuggestions !== undefined && typeof options.includeSuggestions !== "boolean") {
          throw new TypeError("converge includeSuggestions must be boolean");
        }
        if (options.independentReview !== undefined && typeof options.independentReview !== "boolean") {
          throw new TypeError("converge independentReview must be boolean");
        }
        if (options.phases !== undefined && typeof options.phases !== "boolean") {
          throw new TypeError("converge phases must be boolean");
        }
        if (options.name !== undefined && (typeof options.name !== "string" || !options.name.trim())) {
          throw new TypeError("converge name must be a non-empty string");
        }
        const fixInstructions = convergenceInstructions(options.fixInstructions, "fixInstructions");
        const reviewInstructions = convergenceInstructions(options.reviewInstructions, "reviewInstructions");
        const stallTolerance = options.stallTolerance === undefined ? 0 : options.stallTolerance;
        const includeSuggestions = options.includeSuggestions === true;
        const usePhases = options.phases !== false;
        const name = options.name === undefined ? undefined : collapse(options.name).slice(0, 120);
        const prefix = name === undefined ? "" : name + " · ";
        const capacity = () => JSON.parse(callHost("limits"));
        // An omitted maxRounds is still finite: it is derived from the agent
        // calls this run has left, two per round, capped at ${MAX_CONVERGENCE_ROUNDS}.
        let maxRounds;
        if (options.maxRounds === undefined) {
          maxRounds = Math.max(1, Math.min(${MAX_CONVERGENCE_ROUNDS}, Math.floor(capacity().agentCalls / 2)));
        } else {
          if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > ${MAX_CONVERGENCE_ROUNDS}) {
            throw new RangeError("converge maxRounds must be an integer from 1 to " + ${MAX_CONVERGENCE_ROUNDS});
          }
          maxRounds = options.maxRounds;
        }

        const rounds = [];
        let state = "running";
        let currentRound = 0;
        let verdict;
        let actionableCount;
        let fingerprint;
        let stoppingReason;
        let implementerJobId;
        let reviewerJobId;
        let finalReview;
        let implementationOutput;
        const emit = () => {
          // Progress is advisory: a rejected or dropped frame never changes the
          // loop's outcome, which is carried by the returned result.
          callHost("convergence", JSON.stringify({
            name,
            round: currentRound,
            maxRounds,
            state,
            verdict,
            actionableCount,
            fingerprint,
            stoppingReason,
            implementerJobId,
            reviewerJobId,
            rounds: rounds.slice(-${MAX_CONVERGENCE_ROUNDS}),
          }));
        };
        const finish = (outcome, reason) => {
          state = outcome;
          stoppingReason = reason;
          emit();
          return {
            ok: outcome === "approved",
            outcome,
            roundsAttempted: currentRound,
            maxRounds,
            implementerJobId,
            reviewerJobId,
            finalReview,
            implementationOutput,
            stoppingReason: reason,
            rounds: rounds.slice(),
          };
        };
        const callOutcome = (result) => {
          const error = String(result.error === undefined ? "" : result.error);
          return result.limit === "budget" || error.indexOf("Agent call limit exceeded") === 0 ? "limit-reached" : "failed";
        };
        const callReason = (label, result) => label + " call failed: " + collapse(result.error || "no reason reported").slice(0, 500);
        const actionableOf = (review) => review.findings.filter((item) => includeSuggestions || item.severity !== "suggestion");
        const canonicalOf = (actionable) => actionable
          .map((item) => [
            item.id.toLowerCase(),
            item.severity,
            (item.filePath === undefined ? "" : item.filePath).toLowerCase(),
            collapse(item.body).toLowerCase().slice(0, 512),
          ].join("|"))
          .sort()
          .join("\\n");
        const fixPrompt = (review, actionable) => {
          const lines = [];
          if (fixInstructions) lines.push(fixInstructions);
          lines.push("The reviewer requested changes. Resolve every finding below in the shared checkout, then report exactly what you changed and how you verified it.");
          lines.push("Review summary: " + collapse(review.summary).slice(0, 1000));
          lines.push("Findings:");
          let remaining = 8192 - lines.join("\\n").length - 1;
          for (let index = 0; index < actionable.length; index++) {
            const item = actionable[index];
            const findingPrefix = "- [" + item.severity + "] " + item.id;
            const laterMinimum = actionable.slice(index + 1)
              .reduce((total, later) => total + ("- [" + later.severity + "] " + later.id + ": x\\n").length, 0);
            const minimum = findingPrefix.length + 3;
            const sharedExtra = Math.max(0, remaining - minimum - laterMinimum);
            const allowance = minimum + Math.floor(sharedExtra / (actionable.length - index));
            const line = item.startLine === undefined ? "" : ":" + item.startLine;
            const location = item.filePath === undefined ? "" : " (" + item.filePath + line + ")";
            const desiredBody = Math.min(64, collapse(item.body).length);
            const locationBudget = Math.max(0, allowance - findingPrefix.length - desiredBody - 2);
            const boundedLocation = location.slice(0, Math.min(location.length, locationBudget));
            const bodyBudget = Math.max(1, allowance - findingPrefix.length - boundedLocation.length - 2);
            const findingLine = findingPrefix + boundedLocation + ": " + collapse(item.body).slice(0, bodyBudget);
            lines.push(findingLine);
            remaining -= findingLine.length + 1;
          }
          return lines.join("\\n");
        };
        const reviewAgainPrompt = (round, actionable) => {
          const lines = [];
          if (reviewInstructions) lines.push(reviewInstructions);
          lines.push("Round " + round + ": the implementer reported another attempt. Re-inspect the current checkout and return the same structured review verdict.");
          if (actionable.length) lines.push("Findings you reported last round: " + actionable.map((item) => item.id).join(", ").slice(0, 1000));
          lines.push("Approve only when every actionable finding is genuinely resolved; report blocked only for an external or policy boundary you cannot resolve here.");
          return lines.join("\\n").slice(0, 4096);
        };

        let previousCanonical;
        let repeats = 0;
        let fixText = "";
        let reviewAgainText = "";
        try {
          for (let round = 1; round <= maxRounds; round++) {
            const limits = capacity();
            if (limits.agentCalls < 2) {
              return finish("limit-reached", "the run has fewer than two agent calls left, so another implement/review round cannot start");
            }
            const implementationPhase = prefix + (round === 1 ? "implement 1" : "fix " + (round - 1));
            const reviewPhase = prefix + "review " + round;
            const phaseTitles = usePhases ? [implementationPhase, reviewPhase] : [];
            if (phaseTitles.length) {
              const phaseCapacity = await new Promise((resolve) => {
                callHost("phaseCapacity", JSON.stringify({ titles: phaseTitles }), (responseJson) => {
                  try { resolve(JSON.parse(responseJson)); }
                  catch { resolve({ ok: false, reason: "the phase capacity response is invalid" }); }
                });
              });
              if (!phaseCapacity.ok) return finish("limit-reached", phaseCapacity.reason);
            }
            currentRound = round;
            state = "running";
            emit();

            if (usePhases) phaseApi(implementationPhase);
            const implementation = round === 1
              ? await agentApi(implementSpec.prompt, implementSpec.options)
              : await followUpApi(implementerJobId, fixText, {});
            if (!implementation.ok) return finish(callOutcome(implementation), callReason("implementation", implementation));
            if (typeof implementation.output === "string") implementationOutput = implementation.output.slice(0, 4000);
            if (round === 1) {
              implementerJobId = implementation.jobId;
              if (typeof implementerJobId !== "string" || !implementerJobId) {
                return finish("failed", "the implementation agent retained no session, so no fix round could continue it");
              }
            }

            if (usePhases) phaseApi(reviewPhase);
            const reviewOptions = { ...reviewSpec.options, access: "readOnly", schema: CONVERGENCE_REVIEW_SCHEMA };
            if (options.independentReview === true) reviewOptions.independentOf = implementerJobId;
            const reviewed = round === 1
              ? await agentApi(reviewSpec.prompt, reviewOptions)
              : await followUpApi(reviewerJobId, reviewAgainText, { schema: CONVERGENCE_REVIEW_SCHEMA });
            if (!reviewed.ok) return finish(callOutcome(reviewed), callReason("review", reviewed));
            if (round === 1) {
              reviewerJobId = reviewed.jobId;
              if (typeof reviewerJobId !== "string" || !reviewerJobId) {
                return finish("failed", "the review agent retained no session, so no re-review could continue it");
              }
            }

            const parsed = validateReview(reviewed.structured);
            if (!parsed.ok) return finish("failed", "review " + round + " returned an unusable verdict: " + parsed.error);
            finalReview = parsed.value;
            const actionable = actionableOf(parsed.value);
            const canonical = canonicalOf(actionable);
            if (parsed.value.verdict === "approve" && actionable.length) {
              return finish("failed", "review " + round + " approved while still reporting " + actionable.length + " actionable finding(s)");
            }
            if (parsed.value.verdict === "request_changes" && !actionable.length) {
              const advisory = parsed.value.findings.length
                ? " (its findings are all suggestions, which stay advisory unless includeSuggestions is set)"
                : "";
              return finish("failed", "review " + round + " requested changes without reporting an actionable finding" + advisory);
            }
            verdict = parsed.value.verdict;
            actionableCount = actionable.length;
            fingerprint = convergenceFingerprint(canonical);
            rounds.push({ round, verdict, actionableCount, fingerprint });
            emit();

            if (verdict === "approve") return finish("approved", "the reviewer approved in round " + round);
            if (verdict === "blocked") {
              return finish("blocked", "the reviewer reported an external blocker: " + collapse(parsed.value.summary).slice(0, 500));
            }
            if (previousCanonical !== undefined && canonical === previousCanonical) {
              repeats += 1;
              if (repeats > stallTolerance) {
                return finish("stalled", "round " + round + " repeated the same " + actionable.length + " unresolved finding(s) as the round before it");
              }
            } else {
              repeats = 0;
            }
            previousCanonical = canonical;
            if (round >= maxRounds) {
              return finish("limit-reached", "reached the configured maximum of " + maxRounds + " round(s) with changes still requested");
            }
            fixText = fixPrompt(parsed.value, actionable);
            reviewAgainText = reviewAgainPrompt(round + 1, actionable);
          }
          return finish("limit-reached", "reached the configured maximum of " + maxRounds + " round(s)");
        } catch (error) {
          return finish("failed", collapse(error && error.message ? error.message : String(error)).slice(0, 1000));
        }
      };
      Object.defineProperties(globalThis, {
        args: { value: workflowArgs, writable: false, configurable: false },
        Date: { value: WorkflowDate, writable: false, configurable: false },
        phase: { value: phaseApi, writable: false, configurable: false },
        log: { value: logApi, writable: false, configurable: false },
        agent: { value: agentApi, writable: false, configurable: false },
        followUp: { value: followUpApi, writable: false, configurable: false },
        parallel: { value: parallelApi, writable: false, configurable: false },
        pipeline: { value: pipelineApi, writable: false, configurable: false },
        converge: { value: convergeApi, writable: false, configurable: false },
        convergenceReviewSchema: { value: CONVERGENCE_REVIEW_SCHEMA, writable: false, configurable: false },
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
  const hasMeta = Object.prototype.hasOwnProperty.call(module.namespace, "meta");
  const meta = hasMeta ? module.namespace.meta : undefined;
  if (hasMeta) {
    let metaJson;
    try { metaJson = JSON.stringify(meta); }
    catch (error) { throw new TypeError(`Workflow meta must be JSON-serializable: ${errorMessage(error)}`); }
    if (metaJson !== undefined && byteLength(metaJson) > 16 * KIB) throw new RangeError("Workflow meta exceeds the 16 KiB limit");
    if (!send({ type: "meta", meta: metaJson === undefined ? null : JSON.parse(metaJson) })) throw new Error("Unable to send workflow meta");
  }
  const defaultExport = module.namespace.default;
  if (typeof defaultExport !== "function") throw new TypeError("Workflow must export a default async function");
  const result = await Reflect.apply(defaultExport, undefined, [
    sandbox.args,
    sandbox.phase,
    sandbox.agent,
    sandbox.parallel,
    sandbox.pipeline,
    sandbox.log,
    sandbox.followUp,
  ]);
  if (pendingAgents.size > 0) {
    throw new Error(`Workflow returned before ${pendingAgents.size} agent call${pendingAgents.size === 1 ? "" : "s"} settled; await every agent() call`);
  }
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
  if (!message || typeof message !== "object" || message.token !== token) return;
  if (message.type !== "init" && frameSize(message) > MAX_IPC_BYTES) return;
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
  if (message.type === "phase-capacity-result") {
    const resolve = pendingPhaseCapacity.get(message.id);
    if (!resolve) return;
    pendingPhaseCapacity.delete(message.id);
    let response;
    try { response = JSON.stringify(message.result); }
    catch { response = JSON.stringify({ ok: false, reason: "the phase capacity response is invalid" }); }
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
      typeof message.argsJson !== "string" || byteLength(message.argsJson) > MAX_ARGS_BYTES ||
      !Number.isSafeInteger(message.maxAgentCalls) || message.maxAgentCalls < 1 || message.maxAgentCalls > MAX_AGENT_CALLS) {
    finishError("Invalid or oversized workflow initialization");
    return;
  }
  agentCallBudget = message.maxAgentCalls;
  void execute(message.source, message.argsJson).catch(finishError);
});
