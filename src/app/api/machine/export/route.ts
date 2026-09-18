import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { runExport } from "@/lib/export/engine";
import { getGraphConfig, OneDriveExportTarget } from "@/lib/export/onedrive";
import { captureError, createLogger, errorMessage } from "@/lib/log";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";

/**
 * The per-run caps, lifted when this install is not a serverless function.
 *
 * `undefined` on a cloud deploy leaves the engine's own defaults (30 items, a
 * 45s budget) exactly as they are — those exist because the lambda dies at 60s.
 * A supervised local peer has no such ceiling, so it takes the batch limit the
 * engine allows and a 20-minute budget, which is what lets a backlog actually
 * clear instead of shrinking by 30 a night.
 */
function localExportBudget(): { batch: number; budgetMs: number } | undefined {
  if (process.env.VERCEL_ENV || !process.env.LEDGR_SUPERVISOR_DIR) return undefined;
  return { batch: 500, budgetMs: 20 * 60_000 };
}

// Nightly OneDrive export (vercel.json cron; PRD §5.4). Same door as the
// purge: Vercel sends GET with CRON_SECRET, a raw cron-scoped machine token.
export const dynamic = "force-dynamic";
// Attachment copies can be large; take the full minute the plan allows.
export const maxDuration = 60;

// The export writes into one person's OneDrive, so the job belongs to the
// matching users row (multi-user-ready: a future per-user export would read
// per-user config instead).
async function resolveExportOwner(upn: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, upn.toLowerCase()));
  return rows[0]?.id ?? null;
}

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(
    request.headers.get("authorization"),
    "cron"
  );
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("export");
  const cfg = getGraphConfig();
  if (!cfg) {
    // Not configured yet is a visible condition, not a crash and not a
    // silent skip.
    log.warn("export target not configured (GRAPH_* / ONEDRIVE_* env unset)");
    return NextResponse.json(
      {
        ok: false,
        correlationId: log.correlationId,
        error: "export target not configured",
      },
      { status: 503 }
    );
  }

  try {
    const ownerId = await resolveExportOwner(cfg.upn);
    if (!ownerId) {
      throw new Error(`no users row matches ONEDRIVE_EXPORT_UPN ${cfg.upn}`);
    }
    // Exactly one install may run this: two writers on one OneDrive folder, and
    // `items.exported_at` is itself synced, so a double export is corrupting
    // rather than merely wasteful. An unclaimed job runs everywhere, as before.
    const standDown = await standDownIfNotOwner("export", ownerId);
    if (standDown) {
      log.info("export skipped: this install does not own the job");
      return standDown;
    }
    const itemErrors: { itemId: string; message: string }[] = [];
    const attachmentErrors: { itemId: string; storageKey: string; status: number }[] = [];
    const result = await runExport(ownerId, new OneDriveExportTarget(cfg), {
      // THE REASON MOVING THIS JOB IS WORTH ANYTHING. The caps exist because a
      // Vercel lambda dies at 60s: 30 items and a 45s budget per run. Measured
      // 2026-08-25, that no longer keeps up with the edit rate, so `remaining`
      // climbs and the queue never drains. A local peer has no such ceiling, so
      // when the job runs on one it takes the whole queue in one pass.
      ...(localExportBudget() ?? {}),
      onError: (itemId, err) =>
        itemErrors.push({ itemId, message: errorMessage(err) }),
      onAttachmentError: (itemId, failures) =>
        attachmentErrors.push(...failures.map((f) => ({ itemId, ...f }))),
    });
    await stampJobRun(ownerId, "export");
    log.info("export run finished", { ...result });
    if (itemErrors.length > 0) {
      await captureError("export", null, {
        correlationId: log.correlationId,
        message: `${itemErrors.length} item(s) failed to export`,
        detail: { itemErrors },
      });
    }
    // Skipped attachments don't fail the run (the item still exported), but
    // they're not silent: capture so the missing bytes are visible in /health.
    if (attachmentErrors.length > 0) {
      await captureError("export", null, {
        correlationId: log.correlationId,
        message: `${attachmentErrors.length} attachment(s) skipped (bytes unavailable)`,
        detail: { attachmentErrors },
      });
    }
    return NextResponse.json({
      ok: true,
      correlationId: log.correlationId,
      ...result,
    });
  } catch (err) {
    await captureError("export", err, { correlationId: log.correlationId });
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId },
      { status: 500 }
    );
  }
}
