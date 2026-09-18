// Milestone completion + progress parts (ADR-196, refined same-day after
// Tyler's first real use). A milestone's MODE falls out of what it carries —
// no toggle to configure:
//
//   - task   — it has a "Completes with task" link (edges with role 'task').
//              The linked task's completion completes it; the widget's circle
//              acts on the TASK, so there's one gesture and no dual state. A
//              date on it is a TARGET (places it on the Timeline), never a
//              trigger. Derived at read time, never written back, so reopening
//              the task reopens the milestone for free.
//   - date   — dated, no task link: the original PRD §6 semantic ("arrives
//              whether you act or not"). No checkbox; passed/upcoming derive
//              from the date.
//   - manual — undated, no task link: a work milestone with a checkbox.
//
// A milestone whose own status is done counts done regardless of mode (the
// item page's checkbox still exists), and completion is STAMPED: updateItem
// writes properties.completed_at when a milestone enters done (cleared on
// reopen), so the Timeline can place a finished undated milestone at the date
// it actually finished. Task-mode completions derive their date from the
// task's updated_at (an approximation — the task row has no completion stamp).
//
// Server-only (one batched relations query per widget/card load — never per
// milestone).
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { items, relations } from "@/db/schema";
import {
  milestonePoints,
  milestoneSharePct,
  type MilestoneShare,
  type PointProgress,
} from "@/lib/project-progress";

export type MilestoneListRow = {
  id: string;
  statusCategory: string;
  dueDate: Date | null;
  properties: unknown;
  // Fallback completion date for a done milestone with no stamp (done before
  // stamping existed): its last write was the completing one, near enough.
  updatedAt?: Date | null;
};

export type MilestoneMode = "task" | "date" | "manual";

export type MilestoneState = {
  mode: MilestoneMode;
  done: boolean;
  // How it completed (null = not complete). "date" drives the widget's
  // "passed" badge vs the checked-off "done" ones.
  via: "manual" | "task" | "date" | null;
  // The linked task, when the relation field is set. The widget's circle
  // targets task.id in task mode.
  task: { id: string; title: string; done: boolean } | null;
  // When it completed (stamp > task write > own last write), or null. The
  // Timeline places a finished undated milestone here.
  completedAt: Date | null;
  // Explicit share of the project bar (percent, 0 = pooled default weight).
  pct: number;
};

function todayUtcMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function stampedCompletedAt(properties: unknown): Date | null {
  const raw = (properties as Record<string, unknown> | null)?.completed_at;
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Resolve every milestone's completion state in one pass: one query fetches all
// 'task'-role edges (milestone -> task, the typed relation field's shape,
// ADR-067) with the target task's status.
export async function milestoneStates(
  ownerId: string,
  rows: MilestoneListRow[]
): Promise<Map<string, MilestoneState>> {
  const out = new Map<string, MilestoneState>();
  if (rows.length === 0) return out;
  const linked = new Map<string, { id: string; title: string; done: boolean; updatedAt: Date }>();
  const edges = await getDb()
    .select({
      sourceId: relations.sourceId,
      id: items.id,
      title: items.title,
      statusCategory: items.statusCategory,
      updatedAt: items.updatedAt,
    })
    .from(relations)
    .innerJoin(items, eq(items.id, relations.targetId))
    .where(
      and(
        inArray(relations.sourceId, rows.map((r) => r.id)),
        eq(relations.role, "task"),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt),
        eq(items.isTemplate, false)
      )
    );
  for (const e of edges) {
    // cardinality is single; if extra edges exist, first one wins.
    if (!linked.has(e.sourceId)) {
      linked.set(e.sourceId, {
        id: e.id,
        title: e.title,
        done: e.statusCategory === "done",
        updatedAt: e.updatedAt,
      });
    }
  }
  const today = todayUtcMs();
  for (const m of rows) {
    const task = linked.get(m.id) ?? null;
    const mode: MilestoneMode = task ? "task" : m.dueDate ? "date" : "manual";
    const via: MilestoneState["via"] =
      m.statusCategory === "done"
        ? "manual"
        : task?.done
          ? "task"
          : mode === "date" && m.dueDate && m.dueDate.getTime() < today
            ? "date"
            : null;
    const done = via !== null;
    const completedAt = !done
      ? null
      : via === "date"
        ? m.dueDate
        : (stampedCompletedAt(m.properties) ??
          (via === "task" ? (task?.updatedAt ?? null) : null) ??
          m.updatedAt ??
          null);
    const taskOut = task ? { id: task.id, title: task.title, done: task.done } : null;
    out.set(m.id, { mode, done, via, task: taskOut, completedAt, pct: milestoneSharePct(m.properties) });
  }
  return out;
}

// The two progress inputs a record's milestones contribute (ADR-196): pooled
// 5-point parts for unweighted milestones, explicit percent shares for weighted
// ones. Callers combine the pool with their task/meeting parts, then overlay
// the shares via applyMilestoneShares.
export async function milestoneProgressParts(
  ownerId: string,
  rows: MilestoneListRow[]
): Promise<{ pool: PointProgress[]; shares: MilestoneShare[] }> {
  const states = await milestoneStates(ownerId, rows);
  const pool: PointProgress[] = [];
  const shares: MilestoneShare[] = [];
  for (const m of rows) {
    const s = states.get(m.id);
    if (!s) continue;
    if (s.pct > 0) shares.push({ pct: s.pct, done: s.done });
    else pool.push(milestonePoints(s.done));
  }
  return { pool, shares };
}
