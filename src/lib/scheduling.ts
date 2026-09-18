// Scheduling helpers for native tasks (T2, ADR-073): the deterministic overdue
// auto-roll. Server-side, owner-scoped, no model in the loop (Principle 3) —
// the slot-finder/rescheduler sibling from explorations/calendar-time-blocking.md,
// in its simplest form: pull a stale planned date forward to today.
import { and, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { ACTIVE_CATEGORIES } from "@/lib/status";
import { todayBounds } from "@/lib/today";

// The shared predicate for an overdue planned task: open, live, non-recurring,
// and past its EFFECTIVE plan date — its scheduled day if set, else its due
// (deadline) day (matching the Today partition). Recurring series are excluded:
// their next occurrence is driven by completion/skip (recurrence-service.ts), so
// auto-advancing them would silently skip an occurrence without logging it.
function overdueWhere(ownerId: string, dueToday: Date): SQL {
  return and(
    eq(items.ownerId, ownerId),
    eq(items.type, "task"),
    inArray(items.statusCategory, ACTIVE_CATEGORIES),
    isNull(items.deletedAt),
    eq(items.isTemplate, false),
    or(
      lt(items.scheduledDate, dueToday),
      and(isNull(items.scheduledDate), lt(items.dueDate, dueToday))
    ),
    sql`(${items.properties} -> 'recurrence') is null`
  )!;
}

// Roll every overdue planned task forward to today: set its scheduled (planned)
// date to today so it lands in today's plan. The deadline (due_date) is left
// alone — a missed deadline stays a fact. Returns the count moved.
//
// DELIBERATELY OUTSIDE DATE ANCHORING (ADR-253). Everywhere else, moving a plan
// date carries the deadline and the subtask tree by the same delta; this one
// bulk statement does neither, for two reasons:
//   1. The deadline exception is the older, stronger rule (ADR-078): the roll is
//      a recovery action for work you missed, not a replan, and advancing the
//      deadline would erase the fact that you blew it.
//   2. The roll FLATTENS by design — every stale task lands on today, each row
//      independently — so overdue children are already picked up by the same
//      predicate. Applying a per-row delta on top would move them twice.
// The gap this leaves: a FUTURE-dated child of an overdue parent keeps its date
// while the parent jumps forward, so their spacing closes up. Rare (it needs a
// subtask dated ahead of a parent that is already late) and left as a known
// exception rather than silently picking a semantic — see next_steps.md.
export async function rollOverdueScheduled(
  ownerId: string,
  now = new Date()
): Promise<{ rolled: number }> {
  const { dueToday } = todayBounds(now);
  const res = await getDb()
    .update(items)
    .set({ scheduledDate: dueToday, updatedAt: new Date() })
    .where(overdueWhere(ownerId, dueToday))
    .returning({ id: items.id });
  return { rolled: res.length };
}

// How many tasks rollOverdueScheduled would move, without moving them — powers
// a "Roll N overdue tasks to today" affordance that only shows when N > 0.
export async function countOverdueScheduled(
  ownerId: string,
  now = new Date()
): Promise<number> {
  const { dueToday } = todayBounds(now);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(overdueWhere(ownerId, dueToday));
  return rows[0].count;
}
