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
import type { JobSnapshot, SendBehavior, ToolTrace } from "../../src/types.ts";
import { sanitizeText } from "./render.ts";
import {
  DEFAULT_TOOL_DISPLAY,
  groupToolBlocks,
  renderToolGroupRow,
  resolveToolRenderSnapshot,
  summarizeToolCalls,
  toolCallState,
  transcriptBlocks,
  type ToolDisplayMode,
  type ToolLifecycleBlock,
  type ToolRenderSnapshot,
} from "../tool-summary.ts";

export type { ToolRenderSnapshot } from "../tool-summary.ts";

/*
 * One normalized transcript for every supervision surface. Assistant and user
 * prose use Pi's own message configuration, while tool lifecycle events are
 * adapted into Pi's public ToolExecutionComponent. Backend adapters preserve
 * structured arguments/results so built-in tools receive their native Pi
 * renderer; unknown native tools use Pi's generic fallback shell.
 */

export interface TranscriptOptions {
  /** Overrides Pi's regular assistant Markdown renderer. */
  renderMarkdown?: (text: string, width: number) => string[];
  /** Overrides Pi's regular tool execution renderer. */
  renderTool?: (tool: ToolRenderSnapshot, width: number) => string[];
  /** Compact groups consecutive tool calls into one bounded indicator; full uses Pi's tool shell. */
  toolDisplay?: ToolDisplayMode;
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

function resolvedTool(
  job: JobSnapshot,
  block: ToolLifecycleBlock,
  trace: ToolTrace | undefined,
): ToolRenderSnapshot {
  return resolveToolRenderSnapshot(`${job.id}:${block.call.toolId}`, job.cwd, block.call, block.result, trace);
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
  const toolDisplay = options.toolDisplay ?? DEFAULT_TOOL_DISPLAY;
  const blocks = transcriptBlocks(job.transcript);

  for (const block of toolDisplay === "full" ? blocks : groupToolBlocks(blocks)) {
    if (block.kind === "toolGroup") {
      const states = block.calls.map((call) => toolCallState(call.call, call.result, toolTraces.get(call.call.toolId)));
      lines.push(renderToolGroupRow(summarizeToolCalls(states), theme, safeWidth));
      continue;
    }
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
