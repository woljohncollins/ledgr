import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";
import { getGraphMailSource } from "@/lib/email/graph-source";
import { runEmailImport } from "@/lib/email/sync";
import { resolveMailboxOwner } from "@/lib/calendar/owner";
import { getGraphMailboxUpn, GraphError } from "@/lib/graph/client";
import { captureError, createLogger, errorMessage } from "@/lib/log";

// Scheduled email-in (slice 26, PRD §5.3). GitHub Actions cron with a
// cron-scoped token, same door as the other machine jobs. User-authed twin:
// POST /api/email/import.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const log = createLogger("email-import");
  const source = getGraphMailSource();
  const upn = getGraphMailboxUpn();
  if (!source || !upn) {
    log.warn("mail source not configured (GRAPH_* / mailbox UPN unset)");
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId, error: "mail source not configured" },
      { status: 503 }
    );
  }

  try {
    const ownerId = await resolveMailboxOwner(upn);
    const standDown = ownerId ? await standDownIfNotOwner("email-import", ownerId) : null;
    if (standDown) return standDown;
    if (!ownerId) throw new Error(`no users row matches mailbox UPN ${upn}`);
    const msgErrors: { messageId: string; message: string }[] = [];
    const result = await runEmailImport(ownerId, source, {
      onError: (messageId, err) => msgErrors.push({ messageId, message: errorMessage(err) }),
    });
    log.info("email import finished", { ...result });
    if (msgErrors.length > 0) {
      await captureError("email-import", null, {
        correlationId: log.correlationId,
        message: `${msgErrors.length} message(s) failed to import`,
        detail: { msgErrors },
      });
    }
    await stampJobRun(ownerId, "email-import");
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    // 403 = Mail.ReadWrite not granted (§1c); 404 = the "Ledgr Import" folder
    // doesn't exist yet. Both are "not configured", not faults — 503 + warn.
    if (err instanceof GraphError && (err.status === 403 || err.status === 404)) {
      log.warn("email import not configured", { detail: err.message });
      return NextResponse.json(
        { ok: false, correlationId: log.correlationId, error: "email import not configured (runbook §1c / §5.3)" },
        { status: 503 }
      );
    }
    await captureError("email-import", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
