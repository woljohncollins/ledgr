// Action-item -> task promotion (slice 24, PRD §5.1; block-linked in ADR-090).
// Turning a line in a meeting into a task: create the task, relate it to the
// meeting and to the meeting's confirmed people (so it shows up in that person's
// open tasks, which is exactly what next time's prep reads). When promoted from
// a body line (ADR-090) the task also carries its source — the meeting id and
// the line's ^id anchor — in properties.source, so the task can deep-link back
// to the exact line and the line can show a "→ task" badge. Owner-scoped throughout.
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getItem, ItemError } from "@/lib/items";
import { createItem, type ItemInput } from "@/lib/item-mutations";
import { relateItems } from "@/lib/relations";
import { getMeetingPeople } from "./prep";

export type PromoteOptions = {
  // The source line's ^id anchor (ADR-090), stored as properties.source.blockRef.
  blockRef?: string;
  // Extra edges the capture card already resolved (a "+project" destination,
  // "@"-linked items, existing tags) — the same `relateTo` the create route
  // takes, written alongside the meeting/people edges below.
  relateTo?: { targetId: string; role?: string }[];
};

export async function promoteActionItem(
  ownerId: string,
  meetingId: string,
  input: ItemInput,
  opts: PromoteOptions = {}
) {
  const trimmed = (input.title ?? "").trim();
  if (!trimmed) throw new ItemError("bad_request", "task title is required");

  // Ownership + existence (also gives the type for a friendlier guard).
  const meeting = await getItem(ownerId, meetingId);
  if (meeting.deletedAt) throw new ItemError("not_found", "meeting not found");

  // The source back-reference (ADR-090): always the meeting; blockRef only when
  // promoted from a specific body line.
  const source: { type: "event"; itemId: string; blockRef?: string } = {
    type: "event",
    itemId: meetingId,
  };
  if (opts.blockRef) source.blockRef = opts.blockRef;

  // Everything the capture card parsed out of the line — due/scheduled date,
  // priority, recurrence, custom properties, the description — rides through
  // unchanged; only the type, the source, and inbox are ours to decide.
  const task = await createItem(ownerId, {
    ...input,
    type: "task",
    title: trimmed,
    // Status defaults to the type's not-started status (createItem, S2).
    // It's a deliberate promotion, not an untriaged arrival (ADR-010).
    inbox: false,
    properties: {
      ...((input.properties as Record<string, unknown> | undefined) ?? {}),
      source,
    },
  });

  // Relate task -> meeting (confirmed; it's a deliberate manual-equivalent
  // act), then task -> each of the meeting's people, so the task lands in
  // that person's open-task list, then the card's own edges. Edge failures
  // (a since-deleted person) don't undo the task.
  const people = await getMeetingPeople(ownerId, meetingId);
  const edges: { targetId: string; role?: string }[] = [
    { targetId: meetingId },
    ...people.map((e) => ({ targetId: e.id })),
    ...(opts.relateTo ?? []).slice(0, 20),
  ];
  const relateErrors: string[] = [];
  for (const e of edges) {
    try {
      await relateItems(ownerId, task.id, e.targetId, e.role);
    } catch (err) {
      relateErrors.push(err instanceof Error ? err.message : "relate failed");
    }
  }
  return { task, relateErrors };
}
// The meeting's promoted lines: a map of source-line anchor (`^id`) → the task
// it produced (ADR-090). Drives the editor's "✓ task" badge — which line shows
// a promoted marker, and what it links to. Owner-scoped; index-friendly
// containment on `properties.source.itemId`, then keeps the rows with a blockRef.
export async function promotedBlockRefs(
  ownerId: string,
  meetingId: string
): Promise<Record<string, { id: string; title: string }>> {
  const rows = await getDb().execute(sql`
    select id, title, properties->'source'->>'blockRef' as block_ref
    from items
    where owner_id = ${ownerId}
      and type = 'task'
      and deleted_at is null
      and properties @> ${JSON.stringify({ source: { itemId: meetingId } })}::jsonb
      and properties->'source'->>'blockRef' is not null
  `);
  const map: Record<string, { id: string; title: string }> = {};
  for (const r of rows.rows as { id: string; title: string | null; block_ref: string }[]) {
    if (r.block_ref) map[r.block_ref] = { id: r.id, title: r.title ?? "" };
  }
  return map;
}
