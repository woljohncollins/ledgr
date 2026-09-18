// Slice 5 verification (next_steps.md), markdown-era (ADR-040): the @-mention
// → relations sync over markdown bodies and the attachment presign flow,
// against the live Neon DB, then cleans up. Run with:
//   npx tsx scripts/verify-editor.mts
import { readFileSync } from "node:fs";

// Minimal .env.local loader; strips BOM and CRLF (PowerShell-written files).
for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { makeMarkdownBody } = await import("../src/lib/body");
const { mentionToMarkdown } = await import("../src/lib/editor/mention-markdown");
const { getDb } = await import("../src/db");
const { attachments, items, relations, users } = await import(
  "../src/db/schema"
);
const {
  ItemError,
  listItemsQuery,
} = await import("../src/lib/items");
const {
  createItem,
  restoreRevision,
  updateItem,
} = await import("../src/lib/item-mutations");
const { MENTION_ROLE } = await import("../src/lib/mentions");
const { and, eq, inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function expectError(
  name: string,
  code: "not_found" | "bad_request",
  fn: () => Promise<unknown>
) {
  try {
    await fn();
    check(name, false, "no error thrown");
  } catch (err) {
    check(name, err instanceof ItemError && err.code === code, String(err));
  }
}

// ---------- Part 1: mention sync + search (live Neon) ----------

const db = getDb();
const owner = (await db.select({ id: users.id }).from(users).limit(1))[0];
if (!owner) throw new Error("no users row; run db:seed first");

const made: string[] = [];
async function mk(title: string, body: unknown = null) {
  const item = await createItem(owner.id, { type: "note", title, body });
  made.push(item.id);
  return item;
}

const target = await mk("verify5 target");
// Bodies are canonical markdown now (ADR-040): a mention is the ledgr:// link.
const mentionOf = (id: string) => makeMarkdownBody(`see ${mentionToMarkdown(id, "x")}`);

const source = await mk("verify5 source", mentionOf(target.id));

const rels = () =>
  db
    .select({ targetId: relations.targetId, role: relations.role })
    .from(relations)
    .where(and(eq(relations.sourceId, source.id), eq(relations.role, MENTION_ROLE)));

check(
  "mention: create body → relation row",
  (await rels()).some((r) => r.targetId === target.id)
);

// A manual relation with another role must survive the sync.
await db.insert(relations).values({
  sourceId: source.id,
  targetId: target.id,
  role: "tagged",
});

await updateItem(owner.id, source.id, { body: makeMarkdownBody("no mentions now") });
check("mention: removing mention removes relation row", (await rels()).length === 0);
const tagged = await db
  .select({ id: relations.id })
  .from(relations)
  .where(and(eq(relations.sourceId, source.id), eq(relations.role, "tagged")));
check("mention: other-role relations untouched by sync", tagged.length === 1);

await updateItem(owner.id, source.id, {
  body: mentionOf("00000000-0000-0000-0000-00000000dead"),
});
check("mention: dangling target id creates nothing", (await rels()).length === 0);

await updateItem(owner.id, source.id, { body: mentionOf(source.id) });
check("mention: self-mention ignored", (await rels()).length === 0);

// Mentions return on revision restore (the create-time body had the mention
// and was snapshotted; restoring it should resync the edge).
const revs = await db.execute(
  // raw to keep this script independent of lib internals
  (await import("drizzle-orm")).sql`
    select id from revisions where item_id = ${source.id} order by created_at asc limit 1`
);
if (revs.rows.length > 0) {
  await restoreRevision(owner.id, source.id, revs.rows[0].id as string);
  check(
    "mention: revision restore resyncs relations",
    (await rels()).some((r) => r.targetId === target.id)
  );
} else {
  check("mention: revision restore resyncs relations", false, "no revision found");
}

// Clearing the body clears the edges.
await updateItem(owner.id, source.id, { body: null });
check("mention: null body clears relation rows", (await rels()).length === 0);

// Title search for the @-picker.
const needle = await mk("verify5 zq%needle_zz");
const q1 = await listItemsQuery(owner.id, { q: "zq%needle" });
check("search: q matches title substring", q1.some((r) => r.id === needle.id));
const q2 = await listItemsQuery(owner.id, { q: "zq%needle" });
check(
  "search: ILIKE wildcards escaped",
  // '%' is literal in the query: 'zqXneedle' must NOT match
  !(await listItemsQuery(owner.id, { q: "zqXneedle" })).some((r) => r.id === needle.id) &&
    q2.some((r) => r.id === needle.id)
);
const qsql = listItemsQuery(owner.id, { q: "abc" }).toSQL().sql.toLowerCase();
check(
  "search: q query stays owner-scoped, body-free",
  qsql.includes("owner_id") && qsql.includes("ilike") && !qsql.includes('"body"')
);

// ---------- Part 2: attachments (validation + presign shape) ----------

const att = await import("../src/lib/attachments");

// This check asserts the unconfigured-storage path, regardless of whether
// the local .env.local (loaded above) already carries real R2 credentials
// for everyday dev use — so clear them for just this one assertion. (The
// fake config set right below overwrites all four for the rest of the suite.)
for (const k of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"]) {
  delete process.env[k];
}

await expectError("attach: storage unconfigured → bad_request", "bad_request", () =>
  att.createAttachment(owner.id, {
    itemId: target.id,
    filename: "x.png",
    contentType: "image/png",
    sizeBytes: 10,
  })
);

// Fake-but-well-formed R2 config: aws4fetch signs locally, no network needed.
process.env.R2_ACCESS_KEY_ID = "verifykey";
process.env.R2_SECRET_ACCESS_KEY = "verifysecret";
process.env.R2_BUCKET = "ledgr";
process.env.R2_ENDPOINT = "https://fake-account.r2.cloudflarestorage.com";

await expectError("attach: zero size rejected", "bad_request", () =>
  att.createAttachment(owner.id, {
    itemId: target.id,
    filename: "x.png",
    contentType: "image/png",
    sizeBytes: 0,
  })
);
await expectError("attach: oversize rejected", "bad_request", () =>
  att.createAttachment(owner.id, {
    itemId: target.id,
    filename: "x.png",
    contentType: "image/png",
    sizeBytes: 101 * 1024 * 1024,
  })
);
await expectError("attach: unknown item → not_found", "not_found", () =>
  att.createAttachment(owner.id, {
    itemId: "00000000-0000-0000-0000-00000000dead",
    filename: "x.png",
    contentType: "image/png",
    sizeBytes: 10,
  })
);

const created = await att.createAttachment(owner.id, {
  itemId: target.id,
  filename: "pasted image.png",
  contentType: "image/png",
  sizeBytes: 1234,
});
check(
  "attach: storage key is owner-prefixed and sanitized",
  created.storageKey.startsWith(`${owner.id}/`) &&
    created.storageKey.endsWith("/pasted_image.png")
);
check(
  "attach: presigned PUT URL shape",
  created.uploadUrl.includes("X-Amz-Signature=") &&
    created.uploadUrl.includes("X-Amz-Expires=900") &&
    created.uploadUrl.startsWith("https://fake-account.r2.cloudflarestorage.com/ledgr/")
);
check(
  // ADR-231: there is no CDN base any more. publicUrl survives as a field for
  // API/MCP back-compat and is now the same stable address as fileUrl.
  "attach: publicUrl is the stable address, not a provider URL",
  created.publicUrl === `/files/${created.id}` && created.fileUrl === created.publicUrl
);
const listed = await att.listAttachments(owner.id, target.id);
check(
  "attach: metadata row listed for item",
  listed.some((a) => a.id === created.id && a.sizeBytes === 1234)
);

// Quota: park a row just under the 10GB line, then any new file must bounce.
const hog = crypto.randomUUID();
await db.insert(attachments).values({
  id: hog,
  ownerId: owner.id,
  parentItemId: target.id,
  filename: "hog.bin",
  contentType: "application/octet-stream",
  sizeBytes: 10 * 1024 * 1024 * 1024 - 100,
  storageKey: `${owner.id}/${hog}/hog.bin`,
});
await expectError("attach: quota enforced (~10GB)", "bad_request", () =>
  att.createAttachment(owner.id, {
    itemId: target.id,
    filename: "y.png",
    contentType: "image/png",
    sizeBytes: 1024,
  })
);

// ---------- Cleanup ----------
await db.delete(items).where(inArray(items.id, made));
const leftover = await db
  .select({ id: relations.id })
  .from(relations)
  .where(inArray(relations.sourceId, made));
check("cleanup: cascade removed relations/attachments", leftover.length === 0);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
