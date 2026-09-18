// Orphaned-files sweep (ADR-237, the Data Hygiene page's first real tool).
// GET scans: every object in storage under the owner's prefix with no
// attachment row behind it. DELETE removes them; POST RECOVERS them instead —
// one note per file, linking it, with its attachment row recreated. Both
// re-scan server-side, so a file uploaded after the scan the owner is looking
// at can never be caught (its row exists). Owner-scoped throughout.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import {
  deleteOrphanedObjects,
  findOrphanedObjects,
  recoverOrphanedObjects,
} from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const owner = await requireOwner();
    if (owner instanceof NextResponse) return owner;
    const orphans = await findOrphanedObjects(owner.id);
    return NextResponse.json({
      orphans,
      totalBytes: orphans.reduce((a, o) => a + o.sizeBytes, 0),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    const owner = await requireOwner();
    if (owner instanceof NextResponse) return owner;
    return NextResponse.json(await deleteOrphanedObjects(owner.id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST() {
  try {
    const owner = await requireOwner();
    if (owner instanceof NextResponse) return owner;
    return NextResponse.json(await recoverOrphanedObjects(owner.id));
  } catch (err) {
    return errorResponse(err);
  }
}
