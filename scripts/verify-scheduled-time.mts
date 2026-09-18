// Stage A time-blocking verification (explorations/calendar-time-blocking.md):
// an optional scheduled start time + duration on a task, surfaced as a timed
// block in the published ICS feed. Three layers: the pure helper
// (scheduled-time.ts — parse/validate/format), the pure ICS builder (ics.ts —
// timed DTSTART/DTEND, alarms, recurring + EXDATE, cross-midnight), and the
// server assembler (ics-data.ts) against live Neon (the time attaches to a
// scheduled day, is ignored on a due-only event). Run:
//   npx tsx scripts/verify-scheduled-time.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const {
  parseScheduledTime,
  startMinutes,
  endMinutes,
  splitMinutes,
  formatTime12,
  formatRange,
  isValidStart,
  DEFAULT_DURATION_MINUTES,
} = await import("../src/lib/scheduled-time");
const { buildTaskCalendar } = await import("../src/lib/ics");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const STAMP = "20260618T120000Z";

console.log("\n# Pure: scheduled-time helper");
{
  check("valid start parses", JSON.stringify(parseScheduledTime({ scheduledTime: { start: "14:00", durationMinutes: 90 } })) === JSON.stringify({ start: "14:00", durationMinutes: 90 }));
  check("missing duration defaults", parseScheduledTime({ scheduledTime: { start: "09:30" } })?.durationMinutes === DEFAULT_DURATION_MINUTES);
  check("zero/negative duration defaults", parseScheduledTime({ scheduledTime: { start: "09:30", durationMinutes: 0 } })?.durationMinutes === DEFAULT_DURATION_MINUTES);
  check("null scheduledTime → null", parseScheduledTime({ scheduledTime: null }) === null);
  check("absent → null", parseScheduledTime({}) === null);
  check("malformed start → null", parseScheduledTime({ scheduledTime: { start: "25:00" } }) === null);
  check("non-string start → null", parseScheduledTime({ scheduledTime: { start: 900 } }) === null);
  check("null properties → null", parseScheduledTime(null) === null);
  check("isValidStart edges", isValidStart("00:00") && isValidStart("23:59") && !isValidStart("24:00") && !isValidStart("12:60") && !isValidStart("9:00"));

  const t = { start: "14:00", durationMinutes: 90 };
  check("startMinutes", startMinutes(t) === 14 * 60);
  check("endMinutes", endMinutes(t) === 14 * 60 + 90);
  check("splitMinutes same-day", JSON.stringify(splitMinutes(endMinutes(t))) === JSON.stringify({ dayOffset: 0, hhmm: "15:30" }));
  check("splitMinutes rolls past midnight", JSON.stringify(splitMinutes(23 * 60 + 30 + 90)) === JSON.stringify({ dayOffset: 1, hhmm: "01:00" }));
  check("formatTime12 am/pm/noon/midnight", formatTime12("14:00") === "2:00 PM" && formatTime12("00:00") === "12:00 AM" && formatTime12("12:00") === "12:00 PM" && formatTime12("09:05") === "9:05 AM");
  check("formatRange same-day", formatRange(t) === "2:00 PM – 3:30 PM");
  check("formatRange across midnight", formatRange({ start: "23:30", durationMinutes: 90 }) === "11:30 PM – 1:00 AM (+1d)");
}

console.log("\n# Pure: ICS builder — timed blocks");
{
  const ics = buildTaskCalendar(
    [{ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "Sermon prep", date: "2026-06-20", startTime: "14:00", durationMinutes: 90, url: "https://x/items/1" }],
    { dtstamp: STAMP }
  );
  check("timed DTSTART (floating, no Z)", ics.includes("DTSTART:20260620T140000") && !ics.includes("DTSTART:20260620T140000Z"));
  check("timed DTEND = start + duration", ics.includes("DTEND:20260620T153000"));
  check("not an all-day VALUE=DATE", !ics.includes("VALUE=DATE"));
  check("timed default alarm fires at start", ics.includes("TRIGGER:PT0M") && !ics.includes("TRIGGER:PT9H"));
}
{
  // No start time → still all-day, exactly as before (no regression).
  const ics = buildTaskCalendar(
    [{ id: "aaaaaaaa-0000-0000-0000-000000000002", title: "All-day task", date: "2026-06-20" }],
    { dtstamp: STAMP }
  );
  check("absent start → all-day DTSTART", ics.includes("DTSTART;VALUE=DATE:20260620"));
  check("absent start → all-day DTEND next day", ics.includes("DTEND;VALUE=DATE:20260621"));
  check("absent start → 9am default alarm", ics.includes("TRIGGER:PT9H"));
}
{
  // Missing duration on a timed block defaults to 60 minutes.
  const ics = buildTaskCalendar(
    [{ id: "aaaaaaaa-0000-0000-0000-000000000003", title: "Default length", date: "2026-06-20", startTime: "09:00" }],
    { dtstamp: STAMP }
  );
  check("default 60m duration → DTEND +1h", ics.includes("DTSTART:20260620T090000") && ics.includes("DTEND:20260620T100000"));
}
{
  // A block that runs past midnight rolls DTEND into the next day.
  const ics = buildTaskCalendar(
    [{ id: "aaaaaaaa-0000-0000-0000-000000000004", title: "Late block", date: "2026-06-20", startTime: "23:30", durationMinutes: 90 }],
    { dtstamp: STAMP }
  );
  check("DTEND rolls to next day", ics.includes("DTSTART:20260620T233000") && ics.includes("DTEND:20260621T010000"));
}
{
  // Reminder lead time is measured from the timed start (minutes before).
  const ics = buildTaskCalendar(
    [{ id: "aaaaaaaa-0000-0000-0000-000000000005", title: "With lead", date: "2026-06-20", startTime: "14:00", durationMinutes: 30, reminderMinutes: 15 }],
    { dtstamp: STAMP }
  );
  check("reminder overrides timed default", ics.includes("TRIGGER:-PT15M") && !ics.includes("TRIGGER:PT0M"));
}
{
  // A timed recurring series: timed DTSTART + RRULE, and EXDATE must be DATE-TIME
  // (matching DTSTART) at the block start, not VALUE=DATE.
  const ics = buildTaskCalendar(
    [{ id: "aaaaaaaa-0000-0000-0000-000000000006", title: "Weekly block", date: "2026-06-15", startTime: "08:00", durationMinutes: 60, rrule: "FREQ=WEEKLY;BYDAY=MO", exdates: ["2026-06-15", "2026-06-22"] }],
    { dtstamp: STAMP }
  );
  check("timed recurring keeps the RRULE", ics.includes("RRULE:FREQ=WEEKLY;BYDAY=MO"));
  check("timed DTSTART on the anchor", ics.includes("DTSTART:20260615T080000"));
  check("EXDATE is DATE-TIME at the start, not VALUE=DATE", ics.includes("EXDATE:20260615T080000,20260622T080000") && !ics.includes("EXDATE;VALUE=DATE"));
}

// ---------------------------------------------------------------------------
const { getDb } = await import("../src/db");
const { items, users } = await import("../src/db/schema");
const { createItem } = await import("../src/lib/item-mutations");
const { listIcsTasks } = await import("../src/lib/ics-data");
const { eq: dEq, inArray } = await import("drizzle-orm");

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const db = getDb();
const stamp = Date.now();
const [owner] = await db.insert(users).values({ email: `verify-sched-time-${stamp}@example.invalid` }).returning({ id: users.id });

try {
  console.log("\n# Service: scheduled time attaches to the feed (live Neon)");

  // A scheduled day + a time → timed block in the feed.
  const timed = await createItem(owner.id, {
    type: "task",
    title: "timed scheduled",
    scheduledDate: ymdToUtc("2026-06-20"),
    properties: { scheduledTime: { start: "14:00", durationMinutes: 90 } },
  });
  // A due-only task with a (meaningless) scheduledTime → time must NOT apply:
  // the time refines the scheduled day, and a deadline has none.
  const dueOnly = await createItem(owner.id, {
    type: "task",
    title: "due only with stray time",
    dueDate: ymdToUtc("2026-06-22"),
    properties: { scheduledTime: { start: "09:00", durationMinutes: 30 } },
  });
  // A scheduled day with no time → stays all-day.
  const plain = await createItem(owner.id, {
    type: "task",
    title: "scheduled, no time",
    scheduledDate: ymdToUtc("2026-06-21"),
  });

  const tasks = await listIcsTasks(owner.id, "https://ledgr.test");
  const t = tasks.find((x) => x.id === timed.id)!;
  check("timed task carries startTime", t.startTime === "14:00", `startTime=${t.startTime}`);
  check("timed task carries duration", t.durationMinutes === 90, `duration=${t.durationMinutes}`);

  const d = tasks.find((x) => x.id === dueOnly.id)!;
  check("due-only ignores the stray time (stays all-day)", d.startTime == null, `startTime=${d.startTime}`);

  const p = tasks.find((x) => x.id === plain.id)!;
  check("scheduled-no-time stays all-day", p.startTime == null);

  // The rendered feed shows a timed block for the timed task and all-day for the rest.
  const feed = buildTaskCalendar(tasks, { dtstamp: STAMP });
  check("feed emits a timed DTSTART for the timed task", feed.includes("DTSTART:20260620T140000"));
  check("feed keeps the due-only task all-day", feed.includes("DTSTART;VALUE=DATE:20260622"));
} finally {
  await db.update(items).set({ parentId: null }).where(dEq(items.ownerId, owner.id));
  await db.delete(items).where(dEq(items.ownerId, owner.id));
  await db.delete(users).where(inArray(users.id, [owner.id]));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
