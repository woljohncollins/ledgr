// Presentational pieces shared by the rail's popover rows (ADR-108; restyled to
// the Todoist section shape, Tyler 2026-08-18): the row "face" — a small label
// line with the value (and an optional leading glyph) stacked under it — used
// as a Popover trigger, a few house-style glyphs for those rows, and a menu
// item for the small option menus (Priority, Status). Pure components (no
// hooks) — they render client when used inside the client rows.

import type { ReactNode } from "react";
import { RAIL_LABEL } from "./styles";

const GLYPH = "h-4 w-4 shrink-0";

export function CalendarGlyph({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`${GLYPH} ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 9h16M8 3v4M16 3v4" />
    </svg>
  );
}

export function TargetGlyph({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`${GLYPH} ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

// A pushpin: "this date stands still while its anchor moves" (ADR-253).
export function PinGlyph({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`${GLYPH} ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
    </svg>
  );
}

export function FlagGlyph({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`${GLYPH} ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21V4" />
      <path d="M5 4c4-2 6 2 10 0v9c-4 2-6-2-10 0" />
    </svg>
  );
}

// Small label line on top, value (or muted placeholder) with an optional
// leading glyph under it — the Todoist stacked section. `inline` keeps a short
// value (Priority's P-chip) on the label's own line instead (Tyler, 2026-08-18:
// "to the right rather than underneath").
export function RowFace({
  label,
  empty = false,
  overdue = false,
  icon,
  inline = false,
  children,
}: {
  label: string;
  empty?: boolean;
  // A past-due scheduled/due date on an open task — the value shows red.
  overdue?: boolean;
  // A leading glyph on the value line (calendar, flag…); dims when empty.
  icon?: ReactNode;
  inline?: boolean;
  children: ReactNode;
}) {
  const value = (
    <span
      className={`flex min-w-0 items-center gap-2 ${
        overdue ? "text-red-400" : empty ? "text-ink-faint" : "text-ink"
      }`}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
  if (inline) {
    return (
      <span className="flex w-full items-center justify-between gap-3">
        <span className={RAIL_LABEL}>{label}</span>
        {value}
      </span>
    );
  }
  return (
    <span className="flex w-full flex-col gap-1">
      <span className={RAIL_LABEL}>{label}</span>
      {value}
    </span>
  );
}

// One choice in a Priority/Status menu, with a leading swatch and a check on the
// active option.
export function MenuItem({
  active = false,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-800 ${
        active ? "text-neutral-100" : "text-neutral-300"
      }`}
    >
      <span className="flex flex-1 items-center gap-2">{children}</span>
      {active && <span className="text-neutral-400">✓</span>}
    </button>
  );
}
