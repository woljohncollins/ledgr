import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import {
  getSyncStatus,
  readSyncHubs,
  writeStoredConfirmLargePush,
} from "@/lib/sync/client";

export const dynamic = "force-dynamic";

// POST /api/sync/release-push — release a held first push (guardrail 2) from
// the GUI, instead of editing supervisor config and restarting. Owner-authed
// like /api/sync/mode. The flag is ONE-SHOT: the loop clears it as soon as
// the push goes through, so it can never quietly release a future process's
// held push (see client.ts).
export async function POST() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    if ((await readSyncHubs()).length === 0) {
      return NextResponse.json({ error: "this instance does not sync to a hub" }, { status: 400 });
    }
    const s = getSyncStatus();
    if (s.holdReason !== "first_push_size") {
      return NextResponse.json(
        { error: "no held first push to release right now" },
        { status: 409 }
      );
    }
    await writeStoredConfirmLargePush(true);
    return NextResponse.json({ released: true });
  } catch (err) {
    return errorResponse(err);
  }
}
