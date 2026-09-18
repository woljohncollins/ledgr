// Rebuild every item's passage_refs from its body.
//
// Why this exists: until 2026-08-23 the sync apply path wrote item rows
// without rebuilding their derived passage edges (passage_refs is outside
// ADR-206's v1 synced set and has no trigger), so any peer that ran a build
// from before that fix holds a passage index frozen at whatever its fill
// copied. The fix keeps things correct going forward; this repairs the drift
// already accumulated.
//
// Run it on a PEER that ran a pre-fix build. It is pointless on the hub, whose
// edges item-mutations.ts has been maintaining all along, and running it there
// would rewrite thousands of rows to the same values.
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/ledgr \
//     npx tsx scripts/rebuild-passage-refs.mts
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { replacePassageRefs } from "../src/lib/passages/refs";

const db = getDb();
const BATCH = 500;

// Bodies only: an item with no body can hold no passage link, and its edges
// (if any survive from a stale index) are cleared by the null-body path below
// only when it actually had some.
const { rows: withBody } = (await db.execute(
  sql`select id from items where body is not null order by id`
)) as { rows: { id: string }[] };
const { rows: orphaned } = (await db.execute(
  sql`select distinct p.source_item_id as id
        from passage_refs p join items i on i.id = p.source_item_id
       where p.role = 'passage' and i.body is null`
)) as { rows: { id: string }[] };

const ids = [...withBody.map((r) => r.id), ...orphaned.map((r) => r.id)];
console.log(`${ids.length} item(s) to reconcile (${withBody.length} with a body, ${orphaned.length} holding stale edges with none)`);

let done = 0;
for (const id of ids) {
  const { rows } = (await db.execute(sql`select body from items where id = ${id}`)) as {
    rows: { body: unknown }[];
  };
  await replacePassageRefs(db, id, rows[0]?.body ?? null);
  if (++done % BATCH === 0) console.log(`  ${done}/${ids.length}`);
}

const { rows: total } = (await db.execute(
  sql`select count(*)::int as n from passage_refs where role = 'passage'`
)) as { rows: { n: number }[] };
console.log(`Done. ${done} item(s) reconciled; ${total[0].n} passage edge(s) now stored.`);
