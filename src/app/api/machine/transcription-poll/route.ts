// GET /api/machine/transcription-poll — the cron backstop for transcription
// (meeting recording v1b, ADR-088). Advances every transcript with a still-
// running job, so a transcription finishes even if the user uploaded and
// navigated away (the client-poll path only runs while the panel is open).
// Sub-daily, so it comes from GitHub Actions hitting this endpoint with the
// cron-scoped machine token — the same door as calendar/email/notify sync.
// Deterministic plumbing (Principle 3): it only polls the speech-to-text
// service and fills bodies; no model in the loop.
import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { standDownIfNotOwner } from "@/lib/job-owner-guard";
import { stampJobRun } from "@/lib/job-owners-store";
import { resolveMachineOwner } from "@/lib/machine/owner";
import {
  advanceTranscription,
  listPendingTranscriptions,
} from "@/lib/meetings/transcription-service";
import { getTranscription } from "@/lib/transcription/provider";
import { captureError, createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"), "cron");
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const log = createLogger("transcription-poll");
  // Not configured → nothing to do (the paste path needs no transcription).
  if (!getTranscription()) {
    return NextResponse.json({ ok: true, skipped: true, adapter: "none" });
  }

  try {
    const ownerId = await resolveMachineOwner();
    if (!ownerId) throw new Error("no users row matches the machine owner UPN");
    const standDown = await standDownIfNotOwner("transcription-poll", ownerId);
    if (standDown) return standDown;
    const pending = await listPendingTranscriptions(ownerId);
    let completed = 0;
    let errored = 0;
    for (const id of pending) {
      const { status, changed } = await advanceTranscription(ownerId, id);
      if (changed && status === "completed") completed += 1;
      if (changed && status === "error") errored += 1;
    }
    log.info("transcription poll finished", { pending: pending.length, completed, errored });
    await stampJobRun(ownerId, "transcription-poll");
    return NextResponse.json({
      ok: true,
      correlationId: log.correlationId,
      pending: pending.length,
      completed,
      errored,
    });
  } catch (err) {
    await captureError("transcription-poll", err, { correlationId: log.correlationId });
    return NextResponse.json({ ok: false, correlationId: log.correlationId }, { status: 500 });
  }
}
