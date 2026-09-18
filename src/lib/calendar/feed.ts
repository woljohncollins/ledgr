// Calendar feed (ADR-094 E3): read the un-promoted upcoming events for the
// /events "From your calendar" section, and promote one to a real `event` item
// on a manual Add (or reuse the existing item if it was already promoted).
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, items } from "@/db/schema";
import { ItemError } from "@/lib/items";
import { getAppTimezone } from "@/lib/today";
import { DEFAULT_WINDOW_DAYS } from "./sync";
import { applyEventIntake } from "./intake";
import type { OverlayEvent } from "./overlay";
import type { CalendarEvent } from "./types";

// The meeting-import feed only suggests near-term events to add. It reads the
// same cache the Planner overlay does, but the cache now holds 4 weeks
// (DEFAULT_WINDOW_DAYS), so bound the feed to 2 weeks here to keep the
// suggestion list short and near-term, independent of the overlay's horizon.
const FEED_WINDOW_DAYS = 14;

export type FeedEvent = {
  id: string; // the cache row id (what Add posts)
  msEventId: string;
  title: string;
  startAt: Date | null;
  endAt: Date | null;
  isOnline: boolean;
  location: string | null;
  attendeeCount: number;
};

type CacheMeta = {
  organizer: CalendarEvent["organizer"];
  attendees: CalendarEvent["attendees"];
  location: string | null;
  isOnline: boolean;
  joinUrl: string | null;
  webLink: string | null;
  seriesMasterId: string | null;
  bodyPreview: string | null;
  lastModified: string | null;
};

// The upcoming, un-promoted, non-cancelled events — the calendar feed. Ordered
// by start, capped. Owner-scoped + index-backed (calendar_events_feed_idx).
// windowDays widens the horizon past the UI's near-term default for callers that
// want the whole cache (the MCP tool: an agent routing an agenda item onto a
// meeting three weeks out). Capped at the cache's own window — beyond it there
// is nothing to read.
export async function listCalendarFeed(
  ownerId: string,
  opts: { now?: Date; limit?: number; windowDays?: number } = {}
): Promise<FeedEvent[]> {
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(opts.windowDays ?? FEED_WINDOW_DAYS, 1), DEFAULT_WINDOW_DAYS);
  const feedEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({
      id: calendarEvents.id,
      msEventId: calendarEvents.msEventId,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      meta: calendarEvents.meta,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.ownerId, ownerId),
        isNull(calendarEvents.promotedItemId),
        eq(calendarEvents.isCancelled, false),
        gte(calendarEvents.startAt, now),
        lte(calendarEvents.startAt, feedEnd)
      )
    )
    .orderBy(asc(calendarEvents.startAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map((r) => {
    const m = (r.meta ?? {}) as Partial<CacheMeta>;
    return {
      id: r.id,
      msEventId: r.msEventId,
      title: r.title,
      startAt: r.startAt,
      endAt: r.endAt,
      isOnline: m.isOnline ?? false,
      location: m.location ?? null,
      attendeeCount: m.attendees?.length ?? 0,
    };
  });
}

// Day + wall-clock formatters in the owner's timezone. Events are real instants;
// the overlay places them on the calendar day and time the user actually sees.
// Built per-zone (memoized) so this resolves the owner's setting per call.
const fmtCache = new Map<string, { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();
function tzFmts(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = {
      day: new Intl.DateTimeFormat("en-CA", { timeZone: tz }), // YYYY-MM-DD
      time: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), // HH:MM (24h)
    };
    fmtCache.set(tz, f);
  }
  return f;
}
const DEFAULT_EVENT_MINUTES = 60;

// The owner's calendar events overlapping a window, as read-only overlay blocks
// for the Planner. Unlike listCalendarFeed this returns ALL events in range —
// promoted or not — because the overlay shows the whole calendar to plan
// around, not just the un-added feed. Cancelled events are excluded. Day +
// start are resolved to the owner's timezone here so the client grids needn't do tz
// math. Owner-scoped + index-backed (calendar_events_feed_idx on owner,start_at).
export async function listCalendarEventsForRange(
  ownerId: string,
  start: Date,
  end: Date
): Promise<OverlayEvent[]> {
  const rows = await getDb()
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      meta: calendarEvents.meta,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.ownerId, ownerId),
        eq(calendarEvents.isCancelled, false),
        gte(calendarEvents.startAt, start),
        lte(calendarEvents.startAt, end)
      )
    )
    .orderBy(asc(calendarEvents.startAt));
  const fmts = tzFmts(await getAppTimezone(ownerId));
  const out: OverlayEvent[] = [];
  for (const r of rows) {
    if (!r.startAt) continue;
    const m = (r.meta ?? {}) as Partial<CacheMeta>;
    const startMs = r.startAt.getTime();
    const endMs = r.endAt ? r.endAt.getTime() : startMs + DEFAULT_EVENT_MINUTES * 60_000;
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
    const startTime = fmts.time.format(r.startAt);
    // All-day heuristic: the synced meta doesn't carry Graph's isAllDay flag, so
    // infer it — starts at local midnight and spans whole days. A rare midnight
    // timed event lands in the all-day band, which is acceptable.
    const allDay = startTime === "00:00" && durationMinutes % 1440 === 0;
    out.push({
      id: r.id,
      title: r.title,
      ymd: fmts.day.format(r.startAt),
      start: allDay ? null : startTime,
      durationMinutes,
      location: m.location ?? null,
    });
  }
  return out;
}

// Reconstruct a CalendarEvent from a cached row — enough for the matcher engine.
function toCalendarEvent(row: {
  msEventId: string;
  title: string;
  startAt: Date | null;
  endAt: Date | null;
  isCancelled: boolean;
  meta: unknown;
  lastModified: string | null;
}): CalendarEvent {
  const m = (row.meta ?? {}) as Partial<CacheMeta>;
  return {
    id: row.msEventId,
    title: row.title,
    startUtc: row.startAt ?? new Date(),
    endUtc: row.endAt,
    isCancelled: row.isCancelled,
    organizer: m.organizer ?? null,
    attendees: m.attendees ?? [],
    location: m.location ?? null,
    isOnline: m.isOnline ?? false,
    joinUrl: m.joinUrl ?? null,
    webLink: m.webLink ?? null,
    seriesMasterId: m.seriesMasterId ?? null,
    bodyPreview: m.bodyPreview ?? null,
    lastModified: row.lastModified,
  };
}

// Promote one cached event to a real `event` item (the manual "Add"). Idempotent:
// if already promoted, returns the existing item id. Runs the matchers so a
// manually-added event still gets its known people attached for prep.
export async function promoteCalendarEvent(
  ownerId: string,
  cacheId: string
): Promise<{ itemId: string; alreadyPromoted: boolean }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.id, cacheId), eq(calendarEvents.ownerId, ownerId)));
  const row = rows[0];
  if (!row) throw new ItemError("not_found", "calendar event not found");
  if (row.promotedItemId) {
    return { itemId: row.promotedItemId, alreadyPromoted: true };
  }

  const inserted = await db
    .insert(items)
    .values({
      ownerId,
      type: "event",
      title: row.title,
      meetingAt: row.startAt,
      msEventId: row.msEventId,
      status: "open",
      inbox: false,
      properties: row.meta ? { calendar: row.meta } : null,
    })
    .returning({ id: items.id });
  const itemId = inserted[0].id;
  await db
    .update(calendarEvents)
    .set({ promotedItemId: itemId })
    .where(and(eq(calendarEvents.id, cacheId), eq(calendarEvents.ownerId, ownerId)));

  // Run intake (EM2, ADR-123): apply a pinned template, else attach suggested
  // people. Best-effort — the event is added either way.
  try {
    await applyEventIntake(ownerId, itemId, toCalendarEvent(row));
  } catch {
    /* swallow — the add succeeded; matching is best-effort */
  }

  return { itemId, alreadyPromoted: false };
}
