// Slice 22 verification: the calendar sync engine (src/lib/calendar/sync)
// against the live Neon DB with a stub CalendarSource, under a throwaway user
// so no real meeting is ever touched. Covers create, idempotence, reschedule,
// cancel/uncancel (never delete), dedupe, trashed-item protection, properties
// merge (matcher-written keys survive), attendee FTS, owner scoping, and the
// job_state /health source. Run with: npx tsx scripts/verify-calendar-sync.mts
// Safe to delete once the slice is closed.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { calendarEvents, items, jobState, users } = await import("../src/db/schema");
const { runCalendarSync, getCalendarState, CALENDAR_JOB_KEY } = await import(
  "../src/lib/calendar/sync"
);
type CalendarEvent = import("../src/lib/calendar/types").CalendarEvent;
type CalendarSource = import("../src/lib/calendar/types").CalendarSource;
const { and, eq, isNotNull, ne, sql } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();

// Mutable stub: the test sets `stub.events` between runs to simulate a moving
// calendar. windowDays is ignored (the fixtures are already "in window").
const stub: { events: CalendarEvent[] } & CalendarSource = {
  events: [],
  async listEvents() {
    return this.events;
  },
};

function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    id: over.id,
    title: over.title ?? "Untitled meeting",
    startUtc: over.startUtc ?? new Date("2026-06-20T15:00:00Z"),
    endUtc: over.endUtc ?? new Date("2026-06-20T16:00:00Z"),
    isCancelled: over.isCancelled ?? false,
    organizer: over.organizer ?? { name: "Brandon", email: "brandon@example.invalid" },
    attendees: over.attendees ?? [],
    location: over.location ?? null,
    isOnline: over.isOnline ?? false,
    joinUrl: over.joinUrl ?? null,
    webLink: over.webLink ?? null,
    seriesMasterId: over.seriesMasterId ?? null,
    bodyPreview: over.bodyPreview ?? null,
    lastModified: over.lastModified ?? "2026-06-10T00:00:00Z",
  };
}

const [tempUser] = await db
  .insert(users)
  .values({ email: `verify-calendar-${Date.now()}@example.invalid` })
  .returning({ id: users.id });
const ownerId = tempUser.id;

// E3: the sync only auto-creates (promotes) events a matcher recognizes; force
// "every event matches" here so this script keeps exercising the create /
// reschedule / cancel / idempotence reconcile path (the feed/gating path has its
// own verify-calendar-feed.mts).
const promoteAll = { shouldPromote: async () => true };

const stampedElsewhere = async () =>
  (
    await db
      .select({ count: sql<number>`count(*)::int` })
      .from(items)
      .where(and(ne(items.ownerId, ownerId), isNotNull(items.msEventId)))
  )[0].count;
const otherEventItemsBefore = await stampedElsewhere();

const getByEvent = async (eventId: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.ownerId, ownerId), eq(items.msEventId, eventId)))
  );

const UNIQUE_ATTENDEE = `Zelphine${Date.now()}`;

try {
  // --- first run: create -------------------------------------------------
  stub.events = [
    ev({ id: "evt-roger", title: "Roger 1:1", attendees: [{ name: UNIQUE_ATTENDEE, email: "roger@example.invalid" }] }),
    ev({ id: "evt-staff", title: "Staff meeting", startUtc: new Date("2026-06-21T14:00:00Z") }),
    ev({ id: "evt-ghost", title: "Cancelled before sync", isCancelled: true }),
  ];
  const run1 = await runCalendarSync(ownerId, stub, promoteAll);
  check("run 1 creates the two live events", run1.promoted ===2, JSON.stringify(run1));
  check("run 1 skips a cancelled-before-sync event (no tombstone)", run1.cached === 1 && (await getByEvent("evt-ghost")).length === 0);
  check("run 1 seen counts all events", run1.seen === 3);

  const roger = (await getByEvent("evt-roger"))[0];
  check("created item is a meeting", roger?.type === "event");
  check("created item carries title + meeting_at", roger?.title === "Roger 1:1" && roger?.meetingAt?.toISOString() === "2026-06-20T15:00:00.000Z");
  check("created item is NOT in the inbox (fully-formed arrival, ADR-023)", roger?.inbox === false);
  check("created item stores ms_event_id", roger?.msEventId === "evt-roger");
  const cal = (roger?.properties as { calendar?: Record<string, unknown> })?.calendar;
  check("properties.calendar carries attendees + attendeeEmails", Array.isArray(cal?.attendees) && JSON.stringify(cal?.attendeeEmails) === JSON.stringify(["roger@example.invalid"]));
  check("properties.calendar.canceled is false", cal?.canceled === false);

  // --- attendee is full-text searchable ----------------------------------
  const found = await db.execute(sql`
    select id from items
    where owner_id = ${ownerId} and search @@ websearch_to_tsquery('english', ${UNIQUE_ATTENDEE})
  `);
  check("attendee name is full-text searchable (FTS over properties)", found.rows.length === 1, `${found.rows.length} hit(s)`);

  // --- idempotence --------------------------------------------------------
  const updatedAtBefore = (await getByEvent("evt-roger"))[0].updatedAt.getTime();
  // Same 3-event input (incl. the still-cancelled evt-ghost, which stays
  // uncreated): every event resolves to unchanged, nothing is written.
  const run2 = await runCalendarSync(ownerId, stub, promoteAll);
  check("run 2 is a no-op (all unchanged, ghost still uncreated)", run2.promoted ===0 && run2.updated === 0 && run2.canceled === 0 && run2.unchanged === 2 && run2.cached === 1, JSON.stringify(run2));
  check("unchanged run does not bump updated_at (no re-export churn)", (await getByEvent("evt-roger"))[0].updatedAt.getTime() === updatedAtBefore);

  // --- reschedule ---------------------------------------------------------
  stub.events = [
    ev({ id: "evt-roger", title: "Roger 1:1", startUtc: new Date("2026-06-20T17:30:00Z"), lastModified: "2026-06-15T00:00:00Z", attendees: [{ name: UNIQUE_ATTENDEE, email: "roger@example.invalid" }] }),
    ev({ id: "evt-staff", title: "Staff meeting", startUtc: new Date("2026-06-21T14:00:00Z") }),
  ];
  const run3 = await runCalendarSync(ownerId, stub, promoteAll);
  check("run 3 reschedules exactly one (updated)", run3.updated === 1 && run3.unchanged === 1, JSON.stringify(run3));
  check("reschedule moved meeting_at", (await getByEvent("evt-roger"))[0].meetingAt?.toISOString() === "2026-06-20T17:30:00.000Z");

  // --- cancel (flag, never delete) ----------------------------------------
  stub.events = [
    ev({ id: "evt-roger", title: "Canceled: Roger 1:1", startUtc: new Date("2026-06-20T17:30:00Z"), isCancelled: true, lastModified: "2026-06-16T00:00:00Z", attendees: [{ name: UNIQUE_ATTENDEE, email: "roger@example.invalid" }] }),
    ev({ id: "evt-staff", title: "Staff meeting", startUtc: new Date("2026-06-21T14:00:00Z") }),
  ];
  const run4 = await runCalendarSync(ownerId, stub, promoteAll);
  check("run 4 flags one cancellation", run4.canceled === 1 && run4.unchanged === 1, JSON.stringify(run4));
  const canceledRow = (await getByEvent("evt-roger"))[0];
  check("cancelled meeting still exists (not deleted)", !!canceledRow && canceledRow.deletedAt === null);
  check("cancelled meeting is flagged in properties.calendar.canceled", (canceledRow.properties as { calendar?: { canceled?: boolean } }).calendar?.canceled === true);

  // --- uncancel -----------------------------------------------------------
  stub.events = [
    ev({ id: "evt-roger", title: "Roger 1:1 (back on)", startUtc: new Date("2026-06-20T17:30:00Z"), isCancelled: false, lastModified: "2026-06-17T00:00:00Z", attendees: [{ name: UNIQUE_ATTENDEE, email: "roger@example.invalid" }] }),
    ev({ id: "evt-staff", title: "Staff meeting", startUtc: new Date("2026-06-21T14:00:00Z") }),
  ];
  const run5 = await runCalendarSync(ownerId, stub, promoteAll);
  check("run 5 un-cancels (updated, not canceled)", run5.updated === 1 && run5.canceled === 0);
  check("un-cancel clears the canceled flag", ((await getByEvent("evt-roger"))[0].properties as { calendar?: { canceled?: boolean } }).calendar?.canceled === false);

  // --- properties merge: a matcher-written key survives a sync ------------
  await db.update(items).set({ properties: { ...(canceledRow.properties as object), matchedTemplate: "roger-1on1" } }).where(eq(items.id, roger.id));
  stub.events = [
    ev({ id: "evt-roger", title: "Roger 1:1 (renamed again)", startUtc: new Date("2026-06-20T17:30:00Z"), lastModified: "2026-06-18T00:00:00Z", attendees: [{ name: UNIQUE_ATTENDEE, email: "roger@example.invalid" }] }),
    ev({ id: "evt-staff", title: "Staff meeting", startUtc: new Date("2026-06-21T14:00:00Z") }),
  ];
  await runCalendarSync(ownerId, stub, promoteAll);
  const merged = (await getByEvent("evt-roger"))[0].properties as { calendar?: unknown; matchedTemplate?: string };
  check("sync merges properties (matcher-written key survives)", merged.matchedTemplate === "roger-1on1" && !!merged.calendar);

  // --- trashed item is neither resurrected nor duplicated -----------------
  await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, (await getByEvent("evt-staff"))[0].id));
  stub.events = [
    ev({ id: "evt-staff", title: "Staff meeting MOVED", startUtc: new Date("2026-06-22T14:00:00Z"), lastModified: "2026-06-19T00:00:00Z" }),
  ];
  const run7 = await runCalendarSync(ownerId, stub, promoteAll);
  check("trashed meeting is left alone (counts unchanged)", run7.unchanged === 1 && run7.promoted ===0, JSON.stringify(run7));
  const staffRows = await getByEvent("evt-staff");
  check("trashed meeting not resurrected and not duplicated", staffRows.length === 1 && staffRows[0].deletedAt !== null);

  // --- the HANDOFF (ADR-221) ----------------------------------------------
  // The acceptance test for making this job claimable. A machine taking the job
  // over has none of the state this one built up: no place in the queue (there
  // is none to have, every run pulls the whole window fresh) and, the part that
  // was actually worried about, an EMPTY `calendar_events` cache, because that
  // table does not sync. Simulate exactly that and re-run: if dedup ever moved
  // off the synced items.ms_event_id and onto the cache, this is the run that
  // would quietly promote a second copy of every meeting.
  await db.delete(jobState).where(eq(jobState.key, CALENDAR_JOB_KEY));
  await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
  const liveBefore = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.ownerId, ownerId), isNotNull(items.msEventId)));
  stub.events = [
    ev({ id: "evt-roger", title: "Roger 1:1 (renamed again)", startUtc: new Date("2026-06-20T17:30:00Z"), lastModified: "2026-06-18T00:00:00Z", attendees: [{ name: UNIQUE_ATTENDEE, email: "roger@example.invalid" }] }),
    ev({ id: "evt-staff", title: "Staff meeting MOVED", startUtc: new Date("2026-06-22T14:00:00Z"), lastModified: "2026-06-19T00:00:00Z" }),
  ];
  const handoff = await runCalendarSync(ownerId, stub, promoteAll);
  check("a machine taking over creates no meeting it already has",
    handoff.promoted === 0 && handoff.unchanged === 2, JSON.stringify(handoff));
  const liveAfter = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.ownerId, ownerId), isNotNull(items.msEventId)));
  check("no meeting record was duplicated by the handoff",
    liveAfter.length === liveBefore.length, `${liveBefore.length} -> ${liveAfter.length}`);
  const relinked = await db
    .select({ msEventId: calendarEvents.msEventId, promotedItemId: calendarEvents.promotedItemId })
    .from(calendarEvents)
    .where(eq(calendarEvents.ownerId, ownerId));
  check("the emptied list of meetings on offer refills and re-links itself",
    relinked.length === 2 && relinked.every((r) => !!r.promotedItemId), JSON.stringify(relinked));

  // --- job state ----------------------------------------------------------
  const state = await getCalendarState();
  check("job_state records a clean run", !!state && state.lastSuccessAt !== null && state.lastResult.errors === 0, JSON.stringify(state?.lastResult));

  // --- owner scoping ------------------------------------------------------
  check("no other owner's event-items were touched", (await stampedElsewhere()) === otherEventItemsBefore);
} finally {
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
  await db.delete(jobState).where(eq(jobState.key, CALENDAR_JOB_KEY));
  await db.delete(users).where(eq(users.id, ownerId));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
