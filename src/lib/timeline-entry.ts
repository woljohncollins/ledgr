// The timeline spine's wire shape: what any gatherer hands the renderer.
//
// This is the seam that makes the spine reusable (Brandon, 2026-09-03). It lives
// in its own dependency-free module so a gatherer (server, DB-reaching) and the
// renderer (pure, mountable from a client component) share one contract without
// either importing the other's world. Today there are two gatherers:
//
//   gatherProjectTimeline  (src/lib/project-timeline.ts) — one record, its five
//                          related collections, per-collection date rules.
//   viewEntries            (ViewRenderer) — any saved view's rows, placed by the
//                          view's date field.
//
// A third (an activity-log gatherer, a cross-project roll-up, a composed record
// surface) only has to emit this array. Keep the fields presentational: the
// renderer must not need to know which gatherer produced a row.
export type TimelineTier = "big" | "small";

export type TimelineEntry = {
  id: string;
  // The item the entry links to (the record itself for "created").
  itemId: string;
  date: Date;
  tier: TimelineTier;
  // Drives the dot color and, in the small tier, the glyph. "item" is the
  // generic row a view spine emits for a type with no timeline meaning of its
  // own (a log entry, a person, a sermon).
  kind: "meeting" | "milestone" | "task" | "note" | "link" | "created" | "item";
  // Short verb phrase for the entry ("Meeting", "Milestone completed", …), shown
  // as the chip. Empty string = no chip.
  label: string;
  title: string;
  // The entry has a wall-clock time worth showing beside its date.
  hasTime: boolean;
  // True when `date` is a UTC-midnight calendar day (due dates, note dates,
  // custom date properties) — format it in UTC. False for real timestamps
  // (meeting times, completion stamps, created-at), which format in the owner's
  // timezone; rendering a UTC-midnight day in a US timezone would shift it back
  // a day, and rendering a late-evening stamp in UTC would shift it forward one.
  calendarDay: boolean;
  done?: boolean;
  // Link entries only: the outbound URL. The tick's title opens it directly
  // (same rule as the Links card, where the title IS the outbound link).
  url?: string | null;
  // Optional second line under the title: the view's chosen columns, rendered
  // as text by the caller. Absent on the record spine.
  meta?: string;
};

// A dated-nothing tail entry (open milestones with no due date; view rows whose
// date field is unset). `badge` labels it; absent = no badge.
export type TimelineUndated = { id: string; title: string; badge?: string };
