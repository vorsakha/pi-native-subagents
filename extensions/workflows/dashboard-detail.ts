import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "../../src/types.ts";
import type { WorkflowAgentRecord, WorkflowPhase, WorkflowSnapshot } from "../../src/workflows/types.ts";
import { sanitizeInline, sanitizeText } from "../subagents/render.ts";

/**
 * Pure text-shaping helpers for the workflows dashboard detail pane:
 * bounding, signatures, transcript flattening, serialization, and Markdown.
 * None of these depend on overlay instance state, so they stay reusable
 * (and independently testable) outside `WorkflowsDashboardOverlay`.
 */

export function boundedInline(value: string, limit: number): string {
  return sanitizeInline(boundedHeadTailText(sanitizeText(value), limit, "text"));
}

export function detailSignature(run: WorkflowSnapshot, phase: WorkflowPhase | undefined, agent: WorkflowAgentRecord | undefined): string {
  const pieces = [
    run.runId,
    run.name,
    run.description,
    run.status,
    run.timestamps.updatedAt,
    run.error,
    run.result,
    run.logs,
    run.warnings,
    run.approval,
    run.budget,
    run.definitionFingerprint,
    phase?.index,
    phase?.name,
    phase?.description,
    phase?.status,
    phase?.result,
    phase?.error,
    agent?.index,
    agent?.state,
    agent?.error,
    agent?.prompt,
    agent?.activity,
    agent?.structured,
    agent?.output,
    agent?.preview,
    agent?.transcript,
    agent?.tools,
    agent?.usage,
    agent?.context,
    agent?.speed,
    agent?.effectiveSpeed,
    agent?.isolation,
    agent?.outputProvenance,
    agent?.instructionShaped,
    agent?.independentOf,
    agent?.requestedHarness,
    agent?.availability,
    agent?.executableVersion,
    agent?.capabilityRevision,
    agent?.availabilityChecks,
    agent?.replayedFrom,
    agent?.replacedBy,
    agent?.truncated,
    agent?.generations,
    agent?.attempts,
    agent?.providerFallback,
    agent?.continuationFallback,
    agent?.continuation,
    agent?.providerWait,
  ];
  return pieces.map((piece) => boundedHeadTailText(serializeResult(piece), 4_096, "signature")).join("|");
}

export function boundRenderedRows(rows: string[], limit: number, theme: Theme, label: string): string[] {
  if (rows.length <= limit) return rows;
  const head = Math.max(1, Math.ceil((limit - 1) / 2));
  const tail = Math.max(0, limit - head - 1);
  const omitted = rows.length - head - tail;
  return [...rows.slice(0, head), theme.fg("muted", `… ${omitted} ${label} omitted`), ...(tail ? rows.slice(-tail) : [])];
}

export function boundedHeadTailText(text: string, limit: number, label: string): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const marker = `\n\n… ${label} truncated …\n\n`;
  if (marker.length >= limit) return `${text.slice(0, Math.max(0, limit - 1))}…`;
  const head = Math.max(1, Math.ceil((limit - marker.length) / 2));
  const tail = Math.max(0, limit - marker.length - head);
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ""}`;
}

export function transcriptDisplayText(entry: TranscriptEntry): string {
  if (entry.kind !== "tool") return sanitizeText(entry.text);
  const resultText = entry.result?.content.map((part) => part.text ?? "").filter(Boolean).join("\n");
  let argsText = entry.text ?? "";
  if (!argsText && entry.args && Object.keys(entry.args).length) {
    try { argsText = JSON.stringify(entry.args); }
    catch { argsText = "[unrenderable arguments]"; }
  }
  const detail = entry.phase === "end" ? resultText || entry.text : argsText;
  return sanitizeText(`${entry.name}${detail ? ` · ${detail}` : ""}`);
}

export function boundedTranscriptParts(entries: TranscriptEntry[], limit: number): Array<{ entry?: TranscriptEntry; text: string }> {
  const parts = entries.map((entry) => ({ entry, text: transcriptDisplayText(entry) }));
  const total = parts.reduce((sum, part) => sum + part.text.length, 0);
  if (total <= limit) return parts;
  if (parts.length === 1) return [{ entry: parts[0]!.entry, text: boundedHeadTailText(parts[0]!.text, limit, "transcript") }];

  const marker = "… older transcript content omitted …";
  const firstBudget = Math.max(1, Math.floor((limit - marker.length) / 3));
  const first = { entry: parts[0]!.entry, text: parts[0]!.text.slice(0, firstBudget) };
  let remaining = Math.max(0, limit - first.text.length - marker.length);
  const tail: Array<{ entry?: TranscriptEntry; text: string }> = [];
  for (let index = parts.length - 1; index > 0 && remaining > 0; index--) {
    const part = parts[index]!;
    if (part.text.length <= remaining) {
      tail.unshift(part);
      remaining -= part.text.length;
    } else {
      tail.unshift({ entry: part.entry, text: boundedHeadTailText(part.text, remaining, "transcript entry") });
      remaining = 0;
    }
  }
  return [first, { text: marker }, ...tail];
}

export function serializeResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? String(nested) : nested, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    try { return String(value); }
    catch { return "[unrenderable result]"; }
  }
}

export function appendBoundedSection(target: string[], theme: Theme, label: string, rows: string[], limit: number): void {
  target.push(theme.fg("muted", label));
  if (rows.length <= limit) {
    target.push(...rows);
    return;
  }
  const head = Math.max(1, Math.ceil((limit - 1) / 2));
  const tail = Math.max(0, limit - head - 1);
  const omitted = rows.length - head - tail;
  target.push(...rows.slice(0, head));
  target.push(theme.fg("muted", `… ${omitted} ${label.toLowerCase()} rows omitted`));
  if (tail) target.push(...rows.slice(-tail));
}

export function renderPrefixedRows(theme: Theme, prefix: string, text: string, color: Parameters<Theme["fg"]>[0], width: number): string[] {
  const prefixWidth = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(sanitizeText(text), Math.max(1, width - prefixWidth));
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${theme.fg(color, line)}`);
}

export function renderWorkflowMarkdown(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return new Markdown(sanitizeText(text), 0, 0, getMarkdownTheme())
    .render(safeWidth)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

export function truncateWorkflowDashboardLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}
