# Design System

## Theme
Inherit Pi's active theme. The subagent dashboard must feel like the interactive-shell overlay: restrained terminal chrome, a complete border, clear separators, dense operational information, and no independent brand palette.

## Color
Use Pi semantic theme tokens only:
- `borderAccent` for focused outer chrome
- `borderMuted` for unfocused chrome
- `accent` for selected jobs and primary labels
- `success`, `warning`, and `error` for lifecycle states
- `text`, `muted`, and `dim` for content hierarchy
- `selectedBg` for compact focus/selection badges where useful

## Typography
Use terminal-native text and Pi theme weight helpers. Titles are bold but compact. Metadata and keyboard guidance are dim. Avoid decorative glyphs except structural borders, selection arrows, and status symbols.

## Layout
A single bordered overlay with:
1. title and focus/status metadata,
2. concise keyboard guidance,
3. job list,
4. separator,
5. selected-job metadata and transcript viewport,
6. footer with exit and action shortcuts.

The outer frame uses the same focused double-line and unfocused rounded-line vocabulary as interactive-shell. Every line must fit the provided display width.

## Components
- **Outer frame:** full top, side, separator, and bottom borders.
- **Job row:** selection marker, status glyph and text, short id, role, backend/model, elapsed time.
- **Detail header:** role, job id, lifecycle state, access/backend metadata.
- **Transcript:** bounded tail with empty-state copy.
- **Footer:** always includes `Esc close`; shows steering/follow-up/cancel shortcuts only when applicable.

## Interaction
- Escape and the configured `tui.select.cancel` binding close the overlay.
- Arrow keys and `j`/`k` navigate; Shift+Up/Down and Page Up/Down scroll the selected job's full bounded output. Long logical lines wrap into width-safe visual rows so no retained text is hidden.
- `s` steers, `f` queues a follow-up, and `x` cancels a running job.
- State changes redraw without stealing input or trapping focus.

## Tool call/result rendering

Every `subagent_*` tool and the compatibility `subagent` tool define custom `renderCall`/`renderResult` (`extensions/subagents/render.ts`); none fall back to the default raw-text tool shell shown in `extensions/subagents/index.ts` before this system existed. The shared floor is: no bare tool name, no unbounded text dump, one coherent job card per result.

### Line budgets
- Collapsed result: **≤10 rendered lines**.
- Expanded result: **≤36 rendered lines**.
- Both are hard caps enforced by `buildJobCardLines`, not soft guidance: content is clamped and the final line points to `/subagents` for the live dashboard and full bounded output. This mirrors the dashboard's own bounded-output philosophy instead of inventing a second one.
- Lines are produced by a small `Component` that truncates (never wraps) each line to the actual render width, so the budget holds regardless of terminal width — word-wrap would otherwise silently multiply line counts.

### Job card anatomy (`renderJobCard`)
1. Optional lead line (e.g. `✓ Sent steer message`) for `subagent_send`.
2. Header: status glyph + role + short id + `backend/model` + status word + elapsed/duration, one line.
3. Task summary (sanitized, single line, collapsed to one line even when multi-line).
4. Error (collapsed: 1 line; expanded: up to 3 lines), only when present.
5. Tool trace tail: last 3 tools collapsed, last 8 expanded, each `glyph name: summary`; an omitted-count note when older calls exist.
6. Usage summary line (tokens in/out, cache, cost, turns) — omitted entirely when all zero.
7. Output preview: streaming cards show the last 3/16 lines; settled cards show a head/tail preview within the same budget. Empty output is explicit, and upstream truncation is noted.
8. Footer: always present, either the configured expand-key hint plus `/subagents` (collapsed, settled), `updating…` (collapsed, streaming/partial), or `full bounded output: /subagents` (expanded).

The same card renders live partial tool updates (`onUpdate` polling in `subagent_wait` and the compatibility `subagent` tool) and settled results — there is no separate "(subagent running...)" placeholder text.

### Other tool renderers
- `subagent_spawn` / `subagent_check` / `subagent_cancel`: one-line `renderCall` (`tool name` + accent identifier + dim detail) and a job card `renderResult`.
- `subagent_list`: `renderResult` shows a header count line plus capped rows (8 collapsed / 20 expanded) with a `+N more — see /subagents` note when the session has more jobs than fit.
- All tool text is sanitized (`sanitizeText`/`sanitizeInline`): ANSI/OSC/DCS escape sequences and C0/C1 control characters are stripped before rendering, matching the dashboard's transcript sanitation.
