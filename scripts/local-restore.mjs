// Fill the LOCAL embedded Postgres with initial data — the first-fill path
// for a new hub/spoke peer (LH2, ADR-206). Two sources:
//
//   npm run local:restore -- /path/to/ledgr-YYYY-MM-DD.dump [/path/to/config.json]
//   npm run local:restore -- --from-url <Neon connection string, pooled or direct> [/path/to/config.json]
//
// The dump form restores the backup workflow's custom-format file (pg_dump
// -Fc --no-owner --no-privileges, .github/workflows/backup.yml), pulled from
// OneDrive /Ledgr/Backups/, via `pg_restore` — that format genuinely needs
// the Postgres client tools, since it's pg_dump's own portable-DDL wrapper
// around the data.
//
// The --from-url form needs none of that. Its schema comes from running our
// OWN migrations (scripts/migrate.mjs) against the fresh local database, the
// same as `npm run local:setup`'s start-empty path — so pg_dump's one hard
// job (emitting portable schema DDL) never has to happen at all. What's left
// is copying ROWS between two Postgres databases of a schema we control,
// which scripts/lib/pg-copy.mjs does natively with the `pg` driver we
// already ship as a runtime dependency. Zero extra tools, zero PATH setup.
// Order: start the embedded cluster → drop/recreate the local `ledgr`
// database → migrate it → copy every table's rows (skipping the ones a
// spoke must never clone: sync_ops, sync_peers, sync_device) → clear the
// per-instance job_state rows, which were the HUB's, not this peer's: the
// sync cursors and the `sync:mode` push-mode override.
// sync_device is never in that copy set, and migrating a fresh database
// already self-assigns this peer its own device identity (migration 0054's
// seed insert) — so there is nothing left to "replace" the way the dump path
// still has to.
//
// The dump form still needs `pg_restore` on PATH:
// Windows: winget install PostgreSQL.PostgreSQL.18 (or the zip binaries);
// macOS: brew install libpq (then follow its PATH caveat).
// The --from-url form needs nothing beyond `npm ci` (the `pg` driver ships
// with the app itself).
//
// SAFETY: the RESTORE half never reads DATABASE_URL and only ever connects
// to 127.0.0.1 on the configured local port, so it cannot touch Neon. The
// --from-url form's one exception is the read side of the copy: it opens a
// single connection to whatever host the caller passes on the command line
// and only ever issues SELECTs against it (see copyAllTables in pg-copy.mjs)
// — never a write. That connection string is never written to config.json,
// never logged, and redacted out of any error text (see
// redactConnectionString below). Unlike pg_dump, an ordinary pooled
// connection reads rows just fine, so a `-pooler` hostname is now ACCEPTED
// rather than refused — pg_dump's multi-connection, session-state-dependent
// needs (the old reason for the refusal) simply don't apply to plain SELECTs.
// Stop the supervisor before running either form (the cluster can't be
// started twice).
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");
const { normalizeConfig, buildDbUrl, tunedPostgresFlags } = await import(new URL("../supervisor/lib.mjs", import.meta.url));
const { redactConnectionString } = await import(new URL("./local-setup-lib.mjs", import.meta.url));
const { copyAllTables } = await import(new URL("./lib/pg-copy.mjs", import.meta.url));

const USAGE =
  "usage: npm run local:restore -- /path/to/ledgr-YYYY-MM-DD.dump [/path/to/config.json]\n" +
  "   or: npm run local:restore -- --from-url <Neon connection string, pooled or direct> [/path/to/config.json]";

function fail(msg) {
  throw new Error(msg);
}

/** Start the embedded cluster at cfg.dataDir (initdb on first run). Shared
 * by both fill modes — the one description of "bring the local cluster up".
 * Returns { cluster, pg } (the constructed EmbeddedPostgres instance and the
 * `pg` module); the caller owns calling cluster.stop() when done. */
async function startCluster(cfg) {
  const requireFromRepo = createRequire(join(repoDir, "package.json"));
  const EmbeddedPostgres = (await import(pathToFileURL(requireFromRepo.resolve("embedded-postgres")).href)).default;
  const pg = (await import(pathToFileURL(requireFromRepo.resolve("pg")).href)).default;

  const pgDir = join(cfg.dataDir, "pg");
  mkdirSync(cfg.dataDir, { recursive: true });
  const cluster = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: "postgres",
    password: "postgres",
    port: cfg.dbPort,
    persistent: true,
    // Windows initdb inherits the OS locale, which yields a WIN1252 cluster
    // that cannot store the arrows, curly quotes, em dashes and emoji real
    // Ledgr bodies are full of (it failed on a migration comment first).
    // ICU gives linguistic collation (Apple < Ärger < banana), matching what
    // Neon does and what a person expects, independent of the OS codepage.
    // The libc --locale stays C because Windows libc locales are codepage
    // based; ICU owns collation, so that no longer costs anything.
    initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=en-US", "--locale=C"],
    // Same RAM-sized settings the supervisor runs with (ADR-215), so the
    // restore's own VACUUM ANALYZE and bulk copy get the tuned memory too.
    postgresFlags: tunedPostgresFlags(cfg, totalmem()),
  });
  if (!existsSync(join(pgDir, "PG_VERSION"))) {
    console.log("First run: initdb…");
    await cluster.initialise();
  }
  try {
    await cluster.start();
  } catch (err) {
    fail(
      `could not start the local Postgres (is the supervisor still running? stop it first): ${err instanceof Error ? err.message : err}`
    );
  }
  return { cluster, pg };
}

/**
 * What this machine WAS, read before the fill wipes it.
 *
 * A fill gives this peer a brand-new `sync_device` identity, deliberately — it
 * must not inherit the source's. But job ownership (ADR-218) and the roster
 * (ADR-220) are keyed by that identity, so without this the machine comes back
 * as a STRANGER: its claimed jobs point at an id nothing answers to, and the
 * roster shows a ghost beside a newcomer. Re-filling a peer is a documented,
 * expected operation, so it must not quietly cost the owner their settings.
 *
 * Best-effort: no database yet (a first fill) means there is nothing to carry.
 */
async function readPriorIdentity(pg, cfg) {
  const db = new pg.Client({ connectionString: buildDbUrl(cfg), connectionTimeoutMillis: 4000 });
  try {
    await db.connect();
    const dev = await db.query("select id from sync_device limit 1");
    const deviceId = dev.rows[0]?.id ?? null;
    if (!deviceId) return null;
    let label = null;
    try {
      const row = await db.query("select label from installs where id = $1", [deviceId]);
      label = row.rows[0]?.label ?? null;
    } catch {
      // A database from before the roster existed. The id alone is still worth
      // carrying: it is what job ownership points at.
    }
    return { deviceId, label };
  } catch {
    return null;
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * Re-attach this machine's identity after a fill: keep its name in the roster,
 * and re-point any job it owned at its new id.
 *
 * Rewriting the roster row's id (rather than inserting a second row) is what
 * makes the list show continuity instead of a ghost plus a newcomer.
 */
async function carryIdentityForward(db, prior) {
  if (!prior) return;
  const dev = await db.query("select id from sync_device limit 1");
  const newId = dev.rows[0]?.id;
  if (!newId || newId === prior.deviceId) return;

  let movedRoster = false;
  try {
    const res = await db.query("update installs set id = $1 where id = $2", [
      newId,
      prior.deviceId,
    ]);
    movedRoster = res.rowCount > 0;
  } catch {
    // No installs table on this database yet; nothing to move.
  }

  // Job ownership lives in users.settings.jobOwners, keyed by device id.
  const users = await db.query("select id, settings from users");
  let movedJobs = 0;
  for (const row of users.rows) {
    const settings = row.settings;
    const owners = settings?.jobOwners;
    if (!owners || typeof owners !== "object") continue;
    let changed = false;
    for (const [job, claim] of Object.entries(owners)) {
      if (claim && typeof claim === "object" && claim.deviceId === prior.deviceId) {
        owners[job] = { ...claim, deviceId: newId };
        changed = true;
        movedJobs += 1;
      }
    }
    if (changed) {
      await db.query("update users set settings = $1 where id = $2", [settings, row.id]);
    }
  }

  if (movedRoster || movedJobs > 0) {
    console.log(
      `Kept this machine's identity: ${movedRoster ? `name "${prior.label}"` : "roster row not found"}` +
        `${movedJobs > 0 ? `, and ${movedJobs} scheduled job(s) still assigned here` : ""}.`
    );
  }
}

/** Clean slate: drop and recreate the local `ledgr` database so a fill never
 * merges into leftovers. Shared by both fill modes. */
async function resetLocalDatabase(pg, cfg) {
  const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${cfg.dbPort}/postgres`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query("drop database if exists ledgr with (force)");
  // The cluster is UTF8 with ICU collation by construction (see initdbFlags),
  // so a plain CREATE DATABASE inherits both. There is deliberately NO
  // template0 fallback for a legacy non-UTF8 cluster: the assert below fails
  // loudly instead, and re-initdb is one deleted directory away. Windows
  // initdb used to inherit the OS locale and produce a WIN1252 cluster, which
  // cannot store the arrows, curly quotes, em dashes or emoji real Ledgr
  // bodies contain.
  await admin.query("create database ledgr");
  // Assert rather than assume: a silently non-UTF8 database corrupts body text
  // on write, and the failure would surface much later as mangled characters.
  const enc = await admin.query(
    "select pg_encoding_to_char(encoding) as enc from pg_database where datname = 'ledgr'"
  );
  if (enc.rows[0]?.enc !== "UTF8") {
    await admin.end();
    fail(
      `local database came up as ${enc.rows[0]?.enc ?? "unknown"}, not UTF8, so it cannot hold real body text ` +
        `(arrows, curly quotes, em dashes, emoji). This means the cluster predates the UTF8 fix: ` +
        `stop the supervisor, delete ${cfg.dataDir}, and re-run to get a clean UTF8 + ICU cluster.`
    );
  }
  await admin.end();
}

/** Restore an already-produced custom-format dump file into the local
 * cluster. Throws on any failure; the caller decides how to report and
 * clean up. */
async function restoreFromFile(dumpPath, cfg) {
  // A custom-format dump starts with the magic bytes PGDMP (same loud check
  // the backup workflow makes at dump time).
  {
    const fd = openSync(dumpPath, "r");
    const head = Buffer.alloc(5);
    readSync(fd, head, 0, 5, 0);
    closeSync(fd);
    if (head.toString("latin1") !== "PGDMP") {
      fail(`${dumpPath} is not a pg_dump custom-format file (no PGDMP magic).`);
    }
  }

  const restoreCheck = spawnSync("pg_restore", ["--version"], { encoding: "utf8" });
  if (restoreCheck.status !== 0) {
    fail(
      "pg_restore is not on PATH. Install the Postgres client tools:\n" +
        "  Windows: winget install PostgreSQL.PostgreSQL.18\n" +
        "  macOS:   brew install libpq && brew link --force libpq"
    );
  }
  console.log(`Restoring ${dumpPath}\n  into the local cluster at ${cfg.dataDir} (port ${cfg.dbPort})`);

  const { cluster, pg } = await startCluster(cfg);

  try {
    const dbUrl = buildDbUrl(cfg);
    const prior = await readPriorIdentity(pg, cfg);
    await resetLocalDatabase(pg, cfg);

    console.log("pg_restore…");
    const restore = spawnSync(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", "-d", dbUrl, dumpPath],
      { stdio: "inherit" }
    );
    if (restore.status !== 0) fail("pg_restore failed");

    console.log("Migrating to the bundled journal version…");
    const mig = spawnSync(process.execPath, [join(repoDir, "scripts", "migrate.mjs")], {
      cwd: repoDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    if (mig.status !== 0) fail("migrate failed");

    console.log("Clearing cloned sync state (fresh device identity)…");
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query("truncate sync_ops");
    await db.query("delete from sync_device");
    // Re-run the 0054 seed insert: a fresh identity self-assigns.
    await db.query(
      "insert into sync_device (id) select gen_random_uuid() where not exists (select 1 from sync_device)"
    );
    await db.query("truncate sync_peers");
    // Cursors AND the push-mode override: both are per-instance job_state, and
    // job_state is inside the copy set, so a fill would otherwise adopt the
    // SOURCE's values. A cloned cursor makes a spoke skip ops; a cloned mode
    // silently arms or disarms push on a peer that never asked for it.
    await db.query("delete from job_state where key like 'sync:cursor:%' or key = 'sync:mode'");
    await carryIdentityForward(db, prior);
    await analyzeAfterFill(db);
    await db.end();

    console.log(
      "\nRestore complete. Start the peer with `npm run local:supervisor`.\n" +
        "If this peer syncs against a hub, its first pull/push cycle reconciles\n" +
        "everything newer than the backup — expect a burst of ops, then steady state."
    );
  } finally {
    try {
      await cluster.stop();
    } catch {
      // best-effort
    }
  }
}

/**
 * A bulk fill leaves the planner blind and the visibility map empty: with no
 * statistics it believed a 23,470-row items table held 7 rows and chose plans
 * accordingly (the A2 finding — the related panel alone cost 11× the buffers
 * it should have), and with no VACUUM the index-only scans the counts rely on
 * fall back to heap fetches. Autovacuum gets there eventually; a restore that
 * hands over a database that plans correctly from minute one is deterministic
 * plumbing (Principle 3). Measured at 2.4s on a 186MB fill.
 */
async function analyzeAfterFill(db) {
  console.log("VACUUM ANALYZE (planner statistics + visibility map)…");
  await db.query("vacuum analyze");
}

/**
 * The native live pull (THE KEY INSIGHT: no pg_dump needed — see the header
 * comment). Starts the cluster, resets the local database, migrates it to
 * create the schema, then copies every table's rows from `url` into it with
 * scripts/lib/pg-copy.mjs. `url` is read-only throughout: only SELECTs ever
 * run against it (copyAllTables), and only 127.0.0.1 is ever written to.
 * Any pooled OR direct Neon connection string works — see the header comment
 * for why the old pg_dump-only `-pooler` refusal doesn't apply here.
 */
async function pullFromUrl(url, cfg) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    fail("--from-url is not a valid connection string (couldn't parse a hostname from it).");
  }
  console.log(`Pulling from ${hostname} ...`);

  const { cluster, pg } = await startCluster(cfg);
  try {
    const prior = await readPriorIdentity(pg, cfg);
    await resetLocalDatabase(pg, cfg);
    const dbUrl = buildDbUrl(cfg);

    console.log("Migrating to the bundled journal version (creates the schema)…");
    const mig = spawnSync(process.execPath, [join(repoDir, "scripts", "migrate.mjs")], {
      cwd: repoDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    if (mig.status !== 0) fail("migrate failed");

    console.log("Copying rows…");
    const source = new pg.Client({ connectionString: url });
    const dest = new pg.Client({ connectionString: dbUrl });
    try {
      await source.connect();
      await dest.connect();
      await copyAllTables(source, dest, { log: console.log });
    } catch (err) {
      // Never let a raw pg error (which can echo the connection string back
      // in a bad-auth/bad-host message) reach the console unredacted.
      fail(redactConnectionString(err instanceof Error ? err.message : String(err), url));
    } finally {
      await source.end().catch(() => {});
      await dest.end().catch(() => {});
    }

    console.log("Clearing the hub's sync cursors and push mode (this peer starts its own)…");
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    // Same reasoning as the dump path above: per-instance job_state must not
    // be inherited from the source. `sync:mode` is the GUI push-mode override.
    await db.query("delete from job_state where key like 'sync:cursor:%' or key = 'sync:mode'");
    await carryIdentityForward(db, prior);
    await analyzeAfterFill(db);
    await db.end();

    console.log(
      "\nPull complete. Start the peer with `npm run local:supervisor`.\n" +
        "If this peer syncs against a hub, its first pull/push cycle reconciles\n" +
        "everything newer than this pull — expect a burst of ops, then steady state."
    );
  } finally {
    try {
      await cluster.stop();
    } catch {
      // best-effort
    }
  }
}

// ── Args + config ────────────────────────────────────────────────────────────

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { "from-url": { type: "string" } },
    allowPositionals: true,
  }));
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}\n\n${USAGE}`);
  process.exit(1);
}

const fromUrl = values["from-url"];
let dumpPath;
let configPath;
if (fromUrl) {
  configPath = positionals[0] ? resolve(positionals[0]) : join(repoDir, "supervisor", "config.json");
} else {
  if (!positionals[0]) {
    console.error(`ERROR: ${USAGE}`);
    process.exit(1);
  }
  dumpPath = resolve(positionals[0]);
  configPath = positionals[1] ? resolve(positionals[1]) : join(repoDir, "supervisor", "config.json");
}

let exitCode = 0;
try {
  if (!existsSync(configPath)) {
    fail(`no supervisor config at ${configPath} — copy supervisor/config.example.json and edit it first.`);
  }
  const cfg = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")), dirname(configPath));

  if (fromUrl) {
    await pullFromUrl(fromUrl, cfg);
  } else {
    if (!existsSync(dumpPath)) fail(`${dumpPath} does not exist`);
    await restoreFromFile(dumpPath, cfg);
  }
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  exitCode = 1;
}
process.exit(exitCode);
