import type { BackendEvent, JobSnapshot, Usage } from "./types.ts";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_TOOL_TRACES = 200;
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

function pushTranscript(job: JobSnapshot, entry: JobSnapshot["transcript"][number]): void {
  const previous = job.transcript.at(-1);
  if (previous?.kind === entry.kind && previous.text === entry.text && (entry.kind !== "tool" || previous.kind === "tool" && previous.toolId === entry.toolId)) return;
  if (entry.kind === "tool") {
    job.transcript.push({ ...entry, text: entry.text === undefined ? undefined : boundedText(entry.text, MAX_TRANSCRIPT_ENTRY_BYTES) });
  } else {
    job.transcript.push({ ...entry, text: boundedText(entry.text, MAX_TRANSCRIPT_ENTRY_BYTES) });
  }
  const bytes = () => job.transcript.reduce((total, item) => total + Buffer.byteLength(item.kind === "tool" ? item.text ?? item.name : item.text), 0);
  while (job.transcript.length > MAX_TRANSCRIPT_ENTRIES || bytes() > MAX_TRANSCRIPT_BYTES) {
    job.transcript.splice(job.transcript.length > 1 ? 1 : 0, 1);
  }
}

export function reduceJob(job: JobSnapshot, event: BackendEvent, now = Date.now()): JobSnapshot {
  const next: JobSnapshot = {
    ...job,
    usage: { ...job.usage },
    tools: job.tools.map((tool) => ({ ...tool })),
    transcript: job.transcript.map((entry) => ({ ...entry })),
    queuedMessages: job.queuedMessages.map((message) => ({ ...message })),
  };
  switch (event.type) {
    case "started":
      if (next.status === "queued") next.status = "running";
      next.startedAt ??= event.at ?? now;
      next.backendSessionId = event.backendSessionId ?? next.backendSessionId;
      next.sessionFile = event.sessionFile ?? next.sessionFile;
      break;
    case "user_message":
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
      pushTranscript(next, { kind: "thinking", text: event.text, at: event.at ?? now });
      break;
    case "message": {
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
    case "tool_start":
      next.tools.push({ id: event.id, name: event.name, summary: event.summary, status: "running" });
      pushTranscript(next, { kind: "tool", toolId: event.id, name: event.name, text: event.summary, at: event.at ?? now });
      if (next.tools.length > MAX_TOOL_TRACES) next.tools.splice(0, next.tools.length - MAX_TOOL_TRACES);
      break;
    case "tool_end": {
      for (let index = next.tools.length - 1; index >= 0; index--) {
        const tool = next.tools[index];
        if (tool?.id === event.id) {
          tool.status = event.error ? "failed" : "completed";
          break;
        }
      }
      pushTranscript(next, { kind: "tool", toolId: event.id, name: event.name ?? "tool", text: event.output, error: event.error, at: event.at ?? now });
      break;
    }
    case "usage":
      for (const key of Object.keys(next.usage) as Array<keyof Usage>) {
        const value = event.usage[key];
        if (typeof value === "number" && Number.isFinite(value)) next.usage[key] += value;
      }
      break;
    case "completed":
      if (event.output !== undefined) {
        const bounded = boundedAppend("", event.output);
        next.output = bounded.text;
        next.truncated ||= bounded.truncated;
      }
      if (event.output !== undefined && !next.transcript.some((entry) => entry.kind === "assistant" && entry.text === event.output)) {
        pushTranscript(next, { kind: "assistant", text: event.output, at: event.at ?? now });
      }
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
