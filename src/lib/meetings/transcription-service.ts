// Audio → transcript orchestration (meeting recording v1b, ADR-088). Deterministic
// plumbing over the transcription seam: on audio upload, create the transcript
// child and submit the audio's URL for transcription; then a poll (client status
// check while on the page, or the cron backstop) advances the job and fills the
// transcript body when it completes. No model in Ledgr's loop — the adapter is a
// speech-to-text service (Principle 3); the minutes step stays in the
// Claude-over-MCP layer (ADR-087).
//
// The provider is injected (defaulting to getTranscription()) so the orchestration
// is node-testable with a fake provider, no live key (the graph-auth posture).
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attachments, items } from "@/db/schema";
import { markAudioForPurge } from "@/lib/attachments";
import { makeMarkdownBody } from "@/lib/body";
import { ItemError, getItem } from "@/lib/items";
import { updateItem } from "@/lib/item-mutations";
import { getStorage } from "@/lib/storage";
import {
  getTranscription,
  transcriptToMarkdown,
  type TranscriptionProvider,
  type TranscriptionStatus,
} from "@/lib/transcription/provider";
import { createTranscript } from "./transcripts";

// Per-transcript transcription state, stored at properties.transcription. Written
// whole each time (propertyPatch shallow-merges the top-level `transcription` key).
export type TranscriptionState = {
  jobId?: string;
  status: TranscriptionStatus;
  adapter?: string;
  audioAttachmentId?: string;
  error?: string | null;
};

export function readTranscriptionState(properties: unknown): TranscriptionState | null {
  const t = (properties as Record<string, unknown> | null)?.transcription;
  if (!t || typeof t !== "object") return null;
  const s = (t as Record<string, unknown>).status;
  if (s !== "queued" && s !== "processing" && s !== "completed" && s !== "error") return null;
  return t as TranscriptionState;
}

export function isAudioOrVideo(contentType: string): boolean {
  return /^(audio|video)\//i.test(contentType);
}

// Strip a file extension for a readable transcript title.
function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]{1,8}$/i, "").trim();
  return base || "Audio transcript";
}

// Start transcription from an already-uploaded audio attachment on a meeting:
// create the transcript child (visible immediately as "Transcribing…"), submit
// the audio URL, store the job id. A submit failure marks the transcript errored
// rather than throwing, so the panel shows the failure instead of a dead end.
export async function startAudioTranscription(
  ownerId: string,
  meetingId: string,
  attachmentId: string,
  provider: TranscriptionProvider | null = getTranscription()
): Promise<{ transcriptId: string }> {
  if (!provider) {
    throw new ItemError("bad_request", "transcription is not configured");
  }
  const storage = getStorage();
  if (!storage) throw new ItemError("bad_request", "file storage is not configured");

  const rows = await getDb()
    .select({
      id: attachments.id,
      parentItemId: attachments.parentItemId,
      contentType: attachments.contentType,
      storageKey: attachments.storageKey,
      filename: attachments.filename,
    })
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.ownerId, ownerId)));
  const att = rows[0];
  if (!att) throw new ItemError("not_found", "attachment not found");
  if (att.parentItemId !== meetingId) {
    throw new ItemError("bad_request", "attachment is not on this meeting");
  }
  if (!isAudioOrVideo(att.contentType)) {
    throw new ItemError("bad_request", "attachment is not audio or video");
  }

  // createTranscript validates the parent is the owner's live meeting + writes
  // the meeting→transcript edge (so it's MCP-discoverable like a pasted one).
  const transcript = await createTranscript(ownerId, meetingId, {
    title: titleFromFilename(att.filename),
    text: "",
  });

  const base: TranscriptionState = {
    status: "processing",
    adapter: provider.id,
    audioAttachmentId: attachmentId,
  };
  await updateItem(ownerId, transcript.id, { propertyPatch: { transcription: base } });

  try {
    // A signed URL: the vendor has no Ledgr session and pulls the audio off its
    // own queue, so it needs a self-authenticating URL that outlives the call.
    const { jobId } = await provider.submit(
      await storage.presignDownload(att.storageKey),
      { diarize: true }
    );
    await updateItem(ownerId, transcript.id, {
      propertyPatch: { transcription: { ...base, jobId } },
    });
  } catch (err) {
    await updateItem(ownerId, transcript.id, {
      propertyPatch: {
        transcription: { ...base, status: "error", error: err instanceof Error ? err.message : "submit failed" },
      },
    });
  }

  return { transcriptId: transcript.id };
}

// Poll a transcript's transcription job once and apply the result: fill the body
// (diarized markdown) on completion, record the error on failure, no-op while
// queued/processing or once terminal. Idempotent and deterministic — safe for
// both the client status poll and the cron backstop.
export async function advanceTranscription(
  ownerId: string,
  transcriptId: string,
  provider: TranscriptionProvider | null = getTranscription()
): Promise<{ status: TranscriptionStatus | "none"; changed: boolean }> {
  const item = await getItem(ownerId, transcriptId);
  const state = readTranscriptionState(item.properties);
  if (!state) return { status: "none", changed: false };
  if (state.status === "completed" || state.status === "error") {
    return { status: state.status, changed: false };
  }
  if (!provider || !state.jobId) return { status: state.status, changed: false };

  const result = await provider.poll(state.jobId);
  if (result.status === "completed") {
    const md = transcriptToMarkdown(result) || "_(no speech detected)_";
    await updateItem(ownerId, transcriptId, {
      body: makeMarkdownBody(md),
      propertyPatch: { transcription: { ...state, status: "completed", error: null } },
    });
    // The transcript now exists — the audio has done its job. Start the
    // retention countdown (ADR-089); the daily purge reclaims the bytes.
    if (state.audioAttachmentId) {
      await markAudioForPurge(ownerId, state.audioAttachmentId);
    }
    return { status: "completed", changed: true };
  }
  if (result.status === "error") {
    await updateItem(ownerId, transcriptId, {
      propertyPatch: { transcription: { ...state, status: "error", error: result.error } },
    });
    return { status: "error", changed: true };
  }
  return { status: result.status, changed: false };
}

// Transcript ids with a still-running job — the cron backstop's work list. The
// pending set is tiny, so the JSON path predicate (not index-backed) is fine.
export async function listPendingTranscriptions(ownerId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, "transcript"),
        isNull(items.deletedAt),
        sql`${items.properties} -> 'transcription' ->> 'status' in ('queued','processing')`
      )
    );
  return rows.map((r) => r.id);
}
