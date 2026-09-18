// Backfill for ADR-248: undo the junk the sessionless-apply origin bug left.
//
// Why: the cloud runs neon-http, which has no session, so `SET LOCAL
// ledgr.sync_origin` never reached the oplog trigger and every write the cloud
// APPLIED from a peer was logged as the cloud's own. The merge reads those
// stamps back, so the next body from that same peer looked like a two-device
// conflict: the previous body was snapshotted into `revisions` and the item was
// flagged `syncBodyMerged` ("merged offline, check revisions"). One note
// collected 37 revisions in an afternoon; 74 items carry the false flag.
//
// This clears the false flags and thins the revisions those phantom conflicts
// produced back to the cadence an ordinary save keeps (one snapshot per 5
// minutes, REVISION_DEBOUNCE_MS in src/lib/item-mutations.ts). Only items
// carrying the flag are touched, the newest revision of each is always kept,
// and the first snapshot in every 5-minute window survives — so a genuine
// history that was already spaced out loses nothing.
//
// Safety: production data. Every deleted revision is written to
// scripts/backups/ in full BEFORE the delete, so a restore is re-inserting
// from that file. Dry run is the DEFAULT; --apply writes. Both tables are in
// the synced set, so the cleanup travels to the other peers on its own.
//
// Run: npx tsx scripts/backfill-sync-conflict-noise.mts [--apply] [--env=.env.production.local]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const envArg = process.argv.find((a) => a.startsWith("--env="));
const envFile = envArg ? envArg.slice("--env=".length) : ".env.local";
for (const line of readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { sql } = await import("drizzle-orm");

const apply = process.argv.includes("--apply");
const db = getDb();

console.log(`env: ${envFile}  mode: ${apply ? "APPLY" : "dry run"}`);

// The flagged items, with how much history each is carrying.
const flagged = await db.execute(sql`
  select i.id::text as id, i.title, count(r.id)::int as revs
  from items i left join revisions r on r.item_id = i.id
  where i.properties ->> 'syncBodyMerged' = 'true'
  group by i.id, i.title
  order by count(r.id) desc
`);
console.log(`\nflagged items: ${flagged.rows.length}`);
for (const r of flagged.rows.slice(0, 10)) {
  console.log(`  ${String(r.revs).padStart(4)} revisions  ${r.title}`);
}
if (flagged.rows.length > 10) console.log(`  … and ${flagged.rows.length - 10} more`);

// Thin: keep the newest snapshot per item, plus the first one in each fixed
// 5-minute window. Fixed windows rather than a rolling debounce so the choice
// is deterministic and re-runnable.
const doomed = await db.execute(sql`
  with ranked as (
    select r.id::text as id, r.item_id::text as item_id, r.created_at,
           row_number() over (
             partition by r.item_id, floor(extract(epoch from r.created_at) / 300)
             order by r.created_at
           ) as in_window,
           row_number() over (partition by r.item_id order by r.created_at desc) as from_newest
    from revisions r
    join items i on i.id = r.item_id
    where i.properties ->> 'syncBodyMerged' = 'true'
  )
  select id, item_id, created_at from ranked
  where in_window > 1 and from_newest > 1
  order by item_id, created_at
`);
console.log(`\nrevisions to remove: ${doomed.rows.length}`);

if (doomed.rows.length > 0) {
  const ids = doomed.rows.map((r) => String(r.id));
  if (apply) {
    // Full rows, bodies included: this file IS the undo.
    const rows = await db.execute(
      sql`select to_jsonb(r) as row from revisions r where r.id = any(${`{${ids.join(",")}}`}::uuid[])`
    );
    mkdirSync("scripts/backups", { recursive: true });
    const path = `scripts/backups/sync-conflict-revisions-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    writeFileSync(path, JSON.stringify(rows.rows.map((r) => r.row), null, 2));
    console.log(`backup written: ${path} (${rows.rows.length} rows)`);
    // Chunked: one statement per 500 so a big cleanup can't blow the parameter
    // or op-trigger budget in a single call.
    let removed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const res = await db.execute(
        sql`delete from revisions where id = any(${`{${chunk.join(",")}}`}::uuid[]) returning id`
      );
      removed += res.rows.length;
    }
    console.log(`revisions removed: ${removed}`);
  }
}

// The flag itself. `properties - 'syncBodyMerged'` so nothing else in the blob
// is disturbed.
if (apply) {
  const cleared = await db.execute(sql`
    update items set properties = properties - 'syncBodyMerged'
    where properties ->> 'syncBodyMerged' = 'true'
    returning id
  `);
  console.log(`flags cleared: ${cleared.rows.length}`);
} else {
  console.log(`\nflags that would be cleared: ${flagged.rows.length}`);
  console.log("dry run: nothing written. Re-run with --apply.");
}
