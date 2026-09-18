// Slice 17 verification: exercises the export engine (src/lib/export)
// against the live Neon DB with the local-filesystem target, under a
// throwaway user so no real item ever gets its exported_at stamped by a
// test run. Run with: npx tsx scripts/verify-export.mts
// Safe to delete once the slice is closed.
import { readFileSync, rmSync, existsSync } from "node:fs";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
// Force the no-storage path for the main run: attachment byte copies are
// exercised in the configured end-to-end run (runbook §1b). Saved first so the
// 404-skip section below can re-enable storage and exercise a real fetch miss.
const r2Creds = {
  id: process.env.R2_ACCESS_KEY_ID,
  secret: process.env.R2_SECRET_ACCESS_KEY,
};
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;

const { getDb } = await import("../src/db");
const { attachments, items, jobState, relations, users } = await import(
  "../src/db/schema"
);
const { EXPORT_JOB_KEY, getExportState, runExport } = await import(
  "../src/lib/export/engine"
);
const { LocalExportTarget } = await import("../src/lib/export/local");
const { makeMarkdownBody } = await import("../src/lib/body");
const { and, eq, isNotNull, ne, sql } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const exportDir = await mkdtemp(join(tmpdir(), "ledgr-export-"));
const target = new LocalExportTarget(exportDir);
const onDisk = (path: string) => existsSync(join(exportDir, ...path.split("/")));

// Throwaway owner; everything hangs off it and hard-deletes at the end.
const [tempUser] = await db
  .insert(users)
  .values({ email: `verify-export-${Date.now()}@example.invalid` })
  .returning({ id: users.id });
const ownerId = tempUser.id;

// Local env points at the prod DB, and runExport writes the shared
// onedrive_export job_state row. Snapshot it now and restore it in finally so
// a verify run never clobbers production's last-clean canary.
const priorJobState =
  (await db.select({ value: jobState.value }).from(jobState).where(eq(jobState.key, EXPORT_JOB_KEY)))[0]?.value ?? null;

// Snapshot: no other owner's stamps may change during this run.
const stampedElsewhere = async () =>
  (
    await db
      .select({ count: sql<number>`count(*)::int` })
      .from(items)
      .where(and(ne(items.ownerId, ownerId), isNotNull(items.exportedAt)))
  )[0].count;
const stampedBefore = await stampedElsewhere();

try {
  // --- fixtures -----------------------------------------------------------
  const mkItem = async (input: Record<string, unknown>) =>
    (
      await db
        .insert(items)
        .values({ ownerId, ...(input as object) } as typeof items.$inferInsert)
        .returning()
    )[0];

  const body = makeMarkdownBody("Sermon outline body text");
  const task = await mkItem({
    type: "task",
    title: `Émile's Notes / Q1 — "draft"?`,
    body,
    dueDate: new Date("2026-06-19T00:00:00Z"),
  });
  const entity = await mkItem({ type: "person", title: "Verify Person" });
  const distractor = await mkItem({ type: "person", title: "Suggested Person" });
  const untitled = await mkItem({ type: "note", title: "" });
  await db.insert(relations).values([
    { sourceId: task.id, targetId: entity.id, role: "related", matchState: "confirmed" },
    { sourceId: distractor.id, targetId: task.id, role: "related", matchState: "suggested" },
  ]);
  await db.insert(attachments).values({
    ownerId,
    parentItemId: task.id,
    filename: "chart.png",
    contentType: "image/png",
    sizeBytes: 123,
    storageKey: "nonexistent/chart.png",
  });
  // Created and trashed before any export: must never be selected.
  const ghost = await mkItem({ type: "note", title: "Ghost note" });
  await db
    .update(items)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(items.id, ghost.id));

  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.LEDGR_TIMEZONE || "America/New_York",
    year: "numeric",
  }).format(new Date());
  const id8 = (id: string) => id.slice(0, 8);

  // --- first run ----------------------------------------------------------
  const run1 = await runExport(ownerId, target, {
    onError: (id, err) => console.error("item error", id, err),
  });
  check("run 1 exports the four live fixtures", run1.exported === 4, JSON.stringify(run1));
  check("run 1 clean (no errors, none remaining)", run1.errors === 0 && run1.remaining === 0);
  check("ghost (created+trashed, never exported) skipped",
    (await db.select().from(items).where(eq(items.id, ghost.id)))[0].exportedAt === null);

  const taskPath = `task/${year}/emile-s-notes-q1-draft-${id8(task.id)}.md`;
  check("slug strips diacritics, punctuation, quotes", onDisk(taskPath), taskPath);
  check("empty title slugs to untitled",
    onDisk(`note/${year}/untitled-${id8(untitled.id)}.md`));

  const md = await readFile(join(exportDir, ...taskPath.split("/")), "utf8");
  check("frontmatter carries id/type/status", md.includes(`id: "${task.id}"`) && md.includes(`type: "task"`) && md.includes(`status: "open"`));
  check("title is JSON-escaped YAML", md.includes(`title: ${JSON.stringify(task.title)}`));
  check("due date present", md.includes(`due: "2026-06-19T00:00:00.000Z"`));
  check("confirmed person listed, suggested excluded",
    md.includes(`people: ["Verify Person"]`) && !md.includes("Suggested Person"));
  // With no storage the bytes aren't copied, so the path is omitted: the
  // frontmatter never references a file absent from the export tree (the
  // copied-and-listed case is covered by the configured e2e run, runbook §1b).
  check("uncopied attachment path omitted (no storage)",
    !md.includes(`_attachments/${task.id}/`) && !md.includes("chart.png"));
  check("markdown body serialized", md.includes("Sermon outline body text"));
  check("attachment bytes skipped without storage (stamp stays null)",
    (await db.select().from(attachments).where(eq(attachments.parentItemId, task.id)))[0].exportedAt === null);

  // --- idempotence --------------------------------------------------------
  const run2 = await runExport(ownerId, target);
  check("run 2 is a no-op", run2.exported === 0 && run2.remaining === 0, JSON.stringify(run2));

  // --- run budget stops cleanly instead of overrunning the lambda ---------
  // An attachment-heavy stretch used to blow the 60s ceiling, and a killed run
  // records nothing, so `remaining` froze and every caller 504'd (2026-08-14).
  // A negative budget puts the deadline in the past, so the guard trips before
  // the first item: deterministic, no sleeping.
  await db
    .update(items)
    .set({ updatedAt: new Date() })
    .where(eq(items.ownerId, ownerId));
  const pending = (await runExport(ownerId, target, { budgetMs: -1 }));
  check("budget-stopped run exports nothing and reports what's left",
    pending.exported === 0 && pending.remaining > 0, JSON.stringify(pending));
  check("budget-stopped run is not an error path", pending.errors === 0);
  const budgetState = await getExportState();
  check("budget-stopped run records the attempt but not a clean success",
    !!budgetState && budgetState.lastResult.remaining > 0,
    JSON.stringify(budgetState?.lastResult));
  // Drain it back so the later assertions start from an exported baseline.
  await runExport(ownerId, target);

  // --- rename relocates ---------------------------------------------------
  await db.update(items).set({ title: "Renamed task", updatedAt: new Date() }).where(eq(items.id, task.id));
  const run3 = await runExport(ownerId, target);
  const renamedPath = `task/${year}/renamed-task-${id8(task.id)}.md`;
  check("rename re-exports exactly one", run3.exported === 1);
  check("new path written, old path deleted", onDisk(renamedPath) && !onDisk(taskPath));

  // --- soft delete -> _archive, restore -> back ---------------------------
  await db.update(items).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(items.id, task.id));
  const run4 = await runExport(ownerId, target);
  const archivePath = `_archive/${renamedPath}`;
  check("trashed item moves to _archive", run4.archived === 1 && onDisk(archivePath) && !onDisk(renamedPath));
  check("frontmatter records deleted: true", (await readFile(join(exportDir, ...archivePath.split("/")), "utf8")).includes("deleted: true"));

  await db.update(items).set({ deletedAt: null, updatedAt: new Date() }).where(eq(items.id, task.id));
  const run5 = await runExport(ownerId, target);
  check("restore moves it back out of _archive", run5.exported === 1 && onDisk(renamedPath) && !onDisk(archivePath));

  // --- archived status also lands in _archive -----------------------------
  // The engine routes to _archive on statusCategory (not the display status),
  // so the fixture must move both.
  await db.update(items).set({ status: "archived", statusCategory: "archived", updatedAt: new Date() }).where(eq(items.id, task.id));
  await runExport(ownerId, target);
  check("status archived lands in _archive too", onDisk(archivePath) && !onDisk(renamedPath));

  // --- a missing attachment is skipped, not fatal -------------------------
  // A 404/unreadable object must not block the item's body from exporting
  // (Sunday-proof: the markdown is the fallback, an image is not). It's
  // surfaced via attachmentsFailed + onAttachmentError, never silent.
  if (r2Creds.id && r2Creds.secret) {
    process.env.R2_ACCESS_KEY_ID = r2Creds.id;
    process.env.R2_SECRET_ACCESS_KEY = r2Creds.secret;
    const orphan = await mkItem({
      type: "note",
      title: "Orphan attachment note",
      body: makeMarkdownBody("body survives a missing image"),
    });
    await db.insert(attachments).values({
      ownerId,
      parentItemId: orphan.id,
      filename: "missing.png",
      contentType: "image/png",
      sizeBytes: 1,
      storageKey: `${ownerId}/does-not-exist/missing.png`,
    });
    let failedSeen: { storageKey: string; status: number }[] = [];
    const runMiss = await runExport(ownerId, target, {
      onAttachmentError: (_id, f) => {
        failedSeen = f;
      },
    });
    const orphanPath = `note/${year}/orphan-attachment-note-${id8(orphan.id)}.md`;
    check("missing attachment does not error the item", runMiss.errors === 0, JSON.stringify(runMiss));
    check("missing attachment counted as failed and surfaced",
      runMiss.attachmentsFailed === 1 && failedSeen.length === 1);
    check("item body still exported despite the missing attachment", onDisk(orphanPath));
    const omd = await readFile(join(exportDir, ...orphanPath.split("/")), "utf8");
    check("body present, no dangling attachment path in frontmatter",
      omd.includes("body survives a missing image") && !omd.includes("missing.png"));
    check("orphan item stamped exported; attachment stamp stays null",
      (await db.select().from(items).where(eq(items.id, orphan.id)))[0].exportedAt !== null &&
        (await db.select().from(attachments).where(eq(attachments.parentItemId, orphan.id)))[0].exportedAt === null);

    // The upload leg gets the same guarantee as the read leg above. A Graph
    // failure writing the image (409s were observed on attachment paths,
    // 2026-08-14) used to escape exportAttachments into the item's catch, so
    // the item errored and its markdown never reached OneDrive — and since
    // nothing about the item changed, it failed again every single run.
    // Imported here, not at the top: getStorage reads the R2 creds this block
    // just put on process.env.
    const { getStorage } = await import("../src/lib/storage");
    const storage = getStorage()!;
    const liveKey = `${ownerId}/verify-upload-fail/live.png`;
    await storage.putObject(liveKey, new Uint8Array([1, 2, 3, 4]), "image/png");
    const upFail = await mkItem({
      type: "note",
      title: "Upload fail note",
      body: makeMarkdownBody("body survives a failing image upload"),
    });
    await db.insert(attachments).values({
      ownerId,
      parentItemId: upFail.id,
      filename: "live.png",
      contentType: "image/png",
      sizeBytes: 4,
      storageKey: liveKey,
    });
    // Reject only the attachment write, so the .md write still has to succeed.
    // Delegates explicitly rather than spreading `target`: it's a class
    // instance, so a spread would drop its prototype methods.
    const flakyTarget = {
      putFile: async (p: string, c: Uint8Array | string) => {
        if (p.startsWith("_attachments/")) throw new Error("Graph upload failed (409)");
        return target.putFile(p, c);
      },
      deleteFile: (p: string) => target.deleteFile(p),
    };
    let upFailSeen: { storageKey: string; status: number }[] = [];
    const runUp = await runExport(ownerId, flakyTarget, {
      onAttachmentError: (_id, f) => {
        upFailSeen = f;
      },
    });
    const upPath = `note/${year}/upload-fail-note-${id8(upFail.id)}.md`;
    check("failed attachment upload does not error the item", runUp.errors === 0, JSON.stringify(runUp));
    check("failed upload counted as failed and surfaced",
      runUp.attachmentsFailed === 1 && upFailSeen.length === 1);
    check("item body still exported despite the failed upload", onDisk(upPath));
    check("upload-failed item is stamped, attachment stamp stays null (retried later)",
      (await db.select().from(items).where(eq(items.id, upFail.id)))[0].exportedAt !== null &&
        (await db.select().from(attachments).where(eq(attachments.parentItemId, upFail.id)))[0].exportedAt === null);
    await storage.deleteObject(liveKey);
  } else {
    check("R2 creds available to test 404-skip (no creds: section skipped)", true);
  }

  // --- LT3: live tokens are baked into the exported .md -------------------
  // An exported .md is a derived output, so {{item.*}} tokens resolve to the
  // item's current values (the DB keeps the tokens); unknown tokens pass through.
  const tokNote = await mkItem({
    type: "note",
    title: "Token export note",
    body: makeMarkdownBody("Heading is {{item.title}} — unknown {{item.bogus}} stays."),
  });
  await runExport(ownerId, target);
  const tokPath = `note/${year}/token-export-note-${id8(tokNote.id)}.md`;
  check("token item exported", onDisk(tokPath));
  const tokMd = await readFile(join(exportDir, ...tokPath.split("/")), "utf8");
  check(
    "exported .md bakes {{item.title}}, leaves unknown tokens",
    tokMd.includes("Heading is Token export note — unknown {{item.bogus}} stays.")
  );

  // --- job state + /health source ----------------------------------------
  const state = await getExportState();
  check("job_state records a clean run",
    !!state && state.lastSuccessAt !== null && state.lastRunAt >= state.lastSuccessAt!,
    JSON.stringify(state));

  // --- owner scoping -------------------------------------------------------
  check("no other owner's items were stamped", (await stampedElsewhere()) === stampedBefore);
} finally {
  // Hard-delete fixtures (relations/attachments cascade), then the user.
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
  // Restore (not delete) the shared onedrive_export canary: this DB is also
  // production's, so the verify run must leave /health's last-clean intact.
  if (priorJobState !== null) {
    await db
      .insert(jobState)
      .values({ key: EXPORT_JOB_KEY, value: priorJobState })
      .onConflictDoUpdate({ target: jobState.key, set: { value: priorJobState } });
  } else {
    await db.delete(jobState).where(eq(jobState.key, EXPORT_JOB_KEY));
  }
  rmSync(exportDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
