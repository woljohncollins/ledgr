// Email-in verification: the pure link-don't-copy footer (html.ts) plus the
// import engine against Neon with a stub MailSource under a throwaway owner.
// Covers note/task routing, HTML->text body conversion, inbox:true arrival,
// the link-don't-copy footer (sender + open-in-Outlook link + attachment
// names/sizes, no R2), internetMessageId dedup (no double-import, stable across
// the move), delta-token persistence, and "an errored run does not advance the
// delta token". Run:
//   npx tsx scripts/verify-email-in.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- Part A: pure footer (link-don't-copy) ----------------------------------
const { emailFooterMarkdown } = await import("../src/lib/email/html");
{
  const full = emailFooterMarkdown({
    fromName: "Lesleigh Carmichael",
    fromEmail: "lesleigh@example.org",
    internetMessageId: "<abc@mail.gmail.com>",
    attachments: [{ name: "Proposal.pdf", contentType: "application/pdf", size: 1024 }],
  });
  check("footer shows the sender", full.includes("**From:** Lesleigh Carmichael (lesleigh@example.org)"), full);
  check("footer links to the open-in-Outlook redirect with the encoded mid",
    full.includes("/api/email/open?mid=") && full.includes(encodeURIComponent("<abc@mail.gmail.com>")));
  check("footer lists the attachment name + human size", full.includes("- Proposal.pdf (1 KB)"), full);
  check("footer never embeds bytes or an R2 url", !/r2|cloudflarestorage|base64/i.test(full));

  const senderOnly = emailFooterMarkdown({ fromName: "Bob", fromEmail: null, internetMessageId: null, attachments: [] });
  check("sender-only footer: From but no link, no Attachments heading",
    senderOnly.includes("**From:** Bob") && !senderOnly.includes("Open original") && !senderOnly.includes("Attachments"));

  check("empty footer (nothing to show) is the empty string",
    emailFooterMarkdown({ fromName: null, fromEmail: null, internetMessageId: null, attachments: [] }) === "");
}

const { getDb } = await import("../src/db");
const { items, jobState, users } = await import("../src/db/schema");
const { runEmailImport, getEmailState, EMAIL_JOB_KEY } = await import("../src/lib/email/sync");
type MailSource = import("../src/lib/email/types").MailSource;
type NormalizedMessage = import("../src/lib/email/types").NormalizedMessage;
const { and, eq, sql } = await import("drizzle-orm");

const db = getDb();

function msg(over: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: over.id,
    // Derive a stable internetMessageId from the id so the dedup guard keys on
    // it (the real stable handle), mirroring production.
    internetMessageId: over.internetMessageId ?? `<${over.id}@test>`,
    subject: over.subject ?? "",
    fromName: over.fromName ?? "Sender",
    fromEmail: over.fromEmail ?? "sender@example.invalid",
    receivedAt: over.receivedAt ?? "2026-06-13T12:00:00Z",
    bodyHtml: over.bodyHtml ?? null,
    bodyText: over.bodyText ?? null,
    attachments: over.attachments ?? [],
  };
}

class FakeMail implements MailSource {
  received: (string | null)[] = [];
  moved: string[] = [];
  throwMoveFor = new Set<string>();
  next: { messages: NormalizedMessage[]; nextDeltaToken: string | null } = { messages: [], nextDeltaToken: null };
  async listNewMessages(token: string | null) {
    this.received.push(token);
    return this.next;
  }
  async markImported(id: string) {
    if (this.throwMoveFor.has(id)) throw new Error("move failed");
    this.moved.push(id);
  }
}

const [tempUser] = await db.insert(users).values({ email: `verify-email-${Date.now()}@example.invalid` }).returning({ id: users.id });
const ownerId = tempUser.id;

const findByMessageId = async (messageId: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.ownerId, ownerId), sql`properties @> ${JSON.stringify({ email: { messageId } })}::jsonb`))
  )[0];

const fake = new FakeMail();

// job_state uses a single global key shared with the real email-import job.
// Snapshot and clear it so this run starts from a null token AND doesn't
// clobber production's delta token; restore it in finally.
const savedJob = (await db.select().from(jobState).where(eq(jobState.key, EMAIL_JOB_KEY)))[0];
await db.delete(jobState).where(eq(jobState.key, EMAIL_JOB_KEY));

try {
  // --- Run 1: import note, task, html, attachment-bearing -----------------
  fake.next = {
    messages: [
      msg({ id: "m1", subject: "Hello there", bodyText: "Line one\n\nLine two" }),
      msg({ id: "m2", subject: "task:  Follow up with Roger", bodyText: "do it" }),
      msg({ id: "m3", subject: "Formatted", bodyHtml: "<p>Hi <b>there</b></p><p>bye</p>" }),
      msg({ id: "m4", subject: "Has a file", bodyText: "see attached", attachments: [{ name: "doc.pdf", contentType: "application/pdf", size: 10 }] }),
    ],
    nextDeltaToken: "delta-1",
  };
  const r1 = await runEmailImport(ownerId, fake);
  check("run 1 imports all four messages", r1.imported === 4 && r1.errors === 0, JSON.stringify(r1));
  check("run 1 routes 1 task + 3 notes", r1.tasks === 1 && r1.notes === 3);
  check("run 1 counts the one linked attachment", r1.attachments === 1, JSON.stringify(r1));
  check("run 1 starts from a null delta token", fake.received[0] === null);
  check("all four messages were marked imported (moved)", fake.moved.length === 4);

  const n1 = await findByMessageId("m1");
  check("plain message becomes a note, inbox:true", n1?.type === "note" && n1?.title === "Hello there" && n1?.inbox === true);
  const nb1 = (n1?.body as { format?: string; text?: string } | null) ?? {};
  const n1text = nb1.text ?? "";
  check("note body keeps the email's text", nb1.format === "markdown" && n1text.includes("Line one") && n1text.includes("Line two"), n1text);
  check("note body carries the link-don't-copy footer (From + Outlook link)",
    n1text.includes("**From:**") && n1text.includes("/api/email/open?mid="), n1text);
  const email1 = (n1?.properties as { email?: { fromEmail?: string; internetMessageId?: string } })?.email;
  check("note records sender + stable internetMessageId in properties.email",
    email1?.fromEmail === "sender@example.invalid" && email1?.internetMessageId === "<m1@test>");

  const t2 = await findByMessageId("m2");
  check("`task:` subject becomes a task with the prefix stripped", t2?.type === "task" && t2?.title === "Follow up with Roger");

  const h3 = await findByMessageId("m3");
  const h3text = (h3?.body as { format?: string; text?: string } | null)?.text ?? "";
  check("HTML body is converted to markdown text (tags stripped)",
    h3text.includes("Hi there") && h3text.includes("bye") && !h3text.includes("<"), h3text);

  const a4 = await findByMessageId("m4");
  const a4text = (a4?.body as { text?: string } | null)?.text ?? "";
  check("attachment-bearing message lists the file in the body, no R2 copy",
    !!a4 && a4text.includes("doc.pdf") && a4text.includes("(10 B)") && a4text.includes("Attachments"), a4text);

  check("job_state advanced the delta token on a clean run", (await getEmailState())?.deltaToken === "delta-1");

  // --- Run 2: dedup (same internetMessageId) does not double-import --------
  fake.next = { messages: [msg({ id: "m1", subject: "Hello there", bodyText: "x" })], nextDeltaToken: "delta-2" };
  const r2 = await runEmailImport(ownerId, fake);
  check("run 2 receives the stored delta token", fake.received[1] === "delta-1");
  check("a re-seen message is skipped, not re-imported", r2.skipped === 1 && r2.imported === 0);
  const m1count = (await db.select({ c: sql<number>`count(*)::int` }).from(items).where(and(eq(items.ownerId, ownerId), sql`properties @> ${JSON.stringify({ email: { messageId: "m1" } })}::jsonb`)))[0].c;
  check("only one item exists for the re-seen message", m1count === 1);
  check("clean run 2 advanced the token", (await getEmailState())?.deltaToken === "delta-2");

  // --- Run 3: an errored run must not advance the token -------------------
  fake.throwMoveFor.add("m5");
  fake.next = { messages: [msg({ id: "m5", subject: "Will fail to move", bodyText: "y" })], nextDeltaToken: "delta-3" };
  const r3 = await runEmailImport(ownerId, fake);
  check("a message whose move fails counts as an error", r3.errors === 1);
  check("an errored run does NOT advance the delta token", (await getEmailState())?.deltaToken === "delta-2");
  check("the errored message's item still exists (dedup catches it next run)", !!(await findByMessageId("m5")));

  // --- Run 4: the HANDOFF (ADR-221) ---------------------------------------
  // The acceptance test for making this job claimable. `FakeMail` above answers
  // the same reply whatever token it is handed, which is fine for engine
  // mechanics and useless here: the entire question is what a machine that has
  // NEVER run this job sees when it starts from nothing. So this run uses a
  // source that models what Outlook actually does — a folder you list, and a
  // move that takes a message out of it (GraphMailSource.markImported) — and
  // the handoff is simulated by deleting the stored place-in-the-queue, which
  // is exactly what a second machine has: none.
  class FolderMail implements MailSource {
    folder: NormalizedMessage[] = [];
    tokenCalls: (string | null)[] = [];
    // What this delta chain has already handed out. A null token starts a new
    // chain, which is why a fresh machine sees the folder's whole contents.
    private reported = new Set<string>();
    async listNewMessages(token: string | null) {
      this.tokenCalls.push(token);
      if (token === null) this.reported.clear();
      const out = this.folder.filter((m) => !this.reported.has(m.id));
      for (const m of out) this.reported.add(m.id);
      return { messages: out, nextDeltaToken: `folder-token-${this.tokenCalls.length}` };
    }
    async markImported(id: string) {
      this.folder = this.folder.filter((m) => m.id !== id);
      this.reported.delete(id);
    }
  }

  // A machine that has run this job before still has its own place in the
  // queue; clear it so the first FolderMail run is an ordinary first run.
  await db.delete(jobState).where(eq(jobState.key, EMAIL_JOB_KEY));
  const folderMail = new FolderMail();
  folderMail.folder = [
    msg({ id: "h1", subject: "Filed by the first machine", bodyText: "a" }),
    msg({ id: "h2", subject: "task: Also filed there", bodyText: "b" }),
  ];
  // Machine A: a normal run. Both messages are filed and leave the folder.
  const a1 = await runEmailImport(ownerId, folderMail);
  check("handoff setup: the first machine files both and empties the folder",
    a1.imported === 2 && folderMail.folder.length === 0, JSON.stringify(a1));

  // Two messages arrive after that run. One of them, h4, models the crash
  // window: the first machine created its item but died before the move, so it
  // is still sitting in the folder looking unfiled.
  folderMail.folder = [
    msg({ id: "h3", subject: "Arrived after the move", bodyText: "c" }),
    msg({ id: "h4", subject: "Created but never moved", bodyText: "d" }),
  ];
  await runEmailImport(ownerId, folderMail); // files h3 and h4, empties the folder
  folderMail.folder = [msg({ id: "h4", subject: "Created but never moved", bodyText: "d" })];

  // THE HANDOFF. A different machine now owns the job. It has no stored place
  // in the queue, because that record never syncs.
  await db.delete(jobState).where(eq(jobState.key, EMAIL_JOB_KEY));
  folderMail.folder.push(msg({ id: "h5", subject: "Genuinely new", bodyText: "e" }));
  folderMail.tokenCalls.length = 0;

  const handoff = await runEmailImport(ownerId, folderMail);
  check("the new machine starts from nothing, as a new machine does", folderMail.tokenCalls[0] === null);
  check("it sees only what is still in the folder, never the filed ones",
    handoff.imported + handoff.skipped === 2, JSON.stringify(handoff));
  check("it imports the genuinely new message", handoff.imported === 1 && !!(await findByMessageId("h5")));
  check("the created-but-unmoved message is recognized and skipped, not filed twice",
    handoff.skipped === 1, JSON.stringify(handoff));
  check("it clears the stuck message out of the folder", folderMail.folder.length === 0);

  const dupes = await db.execute(sql`
    select properties->'email'->>'internetMessageId' as mid, count(*)::int as c
    from items where owner_id = ${ownerId} and properties ? 'email'
    group by 1 having count(*) > 1
  `);
  check("after the handoff, not one message has two items", dupes.rows.length === 0, JSON.stringify(dupes.rows));

  const filed = await db.execute(sql`
    select count(*)::int as c from items
    where owner_id = ${ownerId} and properties->'email'->>'messageId' like 'h%'
  `);
  check("all five handoff messages are filed exactly once", (filed.rows[0] as { c: number }).c === 5, JSON.stringify(filed.rows));
} finally {
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(jobState).where(eq(jobState.key, EMAIL_JOB_KEY));
  if (savedJob) await db.insert(jobState).values({ key: EMAIL_JOB_KEY, value: savedJob.value });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
