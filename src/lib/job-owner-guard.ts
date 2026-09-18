// The two lines an exclusive job's route adds to honor ownership.
//
// Kept as one helper rather than copied six times, because the interesting part
// is the RESPONSE, not the check: a job that stood down did not fail, so it must
// answer 200. Returning 500 would put a red mark in the supervisor's cron state
// and in `error_log` every night on every machine that is not the owner, which
// is precisely the "no silent failures" rule inverted into noise.
import { NextResponse } from "next/server";
import { jobRunVerdict } from "@/lib/job-owners-store";
import { standDownDetail, type MovableJob } from "@/lib/job-owners";

/**
 * Returns a 200 "skipped" response when this install must NOT run the job, or
 * null when it should carry on.
 *
 * Call it AFTER auth (an unauthenticated caller learns nothing about topology)
 * and BEFORE any work. The owner id is needed because the slot lives in that
 * owner's settings.
 */
export async function standDownIfNotOwner(
  job: MovableJob,
  ownerId: string
): Promise<NextResponse | null> {
  const verdict = await jobRunVerdict(ownerId, job);
  if (verdict.run) return null;
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: verdict.reason,
    // Said plainly, because this response is what a person sees when they poke
    // the endpoint by hand wondering why nothing is exporting.
    detail: standDownDetail(verdict.reason, verdict.ownerLabel),
  });
}
