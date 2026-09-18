// Bucket granularity for the vertical timeline spine: how much time one chip on
// the spine covers. The vocabulary is TIMELINE_ZOOMS (ADR-166) reused verbatim,
// so a view's `display.zoom` means "px per day" on the horizontal Timeline and
// "one chip per span" on the vertical History, rather than the two renderings
// carrying two knobs that mean the same thing.
//
// Every grain is offered on every type (Brandon, 2026-09-03): a type whose dates
// are calendar days simply has nothing finer than a day to bucket by, and the
// right answer there is to fall back to the day rather than to hide the control
// or invent a midnight. See `grainBucket`'s calendarDay branch.
//
// Pure and client-safe: type-only import from views.ts (which reaches the DB),
// same discipline as placement.ts, so a client renderer can bucket too.
import { addDays } from "@/lib/timeline-geometry";
import type { TimelineZoom } from "@/lib/views";

export type Grain = TimelineZoom;

// The grains the spine offers, in coarsening order. `satisfies` keeps this in
// step with TIMELINE_ZOOMS: drop or rename a zoom there and this fails to build.
export const SPINE_GRAINS = [
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "halfDecade",
] as const satisfies readonly TimelineZoom[];

export const DEFAULT_GRAIN: Grain = "month";

export function parseGrain(raw: string | string[] | undefined): Grain {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (SPINE_GRAINS as readonly string[]).includes(v ?? "") ? (v as Grain) : DEFAULT_GRAIN;
}

type Parts = { y: number; m: number; d: number; h: number };

// The instant's calendar position in `zone`. en-CA gives zero-padded numerics,
// and hour12:false can yield "24" for midnight in some ICU builds, hence % 24.
function zoneParts(date: Date, zone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: num("year"), m: num("month"), d: num("day"), h: num("hour") % 24 };
}

const p2 = (n: number) => String(n).padStart(2, "0");
const ymdOf = (p: Parts) => `${p.y}-${p2(p.m)}-${p2(p.d)}`;

// Label a resolved calendar position. The position is already zone-resolved, so
// it formats as a UTC instant: going back through a named zone here would apply
// the offset a second time and slide a chip into the wrong day.
function label(ymd: string, opts: Intl.DateTimeFormatOptions, hour = 0): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d, hour))
  );
}

function dow(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// The chip an entry falls under: a stable key (change of key = new chip) and the
// text on it. `calendarDay` follows TimelineEntry: true for a UTC-midnight day
// (a due date, a note date, a custom date property), which formats in UTC, and
// false for a real instant, which formats in the owner's zone. Getting this
// backwards is what slides a due date one day earlier in US time zones.
export function grainBucket(
  date: Date,
  grain: Grain,
  tz: string,
  calendarDay: boolean
): { key: string; label: string } {
  const zone = calendarDay ? "UTC" : tz;
  const p = zoneParts(date, zone);
  const ymd = ymdOf(p);

  switch (grain) {
    case "hour":
      // A day-only date has no hour to sit in, so it buckets by its day rather
      // than pretending to have happened at midnight.
      return calendarDay
        ? { key: ymd, label: label(ymd, { weekday: "long", month: "long", day: "numeric" }) }
        : {
            key: `${ymd}T${p2(p.h)}`,
            label: label(ymd, { month: "short", day: "numeric", hour: "numeric" }, p.h),
          };
    case "day":
      return { key: ymd, label: label(ymd, { weekday: "long", month: "long", day: "numeric" }) };
    case "week": {
      // Weeks start Monday, matching the horizontal ruler's week major
      // (timeline-geometry.ts ticks on dow === 1), so both renderings agree on
      // where a week begins.
      const start = addDays(ymd, dow(ymd) === 0 ? -6 : 1 - dow(ymd));
      return { key: start, label: `Week of ${label(start, { month: "long", day: "numeric" })}` };
    }
    case "month":
      // Must stay "September 2026": this is the label the record timeline has
      // always shown, and month is the default grain.
      return { key: `${p.y}-${p2(p.m)}`, label: label(ymd, { month: "long", year: "numeric" }) };
    case "quarter": {
      const q = Math.floor((p.m - 1) / 3) + 1;
      return { key: `${p.y}-Q${q}`, label: `Q${q} ${p.y}` };
    }
    case "year":
      return { key: String(p.y), label: String(p.y) };
    default: {
      const start = Math.floor(p.y / 5) * 5;
      return { key: `h5-${start}`, label: `${start}–${start + 4}` };
    }
  }
}

// Control labels, shared by the record page's grain links and the view builder.
export const GRAIN_LABELS: Record<Grain, string> = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  halfDecade: "5-Year",
};
