// Pure grouping helpers for the board layout (slice 35, PRD §4.2/§4.14),
// extracted from ViewRenderer so the logic is node-testable — the renderer is a
// React component, but a board column's value + order is plain policy. Same
// pure-policy-vs-wiring split as canvas-registry/modules.ts.
//
// The new capability: a board can group by a custom *select* property (a
// workflow's "Stage"), not just the built-in fields. Property values live in
// items.properties; the column order follows the property's options when known.
import { ITEM_STATUSES, URGENCIES } from "@/lib/item-enums";
import type { GroupField, ViewGrouping } from "@/lib/views";

// The fields a board needs to compute a row's group. A superset-narrowing of a
// listColumns row (the renderer passes the same rows it already has).
// properties is unknown (jsonb), cast once where it's read below.
export type GroupableItem = {
  // Needed by a RELATION grouping (group by tag), whose values don't live on the
  // row at all — they're `relations` edges, looked up by source id in a map the
  // caller batch-fetched. Every listColumns row already carries it.
  id: string;
  status: string;
  urgency: number | null;
  type: string;
  dueDate: Date | null;
  scheduledDate: Date | null;
  properties: unknown;
};

// Edges for a relation grouping, keyed by source item id — the shape
// `outgoingRelationsBySource` returns. Only the title is used (it's the group
// label), but the full ref is accepted so callers can pass their map straight in.
export type GroupEdges = Map<string, { id: string; title: string }[]>;

export const NONE_GROUP = "none";
const DUE_ORDER = ["overdue", "today", "this week", "later", "no date"] as const;

// en-CA renders YYYY-MM-DD, a sortable day key; due dates are UTC-midnight
// calendar days (ADR-008), so compare in UTC.
const utcKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });

export function dueBucket(dueDate: Date | null, now: Date): string {
  if (!dueDate) return "no date";
  const today = utcKey.format(now);
  const itemKey = utcKey.format(dueDate);
  if (itemKey < today) return "overdue";
  if (itemKey === today) return "today";
  const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (itemKey <= utcKey.format(week)) return "this week";
  return "later";
}

// EVERY group a row belongs to. Most groupings put a row in exactly one column, so
// this returns a single-entry array; the two multi-valued kinds fan out, so one row
// shows under EACH of its values (Tyler, 2026-08-12 — "adding a tag to a task
// self-organizes it").
//
// Fan-out is what makes tag grouping useful and it's why this is the plural
// primitive. The old single-value behavior joined a multi_select's values into one
// composite column ("work, urgent"), which meant a task tagged two ways got its own
// private column shared with nothing — the opposite of grouping. A row with no
// values lands in NONE_GROUP, so nothing is silently dropped from the board.
//
// Consequence worth stating: with fan-out the column counts sum to MORE than the
// row count. That's correct for tags (a task really is in both) and is why callers
// must not use column totals as an item count.
export function groupValuesFor(
  item: GroupableItem,
  grouping: ViewGrouping,
  now: Date,
  edges?: GroupEdges
): string[] {
  // Relation grouping (group by tag): the values are edges, not row data.
  if (grouping && "relationRole" in grouping) {
    const titles = (edges?.get(item.id) ?? [])
      .map((e) => e.title.trim())
      .filter((t) => t !== "");
    if (titles.length === 0) return [NONE_GROUP];
    // De-duplicate: two edges to same-titled tags would otherwise make a row
    // appear twice in one column.
    return [...new Set(titles)];
  }
  if (grouping && "propertyKey" in grouping) {
    const props = item.properties as Record<string, unknown> | null;
    const v = props?.[grouping.propertyKey];
    if (v == null || v === "") return [NONE_GROUP];
    if (Array.isArray(v)) {
      const vals = v.map(String).filter((s) => s !== "");
      return vals.length ? [...new Set(vals)] : [NONE_GROUP];
    }
    return [String(v)];
  }
  return [groupValueFor(item, grouping, now)];
}

// The single column a row falls in — the built-in fields, which are all
// single-valued. Kept as its own function because the board DnD path needs exactly
// one value per card, and because a status/urgency/date grouping can never fan out.
// For the multi-valued kinds (relation, multi_select) call groupValuesFor instead;
// this returns their FIRST group only.
export function groupValueFor(
  item: GroupableItem,
  grouping: ViewGrouping,
  now: Date,
  edges?: GroupEdges
): string {
  if (grouping && "relationRole" in grouping) {
    return groupValuesFor(item, grouping, now, edges)[0];
  }
  if (grouping && "propertyKey" in grouping) {
    const props = item.properties as Record<string, unknown> | null;
    const v = props?.[grouping.propertyKey];
    if (v == null || v === "") return NONE_GROUP;
    if (Array.isArray(v)) return v.length ? String(v[0]) : NONE_GROUP;
    return String(v);
  }
  const field: GroupField = grouping?.field ?? "status";
  switch (field) {
    case "status":
      return item.status;
    case "urgency":
      return item.urgency != null ? String(item.urgency) : NONE_GROUP;
    case "type":
      return item.type;
    case "plan":
      // Effective plan date bucket: scheduled if set, else due (ADR-109).
      return dueBucket(item.scheduledDate ?? item.dueDate, now);
    case "due":
      return dueBucket(item.dueDate, now);
    case "scheduled":
      return dueBucket(item.scheduledDate, now);
  }
}

// The /api/items PATCH body that moves a card into board column `col`, given
// the grouping (board DnD, the kanban drop). Only the groupings the board lets
// you drag — a status/urgency field, or a single-select property — are
// expressible; anything else (computed `due`, `type`, multi_select) returns
// null and the drop is a no-op. The page gates which boards drag; this is the
// backstop + the single place the drop→write mapping lives. NONE_GROUP clears.
export function boardDropPatch(
  grouping: ViewGrouping,
  col: string
): Record<string, unknown> | null {
  // A relation grouping is NOT droppable. Moving a card between tag columns would
  // mean deleting one `relations` edge and creating another, which is a different
  // write from the `/api/items` PATCH this returns — and with fan-out a card can
  // legitimately sit in several columns at once, so "moved out of Work" is
  // ambiguous. Returning null makes the drop a no-op (the page also gates which
  // boards drag), rather than silently writing the wrong thing.
  if (grouping && "relationRole" in grouping) return null;
  if (grouping && "propertyKey" in grouping) {
    return {
      propertyPatch: { [grouping.propertyKey]: col === NONE_GROUP ? null : col },
    };
  }
  const field: GroupField = grouping?.field ?? "status";
  if (field === "status") return { status: col };
  if (field === "urgency") return { urgency: col === NONE_GROUP ? null : Number(col) };
  return null;
}

// Column order: a known order first (the enum's canonical order for a built-in
// field, or the property's option order for a property grouping), then any
// remaining present values alphabetically, with NONE_GROUP always last.
export function orderedGroups(
  grouping: ViewGrouping,
  present: Set<string>,
  knownOrder?: string[]
): string[] {
  let known: readonly string[] = [];
  if (grouping && "relationRole" in grouping) {
    // No canonical order for tags — a tag list is open-ended and user-created, so
    // there's no option list to follow the way a select property has one. Every
    // present value falls through to the alphabetical tail below, with NONE_GROUP
    // ("Untagged") pinned last.
    known = knownOrder ?? [];
  } else if (grouping && "propertyKey" in grouping) {
    known = knownOrder ?? [];
  } else {
    const field: GroupField = grouping?.field ?? "status";
    // status uses the type's resolved status keys (knownOrder) so a board shows
    // every custom status as a column in schema order (S2); ITEM_STATUSES is the
    // inherited-default fallback.
    known = {
      status: knownOrder ?? ITEM_STATUSES,
      urgency: [...URGENCIES.map(String), NONE_GROUP],
      plan: DUE_ORDER,
      due: DUE_ORDER,
      scheduled: DUE_ORDER,
      type: [] as readonly string[],
    }[field];
  }
  const head = known.filter((v) => present.has(v));
  const rest = [...present]
    .filter((v) => !head.includes(v))
    .sort((a, b) =>
      a === NONE_GROUP ? 1 : b === NONE_GROUP ? -1 : a.localeCompare(b)
    );
  return [...head, ...rest];
}
