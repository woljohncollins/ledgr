// Relations: the read path behind entity pages and the backlinks panel
// (slice 6, PRD §4.2 "tag as dashboard" / §4.9), plus the write path
// (slice 15): relate, un-relate, confirm. One both-directions pass over
// relations, owner-scoped, body-free, live items only. Both match states are
// returned with the flag carried per row: trusted lists keep only
// 'confirmed'; the UI renders 'suggested' rows dotted/grayed instead of
// hiding them.
//
// Mention edges (role 'mention') belong to the body: they are diff-synced
// from @-mentions on every save (src/lib/mentions.ts), so the write path
// refuses to create or delete them — a manually deleted mention edge would
// silently resurrect on the next body save.
import { and, asc, desc, eq, inArray, ne, isNull, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { getDb } from "@/db";
import { items, relations } from "@/db/schema";
import { ItemError, listColumns } from "@/lib/items";
import { MENTION_ROLE } from "@/lib/mentions";
import {
  emitActivity,
  isTrackedSubjectType,
  type ActivityKind,
} from "@/lib/activity";

// Generous bound for a single-user dashboard page; paging can come with the
// view engine if an entity ever outgrows it.
const RELATED_LIMIT = 500;

export type RelatedItem = Awaited<
  ReturnType<typeof relatedItemsQuery>
>[number] extends infer Row
  ? Omit<Row, "role"> & { roles: string[] }
  : never;

// Exposed as a query builder (items.ts pattern) so verification can assert
// the generated SQL carries owner_id and selects no body.
//
// Shape matters here: this reads the edges FIRST (two index probes, one per
// direction, UNION ALL) and joins items onto that small set — O(edges of this
// item). The previous OR-join (`(source=X and i.id=target) or (target=X and
// i.id=source)`) gave the planner no index path from either side, so it
// scanned and sorted ALL the owner's items and probed relations per row:
// measured at 26,653 buffers / 127ms on the prod spoke for ONE item page
// open, vs 3,241 / 23ms for this form (perf-audit.mts reproduces it).
export function relatedItemsQuery(ownerId: string, itemId: string) {
  const db = getDb();
  const edges = unionAll(
    db
      .select({
        otherId: relations.targetId,
        role: relations.role,
        matchState: relations.matchState,
        home: relations.home,
      })
      .from(relations)
      .where(eq(relations.sourceId, itemId)),
    db
      .select({
        otherId: relations.sourceId,
        role: relations.role,
        matchState: relations.matchState,
        home: relations.home,
      })
      .from(relations)
      .where(eq(relations.targetId, itemId))
  ).as("edges");
  return db
    .select({
      ...listColumns,
      role: edges.role,
      matchState: edges.matchState,
      home: edges.home,
    })
    .from(edges)
    .innerJoin(items, eq(items.id, edges.otherId))
    .where(
      and(
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt),
        // A template prototype must not surface as a related item (ADR-093).
        // Filtered on the JOINED item, so a prototype's OWN Related panel still
        // shows its (non-template) links when authoring.
        eq(items.isTemplate, false),
        // A self-edge must not list the entity on its own page.
        ne(items.id, itemId)
      )
    )
    .orderBy(desc(items.updatedAt))
    .limit(RELATED_LIMIT);
}

// Distinct related items. An item linked by several edges (mention + tag,
// or both directions) appears once, with every role collected and
// 'confirmed' winning over 'suggested'.
export async function listRelatedItems(
  ownerId: string,
  itemId: string
): Promise<RelatedItem[]> {
  const anchor = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.ownerId, ownerId)));
  if (anchor.length === 0) throw new ItemError("not_found", "item not found");

  const out = new Map<string, RelatedItem>();
  for (const { role, ...row } of await relatedItemsQuery(ownerId, itemId)) {
    const seen = out.get(row.id);
    if (!seen) {
      out.set(row.id, { ...row, roles: [role] });
    } else {
      if (!seen.roles.includes(role)) seen.roles.push(role);
      if (row.matchState === "confirmed") seen.matchState = "confirmed";
    }
  }
  return [...out.values()];
}

// Confirmed related items for a SET of anchor ids, in one pair of indexed
// queries (not N+1) — for the dashboard's compact list, which shows a small
// "associated with" chip per row. Either direction, owner-scoped, live-only,
// self-edges and the anchor itself excluded; deduped per anchor, capped small.
// opts.type narrows to related items of one type (the Inbox People chip wants
// persons only, filtered in SQL so the cap can't crowd them out).
export async function relatedSummaryFor(
  ownerId: string,
  itemIds: string[],
  opts: { type?: string } = {}
): Promise<Map<string, { id: string; title: string; type: string }[]>> {
  const out = new Map<string, { id: string; title: string; type: string }[]>();
  if (itemIds.length === 0) return out;
  const db = getDb();
  const anchors = new Set(itemIds);
  const cols = { id: items.id, title: items.title, type: items.type };
  const itemFilter = [
    eq(items.ownerId, ownerId),
    isNull(items.deletedAt),
    eq(items.isTemplate, false),
    ...(opts.type ? [eq(items.type, opts.type)] : []),
  ];
  // Two passes: anchor is the source (related = target), then anchor is the
  // target (related = source). Confirmed edges only.
  const [asSource, asTarget] = await Promise.all([
    db
      .select({ anchor: relations.sourceId, ...cols })
      .from(relations)
      .innerJoin(items, eq(items.id, relations.targetId))
      .where(
        and(
          inArray(relations.sourceId, itemIds),
          eq(relations.matchState, "confirmed"),
          ...itemFilter
        )
      ),
    db
      .select({ anchor: relations.targetId, ...cols })
      .from(relations)
      .innerJoin(items, eq(items.id, relations.sourceId))
      .where(
        and(
          inArray(relations.targetId, itemIds),
          eq(relations.matchState, "confirmed"),
          ...itemFilter
        )
      ),
  ]);
  for (const r of [...asSource, ...asTarget]) {
    if (r.id === r.anchor || !anchors.has(r.anchor)) continue;
    const arr = out.get(r.anchor) ?? [];
    if (!arr.some((x) => x.id === r.id) && arr.length < 4) {
      arr.push({ id: r.id, title: r.title, type: r.type });
    }
    out.set(r.anchor, arr);
  }
  return out;
}

// Typed relation fields (ADR-067): a relation property's value is the set of
// edges FROM this item with role = the field's key. Read all such edges for a
// set of roles in one query and bucket them by role, so the canvas can render
// each typed field (Author, Attendees) with its current links. Directional on
// purpose — the field's owner is the source — unlike the direction-blind
// Related panel. Body-free, owner-scoped (on the targets), live items only.
export async function outgoingRelationsByRole(
  ownerId: string,
  itemId: string,
  roles: string[]
): Promise<Map<string, { id: string; title: string; type: string }[]>> {
  const out = new Map<string, { id: string; title: string; type: string }[]>();
  for (const r of roles) out.set(r, []);
  if (roles.length === 0) return out;
  const rows = await getDb()
    .select({
      role: relations.role,
      id: items.id,
      title: items.title,
      type: items.type,
    })
    .from(relations)
    .innerJoin(items, eq(items.id, relations.targetId))
    .where(
      and(
        eq(relations.sourceId, itemId),
        inArray(relations.role, roles),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt),
        eq(items.isTemplate, false)
      )
    )
    .orderBy(desc(items.updatedAt));
  for (const row of rows) {
    out.get(row.role)?.push({ id: row.id, title: row.title, type: row.type });
  }
  return out;
}

// The list-surface counterpart of outgoingRelationsByRole: the same edges for
// MANY source items in ONE query, bucketed by source id (Tyler, 2026-08-12 —
// tag chips on task rows, and grouping a list by tag). Doing this per row would
// be an N+1 against a list that already loads in one query, which the perf rules
// rule out; a list of 200 tasks costs one extra round trip here.
//
// Same shape and same guarantees as the single-item version — body-free,
// owner-scoped on the targets, live non-template items only — so a caller can
// swap between them. A source id with no edges is present with an empty array,
// so callers never have to distinguish "no tags" from "not fetched".
export async function outgoingRelationsBySource(
  ownerId: string,
  itemIds: string[],
  role: string
): Promise<Map<string, { id: string; title: string; type: string }[]>> {
  const out = new Map<string, { id: string; title: string; type: string }[]>();
  for (const id of itemIds) out.set(id, []);
  if (itemIds.length === 0) return out;
  const rows = await getDb()
    .select({
      sourceId: relations.sourceId,
      id: items.id,
      title: items.title,
      type: items.type,
    })
    .from(relations)
    .innerJoin(items, eq(items.id, relations.targetId))
    .where(
      and(
        inArray(relations.sourceId, itemIds),
        eq(relations.role, role),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt),
        eq(items.isTemplate, false)
      )
    )
    // Alphabetical, not by updatedAt: a row's chips and a list's tag groups are
    // read as a set, and a set that reorders itself when an unrelated tag is
    // renamed looks like a bug. The single-item version sorts by recency because
    // an editable field's newest link belongs on top; a read-only chip doesn't.
    .orderBy(asc(items.title));
  for (const row of rows) {
    out.get(row.sourceId)?.push({ id: row.id, title: row.title, type: row.type });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write path (slice 15). Every entry point validates both ids against the
// owner before touching relations, because relations rows carry no owner_id
// of their own (schema.md: ownership lives on the items they connect).

async function assertOwned(
  ownerId: string,
  id: string,
  opts: { live?: boolean } = {}
) {
  const rows = await getDb()
    .select({ deletedAt: items.deletedAt })
    .from(items)
    .where(and(eq(items.id, id), eq(items.ownerId, ownerId)));
  if (rows.length === 0) throw new ItemError("not_found", "item not found");
  if (opts.live && rows[0].deletedAt !== null) {
    throw new ItemError("bad_request", "item is in Trash");
  }
}

// Assert every id is a live item owned by ownerId, in one query. Used to
// pre-validate a batch of target ids BEFORE a multi-write operation (e.g.
// remember()'s `about` links), so one bad/hallucinated id fails the whole call
// up front rather than leaving a partially-linked write behind. Throws on the
// first missing or trashed id.
export async function assertOwnedItems(ownerId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await getDb()
    .select({ id: items.id, deletedAt: items.deletedAt })
    .from(items)
    .where(and(inArray(items.id, unique), eq(items.ownerId, ownerId)));
  const found = new Map(rows.map((r) => [r.id, r.deletedAt]));
  for (const id of unique) {
    if (!found.has(id)) throw new ItemError("not_found", `item not found: ${id}`);
    if (found.get(id) !== null) throw new ItemError("bad_request", `item is in Trash: ${id}`);
  }
}

// The backlinks panel is direction-blind (a row is "linked", not "linked
// from"), so the un-relate and confirm gestures match edges both ways.
function pairFilter(itemId: string, otherId: string): SQL {
  return or(
    and(eq(relations.sourceId, itemId), eq(relations.targetId, otherId)),
    and(eq(relations.sourceId, otherId), eq(relations.targetId, itemId))
  )!;
}

// Manual relate: source -> target with role 'related' by default (PRD §3.4:
// tagging a task with an entity is an edge from the task to the entity).
// Upsert on the (source, target, role) unique: re-relating an existing
// suggested edge confirms it — relating *is* the confirm gesture.
export async function relateItems(
  ownerId: string,
  sourceId: string,
  targetId: string,
  role = "related",
  opts: { home?: boolean } = {}
) {
  if (role === MENTION_ROLE) {
    throw new ItemError(
      "bad_request",
      "mention edges are managed by the body; edit the @-mention instead"
    );
  }
  if (sourceId === targetId) {
    throw new ItemError("bad_request", "an item cannot relate to itself");
  }
  await assertOwned(ownerId, sourceId, { live: true });
  await assertOwned(ownerId, targetId, { live: true });
  // One home parent per child (ADR-111): mark this the primary residence only
  // after clearing any prior home edge, so the partial unique index never trips.
  if (opts.home) await clearHomeEdges(sourceId);
  const rows = await getDb()
    .insert(relations)
    .values({ sourceId, targetId, role, home: opts.home ?? false })
    .onConflictDoUpdate({
      target: [relations.sourceId, relations.targetId, relations.role],
      set: opts.home
        ? { matchState: "confirmed", home: true }
        : { matchState: "confirmed" },
    })
    .returning();
  return rows[0];
}

// Clear the home flag on every existing edge from this child, so a new home
// edge can be set without violating the one-home-per-source partial unique.
async function clearHomeEdges(childId: string) {
  await getDb()
    .update(relations)
    .set({ home: false })
    .where(and(eq(relations.sourceId, childId), eq(relations.home, true)));
}

// The records this item is FILED UNDER: a home edge, or a `project`/`contains`
// role, regardless of the home flag. The same predicate the completion sweep
// and the record cards' contained/visitor split use.
//
// It exists because setHome DEMOTES a previous home edge (home=false) instead
// of deleting it, and the typed collection cards are home-agnostic — so
// re-filing a task under a second project left it rendered on BOTH projects'
// Tasks cards, with the old one no longer marked as its home. Callers that
// promise "this lives in exactly one record" have to clear the old edge
// themselves; this tells them what to clear.
export async function filedUnderRecords(
  ownerId: string,
  itemId: string
): Promise<string[]> {
  await assertOwned(ownerId, itemId);
  const rows = await getDb()
    .select({ targetId: relations.targetId })
    .from(relations)
    .where(
      and(
        eq(relations.sourceId, itemId),
        or(eq(relations.home, true), inArray(relations.role, ["project", "contains"]))
      )
    );
  return Array.from(new Set(rows.map((r) => r.targetId)));
}

// Containment (ADR-111): make `childId` live in `parentId` as its PRIMARY
// residence (a child -> parent edge with home=true). This is how a Project
// "contains" a note/task/milestone/typed record — relationships + the home bit,
// not a new ownership model ("a note is still a note"). The same record can be
// surfaced elsewhere through home=false edges without being copied or re-owned.
// Emits the matching activity line on the parent when the parent is a tracked
// record (best-effort). `role` defaults to the generic "contains"; the existing
// task->project edge keeps its own "project" role and passes it here.
export async function setHome(
  ownerId: string,
  childId: string,
  parentId: string,
  role = "contains"
) {
  if (childId === parentId) {
    throw new ItemError("bad_request", "an item cannot contain itself");
  }
  await assertOwned(ownerId, childId, { live: true });
  await assertOwned(ownerId, parentId, { live: true });
  await clearHomeEdges(childId);
  const rows = await getDb()
    .insert(relations)
    .values({ sourceId: childId, targetId: parentId, role, home: true })
    .onConflictDoUpdate({
      target: [relations.sourceId, relations.targetId, relations.role],
      set: { matchState: "confirmed", home: true },
    })
    .returning();
  await emitContainmentActivity(ownerId, childId, parentId).catch(() => {});
  return rows[0];
}

// The record a child primarily LIVES in — its home-edge parent (id + type), or
// null. Used to bubble a note jotted on a meeting up to the meeting's containing
// project, so it also surfaces in that project's Docs box (Tyler, 2026-07-01).
export async function homeParentRecord(
  ownerId: string,
  childId: string
): Promise<{ id: string; type: string } | null> {
  const rows = await getDb()
    .select({ id: items.id, type: items.type })
    .from(relations)
    .innerJoin(items, eq(items.id, relations.targetId))
    .where(
      and(
        eq(relations.sourceId, childId),
        eq(relations.home, true),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

// Map a contained child's type to its activity kind on the parent's timeline.
const CONTAINMENT_KIND: Record<string, ActivityKind> = {
  task: "task_added",
  note: "note_added",
  milestone: "milestone_added",
};

async function emitContainmentActivity(
  ownerId: string,
  childId: string,
  parentId: string
) {
  const rows = await getDb()
    .select({ id: items.id, type: items.type, title: items.title })
    .from(items)
    .where(and(inArray(items.id, [childId, parentId]), eq(items.ownerId, ownerId)));
  const child = rows.find((r) => r.id === childId);
  const parent = rows.find((r) => r.id === parentId);
  if (!child || !parent || !isTrackedSubjectType(parent.type)) return;
  const kind = CONTAINMENT_KIND[child.type] ?? "record_related";
  await emitActivity({
    ownerId,
    subjectId: parentId,
    actorId: childId,
    kind,
    summary: `Added ${child.type} “${child.title || "untitled"}”`,
    payload: { childType: child.type },
  });
}

// Machine-made edge from the calendar matcher (slice 23). Like relateItems
// but writes the given match_state (attendee/fuzzy land 'suggested', series/
// regex 'confirmed', per the engine) and, crucially, **never downgrades** an
// existing confirmed edge to suggested: if the user already confirmed (or
// manually related) this pair, a later suggested auto-match leaves it
// confirmed. A confirmed auto-match upgrades an existing suggested edge.
export async function addMatchEdge(
  ownerId: string,
  sourceId: string,
  targetId: string,
  matchState: "confirmed" | "suggested",
  role = "related"
) {
  if (role === MENTION_ROLE) {
    throw new ItemError("bad_request", "mention edges are body-managed");
  }
  if (sourceId === targetId) {
    throw new ItemError("bad_request", "an item cannot relate to itself");
  }
  await assertOwned(ownerId, sourceId, { live: true });
  await assertOwned(ownerId, targetId, { live: true });
  const rows = await getDb()
    .insert(relations)
    .values({ sourceId, targetId, role, matchState })
    .onConflictDoUpdate({
      target: [relations.sourceId, relations.targetId, relations.role],
      set: {
        matchState: sql`case when excluded.match_state = 'confirmed' or ${relations.matchState} = 'confirmed' then 'confirmed'::match_state else 'suggested'::match_state end`,
      },
    })
    .returning();
  return rows[0];
}

// Un-relate, never delete (PRD §4.9): removes every non-mention edge between
// the pair in both directions; both items stay. suggestedOnly is the reject
// gesture for provisional matches — it leaves confirmed edges alone. role
// scopes the removal to one role (ADR-067): a typed relation field removes only
// its own edge (role = the field key), so clearing an Author chip can't also
// drop a generic +Relate link to the same person.
export async function unrelateItems(
  ownerId: string,
  itemId: string,
  otherId: string,
  opts: { suggestedOnly?: boolean; role?: string } = {}
) {
  await assertOwned(ownerId, itemId);
  await assertOwned(ownerId, otherId);
  const where = [pairFilter(itemId, otherId), ne(relations.role, MENTION_ROLE)];
  if (opts.suggestedOnly) where.push(eq(relations.matchState, "suggested"));
  if (opts.role) where.push(eq(relations.role, opts.role));
  const rows = await getDb()
    .delete(relations)
    .where(and(...where))
    .returning({ id: relations.id });
  return { removed: rows.length };
}

// Confirm a provisional match: flips every suggested edge between the pair
// to confirmed (PRD §3.3; the calendar matcher creates these in Phase 2).
export async function confirmRelations(
  ownerId: string,
  itemId: string,
  otherId: string
) {
  await assertOwned(ownerId, itemId);
  await assertOwned(ownerId, otherId);
  const rows = await getDb()
    .update(relations)
    .set({ matchState: "confirmed" })
    .where(
      and(pairFilter(itemId, otherId), eq(relations.matchState, "suggested"))
    )
    .returning({ id: relations.id });
  return { confirmed: rows.length };
}
