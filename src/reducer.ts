import type { BackendEvent, JobSnapshot, Usage } from "./types.ts";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_TOOL_TRACES = 200;

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

export function reduceJob(job: JobSnapshot, event: BackendEvent, now = Date.now()): JobSnapshot {
  const next: JobSnapshot = { ...job, usage: { ...job.usage }, tools: job.tools.map((tool) => ({ ...tool })) };
  switch (event.type) {
    case "started":
      if (next.status === "queued") next.status = "running";
      next.startedAt ??= event.at ?? now;
      break;
    case "text_delta": {
      const appended = boundedAppend(next.output, event.text);
      next.output = appended.text;
      next.truncated ||= appended.truncated;
      break;
    }
    case "message": {
      const appended = boundedAppend("", event.text);
      next.output = appended.text;
      next.truncated ||= appended.truncated;
      break;
    }
    case "tool_start":
      next.tools.push({ id: event.id, name: event.name, summary: event.summary, status: "running" });
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
      next.status = "completed";
      next.endedAt = event.at ?? now;
      break;
    case "failed":
      next.status = "failed";
      next.error = event.error;
      next.endedAt = event.at ?? now;
      break;
    case "cancelled":
      next.status = "cancelled";
      next.error = event.reason ?? "Cancelled";
      next.endedAt = event.at ?? now;
      break;
  }
  return next;
}
