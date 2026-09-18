// Date anchoring (ADR-253) — the one rule three surfaces share: **a date tracks
// its anchor unless it is pinned.**
//
//   - a child item's dates anchor to its PARENT's scheduled date,
//   - an item's due date anchors to its OWN scheduled date,
//   - a recurring series' due date anchors to the occurrence it advances to.
//
// When an anchor moves by N days, the dates hanging off it move by N days too,
// preserving the gap the user already set. Pinning a date opts it out: "this one
// really is Apr 15 whatever else moves."
//
// This REPLACES the stored-offset model of ADR-085 (`properties.relativeSchedule`).
// That field required an explicit write from one control, so a subtask created
// any other way (MCP `add_subtasks`, a template, a clone) silently never tracked
// its parent. Anchoring is the DEFAULT here, so nothing has to be stamped and
// there is no backfill: the gap is simply whatever the two dates currently are.
// `relativeSchedule` is left readable for the offset chip's label but is no
// longer written or required — see `relative-subtask.ts`.
//
// PURE + client-safe: no DB, no dates-as-instants. Calendar-day (YYYY-MM-DD, UTC)
// math only, the recurrence.ts convention (ADR-008).

// Which of an item's two dates is pinned. Stored under
// `items.properties.datePins` (jsonb, no column — light owner data, like
// properties.recurrence / focus / relativeSchedule before it).
export type DatePins = {
  // The item's scheduled date ignores its parent's moves.
  scheduled?: boolean;
  // The item's due date ignores its own scheduled date's moves (a hard external
  // deadline: taxes, a grant submission, a hand-off).
  due?: boolean;
};

// Tolerant parse (the views.ts / recurrence.ts discipline): anything that isn't
// a plain object of booleans reads as "nothing pinned", never throws.
export function parseDatePins(raw: unknown): DatePins {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const pins: DatePins = {};
  if (o.scheduled === true) pins.scheduled = true;
  if (o.due === true) pins.due = true;
  return pins;
}

export function datePinsOf(
  properties: Record<string, unknown> | null | undefined
): DatePins {
  return parseDatePins(properties?.datePins);
}

// Does this item's scheduled date follow its parent?
export function isScheduledPinned(
  properties: Record<string, unknown> | null | undefined
): boolean {
  return datePinsOf(properties).scheduled === true;
}

// Does this item's due date follow its own scheduled date?
//
// Back-compat: ADR-076's `recurrence.maintainDueOffset` was the old, GUI-less,
// default-OFF version of this rule, reachable only over MCP. It is superseded —
// anchoring is now the default — but an explicit `maintainDueOffset: false` from
// an existing caller still reads as "pin the deadline", so nobody's stored intent
// silently inverts. `set_recurrence` translates the flag to a pin on write.
export function isDuePinned(
  properties: Record<string, unknown> | null | undefined
): boolean {
  return datePinsOf(properties).due === true;
}

// Merge a pin change into an existing properties bag, dropping the key entirely
// when nothing is pinned (so we don't litter every item with `datePins: {}`).
export function withDatePin(
  properties: Record<string, unknown> | null | undefined,
  which: keyof DatePins,
  pinned: boolean
): Record<string, unknown> {
  const props = { ...(properties ?? {}) };
  const pins = { ...datePinsOf(props) };
  if (pinned) pins[which] = true;
  else delete pins[which];
  if (Object.keys(pins).length === 0) delete props.datePins;
  else props.datePins = pins;
  return props;
}

// Whole days between two UTC-midnight calendar days. Null when either side is
// missing, which every caller reads as "no anchor moved, shift nothing".
export function dayDelta(before: Date | null, after: Date | null): number | null {
  if (!before || !after) return null;
  const d = Math.round((after.getTime() - before.getTime()) / 86_400_000);
  return d === 0 ? null : d;
}

// Shift a UTC-midnight calendar day by N days, preserving null.
export function shiftDay(date: Date | null, deltaDays: number): Date | null {
  if (!date) return null;
  return new Date(date.getTime() + deltaDays * 86_400_000);
}

// Is this deadline incoherent — a due date landing BEFORE the day the work is
// planned for? Surfaced as a cue + a one-click fix, never blocked: sometimes you
// genuinely missed a deadline and the honest record is "due Aug 28, working it
// Sep 14" (ADR-253).
export function isDueBeforeScheduled(
  scheduled: Date | null | undefined,
  due: Date | null | undefined
): boolean {
  if (!scheduled || !due) return false;
  return due.getTime() < scheduled.getTime();
}
