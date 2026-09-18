import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { captureError, createLogger } from "@/lib/log";
import {
  readSnapshotKeep,
  readSnapshotsEnabled,
  runSnapshot,
  snapshotTarget,
  writeSnapshotKeep,
  writeSnapshotsEnabled,
} from "@/lib/snapshot-settings";
import { MAX_KEEP, MIN_KEEP } from "@/lib/snapshots-plan";

export const dynamic = "force-dynamic";

// The owner's own snapshot surface, both verbs local-peer only:
//
//   PATCH {enabled?, keep?}  whether this machine takes them, and how many it
//                            keeps. Either field alone; both are optional.
//   POST                     take one right now
//
// Stored in job_state so PATCH applies to the next run with no restart, and
// never synced: each machine has its own disk and its own answer.

/** The shared local-peer gate, as a response. */
function requireLocalPeer() {
  const target = snapshotTarget();
  return target ?? NextResponse.json({ error: "snapshots are a local-peer feature" }, { status: 400 });
}

export async function PATCH(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const target = requireLocalPeer();
  if (target instanceof NextResponse) return target;
  try {
    const body = (await request.json()) as { keep?: unknown; enabled?: unknown };

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
      }
      // Switching OFF never deletes the restore points already on disk: the
      // point of a safety net is that turning off the machine that fills it
      // does not take away what it caught (defer-by-hiding, not deleting).
      await writeSnapshotsEnabled(body.enabled);
    }

    if (body.keep !== undefined) {
      const keep = Number(body.keep);
      if (!Number.isFinite(keep) || keep < MIN_KEEP || keep > MAX_KEEP) {
        return NextResponse.json(
          { error: `keep must be a number between ${MIN_KEEP} and ${MAX_KEEP}` },
          { status: 400 }
        );
      }
      // Deliberately does NOT prune here. Lowering the number deletes history,
      // and that belongs on the scheduled path where it always happens, not on
      // a click in a settings form. The section says when it takes effect.
      await writeSnapshotKeep(keep);
    }

    return NextResponse.json({
      enabled: await readSnapshotsEnabled(),
      keep: await readSnapshotKeep(),
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}

/**
 * POST — "Snapshot now". The same `runSnapshot` the hourly job calls, so a
 * manual restore point is indistinguishable from a scheduled one (including the
 * prune: an extra dump inside the same hour collapses to the newest, which is
 * the tiered spread doing its job rather than a special case).
 *
 * Synchronous on purpose: a dump takes seconds to a minute and the owner pressed
 * a button, so they should be told what happened rather than left to guess. The
 * button disables itself while it runs.
 */
export async function POST() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const target = requireLocalPeer();
  if (target instanceof NextResponse) return target;

  const log = createLogger("snapshot");
  try {
    const result = await runSnapshot(target);
    log.info("manual snapshot taken", { ...result, removed: result.removed.length });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Same posture as the scheduled path: a failed snapshot is never silent.
    await captureError("snapshot", err, { correlationId: log.correlationId });
    return NextResponse.json(
      {
        ok: false,
        correlationId: log.correlationId,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
