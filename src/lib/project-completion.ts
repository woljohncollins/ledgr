// "Mark this project done" — completing a whole record in one action (Tyler,
// 2026-08-25). The header checkbox sets the project to its Done status AND
// completes everything open inside it, so a finished project doesn't leave a
// tail of open tasks behind skewing its progress bar and every task list.
//
// This is a BULK WRITE, so three rules shape it:
//
//   1. PLAN, THEN APPLY. planProjectCompletion() only reads: it returns exactly
//      what would change, grouped, so the confirm dialog can name real counts
//      ("21 tasks, 3 milestones") before anything is written and the owner can
//      cancel. Nothing here writes without a separate applyProjectCompletion().
//
//   2. SCOPE IS CONTAINMENT, NOT MERE ASSOCIATION. Only items the project
//      actually holds are swept: a home edge, or a `project`/`contains` role.
//      A task that is merely *related* to the project is left alone — the
//      record-widget collections are deliberately association-wide (a Tasks card
//      shows anything linked), but "association" is far too wide a net to
//      complete things through. Completing a neighbour's task because it once got
//      linked here would be silent damage.
//
//   3. NEVER SILENTLY MISS OR MANGLE. Two kinds of item are deliberately NOT
//      swept, and both are reported rather than dropped:
//        - a type with no completion concept (statusMode "none": a person, note,
//          link, event, or receipt). Its rows carry a harmless default status, so
//          writing "done" would be a no-op the UI can never show or reverse.
//          Give the type a Done checkbox in Build and it starts being swept.
//        - a REPEATING task. Completing one advances it to its next date rather
//          than closing it (that's the recurrence model, ADR-073), so sweeping it
//          would quietly reschedule a chore instead of finishing it.
//
// Reversal is the caller's: applyProjectCompletion returns each item's PRIOR
// status, and revertProjectCompletion puts them back — which is what the undo
// toast holds. Every write goes through updateItem, so revisions, the activity
// log, Next-Action advancement and owner-scoping all behave exactly as a
// hand-edit would.
import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items, types } from "@/db/schema";
import { updateItem } from "@/lib/item-mutations";
import { isRecurring } from "@/lib/recurrence";
import {
  defaultStatusKey,
  parseStatusSchema,
  resolveStatusMode,
  resolveStatusSchema,
} from "@/lib/status";

// One item the sweep looked at. `status` is its status BEFORE the sweep, which
// is what makes the undo exact.
export type SweepItem = {
  id: string;
  type: string;
  title: string;
  status: string;
};

export type CompletionPlan = {
  // Items that will be completed, each with the status key to write.
  completable: (SweepItem & { nextStatus: string })[];
  // Open items whose TYPE has no completion concept (statusMode "none").
  skippedNoCompletion: SweepItem[];
  // Open repeating tasks — completing one advances it, so it's left alone.
  skippedRecurring: SweepItem[];
  // The project's own target status, or null when its type defines no Done
  // status at all (then there is nothing to do and the checkbox stays hidden).
  projectNextStatus: string | null;
};

// A one-line summary for the confirm dialog / toast: "21 tasks, 3 milestones".
// Grouped by type and count-ordered so the biggest group reads first.
export function describeSweep(rows: { type: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}${n === 1 ? "" : "s"}`)
    .join(", ");
}

// Everything OPEN that this record contains (see rule 2 above). Owner-scoped,
// body-free per the standing list rule. `home` is a directional child->parent
// edge, so it only counts when the item is the SOURCE — a home edge pointing the
// other way would mean the project lives inside the item, not the reverse.
async function openContainedItems(
  ownerId: string,
  projectId: string
): Promise<(SweepItem & { properties: unknown })[]> {
  const rows = await getDb().execute(sql`
    select i.id, i.type, i.title, i.status, i.properties
    from ${items} i
    where i.owner_id = ${ownerId}
      and i.deleted_at is null
      and i.status_category in ('not_started', 'in_progress')
      and exists (
        select 1 from relations r
        where r.match_state = 'confirmed'
          and (
            (r.source_id = i.id and r.target_id = ${projectId}
              and (r.home or r.role in ('project', 'contains')))
            or
            (r.target_id = i.id and r.source_id = ${projectId}
              and r.role in ('project', 'contains'))
          )
      )
    order by i.type, i.created_at
  `);
  return (rows as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
    id: String(r.id),
    type: String(r.type),
    title: String(r.title ?? ""),
    status: String(r.status),
    properties: r.properties,
  }));
}

// What the sweep needs to know about ONE type to decide whether its items can be
// completed: how it presents completion, and the status key "done" means for it.
export type TypeCompletion = { mode: string; doneKey: string | null };

// The per-item rule, pure and exported so it can be asserted directly.
//
// THE CONTRACT THIS ENCODES (Tyler, 2026-08-25): the sweep is generic over
// types, with NO allowlist anywhere. Whether an item is completable is decided
// entirely by looking its type up at plan time and asking two questions — does
// this type track completion, and what status key does it call done. So a type
// that gains a Done checkbox LATER (a Receipt, a Purchase, a type that doesn't
// exist yet) starts being swept the moment it does, with no code change, no
// registration, and no edit to this file. That is the point: hardcoding
// task/milestone here would mean every future type silently fell out of the
// sweep, and nobody would notice until a finished project quietly kept a tail of
// open work.
export function sweepDecision(
  item: { type: string; properties?: unknown },
  meta: TypeCompletion | undefined
): { action: "complete"; nextStatus: string } | { action: "skip"; reason: "no_completion" | "recurring" } {
  // No completion concept (statusMode "none", or no done status to write):
  // writing "done" would be a no-op no surface can show or reverse.
  if (!meta || meta.mode === "none" || !meta.doneKey) {
    return { action: "skip", reason: "no_completion" };
  }
  // A repeating task ADVANCES on completion (ADR-073) rather than closing, so
  // sweeping it would quietly reschedule a chore instead of finishing it.
  const props = item.properties as Record<string, unknown> | null;
  if (isRecurring(props?.recurrence)) {
    return { action: "skip", reason: "recurring" };
  }
  return { action: "complete", nextStatus: meta.doneKey };
}

// The completion metadata for a set of types, in ONE query (the sweep touches
// several types at once; a per-item lookup would be N round trips). Read fresh
// on every plan, which is what makes the contract above hold over time.
async function completionByType(
  typeKeys: string[]
): Promise<Map<string, TypeCompletion>> {
  const out = new Map<string, TypeCompletion>();
  if (typeKeys.length === 0) return out;
  const rows = await getDb()
    .select({ key: types.key, schema: types.statusSchema, mode: types.statusMode })
    .from(types)
    .where(inArray(types.key, typeKeys));
  for (const row of rows) {
    const parsed = parseStatusSchema(row.schema);
    const schema = resolveStatusSchema(parsed);
    out.set(row.key, {
      mode: resolveStatusMode(row.mode, parsed != null),
      doneKey: defaultStatusKey(schema, "done"),
    });
  }
  return out;
}

// READ-ONLY. What "mark this project done" would change, so the owner sees it
// before it happens.
export async function planProjectCompletion(
  ownerId: string,
  projectId: string,
  projectType: string
): Promise<CompletionPlan> {
  const contained = await openContainedItems(ownerId, projectId);
  const meta = await completionByType([
    ...new Set([...contained.map((c) => c.type), projectType]),
  ]);

  const plan: CompletionPlan = {
    completable: [],
    skippedNoCompletion: [],
    skippedRecurring: [],
    projectNextStatus: meta.get(projectType)?.doneKey ?? null,
  };

  for (const row of contained) {
    const bare: SweepItem = {
      id: row.id,
      type: row.type,
      title: row.title,
      status: row.status,
    };
    const decision = sweepDecision(row, meta.get(row.type));
    if (decision.action === "complete") {
      plan.completable.push({ ...bare, nextStatus: decision.nextStatus });
    } else if (decision.reason === "recurring") {
      plan.skippedRecurring.push(bare);
    } else {
      plan.skippedNoCompletion.push(bare);
    }
  }
  return plan;
}

// The result of an apply: everything actually written, with the status each item
// held BEFORE — the payload the undo toast hands back to revertProjectCompletion.
export type CompletionResult = {
  changed: SweepItem[];
  failed: { id: string; error: string }[];
};

// WRITE. Complete the plan's items, then the project itself last — so if the
// sweep fails partway the project isn't already sitting at Done over a pile of
// open work. A per-item failure is collected, never fatal: the rest still lands
// and the undo payload covers exactly what changed.
export async function applyProjectCompletion(
  ownerId: string,
  projectId: string,
  projectType: string,
  projectStatus: string,
  plan: CompletionPlan
): Promise<CompletionResult> {
  const changed: SweepItem[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const row of plan.completable) {
    try {
      await updateItem(ownerId, row.id, { status: row.nextStatus });
      changed.push({ id: row.id, type: row.type, title: row.title, status: row.status });
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : "failed" });
    }
  }

  // The project LAST, so a sweep that dies partway never leaves the record
  // reading "Done" over a pile of still-open work. It rides in `changed` like
  // any other item, which is what lets the undo restore the project's previous
  // status along with everything else.
  if (plan.projectNextStatus && plan.projectNextStatus !== projectStatus) {
    try {
      await updateItem(ownerId, projectId, { status: plan.projectNextStatus });
      changed.push({
        id: projectId,
        type: projectType,
        title: "",
        status: projectStatus,
      });
    } catch (err) {
      failed.push({
        id: projectId,
        error: err instanceof Error ? err.message : "failed",
      });
    }
  }
  return { changed, failed };
}

// UNDO. Put each item back to the status it held before the sweep. Same
// per-item tolerance: one item since edited or trashed doesn't block the rest.
export async function revertProjectCompletion(
  ownerId: string,
  entries: { id: string; status: string }[]
): Promise<{ reverted: number; failed: number }> {
  let reverted = 0;
  let failed = 0;
  for (const e of entries) {
    try {
      await updateItem(ownerId, e.id, { status: e.status });
      reverted += 1;
    } catch {
      failed += 1;
    }
  }
  return { reverted, failed };
}
