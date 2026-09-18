// Read-only dump for the person-relation backfill (2026-09-14). Writes JSON to
// the path in argv[2]. Run: npx tsx scripts/dump-people-events.mts .env.production.local out.json
import { readFileSync, writeFileSync } from "node:fs";
const envFile = process.argv[2] ?? ".env.hub.local"; // the hub = the main copy; pass .env.production.local only to read the Neon peer
for (const line of readFileSync(envFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { getDb } = await import("../src/db");
const { sql } = await import("drizzle-orm");
const db = getDb();
type Row = Record<string, unknown>;
// node-postgres returns { rows }, the Neon HTTP driver returns the array itself.
const q = async (s: Parameters<typeof db.execute>[0]): Promise<Row[]> => {
  const r = await db.execute(s);
  return Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] }).rows ?? []);
};
const owners = await q(sql`select id, email from users`);
const people = await q(sql`select id, owner_id, title, properties from items where type='person' and deleted_at is null`);
const groups = await q(sql`select id, owner_id, title from items where type='group' and deleted_at is null`);
const events = await q(sql`select id, title, meeting_at, properties, body->>'text' as body, owner_id
  from items where type='event' and deleted_at is null order by meeting_at desc nulls last`);
const edges = await q(sql`select r.source_id, r.target_id, r.role, r.match_state
  from relations r join items a on a.id=r.source_id join items b on b.id=r.target_id
  where (a.type='event' and b.type in ('person','group')) or (b.type='event' and a.type in ('person','group'))
     or (a.type='group' and b.type='person') or (a.type='person' and b.type='group')`);
const recentOps = await q(sql`select tbl, kind, count(*)::int as n from sync_ops where at > now() - interval '3 hours' group by 1,2`).catch(() => []);
writeFileSync(process.argv[3], JSON.stringify({ owners, people, groups, events, edges, recentOps }));
console.log({ recentOps });
console.log({ owners: owners.length, people: people.length, groups: groups.length, events: events.length, edges: edges.length, host: process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] });
process.exit(0);
