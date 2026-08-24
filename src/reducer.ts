import type {
  BackendEvent,
  JobSnapshot,
  ToolResultContent,
  ToolResultSnapshot,
  Usage,
} from "./types.ts";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_TOOL_TRACES = 200;
export const MAX_JOB_WARNINGS = 8;
export const MAX_TRANSCRIPT_ENTRIES = 160;
export const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_ENTRY_BYTES = 16 * 1024;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function boundedAppend(current: string, addition: string): { text: string; truncated: boolean } {
  const joined = current + addition;
  const bytes = Buffer.byteLength(joined);
  if (bytes <= MAX_OUTPUT_BYTES) return { text: joined, truncated: false };
  const buffer = Buffer.from(joined);
  const marker = Buffer.from("[Earlier output truncated]\n");
  const suffixBytes = Math.max(0, MAX_OUTPUT_BYTES - marker.length);
  let suffix = buffer.subarray(buffer.length - suffixBytes).toString("utf8");
  if (suffix.startsWith("�")) suffix = suffix.slice(1);
  while (Buffer.byteLength(suffix) > suffixBytes) suffix = [...suffix].slice(1).join("");
  return { text: `${marker.toString()}${suffix}`, truncated: true };
}

function boundedText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8").replace(/^�/, "");
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "string") return boundedText(nested, 4 * 1024);
      if (typeof nested === "bigint") return String(nested);
      if (Array.isArray(nested) && nested.length > 32) return [...nested.slice(0, 32), `[${nested.length - 32} items omitted]`];
      if (nested !== null && typeof nested === "object") {
        if (seen.has(nested)) return "[circular]";
        seen.add(nested);
      }
      return nested;
    });
  } catch {
    return { unavailable: true };
  }
  if (Buffer.byteLength(serialized) <= maxBytes) return JSON.parse(serialized) as unknown;
  return { truncated: true, preview: boundedText(serialized, Math.max(0, maxBytes - 64)) };
}

function boundedArgs(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const bounded = boundedJson(value, 8 * 1024);
  return bounded !== null && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : undefined;
}

function boundedResult(
  value: ToolResultSnapshot | undefined,
  output: string | undefined,
  error: boolean | undefined,
): ToolResultSnapshot | undefined {
  if (!value && output === undefined && error === undefined) return undefined;
  const source = value?.content ?? (output === undefined ? [] : [{ type: "text", text: output }]);
  const content: ToolResultContent[] = [];
  let remaining = 10 * 1024;
  for (const part of source.slice(0, 16)) {
    if (remaining <= 0) break;
    const text = part.text === undefined ? undefined : boundedText(part.text, remaining);
    remaining -= text === undefined ? 0 : Buffer.byteLength(text);
    const data = part.data === undefined || remaining <= 0 ? undefined : boundedText(part.data, remaining);
    remaining -= data === undefined ? 0 : Buffer.byteLength(data);
    content.push({
      type: boundedText(String(part.type || "text"), 64),
      text,
      data,
      mimeType: part.mimeType === undefined ? undefined : boundedText(part.mimeType, 128),
    });
  }
  return {
    content,
    details: boundedJson(value?.details, 4 * 1024),
    isError: value?.isError === true || error === true,
  };
}

function transcriptEntryBytes(entry: JobSnapshot["transcript"][number]): number {
  try { return Buffer.byteLength(JSON.stringify(entry)); }
  catch { return MAX_TRANSCRIPT_ENTRY_BYTES; }
}

function pushTranscript(job: JobSnapshot, entry: JobSnapshot["transcript"][number]): void {
  const previous = job.transcript.at(-1);
  if (previous?.kind === entry.kind && previous.text === entry.text && (
    entry.kind !== "tool" || previous.kind === "tool" && previous.toolId === entry.toolId && previous.phase === entry.phase
  )) return;
  if (entry.kind === "tool") {
    job.transcript.push({
      ...entry,
      args: boundedArgs(entry.args),
      result: entry.phase === "end" || entry.result
        ? boundedResult(entry.result, entry.text, entry.error)
        : undefined,
      text: entry.text === undefined ? undefined : boundedText(entry.text, MAX_TRANSCRIPT_ENTRY_BYTES),
    });
  } else {
    job.transcript.push({ ...entry, text: boundedText(entry.text, MAX_TRANSCRIPT_ENTRY_BYTES) });
  }
  const bytes = () => job.transcript.reduce((total, item) => total + transcriptEntryBytes(item), 0);
  while (job.transcript.length > MAX_TRANSCRIPT_ENTRIES || bytes() > MAX_TRANSCRIPT_BYTES) {
    job.transcript.splice(job.transcript.length > 1 ? 1 : 0, 1);
  }
}

export function reduceJob(job: JobSnapshot, event: BackendEvent, now = Date.now()): JobSnapshot {
  // Copy arrays only in the event branches that mutate them. Streaming text/thinking
  // deltas are the hot path and must not duplicate a bounded 256 KiB transcript per token.
  const next: JobSnapshot = { ...job };
  switch (event.type) {
    case "queued":
      break;
    case "started":
      if (next.status === "queued") next.status = "running";
      next.startedAt ??= event.at ?? now;
      next.backendSessionId = event.backendSessionId ?? next.backendSessionId;
      next.sessionFile = event.sessionFile ?? next.sessionFile;
      break;
    case "user_message":
      next.transcript = job.transcript.map((entry) => ({ ...entry }));
      pushTranscript(next, { kind: "user", text: event.text, at: event.at ?? now });
      break;
    case "text_delta": {
      const appended = boundedAppend(next.output, event.text);
      next.output = appended.text;
      next.truncated ||= appended.truncated;
      break;
    }
    case "thinking_delta":
      next.liveThinking = boundedText(next.liveThinking + event.text, MAX_OUTPUT_BYTES);
      break;
    case "thinking_message":
      next.liveThinking = "";
      next.transcript = job.transcript.map((entry) => ({ ...entry }));
      pushTranscript(next, { kind: "thinking", text: event.text, at: event.at ?? now });
      break;
    case "message": {
      next.transcript = job.transcript.map((entry) => ({ ...entry }));
      const appended = boundedAppend("", event.text);
      next.output = appended.text;
      next.truncated ||= appended.truncated;
      next.liveThinking = "";
      pushTranscript(next, { kind: "assistant", text: event.text, at: event.at ?? now });
      break;
    }
    case "queue_changed":
      next.queuedMessages = event.messages.slice(-32).map((message) => ({ ...message, text: boundedText(message.text, 4 * 1024) }));
      break;
    case "tool_start": {
      const args = boundedArgs(event.args);
      next.tools = job.tools.map((tool) => ({ ...tool }));
      next.transcript = job.transcript.map((entry) => ({ ...entry }));
      next.tools.push({
        id: event.id,
        name: event.name,
        ...(args ? { args } : {}),
        summary: event.summary,
        status: "running",
      });
      pushTranscript(next, {
        kind: "tool",
        phase: "start",
        toolId: event.id,
        name: event.name,
        args,
        text: event.summary,
        at: event.at ?? now,
      });
      if (next.tools.length > MAX_TOOL_TRACES) next.tools.splice(0, next.tools.length - MAX_TOOL_TRACES);
      break;
    }
    case "tool_end": {
      const result = boundedResult(event.result, event.output, event.error);
      const failed = result?.isError ?? event.error === true;
      next.tools = job.tools.map((tool) => ({ ...tool }));
      next.transcript = job.transcript.map((entry) => ({ ...entry }));
      for (let index = next.tools.length - 1; index >= 0; index--) {
        const tool = next.tools[index];
        if (tool?.id === event.id) {
          tool.status = failed ? "failed" : "completed";
          tool.result = result;
          break;
        }
      }
      pushTranscript(next, {
        kind: "tool",
        phase: "end",
        toolId: event.id,
        name: event.name ?? "tool",
        result,
        text: event.result ? undefined : event.output,
        error: failed,
        at: event.at ?? now,
      });
      break;
    }
    case "degraded": {
      // Optional native integrations report themselves without failing the job;
      // the notice stays bounded and de-duplicated so a flapping source cannot spam the card.
      const warning = `${event.source}: ${event.detail}`.replace(/\s+/g, " ").trim().slice(0, 300);
      if (!job.warnings?.includes(warning)) next.warnings = [...(job.warnings ?? []), warning].slice(-MAX_JOB_WARNINGS);
      break;
    }
    case "usage":
      next.usage = { ...job.usage };
      for (const key of Object.keys(next.usage) as Array<keyof Usage>) {
        const value = event.usage[key];
        if (typeof value === "number" && Number.isFinite(value)) next.usage[key] += value;
      }
      break;
    case "context":
      next.context = { ...event.context };
      break;
    case "completed":
      if (event.output !== undefined) {
        const bounded = boundedAppend("", event.output);
        next.output = bounded.text;
        next.truncated ||= bounded.truncated;
      }
      if (event.output !== undefined && !next.transcript.some((entry) => entry.kind === "assistant" && entry.text === event.output)) {
        next.transcript = job.transcript.map((entry) => ({ ...entry }));
        pushTranscript(next, { kind: "assistant", text: event.output, at: event.at ?? now });
      }
      // Kept exact, unlike every other bounded field on this snapshot: this is the
      // authoritative native structured-result payload workflow schema validation
      // and replay operate on, so truncating it here would let corrupted data pass
      // a permissive schema silently. Presentation surfaces (dashboard, artifacts)
      // apply their own bounded serialization when they render or persist it.
      if (event.structured !== undefined) next.structured = event.structured;
      next.status = "completed";
      next.queuedMessages = [];
      next.endedAt = event.at ?? now;
      break;
    case "failed":
      next.status = "failed";
      next.queuedMessages = [];
      next.error = event.error;      next.endedAt = event.at ?? now;
      break;
    case "cancelled":
      next.status = "cancelled";
      next.queuedMessages = [];
      next.error = event.reason ?? "Cancelled";      next.endedAt = event.at ?? now;
      break;
  }
  return next;
}
