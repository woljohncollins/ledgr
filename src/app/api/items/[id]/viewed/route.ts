// The "looked at it" beacon (Tyler, 2026-08-17): opening a widget-home record
// counts as reviewing it — no manual check-in button, deliberately. Writes the
// PJ1 `checkin_reviewed` activity event, which advances the derived
// last_reviewed_at and resets the Digest staleness clock, so a project you
// actually open never surfaces as "gone quiet."
//
// Throttled server-side: at most one event per record per 12 hours, so a day of
// tab-hopping writes one row and the activity log doesn't fill with views.
// (checkin_reviewed is also filtered out of the Recent Activity card — it's
// plumbing, not narrative.) Deliberately NOT items.properties: every write to
// items bumps updated_at, and looking at a record is not an edit.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { lastReviewedAt, reviewCheckin } from "@/lib/activity";

export const dynamic = "force-dynamic";

const THROTTLE_MS = 12 * 60 * 60 * 1000;

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { id } = await context.params;
    const last = await lastReviewedAt(owner.id, id);
    if (last && Date.now() - last.getTime() < THROTTLE_MS) {
      return NextResponse.json({ ok: true, stamped: false });
    }
    await reviewCheckin(owner.id, id);
    return NextResponse.json({ ok: true, stamped: true });
  } catch (err) {
    return errorResponse(err);
  }
}
