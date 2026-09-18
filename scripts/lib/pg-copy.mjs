// Native row-copy engine for the local hub's live database pull (ADR-206).
// Used by scripts/local-restore.mjs's --from-url path.
//
// Why this exists instead of pg_dump: pg_dump's hard job is emitting
// portable schema DDL, but a local peer already gets its schema from running
// our own migrations (scripts/migrate.mjs). So a live pull only needs ROWS,
// and copying rows between two Postgres databases of a schema we control is
// a small job with the `pg` driver we already ship as a runtime dependency.
// No pg_dump/pg_restore/psql on PATH required.
//
// Pure helpers are grouped first (exercised without a database by
// scripts/verify-setup.mts); the connected discovery/copy functions follow
// (exercised against two real embedded-postgres clusters by
// scripts/verify-pg-copy.mts).

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Tables that must never be cloned from a hub, even though they are ordinary
// rows in `public`:
//   - sync_ops: the oplog. A pulled peer starts with an empty one.
//   - sync_device: per-peer identity. Migration 0054 already seeds a fresh
//     row for THIS peer the moment it migrates; cloning the hub's would make
//     two peers share one device id and corrupt sync cursoring.
//   - sync_peers: device registrations belong to the hub that minted them.
// drizzle's own migration bookkeeping table lives in the `drizzle` schema,
// not `public` (confirmed against a migrated database), so a public-schema
// catalog query already excludes it without needing to list it here.
export const EXCLUDED_TABLES = new Set(["sync_ops", "sync_peers", "sync_device"]);

export function isCopyableTable(name) {
  return !EXCLUDED_TABLES.has(name);
}

/**
 * How many rows fit in one parameterized multi-row INSERT without crossing
 * Postgres's bound-parameter cap (65535), given the column count. Also
 * capped at `maxRows` (default 500) regardless, so one bad batch doesn't
 * waste much work and pages stay a reasonable memory footprint for wide
 * tables with large bodies.
 */
export function rowsPerBatch(columnCount, { paramCap = 65535, maxRows = 500 } = {}) {
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new Error(`columnCount must be a positive integer, got ${columnCount}`);
  }
  return Math.max(1, Math.min(maxRows, Math.floor(paramCap / columnCount)));
}

/**
 * A parameterized multi-row upsert. `columns` is the insertable column list
 * (generated columns already excluded by the caller).
 *
 * Plain INSERT is not enough: a fresh destination is migrated (not empty)
 * before the copy runs, and migrations seed their own rows into a few
 * synced tables — the system `types` (ON CONFLICT DO NOTHING, still a real
 * row) and the singleton `sync_schema_ver` (WHERE NOT EXISTS, same idea). A
 * plain INSERT of the source's matching row would hit a primary-key
 * conflict on exactly those rows. ON CONFLICT (pk) DO UPDATE makes the
 * source's row win instead, which is also what makes a second full pull
 * idempotent rather than an error.
 *
 * When `conflictColumn` is omitted (a table with no usable single-column
 * PK), this falls back to a plain INSERT — the same rare-case fallback
 * copyTable already documents for paging.
 *
 * @param {string} table
 * @param {string[]} columns
 * @param {number} rowCount
 * @param {string | null} [conflictColumn]
 */
export function buildInsertSql(table, columns, rowCount, conflictColumn = null) {
  if (rowCount < 1) throw new Error("rowCount must be >= 1");
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    const base = r * columns.length;
    rows.push(`(${columns.map((_, i) => `$${base + i + 1}`).join(", ")})`);
  }
  let sql = `insert into "${table}" (${colList}) values ${rows.join(", ")}`;
  if (conflictColumn) {
    const others = columns.filter((c) => c !== conflictColumn);
    sql +=
      others.length > 0
        ? ` on conflict ("${conflictColumn}") do update set ${others.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`
        : ` on conflict ("${conflictColumn}") do nothing`;
  }
  return sql;
}

/** Keyset page queries for a single-column PK, reading only the given
 * columns (skips generated columns, and skips reading large derived columns
 * like items.search that are never written back). */
export function buildPageQuery(table, columns, pkColumn, pageSize) {
  const colList = columns.map((c) => `"${c}"`).join(", ");
  return {
    firstText: `select ${colList} from "${table}" order by "${pkColumn}" limit ${pageSize}`,
    text: `select ${colList} from "${table}" where "${pkColumn}" > $1 order by "${pkColumn}" limit ${pageSize}`,
  };
}

/** A full read for a table with no usable single-column PK. */
export function buildFullReadQuery(table, columns) {
  const colList = columns.map((c) => `"${c}"`).join(", ");
  return `select ${colList} from "${table}"`;
}

/** setval SQL that realigns a sequence past the highest copied value.
 * COALESCE to 1 covers the empty-table case (setval refuses a value < 1). */
export function buildSetvalSql(seqName, table, column) {
  return `select setval('${seqName}', coalesce((select max("${column}") from "${table}"), 1))`;
}

// ── Connected discovery ──────────────────────────────────────────────────────
// `client` just needs an async query(text, params) method for these — a
// pg.Client or pg.Pool both qualify. copyAllTables below is pickier (see its
// own comment): its `dest` must be a single dedicated pg.Client, never a
// Pool, because SET session_replication_role has to hold across every insert
// in the copy, and a Pool can silently hand out a different connection per
// query.

/**
 * Ordinary base tables in the public schema, minus EXCLUDED_TABLES.
 * information_schema.tables is schema-scoped, so drizzle's
 * `drizzle.__drizzle_migrations` bookkeeping table is never in this list.
 */
export async function listCopyableTables(client) {
  const res = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`
  );
  return res.rows.map((r) => r.table_name).filter((t) => isCopyableTable(t));
}

/** Insertable columns for a table: every ordinary column minus any
 * GENERATED ALWAYS ones (e.g. items.search) — Postgres computes those
 * itself and refuses an explicit value for them. */
export async function insertableColumns(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 and is_generated <> 'ALWAYS'
     order by ordinal_position`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

/** The table's single-column primary key, or null when it has none or a
 * composite one (copyTable then falls back to a full read). */
export async function primaryKeyColumn(client, table) {
  const res = await client.query(
    `select a.attname
     from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = $1::regclass and i.indisprimary`,
    [table]
  );
  return res.rows.length === 1 ? res.rows[0].attname : null;
}

/** Every (column, sequence) pair among `columns` whose sequence needs
 * resetting after a bulk copy (serial/identity columns) — discovered from
 * the catalog, never hardcoded. */
export async function serialColumns(client, table, columns) {
  const out = [];
  for (const column of columns) {
    const res = await client.query("select pg_get_serial_sequence($1, $2) as seq", [table, column]);
    const seq = res.rows[0]?.seq;
    if (seq) out.push({ column, seq });
  }
  return out;
}

// ── Copy ──────────────────────────────────────────────────────────────────

/**
 * A jsonb/json column reads back from `pg` as an already-parsed JS value —
 * which, for a column whose top-level shape is an ARRAY (e.g. types'
 * property_schema, an ordered PropertyDef[]), is a plain JS array. `pg`'s own
 * parameter serialization special-cases Array.isArray BEFORE its generic
 * object handling and turns it into a Postgres ARRAY literal ("{a,b}"), not
 * JSON text — exactly wrong for a jsonb column. Stringifying every object
 * (arrays included) ourselves sidesteps that ambiguity entirely; Postgres
 * parses the resulting text back into jsonb on insert. Dates and Buffers
 * pass through untouched so timestamp/bytea columns still work. Schema
 * currently has no genuine native array column (grep for pgTable + .array()
 * confirms it), so nothing is left for `pg`'s array literal path to serve.
 */
function toParam(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Copy one table's rows, source -> dest, in keyset pages ordered by a
 * single-column PK. Falls back to one full read for a table with no such PK
 * (none in today's schema hits this path).
 * ponytail: the full-read fallback has no row ceiling beyond available
 * memory; add real ctid-keyset paging if a PK-less table ever shows up.
 * Returns the row count copied.
 */
export async function copyTable(source, dest, table, { pageSize = 500 } = {}) {
  // The destination's catalog is authoritative for shape: it just ran our
  // own migrations, so this is the schema both databases are meant to share.
  const columns = await insertableColumns(dest, table);
  if (columns.length === 0) return 0;
  const batchSize = rowsPerBatch(columns.length, { maxRows: pageSize });
  const pk = await primaryKeyColumn(dest, table);

  let total = 0;

  const insertPage = async (rows) => {
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const values = [];
      for (const row of chunk) for (const col of columns) values.push(toParam(row[col]));
      await dest.query(buildInsertSql(table, columns, chunk.length, pk), values);
    }
    total += rows.length;
  };

  if (!pk) {
    const res = await source.query(buildFullReadQuery(table, columns));
    if (res.rows.length > 0) await insertPage(res.rows);
    return total;
  }

  const { firstText, text } = buildPageQuery(table, columns, pk, pageSize);
  let cursor = null;
  for (;;) {
    const res = cursor === null ? await source.query(firstText) : await source.query(text, [cursor]);
    if (res.rows.length === 0) break;
    await insertPage(res.rows);
    if (res.rows.length < pageSize) break;
    cursor = res.rows[res.rows.length - 1][pk];
  }
  return total;
}

/**
 * Copy every table's rows from `source` to `dest`. Both must be a single
 * already-connected pg.Client, NOT a pg.Pool: the SET below has to hold for
 * the whole copy, and a pool can quietly serve a different underlying
 * connection to each query, silently losing that session state partway
 * through. SOURCE IS READ-ONLY: only the SELECTs above ever run against it,
 * never a write.
 *
 * Wraps the whole copy in `session_replication_role = replica` on `dest`.
 * This is the load-bearing trick: it disables both foreign-key enforcement
 * AND ordinary user triggers on the destination, so (a) tables can be
 * copied in any order with no dependency sort, and (b) migration 0054's
 * sync triggers do not fire and log a sync_ops row for every copied row —
 * verified empirically in scripts/verify-pg-copy.mts (sync_ops is empty
 * after a copy). Reset to `origin` in a finally either way.
 */
export async function copyAllTables(source, dest, { log = () => {}, pageSize = 500 } = {}) {
  const tables = await listCopyableTables(source);
  log(`Copying ${tables.length} tables: ${tables.join(", ")}`);

  await dest.query("set session_replication_role = replica");
  let total = 0;
  try {
    for (const table of tables) {
      const n = await copyTable(source, dest, table, { pageSize });
      total += n;
      log(`  ${table}: ${n.toLocaleString()} rows`);
    }
  } finally {
    await dest.query("set session_replication_role = origin");
  }
  log(`Total: ${total.toLocaleString()} rows across ${tables.length} tables`);

  for (const table of tables) {
    const columns = await insertableColumns(dest, table);
    const serials = await serialColumns(dest, table, columns);
    for (const { column, seq } of serials) {
      await dest.query(buildSetvalSql(seq, table, column));
    }
  }

  return { tables, total };
}
