import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { rollMovesDue, rollOverdueScheduled } from "@/lib/scheduling";

export const dynamic = "force-dynamic";

// POST /api/tasks/roll-overdue — pull every overdue planned (scheduled) task
// forward to today (T2, ADR-073). Deterministic, owner-scoped; the manual
// counterpart to the optional cron at /api/machine/roll-overdue.
export async function POST() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    return NextResponse.json(
      await rollOverdueScheduled(owner.id, new Date(), { alsoDue: rollMovesDue() })
    );
  } catch (err) {
    return errorResponse(err);
  }
}
