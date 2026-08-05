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
 * Panels use the full available width and cap at 80% of terminal height. Status
 * is never communicated by color alone, focus stays visible, and every action is
 * keyboard reachable including Pi's cancel binding and Escape.
 */
const DASHBOARD_MAX_HEIGHT_RATIO = 0.8;

export function dashboardMaxHeight(terminalRows: number): number {
  const availableRows = Math.max(10, terminalRows || 30);
  return Math.max(0, Math.floor(availableRows * DASHBOARD_MAX_HEIGHT_RATIO));
}

export function createDashboardFrame(theme: Theme, width: number, focused: boolean) {
  const safeWidth = Math.max(0, width);
  const innerWidth = Math.max(0, safeWidth - 2);
  const borderColor = focused ? "borderAccent" : "border";
  const border = (text: string) => theme.fg(borderColor, text);

  const pad = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth);
    return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  };

  const borderSegment = (title: string) => {
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, innerWidth - 3))} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      border("─") +
      (label ? theme.fg("text", label) : "") +
      border("─".repeat(Math.max(0, innerWidth - 1 - labelWidth)))
    );
  };

  return {
    innerWidth,
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
      return border("╭") + borderSegment(title) + border("╮");
    },
    divider(title: string): string {
      return border("├") + borderSegment(title) + border("┤");
    },
    row(text: string): string {
      return border("│") + pad(text) + border("│");
    },
    bottom(): string {
      return border("╰") + border("─".repeat(innerWidth)) + border("╯");
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
