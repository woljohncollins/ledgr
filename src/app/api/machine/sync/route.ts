import { NextResponse } from "next/server";
import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncOps, syncPeers } from "@/db/schema";
import { verifySyncDevice } from "@/lib/sync/auth";
import { latestSchemaVer } from "@/lib/sync/version";
import { versionGate, type SyncOp } from "@/lib/sync/engine";
import { applySyncOps } from "@/lib/sync/apply";
import {
  cursorTooStale,
  dedupePushedOps,
  pullOnlyRejectsPush,
  readPrunedThrough,
} from "@/lib/sync/peers";
import { captureError, createLogger, errorMessage } from "@/lib/log";

// The hub side of the sync spine (plans/local-hub-idea-to-cutover.html,
// phase 1): one POST = one exchange. The peer pushes its ops since our last
// sight of it and pulls ours since its cursor. Auth is a DB-backed device
// token (sync_peers, plan decision 15) — the same public-matcher door as the
// other /api/machine routes, verified in the handler, never Clerk.
export const dynamic = "force-dynamic";
// A full 500-op batch on the neon-http driver is hundreds of round trips.
export const maxDuration = 60;

// Response batch cap; the client loops while hasMore.
const PULL_BATCH = 500;
// How far past the cap a batch may extend to finish the last op's same-`at`
// run (one hub transaction), so an FK-linked delete family is never split.
const RUN_EXTEND_CAP = 500;

type SyncRequest = {
  deviceId?: string;
  schemaVer?: string;
  sinceSeq?: number;
  ops?: SyncOp[];
  // ADR-210, additive and optional: `false` asks for a PUSH-ONLY exchange.
  // A peer sends it for a hub it is not allowed to pull from yet (an
  // emergency backup awaiting the owner's approval) — depositing changes is
  // always safe, reading is what trust gates. Omitted means pull, so every
  // caller written before this is byte-for-byte unaffected.
  pull?: boolean;
};

export async function POST(request: Request) {
  const peer = await verifySyncDevice(request.headers.get("authorization"));
  if (!peer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("sync");
  let body: SyncRequest;
  try {
    body = (await request.json()) as SyncRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Version gate FIRST: peers exchange ops only on identical bundled journal
  // tags. The 409 carries both versions — the stale side's update card reads
  // it (phase 5).
  const localVer = latestSchemaVer();
  if (!body.schemaVer || !versionGate(localVer, body.schemaVer)) {
    // Identify the caller: a 409 returns before anything else is recorded,
    // so without this line the rejected peer is anonymous in the logs.
    // Never log the token or the Authorization header.
    log.warn("schema version mismatch", {
      peer: peer.name,
      deviceId: peer.deviceId,
      localVer,
      remoteVer: body.schemaVer ?? null,
      ip: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json(
      { error: "schema version mismatch", localVer, remoteVer: body.schemaVer ?? null },
      { status: 409 }
    );
  }

  const ops = Array.isArray(body.ops) ? body.ops : [];
  const sinceSeq = Number.isFinite(body.sinceSeq) ? Number(body.sinceSeq) : 0;
  const wantsPull = body.pull !== false;

  // Guardrail 1, hub side: a pull_only device is refused outright rather than
  // silently dropped, so the guarantee never depends on the spoke behaving
  // (a bug or a misconfigured spoke can't push around it).
  if (pullOnlyRejectsPush(peer.pullOnly, ops.length)) {
    log.warn("pull-only device attempted to push ops", { peer: peer.name, count: ops.length });
    return NextResponse.json(
      { error: "this device is pull-only; it cannot push changes" },
      { status: 403 }
    );
  }

  try {
    const db = getDb();
    // Push dedupe (ADR-208): drop ops this device already pushed. Before
    // this, a re-delivered batch (response lost after apply, or a client
    // looping on a refusal below) was re-APPLIED, and each re-apply's row
    // writes had their triggers log fresh hub ops — unbounded oplog growth.
    const newOps = dedupePushedOps(ops, peer.lastPushedSeq);
    if (newOps.length < ops.length) {
      log.warn("dropped already-pushed ops (re-delivery)", {
        peer: peer.name,
        dropped: ops.length - newOps.length,
      });
    }
    const result = await applySyncOps(newOps);
    if (result.rejected > 0) {
      // Owner-scope or unknown-table refusals are visible, never silent.
      log.warn("sync ops rejected", { peer: peer.name, rejected: result.rejected });
    }
    // ADR-241: changes this hub could not apply are PARKED, not re-tried
    // forever. The rest of the batch landed and the peer may advance its
    // cursor, so this is the only place the failure is recorded. Captured as
    // an error (not just a log line) so it reaches the errors surface and the
    // weekly health check rather than scrolling past in a function log.
    if (result.parked.length > 0) {
      log.warn("sync changes parked: this hub could not apply them", {
        peer: peer.name,
        parked: result.parked,
      });
      await captureError(
        "sync",
        new Error(
          `${result.parked.length} change(s) from "${peer.name}" could not be applied and were parked: ` +
            result.parked.map((p) => `${p.kind} ${p.table} ${p.id ?? ""}: ${p.error}`).join("; ")
        ),
        { correlationId: log.correlationId }
      );
    }

    // Record the peer's push cursor + liveness. The identity is the
    // AUTHENTICATED row, never the body's claimed deviceId.
    const maxPushed = ops.reduce((m, o) => Math.max(m, o.seq ?? 0), 0);
    await db
      .update(syncPeers)
      .set({
        lastSeenAt: new Date(),
        lastPushedSeq: sql`greatest(${syncPeers.lastPushedSeq}, ${maxPushed})`,
      })
      .where(eq(syncPeers.deviceId, peer.deviceId));

    // A push-only exchange (ADR-210) stops here: no ops served, no
    // lastPulledSeq advance — the retention hold has to keep reflecting what
    // this peer has actually read — and no staleness refusal, since nothing
    // was pulled to be stale. The peer learns it is falling behind from the
    // freshness gap on its own Network page instead.
    if (!wantsPull) {
      return NextResponse.json({
        ops: [],
        cursor: sinceSeq,
        hasMore: false,
        schemaVer: localVer,
        applied: result.actions,
        rejected: result.rejected,
        parked: result.parked,
        pulled: false,
        serverTime: new Date().toISOString(),
      });
    }

    // The staleness refusal (ADR-208), AFTER the push half on purpose: a
    // waking peer's local edits still drain to the hub (they are ordinary
    // new ops, merged by the same LWW rules as any offline edit), because
    // the remedy for staleness is a re-fill, and a re-fill destroys
    // anything local that never pushed. The pull half is what must refuse:
    // ops in (sinceSeq, prunedThrough] were pruned, so serving "what's
    // left" would hand this peer a permanently partial database that
    // reports synced — the exact silent failure Principle 9 forbids.
    const prunedThrough = await readPrunedThrough();
    if (cursorTooStale(sinceSeq, prunedThrough)) {
      log.warn("peer cursor predates the oldest retained op; refusing", {
        peer: peer.name,
        sinceSeq,
        prunedThrough,
      });
      return NextResponse.json(
        {
          error:
            "cursor too far behind: ops this peer never pulled have been pruned; re-fill required",
          sinceSeq,
          prunedThrough,
          // The push half above DID run — the client may advance its push
          // cursor for the ops it sent even though the pull was refused.
          pushApplied: true,
          applied: result.actions,
          rejected: result.rejected,
        },
        { status: 410 }
      );
    }

    // Pull: our ops the peer hasn't seen, minus echoes of its own writes
    // (origin_device_id stamped by the apply layer where the driver allows).
    const rows = await db
      .select()
      .from(syncOps)
      .where(
        and(
          gt(syncOps.seq, sinceSeq),
          or(isNull(syncOps.originDeviceId), ne(syncOps.originDeviceId, peer.deviceId))
        )
      )
      .orderBy(syncOps.seq)
      .limit(PULL_BATCH);
    const hasMore = rows.length === PULL_BATCH;
    // A capped batch must not split one transaction's ops (they share `at` —
    // the trigger stamps now()): the receiver executes a batch's items
    // deletes as ONE statement (ADR-206 addendum 7), so a parent+child family
    // hard-deleted together has to travel together or the parent's delete
    // fails its FK and wedges the peer. Extend to the end of the run.
    // ponytail: RUN_EXTEND_CAP bounds a monster transaction; a >500-op
    // same-instant DELETE family could still split — raise the cap if ever
    // seen live.
    if (hasMore) {
      const last = rows[rows.length - 1];
      const run = await db
        .select()
        .from(syncOps)
        .where(
          and(
            gt(syncOps.seq, last.seq),
            eq(syncOps.at, last.at),
            or(isNull(syncOps.originDeviceId), ne(syncOps.originDeviceId, peer.deviceId))
          )
        )
        .orderBy(syncOps.seq)
        .limit(RUN_EXTEND_CAP);
      rows.push(...run);
    }
    // When the batch is capped, the cursor stops at the last included op so
    // the caller's loop misses nothing; otherwise it jumps to the head so
    // filtered-out echoes aren't rescanned forever.
    let cursor = rows.length > 0 ? rows[rows.length - 1].seq : sinceSeq;
    if (!hasMore) {
      const head = await db
        .select({ max: sql<string>`coalesce(max(${syncOps.seq}), 0)::text` })
        .from(syncOps);
      cursor = Math.max(cursor, Number(head[0]?.max ?? 0));
    }
    await db
      .update(syncPeers)
      .set({ lastPulledSeq: cursor })
      .where(eq(syncPeers.deviceId, peer.deviceId));

    return NextResponse.json({
      ops: rows.map((r) => ({
        seq: r.seq,
        deviceId: r.deviceId,
        originDeviceId: r.originDeviceId,
        ownerId: r.ownerId,
        at: r.at.toISOString(),
        tbl: r.tbl,
        rowId: r.rowId,
        kind: r.kind,
        changed: r.changed,
        schemaVer: r.schemaVer,
      })),
      cursor,
      hasMore,
      schemaVer: localVer,
      applied: result.actions,
      rejected: result.rejected,
      parked: result.parked,
      // Guardrail 3: additive field so existing callers are unaffected. The
      // client compares this to its own clock to detect skew.
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    const message = errorMessage(err);
    await captureError("sync", err, { correlationId: log.correlationId });
    log.error("sync exchange failed", { message, peer: peer.name });
    return NextResponse.json(
      { ok: false, correlationId: log.correlationId, error: message },
      { status: 500 }
    );
  }
}
