import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTerminal } from "../../src/manager.ts";
import type { JobSnapshot, SendBehavior, TranscriptEntry } from "../../src/types.ts";
import { sanitizeText } from "./render.ts";

/*
 * One normalized transcript for every supervision surface. Harness events are
 * already reduced into `job.transcript`; this module turns that bounded state
 * into display lines with a stable prefix vocabulary:
 *
 *   > user or queued message   ~ thinking   → tool   × failed tool   • live output
 *
 * Prefixes, not color, carry the meaning. Assistant prose can optionally be
 * rendered as Markdown by injecting a renderer, which lets the dashboard cache
 * the expensive pass per job generation and width.
 */

export interface TranscriptOptions {
  /** Renders assistant prose as Markdown instead of plain wrapped text. */
  renderMarkdown?: (text: string, width: number) => string[];
}

/** Why a job's transcript is empty, in the job's own lifecycle terms. */
export function emptyTranscriptLabel(job: Pick<JobSnapshot, "status">): string {
  switch (job.status) {
    case "queued": return "(queued — waiting for an agent slot)";
    case "running": return "(running — waiting for the first response)";
    case "failed": return "(failed before producing assistant text)";
    case "cancelled": return "(cancelled before producing assistant text)";
    default: return "(no assistant text)";
  }
}

export function buildTranscript(
  job: JobSnapshot,
  width: number,
  theme: Theme,
  options: TranscriptOptions = {},
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  const pushWrapped = (prefix: string, text: string, color: Parameters<Theme["fg"]>[0]) => {
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    const prefixWidth = visibleWidth(prefix);
    const wrapped = wrapTextWithAnsi(clean, Math.max(1, safeWidth - prefixWidth));
    for (let index = 0; index < wrapped.length; index++) {
      lines.push((index === 0 ? prefix : " ".repeat(prefixWidth)) + theme.fg(color, wrapped[index]!));
    }
  };
  const pushProse = (prefix: string, text: string, color: Parameters<Theme["fg"]>[0]) => {
    const render = options.renderMarkdown;
    if (!render) return pushWrapped(prefix, text, color);
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    const prefixWidth = visibleWidth(prefix);
    const rendered = render(clean, Math.max(1, safeWidth - prefixWidth));
    for (let index = 0; index < rendered.length; index++) {
      lines.push((index === 0 ? prefix : " ".repeat(prefixWidth)) + truncateToWidth(rendered[index]!, Math.max(1, safeWidth - prefixWidth), ""));
    }
  };
  for (const entry of job.transcript) renderEntry(entry, pushWrapped, pushProse, theme);
  if (job.liveThinking.trim()) pushWrapped(theme.fg("dim", "~ "), job.liveThinking, "muted");
  const lastAssistant = [...job.transcript].reverse().find((entry) => entry.kind === "assistant");
  if (!isTerminal(job.status) && job.output.trim() && lastAssistant?.text !== job.output) {
    pushProse(theme.fg("accent", "• "), job.output, "text");
  }
  for (const queued of job.queuedMessages) {
    pushWrapped(theme.fg("warning", `> [${queued.behavior}] `), queued.text, "muted");
  }
  if (!lines.length) lines.push(theme.fg("dim", emptyTranscriptLabel(job)));
  return lines;
}

function renderEntry(
  entry: TranscriptEntry,
  push: (prefix: string, text: string, color: Parameters<Theme["fg"]>[0]) => void,
  pushProse: (prefix: string, text: string, color: Parameters<Theme["fg"]>[0]) => void,
  theme: Theme,
): void {
  if (entry.kind === "user") push(theme.fg("accent", "> "), entry.text, "userMessageText");
  else if (entry.kind === "thinking") push(theme.fg("dim", "~ "), entry.text, "muted");
  else if (entry.kind === "assistant") pushProse("", entry.text, "text");
  else {
    const glyph = entry.error ? theme.fg("error", "× ") : theme.fg("muted", "→ ");
    push(glyph, `${entry.name}${entry.text ? ` · ${entry.text}` : ""}`, entry.error ? "error" : "muted");
  }
}

/**
 * Cheap identity for a job's rendered transcript. Every mutation the reducer can
 * perform — appended entries, evicted entries, streamed output, queue changes —
 * moves at least one component, so a cache keyed on this never serves stale text.
 */
export function transcriptSignature(job: JobSnapshot): string {
  // Keep the cache cheap enough for streaming, but content-sensitive: bounded
  // output can replace its tail without changing any length/count fields.
  let chars = 0;
  let hash = 2_166_136_261;
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
  };
  for (const entry of job.transcript) {
    const text = entry.text ?? "";
    mix(entry.kind);
    chars += text.length;
    mix(text);
    if (entry.kind === "tool") {
      chars += entry.name.length + entry.toolId.length;
      mix(entry.name);
      mix(entry.toolId);
      mix(entry.error ? "1" : "0");
    }
  }
  mix(job.output);
  mix(job.liveThinking);
  for (const queued of job.queuedMessages) {
    chars += queued.text.length;
    mix(queued.behavior);
    mix(queued.text);
  }
  return [job.id, job.generation, job.status, job.transcript.length, chars, hash.toString(36)].join(":");
}

/** Whether a job's retained native session can still receive a message, and as what. */
export interface TakeoverPolicy {
  reusable: boolean;
  behavior: SendBehavior;
  /** Set when the session is read-only; explains why in the operator's terms. */
  restriction?: string;
}

export function takeoverPolicy(job: JobSnapshot): TakeoverPolicy {
  if (job.workflow) {
    return { reusable: false, behavior: "steer", restriction: "Workflow-owned agents are read-only here; inspect or cancel them from /workflows." };
  }
  if (job.status === "failed" || job.status === "cancelled") {
    return { reusable: false, behavior: "steer", restriction: `This native session cannot continue after ${job.status}.` };
  }
  return { reusable: true, behavior: job.status === "completed" ? "followUp" : "steer" };
}
