import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { captureError, createLogger } from "@/lib/log";
import { resolveMachineOwner } from "@/lib/machine/owner";
import { rollOverdueScheduled } from "@/lib/scheduling";

// Optional daily overdue auto-roll (T2, ADR-073): a scheduler (Vercel cron /
// GitHub Actions / a local cron) calls this through the machine-token door
// (ADR-036) to pull overdue planned tasks forward to today. Deterministic, no
// model (Principle 3). Not scheduled by default — wire it into vercel.json or a
// GitHub Actions workflow if auto-roll is wanted; the manual button on Today
// (POST /api/tasks/roll-overdue) is the always-on path.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const log = createLogger("roll-overdue");
  try {
    const ownerId = await resolveMachineOwner();
    if (!ownerId) {
      log.warn("roll-overdue: no owner resolved");
      return NextResponse.json({ ok: true, rolled: 0, note: "no owner" });
    }
    const result = await rollOverdueScheduled(ownerId);
    log.info("roll-overdue finished", { ...result });
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    await captureError("roll-overdue", err, { correlationId: log.correlationId });
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId },
      { status: 500 }
    );
  }
}
