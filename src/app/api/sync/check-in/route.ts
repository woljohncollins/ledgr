import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { readSyncHubs, requestCheckIn } from "@/lib/sync/client";

export const dynamic = "force-dynamic";

// POST /api/sync/check-in — exchange with every hub now, ignoring the cadence.
// Owner-authed like /api/sync/mode and /api/sync/release-push.
//
// The cadence is a ceiling on how long a change may take to travel, and it used
// to be the floor as well: nothing anywhere could ask this peer to sync sooner,
// so a job assignment made on another copy (ADR-225) landed whenever the clock
// said. This is the "sooner" lever, and it is the whole reason a slow cadence is
// a reasonable choice rather than a trap.
export async function POST() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    if ((await readSyncHubs()).length === 0) {
      // The cloud copy is a hub: other copies come to it, it never goes to
      // them, so there is nothing here to hurry along.
      return NextResponse.json(
        { error: "this copy does not sync to another copy, so it has nothing to check in with" },
        { status: 400 }
      );
    }
    const { armed } = requestCheckIn();
    if (!armed) {
      // Requested anyway (the flag is read whenever the loop starts), but say
      // so rather than showing a spinner that will never resolve.
      return NextResponse.json(
        { error: "syncing is not running in this process yet; restart the local service" },
        { status: 409 }
      );
    }
    return NextResponse.json({ queued: true });
  } catch (err) {
    return errorResponse(err);
  }
}
