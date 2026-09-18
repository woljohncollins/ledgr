import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { gatherSyncStatus } from "@/lib/sync/client";

export const dynamic = "force-dynamic";

// GET /api/sync/status — the spoke-side sync state (the nav pill polls this,
// the /build/updates Sync section reads it server-side). Owner-authed: this is
// a UI surface, not a machine one (machine auth stays only on
// /api/machine/sync). With no LEDGR_SYNC_HUBS it answers {enabled: false}
// without touching the database, so the cloud hub and Tyler's instance pay
// one auth check and nothing else.
export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    return NextResponse.json(await gatherSyncStatus());
  } catch (err) {
    return errorResponse(err);
  }
}
