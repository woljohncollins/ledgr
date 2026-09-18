// Timeline geometry verification (ADR-166): date↔x round-trips and ruler ticks
// across zooms. Pure, no DB. Run: npx tsx scripts/verify-timeline-geometry.mts
import {
  pxPerDay,
  daysBetween,
  dateToX,
  xToDate,
  addDays,
  snapMinutes,
  ticks,
  applyTimelineDrag,
} from "../src/lib/timeline-geometry";
import { grainBucket, SPINE_GRAINS } from "../src/lib/timeline-grain";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const O = "2026-07-20"; // a Monday

check("daysBetween forward", daysBetween(O, "2026-07-27") === 7);
check("daysBetween backward", daysBetween(O, "2026-07-18") === -2);
check("daysBetween across month", daysBetween("2026-07-30", "2026-08-02") === 3);
check("addDays wraps month", addDays("2026-07-30", 3) === "2026-08-02", addDays("2026-07-30", 3));
check("addDays negative", addDays(O, -1) === "2026-07-19", addDays(O, -1));

// day-only chip at week zoom sits at day boundary
check(
  "dateToX day-only = dayIndex * ppd",
  dateToX("2026-07-27", null, O, "week") === 7 * pxPerDay("week"),
);

// timed anchor adds intraday fraction (12:00 = half a day)
{
  const ppd = pxPerDay("day");
  check("dateToX timed noon = 0.5 day", dateToX(O, 720, O, "day") === 0.5 * ppd, String(dateToX(O, 720, O, "day")));
}

// round-trip at hour zoom snaps to 15 min
{
  const x = dateToX("2026-07-21", 615, O, "hour"); // 10:15 next day
  const back = xToDate(x, O, "hour");
  check("hour round-trip ymd", back.ymd === "2026-07-21", back.ymd);
  check("hour round-trip minutes (snap 15)", back.minutes === 615, String(back.minutes));
  check("hour snap = 15", snapMinutes("hour") === 15);
}

// coarse zoom → day-only (minutes null)
{
  const x = dateToX("2026-08-01", null, O, "month");
  const back = xToDate(x + 5, O, "month"); // a few px into the day still resolves that day
  check("month zoom resolves day", back.ymd === "2026-08-01", back.ymd);
  check("month zoom minutes null", back.minutes === null);
  check("month snap null", snapMinutes("month") === null);
}

// ticks: week zoom yields one per day, major on Mondays, spanning the range
{
  const t = ticks(O, 14, "week");
  check("week ticks count = 14", t.length === 14, String(t.length));
  check("week tick 0 is major (Monday)", t[0].major === true);
  check("week tick 1 not major (Tuesday)", t[1].major === false);
  check("week tick 7 major (next Monday)", t[7].major === true);
  check("week first tick x = 0", t[0].x === 0);
}

// ticks: hour zoom yields intraday ticks, major at midnight
{
  const t = ticks(O, 1, "hour");
  check("hour ticks = 24 in a day", t.length === 24, String(t.length));
  check("hour tick 0 major (midnight)", t[0].major === true);
  check("hour tick 1 not major", t[1].major === false);
}

// --- drag math (slice 4) ---------------------------------------------------

// Move a day-only chip: whole-day shift by exactly one day's px, end stays null.
{
  const r = applyTimelineDrag("move", O, { ymd: O, minutes: null }, null, pxPerDay("week"), "week");
  check("move day-only chip +1 day", r.start.ymd === addDays(O, 1) && r.start.minutes === null, JSON.stringify(r.start));
  check("move chip keeps single anchor", r.end === null);
}

// Move a day-only BAR (scheduled→due) preserves the span (both edges shift same).
{
  const start = { ymd: O, minutes: null };
  const end = { ymd: addDays(O, 3), minutes: null }; // 3-day span
  const r = applyTimelineDrag("move", O, start, end, 2 * pxPerDay("week"), "week");
  check("move bar start +2 days", r.start.ymd === addDays(O, 2), r.start.ymd);
  check("move bar preserves span (end +2 days)", r.end?.ymd === addDays(O, 5), r.end?.ymd);
}

// Move a timed anchor at hour zoom snaps to 15-min slots and preserves the day.
{
  const start = { ymd: O, minutes: 600 }; // 10:00
  // +40px at 2400px/day = +40/2400 day = +24 min → snaps to +30 (nearest 15 → 45? 624 rounded to 15 = 630)
  const r = applyTimelineDrag("move", O, start, null, 40, "hour");
  check("move timed snaps to 15 (10:00 +24min → 10:30)", r.start.minutes === 630, String(r.start.minutes));
  check("move timed keeps day", r.start.ymd === O, r.start.ymd);
}

// Move a timed anchor at COARSE zoom moves whole days and keeps the time-of-day.
{
  const start = { ymd: O, minutes: 540 }; // 9:00 meeting
  const r = applyTimelineDrag("move", O, start, { ymd: O, minutes: 600 }, pxPerDay("month"), "month");
  check("coarse move keeps time-of-day (9:00)", r.start.minutes === 540, String(r.start.minutes));
  check("coarse move shifts one day", r.start.ymd === addDays(O, 1), r.start.ymd);
  check("coarse move preserves end time + span", r.end?.minutes === 600 && r.end?.ymd === addDays(O, 1), JSON.stringify(r.end));
}

// resizeEnd extends the span; start is untouched.
{
  const start = { ymd: O, minutes: null };
  const end = { ymd: addDays(O, 1), minutes: null };
  const r = applyTimelineDrag("resizeEnd", O, start, end, 2 * pxPerDay("week"), "week");
  check("resizeEnd extends to +3 days", r.end?.ymd === addDays(O, 3), r.end?.ymd);
  check("resizeEnd leaves start put", r.start.ymd === O, r.start.ymd);
}

// resizeEnd clamps so a day-only bar can't collapse below one day.
{
  const start = { ymd: O, minutes: null };
  const end = { ymd: addDays(O, 3), minutes: null };
  const r = applyTimelineDrag("resizeEnd", O, start, end, -10 * pxPerDay("week"), "week");
  check("resizeEnd clamps to start + 1 day", r.end?.ymd === addDays(O, 1), r.end?.ymd);
}

// resizeStart moves the front edge; end untouched; clamps against the end.
{
  const start = { ymd: O, minutes: null };
  const end = { ymd: addDays(O, 4), minutes: null };
  const r = applyTimelineDrag("resizeStart", O, start, end, 2 * pxPerDay("week"), "week");
  check("resizeStart moves front +2 days", r.start.ymd === addDays(O, 2), r.start.ymd);
  check("resizeStart leaves end put", r.end?.ymd === addDays(O, 4), r.end?.ymd);
  const clamp = applyTimelineDrag("resizeStart", O, start, end, 99 * pxPerDay("week"), "week");
  check("resizeStart clamps to end − 1 day", clamp.start.ymd === addDays(O, 3), clamp.start.ymd);
}

// --- History spine grain buckets (2026-09-03) ----------------------------
// The bucket key is what decides where a chip breaks, so these guard the two
// ways it can be wrong: a zone shift sliding an entry into the wrong span, and
// a boundary (week/quarter/year) landing on the wrong side.
{
  const CT = "America/Chicago";
  const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

  // A UTC-midnight calendar day formats in UTC. Reading it in Central time
  // would put it in the previous day, which is the classic due-date-off-by-one.
  check(
    "calendarDay entry keeps its own day",
    grainBucket(day("2026-07-01"), "day", CT, true).key === "2026-07-01",
    grainBucket(day("2026-07-01"), "day", CT, true).key,
  );
  check(
    "calendarDay entry keeps its own month",
    grainBucket(day("2026-07-01"), "month", CT, true).key === "2026-07",
    grainBucket(day("2026-07-01"), "month", CT, true).key,
  );
  // A real instant formats in the owner's zone: 01:30 UTC on Jul 1 is still
  // Jun 30 in Central, so it belongs to June.
  check(
    "instant buckets in the owner's zone",
    grainBucket(new Date("2026-07-01T01:30:00Z"), "month", CT, false).key === "2026-06",
    grainBucket(new Date("2026-07-01T01:30:00Z"), "month", CT, false).key,
  );
  // Month is the default grain and its label is the one the record timeline has
  // always shown.
  check(
    "month label unchanged",
    grainBucket(day("2026-09-15"), "month", CT, true).label === "September 2026",
    grainBucket(day("2026-09-15"), "month", CT, true).label,
  );
  // Weeks start Monday, matching the horizontal ruler's week major.
  check(
    "week starts Monday",
    grainBucket(day("2026-07-22"), "week", CT, true).key === "2026-07-20",
    grainBucket(day("2026-07-22"), "week", CT, true).key,
  );
  check(
    "Sunday belongs to the week before",
    grainBucket(day("2026-07-26"), "week", CT, true).key === "2026-07-20",
    grainBucket(day("2026-07-26"), "week", CT, true).key,
  );
  check(
    "Monday is its own week start",
    grainBucket(day("2026-07-20"), "week", CT, true).key === "2026-07-20",
    grainBucket(day("2026-07-20"), "week", CT, true).key,
  );
  // Quarter/year boundaries.
  check("quarter boundary Jul 1 = Q3", grainBucket(day("2026-07-01"), "quarter", CT, true).key === "2026-Q3");
  check("quarter boundary Jun 30 = Q2", grainBucket(day("2026-06-30"), "quarter", CT, true).key === "2026-Q2");
  check("year boundary", grainBucket(day("2026-01-01"), "year", CT, true).key === "2026");
  check("halfDecade floors to 5", grainBucket(day("2026-04-01"), "halfDecade", CT, true).label === "2025–2029");
  // Hour grain on a day-only date has no hour to sit in, so it falls back to the
  // day rather than inventing a midnight (Brandon: build hour for every type).
  check(
    "hour grain falls back to day for a day-only date",
    grainBucket(day("2026-07-01"), "hour", CT, true).key === "2026-07-01",
    grainBucket(day("2026-07-01"), "hour", CT, true).key,
  );
  check(
    "hour grain splits a real instant",
    grainBucket(new Date("2026-07-01T20:15:00Z"), "hour", CT, false).key === "2026-07-01T15",
    grainBucket(new Date("2026-07-01T20:15:00Z"), "hour", CT, false).key,
  );
  // Every grain returns a usable pair, so a stored zoom can never blank a chip.
  check(
    "every grain yields a key and a label",
    SPINE_GRAINS.every((g) => {
      const b = grainBucket(day("2026-07-01"), g, CT, true);
      return b.key.length > 0 && b.label.length > 0;
    }),
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
