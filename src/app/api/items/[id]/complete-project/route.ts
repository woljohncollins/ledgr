// "Mark this project done" — the record-completion endpoint behind the project
// header's checkbox (Tyler, 2026-08-25). Purely additive API surface, so solo
// per ADR-183's carve-out.
//
// Three calls, one route, because they're one workflow:
//
//   GET                       → the PLAN. Read-only: what would change, so the
//                               confirm popover can name real counts before
//                               anything is written.
//   POST {}                   → APPLY. Completes the contained items, then the
//                               project. Returns the undo payload.
//   POST {undo:[{id,status}]} → REVERT that payload, item by item.
//
// The plan/apply split is the point: a bulk write the owner can't preview is a
// bulk write they can't trust. All the scoping and skip rules live in
// project-completion.ts — this file is auth, validation, and shape.
import { NextResponse } from "next/server";
import { asUuid, errorResponse, requireOwner } from "@/lib/api";
import { getItem } from "@/lib/items";
import {
  applyProjectCompletion,
  describeSweep,
  planProjectCompletion,
  revertProjectCompletion,
} from "@/lib/project-completion";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// Cap an undo payload the same way the bulk route caps a batch: an undo can
// never legitimately be larger than the sweep that produced it.
const MAX_UNDO = 500;

function planResponse(plan: Awaited<ReturnType<typeof planProjectCompletion>>) {
  return {
    // What will be completed.
    count: plan.completable.length,
    summary: describeSweep(plan.completable),
    // What deliberately won't be, so the dialog can say so out loud rather than
    // leaving the owner to notice later that a receipt is still open.
    skipped: {
      noCompletion: plan.skippedNoCompletion.length,
      noCompletionSummary: describeSweep(plan.skippedNoCompletion),
      recurring: plan.skippedRecurring.length,
      recurringSummary: describeSweep(plan.skippedRecurring),
    },
    projectNextStatus: plan.projectNextStatus,
  };
}

// GET /api/items/[id]/complete-project — preview only, writes nothing.
export async function GET(_request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const id = asUuid((await context.params).id, "id");
    const record = await getItem(owner.id, id);
    const plan = await planProjectCompletion(owner.id, id, record.type);
    return NextResponse.json(planResponse(plan));
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/items/[id]/complete-project — apply, or revert a prior apply.
export async function POST(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const id = asUuid((await context.params).id, "id");

    // --- Undo path -------------------------------------------------------
    const undo = (body as { undo?: unknown }).undo;
    if (undo !== undefined) {
      if (!Array.isArray(undo)) {
        return NextResponse.json({ error: "undo must be an array" }, { status: 400 });
      }
      if (undo.length > MAX_UNDO) {
        return NextResponse.json(
          { error: `too many undo entries (max ${MAX_UNDO})` },
          { status: 400 }
        );
      }
      const entries: { id: string; status: string }[] = [];
      for (const raw of undo) {
        const e = raw as { id?: unknown; status?: unknown };
        if (typeof e?.id !== "string" || typeof e?.status !== "string") {
          return NextResponse.json(
            { error: "each undo entry needs an id and a status" },
            { status: 400 }
          );
        }
        // asUuid so an undo can't be used to poke at arbitrary strings; the
        // owner scope still comes from updateItem.
        entries.push({ id: asUuid(e.id, "id"), status: e.status });
      }
      return NextResponse.json(await revertProjectCompletion(owner.id, entries));
    }

    // --- Apply path ------------------------------------------------------
    const record = await getItem(owner.id, id);
    const plan = await planProjectCompletion(owner.id, id, record.type);
    if (!plan.projectNextStatus) {
      return NextResponse.json(
        { error: `type '${record.type}' defines no Done status` },
        { status: 400 }
      );
    }
    const result = await applyProjectCompletion(
      owner.id,
      id,
      record.type,
      record.status,
      plan
    );
    // Report what ACTUALLY changed, not what was planned — a per-item failure
    // means the two differ, and the toast must not overstate the sweep. (The
    // plan's own counts are deliberately not spread in here: they would
    // overwrite these.)
    const applied = result.changed.filter((c) => c.id !== id);
    const preview = planResponse(plan);
    return NextResponse.json({
      // The undo payload: every item that changed, with the status it held
      // before. The client holds this for the life of the undo toast.
      changed: result.changed.map((c) => ({ id: c.id, status: c.status })),
      // Counts exclude the project row itself, so the toast reads
      // "Completed 18 tasks" rather than counting the project as a task.
      count: applied.length,
      summary: describeSweep(applied),
      failed: result.failed,
      skipped: preview.skipped,
      projectNextStatus: preview.projectNextStatus,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
