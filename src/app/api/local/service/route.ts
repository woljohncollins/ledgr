import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { readLocalServiceReport } from "@/lib/local-service";

export const dynamic = "force-dynamic";

// GET /api/local/service — what the local service says about itself (ADR-227).
//
// Exists so the Restart button can tell "back up" from "still down": the answer
// carries the supervisor's pid, so a caller that recorded the old one knows a
// DIFFERENT process is serving rather than assuming the request worked. While
// the peer is restarting this endpoint does not answer at all, which is itself
// the honest signal.
export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const report = await readLocalServiceReport(
    process.env.VERCEL_ENV ? null : (process.env.LEDGR_SUPERVISOR_DIR ?? null)
  );
  return NextResponse.json(report);
}
