// The re-runnable performance audit (A2, the thorough pass): measures the
// standard read surfaces the way the original lens finding was measured —
// buffers touched + runtime from EXPLAIN (ANALYZE, BUFFERS) — so nobody derives
// these numbers by hand again. Read-only by construction: every statement is a
// SELECT wrapped in EXPLAIN, guarded below, so it is safe to point at the live
// local spoke or at the cloud pooler.
//
//   npx tsx scripts/perf-audit.mts                          # DATABASE_URL
//   npx tsx scripts/perf-audit.mts --url=postgresql://…     # any peer
//   npx tsx scripts/perf-audit.mts --json                   # machine-readable
//   npx tsx scripts/perf-audit.mts --catalog                # list queries, run nothing
//
// Where the SQL comes from matters: everything with an exported query builder
// (viewItemsQuery, listItemsQuery, searchItemsQuery, relatedItemsQuery) is
// captured via .toSQL(), so the audit measures the app's real SQL and stays
// honest as the builders change. The rest (Today's batch, the nav counts) is
// hand-copied and marked `source:` with the file to re-check if it drifts.
//
// Reading the numbers:
//   - buffers = shared hit + read for the whole plan, in 8KB pages. Compare to
//     shared_buffers (reported in the header): a query touching more pages than
//     the cache holds evicts itself every run and can never stay warm — the
//     original "Most linked" finding.
//   - run1 vs run2: run1 after a restart is the honest cold number; on a warm
//     server run1≈run2. The script cannot restart the server for you.
//   - the environment section calls out stale statistics (last analyze) and
//     never-used indexes, both of which the measurements sit on top of.
import { readFileSync, existsSync } from "node:fs";

type Args = { url: string | null; json: boolean; catalogOnly: boolean; label: string };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const val = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return {
    url: val("url"),
    json: argv.includes("--json"),
    catalogOnly: argv.includes("--catalog"),
    label: val("label") ?? "",
  };
}

const args = parseArgs();

// Resolve the URL the way the npm scripts do: --url wins, then DATABASE_URL,
// then .env.local. Never .env.production.local implicitly — pointing this at
// the cloud is a deliberate --url choice, not a default.
function resolveUrl(): string {
  if (args.url) return args.url;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  console.error("No --url and no DATABASE_URL. Nothing to measure.");
  process.exit(2);
}

const url = resolveUrl();
// The builders read getDb() → DATABASE_URL, so set it before the dynamic
// imports below. toSQL() never opens a connection.
process.env.DATABASE_URL = url;

const { viewItemsQuery } = await import("../src/lib/views");
const { listItemsQuery } = await import("../src/lib/items");
const { searchItemsQuery } = await import("../src/lib/search");
const { relatedItemsQuery } = await import("../src/lib/relations");

type Q = { name: string; group: string; sql: string; params: unknown[]; source: string };

// ── The catalog ──────────────────────────────────────────────────────────────
// OWNER / ITEM / TYPE placeholders are substituted after we look real ones up.
function buildCatalog(owner: string, sampleItem: string, busiestType: string): Q[] {
  const fromBuilder = (
    name: string,
    group: string,
    b: { toSQL(): { sql: string; params: unknown[] } },
    source: string
  ): Q => {
    const { sql, params } = b.toSQL();
    return { name, group, sql, params, source };
  };

  const qs: Q[] = [
    // The four default lenses on the busiest type — the A2 table, reproduced.
    fromBuilder(
      `lens recent (${busiestType})`,
      "lenses",
      viewItemsQuery(owner, { type: busiestType }, { field: "updatedAt", dir: "desc" }),
      "views.ts viewItemsQuery"
    ),
    fromBuilder(
      `lens newest (${busiestType})`,
      "lenses",
      viewItemsQuery(owner, { type: busiestType }, { field: "createdAt", dir: "desc" }),
      "views.ts viewItemsQuery"
    ),
    fromBuilder(
      `lens A→Z (${busiestType})`,
      "lenses",
      viewItemsQuery(owner, { type: busiestType }, { field: "title", dir: "asc" }),
      "views.ts viewItemsQuery"
    ),
    fromBuilder(
      `lens mostLinked (${busiestType})`,
      "lenses",
      viewItemsQuery(owner, { type: busiestType }, { field: "mostLinked", dir: "desc" }),
      "views.ts listOrderExpr (the correlated count)"
    ),
    // The same recent lens across ALL types (the /views "All items" shape).
    fromBuilder(
      "lens recent (all types)",
      "lenses",
      viewItemsQuery(owner, {}, { field: "updatedAt", dir: "desc" }),
      "views.ts viewItemsQuery"
    ),
    fromBuilder(
      "lens mostLinked (all types)",
      "lenses",
      viewItemsQuery(owner, {}, { field: "mostLinked", dir: "desc" }),
      "views.ts listOrderExpr"
    ),

    // Pickers / typeahead (the @-mention path): title-word ILIKE + trigram order.
    fromBuilder(
      "picker typeahead (2 words)",
      "pickers",
      listItemsQuery(owner, { q: "roger meeting", limit: 8 }),
      "items.ts listItemsQuery"
    ),
    fromBuilder(
      "picker typeahead (short q)",
      "pickers",
      listItemsQuery(owner, { q: "ro", limit: 8 }),
      "items.ts listItemsQuery"
    ),

    // Full-text search + snippet (ts_headline over left(body_text, 4000)).
    fromBuilder(
      "search FTS + snippet",
      "search",
      searchItemsQuery(owner, "meeting agenda"),
      "search.ts searchItemsQuery"
    ),

    // The item page's Related panel.
    fromBuilder(
      "related panel (one item)",
      "item page",
      relatedItemsQuery(owner, sampleItem),
      "relations.ts relatedItemsQuery"
    ),
  ];

  // Hand-copied SQL. Marked with its source; if the source changes shape, this
  // drifts and should be re-copied (grep the file named in `source`).
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10);
  const dayStart = new Date(today); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(today); dayEnd.setHours(24, 0, 0, 0);

  qs.push(
    {
      name: "today: due/planned tasks",
      group: "today",
      sql: `select id from items where owner_id=$1 and deleted_at is null and is_template=false and type='task'
        and status_category in ('not_started','in_progress')
        and (due_date < $2 or scheduled_date < $2)
        order by least(coalesce(scheduled_date, due_date), coalesce(due_date, scheduled_date)) asc limit 100`,
      params: [owner, ymd],
      source: "today.ts getTodayData (dueTasks)",
    },
    {
      name: "today: meetings of the day",
      group: "today",
      sql: `select id from items where owner_id=$1 and deleted_at is null and is_template=false and type='event'
        and meeting_at >= $2 and meeting_at < $3 order by meeting_at asc limit 50`,
      params: [owner, dayStart.toISOString(), dayEnd.toISOString()],
      source: "today.ts getTodayData (meetings)",
    },
    {
      name: "today: focus (properties @>)",
      group: "today",
      sql: `select id from items where owner_id=$1 and deleted_at is null and is_template=false and type='task'
        and status_category in ('not_started','in_progress')
        and properties @> $2::jsonb limit 50`,
      params: [owner, JSON.stringify({ focus: { date: ymd } })],
      source: "today.ts getTodayData (focusTasks)",
    },
    {
      name: "nav: inbox count (every page)",
      group: "nav",
      sql: `select count(*)::int from items where owner_id=$1 and inbox=true
        and status_category in ('not_started','in_progress') and deleted_at is null and is_template=false`,
      params: [owner],
      source: "items.ts countInbox",
    },
    {
      name: "build: counts by type",
      group: "nav",
      sql: `select type, count(*)::int from items where owner_id=$1 and deleted_at is null and is_template=false group by type`,
      params: [owner],
      source: "items.ts itemCountsByType",
    },
    {
      name: "view badge: count matching",
      group: "views",
      sql: `select count(*)::int from items where owner_id=$1 and deleted_at is null and is_template=false and type=$2`,
      params: [owner, busiestType],
      source: "views.ts countViewItems",
    },
    {
      name: "subtask rollup (children of one)",
      group: "item page",
      sql: `select status_category, count(*)::int from items where owner_id=$1 and parent_id=$2 and deleted_at is null group by status_category`,
      params: [owner, sampleItem],
      source: "the parent_id children pattern (items_parent_idx)",
    },
    {
      name: "sync: ops since cursor",
      group: "sync",
      sql: `select seq from sync_ops where seq > $1 order by seq asc limit 500`,
      params: [0],
      source: "sync/peers.ts pull half",
    },
    {
      name: "trash list",
      group: "lenses",
      sql: `select id from items where owner_id=$1 and deleted_at is not null and is_template=false order by deleted_at desc limit 50`,
      params: [owner],
      source: "items.ts listItemsQuery (trash)",
    }
  );
  return qs;
}

// ── Runner ───────────────────────────────────────────────────────────────────

function assertSelectOnly(sql: string): void {
  const head = sql.trim().slice(0, 12).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error(`refusing non-SELECT statement: ${sql.slice(0, 80)}`);
  }
}

type PlanJson = {
  Plan: Record<string, unknown> & { "Node Type": string };
  "Execution Time": number;
  "Planning Time": number;
};

function sumBuffers(node: Record<string, unknown>): { hit: number; read: number } {
  // Top node totals include children in ANALYZE BUFFERS output.
  return {
    hit: Number(node["Shared Hit Blocks"] ?? 0),
    read: Number(node["Shared Read Blocks"] ?? 0),
  };
}

type Row = {
  name: string;
  group: string;
  run1Ms: number;
  run2Ms: number;
  buffers: number;
  read1: number;
  rows: number;
  topNode: string;
  source: string;
};

async function main() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: url,
    ssl: /neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 60_000,
  });
  await client.connect();

  const who = await client.query(
    "select current_database() db, inet_server_addr()::text addr, version() v"
  );
  const owner = (await client.query("select id from users order by created_at asc limit 1"))
    .rows[0]?.id;
  if (!owner) {
    console.error("No users row — nothing to measure against.");
    process.exit(2);
  }
  const busiest = (
    await client.query(
      "select type from items where owner_id=$1 and deleted_at is null group by type order by count(*) desc limit 1",
      [owner]
    )
  ).rows[0]?.type ?? "task";
  const sampleItem = (
    await client.query(
      // The most-connected live item: the honest worst case for the related panel.
      `select i.id from items i where i.owner_id=$1 and i.deleted_at is null
       order by (select count(*) from relations r where r.source_id=i.id or r.target_id=i.id) desc limit 1`,
      [owner]
    )
  ).rows[0]?.id;

  const catalog = buildCatalog(owner, sampleItem, busiest);
  if (args.catalogOnly) {
    for (const q of catalog) console.log(`${q.group.padEnd(10)} ${q.name}  [${q.source}]`);
    await client.end();
    return;
  }

  // Environment first: what the measurements sit on.
  const settings = await client.query(
    `select name, setting, unit from pg_settings where name in
     ('shared_buffers','work_mem','effective_cache_size','random_page_cost','autovacuum',
      'maintenance_work_mem','max_parallel_workers_per_gather','track_counts')`
  );
  const sizes = await client.query(
    `select s.relname, pg_size_pretty(pg_table_size(c.oid)) tbl, pg_size_pretty(pg_indexes_size(c.oid)) idx,
       s.n_live_tup, s.n_dead_tup, s.last_analyze, s.last_autoanalyze, s.last_autovacuum
     from pg_stat_user_tables s join pg_class c on c.oid = s.relid
     where s.relname in ('items','relations','revisions','sync_ops','item_relatedness','passage_refs','activity_events')
     order by pg_table_size(c.oid) desc`
  );
  const unusedIdx = await client.query(
    `select indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) size, idx_scan
     from pg_stat_user_indexes where idx_scan = 0 and pg_relation_size(indexrelid) > 8192*16
     order by pg_relation_size(indexrelid) desc limit 15`
  );

  const results: Row[] = [];
  for (const q of catalog) {
    assertSelectOnly(q.sql);
    const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`;
    try {
      const r1 = (await client.query({ text: explain, values: q.params })).rows[0][
        "QUERY PLAN"
      ][0] as PlanJson;
      const r2 = (await client.query({ text: explain, values: q.params })).rows[0][
        "QUERY PLAN"
      ][0] as PlanJson;
      const b2 = sumBuffers(r2.Plan);
      const b1 = sumBuffers(r1.Plan);
      results.push({
        name: q.name,
        group: q.group,
        run1Ms: Math.round(r1["Execution Time"] * 10) / 10,
        run2Ms: Math.round(r2["Execution Time"] * 10) / 10,
        buffers: b2.hit + b2.read,
        read1: b1.read,
        rows: Number(r2.Plan["Actual Rows"] ?? 0),
        topNode: r2.Plan["Node Type"],
        source: q.source,
      });
    } catch (err) {
      results.push({
        name: q.name,
        group: q.group,
        run1Ms: -1,
        run2Ms: -1,
        buffers: -1,
        read1: -1,
        rows: 0,
        topNode: `ERROR: ${String((err as Error).message).slice(0, 60)}`,
        source: q.source,
      });
    }
  }
  await client.end();

  const sharedBuffers = settings.rows.find((r) => r.name === "shared_buffers");
  const sbPages = sharedBuffers ? Number(sharedBuffers.setting) : 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          label: args.label || undefined,
          db: who.rows[0],
          settings: settings.rows,
          tables: sizes.rows,
          unusedIndexes: unusedIdx.rows,
          sharedBufferPages: sbPages,
          results,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n== perf audit ${args.label ? `(${args.label}) ` : ""}against ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`   ${who.rows[0].v.split(",")[0]}`);
  console.log("\n-- settings");
  for (const s of settings.rows) console.log(`   ${s.name.padEnd(34)} ${s.setting}${s.unit ? " " + s.unit : ""}`);
  console.log("\n-- tables (size / index size / live / dead / last analyze)");
  for (const t of sizes.rows) {
    const an = t.last_analyze ?? t.last_autoanalyze;
    console.log(
      `   ${t.relname.padEnd(18)} ${String(t.tbl).padEnd(10)} ${String(t.idx).padEnd(10)} ${String(t.n_live_tup).padEnd(8)} ${String(t.n_dead_tup).padEnd(7)} ${an ? new Date(an).toISOString().slice(0, 10) : "NEVER ANALYZED"}`
    );
  }
  if (unusedIdx.rows.length) {
    console.log("\n-- indexes never scanned since stats reset (candidates to question, not delete blindly)");
    for (const i of unusedIdx.rows) console.log(`   ${i.indexrelname.padEnd(40)} ${i.size}`);
  }
  console.log(`\n-- queries (buffers are 8KB pages; shared_buffers holds ${sbPages || "?"} pages)`);
  console.log(`   ${"query".padEnd(34)} ${"grp".padEnd(9)} ${"run1".padStart(8)} ${"run2".padStart(8)} ${"buffers".padStart(8)} ${"read1".padStart(6)}  top node`);
  for (const r of [...results].sort((a, b) => b.buffers - a.buffers)) {
    const hot = sbPages > 0 && r.buffers > sbPages ? " ← exceeds cache" : "";
    console.log(
      `   ${r.name.padEnd(34)} ${r.group.padEnd(9)} ${String(r.run1Ms + "ms").padStart(8)} ${String(r.run2Ms + "ms").padStart(8)} ${String(r.buffers).padStart(8)} ${String(r.read1).padStart(6)}  ${r.topNode}${hot}`
    );
  }
  console.log("");
}

await main();
