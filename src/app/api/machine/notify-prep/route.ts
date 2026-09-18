import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { runPrepNotify } from "@/lib/push/notify";
import { resolveNotifyOwner } from "@/lib/push/owner";
import { getWebPushSender } from "@/lib/push/web-push";
import { captureError, createLogger } from "@/lib/log";

// Meeting-prep-ready push (slice 30, PRD §4.11). Sub-daily (hourly) — so it
// runs from GitHub Actions (.github/workflows/notify-prep.yml) hitting this
// endpoint with the cron-scoped machine token, the same door as calendar/email
// sync. Each due meeting is notified once (per-meeting flag in
// runPrepNotify); the hourly cadence inside a 2h window catches every meeting.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("notify-prep");
  const sender = getWebPushSender();
  if (!sender) {
    log.warn("push not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY unset)");
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId, error: "push not configured (runbook §1e)" },
      { status: 503 }
    );
  }

  try {
    const ownerId = await resolveNotifyOwner();
    if (!ownerId) throw new Error("no users row matches the notify owner UPN");
    const result = await runPrepNotify(ownerId, sender);
    log.info("prep notify finished", { ...result });
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    await captureError("notify-prep", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
