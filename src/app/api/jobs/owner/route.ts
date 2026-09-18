import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { isMovableJob } from "@/lib/job-owners";
import { setJobOwner, type ClaimAction } from "@/lib/job-owners-store";

export const dynamic = "force-dynamic";

// PATCH /api/jobs/owner {job, action, deviceId?} — which install runs an
// exclusive scheduled job. Owner authed (a settings surface).
//
// Four actions, all of which work from ANY copy:
//
//   assign   run it on the copy named by `deviceId`, taken from the roster
//            (ADR-220). This is the one the roster made possible: the roster's
//            rows are keyed by each install's own `sync_device` id, the same id
//            space the gate compares against, so a copy can finally name
//            another copy.
//   claim    shorthand for "run it here", needing no target.
//   nobody   run it nowhere.
//   default  back to "wherever it is switched on", i.e. how it behaved before
//            any of this existed.
//
// The value goes to `users.settings`, which SYNCS, so the answer reaches every
// other install on its next exchange and each one re-reads it before its next
// run. That is the exactly-one guarantee: one slot, so a conflict cannot be
// stored.
const ACTIONS: ClaimAction[] = ["claim", "assign", "nobody", "default"];

export async function PATCH(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const body = (await request.json()) as {
      job?: unknown;
      action?: unknown;
      deviceId?: unknown;
    };
    if (typeof body.job !== "string" || !isMovableJob(body.job)) {
      return NextResponse.json({ error: "unknown job" }, { status: 400 });
    }
    if (typeof body.action !== "string" || !ACTIONS.includes(body.action as ClaimAction)) {
      return NextResponse.json(
        { error: `action must be one of ${ACTIONS.join(", ")}` },
        { status: 400 }
      );
    }
    if (body.action === "assign" && typeof body.deviceId !== "string") {
      return NextResponse.json({ error: "assign needs a deviceId" }, { status: 400 });
    }
    const result = await setJobOwner(owner.id, body.job, body.action as ClaimAction, {
      deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
    });
    if (result.error) {
      // A refused claim is a 409: the request was well formed, the state says no.
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json({ jobOwners: result.owners });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
