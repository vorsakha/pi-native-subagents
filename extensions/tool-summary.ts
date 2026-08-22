import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolResultSnapshot, ToolTrace, TranscriptEntry } from "../src/types.ts";
import { sanitizeInline, sanitizeText, traceStatusMeta, TRACE_GROUP } from "./subagents/render.ts";

/*
 * Presentation policy for compact tool-call groups, shared by the /subagents
 * transcript, takeover, and the /workflows agent inspector. Pairing rules,
 * status derivation, and render-snapshot resolution live once here so compact
 * and full rendering (in both surfaces) can never disagree about a call's
 * name, outcome, or arguments. Pi-free and unit-testable on its own.
 */

export type ToolDisplayMode = "compact" | "full";
export const DEFAULT_TOOL_DISPLAY: ToolDisplayMode = "compact";

export interface ToolCallState {
  name: string;
  status: "running" | "completed" | "failed";
}

export interface ToolGroupSummary {
  total: number;
  completed: number;
  failed: number;
  running: number;
  /** Bounded, count-descending then first-appearance; `omitted` folds the rest. */
  tools: Array<{ name: string; count: number }>;
  omitted: number;
  failedTools: string[];
  runningTools: string[];
}

export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

const BUILT_IN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const MAX_GROUP_TOOL_NAMES = 6;
const MAX_GROUP_FAILED_NAMES = 3;
const MAX_GROUP_RUNNING_NAMES = 3;
const MAX_ROW_NAME_WIDTH = 24;

export function normalizeToolName(value: string): string {
  const clean = sanitizeInline(value) || "tool";
  const lower = clean.toLowerCase();
  return BUILT_IN_TOOL_NAMES.has(lower) ? lower : clean;
}

/** The single status rule shared by compact and full rendering. */
export function toolCallState(call: ToolEntry, result: ToolEntry | undefined, trace?: ToolTrace): ToolCallState {
  const callName = call.name === "tool" ? "" : call.name;
  const resultName = result?.name === "tool" ? "" : result?.name;
  const name = normalizeToolName(callName || resultName || trace?.name || "tool");
  const status: ToolCallState["status"] =
    result?.error === true || result?.result?.isError === true || trace?.status === "failed"
      ? "failed"
      : result || trace?.status === "completed"
        ? "completed"
        : "running";
  return { name, status };
}

/**
 * A phase-less entry with no explicit result/error is genuinely ambiguous
 * (a bare legacy args-only record) and stays open until a later event or
 * trace settles it. A phase-less entry that already carries a result or an
 * error flag is a self-contained, already-settled call — pairing it with
 * itself as its own result keeps failures visible instead of reporting them
 * as still running.
 */
function isSelfSettled(entry: ToolEntry): boolean {
  return entry.phase === undefined && (entry.result !== undefined || entry.error === true);
}

export interface ToolPairing {
  /** toolId, in first-occurrence chronological order. */
  order: string[];
  pairs: Map<string, { call: ToolEntry; result?: ToolEntry }>;
}

/** Pairs tool events by id across the given sequence, regardless of what (if anything) separates a call from its result. */
export function pairToolEntries(entries: readonly ToolEntry[]): ToolPairing {
  const order: string[] = [];
  const pairs = new Map<string, { call: ToolEntry; result?: ToolEntry }>();
  for (const entry of entries) {
    const existing = pairs.get(entry.toolId);
    if (existing) {
      if (entry.phase === "end" || entry.phase === undefined) existing.result = entry;
      continue;
    }
    const isResult = entry.phase === "end" || isSelfSettled(entry);
    pairs.set(entry.toolId, { call: entry, result: isResult ? entry : undefined });
    order.push(entry.toolId);
  }
  return { order, pairs };
}

/** Pairs a run of tool events by id, then resolves each to one call state. */
export function toolCallStates(entries: readonly ToolEntry[], traces?: ReadonlyMap<string, ToolTrace>): ToolCallState[] {
  const { order, pairs } = pairToolEntries(entries);
  return order.map((id) => {
    const pair = pairs.get(id)!;
    return toolCallState(pair.call, pair.result, traces?.get(id));
  });
}

export function summarizeToolCalls(calls: readonly ToolCallState[]): ToolGroupSummary {
  let completed = 0;
  let failed = 0;
  let running = 0;
  const failedTools: string[] = [];
  const runningTools: string[] = [];
  const counts = new Map<string, { count: number; index: number }>();
  for (const call of calls) {
    if (call.status === "failed") {
      failed++;
      if (failedTools.length < MAX_GROUP_FAILED_NAMES) failedTools.push(call.name);
    } else if (call.status === "running") {
      running++;
      if (runningTools.length < MAX_GROUP_RUNNING_NAMES) runningTools.push(call.name);
    } else {
      completed++;
    }
    const existing = counts.get(call.name);
    if (existing) existing.count++;
    else counts.set(call.name, { count: 1, index: counts.size });
  }
  const sorted = [...counts.entries()]
    .map(([name, { count, index }]) => ({ name, count, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
  const tools = sorted.slice(0, MAX_GROUP_TOOL_NAMES).map(({ name, count }) => ({ name, count }));
  return {
    total: calls.length,
    completed,
    failed,
    running,
    tools,
    omitted: sorted.length - tools.length,
    failedTools,
    runningTools,
  };
}

function boundName(name: string): string {
  return truncateToWidth(sanitizeInline(name), MAX_ROW_NAME_WIDTH, "…");
}

/** Bounded, failure-first candidate ladder; the first row that fits `width` wins. */
export function renderToolGroupRow(summary: ToolGroupSummary, theme: Theme, width: number): string {
  const safeWidth = Math.max(0, width);
  const glyph = theme.fg("accent", TRACE_GROUP);
  const countLabel = `${summary.total} tool call${summary.total === 1 ? "" : "s"}`;

  const statusParts: string[] = [];
  if (summary.completed) statusParts.push(theme.fg(traceStatusMeta("completed").color, `✓${summary.completed}`));
  if (summary.failed) statusParts.push(theme.fg(traceStatusMeta("failed").color, `×${summary.failed}`));
  if (summary.running) statusParts.push(theme.fg(traceStatusMeta("running").color, `●${summary.running}`));

  const failedNames = summary.failedTools.map(boundName).join(", ");
  const runningNames = summary.runningTools.map(boundName).join(", ");
  const breakdown = summary.tools
    .map(({ name, count }) => (count > 1 ? `${boundName(name)} ×${count}` : boundName(name)))
    .join(", ") + (summary.omitted > 0 ? `, +${summary.omitted} more` : "");

  const build = (segments: string[]): string => `${glyph} ${[countLabel, ...segments].join(" · ")}`;

  const candidates = [
    build([
      ...(statusParts.length ? [statusParts.join(" ")] : []),
      ...(failedNames ? [`failed ${failedNames}`] : []),
      ...(runningNames ? [`running ${runningNames}`] : []),
      ...(breakdown ? [theme.fg("dim", breakdown)] : []),
    ]),
    build([
      ...(statusParts.length ? [statusParts.join(" ")] : []),
      ...(failedNames ? [`failed ${failedNames}`] : []),
      ...(runningNames ? [`running ${runningNames}`] : []),
    ]),
    build([
      ...(statusParts.length ? [statusParts.join(" ")] : []),
      ...(failedNames ? [`failed ${failedNames}`] : []),
    ]),
    build(statusParts.length ? [statusParts.join(" ")] : []),
    `${glyph} ${summary.total}${summary.failed ? ` ×${summary.failed}` : ""}${summary.running ? ` ●${summary.running}` : ""}`,
  ];

  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= safeWidth) return candidate;
  }
  return truncateToWidth(candidates[candidates.length - 1]!, safeWidth, "…");
}

/*
 * Chronological block folding, shared by every full-mode transcript renderer.
 * Tool events are paired globally by id — not just within one adjacent run —
 * so a call that starts, is interrupted by an assistant/user/thinking entry,
 * and ends later still resolves to exactly one call, positioned at its first
 * occurrence, in both compact and full rendering.
 */

export type TranscriptBlock =
  | { kind: "entry"; entry: Exclude<TranscriptEntry, ToolEntry> }
  | { kind: "tool"; call: ToolEntry; result?: ToolEntry };
export type ToolLifecycleBlock = Extract<TranscriptBlock, { kind: "tool" }>;
export type GroupedBlock = TranscriptBlock | { kind: "toolGroup"; calls: ToolLifecycleBlock[] };

/** Pairs native start/result events by id, even when parallel calls or other entries interleave. */
export function transcriptBlocks(entries: readonly TranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const openTools = new Map<string, ToolLifecycleBlock>();
  for (const entry of entries) {
    if (entry.kind !== "tool") {
      blocks.push({ kind: "entry", entry });
      continue;
    }

    const open = openTools.get(entry.toolId);
    const isResult = entry.phase === "end" || (entry.phase === undefined && (open !== undefined || isSelfSettled(entry)));
    if (isResult && open) {
      open.result = entry;
      openTools.delete(entry.toolId);
      continue;
    }
    if (isResult) {
      blocks.push({ kind: "tool", call: entry, result: entry });
      continue;
    }

    const block: ToolLifecycleBlock = { kind: "tool", call: entry };
    blocks.push(block);
    openTools.set(entry.toolId, block);
  }
  return blocks;
}

/** Folds consecutive tool blocks (chronological order preserved) into single groups. */
export function groupToolBlocks(blocks: readonly TranscriptBlock[]): GroupedBlock[] {
  const grouped: GroupedBlock[] = [];
  let run: ToolLifecycleBlock[] = [];
  const flush = () => {
    if (!run.length) return;
    grouped.push({ kind: "toolGroup", calls: run });
    run = [];
  };
  for (const block of blocks) {
    if (block.kind === "tool") {
      run.push(block);
      continue;
    }
    flush();
    grouped.push(block);
  }
  flush();
  return grouped;
}

/*
 * Structured render-snapshot resolution, shared by every full-mode Pi
 * ToolExecutionComponent renderer (`/subagents`, takeover, and `/workflows`).
 */

export interface ToolRenderSnapshot {
  key: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResultSnapshot;
  status: "running" | "completed" | "failed";
  cwd: string;
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

/** Resolves one paired call/result into the structured snapshot Pi's ToolExecutionComponent renders. */
export function resolveToolRenderSnapshot(
  key: string,
  cwd: string,
  call: ToolEntry,
  result: ToolEntry | undefined,
  trace: ToolTrace | undefined,
): ToolRenderSnapshot {
  const { name, status } = toolCallState(call, result, trace);
  const args = call.args ?? trace?.args ?? legacyArgs(name, call.phase === "end" ? trace?.summary : call.text);
  const legacyOutput = normalizeToolOutput(result?.text ?? (call.phase === "end" ? call.text : undefined));
  const toolResult = result?.result ?? trace?.result ?? (status === "running"
    ? undefined
    : {
        content: legacyOutput ? [{ type: "text", text: legacyOutput }] : [],
        isError: status === "failed",
      });
  return { key, name, args, result: toolResult, status, cwd };
}
