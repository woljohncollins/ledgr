// The placement layer (ADR-timeline): the one seam that turns a stored item into
// a position on a calendar/timeline and turns a drag back into a write. It is
// what makes the Planner type-agnostic — every renderer (Month, Timeline)
// consumes Placements and NEVER reads a date field directly, so a new field
// shape is added here alone.
//
// Two things it knows that renderers must not:
//  1. How each field STORES time. Calendar-day fields (scheduled/due/note) are
//     UTC-midnight, zone-free (ADR-008); real instants (meeting_at/end_at,
//     created/updated) carry a wall-clock time in the owner's zone; a task's
//     intra-day block is start+duration in properties.scheduledTime (floating).
//  2. Which edits are LEGAL. A read-only field (created/updated) can't be moved;
//     a single-anchor item can't be resized until it gains an end. The renderer
//     just honors the `can` flags.
//
// Pure and dependency-light (only zone.ts + scheduled-time.ts, both client-safe),
// so the client renderers, a server pre-layout, and the verify script share one
// source of truth (the scheduled-time.ts discipline).

import { ymdInZone, minutesInZone, zonedInstant, type Ymd } from "@/lib/zone";
import {
  parseScheduledTime,
  startMinutes,
  DEFAULT_DURATION_MINUTES,
} from "@/lib/scheduled-time";
// Type-only (erased at build) so this client-safe seam never pulls the
// DB-importing views.ts into a bundle, and there's no runtime import cycle
// (views.ts imports values from here; this imports only types from there).
import type { DateProperty, ViewDisplay } from "@/lib/views";

// A built-in date field, or "plan" (scheduled ?? due, ADR-109). Real-instant
// fields carry a time-of-day; the rest are calendar days.
export const BUILTIN_DATES = [
  "plan",
  "scheduledDate",
  "dueDate",
  "meetingAt",
  "endAt",
  "noteDate",
  "createdAt",
  "updatedAt",
] as const;
export type BuiltinDate = (typeof BUILTIN_DATES)[number];

// Where a spec's start or end points: a built-in field, or a custom date
// property by key (its end sibling is the key "<key>__end", the range rule).
export type DateRef = { field: BuiltinDate } | { prop: string };

// A view's placement config: the field an item is anchored by, and optionally
// the field that ends its span (a bar). endField null/absent = a single anchor.
export type PlacementSpec = { start: DateRef; end?: DateRef | null };

// Derive the placement spec from a view's date property + any explicit
// start/end fields (ADR-166), shared by every planner renderer so Month and
// Timeline agree. A meeting anchors to its end_at; a scheduled/plan task pairs
// with its due date (chip if only one is set, bar if both). An explicit
// startField/endField in the view display wins over the derivation.
export function deriveSpec(prop: DateProperty | null, display: ViewDisplay | null): PlacementSpec {
  const start: DateRef = display?.startField ?? (prop ? { field: prop } : { field: "plan" });
  let end: DateRef | undefined = display?.endField ?? undefined;
  if (!end && "field" in start) {
    if (start.field === "meetingAt") end = { field: "endAt" };
    else if (start.field === "scheduledDate" || start.field === "plan") end = { field: "dueDate" };
  }
  return { start, end };
}

// The suffix a `withEnd` date property uses for its end value (ADR-timeline).
// Start lives at properties[key] (an ISO scalar, ADR-008, so existing filters/
// sorts on the start key are untouched); end lives at properties[key + END_SUFFIX].
export const END_SUFFIX = "__end";
export const endPropKey = (key: string) => `${key}${END_SUFFIX}`;

// A normalized position, zone-resolved. `ymd` is always the calendar day the
// item sits on; `minutes` is wall-clock minutes since midnight when the field
// carries a time, else null (an all-day chip).
export type Anchor = { ymd: string; minutes: number | null };

export type Placement = {
  start: Anchor | null; // null = no value in the start field → the "no date" rail
  end: Anchor | null; // null = single anchor (chip); set = a span (bar)
  can: { move: boolean; resizeStart: boolean; resizeEnd: boolean };
};

// The minimal item shape the layer reads (ViewItem satisfies it). Structural so
// this lib never imports a component.
export type PlaceableItem = {
  type: string;
  scheduledDate: Date | null;
  dueDate: Date | null;
  meetingAt: Date | null;
  endAt: Date | null;
  noteDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  properties: unknown;
};

// --- reading a field → an Anchor -----------------------------------------

const ymdUtcKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
const pad = (n: number) => String(n).padStart(2, "0");
const ymdOf = (r: Ymd) => `${r.y}-${pad(r.m)}-${pad(r.d)}`;
// UTC-midnight ISO for a calendar-day write (ADR-008), matching the planner's
// existing day writes.
const dayIso = (ymd: string) => `${ymd}T00:00:00.000Z`;

// Real instants carry a time-of-day; calendar-day columns don't. "plan" follows
// scheduled (its day is a scheduled day, which may carry a scheduledTime block).
function isInstantField(field: BuiltinDate): boolean {
  return field === "meetingAt" || field === "endAt" || field === "createdAt" || field === "updatedAt";
}
// Only these can be written by a drag; created/updated are read-only anchors,
// and "plan" is written via its scheduled day.
function isWritableField(field: BuiltinDate): boolean {
  return field === "plan" || field === "scheduledDate" || field === "dueDate" ||
    field === "meetingAt" || field === "endAt" || field === "noteDate";
}

function builtinDate(item: PlaceableItem, field: BuiltinDate): Date | null {
  switch (field) {
    case "plan":
      return item.scheduledDate ?? item.dueDate;
    case "scheduledDate":
      return item.scheduledDate;
    case "dueDate":
      return item.dueDate;
    case "meetingAt":
      return item.meetingAt;
    case "endAt":
      return item.endAt;
    case "noteDate":
      return item.noteDate;
    case "createdAt":
      return item.createdAt;
    case "updatedAt":
      return item.updatedAt;
  }
}

function propString(properties: unknown, key: string): string | null {
  if (typeof properties !== "object" || properties === null) return null;
  const v = (properties as Record<string, unknown>)[key];
  return typeof v === "string" && v.length >= 10 ? v : null;
}

// A custom date property value is either a day scalar ("2026-09-10") or, for a
// `withTime` field (ADR-254), a full ISO instant. Anything longer than a day
// that parses is the instant; a bare day (or garbage) returns null so the
// caller keeps the day-only path. Exported so the spine and the cell renderer
// agree with placement on which values carry a clock.
export function propInstant(v: string | null): Date | null {
  if (!v || v.length <= 10) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Resolve one DateRef on an item to an Anchor (or null when unset). tz governs
// how a real instant is split into a local day + minutes.
function readAnchor(item: PlaceableItem, ref: DateRef, tz: string): Anchor | null {
  if ("prop" in ref) {
    const v = propString(item.properties, ref.prop);
    if (!v) return null;
    // A withTime prop stores a real instant (ADR-254): split it in the owner's
    // zone like meetingAt. A day scalar stays an all-day anchor.
    const inst = propInstant(v);
    if (inst) return { ymd: ymdOf(ymdInZone(inst, tz)), minutes: minutesInZone(inst, tz) };
    return { ymd: v.slice(0, 10), minutes: null };
  }
  const d = builtinDate(item, ref.field);
  if (!d) return null;
  if (isInstantField(ref.field)) {
    return { ymd: ymdOf(ymdInZone(d, tz)), minutes: minutesInZone(d, tz) };
  }
  // Calendar-day field (UTC-midnight). A scheduled day may carry an intra-day
  // time block in properties.scheduledTime; surface its start as the minutes so
  // the item places by time at fine zoom (the old Multi-day behavior).
  const ymd = ymdUtcKey.format(d);
  if (ref.field === "scheduledDate" || ref.field === "plan") {
    const st = parseScheduledTime(item.properties);
    return { ymd, minutes: st ? startMinutes(st) : null };
  }
  return { ymd, minutes: null };
}

// --- the two public functions --------------------------------------------

// Where an item sits and what may be done to it, for a given spec + zone.
export function resolvePlacement(item: PlaceableItem, spec: PlacementSpec, tz: string): Placement {
  const start = readAnchor(item, spec.start, tz);
  let end = spec.end ? readAnchor(item, spec.end, tz) : null;

  // A scheduled task with a time block but no explicit endField still spans its
  // block within the day: derive the end from start + the block's duration, so a
  // 2:00–3:30 task shows as a bar and its bottom edge is grabbable. This is ONLY
  // for a spec with no end field (the intra-day / Multi-day case). When the spec
  // DOES declare an end (e.g. deriveSpec pairing scheduled→due), the end is that
  // field: a block must not masquerade as a due date, or buildPatch would write
  // the block's end into dueDate on a move (ADR-166 slice 5 fix). The block's
  // duration is then preserved by buildPatch's writeRef, not surfaced as a bar.
  const startIsSchedule =
    !("prop" in spec.start) && (spec.start.field === "scheduledDate" || spec.start.field === "plan");
  if (!spec.end && !end && start && startIsSchedule && start.minutes != null) {
    const st = parseScheduledTime(item.properties);
    const dur = st?.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    end = { ymd: start.ymd, minutes: start.minutes + dur };
  }

  // Guard a backwards span: an end before the start (e.g. a scheduled→due task
  // whose deadline is already past its planned day) can't be a bar — drop the
  // end so it renders as a single chip at the start.
  if (start && end && anchorBefore(end, start)) end = null;

  const startWritable = !("prop" in spec.start) ? isWritableField(spec.start.field) : true;
  const endWritable = spec.end
    ? "prop" in spec.end || isWritableField(spec.end.field)
    : startIsSchedule; // the derived scheduledTime block is resizable (writes duration)

  return {
    start,
    end,
    can: {
      move: start != null && startWritable,
      // Resizing needs a span (an end) whose field is writable.
      resizeStart: end != null && startWritable && start != null,
      resizeEnd: end != null && endWritable,
    },
  };
}

// A partial PATCH body (the shape /api/items/[id] accepts): typed date fields
// and/or a propertyPatch. Merged across refs by buildPatch.
export type PatchParts = {
  fields: Record<string, string | null>;
  propertyPatch: Record<string, unknown>;
};

function emptyParts(): PatchParts {
  return { fields: {}, propertyPatch: {} };
}

// Write one ref to a target anchor (or null to clear). `blockEndMinutes` lets a
// scheduled day also carry its intra-day block duration (start→end same day).
function writeRef(
  item: PlaceableItem,
  ref: DateRef,
  anchor: Anchor | null,
  tz: string,
  blockEndMinutes?: number | null,
): PatchParts {
  const parts = emptyParts();
  if ("prop" in ref) {
    // Value-driven (ADR-254): an anchor with minutes writes an instant, one
    // without writes the day. The view's zoom decides which the drag produced.
    parts.propertyPatch[ref.prop] = !anchor
      ? null
      : anchor.minutes != null
        ? zonedInstant(ymdToRec(anchor.ymd), anchor.minutes, tz).toISOString()
        : anchor.ymd;
    return parts;
  }
  const f = ref.field;
  if (f === "meetingAt" || f === "endAt") {
    parts.fields[f] = anchor ? zonedInstant(ymdToRec(anchor.ymd), anchor.minutes ?? 0, tz).toISOString() : null;
    return parts;
  }
  // "plan" writes the scheduled day (ADR-109: planning sets the scheduled date).
  const dayField = f === "plan" ? "scheduledDate" : f;
  parts.fields[dayField] = anchor ? dayIso(anchor.ymd) : null;
  // The scheduled day owns the intra-day time block (properties.scheduledTime).
  if (dayField === "scheduledDate") {
    if (anchor && anchor.minutes != null) {
      // Duration: from an explicit same-day resize end when given; otherwise keep
      // the block's existing duration (a plain move must not reset it), falling
      // back to the default only when there's no prior block.
      const durationMinutes =
        blockEndMinutes != null
          ? Math.max(1, blockEndMinutes - anchor.minutes)
          : parseScheduledTime(item.properties)?.durationMinutes ?? DEFAULT_DURATION_MINUTES;
      parts.propertyPatch.scheduledTime = { start: minutesToHhmm(anchor.minutes), durationMinutes };
    } else {
      parts.propertyPatch.scheduledTime = null; // all-day or cleared
    }
  }
  return parts;
}

// Build the PATCH body to move/resize `item` to a desired placement. Pass the
// full desired {start, end}; a rail-drop is start=null. Only the spec's own
// fields are touched, so unrelated data is never clobbered.
export function buildPatch(
  item: PlaceableItem,
  spec: PlacementSpec,
  tz: string,
  next: { start: Anchor | null; end: Anchor | null },
): Record<string, unknown> {
  const startSameDayEnd =
    next.start && next.end && next.start.ymd === next.end.ymd ? next.end.minutes : null;
  const acc = writeRef(item, spec.start, next.start, tz, startSameDayEnd);

  // Write the end only to a distinct, real end field (endAt or a custom
  // "<key>__end"). A same-day scheduled block's end was already folded into
  // scheduledTime.durationMinutes above, so it has no separate field to write.
  if (spec.end) {
    const endRef: DateRef = "prop" in spec.end ? spec.end : { field: spec.end.field };
    const merge = writeRef(item, endRef, next.end, tz);
    Object.assign(acc.fields, merge.fields);
    Object.assign(acc.propertyPatch, merge.propertyPatch);
  }

  const body: Record<string, unknown> = { ...acc.fields };
  if (Object.keys(acc.propertyPatch).length) body.propertyPatch = acc.propertyPatch;
  return body;
}

// --- tiny local helpers ---------------------------------------------------

function ymdToRec(ymd: string): Ymd {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}
function minutesToHhmm(minutes: number): string {
  const within = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(within / 60))}:${pad(within % 60)}`;
}
// True when anchor `a` falls strictly before `b`. ISO ymd sorts lexically
// (ADR-008); same day compares minutes (a null minute = day start = 0).
function anchorBefore(a: Anchor, b: Anchor): boolean {
  if (a.ymd !== b.ymd) return a.ymd < b.ymd;
  return (a.minutes ?? 0) < (b.minutes ?? 0);
}
