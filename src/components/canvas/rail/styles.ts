// Shared class strings for the task-canvas right rail (ADR-108; restyled to the
// Todoist section rhythm, Tyler 2026-08-18). Kept in a plain module (no
// "use client", no JSX) so the server TaskCanvas can import the row wrapper
// class while the client row components import the same trigger styling — one
// source of truth for the rail's vertical rhythm.

// One rail entry: a hairline divider above it, dropped on the first entry, so
// the rail reads as a clean divided list (the Todoist properties-panel rhythm).
export const RAIL_ROW = "border-t border-line first:border-t-0";

// A section's small label line — "Project", "Date", "Priority" — sitting above
// its value (the Todoist stacked-section look).
export const RAIL_LABEL = "text-xs font-medium text-ink-subtle";

// A popover row's trigger button: fills the row (the face stacks label over
// value), with a gentle hover so it reads as tappable. Padding lives here (not
// the wrapper) so the whole padded row is the click target.
export const RAIL_TRIGGER =
  "group block w-full rounded-md py-2.5 text-left text-sm outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2";

// Matching padding for static (non-popover) rows: status checkbox, focus, the
// relation/custom property groups.
export const RAIL_STATIC = "py-2.5";
