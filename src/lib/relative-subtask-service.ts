// Child date shifting (ADR-253) — the server half of `date-anchor.ts`. When a
// task's scheduled date moves by N days, move every dated child by the same N,
// recursing so the shift chains all the way down a subtask tree.
//
// This REPLACES `recomputeRelativeChildren` (S5, ADR-085), which re-derived each
// child from a STORED offset and therefore only moved the children that had one.
// Only `SubtaskSchedule` ever wrote that offset, so a subtask created through MCP
// `add_subtasks`, a template, or a clone silently stayed put forever — the exact
// breakage Tyler hit (five of six subtasks ignoring their parent, 2026-09-11).
// Shifting by delta needs nothing stored, so every existing child tracks from now
// on with no migration.
//
// A child opts OUT by pinning its scheduled date (`properties.datePins.scheduled`):
// a pinned child does not move, and neither does its subtree, because that subtree
// anchors to the child that stayed put.
//
// Direct DB updates — NOT updateItem — to avoid re-entrancy; depth-capped like
// the other tree walks.
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { isDuePinned, isScheduledPinned, shiftDay } from "@/lib/date-anchor";
import { dateToYmdUtc, ymdToUtcDate } from "@/lib/recurrence";
import { applyOffset, relativeOffsetOf } from "@/lib/relative-subtask";

export type ShiftedChild = {
  id: string;
  scheduledDate: Date | null;
  dueDate: Date | null;
};

// Move every unpinned dated descendant of `parentId` by `deltaDays`. Returns the
// rows as they were BEFORE the shift, so the caller can offer an undo.
export async function shiftChildDates(
  ownerId: string,
  parentId: string,
  deltaDays: number,
  depth = 0
): Promise<ShiftedChild[]> {
  if (depth > 50 || deltaDays === 0) return [];
  const children = await getDb()
    .select({
      id: items.id,
      properties: items.properties,
      scheduledDate: items.scheduledDate,
      dueDate: items.dueDate,
    })
    .from(items)
    .where(
      and(
        eq(items.parentId, parentId),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt)
      )
    );

  const moved: ShiftedChild[] = [];
  for (const child of children) {
    const props = child.properties as Record<string, unknown> | null;
    // Pinned: this child holds its date, so its own subtree has not moved either.
    if (isScheduledPinned(props)) continue;
    // Undated children have nothing to shift, but a descendant might still be
    // dated relative to a dated grandparent, so the walk continues past them.
    const nextScheduled = shiftDay(child.scheduledDate, deltaDays);
    // The child's deadline hangs off the child's own scheduled date, so it rides
    // along by the same delta unless it is pinned. A child with a due date but no
    // scheduled date still moves: `due` IS its effective plan date (scheduling.ts).
    const nextDue = isDuePinned(props) ? child.dueDate : shiftDay(child.dueDate, deltaDays);

    if (nextScheduled !== child.scheduledDate || nextDue !== child.dueDate) {
      moved.push({
        id: child.id,
        scheduledDate: child.scheduledDate,
        dueDate: child.dueDate,
      });
      await getDb()
        .update(items)
        .set({ scheduledDate: nextScheduled, dueDate: nextDue, updatedAt: new Date() })
        .where(and(eq(items.id, child.id), eq(items.ownerId, ownerId)));
    }
    // Recurse: the child moved (or is undated), so its own children follow by the
    // same delta.
    moved.push(...(await shiftChildDates(ownerId, child.id, deltaDays, depth + 1)));
  }
  return moved;
}

// Derive dates for descendants carrying a stored `relativeSchedule` offset, from
// an anchor day downward. This is ADR-085's old recompute, deliberately kept and
// deliberately NARROWED to the template apply path (ADR-253).
//
// It survives because a template PROTOTYPE usually carries no concrete dates at
// all: its checklist says "day 0, day +1, day +5" as offsets, and there is no gap
// for anchoring to measure. Applying the template is also not a "move" — the clone
// goes from undated to dated, which is not a delta — so `shiftChildDates` cannot
// and should not fire there.
//
// It is NOT used for live subtask trees any more. That was the bug: it only ever
// moved children that had been stamped with an offset by one control, leaving
// every MCP-, template-, or clone-created sibling frozen.
export async function deriveOffsetChildren(
  ownerId: string,
  parentId: string,
  parentScheduledYmd: string | null,
  depth = 0
): Promise<void> {
  if (depth > 50 || !parentScheduledYmd) return;
  const children = await getDb()
    .select({ id: items.id, properties: items.properties, scheduledDate: items.scheduledDate })
    .from(items)
    .where(
      and(
        eq(items.parentId, parentId),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt)
      )
    );
  for (const child of children) {
    const offset = relativeOffsetOf(child.properties as Record<string, unknown> | null);
    // No offset: this child states its own date (or has none). Left alone, but the
    // walk continues so a deeper offset still resolves against its own anchor.
    const nextYmd = offset === null ? null : applyOffset(parentScheduledYmd, offset);
    if (nextYmd) {
      await getDb()
        .update(items)
        .set({ scheduledDate: ymdToUtcDate(nextYmd), updatedAt: new Date() })
        .where(and(eq(items.id, child.id), eq(items.ownerId, ownerId)));
    }
    const anchor =
      nextYmd ?? (child.scheduledDate ? dateToYmdUtc(child.scheduledDate) : null);
    await deriveOffsetChildren(ownerId, child.id, anchor, depth + 1);
  }
}

// Restore a set of child dates captured by `shiftChildDates` — the undo half of
// the toast (ADR-142: destructive-ish, one-way-feeling actions get an undo).
export async function restoreChildDates(
  ownerId: string,
  rows: ShiftedChild[]
): Promise<number> {
  let n = 0;
  for (const row of rows) {
    await getDb()
      .update(items)
      .set({
        scheduledDate: row.scheduledDate,
        dueDate: row.dueDate,
        updatedAt: new Date(),
      })
      .where(and(eq(items.id, row.id), eq(items.ownerId, ownerId)));
    n += 1;
  }
  return n;
}
