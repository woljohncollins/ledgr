// Meeting recording v1b verification (ADR-088): the audio→transcript
// orchestration against live Neon, with a FAKE provider injected (no live key —
// the graph-auth gated posture). Covers startAudioTranscription (transcript
// child + meeting edge + processing state + jobId; submit-failure → error
// state), advanceTranscription (processing no-op; completed fills the diarized
// body + minutes stays none so it enters the awaiting view; error records the
// message; terminal no-op), listPendingTranscriptions, and the guards.
// Run: npx tsx scripts/verify-transcription-flow.mts   Safe to delete later.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// Storage need not be real here — publicUrl() is pure string concat (no network),
// and the fake transcription provider ignores the URL. Dummy R2 vars just let
// getStorage() return a provider so the real code path (deriving the audio URL)
// runs. (Local dev often has no R2 configured.)
for (const [k, v] of Object.entries({
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || "test",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "test",
  R2_BUCKET: process.env.R2_BUCKET || "test-bucket",
  R2_ENDPOINT: process.env.R2_ENDPOINT || "https://example.r2.cloudflarestorage.com",
})) {
  process.env[k] = v;
}

const { getDb } = await import("../src/db");
const { items, attachments, relations, users } = await import("../src/db/schema");
const {
  startAudioTranscription,
  advanceTranscription,
  listPendingTranscriptions,
  isAudioOrVideo,
} = await import("../src/lib/meetings/transcription-service");
const { getItem, ItemError } = await import("../src/lib/items");
const { bodyMarkdown } = await import("../src/lib/body");
const { eq } = await import("drizzle-orm");
type TP = import("../src/lib/transcription/provider").TranscriptionProvider;
type TR = import("../src/lib/transcription/provider").TranscriptionResult;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
async function throws(name: string, fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    check(name, err instanceof ItemError && (!code || err.code === code), err instanceof ItemError ? err.code : String(err));
  }
}

// Fake providers: a happy one (submit ok, poll returns a script of results) and
// a submit-failing one.
const makeProvider = (poll: () => Promise<TR>): TP => ({
  id: "fake",
  async submit() {
    return { jobId: "job-123" };
  },
  poll: async (jobId: string) => ({ ...(await poll()), jobId }),
});
const failingProvider: TP = {
  id: "fake",
  async submit() {
    throw new Error("provider down");
  },
  async poll() {
    throw new Error("n/a");
  },
};

// --- isAudioOrVideo -------------------------------------------------------
check("isAudioOrVideo: audio/mp4", isAudioOrVideo("audio/mp4"));
check("isAudioOrVideo: video/webm", isAudioOrVideo("video/webm"));
check("isAudioOrVideo rejects image/png", !isAudioOrVideo("image/png"));

const db = getDb();
const [u] = await db
  .insert(users)
  .values({ email: `verify-trflow-${Date.now()}@example.invalid` })
  .returning({ id: users.id });
const ownerId = u.id;
const mk = async (v: Record<string, unknown>) =>
  (await db.insert(items).values({ ownerId, ...(v as object) } as typeof items.$inferInsert).returning({ id: items.id }))[0].id;

const meetingId = await mk({ type: "event", title: "Recorded meeting" });
const otherMeetingId = await mk({ type: "event", title: "Other meeting" });

const mkAttachment = async (parentId: string, contentType: string) =>
  (
    await db
      .insert(attachments)
      .values({
        ownerId,
        parentItemId: parentId,
        filename: "recording.m4a",
        contentType,
        sizeBytes: 1234,
        storageKey: `${ownerId}/x/recording.m4a`,
      })
      .returning({ id: attachments.id })
  )[0].id;

const audioAtt = await mkAttachment(meetingId, "audio/mp4");

// --- start: child + edge + processing + jobId -----------------------------
let processingResult: TR = { jobId: "job-123", status: "processing", text: null, segments: [], error: null };
const provider = makeProvider(async () => processingResult);
const { transcriptId } = await startAudioTranscription(ownerId, meetingId, audioAtt, provider);

const created = await getItem(ownerId, transcriptId);
check("transcript child created under the meeting", created.type === "transcript" && created.parentId === meetingId);
const st = (created.properties as Record<string, unknown>)?.transcription as Record<string, unknown>;
check("transcription state: processing + jobId + audioAttachmentId", st?.status === "processing" && st?.jobId === "job-123" && st?.audioAttachmentId === audioAtt, JSON.stringify(st));
check("minutes still none (becomes awaiting once transcribed)", (created.properties as Record<string, unknown>)?.minutes === "none");

const edge = await db
  .select({ role: relations.role, state: relations.matchState })
  .from(relations)
  .where(eq(relations.sourceId, meetingId));
check("meeting→transcript edge written (MCP-discoverable)", edge.some((e) => e.role === "transcript" && e.state === "confirmed"));

// --- advance: processing → no-op ------------------------------------------
let r = await advanceTranscription(ownerId, transcriptId, provider);
check("advance while processing → no change", r.status === "processing" && r.changed === false);

// --- advance: completed → body filled (diarized), still awaiting minutes ---
processingResult = {
  jobId: "job-123",
  status: "completed",
  text: "Hi there. Hello.",
  segments: [
    { speaker: "A", start: 0, end: 1000, text: "Hi there." },
    { speaker: "B", start: 1100, end: 2000, text: "Hello." },
  ],
  error: null,
};
r = await advanceTranscription(ownerId, transcriptId, provider);
check("advance completed → changed", r.status === "completed" && r.changed === true);
const done = await getItem(ownerId, transcriptId);
check(
  "body filled with diarized markdown",
  bodyMarkdown(done.body) === "**Speaker A:** Hi there.\n\n**Speaker B:** Hello.",
  JSON.stringify(bodyMarkdown(done.body))
);
const doneSt = (done.properties as Record<string, unknown>)?.transcription as Record<string, unknown>;
check("transcription state completed", doneSt?.status === "completed");
check("minutes none → enters the awaiting-minutes view", (done.properties as Record<string, unknown>)?.minutes === "none");

// --- advance on terminal → no-op ------------------------------------------
r = await advanceTranscription(ownerId, transcriptId, provider);
check("advance on completed → no-op", r.status === "completed" && r.changed === false);

// --- submit failure → error state -----------------------------------------
const audioAtt2 = await mkAttachment(meetingId, "audio/mpeg");
const { transcriptId: t2 } = await startAudioTranscription(ownerId, meetingId, audioAtt2, failingProvider);
const errItem = await getItem(ownerId, t2);
const errSt = (errItem.properties as Record<string, unknown>)?.transcription as Record<string, unknown>;
check("submit failure → error state with message", errSt?.status === "error" && typeof errSt?.error === "string", JSON.stringify(errSt));

// --- listPendingTranscriptions: only running jobs -------------------------
const audioAtt3 = await mkAttachment(meetingId, "audio/wav");
await startAudioTranscription(ownerId, meetingId, audioAtt3, provider); // poll returns completed now, but state starts processing
const pending = await listPendingTranscriptions(ownerId);
check("pending excludes completed + errored", !pending.includes(transcriptId) && !pending.includes(t2), JSON.stringify(pending));
check("pending includes a freshly-started job", pending.length >= 1);

// --- guards ---------------------------------------------------------------
await throws("no provider → bad_request", () => startAudioTranscription(ownerId, meetingId, audioAtt, null), "bad_request");
const wrongAtt = await mkAttachment(otherMeetingId, "audio/mp4");
await throws("attachment on a different meeting → bad_request", () => startAudioTranscription(ownerId, meetingId, wrongAtt, provider), "bad_request");
const imgAtt = await mkAttachment(meetingId, "image/png");
await throws("non-audio attachment → bad_request", () => startAudioTranscription(ownerId, meetingId, imgAtt, provider), "bad_request");
await throws("missing attachment → not_found", () => startAudioTranscription(ownerId, meetingId, crypto.randomUUID(), provider), "not_found");

// --- cleanup --------------------------------------------------------------
await db.delete(relations).where(eq(relations.sourceId, meetingId));
await db.delete(attachments).where(eq(attachments.ownerId, ownerId));
await db.delete(items).where(eq(items.ownerId, ownerId));
await db.delete(users).where(eq(users.id, ownerId));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
