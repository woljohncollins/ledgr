// Person/group relation backfill WRITER (2026-09-14). Reads the approved proposals.json
// from the dry run and writes each edge through relateItems — the same function the
// MCP relate_items tool and POST /api/machine/relations use, so it is owner-scoped,
// upserts on (source, target, role) (idempotent: a re-run duplicates nothing), and
// flips a suggested pair to confirmed.
//
// Run: npx tsx scripts/write-people-backfill.mts .env.hub.local <proposals.json> [--tiers A-email,B-title,...] [--limit N] [--dry-run]
import { readFileSync, appendFileSync } from "node:fs";
const [envFile, proposalsPath, ...rest] = process.argv.slice(2);
for (const line of readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const arg = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const dryRun = rest.includes("--dry-run");
const tierPrefixes = arg("--tiers")?.split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(arg("--limit") ?? Infinity);

// Live writes go to the MAIN copy (the hub on this laptop). Neon is a sync peer; writing
// there costs cloud calls and only reaches the main copy on the daily check-in.
if (/neon\.tech/.test(process.env.DATABASE_URL ?? "") && !rest.includes("--allow-cloud")) {
  console.error("refusing: DATABASE_URL is the Neon cloud peer, not the main copy. Use .env.hub.local (or pass --allow-cloud on purpose).");
  process.exit(2);
}
const { getDb } = await import("../src/db");
const { sql } = await import("drizzle-orm");
const { relateItems } = await import("../src/lib/relations");
const db = getDb();

type P = { event_id: string; event_title: string; meeting_date: string; target_id: string; target_name: string; role: string; tier: string };
let props: P[] = JSON.parse(readFileSync(proposalsPath, "utf8"));
if (tierPrefixes) props = props.filter((p) => tierPrefixes.some((t) => p.tier.startsWith(t)));
props.sort((a, b) => (b.meeting_date || "").localeCompare(a.meeting_date || ""));   // newest first
props = props.slice(0, limit);

type Row = Record<string, string>;
// node-postgres returns { rows }, the Neon HTTP driver returns the array itself.
const rows = (r: unknown): Row[] =>
  Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] }).rows ?? []);

const ownerId: string = rows(
  await db.execute(sql`select owner_id from items where id = ${props[0].event_id}`)
)[0].owner_id;

// Existing confirmed edges, re-read now (not from the dump) so a re-run skips what's already there.
const ex = await db.execute(
  sql`select source_id, target_id, role from relations where match_state = 'confirmed'`
);
const have = new Set<string>(rows(ex).map((r) => `${r.source_id}|${r.target_id}|${r.role}`));

const log = proposalsPath.replace(/\.json$/, `.write-${Date.now()}.log`);
let written = 0, skipped = 0, failed = 0, i = 0;
for (const p of props) {
  i++;
  const key = `${p.event_id}|${p.target_id}|${p.role}`;
  if (have.has(key)) { skipped++; continue; }
  if (dryRun) { written++; continue; }
  try {
    await relateItems(ownerId, p.event_id, p.target_id, p.role);
    have.add(key); written++;
    appendFileSync(log, `OK ${p.meeting_date} ${p.event_title} -> ${p.target_name} [${p.role}] (${p.tier})\n`);
  } catch (err) {
    failed++;
    appendFileSync(log, `FAIL ${p.meeting_date} ${p.event_title} -> ${p.target_name} [${p.role}] (${p.tier}): ${(err as Error).message}\n`);
  }
  if (i % 100 === 0) console.log(`${i}/${props.length} processed — written ${written}, skipped ${skipped}, failed ${failed}`);
}
console.log({ processed: i, written, skipped, failed, dryRun, log });
process.exit(0);
