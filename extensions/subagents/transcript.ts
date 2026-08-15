import {
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import { isTerminal } from "../../src/manager.ts";
import type {
  JobSnapshot,
  SendBehavior,
  ToolResultSnapshot,
  TranscriptEntry,
} from "../../src/types.ts";
import { sanitizeInline, sanitizeText } from "./render.ts";

/*
 * One normalized transcript for every supervision surface. Assistant and user
 * prose use Pi's own message configuration, while tool lifecycle events are
 * adapted into Pi's public ToolExecutionComponent. Backend adapters preserve
 * structured arguments/results so built-in tools receive their native Pi
 * renderer; unknown native tools use Pi's generic fallback shell.
 */

export interface ToolRenderSnapshot {
  key: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResultSnapshot;
  status: "running" | "completed" | "failed";
  cwd: string;
}

export interface TranscriptOptions {
  /** Overrides Pi's regular assistant Markdown renderer. */
  renderMarkdown?: (text: string, width: number) => string[];
  /** Overrides Pi's regular tool execution renderer. */
  renderTool?: (tool: ToolRenderSnapshot, width: number) => string[];
}

/** Render assistant prose with regular Pi message padding, theme, and wrapping. */
export function renderAssistantMarkdown(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return new Markdown(sanitizeText(text).trim(), 1, 0, getMarkdownTheme())
    .render(safeWidth)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

/** Render a user turn through Pi's public user-message component. */
export function renderUserMessage(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return new UserMessageComponent(sanitizeText(text), getMarkdownTheme(), 1)
    .render(safeWidth)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

/** Match Pi's visible thinking treatment without exposing message internals. */
function renderThinking(text: string, width: number, theme: Theme): string[] {
  const safeWidth = Math.max(1, width);
  const rows = new Markdown(
    sanitizeText(text).trim(),
    1,
    0,
    getMarkdownTheme(),
    {
      color: (content) => theme.fg("thinkingText", content),
      italic: true,
    },
  ).render(safeWidth);
  return ["", ...rows.map((line) => truncateToWidth(line, safeWidth, ""))];
}

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type ToolTrace = JobSnapshot["tools"][number];
type TranscriptBlock =
  | { kind: "entry"; entry: Exclude<TranscriptEntry, ToolEntry> }
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
    const isResult = entry.phase === "end" || entry.phase === undefined && open !== undefined;
    if (isResult && open) {
      open.result = entry;
      openTools.delete(entry.toolId);
      continue;
    }
    if (isResult) {
      blocks.push({ kind: "tool", call: entry, result: entry });
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

const BUILT_IN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);

function piToolName(value: string): string {
  const clean = sanitizeInline(value) || "tool";
  const lower = clean.toLowerCase();
  return BUILT_IN_TOOL_NAMES.has(lower) ? lower : clean;
}

function legacyArgs(name: string, text: string | undefined): Record<string, unknown> {
  const parsed = jsonRecord(text);
  if (parsed) return parsed;
  const value = sanitizeText(text ?? "").trim();
  if (!value) return {};
  const lower = name.toLowerCase();
  if (lower === "bash") return { command: value };
  if (["edit", "read", "write"].includes(lower)) return { path: value };
  return { input: value };
}

/** Claude sometimes JSON-encodes textual tool output; expose the actual text. */
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

function resolvedTool(
  job: JobSnapshot,
  block: Extract<TranscriptBlock, { kind: "tool" }>,
  trace: ToolTrace | undefined,
): ToolRenderSnapshot {
  const callName = block.call.name === "tool" ? "" : block.call.name;
  const resultName = block.result?.name === "tool" ? "" : block.result?.name;
  const name = piToolName(callName || resultName || trace?.name || "tool");
  const args = block.call.args ?? trace?.args ?? legacyArgs(name, block.call.phase === "end" ? trace?.summary : block.call.text);
  const status = block.result?.error === true || block.result?.result?.isError === true || trace?.status === "failed"
    ? "failed"
    : block.result || trace?.status === "completed"
      ? "completed"
      : "running";
  const legacyOutput = normalizeToolOutput(block.result?.text ?? (
    block.call.phase === "end" ? block.call.text : undefined
  ));
  const result = block.result?.result ?? trace?.result ?? (status === "running"
    ? undefined
    : {
        content: legacyOutput ? [{ type: "text", text: legacyOutput }] : [],
        isError: status === "failed",
      });
  return {
    key: `${job.id}:${block.call.toolId}`,
    name,
    args,
    result,
    status,
    cwd: job.cwd,
  };
}

const transcriptTui = {
  requestRender() {},
} as unknown as TUI;

/** Render a normalized tool lifecycle through Pi's own execution component. */
export function renderPiTool(tool: ToolRenderSnapshot, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const component = new ToolExecutionComponent(
    tool.name,
    tool.key,
    tool.args,
    { showImages: false },
    undefined,
    transcriptTui,
    tool.cwd,
  );
  component.setArgsComplete();
  if (tool.result) component.updateResult(tool.result, false);
  return component.render(safeWidth).map((line) => truncateToWidth(line, safeWidth, ""));
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
  const renderMarkdown = options.renderMarkdown ?? renderAssistantMarkdown;
  const renderTool = options.renderTool ?? renderPiTool;
  const pushWrapped = (prefix: string, text: string, color: Parameters<Theme["fg"]>[0]) => {
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    const prefixWidth = visibleWidth(prefix);
    const wrapped = wrapTextWithAnsi(clean, Math.max(1, safeWidth - prefixWidth));
    for (let index = 0; index < wrapped.length; index++) {
      lines.push((index === 0 ? prefix : " ".repeat(prefixWidth)) + theme.fg(color, wrapped[index]!));
    }
  };
  const pushAssistant = (text: string) => {
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    lines.push(...renderMarkdown(clean, safeWidth));
  };
  const toolTraces = new Map(job.tools.map((tool) => [tool.id, tool]));

  for (const block of transcriptBlocks(job.transcript)) {
    if (block.kind === "tool") {
      const tool = resolvedTool(job, block, toolTraces.get(block.call.toolId));
      lines.push(...renderTool(tool, safeWidth));
      continue;
    }
    if (block.entry.kind === "user") lines.push(...renderUserMessage(block.entry.text, safeWidth));
    else if (block.entry.kind === "thinking") lines.push(...renderThinking(block.entry.text, safeWidth, theme));
    else pushAssistant(block.entry.text);
  }

  if (job.liveThinking.trim()) lines.push(...renderThinking(job.liveThinking, safeWidth, theme));
  const lastAssistant = [...job.transcript].reverse().find((entry) => entry.kind === "assistant");
  if (!isTerminal(job.status) && job.output.trim() && lastAssistant?.text !== job.output) {
    pushAssistant(job.output);
  }
  for (const queued of job.queuedMessages) {
    pushWrapped(theme.fg("warning", `> [${queued.behavior}] `), queued.text, "muted");
  }
  if (!lines.length) lines.push(theme.fg("dim", emptyTranscriptLabel(job)));
  return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

function signatureValue(value: unknown): string {
  if (value === undefined) return "";
  try { return JSON.stringify(value); }
  catch { return "[unserializable]"; }
}

/** Cheap, content-sensitive identity for a job's rendered transcript. */
export function transcriptSignature(job: JobSnapshot): string {
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
      const structured = `${signatureValue(entry.args)}${signatureValue(entry.result)}`;
      chars += entry.name.length + entry.toolId.length + structured.length;
      mix(entry.name);
      mix(entry.toolId);
      mix(entry.phase ?? "legacy");
      mix(entry.error ? "1" : "0");
      mix(structured);
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
