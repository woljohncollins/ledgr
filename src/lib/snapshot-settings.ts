// The db-side half of snapshots: the knob, the database's own size, and the one
// runner both trigger paths call.
//
// `job_state` deliberately, for the same two reasons: it is outside ADR-206's
// synced set, so one peer's snapshot policy never replicates to another (each
// machine has its own disk), and it is read fresh on every run, so changing it
// needs no config-file edit and no restart.
//
// Split out of src/lib/snapshots.ts on purpose: that module stays free of the
// db client so the spread arithmetic runs in CI (verify-ci.mjs classifies any
// script that reaches the db as local-only).
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jobState } from "@/db/schema";
import { clampKeep, DEFAULT_KEEP } from "@/lib/snapshots-plan";
import { pruneSnapshots, snapshotsDir, takeSnapshot } from "@/lib/snapshots";

const SNAPSHOT_KEEP_KEY = "snapshots:keep";
const SNAPSHOT_ENABLED_KEY = "snapshots:enabled";

/**
 * Is the hourly snapshot switched on here?
 *
 * THE SWITCH LIVES HERE, NOT IN THE SUPERVISOR CONFIG (ADR-222). It used to be
 * `crons.snapshot` in `supervisor/config.json`, which meant turning restore
 * points on required editing a file and restarting a service — a builder's
 * gesture asked of the person using the product. The supervisor now schedules
 * the job unconditionally and this answers whether it does any work, so the
 * whole setting is a checkbox that takes effect on the next hour with no
 * restart.
 *
 * Absent = OFF, deliberately: snapshots cost real disk, and scheduling the job
 * for everyone must not start filling anyone's drive until they ask.
 */
export async function readSnapshotsEnabled(): Promise<boolean> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, SNAPSHOT_ENABLED_KEY));
  return (rows[0]?.value as { enabled?: unknown } | undefined)?.enabled === true;
}

export async function writeSnapshotsEnabled(enabled: boolean): Promise<boolean> {
  const value = { enabled };
  await getDb()
    .insert(jobState)
    .values({ key: SNAPSHOT_ENABLED_KEY, value })
    .onConflictDoUpdate({ target: jobState.key, set: { value, updatedAt: new Date() } });
  return enabled;
}

/** How many restore points to keep. Absent = the default, not "off". */
export async function readSnapshotKeep(): Promise<number> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, SNAPSHOT_KEEP_KEY));
  const stored = (rows[0]?.value as { keep?: unknown } | undefined)?.keep;
  return stored === undefined || stored === null ? DEFAULT_KEEP : clampKeep(stored);
}

export async function writeSnapshotKeep(keep: number): Promise<number> {
  const value = { keep: clampKeep(keep) };
  await getDb()
    .insert(jobState)
    .values({ key: SNAPSHOT_KEEP_KEY, value })
    .onConflictDoUpdate({ target: jobState.key, set: { value, updatedAt: new Date() } });
  return value.keep;
}

/**
 * On-disk size of this instance's database, for the size estimate shown before
 * any snapshot exists. Null when the query fails rather than a fake zero.
 */
export async function databaseBytes(): Promise<number | null> {
  try {
    const res = await getDb().execute(
      sql`select pg_database_size(current_database())::bigint as bytes`
    );
    const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
    const bytes = Number((rows[0] as { bytes?: unknown } | undefined)?.bytes);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Take a snapshot and prune to policy. THE one runner: both the hourly job
 * (GET /api/machine/snapshot) and the owner's "Snapshot now" button
 * (POST /api/snapshots) call this, so a manual snapshot is byte-for-byte the
 * same act as a scheduled one and there is no second place for the prune
 * decision to drift to.
 *
 * Prunes AFTER the dump on purpose: the new snapshot is part of the plan it is
 * pruned against, so the count on disk settles at `keep` rather than keep+1.
 *
 * Throws when the tools are missing or pg_dump fails; the callers report it.
 */
export async function runSnapshot(opts: {
  supervisorDir: string;
  dbUrl: string;
}): Promise<{ name: string; bytes: number; keep: number; removed: string[] }> {
  const keep = await readSnapshotKeep();
  const dir = snapshotsDir(opts.supervisorDir);
  const { name, bytes } = await takeSnapshot({ dbUrl: opts.dbUrl, dir });
  return { name, bytes, keep, removed: pruneSnapshots(dir, keep) };
}

/**
 * The local-peer gate both snapshot routes share. A cloud deployment has no
 * disk to write to and no local cluster to dump, so it says so rather than
 * half-working.
 */
export function snapshotTarget(): { supervisorDir: string; dbUrl: string } | null {
  const supervisorDir = process.env.LEDGR_SUPERVISOR_DIR;
  const dbUrl = process.env.DATABASE_URL;
  return supervisorDir && dbUrl ? { supervisorDir, dbUrl } : null;
}
