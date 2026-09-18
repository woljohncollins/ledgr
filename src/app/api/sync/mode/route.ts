import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { readSyncHubs, readSyncMode, writeSyncMode } from "@/lib/sync/client";

export const dynamic = "force-dynamic";

// PATCH /api/sync/mode {mode: "pull-only" | "full"} — this instance's own push
// mode, the spoke-side half of ADR-206 addendum 4's arming sequence. Owner
// authed (a UI surface); the hub's per-device pull_only flag is a different
// thing entirely and lives on /api/sync/peers/[id].
//
// The value goes to job_state, which is outside the synced set, so one peer's
// mode never replicates to another. The sync loop re-reads it every tick, so
// no restart is needed.
export async function PATCH(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  // The effective list (stored ?? env, ADR-209), so a hub added from
  // Build → Network counts without a restart.
  if ((await readSyncHubs()).length === 0) {
    return NextResponse.json({ error: "this instance does not sync to a hub" }, { status: 400 });
  }
  try {
    const body = (await request.json()) as { mode?: unknown };
    if (body.mode !== "pull-only" && body.mode !== "full") {
      return NextResponse.json(
        { error: 'mode must be "pull-only" or "full"' },
        { status: 400 }
      );
    }
    await writeSyncMode(body.mode);
    return NextResponse.json({ mode: await readSyncMode() });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
