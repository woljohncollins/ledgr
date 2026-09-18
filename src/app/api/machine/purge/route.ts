import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { captureError, createLogger } from "@/lib/log";
import { purgeExpiredTrash } from "@/lib/item-mutations";
import { purgeExpiredAudio } from "@/lib/attachments";
import { purgeArchivedNotifications } from "@/lib/notifications";
import { pruneSyncOps } from "@/lib/sync/peers";
import { announceOwnInstall } from "@/lib/installs";

// Daily Trash purge (vercel.json cron). Vercel sends GET with
// `Authorization: Bearer $CRON_SECRET`; CRON_SECRET holds a raw machine
// token with the cron scope, so the platform cron walks through the same
// door as any other machine caller (ADR-005, runbook.md §3). Also reclaims
// expired audio (meeting recording v1b, ADR-089): once a transcript is
// produced, the audio is stamped purge_after now()+30d and removed here.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(
    request.headers.get("authorization"),
    "cron"
  );
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("purge");
  try {
    const result = await purgeExpiredTrash();
    const audio = await purgeExpiredAudio();
    // 30-day purge of archived notifications (ADR-129), matching Trash's window.
    const notifications = await purgeArchivedNotifications();
    // Sync oplog retention (ADR-206): the row-level triggers append forever,
    // so drop ops every live peer has pulled that are past the time floor.
    const syncOps = await pruneSyncOps();
    // The roster heartbeat rides here (ADR-220) because `purge` is the one job
    // ADR-214 says EVERY instance runs itself, daily — so a cloud deploy and a
    // local peer both announce with no new scheduler and no new schedule to
    // forget. Day granularity is all any surface reads.
    await announceOwnInstall();
    log.info("purge run finished", { ...result, ...audio, ...notifications, ...syncOps });
    return NextResponse.json({
      ok: true,
      correlationId: log.correlationId,
      ...result,
      ...audio,
      ...notifications,
      ...syncOps,
    });
  } catch (err) {
    // No silent failures: cron errors land in error_log and surface
    // through /health.
    await captureError("purge", err, { correlationId: log.correlationId });
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId },
      { status: 500 }
    );
  }
}
