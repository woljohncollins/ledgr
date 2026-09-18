import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";
import { isTodoistAdapterActive } from "@/lib/tasks/provider";
import { getTodoistClient } from "@/lib/todoist/client";
import { resolveTodoistOwner } from "@/lib/todoist/owner";
import { runTodoistSync } from "@/lib/todoist/sync";
import { captureError, createLogger, errorMessage } from "@/lib/log";

// Polling fallback for Todoist sync (slice 25, PRD §5.2). The webhook is the
// real-time path; this GitHub Actions cron is the backstop (and catches
// anything the webhook missed). Cron-scoped machine token, same door as the
// other machine jobs. User-authed twin: POST /api/todoist/sync.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("todoist-sync");
  // Native is the default tasks adapter (ADR-073/081): Ledgr owns tasks in-app,
  // so when Todoist isn't the active adapter the cron no-ops cleanly (200, not
  // an error) — the scheduled job can keep firing harmlessly.
  if (!isTodoistAdapterActive()) {
    return NextResponse.json({ ok: true, skipped: true, adapter: "native" });
  }
  const client = getTodoistClient();
  if (!client) {
    log.warn("Todoist not configured (TODOIST_TOKEN unset)");
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId, error: "Todoist not configured" },
      { status: 503 }
    );
  }

  try {
    const ownerId = await resolveTodoistOwner();
    if (!ownerId) throw new Error("no users row resolves the Todoist owner (set TODOIST_OWNER_UPN)");
    const standDown = await standDownIfNotOwner("todoist-sync", ownerId);
    if (standDown) return standDown;
    const taskErrors: { itemId: string; message: string }[] = [];
    const result = await runTodoistSync(ownerId, client, {
      onError: (itemId, err) => taskErrors.push({ itemId, message: errorMessage(err) }),
    });
    log.info("todoist sync finished", { ...result });
    if (taskErrors.length > 0) {
      await captureError("todoist-sync", null, {
        correlationId: log.correlationId,
        message: `${taskErrors.length} task(s) failed to sync`,
        detail: { taskErrors },
      });
    }
    await stampJobRun(ownerId, "todoist-sync");
    return NextResponse.json({ ok: true, correlationId: log.correlationId, ...result });
  } catch (err) {
    await captureError("todoist-sync", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
