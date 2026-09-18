// Meeting recording v1b verification (ADR-089): audio retention against live
// Neon, with a spy storage (records deleteObject; no R2). Covers
// markAudioForPurge (stamps purge_after ~N days out), purgeExpiredAudio (past →
// bytes deleted + row gone; future/null → kept), deleteAttachment (row + bytes,
// not_found guard), and the tie-in: a completed transcription stamps its audio
// for purge (via advanceTranscription with a fake provider).
// Run: npx tsx scripts/verify-audio-retention.mts   Safe to delete later.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
// Dummy R2 vars so getStorage() is configured for the transcription-start path
// (presignDownload signs locally, no network). The spy is used for delete/purge.
for (const [k, v] of Object.entries({
  R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_BUCKET: "b",
  R2_ENDPOINT: "https://x.r2.cloudflarestorage.com", R2_PUBLIC_BASE_URL: "https://cdn.example.com",
})) {
  if (!process.env[k]) process.env[k] = v;
}

const { getDb } = await import("../src/db");
const { items, attachments, relations, users } = await import("../src/db/schema");
const { markAudioForPurge, purgeExpiredAudio, deleteAttachment, AUDIO_RETENTION_DAYS } = await import("../src/lib/attachments");
const { startAudioTranscription, advanceTranscription } = await import("../src/lib/meetings/transcription-service");
const { ItemError } = await import("../src/lib/items");
const { eq } = await import("drizzle-orm");
type SP = import("../src/lib/storage").StorageProvider;
type TP = import("../src/lib/transcription/provider").TranscriptionProvider;

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

const deleted: string[] = [];
const spy: SP = {
  async presignUpload() { throw new Error("unused"); },
  async putObject() { throw new Error("unused"); },
  async listObjects() { throw new Error("unused"); },
  async presignDownload(k) { return `https://signed.example.invalid/${k}`; },
  async deleteObject(k) { deleted.push(k); },
};

const db = getDb();
const [u] = await db.insert(users).values({ email: `verify-retention-${Date.now()}@example.invalid` }).returning({ id: users.id });
const [u2] = await db.insert(users).values({ email: `verify-retention-other-${Date.now()}@example.invalid` }).returning({ id: users.id });
const ownerId = u.id;
const meetingId = (await db.insert(items).values({ ownerId, type: "event", title: "M" }).returning({ id: items.id }))[0].id;

const mkAtt = async (owner: string, key: string, purgeAfter: Date | null) =>
  (
    await db
      .insert(attachments)
      .values({ ownerId: owner, parentItemId: meetingId, filename: "a.m4a", contentType: "audio/mp4", sizeBytes: 1, storageKey: key, purgeAfter })
      .returning({ id: attachments.id })
  )[0].id;

// --- markAudioForPurge stamps a future window -----------------------------
const a1 = await mkAtt(ownerId, "k/keep-then-mark", null);
await markAudioForPurge(ownerId, a1);
const a1row = (await db.select({ p: attachments.purgeAfter }).from(attachments).where(eq(attachments.id, a1)))[0];
const days = a1row.p ? (a1row.p.getTime() - Date.now()) / 86_400_000 : -1;
check(`markAudioForPurge stamps ~${AUDIO_RETENTION_DAYS}d out`, days > AUDIO_RETENTION_DAYS - 1 && days < AUDIO_RETENTION_DAYS + 1, `${days.toFixed(1)}d`);

// --- purgeExpiredAudio: past purged, future/null kept ---------------------
await mkAtt(ownerId, "k/past", new Date(Date.now() - 86_400_000));
const future = await mkAtt(ownerId, "k/future", new Date(Date.now() + 86_400_000));
await mkAtt(ownerId, "k/never", null);
const res = await purgeExpiredAudio(spy);
check("purge removed the past-due attachment only", res.purgedAudio === 1 && res.failed === 0, JSON.stringify(res));
check("purge deleted the past object's bytes", deleted.includes("k/past"));
const remaining = (await db.select({ id: attachments.id, key: attachments.storageKey }).from(attachments).where(eq(attachments.ownerId, ownerId))).map((r) => r.key);
check("past row gone; future + null kept", !remaining.includes("k/past") && remaining.includes("k/future") && remaining.includes("k/never") && remaining.includes("k/keep-then-mark"), JSON.stringify(remaining));

// --- deleteAttachment (delete-now) ----------------------------------------
deleted.length = 0;
await deleteAttachment(ownerId, future, spy);
check("deleteAttachment removed the row", (await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, future))).length === 0);
check("deleteAttachment deleted the bytes", deleted.includes("k/future"));
await throws("deleteAttachment missing → not_found", () => deleteAttachment(ownerId, crypto.randomUUID(), spy), "not_found");
const otherAtt = await mkAtt(u2.id, "k/other", null);
await throws("deleteAttachment cross-owner → not_found", () => deleteAttachment(ownerId, otherAtt, spy), "not_found");

// --- tie-in: completed transcription stamps its audio for purge -----------
const audioAtt = await mkAtt(ownerId, "k/transcribe-me", null);
const completedProvider: TP = {
  id: "fake",
  async submit() { return { jobId: "j" }; },
  async poll(jobId: string) {
    return { jobId, status: "completed", text: "Hi.", segments: [{ speaker: "A", start: 0, end: 1, text: "Hi." }], error: null };
  },
};
const { transcriptId } = await startAudioTranscription(ownerId, meetingId, audioAtt, completedProvider);
const before = (await db.select({ p: attachments.purgeAfter }).from(attachments).where(eq(attachments.id, audioAtt)))[0];
check("audio not yet stamped before completion", before.p === null);
await advanceTranscription(ownerId, transcriptId, completedProvider);
const after = (await db.select({ p: attachments.purgeAfter }).from(attachments).where(eq(attachments.id, audioAtt)))[0];
check("completed transcription stamps the audio for purge", after.p != null && after.p.getTime() > Date.now());

// --- cleanup --------------------------------------------------------------
await db.delete(relations).where(eq(relations.sourceId, meetingId));
await db.delete(attachments).where(eq(attachments.ownerId, ownerId));
await db.delete(attachments).where(eq(attachments.ownerId, u2.id));
await db.delete(items).where(eq(items.ownerId, ownerId));
await db.delete(users).where(eq(users.id, ownerId));
await db.delete(users).where(eq(users.id, u2.id));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
