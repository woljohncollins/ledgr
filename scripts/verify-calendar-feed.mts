// E3 (ADR-094) verification: the calendar feed. The sync caches every polled
// event, AUTO-PROMOTES only the ones a matcher recognizes, and leaves the rest
// in the feed; the feed query returns upcoming un-promoted non-cancelled events;
// a manual promote (Add) turns one into an item (idempotently). Runs against
// Neon under a throwaway user with a stub source. Run with:
//   node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/verify-calendar-feed.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { calendarEvents, items, jobState, users } = await import("../src/db/schema");
const { runCalendarSync, CALENDAR_JOB_KEY } = await import("../src/lib/calendar/sync");
const { listCalendarFeed, promoteCalendarEvent } = await import("../src/lib/calendar/feed");
const { ItemError } = await import("../src/lib/items");
const { callTool } = await import("../src/lib/mcp/tools");
type CalendarEvent = import("../src/lib/calendar/types").CalendarEvent;
type CalendarSource = import("../src/lib/calendar/types").CalendarSource;
const { and, eq } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const stub: { events: CalendarEvent[] } & CalendarSource = {
  events: [],
  async listEvents() {
    return this.events;
  },
};
function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    id: over.id,
    title: over.title ?? "Untitled",
    startUtc: over.startUtc ?? new Date("2026-06-20T15:00:00Z"),
    endUtc: over.endUtc ?? null,
    isCancelled: over.isCancelled ?? false,
    organizer: over.organizer ?? null,
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
  .values({ email: `verify-feed-${Date.now()}@example.invalid` })
  .returning({ id: users.id });
const ownerId = tempUser.id;
let otherId: string | null = null;

const now = new Date("2026-01-01T00:00:00Z");
const future = (d: number) => new Date(now.getTime() + d * 86400_000);
const pastDay = (d: number) => new Date(now.getTime() - d * 86400_000);
const itemByEvent = async (owner: string, eventId: string) =>
  db.select().from(items).where(and(eq(items.ownerId, owner), eq(items.msEventId, eventId)));

try {
  // A pre-existing item (an event added before E3 / a prior promote): the sync
  // must point the cache at it and keep it OUT of the feed, never duplicate it.
  await db.insert(items).values({
    ownerId,
    type: "event",
    title: "Pre-existing",
    msEventId: "feed-pre",
    meetingAt: future(5),
  });

  stub.events = [
    ev({ id: "feed-match", title: "MATCH standing 1:1", startUtc: future(1) }),
    ev({ id: "feed-add", title: "Conference session", startUtc: future(2) }),
    ev({ id: "feed-add2", title: "Dentist", startUtc: future(3) }),
    ev({ id: "feed-cancelled", title: "Cancelled thing", startUtc: future(4), isCancelled: true }),
    ev({ id: "feed-past", title: "Old event", startUtc: pastDay(1) }),
    ev({ id: "feed-pre", title: "Pre-existing", startUtc: future(5) }),
    ev({ id: "feed-far", title: "Three weeks out", startUtc: future(20) }),
    ev({ id: "feed-beyond", title: "Five weeks out", startUtc: future(35) }),
    // The MCP tools read the clock, not this script's frozen `now`, so their
    // fixture is dated from real time. Still outside every frozen-now window
    // above, so the feed assertions there are unaffected.
    ev({ id: "feed-mcp", title: "MCP fixture", startUtc: new Date(Date.now() + 20 * 86400_000) }),
  ];
  // Simulate the matcher: only titles containing MATCH auto-promote.
  const run = await runCalendarSync(ownerId, stub, {
    shouldPromote: async (e) => e.title.includes("MATCH"),
  });

  check("only the matched event auto-promotes", run.promoted === 1, JSON.stringify(run));
  check("the un-matched, un-promoted events are cached", run.cached === 7, JSON.stringify(run));
  check("matched event became an item", (await itemByEvent(ownerId, "feed-match")).length === 1);
  check(
    "un-matched events did NOT become items",
    (await itemByEvent(ownerId, "feed-add")).length === 0 &&
      (await itemByEvent(ownerId, "feed-add2")).length === 0
  );

  // The feed: upcoming, un-promoted, non-cancelled — ordered by start.
  const feed = await listCalendarFeed(ownerId, { now });
  const feedIds = feed.map((f) => f.msEventId);
  check("feed lists exactly the addable events, in start order", JSON.stringify(feedIds) === JSON.stringify(["feed-add", "feed-add2"]), feedIds.join(","));
  check("feed excludes the matched (already an item)", !feedIds.includes("feed-match"));
  check("feed excludes a cancelled event", !feedIds.includes("feed-cancelled"));
  check("feed excludes a past event", !feedIds.includes("feed-past"));
  check("feed excludes a pre-existing item's event (no duplicate)", !feedIds.includes("feed-pre") && (await itemByEvent(ownerId, "feed-pre")).length === 1);

  // Manual Add (promote) turns a feed event into an item and drops it from feed.
  const feedAdd = feed.find((f) => f.msEventId === "feed-add")!;
  const added = await promoteCalendarEvent(ownerId, feedAdd.id);
  check("promote creates a new item (not already promoted)", added.alreadyPromoted === false && (await itemByEvent(ownerId, "feed-add")).length === 1);
  const feed2 = await listCalendarFeed(ownerId, { now });
  check("the added event left the feed", !feed2.some((f) => f.msEventId === "feed-add") && feed2.length === 1);

  // Idempotent: re-adding returns the same item, makes no duplicate.
  const again = await promoteCalendarEvent(ownerId, feedAdd.id);
  check("re-promote is idempotent (same item, alreadyPromoted)", again.alreadyPromoted === true && again.itemId === added.itemId && (await itemByEvent(ownerId, "feed-add")).length === 1);

  // The MCP window (add_calendar_event's reach): the default feed stops at 14
  // days, `days` widens it as far as the cache holds, and asking for more is
  // clamped rather than reaching past DEFAULT_WINDOW_DAYS into nothing.
  const wide = (await listCalendarFeed(ownerId, { now, windowDays: 28 })).map((f) => f.msEventId);
  check("default feed window excludes an event 20 days out", !feed2.some((f) => f.msEventId === "feed-far"));
  check("days=28 reaches the 20-day event", wide.includes("feed-far"), wide.join(","));
  const clamped = (await listCalendarFeed(ownerId, { now, windowDays: 999 })).map((f) => f.msEventId);
  check("an over-large window clamps to the cache horizon", !clamped.includes("feed-beyond"), clamped.join(","));

  // The MCP tools (ADR-183 additive surface): add_calendar_event must write the
  // SAME row the UI's Add writes — ms_event_id (the sync's match key) and the
  // calendar payload — or a later sync creates a duplicate instead of merging.
  const listed = JSON.parse((await callTool(ownerId, "list_calendar_feed", { days: 28 })).content[0].text);
  const farRow = listed.events.find((e: { msEventId: string }) => e.msEventId === "feed-mcp");
  check("list_calendar_feed is registered and returns the feed", Boolean(farRow) && listed.count === listed.events.length);
  const addRes = await callTool(ownerId, "add_calendar_event", { id: farRow.id });
  check("add_calendar_event succeeds", addRes.isError !== true, addRes.content[0].text.slice(0, 120));
  const addedFar = JSON.parse(addRes.content[0].text);
  const [farItem] = await itemByEvent(ownerId, "feed-mcp");
  check("the tool wrote ms_event_id (the sync match key)", Boolean(farItem) && farItem.id === addedFar.id);
  check("the tool wrote properties.calendar", Boolean((farItem?.properties as { calendar?: unknown })?.calendar));
  check("the tool set meetingAt from the event start", Math.abs((farItem?.meetingAt?.getTime() ?? 0) - (Date.now() + 20 * 86400_000)) < 60_000);
  check("the first add reports alreadyAdded false", addedFar.alreadyAdded === false);
  const addAgain = JSON.parse((await callTool(ownerId, "add_calendar_event", { id: farRow.id })).content[0].text);
  check(
    "add_calendar_event is idempotent (same item, no duplicate)",
    addAgain.id === addedFar.id && addAgain.alreadyAdded === true && (await itemByEvent(ownerId, "feed-mcp")).length === 1
  );
  const badAdd = await callTool(ownerId, "add_calendar_event", { id: "not-a-uuid" });
  check("add_calendar_event rejects a non-uuid id cleanly", badAdd.isError === true);

  // Owner scoping: another owner can't promote our cache row, nor see our feed.
  const [other] = await db
    .insert(users)
    .values({ email: `verify-feed-other-${Date.now()}@example.invalid` })
    .returning({ id: users.id });
  otherId = other.id;
  let foreignBlocked = false;
  try {
    await promoteCalendarEvent(otherId, feedAdd.id);
  } catch (err) {
    foreignBlocked = err instanceof ItemError && err.code === "not_found";
  }
  check("a foreign owner cannot promote our cache row", foreignBlocked);
  const otherFeed = await listCalendarFeed(otherId, { now });
  check("a foreign owner's feed excludes our events", !otherFeed.some((f) => feedIds.includes(f.msEventId)));
} finally {
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
  if (otherId) await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, otherId));
  await db.delete(jobState).where(eq(jobState.key, CALENDAR_JOB_KEY));
  await db.delete(users).where(eq(users.id, ownerId));
  if (otherId) await db.delete(users).where(eq(users.id, otherId));
  console.log("cleanup done");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
