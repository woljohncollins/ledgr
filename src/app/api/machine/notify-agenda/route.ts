import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { runAgendaNotify } from "@/lib/push/notify";
import { resolveNotifyOwner } from "@/lib/push/owner";
import { getWebPushSender } from "@/lib/push/web-push";
import { captureError, createLogger } from "@/lib/log";

// Morning agenda push (slice 30, PRD §4.11). Daily — so it runs on the Vercel
// cron (vercel.json) with the same Bearer $CRON_SECRET door as purge/export.
// A daily Vercel cron is fine (Hobby supports daily); only sub-daily jobs need
// GitHub Actions. The day guard in runAgendaNotify makes a double fire a no-op.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("notify-agenda");
  const sender = getWebPushSender();
  if (!sender) {
    // VAPID keys unset (runbook §1e): a visible "not configured" condition,
    // not a fault — like the Graph/Todoist 503 paths. /health push.lastAgenda
    // staying null is the canary.
    log.warn("push not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY unset)");
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId, error: "push not configured (runbook §1e)" },
      { status: 503 }
    );
  }

  try {
    const ownerId = await resolveNotifyOwner();
    if (!ownerId) throw new Error("no users row matches the notify owner UPN");
    const result = await runAgendaNotify(ownerId, sender);
    log.info("agenda notify finished", { ...result, tally: result.tally });
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    await captureError("notify-agenda", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
