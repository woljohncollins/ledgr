// Calendar tools: the MCP side of the "From your calendar" Add button
// (ADR-094 E3). An agent routing an agenda item onto a meeting that hasn't
// been added to Ledgr yet used to reach for create_item type=event, which
// makes a bare event carrying none of the calendar payload and, crucially, no
// ms_event_id — so the next sync sees no match and creates a SECOND event, and
// the routed agenda item is left on the orphan copy.
//
// These two are thin wrappers over the same owner-scoped libs the Add button
// posts to (listCalendarFeed / promoteCalendarEvent), so the promotion writes
// the identical row the UI would: ms_event_id (the sync's match key),
// properties.calendar (attendees, joinUrl, seriesMasterId, …), and the
// calendar_events.promoted_item_id backlink that makes it idempotent.
//
// Reach is the cached calendar only — Ledgr keeps the next four weeks of
// Outlook. An event outside that window has no ms_event_id to write, so there
// is nothing here to merge on; create_item is still the answer for a meeting
// that isn't on the real calendar at all.
import { asUuid } from "@/lib/api";
import { listCalendarFeed, promoteCalendarEvent } from "@/lib/calendar/feed";
import { getItem } from "@/lib/items";
import { rowView } from "./serializers";
import { optInt } from "./args";
import type { McpTool } from "./wire";

export const calendarTools: McpTool[] = [
  {
    name: "list_calendar_feed",
    title: "List upcoming calendar events not yet in Ledgr",
    description:
      "The owner's upcoming Outlook events that have NOT been added to Ledgr yet " +
      "— the same list the \"From your calendar\" section of the event list shows. " +
      "Call this to find a future meeting before routing anything onto it, then " +
      "pass the returned `id` to add_calendar_event. Defaults to the next 14 days; " +
      "`days` widens it to the 28 days Ledgr caches. An event already added does " +
      "NOT appear here — find those with list_items type=event or search_items.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Days ahead to look (1-28, default 14)." },
        limit: { type: "integer", description: "Max events to return (1-200, default 50)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const events = await listCalendarFeed(ownerId, {
        windowDays: optInt(args, "days"),
        limit: optInt(args, "limit"),
      });
      return { count: events.length, events };
    },
  },
  {
    name: "add_calendar_event",
    title: "Add a calendar event to Ledgr as a meeting",
    description:
      "Turn one upcoming Outlook event into a real Ledgr `event` item — exactly " +
      "what the owner's \"Add\" button does — carrying its attendees, join link and " +
      "series id, and the calendar id the sync matches on, so a later sync updates " +
      "this item instead of creating a duplicate. Takes the `id` from " +
      "list_calendar_feed. Use this (never create_item type=event) whenever you " +
      "need a future meeting that is on the owner's real calendar, e.g. to hang an " +
      "agenda item or a heads-up on it. Idempotent: calling it twice returns the " +
      "same item with alreadyAdded true. Relate things to the returned id with " +
      "relate_items, or write the agenda into its body with update_item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The calendar event id from list_calendar_feed." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const { itemId, alreadyPromoted } = await promoteCalendarEvent(
        ownerId,
        asUuid(args.id, "id")
      );
      const item = await getItem(ownerId, itemId);
      return { ...rowView(item), alreadyAdded: alreadyPromoted };
    },
  },
];
