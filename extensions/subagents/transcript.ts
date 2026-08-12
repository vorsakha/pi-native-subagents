import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTerminal } from "../../src/manager.ts";
import type { JobSnapshot, SendBehavior, TranscriptEntry } from "../../src/types.ts";
import { sanitizeInline, sanitizeText } from "./render.ts";

/*
 * One normalized transcript for every supervision surface. Harness events are
 * already reduced into `job.transcript`; this module turns that bounded state
 * into display lines with a stable vocabulary. User messages and thinking keep
 * compact role prefixes; tool start/result events are paired into Pi-style
 * execution shells with semantic backgrounds, explicit status glyphs, a bold
 * call row, and separated output. Meaning never depends on color alone.
 * Assistant prose can optionally be rendered as Markdown by injecting a
 * renderer, which lets the dashboard cache the expensive pass per job
 * generation and width.
 */

export interface TranscriptOptions {
  /** Renders assistant prose as Markdown instead of plain wrapped text. */
  renderMarkdown?: (text: string, width: number) => string[];
}

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type ToolTrace = JobSnapshot["tools"][number];
type ToolBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type TranscriptBlock =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "tool"; call: ToolEntry; result?: ToolEntry };

/** Pair native start/result events by id, even when parallel calls interleave. */
function transcriptBlocks(entries: TranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const openTools = new Map<string, Extract<TranscriptBlock, { kind: "tool" }>>();
  for (const entry of entries) {
    if (entry.kind !== "tool") {
      blocks.push({ kind: "entry", entry });
      continue;
    }
    const open = openTools.get(entry.toolId);
    if (open) {
      open.result = entry;
      openTools.delete(entry.toolId);
      continue;
    }
    const block: Extract<TranscriptBlock, { kind: "tool" }> = { kind: "tool", call: entry };
    blocks.push(block);
    openTools.set(entry.toolId, block);
  }
  return blocks;
}

function jsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function field(record: Record<string, unknown> | undefined, ...names: string[]): string {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value.trim()) return sanitizeInline(value);
  }
  return "";
}

function knownToolName(name: string): string {
  const lower = sanitizeInline(name).toLowerCase();
  const known: Record<string, string> = {
    bash: "bash",
    edit: "edit",
    find: "find",
    glob: "glob",
    grep: "grep",
    ls: "ls",
    read: "read",
    webfetch: "web fetch",
    websearch: "web search",
    write: "write",
  };
  return known[lower] ?? sanitizeInline(name);
}

/** Format the common native tools with the same call vocabulary as Pi. */
function formatToolCall(entry: ToolEntry, theme: Theme): string {
  const label = knownToolName(entry.name);
  const lower = label.toLowerCase();
  const summary = sanitizeInline(entry.text ?? "");
  const args = jsonRecord(entry.text);
  if (lower === "bash") {
    const command = field(args, "command") || summary;
    return theme.fg("toolTitle", theme.bold(`$ ${command || "…"}`));
  }

  let detail = summary;
  if (lower === "grep" && args) {
    const pattern = field(args, "pattern");
    const path = field(args, "path") || ".";
    const glob = field(args, "glob");
    detail = `${pattern ? `/${pattern}/` : "/…/"} in ${path}${glob ? ` (${glob})` : ""}`;
  } else if ((lower === "glob" || lower === "find") && args) {
    const pattern = field(args, "pattern");
    const path = field(args, "path") || ".";
    detail = [pattern, `in ${path}`].filter(Boolean).join(" ");
  } else if (["read", "edit", "write"].includes(lower) && args) {
    detail = field(args, "path", "file_path") || summary;
  } else if (lower === "web search" && args) {
    detail = field(args, "query") || summary;
  } else if (lower === "web fetch" && args) {
    detail = field(args, "url") || summary;
  }

  const title = theme.fg("toolTitle", theme.bold(label || "tool"));
  return detail ? `${title} ${theme.fg("accent", detail)}` : title;
}

/** Claude often returns a JSON-encoded string; show its actual lines, not quotes and \\n escapes. */
function normalizeToolOutput(value: string | undefined): string {
  const clean = sanitizeText(value ?? "").trimEnd();
  if (!clean) return "";
  try {
    const parsed = JSON.parse(clean) as unknown;
    if (typeof parsed === "string") return sanitizeText(parsed).trimEnd();
    if (Array.isArray(parsed)) {
      const text = parsed
        .map((part) => part !== null && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
          ? String((part as Record<string, unknown>).text)
          : "")
        .filter(Boolean)
        .join("\n");
      if (text) return sanitizeText(text).trimEnd();
    }
  } catch { /* Truncated previews are intentionally rendered as received. */ }
  return clean;
}

function paintToolRow(theme: Theme, background: ToolBackground, content: string, width: number): string {
  const padding = width >= 3 ? 1 : 0;
  const contentWidth = Math.max(1, width - padding * 2);
  const clipped = truncateToWidth(content, contentWidth, "");
  const row = `${" ".repeat(padding)}${clipped}${" ".repeat(Math.max(0, width - padding - visibleWidth(clipped)))}`;
  return theme.bg(background, truncateToWidth(row, width, ""));
}

function renderToolBlock(
  block: Extract<TranscriptBlock, { kind: "tool" }>,
  tool: ToolTrace | undefined,
  width: number,
  theme: Theme,
): string[] {
  const failed = block.result?.error === true || block.call.error === true || tool?.status === "failed";
  const settled = block.result !== undefined || failed || tool?.status === "completed";
  const background: ToolBackground = failed ? "toolErrorBg" : settled ? "toolSuccessBg" : "toolPendingBg";
  const glyph = failed
    ? theme.fg("error", "×")
    : settled
      ? theme.fg("success", "✓")
      : theme.fg("accent", "…");
  // Bounded transcript eviction can leave a settled result without its start
  // event. Reconstruct the call from the durable ToolTrace in that case.
  const loneResult = block.result === undefined && tool !== undefined && tool.status !== "running" && (
    block.call.name === "tool" || block.call.text !== tool.summary
  );
  const call = loneResult && tool
    ? { ...block.call, name: tool.name, text: tool.summary }
    : block.call.name === "tool" && block.result?.name
      ? { ...block.call, name: block.result.name }
      : block.call;
  const header = `${glyph} ${formatToolCall(call, theme)}`;
  const padding = width >= 3 ? 1 : 0;
  const contentWidth = Math.max(1, width - padding * 2);
  const rows = wrapTextWithAnsi(header, contentWidth)
    .map((line) => paintToolRow(theme, background, line, width));
  const output = normalizeToolOutput(block.result?.text ?? (loneResult ? block.call.text : undefined));
  if (!output) return rows;

  rows.push(paintToolRow(theme, background, "", width));
  for (const rawLine of output.split("\n")) {
    const styled = theme.fg(failed ? "error" : "toolOutput", rawLine || " ");
    for (const line of wrapTextWithAnsi(styled, contentWidth)) {
      rows.push(paintToolRow(theme, background, line, width));
    }
  }
  return rows;
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
  const toolTraces = new Map(job.tools.map((tool) => [tool.id, tool]));
  for (const block of transcriptBlocks(job.transcript)) {
    if (block.kind === "entry") {
      renderEntry(block.entry, pushWrapped, pushProse, theme);
      continue;
    }
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(...renderToolBlock(block, toolTraces.get(block.call.toolId), safeWidth, theme));
  }
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
