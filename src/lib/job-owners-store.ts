// The db side of job ownership: read the slot, claim it, release it, and stamp
// a run. The decisions all live in src/lib/job-owners.ts (pure, CI-tested);
// this is the part that touches settings and the device identity.
//
// Split for the same reason snapshot-settings.ts is split from snapshots.ts: the
// pure half has to stay importable by a verify script that runs with no
// database.
import { getSettings, updateSettings } from "@/lib/settings";
import { readLocalDeviceId } from "@/lib/sync/client";
import { listInstalls, seedLabel } from "@/lib/installs";
import {
  claimFor,
  MOVABLE_JOBS,
  ownershipOf,
  shouldRunHere,
  type JobOwners,
  type MovableJob,
  type Verdict,
} from "@/lib/job-owners";

/**
 * Is this install one whose scheduler fires the exclusive jobs without being
 * asked — i.e. a supervised local peer?
 *
 * `LEDGR_SUPERVISOR_DIR` is set by the supervisor and by nothing else, so it
 * answers exactly the question that matters: is something out there about to
 * call these endpoints on a timer? A cloud deploy has no supervisor (its timers
 * are the platform's), and a dev checkout run by hand has none either, so both
 * keep the old "absent means run it" behavior (ADR-225).
 */
export function isSupervisedPeer(): boolean {
  return !!process.env.LEDGR_SUPERVISOR_DIR && !process.env.VERCEL_ENV;
}

/**
 * What this machine goes by, for the claim it writes.
 *
 * Delegates to the roster's own seed (ADR-220) so a claim and a roster row can
 * never disagree about the same machine's name. Note this is only the SEED: once
 * the roster row exists, the owner's chosen name lives there and `assign` reads
 * it from the row rather than from here.
 */
export function installLabel(): string {
  return seedLabel();
}

export async function readJobOwners(ownerId: string): Promise<JobOwners> {
  return (await getSettings(ownerId)).jobOwners;
}

/**
 * THE GATE, as one call a route can make. Returns the verdict plus enough
 * context to log or report it honestly.
 *
 * Reads settings fresh (getSettings is request-cached, not process-cached), so
 * a machine that lost the job between runs sees that on its next run.
 */
export async function jobRunVerdict(
  ownerId: string,
  job: MovableJob
): Promise<{ run: boolean; reason: Verdict; ownerLabel: string | null }> {
  const owners = await readJobOwners(ownerId);
  const selfDeviceId = await readLocalDeviceId();
  const verdict = shouldRunHere({
    owners,
    job,
    selfDeviceId,
    standDownWhenUnset: isSupervisedPeer(),
  });
  const state = ownershipOf(owners, job);
  return {
    ...verdict,
    ownerLabel: state.state === "claimed" ? state.claim.label : null,
  };
}

/**
 * Record that the owner actually ran the job. This is what makes the liveness
 * warning mean "the work is happening" rather than "that device is online".
 *
 * Throttled to once an hour: the write goes through `users.settings`, which
 * SYNCS, so stamping every run of a 15-minute job would put a settings op on
 * the wire four times an hour for no added truth. Nothing reads this at finer
 * resolution than days.
 */
export async function stampJobRun(ownerId: string, job: MovableJob, now = new Date()): Promise<void> {
  const owners = await readJobOwners(ownerId);
  const state = ownershipOf(owners, job);
  if (state.state !== "claimed") return; // nothing to stamp: nobody claimed it
  const last = state.claim.lastRunAt ? Date.parse(state.claim.lastRunAt) : 0;
  if (Number.isFinite(last) && now.getTime() - last < 3_600_000) return;
  await updateSettings(ownerId, {
    jobOwners: { ...owners, [job]: { ...state.claim, lastRunAt: now.toISOString() } },
  });
}

export type ClaimAction = "claim" | "assign" | "nobody" | "default";

/**
 * Move a job to any copy the owner runs.
 *
 * `assign` is what the roster bought (ADR-220): before it existed, no install
 * could name another one, so the only expressible move was "run it HERE". Now
 * the target comes from the roster, whose rows are keyed by each install's OWN
 * id — the same id space the gate compares against — so pointing a job at
 * another machine from anywhere finally type-checks in the real sense.
 *
 * `claim` is kept as the shorthand for "here" (it needs no target), and `nobody`
 * / `default` still work from anywhere, which is what makes a job recoverable
 * when the machine holding it is gone for good.
 */
export async function setJobOwner(
  ownerId: string,
  job: MovableJob,
  action: ClaimAction,
  opts: { deviceId?: string; now?: Date } = {}
): Promise<{ owners: JobOwners; error?: string }> {
  const now = opts.now ?? new Date();
  const owners = await readJobOwners(ownerId);
  if (action === "default") {
    // Absent, not null: the cloud copy does it and supervised peers stand down,
    // which is where an owner who never opened this picker already was.
    const next = { ...owners };
    delete next[job];
    return { owners: (await updateSettings(ownerId, { jobOwners: next })).jobOwners };
  }
  if (action === "nobody") {
    const next: JobOwners = { ...owners, [job]: null };
    return { owners: (await updateSettings(ownerId, { jobOwners: next })).jobOwners };
  }
  if (!MOVABLE_JOBS[job].movable) {
    return { owners, error: MOVABLE_JOBS[job].blocked ?? "This one cannot be moved yet." };
  }
  // The target: another copy from the roster, or this one.
  let deviceId: string | null;
  let label: string;
  if (action === "assign") {
    const target = (await listInstalls(ownerId)).find((i) => i.id === opts.deviceId);
    if (!target) {
      return { owners, error: "That copy is not in the list any more. Pick one that is." };
    }
    deviceId = target.id;
    label = target.label;
  } else {
    deviceId = await readLocalDeviceId();
    label = installLabel();
    if (!deviceId) {
      return {
        owners,
        error:
          "This copy has no device identity yet, so it cannot take the job. It gets one the first time it syncs.",
      };
    }
  }
  const previous = owners[job] ?? null;
  const next: JobOwners = {
    ...owners,
    [job]: claimFor({ deviceId, label, now, previous }),
  };
  return { owners: (await updateSettings(ownerId, { jobOwners: next })).jobOwners };
}
