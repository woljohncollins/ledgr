// Parent/child tree reads (slice 7, PRD §3.5): the recursive subtree fetch
// behind the Subtasks section on the item page, plus the upward ancestors
// read for the breadcrumb (the hierarchy is read from the child upward).
// Owner-scoped, body-free, live items only, like every list-shaped query.
//
// Both CTEs use UNION (not UNION ALL) and select only columns functionally
// dependent on id — no depth counter — so a pre-existing parent cycle
// re-produces identical rows and the dedup terminates the recursion. The
// write-time guard in items.ts means such data can only exist by corruption.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { ItemError, type ItemStatus, type Urgency } from "@/lib/items";
import { type StatusCategory } from "@/lib/status";
import { relativeOffsetOf } from "@/lib/relative-subtask";

// Generous bound for a single-user tree; rows past it are dropped (and any
// children orphaned by the cut are dropped with them in assembly).
const SUBTREE_LIMIT = 500;

export type Progress = { done: number; total: number };

export type SubtaskNode = {
  id: string;
  type: string;
  title: string;
  status: ItemStatus;
  statusCategory: StatusCategory;
  dueDate: Date | null;
  scheduledDate: Date | null;
  // The relative-schedule offset (days from the parent's scheduled date, S5) if
  // this subtask is relatively scheduled, else null. Lets the row show "+2d".
  relativeOffset: number | null;
  urgency: Urgency | null;
  parentId: string;
  createdAt: Date;
  updatedAt: Date;
  children: SubtaskNode[];
  // n of m done over direct task-type children (PRD §3.5 "percent of
  // children done"); a note or meeting filed under a parent is context, not
  // a checklist entry. null when there are no task children, so the UI
  // shows no rollup at all.
  progress: Progress | null;
};

export type Subtree = { children: SubtaskNode[]; progress: Progress | null };

type RawRow = {
  id: string;
  type: string;
  title: string;
  status: ItemStatus;
  status_category: string;
  due_date: string | Date | null;
  scheduled_date: string | Date | null;
  properties: Record<string, unknown> | null;
  urgency: Urgency | null;
  parent_id: string;
  created_at: string | Date;
  updated_at: string | Date;
};

async function assertAnchor(ownerId: string, id: string) {
  const rows = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, id), eq(items.ownerId, ownerId)));
  if (rows.length === 0) throw new ItemError("not_found", "item not found");
}

function progressOf(children: SubtaskNode[]): Progress | null {
  const tasks = children.filter((c) => c.type === "task");
  if (tasks.length === 0) return null;
  return {
    done: tasks.filter((t) => t.statusCategory === "done").length,
    total: tasks.length,
  };
}

// The whole live subtree under rootId, assembled into nested nodes with a
// progress rollup on every node that has task children (and on the root,
// returned alongside). Sibling order is creation order — the checklist
// reads top-down in the order subtasks were added.
export async function listSubtree(
  ownerId: string,
  rootId: string
): Promise<Subtree> {
  await assertAnchor(ownerId, rootId);
  // The recursive term re-filters owner_id and deleted_at: children share
  // their parent's owner in practice, but every query carries the scope.
  const res = await getDb().execute(sql`
    with recursive subtree as (
      select id, type, title, status, status_category, due_date, scheduled_date,
             properties, urgency, parent_id, created_at, updated_at
      from items
      where parent_id = ${rootId} and owner_id = ${ownerId}
        and deleted_at is null
      union
      select i.id, i.type, i.title, i.status, i.status_category, i.due_date,
             i.scheduled_date, i.properties, i.urgency, i.parent_id, i.created_at, i.updated_at
      from items i join subtree s on i.parent_id = s.id
      where i.owner_id = ${ownerId} and i.deleted_at is null
    )
    select * from subtree order by created_at asc limit ${SUBTREE_LIMIT}
  `);

  const nodes = new Map<string, SubtaskNode>();
  for (const raw of res.rows as RawRow[]) {
    nodes.set(raw.id, {
      id: raw.id,
      type: raw.type,
      title: raw.title,
      status: raw.status,
      statusCategory: raw.status_category as StatusCategory,
      dueDate: raw.due_date == null ? null : new Date(raw.due_date),
      scheduledDate:
        raw.scheduled_date == null ? null : new Date(raw.scheduled_date),
      relativeOffset: relativeOffsetOf(raw.properties),
      urgency: raw.urgency,
      parentId: raw.parent_id,
      createdAt: new Date(raw.created_at),
      updatedAt: new Date(raw.updated_at),
      children: [],
      progress: null,
    });
  }

  const top: SubtaskNode[] = [];
  for (const node of nodes.values()) {
    // A row for the root itself only appears if corrupted data cycles back
    // to it; it must not render as a child of its own subtree.
    if (node.id === rootId) continue;
    if (node.parentId === rootId) top.push(node);
    else nodes.get(node.parentId)?.children.push(node);
  }
  for (const node of nodes.values()) node.progress = progressOf(node.children);
  return { children: top, progress: progressOf(top) };
}

// Direct task-children counts for a set of parents, in one grouped query — the
// data behind a list row's "n/m" subtask indicator. Mirrors progressOf (and the
// Subtasks section rollup): only task-type children count, so a note or meeting
// filed under a parent is context, not a checklist entry. Owner-scoped, live
// only, body-free, and keyed by items_parent_idx, so it's a single cheap query
// per list render. Callers pass only the ids currently on screen. Parents with
// no task children are simply absent from the map (no pill renders).
export async function childRollups(
  ownerId: string,
  parentIds: string[]
): Promise<Map<string, Progress>> {
  if (parentIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      parentId: items.parentId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${items.statusCategory} = 'done')::int`,
    })
    .from(items)
    .where(
      and(
        inArray(items.parentId, parentIds),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt),
        eq(items.type, "task")
      )
    )
    .groupBy(items.parentId);
  const map = new Map<string, Progress>();
  for (const r of rows) {
    if (r.parentId) map.set(r.parentId, { done: r.done, total: r.total });
  }
  return map;
}

// A flat descendant task row — what the project timeline needs to count a
// subtask's completion without assembling a tree.
export type DescendantTask = {
  id: string;
  title: string;
  statusCategory: StatusCategory;
  properties: Record<string, unknown> | null;
  updatedAt: Date;
};

// Every live TASK anywhere under a set of roots, in one recursive query — the
// derived-membership read behind "a task on a project brings its subtasks along"
// (Tyler, 2026-08-17). Membership is derived from parent_id at read time, never
// written as relation edges: moving a subtask to another parent, or un-relating
// the parent from the project, changes what this returns with no cleanup pass.
// Recursion walks through non-task children too (a note under a task can hold
// task grandchildren), but only task rows are returned. Same UNION-not-UNION-ALL
// cycle discipline and bound as listSubtree, one shared cap across all roots.
export async function listDescendantTasks(
  ownerId: string,
  rootIds: string[]
): Promise<DescendantTask[]> {
  if (rootIds.length === 0) return [];
  // Each id is its own bound parameter (sql.join), so nothing here depends on
  // how the driver serializes a JS array.
  const idList = sql.join(
    rootIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const res = await getDb().execute(sql`
    with recursive descendants as (
      select id, type, title, status_category, properties, updated_at
      from items
      where parent_id in (${idList}) and owner_id = ${ownerId}
        and deleted_at is null
      union
      select i.id, i.type, i.title, i.status_category, i.properties, i.updated_at
      from items i join descendants d on i.parent_id = d.id
      where i.owner_id = ${ownerId} and i.deleted_at is null
    )
    select id, title, status_category, properties, updated_at
    from descendants where type = 'task'
    order by updated_at asc limit ${SUBTREE_LIMIT}
  `);
  return (res.rows as Array<{
    id: string;
    title: string;
    status_category: string;
    properties: Record<string, unknown> | null;
    updated_at: string | Date;
  }>).map((r) => ({
    id: r.id,
    title: r.title,
    statusCategory: r.status_category as StatusCategory,
    properties: r.properties,
    updatedAt: new Date(r.updated_at),
  }));
}

export type Ancestor = {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
};

// The chain of live ancestors above an item, root first — the breadcrumb.
// A trashed or cross-owner ancestor truncates the chain there.
export async function listAncestors(
  ownerId: string,
  id: string
): Promise<Ancestor[]> {
  const anchor = await getDb()
    .select({ parentId: items.parentId })
    .from(items)
    .where(and(eq(items.id, id), eq(items.ownerId, ownerId)));
  if (anchor.length === 0) throw new ItemError("not_found", "item not found");
  const firstParent = anchor[0].parentId;
  if (!firstParent) return [];

  const res = await getDb().execute(sql`
    with recursive ancestors as (
      select id, title, type, parent_id from items
      where id = ${firstParent} and owner_id = ${ownerId}
        and deleted_at is null
      union
      select i.id, i.title, i.type, i.parent_id
      from items i join ancestors a on i.id = a.parent_id
      where i.owner_id = ${ownerId} and i.deleted_at is null
    )
    select * from ancestors
  `);

  // SQL can't order the chain without a depth counter (which would break
  // the UNION cycle cap), so walk it here; the delete guards the walk
  // against the same corrupted-cycle case.
  const byId = new Map(
    (res.rows as Array<Omit<Ancestor, "parentId"> & { parent_id: string | null }>).map(
      (r) => [r.id, { id: r.id, title: r.title, type: r.type, parentId: r.parent_id }]
    )
  );
  const chain: Ancestor[] = [];
  let cursor: string | null = firstParent;
  while (cursor) {
    const row = byId.get(cursor);
    if (!row) break;
    byId.delete(cursor);
    chain.push(row);
    cursor = row.parentId;
  }
  return chain.reverse();
}
