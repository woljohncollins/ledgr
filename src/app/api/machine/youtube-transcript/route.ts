// GET /api/machine/youtube-transcript — pulls the transcript of a saved YouTube
// video into that video's own saved link. The supervisor's scheduler calls this
// over loopback every ten minutes, through the same machine-token door as every
// other scheduled job (ADR-214), so there is no new auth path, no new state
// file, and a failure reports itself exactly the way a failing cron already
// does.
//
// The work itself is `runYoutubeTranscripts`, shared with the instant kick that
// fires the moment a video is saved (src/lib/item-mutations.ts), so the timer
// path and the save path cannot drift apart.
//
// A SKIPPED RUN IS A CLEAN 200, never a 500. Three things make this copy stand
// down without anything being wrong: the owner has the feature switched off,
// this machine has no yt-dlp installed, or a run is already going. The last one
// is ordinary on a ten-minute timer, since a Whisper run takes minutes. And a
// cloud deployment can never do this work at all — YouTube refuses data-center
// addresses, so the captions are as blocked as Whisper is — which means the
// cloud copy would post a red mark every ten minutes forever and drown the real
// failures in the errors list.
import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";
import { resolveMachineOwner } from "@/lib/machine/owner";
import { runYoutubeTranscripts } from "@/lib/youtube/transcripts";
import { captureError, createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("youtube-transcript");
  try {
    const ownerId = await resolveMachineOwner();
    if (!ownerId) throw new Error("no users row matches the machine owner UPN");
    // Before any work at all: only the machine named under Scheduled work does
    // this one. Two copies transcribing the same video would both write the
    // same transcript into the same body and then fight over whose write wins.
    const standDown = await standDownIfNotOwner("youtube-transcript", ownerId);
    if (standDown) return standDown;

    // Detached: this answers as soon as it knows the work has started, and the
    // transcripts carry on behind it. Waiting is not an option, because Node
    // destroys a request that has been open for five minutes and the scheduler
    // then records a failure for work that was going perfectly (seen on the
    // first real run, 2026-08-31, when Whisper fetched its 3.5GB model). The
    // results still reach the log and any failure still reaches error_log.
    const result = await runYoutubeTranscripts(ownerId, { detach: true });
    // Stamped even when the run skipped, because this machine did take its
    // turn. The liveness warning on Build exists to catch a job that has
    // quietly stopped happening, not to complain about a switch the owner
    // deliberately left off.
    await stampJobRun(ownerId, "youtube-transcript");
    if (result.skipped) {
      log.info("youtube transcripts skipped", { reason: result.skipped });
      return NextResponse.json({
        ok: true,
        skipped: result.skipped,
        correlationId: log.correlationId,
      });
    }
    log.info("youtube transcripts started", { correlationId: log.correlationId });
    return NextResponse.json({ ok: true, started: true, correlationId: log.correlationId });
  } catch (err) {
    // No silent failures: this lands in error_log, counts on /health, and the
    // supervisor's cron state records it too.
    await captureError("youtube-transcript", err, { correlationId: log.correlationId });
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
