import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";
import { getGraphCalendarSource } from "@/lib/calendar/graph-source";
import { resolveMailboxOwner } from "@/lib/calendar/owner";
import { runCalendarSync } from "@/lib/calendar/sync";
import { getGraphMailboxUpn, GraphError } from "@/lib/graph/client";
import { captureError, createLogger, errorMessage } from "@/lib/log";

// Scheduled calendar sync (slice 22, PRD §5.1). Sub-daily, so it runs from
// GitHub Actions (.github/workflows/calendar-sync.yml) hitting this endpoint
// with a cron-scoped machine token — the same auth door as the purge/export
// crons. The user-authed "sync now" twin is POST /api/calendar/sync.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("calendar-sync");
  const source = getGraphCalendarSource();
  const upn = getGraphMailboxUpn();
  if (!source || !upn) {
    log.warn("calendar source not configured (GRAPH_* / mailbox UPN unset)");
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId, error: "calendar source not configured" },
      { status: 503 }
    );
  }

  try {
    const ownerId = await resolveMailboxOwner(upn);
    const standDown = ownerId ? await standDownIfNotOwner("calendar-sync", ownerId) : null;
    if (standDown) return standDown;
    if (!ownerId) throw new Error(`no users row matches mailbox UPN ${upn}`);
    const eventErrors: { eventId: string; message: string }[] = [];
    // Promotion is MANUAL (ADR-123): the cron only caches events into the feed;
    // they become items when the owner clicks Add, where applyEventIntake (the
    // template-rule + person-suggester) runs. No auto-promote, so no
    // shouldPromote/onPromoted — the matcher engine is retired from this path.
    const result = await runCalendarSync(ownerId, source, {
      onError: (eventId, err) => eventErrors.push({ eventId, message: errorMessage(err) }),
    });
    log.info("calendar sync finished", { ...result });
    if (eventErrors.length > 0) {
      await captureError("calendar-sync", null, {
        correlationId: log.correlationId,
        message: `${eventErrors.length} event(s) failed to sync`,
        detail: { eventErrors },
      });
    }
    await stampJobRun(ownerId, "calendar-sync");
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    // A 403 means Calendars.Read / the Application Access Policy isn't in place
    // yet (runbook §1c): a visible "not configured" condition, not a fault —
    // report it as 503 and warn, so error_log isn't spammed every 6h before
    // setup. /health calendar lastSuccessAt staying null is the canary.
    if (err instanceof GraphError && err.status === 403) {
      log.warn("calendar read forbidden (403): Calendars.Read / Application Access Policy not in place (runbook §1c)");
      return NextResponse.json(
        { ok: false, correlationId: log.correlationId, error: "calendar access not configured (runbook §1c)" },
        { status: 503 }
      );
    }
    await captureError("calendar-sync", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
