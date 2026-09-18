// All the owner's files (ADR-237, Data Hygiene tool #2): every attachment with
// its parent item and whether the item still points at it. Deletion goes
// through the existing DELETE /api/attachments/[id]; this route only reads.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { listAllAttachments } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const owner = await requireOwner();
    if (owner instanceof NextResponse) return owner;
    const files = await listAllAttachments(owner.id);
    return NextResponse.json({
      files,
      totalBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
