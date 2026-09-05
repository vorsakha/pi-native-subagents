import { randomUUID } from "node:crypto";
import {
  fingerprintNativeSubagentsStateV1,
  NATIVE_SUBAGENTS_PRODUCER_VERSION,
  NATIVE_SUBAGENTS_STATE_EVENT_V1,
  projectNativeSubagentsStateV1,
  validateNativeSubagentsStateV1,
  type NativeSubagentsStateV1,
} from "../../src/presentation-state.ts";
import type { JobSnapshot } from "../../src/types.ts";
import type { WorkflowSnapshot } from "../../src/workflows/types.ts";

export interface NativeSubagentsStatePublisher {
  start(): void;
  changed(): void;
  suspend(): void;
  stop(finalJobs: readonly JobSnapshot[], finalWorkflows: readonly WorkflowSnapshot[]): void;
}

const DIAGNOSTIC_KIND = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function diagnosticKind(error: unknown): string {
  if (!(error instanceof Error) || !DIAGNOSTIC_KIND.test(error.name)) return "Error";
  return error.name;
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

export function createNativeSubagentsStatePublisher(options: {
  sessionId: string;
  listJobs(): JobSnapshot[];
  listWorkflows(): WorkflowSnapshot[];
  emit(event: typeof NATIVE_SUBAGENTS_STATE_EVENT_V1, state: NativeSubagentsStateV1): void;
  reportError(message: string): void;
  producerVersion?: string;
  instanceId?: string;
  now?: () => number;
  queueMicrotask?: typeof queueMicrotask;
}): NativeSubagentsStatePublisher {
  const enqueue = options.queueMicrotask ?? queueMicrotask;
  const now = options.now ?? Date.now;
  const producerVersion = options.producerVersion ?? NATIVE_SUBAGENTS_PRODUCER_VERSION;
  const instanceId = options.instanceId ?? randomUUID();
  let mode: "idle" | "active" | "suspended" | "stopped" = "idle";
  let generation = 0;
  let sequence = 0;
  let queued = false;
  let publishing = false;
  let lastFingerprint: string | undefined;
  let lastDiagnostic: string | undefined;

  const diagnose = (stage: "projection" | "validation" | "emission", error: unknown): void => {
    const kind = diagnosticKind(error);
    const message = `Native subagents state ${stage} failed (${kind}).`;
    if (message === lastDiagnostic) return;
    lastDiagnostic = message;
    try { options.reportError(message); } catch { /* diagnostics cannot affect manager lifecycle */ }
  };

  const publish = (
    cause: NativeSubagentsStateV1["cause"],
    lifecycle: NativeSubagentsStateV1["session"]["lifecycle"],
    jobs: readonly JobSnapshot[],
    workflows: readonly WorkflowSnapshot[],
  ): void => {
    let state: NativeSubagentsStateV1;
    try {
      state = projectNativeSubagentsStateV1(jobs, workflows, {
        producerVersion,
        instanceId,
        sequence: sequence + 1,
        emittedAt: now(),
        cause,
        sessionId: options.sessionId,
        lifecycle,
      });
    } catch (error) {
      diagnose("projection", error);
      return;
    }
    const fingerprint = fingerprintNativeSubagentsStateV1(state);
    if (fingerprint === lastFingerprint) return;
    if (!validateNativeSubagentsStateV1(state)) {
      diagnose("validation", new TypeError("invalid V1 payload"));
      return;
    }
    try {
      deepFreeze(state);
      options.emit(NATIVE_SUBAGENTS_STATE_EVENT_V1, state);
    } catch (error) {
      diagnose("emission", error);
      return;
    }
    sequence++;
    lastFingerprint = fingerprint;
    lastDiagnostic = undefined;
  };

  const schedule = (): void => {
    if (mode !== "active" || queued) return;
    queued = true;
    const scheduledGeneration = generation;
    enqueue(() => {
      if (!queued || mode !== "active" || generation !== scheduledGeneration) return;
      queued = false;
      publishActive();
    });
  };

  const publishActive = (): void => {
    if (mode !== "active") return;
    if (publishing) {
      schedule();
      return;
    }
    publishing = true;
    try {
      publish(sequence === 0 ? "startup" : "update", "active", options.listJobs(), options.listWorkflows());
    } catch (error) {
      diagnose("projection", error);
    } finally {
      publishing = false;
    }
  };

  return {
    start() {
      if (mode === "active" || mode === "stopped") return;
      mode = "active";
      generation++;
      queued = false;
      publishActive();
    },
    changed() {
      schedule();
    },
    suspend() {
      if (mode === "stopped") return;
      mode = "suspended";
      generation++;
      queued = false;
    },
    stop(finalJobs, finalWorkflows) {
      if (mode === "stopped") return;
      mode = "stopped";
      generation++;
      queued = false;
      publish("shutdown", "closed", finalJobs, finalWorkflows);
    },
  };
}
