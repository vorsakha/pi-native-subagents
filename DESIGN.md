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
- Arrow keys and `j`/`k` navigate.
- `s` steers, `f` queues a follow-up, and `x` cancels a running job.
- State changes redraw without stealing input or trapping focus.
