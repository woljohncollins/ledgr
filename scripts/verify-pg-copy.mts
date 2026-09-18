// Integration check for the native live-pull copy engine (ADR-206, LH-native-pull):
// scripts/lib/pg-copy.mjs, used by scripts/local-restore.mjs's --from-url path
// in place of pg_dump/pg_restore. Same embedded-postgres pattern as
// scripts/verify-sync.mts's tier (b), but proving the bulk row-copy engine
// rather than the incremental sync engine.
//
// Two ephemeral clusters stand in for "the hub" (A, read-only source) and "a
// fresh local peer" (B, the pull destination), both migrated from ./drizzle —
// mirroring the real pull, where migrate creates B's schema (and its own
// migration-seeded rows: the system `types`, the `sync_schema_ver` singleton)
// BEFORE anything is copied. Seed A with representative rows, run the real
// copyAllTables, then assert everything local-restore.mjs's pullFromUrl
// depends on: identical row counts, byte-identical body/jsonb, the generated
// `search` column populated LOCALLY (not copied), sync_ops staying empty
// (trigger suppression), sequences realigned, and a second run being a no-op.
//
// Gated on embedded-postgres availability with a loud SKIP, same as
// verify-sync.mts, so CI (no binaries, no database) can't false-fail.
//
// NOTE this file must never contain the literal name of the database
// connection env var — verify-ci.mjs would classify it as backend-needing and
// silently drop it from CI (it stays a local/manual step, like verify-sync).
//
// Run: npx tsx scripts/verify-pg-copy.mts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirBestEffort } from "../supervisor/rm-dir.mjs";
import { freePorts } from "./lib/free-port.mjs";
import { copyAllTables, EXCLUDED_TABLES } from "./lib/pg-copy.mjs";
// jsonb does not preserve object key order (Postgres docs), so a straight
// JSON.stringify of a round-tripped value can differ from the original by
// key order alone. stableStringify (already used by verify-sync.mts's own
// convergence checks) sorts keys first, which is the right notion of
// "byte-identical" for jsonb content.
import { stableStringify } from "../src/lib/sync/engine";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const OWNER = "00000000-0000-4000-8000-00000000000a";
const ITEM = "11111111-0000-4000-8000-000000000001";
const TARGET = "11111111-0000-4000-8000-000000000002";

async function migratedPool(url: string) {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  return pool;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

async function copyableTableList(pool: Queryable): Promise<string[]> {
  const res = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`
  );
  return res.rows.map((r) => r.table_name as string).filter((t: string) => !EXCLUDED_TABLES.has(t));
}

async function rowCounts(pool: Queryable, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await pool.query(`select count(*)::int as n from "${t}"`);
    out[t] = Number(r.rows[0].n);
  }
  return out;
}

async function runIntegration(urlA: string, urlB: string): Promise<void> {
  const poolA = await migratedPool(urlA);
  const poolB = await migratedPool(urlB);
  try {
    // ── Seed the "hub" (A) with representative rows ────────────────────────
    const longBody = {
      format: "markdown",
      text:
        "# A long note\n\n" +
        "Paragraph one with unicode: café, 日本語, emoji 🎉.\n\n".repeat(30) +
        "## A second heading\n\nMore prose after it.\n",
    };
    const props = { tags: ["alpha", "beta"], nested: { deep: { value: 42 } }, flag: false, when: null };

    await poolA.query(`insert into users (id, email, settings) values ($1, 'pg-copy-test@example.com', $2)`, [
      OWNER,
      JSON.stringify({ theme: "dark" }),
    ]);
    await poolA.query(`insert into types (key, label) values ('widget', 'Widget')`);
    await poolA.query(
      `insert into items (id, owner_id, type, title, body, properties) values ($1, $2, 'widget', 'Target', null, null)`,
      [TARGET, OWNER]
    );
    await poolA.query(
      `insert into items (id, owner_id, type, title, body, properties) values ($1, $2, 'widget', 'Long Body Item', $3, $4)`,
      [ITEM, OWNER, JSON.stringify(longBody), JSON.stringify(props)]
    );
    await poolA.query(
      `insert into relations (id, source_id, target_id, role) values (gen_random_uuid(), $1, $2, 'related')`,
      [ITEM, TARGET]
    );
    await poolA.query(`insert into revisions (id, item_id, body) values (gen_random_uuid(), $1, $2)`, [
      ITEM,
      JSON.stringify({ format: "markdown", text: "an earlier revision" }),
    ]);

    // A throwaway table with a real serial column, on BOTH sides — nothing
    // in today's schema has one among the copied tables (sync_ops.seq is
    // the only bigserial, and it's excluded), so this is the only way to
    // exercise sequence reset for real rather than trusting an empty no-op.
    for (const pool of [poolA, poolB]) {
      await pool.query(`create table pg_copy_test_serial (id serial primary key, note text)`);
    }
    await poolA.query(`insert into pg_copy_test_serial (note) values ('one'), ('two'), ('three')`);

    const tables = await copyableTableList(poolA);
    check(
      "the catalog-discovered table list excludes exactly the per-peer sync tables",
      !tables.includes("sync_ops") && !tables.includes("sync_peers") && !tables.includes("sync_device") && tables.includes("items")
    );
    const beforeA = await rowCounts(poolA, tables);

    // ── Run the real copy engine: A -> B, over dedicated Client connections
    // (never a Pool — see copyAllTables's own comment on why) ──────────────
    const { default: pg } = await import("pg");
    async function copyOnce() {
      const source = new pg.Client({ connectionString: urlA });
      const dest = new pg.Client({ connectionString: urlB });
      await source.connect();
      await dest.connect();
      try {
        return await copyAllTables(source, dest, { log: () => {} });
      } finally {
        await source.end();
        await dest.end();
      }
    }

    const result = await copyOnce();
    check(
      "copyAllTables' reported table list matches the catalog discovery",
      JSON.stringify([...result.tables].sort()) === JSON.stringify([...tables].sort())
    );

    const afterB = await rowCounts(poolB, tables);
    const mismatches = tables.filter((t) => beforeA[t] !== afterB[t]).map((t) => `${t}: A=${beforeA[t]} B=${afterB[t]}`);
    check("every copyable table has an identical row count on both sides", mismatches.length === 0, mismatches.join("; "));

    const itemB = (await poolB.query(`select body, properties, search is not null as has_search from items where id = $1`, [ITEM])).rows[0];
    check("the long multi-paragraph body survives byte-identically", stableStringify(itemB.body) === stableStringify(longBody));
    check("nested/array/null jsonb properties survive byte-identically", stableStringify(itemB.properties) === stableStringify(props));
    check("the generated `search` column is populated LOCALLY (proves generation ran on B, not a copied value)", itemB.has_search === true);

    const opsB = await poolB.query(`select count(*)::int as n from sync_ops`);
    check("sync_ops is EMPTY on B after the copy (trigger suppression via session_replication_role worked)", Number(opsB.rows[0].n) === 0);

    const relB = await poolB.query(`select source_id, target_id, role from relations`);
    check(
      "the relation edge copied",
      relB.rows.length === 1 && relB.rows[0].source_id === ITEM && relB.rows[0].target_id === TARGET
    );

    const revB = await poolB.query(`select count(*)::int as n from revisions where item_id = $1`, [ITEM]);
    check("the revision row copied", Number(revB.rows[0].n) === 1);

    const usersB = await poolB.query(`select settings from users where id = $1`, [OWNER]);
    check("the users row (with settings jsonb) copied", usersB.rows[0]?.settings?.theme === "dark");

    // The rows migrations seed independently on every instance (system
    // `types`, the `sync_schema_ver` singleton) must upsert cleanly rather
    // than crash on a PK conflict against B's own migration-seeded copy.
    const widgetType = await poolB.query(`select label from types where key = 'widget'`);
    check(
      "a hub-only type row copied without a PK conflict against B's migration-seeded system types",
      widgetType.rows[0]?.label === "Widget"
    );
    const verB = await poolB.query(`select ver from sync_schema_ver`);
    check("sync_schema_ver stays exactly one row after the copy (upsert, not a crash)", verB.rows.length === 1);

    // The serial-column table: the copied rows carry the source's explicit
    // ids (1, 2, 3), and B's own sequence — which started fresh at 1 when B
    // created the table before the copy — must be realigned past that max.
    // If it weren't, this insert would collide with the copied id=1 row.
    const serialB = await poolB.query(`select id from pg_copy_test_serial order by id`);
    check("the serial-backed rows themselves copied with their explicit ids", serialB.rows.map((r) => r.id).join(",") === "1,2,3");
    const nextRow = await poolB.query(`insert into pg_copy_test_serial (note) values ('four') returning id`);
    check(
      "the sequence was reset past the copied max (a fresh insert gets id 4, not a collision with the copied id=1)",
      Number(nextRow.rows[0].id) === 4
    );

    // ── Idempotence: a second pull-shaped copy must succeed and change
    // nothing (the ON CONFLICT DO UPDATE upsert, not a crash on round two). ─
    const before2 = await rowCounts(poolB, tables);
    await copyOnce();
    const after2 = await rowCounts(poolB, tables);
    check("a second copy run is idempotent: row counts are unchanged", stableStringify(before2) === stableStringify(after2));
    const opsB2 = await poolB.query(`select count(*)::int as n from sync_ops`);
    check("sync_ops stays empty after the second copy too", Number(opsB2.rows[0].n) === 0);
    const itemB2 = (await poolB.query(`select body from items where id = $1`, [ITEM])).rows[0];
    check("the upserted row's content is unchanged by the second copy", stableStringify(itemB2.body) === stableStringify(longBody));
  } finally {
    await poolA.end();
    await poolB.end();
  }
}

async function main(): Promise<void> {
  let EmbeddedPostgres: new (opts: object) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  };
  try {
    EmbeddedPostgres = (await import("embedded-postgres")).default;
  } catch {
    console.log(
      "\nSKIP  verify-pg-copy: embedded-postgres unavailable.\n" +
        "      Needs the embedded-postgres devDependency's platform binaries (npm ci)."
    );
    return;
  }

  const dirs = [mkdtempSync(join(tmpdir(), "ledgr-pgcopy-a-")), mkdtempSync(join(tmpdir(), "ledgr-pgcopy-b-"))];
  // OS-assigned, never hardcoded: a leaked postmaster from a crashed run
  // holding a fixed port wedged this suite instead of failing it (one CI run
  // sat there 77 minutes), and fixed ports also stop two cluster suites from
  // ever running at once.
  const ports = await freePorts(2);
  const clusters = dirs.map(
    (databaseDir, i) =>
      new EmbeddedPostgres({
        databaseDir,
        user: "postgres",
        password: "postgres",
        port: ports[i],
        persistent: false,
        // Windows initdb inherits the OS locale and would produce a WIN1252
        // cluster with libc collation, which cannot store the arrows, curly
        // quotes and em dashes that real Ledgr bodies (and this suite's own
        // fixtures) contain. The three runtime cluster sites force this; a
        // test cluster that does not is testing a database the app never
        // runs on. Kept identical to them on purpose, and verify-setup.mts
        // asserts that every cluster-creating file carries these flags.
        initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=en-US", "--locale=C"],
      })
  );
  try {
    try {
      for (const c of clusters) {
        await c.initialise();
        await c.start();
        await c.createDatabase("ledgr");
      }
    } catch (err) {
      // A cluster that can't even start is an environment problem (missing
      // platform binaries, a held port), not a copy-engine regression.
      console.log(`SKIP  verify-pg-copy: embedded-postgres could not start (${err instanceof Error ? err.message : err})`);
      return;
    }
    await runIntegration(
      `postgresql://postgres:postgres@localhost:${ports[0]}/ledgr`,
      `postgresql://postgres:postgres@localhost:${ports[1]}/ledgr`
    );
  } finally {
    for (const c of clusters) {
      try {
        await c.stop();
      } catch {
        // best-effort teardown
      }
    }
    // Best-effort: on Windows the postmaster we just stopped releases its
    // handles asynchronously, so an immediate recursive remove loses the
    // race and throws EPERM. Every assertion has already run by here, so a
    // temp directory we cannot delete yet is noise in %TEMP%, not a sync
    // regression — reporting it and exiting on the real result beats
    // crashing a green suite in its teardown.
    for (const d of dirs) {
      const err = rmDirBestEffort(d);
      if (err) console.log(`NOTE  temp cluster dir left behind (still in use): ${d}`);
    }
  }
}

await main();

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
