import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";

export const dynamic = "force-dynamic";

// POST /api/local/restart — restart this machine's local service (ADR-227).
//
// The app cannot do this itself: the supervisor owns the app process, so an app
// that stopped its own parent would have nobody left to start it again. So this
// writes a REQUEST FILE and the supervisor carries it out — the same seam as
// stop-requested and startup-requested (ADR-211), and the same reason: the app
// asks, a process that can actually do the thing does it, and the outcome is
// written back for the app to read once it is up again.
//
// Owner-authed. Deliberately not a machine-token route: it takes the whole peer
// down for a moment, so it belongs to the person, not to a cron.
export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const dir = process.env.LEDGR_SUPERVISOR_DIR;
  if (!dir || process.env.VERCEL_ENV) {
    // Fail closed, ADR-184 style: a cloud deploy has no local service, and a
    // stray env var must never make it look like it has one.
    return NextResponse.json(
      { error: "this copy has no local service to restart" },
      { status: 400 }
    );
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : "asked from the app";
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(
      join(dir, "restart-requested"),
      JSON.stringify({ reason, at: new Date().toISOString() }, null, 2),
      "utf8"
    );
    // "Requested", never "restarted": the work happens in another process and
    // the caller confirms it by watching for the service to come back.
    return NextResponse.json({ requested: true });
  } catch (err) {
    return errorResponse(err);
  }
}
