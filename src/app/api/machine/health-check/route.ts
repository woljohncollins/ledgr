import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";
import { runHealthCheck } from "@/lib/health-check";
import { resolveNotifyOwner } from "@/lib/push/owner";
import { getWebPushSender } from "@/lib/push/web-push";
import { captureError, createLogger } from "@/lib/log";

// Weekly health check (slice 37, PRD §6.2). Weekly is sub-daily-frequency, so
// it comes from GitHub Actions hitting this authenticated endpoint — the same
// scheduler seam (§6.1) the calendar/email/Todoist/prep crons use, swappable
// for a local cron in Phase 4. Cron-scoped machine token, the same door as the
// other /api/machine jobs.
//
// Unlike the agenda push, an unset push sender (no VAPID keys, runbook §1e) is
// NOT a 503 here: the check still runs and records its findings to job_state
// (which /health surfaces) — it just can't deliver the alert. The job's value
// is the self-monitoring, not only the notification.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("health-check");
  try {
    const ownerId = await resolveNotifyOwner();
    if (!ownerId) throw new Error("no users row matches the notify owner UPN");
    const standDown = await standDownIfNotOwner("health-check", ownerId);
    if (standDown) return standDown;
    const sender = getWebPushSender(); // may be null (VAPID unset) — run anyway
    const result = await runHealthCheck(ownerId, sender);
    log.info("health check finished", {
      alerts: result.alerts.length,
      codes: result.alerts.map((a) => a.code),
      delivered: result.delivered,
      pushConfigured: !!sender,
    });
    await stampJobRun(ownerId, "health-check");
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    await captureError("health-check", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
