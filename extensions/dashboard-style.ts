import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/*
 * The panel shell shared by /subagents and /workflows, following Pi's `/ps`
 * visual grammar:
 *
 *   Native subagents · 2 jobs          title and count above the panel
 *   ╭─ jobs · 1 active / 2 ──────╮     one rounded border, titled dividers
 *   │ ● worker      codex   1m   │     selection marker and status glyph left,
 *   ├─ detail · worker ──────────┤     operational metadata right-aligned
 *   ╰────────────────────────────╯
 *   Esc close · j/k move                keyboard guidance below the panel
 *
 * Wide panels split the same shell into two columns — a jobs rail and an
 * inspector — using `splitTop`/`splitRow`/`splitBottom`:
 *
 *   ╭─ jobs ──────────┬─ inspector ─────────────╮
 *   │ ❯ ● worker  12s │ worker · 0123abcd       │
 *   ╰─────────────────┴─────────────────────────╯
 *
 * Panels use the full available width. Height comes from `dashboardOverlayRows`
 * (80% of the terminal in regular TUI mode, or all available rows for a
 * fullscreen surface). Status is never communicated by color alone, focus stays
 * visible, and every action is keyboard reachable including Pi's cancel binding
 * and Escape.
 */
const DASHBOARD_MAX_HEIGHT_RATIO = 0.8;

/** A wide terminal earns a list rail beside the inspector; a medium one stacks them. */
export const DASHBOARD_WIDE_MIN_WIDTH = 96;
export const DASHBOARD_MEDIUM_MIN_WIDTH = 64;
/** Content rows below which the panel drops to a single-pane drill-down. */
export const DASHBOARD_SPLIT_MIN_ROWS = 10;
/** Panel rows below which only a compact summary fits. */
export const DASHBOARD_COMPACT_ROWS = 6;
/** Header, top border, bottom border, and hint around the content area. */
export const DASHBOARD_CHROME_ROWS = 4;

export type DashboardLayoutKind = "wide" | "medium" | "narrow";

export interface DashboardLayout {
  kind: DashboardLayoutKind;
  /** Total lines the panel is allowed to render. */
  height: number;
  /** Rows between the top and bottom borders. */
  contentRows: number;
  /** Visible width of the list rail. `wide` only. */
  railWidth: number;
  /** Rows above the detail divider. `medium` only. */
  listRows: number;
  /** Rows given to the inspector. */
  detailRows: number;
}

export function dashboardLayout(width: number, rows: number): DashboardLayout {
  const height = Math.max(0, Math.floor(rows));
  const contentRows = Math.max(1, height - DASHBOARD_CHROME_ROWS);
  const innerWidth = Math.max(0, Math.floor(width) - 2);
  if (width >= DASHBOARD_WIDE_MIN_WIDTH && contentRows >= DASHBOARD_SPLIT_MIN_ROWS) {
    const railWidth = Math.max(26, Math.min(44, Math.round(innerWidth * 0.32)));
    return {
      kind: "wide",
      height,
      contentRows,
      railWidth,
      listRows: contentRows,
      detailRows: contentRows,
    };
  }
  if (width >= DASHBOARD_MEDIUM_MIN_WIDTH && contentRows >= DASHBOARD_SPLIT_MIN_ROWS) {
    const listRows = Math.max(2, Math.min(6, Math.floor((contentRows - 1) * 0.3)));
    return {
      kind: "medium",
      height,
      contentRows,
      railWidth: 0,
      listRows,
      detailRows: Math.max(1, contentRows - 1 - listRows),
    };
  }
  return {
    kind: "narrow",
    height,
    contentRows,
    railWidth: 0,
    listRows: contentRows,
    detailRows: contentRows,
  };
}

/** Pi 0.81+ reports its renderer mode; older hosts use regular overlay mode. */
export function isFullscreenTui(tui: unknown): boolean {
  return (tui as { mode?: unknown } | undefined)?.mode === "fullscreen";
}

export function dashboardMaxHeight(terminalRows: number): number {
  const availableRows = Math.max(10, terminalRows || 30);
  return Math.max(0, Math.floor(availableRows * DASHBOARD_MAX_HEIGHT_RATIO));
}

/**
 * Rows a panel may render, matching exactly what the overlay geometry allows so
 * nothing the panel draws — including its bottom border and hint — is clipped.
 * Fullscreen panels own the screen; regular panels keep the 80% cap.
 */
export function dashboardOverlayRows(terminalRows: number, fullscreen: boolean): number {
  const rows = Math.max(0, Math.floor(terminalRows || 0)) || 24;
  return fullscreen ? rows : Math.max(0, Math.floor(rows * DASHBOARD_MAX_HEIGHT_RATIO));
}

export function createDashboardFrame(theme: Theme, width: number, focused: boolean) {
  const safeWidth = Math.max(0, width);
  const innerWidth = Math.max(0, safeWidth - 2);
  const borderColor = focused ? "borderAccent" : "border";
  const border = (text: string) => theme.fg(borderColor, text);

  const padTo = (text: string, width: number) => {
    const target = Math.max(0, width);
    const truncated = truncateToWidth(text, target);
    return truncated + " ".repeat(Math.max(0, target - visibleWidth(truncated)));
  };
  const pad = (text: string) => padTo(text, innerWidth);

  const segment = (title: string, width: number) => {
    const target = Math.max(0, width);
    if (!target) return "";
    // A titled segment needs one leading rule plus two label spaces. At tiny
    // widths the rule is the only representation that can fit.
    const label = title && target >= 4
      ? ` ${truncateToWidth(title, target - 3)} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      border("─") +
      (label ? theme.fg("text", label) : "") +
      border("─".repeat(Math.max(0, target - 1 - labelWidth)))
    );
  };
  const borderSegment = (title: string) => segment(title, innerWidth);
  const fitFrameLine = (line: string) => truncateToWidth(line, safeWidth, "");

  /** Column widths for a vertical split: `left │ right` inside the panel. */
  const columns = (leftWidth: number) => {
    const left = Math.max(0, Math.min(Math.floor(leftWidth), Math.max(0, innerWidth - 1)));
    return { left, right: Math.max(0, innerWidth - left - 1) };
  };

  return {
    innerWidth,
    columns,
    header(left: string, right: string): string {
      const gap = Math.max(
        1,
        safeWidth - visibleWidth(left) - visibleWidth(right) - 4,
      );
      return truncateToWidth(
        `  ${left}${" ".repeat(gap)}${right}  `,
        safeWidth,
      );
    },
    top(title: string): string {
      return fitFrameLine(border("╭") + borderSegment(title) + border("╮"));
    },
    divider(title: string): string {
      return fitFrameLine(border("├") + borderSegment(title) + border("┤"));
    },
    row(text: string): string {
      return fitFrameLine(border("│") + pad(text) + border("│"));
    },
    bottom(): string {
      return fitFrameLine(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
    },
    splitTop(leftTitle: string, rightTitle: string, leftWidth: number): string {
      const { left, right } = columns(leftWidth);
      return fitFrameLine(border("╭") + segment(leftTitle, left) + border("┬") + segment(rightTitle, right) + border("╮"));
    },
    splitRow(leftText: string, rightText: string, leftWidth: number): string {
      const { left, right } = columns(leftWidth);
      return fitFrameLine(border("│") + padTo(leftText, left) + border("│") + padTo(rightText, right) + border("│"));
    },
    splitBottom(leftWidth: number): string {
      const { left, right } = columns(leftWidth);
      return fitFrameLine(border("╰") + border("─".repeat(left)) + border("┴") + border("─".repeat(right)) + border("╯"));
    },
    hint(text: string, right?: string): string {
      if (!right) {
        return truncateToWidth(theme.fg("dim", `  ${text}`), safeWidth);
      }
      const contentWidth = Math.max(0, safeWidth - 4);
      const rightWidth = visibleWidth(right);
      const leftWidth = Math.max(0, contentWidth - rightWidth - 2);
      const left = truncateToWidth(text, leftWidth);
      const gap = Math.max(
        1,
        contentWidth - visibleWidth(left) - rightWidth,
      );
      return truncateToWidth(
        theme.fg(
          "dim",
          `  ${left}${" ".repeat(gap)}${right}  `,
        ),
        safeWidth,
      );
    },
  };
}

export function alignDashboardRow(
  left: string,
  right: string,
  width: number,
): string {
  const safeWidth = Math.max(0, width);
  const rightWidth = visibleWidth(right);
  const leftMax = Math.max(0, safeWidth - rightWidth - 2);
  const leftTruncated = truncateToWidth(left, leftMax);
  const gap = Math.max(
    2,
    safeWidth - visibleWidth(leftTruncated) - rightWidth,
  );
  return truncateToWidth(
    leftTruncated + " ".repeat(gap) + right,
    safeWidth,
  );
}
