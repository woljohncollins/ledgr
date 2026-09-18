// A calendar-day picker for the rail popovers (Schedule, Due). Since the
// Todoist-shaped scheduler landed (Tyler 2026-08-18, ADR-202 follow-on) this is
// a thin alias over the shared DayPickerPanel — quick-pick rows, a real month
// grid, and the free-text natural-language box — kept so the rail call sites
// and their contract (onPick reports YYYY-MM-DD or null; the owning row does
// the PATCH) stay put.
"use client";

import DayPickerPanel from "@/components/ui/DayPickerPanel";

export default function DayField({
  valueYmd,
  today,
  onPick,
  parseTime = false,
  autoFocus = false,
}: {
  valueYmd: string | null; // YYYY-MM-DD or null
  today: string; // app-timezone YYYY-MM-DD
  // The picked day, plus an optional "HH:MM" time when `parseTime` is on and the
  // free-text box carried one ("5am today"). The owning row does the PATCH.
  onPick: (ymd: string | null, time?: string) => void;
  // Schedule uses this so the free-text box also reads a time-of-day; Due leaves
  // it off (a deadline has no clock time in this model).
  parseTime?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <DayPickerPanel
      valueYmd={valueYmd}
      today={today}
      onPick={onPick}
      parseTime={parseTime}
      autoFocus={autoFocus}
    />
  );
}
