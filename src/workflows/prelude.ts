// Executed only inside QuickJS. Native execution and all admission bounds remain host-owned.
const MAX_CONVERGENCE_ROUNDS = 16;
const MAX_CONVERGENCE_FINDINGS = 32;
const MAX_PIPELINE_ITEMS = 4096;
const MAX_PIPELINE_CONCURRENCY = 4;

export function workflowPrelude(argsJson: string, maxAgentCalls: number): string {
  return `
    const workflowArgs = JSON.parse(${JSON.stringify(argsJson)});
    const bridge = (input) => input.operation === "agent" || input.operation === "followUp"
      ? tools.workflow_agent(input)
      : tools.workflow_event(input);
    let agentCalls = 0;
    let pendingAgents = 0;
    let phaseEvents = 0;
    let logEvents = 0;
    let convergenceEvents = 0;
    let phaseCapacityRequests = 0;
    let eventChain = Promise.resolve();
    let eventFailure;
    const agentCallBudget = ${maxAgentCalls};
    const byteLength = (value) => unescape(encodeURIComponent(value)).length;
    const enqueue = (operation, payload) => {
      eventChain = eventChain.then(() => bridge({ operation, ...payload }));
      eventChain.catch((error) => { eventFailure = error; });
    };
    const flush = async () => { await eventChain; if (eventFailure) throw eventFailure; };
    const callHost = (operation, payloadJson, resolve) => {
      if (operation === "limits") return JSON.stringify({ agentCalls: Math.max(0, agentCallBudget - agentCalls) });
      const payload = JSON.parse(payloadJson);
      const bytes = byteLength(payloadJson);
      if (operation === "phase" || operation === "log" || operation === "convergence") {
        if (operation === "phase" && ++phaseEvents > 128) return "Workflow phase event limit exceeded (128)";
        if (operation === "log" && ++logEvents > 256) return "Workflow log event limit exceeded (256)";
        if (operation === "convergence" && ++convergenceEvents > 64) return "Workflow convergence event limit exceeded (64)";
        if (operation === "log" && bytes > 4096) return "Log message exceeds the 4 KiB limit";
        if (bytes > (operation === "convergence" ? 65536 : 524288)) return "Workflow event exceeds its size limit";
        enqueue(operation, operation === "convergence" ? { progress: payload } : payload);
        return;
      }
      if (operation === "phaseCapacity") {
        if (++phaseCapacityRequests > 64) {
          resolve(JSON.stringify({ ok: false, reason: "the workflow phase preflight limit was reached" }));
          return;
        }
        void flush().then(() => bridge({ operation, ...payload })).then(
          (result) => resolve(JSON.stringify(result)),
          (error) => resolve(JSON.stringify({ ok: false, reason: String(error) })),
        );
        return;
      }
      if (agentCalls >= 32) { resolve(JSON.stringify({ ok: false, output: "", error: "Agent call limit exceeded (32)" })); return; }
      if (bytes > 524288) { resolve(JSON.stringify({ ok: false, output: "", error: "Agent request exceeds the 512 KiB limit" })); return; }
      const callIndex = agentCalls++;
      pendingAgents++;
      void flush().then(() => bridge({ operation, ...payload, callIndex })).then(
        (result) => { pendingAgents--; resolve(JSON.stringify(result)); },
        (error) => { pendingAgents--; resolve(JSON.stringify({ ok: false, output: "", error: String(error.message || error) })); },
      );
    };
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
        let pendingFindings;
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
            pendingFindings,
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
            pendingFindings = verdict === "request_changes" ? fixPrompt(parsed.value, actionable) : undefined;
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
            fixText = pendingFindings;
            reviewAgainText = reviewAgainPrompt(round + 1, actionable);
          }
          return finish("limit-reached", "reached the configured maximum of " + maxRounds + " round(s)");
        } catch (error) {
          return finish("failed", collapse(error && error.message ? error.message : String(error)).slice(0, 1000));
        }
      };
      Object.defineProperties(globalThis, {
        args: { value: workflowArgs, writable: false, configurable: false },
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

  `;
}
