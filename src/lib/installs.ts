// The roster's db side: announce this copy, read the roster, rename a copy.
//
// The rules that keep this honest, all of them learned the hard way elsewhere in
// this codebase:
//
//   1. An install writes ONLY its own row. That is what makes the synced
//      field-level merge safe (see the table's comment in schema.ts).
//   2. The periodic announce NEVER touches `label`. The owner can rename a
//      machine from any device, and a heartbeat that also wrote the label would
//      silently revert that rename on the next run.
//   3. The config-supplied name SEEDS the row and never re-seeds it. Same
//      reason: after the first announce the database is authoritative.
import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { installs, syncDevice } from "@/db/schema";
import { normalizeLabel, type Install } from "@/lib/installs-plan";

/** "cloud" on a Vercel deploy, "local" on anything a person can walk up to. */
export function installKind(): "cloud" | "local" {
  return process.env.VERCEL_ENV ? "cloud" : "local";
}

/**
 * The name to SEED a new row with, when the owner has not named this machine.
 *
 * `LEDGR_INSTALL_LABEL` is what the setup wizard writes, and it is the intended
 * path: the wizard asks rather than assuming, which is the collision guard.
 * A hostname is the fallback for a copy that predates the wizard's question.
 */
export function seedLabel(): string {
  if (process.env.LEDGR_INSTALL_LABEL) return normalizeLabel(process.env.LEDGR_INSTALL_LABEL);
  if (installKind() === "cloud") return "Cloud";
  return normalizeLabel(hostname(), "This machine");
}

async function ownDeviceId(): Promise<string | null> {
  try {
    const rows = await getDb().select({ id: syncDevice.id }).from(syncDevice).limit(1);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Tell the roster this copy is alive, and what it is running.
 *
 * Called from the `purge` job, which by ADR-214's design runs on EVERY instance
 * daily — so this needs no new scheduler, and a cloud deploy announces itself
 * exactly like a local peer. Deliberately not called on every request or every
 * sync tick: each write is a synced op, and day-granularity is all any surface
 * reads.
 *
 * Insert seeds the label; update leaves it alone (rule 2).
 */
export async function announceInstall(ownerId: string, now = new Date()): Promise<void> {
  const id = await ownDeviceId();
  if (!id) return; // no identity yet; nothing meaningful to announce
  const appVersion = process.env.LEDGR_BUILD_SHA || null;
  await getDb()
    .insert(installs)
    .values({ id, ownerId, label: seedLabel(), kind: installKind(), appVersion, lastSeenAt: now })
    .onConflictDoUpdate({
      target: installs.id,
      set: { kind: installKind(), appVersion, lastSeenAt: now },
    });
}

/**
 * The announce the daily job makes, resolving the owner itself.
 *
 * `resolveMachineOwner()` FIRST, which is how every other scheduled job on this
 * instance finds its owner. The earliest-`users`-row fallback is only for an
 * instance with none of those env vars set — and it is a fallback rather than
 * the rule because a database can hold more than one `users` row (a dev branch
 * accumulates throwaway owners from the verify suites, which is exactly how this
 * was found): attributing the roster row to the wrong one makes the page show an
 * empty list while the row sits there.
 *
 * Best-effort by nature: a heartbeat that failed must never fail the purge it
 * rides on. But it says so, because a roster that quietly never fills would look
 * identical to one nobody has set up.
 */
export async function announceOwnInstall(now = new Date()): Promise<void> {
  try {
    const { resolveMachineOwner } = await import("@/lib/machine/owner");
    const { users } = await import("@/db/schema");
    let ownerId = await resolveMachineOwner().catch(() => null);
    if (!ownerId) {
      const rows = await getDb()
        .select({ id: users.id })
        .from(users)
        .orderBy(users.createdAt)
        .limit(1);
      ownerId = rows[0]?.id ?? null;
    }
    if (ownerId) await announceInstall(ownerId, now);
  } catch (err) {
    const { createLogger } = await import("@/lib/log");
    createLogger("installs").warn("could not announce this copy", { error: String(err) });
  }
}

/**
 * How stale this copy's own roster row may get before a READ refreshes it.
 *
 * The daily announce is the right cadence for hearing about the OTHER copies,
 * and it was the only writer — which meant a copy that had not yet run its
 * 03:10 purge was missing from its own roster, and the job picker on that
 * machine offered no machines to pick. A feature that looks broken for its
 * first day is indistinguishable from one that is broken.
 *
 * So a roster read also refreshes this copy's own row when it is absent or
 * older than this. Twelve hours holds it to at most two extra synced ops a day
 * — the whole reason announce is not per-request — while making the roster
 * correct the moment anybody looks at it.
 */
const SELF_REFRESH_MS = 12 * 60 * 60 * 1000;

export async function listInstalls(ownerId: string): Promise<Install[]> {
  const selfId = await ownDeviceId();
  try {
    let rows = await getDb()
      .select()
      .from(installs)
      .where(eq(installs.ownerId, ownerId))
      .orderBy(installs.label);

    if (selfId) {
      const self = rows.find((r) => r.id === selfId);
      const stale =
        !self || !self.lastSeenAt || Date.now() - self.lastSeenAt.getTime() > SELF_REFRESH_MS;
      // Best-effort: a failed refresh must never turn a readable roster into an
      // empty page, so the rows already in hand stand.
      if (stale) {
        try {
          await announceInstall(ownerId);
          rows = await getDb()
            .select()
            .from(installs)
            .where(eq(installs.ownerId, ownerId))
            .orderBy(installs.label);
        } catch {
          // keep what we read
        }
      }
    }

    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind === "cloud" ? "cloud" : "local",
      appVersion: r.appVersion,
      lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
      isSelf: r.id === selfId,
    }));
  } catch (err) {
    // A database that has not taken 0058 yet: no roster, not a crash. But it is
    // SAID, because an empty list and a broken read look identical on the page
    // and only one of them is fine.
    const { createLogger } = await import("@/lib/log");
    createLogger("installs").warn("could not read the roster", { error: String(err) });
    return [];
  }
}

/**
 * Rename any copy, from any copy.
 *
 * Editing another install's row is the one deliberate exception to rule 1, and
 * it is safe: a label is a display name, so the worst a concurrent edit can do
 * is flip which name wins. Brandon asked for this specifically — a machine named
 * once at setup must still be renameable later without visiting it.
 */
export async function renameInstall(
  ownerId: string,
  id: string,
  label: string
): Promise<Install | null> {
  await getDb()
    .update(installs)
    .set({ label: normalizeLabel(label) })
    .where(and(eq(installs.id, id), eq(installs.ownerId, ownerId)));
  const all = await listInstalls(ownerId);
  return all.find((i) => i.id === id) ?? null;
}

/**
 * Forget a copy that is gone for good.
 *
 * Only ever a row this copy is NOT: removing your own would make the roster lie
 * about the machine you are looking at, and the next announce would recreate it
 * anyway.
 */
export async function forgetInstall(ownerId: string, id: string): Promise<boolean> {
  const selfId = await ownDeviceId();
  if (id === selfId) return false;
  await getDb().delete(installs).where(and(eq(installs.id, id), eq(installs.ownerId, ownerId)));
  return true;
}
