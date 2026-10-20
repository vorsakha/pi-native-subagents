import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "workflow-pi-ai/models";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { WorkflowCodemodeSandbox } from "./codemode.ts";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  hook,
  NestedCallDoc,
  ToolTask,
  type ConversationId,
  type TaskId,
  type ToolTaskResult,
} from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { chmod } from "node:fs/promises";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { reserveWorkflowState, claimWorkflowDatabase, withWorkflowStateReader } from "./state.ts";
import type { WorkflowSandboxOptions, WorkflowSandboxResult, WorkflowConvergenceProgress } from "./sandbox.ts";

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }

  throw new TypeError("Workflow results must be JSON values");
}

const WorkflowDoc = defineDoc<{
  taskId?: TaskId<JsonValue>;
  result?: JsonValue;
  error?: string;
  nativeCalls: number;
  nativeIntents: Array<{ callIndex: number; taskId: TaskId }>;
}>({
  kind: "native.workflow",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nativeCalls: 0, nativeIntents: [] }),
});

type WorkflowState =
  | { phase: "start" }
  | { phase: "finish"; script: TaskId<ToolTaskResult> };

const Workflow = defineTask<{ code: string }, WorkflowState, JsonValue>({
  name: "native.workflow",
  version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const slot = await tx.doc(NestedCallDoc, task.id, "script", null);
        const script = await tx.createTask(
          ToolTask,
          {
            kind: "nested",
            parent: task.id,
            parentCallId: `workflow-${task.id}`,
            key: "script",
            call: {
              type: "toolCall",
              id: `workflow-${task.id}/script`,
              name: "workflow_runner",
              arguments: { code: task.input.code },
            },
          },
          { ownership: { kind: "task", taskId: task.id } },
        );
        slot.taskId = script;

        return {
          status: "waiting",
          checkpoint: { phase: "finish", script },
          on: [script],
          policy: "allSettled",
        };
      }, context);
    },
    finish: async (task, runtime, context) => {
      const call = await runtime.snapshot(NestedCallDoc, task.id, "script", context);
      const document = await runtime.snapshot(WorkflowDoc, task.conversationId, context);
      const result = call?.result;
      const script = await runtime.getTask(task.state.checkpoint.script, context);
      const outcome = script?.state.status === "terminal" ? script.state.outcome : undefined;

      await runtime.commit(() => ({
        status: "terminal",
        outcome: outcome?.status !== "completed" || !result || result.isError
          ? {
              status: "failed",
              error: { message: document?.error ?? "Workflow script failed; inspect its private run artifacts" },
            }
          : { status: "completed", result: document?.result ?? null },
      }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "aborted" },
    }), context);
  },
});

export async function openWorkflowRuntime(
  options: WorkflowSandboxOptions,
  normalizeProgress: (value: unknown) => WorkflowConvergenceProgress | undefined,
) {
  const stateOwner = options.database ? reserveWorkflowState(options.database) : undefined;
  let release: () => Promise<void> = async () => {};
  let openedHarness: Harness | undefined;
  let openedSandbox: CodemodeSandbox | undefined;
  try {
    release = options.database ? await claimWorkflowDatabase(options.database) : release;
    let activeCalls = 0;
    let recovering = false;
    const nativeTasks = new Set<Promise<unknown>>();
    let phaseEvents = 0;
    let phaseCapacityRequests = 0;
    let logEvents = 0;
    let convergenceEvents = 0;
    let conversationId: ConversationId | undefined;
    const sandbox = new WorkflowCodemodeSandbox({
      memoryLimitBytes: 64 * 1024 * 1024,
      timeoutMs: Infinity,
    }, async (message) => {
      if (!openedHarness || !conversationId) throw new Error("Workflow runtime is not open");
      const owner = conversationId;
      await openedHarness.commit(async (tx) => {
        const document = await tx.doc(WorkflowDoc, owner);
        document.error = message.slice(0, 32 * 1024);
      }, BACKGROUND_CONTEXT);
    });
    openedSandbox = sandbox;
    const registry = createRegistry();
    const codemode = createCodemodeTool({ sandbox, models: false });

    registry.install(defineExtension({
      name: "workflow",
      tasks: [Workflow],
      tools: [
        { ...codemode, name: "workflow_runner", callers: ["tools"] },
        defineTool({
          name: "workflow_agent",
          description: "Dispatch a bounded native agent call through the shared job service.",
          parameters: Type.Object({
            operation: Type.Union([Type.Literal("agent"), Type.Literal("followUp")]),
            prompt: Type.String(),
            options: Type.Record(Type.String(), Type.Unknown()),
            jobId: Type.Optional(Type.String()),
            callIndex: Type.Integer({ minimum: 0, maximum: 31 }),
          }),
          structuredOutputSchema: Type.Unknown(),
          // Native file mutations are never safe to replay after an interrupted intent.
          replay: "unsafe",
          callers: ["tools"],
          execute: async (input, api, context) => {
            if (!context.abortSignal) throw new Error("Native calls require a cancellable invocation");
            await api.commit(async (tx) => {
              const document = await tx.doc(WorkflowDoc, api.conversationId);
              if ((input.callIndex !== document.nativeCalls && !(recovering && input.callIndex > document.nativeCalls)) || document.nativeCalls >= 32) {
                throw new Error("Workflow agent call IDs are not contiguous or exceed the 32-call limit");
              }
              document.nativeCalls = input.callIndex + 1;
              document.nativeIntents.push({ callIndex: input.callIndex, taskId: api.taskId });
            }, context);
            bounded(input, 512 * 1024, "Agent request exceeds the 512 KiB limit");
            if (input.operation === "followUp" && (!input.jobId?.trim() || input.jobId.length > 200)) {
              throw new Error("followUp requires a bounded job ID");
            }
            const signal = AbortSignal.any([context.abortSignal, options.signal]);
            activeCalls++;
            try {
              const native = Promise.resolve().then(() => input.operation === "followUp"
                ? options.onFollowUp(input.jobId!, input.prompt, input.options, signal, input.callIndex)
                : options.onAgent(input.prompt, input.options, signal, input.callIndex));
              nativeTasks.add(native);
              void native.then(() => nativeTasks.delete(native), () => nativeTasks.delete(native));
              const result = await cancellable(signal, () => native);
              let normalized: JsonValue;
              try {
                normalized = jsonValue(JSON.parse(JSON.stringify(result)));
                bounded(normalized, 512 * 1024, "Agent result exceeds the 512 KiB limit");
              } catch (error) {
                normalized = { ok: false, output: "", error: errorMessage(error) };
              }
              return { structuredOutput: normalized };
            } catch (error) {
              if (signal.aborted) throw error;
              return { structuredOutput: { ok: false, output: "", error: errorMessage(error) } };
            } finally {
              activeCalls--;
            }
          },
        }),
        defineTool({
          name: "workflow_event",
          description: "Commit bounded workflow progress and final JSON data.",
          parameters: Type.Object({
            operation: Type.Union(["meta", "phase", "phaseCapacity", "log", "convergence", "result"].map((value) => Type.Literal(value))),
            value: Type.Optional(Type.Unknown()),
            title: Type.Optional(Type.String()),
            titles: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 2 })),
            message: Type.Optional(Type.String()),
            progress: Type.Optional(Type.Unknown()),
          }),
          structuredOutputSchema: Type.Unknown(),
          replay: "safe",
          callers: ["tools"],
          execute: async (input, api, context) => {
            let value: JsonValue = null;
            switch (input.operation) {
              case "meta":
                bounded(input.value, 16 * 1024, "Workflow meta exceeds the 16 KiB limit");
                options.onMeta(input.value);
                break;
              case "phase":
                if (++phaseEvents > 128) throw new Error("Workflow phase event limit exceeded (128)");
                bounded(input, 512 * 1024, "Phase message exceeds the 512 KiB limit");
                if (typeof input.title !== "string") throw new Error("phase requires a string title");
                options.onPhase(input.title);
                break;
              case "phaseCapacity":
                if (++phaseCapacityRequests > 64) throw new Error("Workflow phase preflight limit reached");
                if (!input.titles) throw new Error("Invalid phase capacity request");
                value = jsonValue(options.onPhaseCapacity(input.titles));
                break;
              case "log":
                if (++logEvents > 256) throw new Error("Workflow log event limit exceeded (256)");
                bounded(input, 4096, "Log message exceeds the 4 KiB limit");
                if (typeof input.message !== "string") throw new Error("log requires a string message");
                options.onLog(input.message);
                break;
              case "convergence": {
                if (++convergenceEvents > 64) throw new Error("Workflow convergence event limit exceeded (64)");
                bounded(input.progress, 64 * 1024, "Convergence progress exceeds the 64 KiB limit");
                const progress = normalizeProgress(input.progress);
                if (!progress) throw new Error("Invalid convergence progress from workflow sandbox");
                options.onConvergence(progress);
                break;
              }
              case "result":
                if (activeCalls) throw new Error("Workflow returned before all agent calls settled; await every agent() call");
                bounded(input.value, 1024 * 1024, "Workflow result exceeds the 1 MiB limit");
                await api.commit(async (tx) => {
                  const document = await tx.doc(WorkflowDoc, api.conversationId);
                  document.result = jsonValue(input.value);
                }, context);
                break;
            }
            return { structuredOutput: value };
          },
        }),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, context) => {
            if (call.name !== "workflow_runner") return;
            const document = await api.snapshot(WorkflowDoc, api.conversationId, context);

            if (call.parent?.taskId !== document?.taskId) {
              return { block: "Workflow scripts cannot start nested workflows" };
            }
          },
        }),
      ],
    }));

    const harness = await Harness.open(
      options.database ? await openNodeSqliteStorage(options.database) : new MemoryStorage(),
      { models: createModels(), registry },
      BACKGROUND_CONTEXT,
    );
    openedHarness = harness;
    const root = await harness.root(BACKGROUND_CONTEXT);
    conversationId = root.id;

    stateOwner?.attach({ harness, conversationId: root.id });
    if (options.database) await chmod(options.database, 0o600);
    return {
      async run(code: string): Promise<WorkflowSandboxResult> {
        let id = (await harness.snapshot(WorkflowDoc, root.id, BACKGROUND_CONTEXT))?.taskId;
        recovering = id !== undefined;
        if (!id) {
          id = await root.commit(async (tx) => {
            const taskId = await tx.createTask(Workflow, { code }, { ownership: { kind: "conversation" } });
            const document = await tx.doc(WorkflowDoc, root.id);
            document.taskId = taskId;
            return taskId;
          }, BACKGROUND_CONTEXT);
        }
        const taskId = id;
        const abort = () => { void harness.abortTask(taskId, BACKGROUND_CONTEXT).catch(() => undefined); };
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
        try {
          const receipt = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
          if (options.signal.aborted || receipt.state.outcome.status === "aborted") {
            throw Object.assign(new Error("Workflow sandbox aborted"), { name: "AbortError" });
          }
          if (receipt.state.outcome.status !== "completed") {
            throw new Error(receipt.state.outcome.status === "failed" ? receipt.state.outcome.error.message : JSON.stringify(receipt.state.outcome));
          }
          const value = receipt.state.outcome.result;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing workflow result");
          return {
            ...(value.hasMeta ? { meta: value.metaUndefined ? undefined : value.meta } : {}),
            result: value.resultUndefined ? undefined : value.result,
          };
        } finally {
          options.signal.removeEventListener("abort", abort);
        }
      },
      async close() {
        try {
          // Native cancellation also owns worktree finalization and domain proof writes.
          // Let cooperative cleanup finish before closing the run's database, with the old one-second drain bound.
          if (nativeTasks.size) {
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                Promise.allSettled([...nativeTasks]),
                new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); }),
              ]);
            } finally { if (timer) clearTimeout(timer); }
          }
          await harness.close(BACKGROUND_CONTEXT);
          await sandbox.close();
        } finally {
          stateOwner?.release();
          await release();
        }
      },
    };
  } catch (error) {
    await openedHarness?.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await openedSandbox?.close().catch(() => undefined);
    stateOwner?.release();
    await release();
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: unknown, maximum: number, message: string): void {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && Buffer.byteLength(serialized) > maximum) throw new Error(message);
}

async function cancellable<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(Object.assign(new Error("Workflow native call aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Read-only inspection never enables Durable scheduling or replays native work. */
export async function inspectWorkflowExecution(database: string) {
  try {
    return await withWorkflowStateReader(database, async ({ harness, conversationId }) => {
      const document = await harness.snapshot(WorkflowDoc, conversationId, BACKGROUND_CONTEXT);
      const task = document?.taskId ? await harness.getTask(document.taskId, BACKGROUND_CONTEXT) : undefined;
      const unsafeCalls: number[] = [];
      const interruptionErrors: Record<number, string> = {};
      for (const intent of document?.nativeIntents ?? []) {
        const native = await harness.getTask(intent.taskId, BACKGROUND_CONTEXT);
        if (native && (native.state.status !== "terminal" || native.state.outcome.status === "failed"
            && /interrupted.*may have partially run/i.test(native.state.outcome.error.message))) {
          unsafeCalls.push(intent.callIndex);
          if (native.state.status === "terminal" && native.state.outcome.status === "failed") {
            interruptionErrors[intent.callIndex] = native.state.outcome.error.message;
          }
        }
      }
      return { pending: task !== undefined && task.state.status !== "terminal", unsafeCalls, interruptionErrors };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: false, unsafeCalls: [], interruptionErrors: {} as Record<number, string> };
    throw error;
  }
}
