// One-time migration: rewrite storage-provider URLs stored in item bodies and
// person `image` properties to the stable /files/<id> addresses (ADR-228).
//
// Run it ONCE per install, after deploying the /files/[id] route. New uploads
// already store the stable address; this is only for content written before it
// existed. Idempotent: a second run finds nothing to do.
//
//   npx tsx scripts/migrate-attachment-urls.mts            # dry run, changes nothing
//   npx tsx scripts/migrate-attachment-urls.mts --apply    # write
//   npx tsx scripts/migrate-attachment-urls.mts --apply --no-touch
//
// By default an applied change bumps updated_at, which makes the OneDrive export
// re-write those markdown files with relative attachment paths (images then work
// offline in the export tree). --no-touch skips that if you would rather not
// queue a large export/sync pass right now.
//
// Deliberately does NOT write revision snapshots: this is a mechanical address
// change, not a content edit, and 7k snapshots would just churn the cap. Take a
// database backup first — that is the undo.
import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// From the pure module, not ../src/lib/attachments: this script owns its own pg
// client and has no business pulling the app's DB layer in.
const { rewriteProviderUrlsInText, stableAttachmentUrl } = await import(
  "../src/lib/attachment-url"
);

const apply = process.argv.includes("--apply");
const touch = !process.argv.includes("--no-touch");
const url =
  process.env.MIGRATE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/ledgr";

const db = new Client({ connectionString: url });
await db.connect();

const ids = new Set<string>(
  (await db.query<{ id: string }>("select id from attachments")).rows.map((r) =>
    r.id.toLowerCase()
  )
);
const isKnownId = (id: string) => ids.has(id);
console.log(`${ids.size} attachments on record`);
console.log(apply ? "MODE: apply\n" : "MODE: dry run (use --apply to write)\n");

let bodiesChanged = 0;
let bodyUrls = 0;
let imagesChanged = 0;
const unknown = new Set<string>();

// Bodies. Only rows whose text actually contains an http(s) URL are candidates,
// so this reads a fraction of the table rather than every body.
const bodies = await db.query<{ id: string; text: string; format: string }>(`
  select id, body->>'text' as text, body->>'format' as format
  from items
  where body->>'text' like '%http%'
`);
for (const row of bodies.rows) {
  if (!row.text) continue;
  const { text, rewritten } = rewriteProviderUrlsInText(row.text, isKnownId);
  if (rewritten === 0) continue;
  bodiesChanged += 1;
  bodyUrls += rewritten;
  if (apply) {
    await db.query(
      `update items
         set body = jsonb_build_object('format', $2::text, 'text', $3::text)
             ${touch ? ", updated_at = now()" : ""}
       where id = $1`,
      [row.id, row.format ?? "markdown", text]
    );
  }
}

// Person images: a single URL in properties->>'image', not embedded in prose.
const images = await db.query<{ id: string; image: string }>(`
  select id, properties->>'image' as image
  from items
  where properties->>'image' like 'http%'
`);
for (const row of images.rows) {
  const next = stableAttachmentUrl(row.image);
  if (next === row.image) continue;
  const id = next.slice("/files/".length);
  if (!isKnownId(id)) {
    unknown.add(id);
    continue;
  }
  imagesChanged += 1;
  if (apply) {
    await db.query(
      `update items
         set properties = jsonb_set(properties, '{image}', to_jsonb($2::text))
             ${touch ? ", updated_at = now()" : ""}
       where id = $1`,
      [row.id, next]
    );
  }
}

console.log(`bodies:        ${bodiesChanged} items, ${bodyUrls} URLs rewritten`);
console.log(`person images: ${imagesChanged} rewritten`);
if (unknown.size > 0) {
  console.log(
    `\nskipped ${unknown.size} image URL(s) whose attachment row is gone (left as-is)`
  );
}
if (!apply && bodiesChanged + imagesChanged > 0) {
  console.log("\nNothing was written. Re-run with --apply.");
}
if (apply && touch && bodiesChanged + imagesChanged > 0) {
  console.log(
    "\nupdated_at was bumped, so the next export re-writes these markdown files."
  );
}
await db.end();
