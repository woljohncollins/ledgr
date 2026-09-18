// Everything a redesigned task row shows beyond its own columns, batched for a
// page of rows (tasks-row-redesign, ADR-202): the one-line description excerpt,
// every outgoing connection (tags, people, other records), and the project
// chip's parent breadcrumb. Three queries total per list — keyed on the ids the
// page already computed for selection — never per-row (the no-N+1 perf rule).
//
// THE EXCERPT READ IS A DELIBERATE, CAPPED CARVE-OUT of the "list queries never
// select body" invariant (ADR-202): it selects `left(body->>'text', N)` — a
// fixed 240-char head computed DB-side — never the body column itself, so the
// rule's intent (small list payloads) holds. Don't widen the cap or copy this
// pattern elsewhere without re-reading that ADR.
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items, relations } from "@/db/schema";
import { excerptLine } from "@/lib/excerpt";
import { personImage } from "@/lib/person-image";
import { TAGS_ROLE } from "@/lib/tags";

// The role a task→project home edge carries (ADR-111/199).
export const PROJECT_ROLE = "project";

const EXCERPT_CAP = 240;

export type RowConnection = {
  id: string;
  title: string;
  type: string;
  role: string;
  home: boolean;
  // The person's built-in Image (migration 0053) — the strip shows the face in
  // place of the person glyph. null for non-persons and unpictured persons.
  image: string | null;
};

export type TaskRowMeta = {
  // taskId → one plain-text description line ("" never stored; absent instead).
  excerpts: Map<string, string>;
  // taskId → every outgoing edge (mention edges excluded — body links are the
  // body's own affordance, not a row connection), tags first, then title order.
  connections: Map<string, RowConnection[]>;
  // projectId → the project's own home parent, for the "Parent / Project"
  // breadcrumb on the row's right edge.
  projectParents: Map<string, { id: string; title: string }>;
};

export function emptyTaskRowMeta(): TaskRowMeta {
  return { excerpts: new Map(), connections: new Map(), projectParents: new Map() };
}

export async function taskRowMeta(
  ownerId: string,
  itemIds: string[]
): Promise<TaskRowMeta> {
  const meta = emptyTaskRowMeta();
  if (itemIds.length === 0) return meta;
  const db = getDb();

  const [excerptRows, edgeRows] = await Promise.all([
    db
      .select({
        id: items.id,
        head: sql<string | null>`left(${items.body}->>'text', ${EXCERPT_CAP})`,
      })
      .from(items)
      .where(and(inArray(items.id, itemIds), eq(items.ownerId, ownerId))),
    db
      .select({
        sourceId: relations.sourceId,
        role: relations.role,
        home: relations.home,
        id: items.id,
        title: items.title,
        type: items.type,
        image: sql<string | null>`${items.properties}->>'image'`,
      })
      .from(relations)
      .innerJoin(items, eq(items.id, relations.targetId))
      .where(
        and(
          inArray(relations.sourceId, itemIds),
          ne(relations.role, "mention"),
          eq(items.ownerId, ownerId),
          isNull(items.deletedAt),
          eq(items.isTemplate, false)
        )
      )
      .orderBy(asc(items.title)),
  ]);

  for (const r of excerptRows) {
    const line = excerptLine(r.head);
    if (line) meta.excerpts.set(r.id, line);
  }

  for (const id of itemIds) meta.connections.set(id, []);
  for (const r of edgeRows) {
    meta.connections.get(r.sourceId)?.push({
      id: r.id,
      title: r.title,
      type: r.type,
      role: r.role,
      home: r.home ?? false,
      // personImage, not an inline http test: it is the one place that decides
      // what an avatar will render, and a stable /files address is valid too
      // (ADR-228). The inline copy this replaced silently dropped every
      // uploaded avatar from the connection strip.
      image: r.type === "person" ? personImage({ image: r.image }) : null,
    });
  }
  // Tags lead the strip; everything else keeps the query's title order.
  for (const list of meta.connections.values()) {
    list.sort((a, b) =>
      a.role === b.role ? 0 : a.role === TAGS_ROLE ? -1 : b.role === TAGS_ROLE ? 1 : 0
    );
  }

  // Breadcrumb parents for the project chips: one more batched read over the
  // project ids the edges surfaced (a project's own home edge → its parent).
  const projectIds = [
    ...new Set(
      edgeRows.filter((r) => r.role === PROJECT_ROLE).map((r) => r.id)
    ),
  ];
  if (projectIds.length > 0) {
    const parentRows = await db
      .select({
        sourceId: relations.sourceId,
        id: items.id,
        title: items.title,
      })
      .from(relations)
      .innerJoin(items, eq(items.id, relations.targetId))
      .where(
        and(
          inArray(relations.sourceId, projectIds),
          eq(relations.home, true),
          eq(items.ownerId, ownerId),
          isNull(items.deletedAt),
          eq(items.isTemplate, false)
        )
      );
    for (const r of parentRows) {
      meta.projectParents.set(r.sourceId, { id: r.id, title: r.title });
    }
  }

  return meta;
}
