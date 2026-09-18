// Local snapshots from a terminal: list them, take one, prune, and BROWSE one.
//
//   npm run local:snapshot -- list
//   npm run local:snapshot -- now
//   npm run local:snapshot -- prune
//   npm run local:snapshot -- browse 2026-08-25T14-00-00Z
//
// Any of these takes a config path as the last argument when the peer's config
// is not supervisor/config.json.
//
// The scheduled path is the same work through the same module: the supervisor
// triggers GET /api/machine/snapshot hourly (ADR-214's cron seam) and the app
// calls takeSnapshot + pruneSnapshots. This script exists for the two things a
// schedule cannot do: taking one right now, before something risky, and opening
// an old one to look at.
//
// WHY BROWSE IS THE ONLY RESTORE HERE, and why there is no `restore` verb:
// every write on a peer fires the sync_ops triggers, so restoring an old
// database over the live cluster on an ARMED peer would replay weeks-old rows
// into the hub as fresh edits and last-writer-wins would let them win. Browsing
// opens the dump in a throwaway cluster on a spare port instead, where reading
// it costs nothing and nothing can leak back. In-place restore stays the
// deliberate, documented path it already is: `npm run local:restore`, which
// resets this peer's sync identity on the way through.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chooseKeepers,
  clampKeep,
  describeSpread,
  humanBytes,
  DEFAULT_KEEP,
} from "@/lib/snapshots-plan";
import {
  findPgTool,
  listSnapshots,
  pruneSnapshots,
  snapshotsDir,
  takeSnapshot,
} from "@/lib/snapshots";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");
const requireFromRepo = createRequire(join(repoDir, "package.json"));
const { normalizeConfig, buildDbUrl, tunedPostgresFlags } = await import(
  new URL("../supervisor/lib.mjs", import.meta.url).href
);
const { rmDirBestEffort } = await import(new URL("../supervisor/rm-dir.mjs", import.meta.url).href);

const USAGE = "usage: npm run local:snapshot -- <list|now|prune|browse <time>> [config.json]";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const verb = args[0] ?? "list";
const rest = args.slice(1);
// A trailing .json argument is the config path; anything else belongs to the verb.
const configArg = rest.find((a) => a.endsWith(".json"));
const verbArgs = rest.filter((a) => a !== configArg);
const configPath = resolve(configArg ?? join(repoDir, "supervisor", "config.json"));
if (!existsSync(configPath)) fail(`no config at ${configPath}\n${USAGE}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cfg: any = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")), dirname(configPath));
const dir = snapshotsDir(cfg.dataDir);

/**
 * How many to keep, read from job_state: the same value the settings page
 * writes, so the terminal and the app can never disagree. Connects to the
 * RUNNING cluster; the default stands in when it is not up, since a prune with
 * a guessed policy is worse than one with the documented default.
 */
async function readKeep(): Promise<number> {
  const pg = (await import(pathToFileURL(requireFromRepo.resolve("pg")).href)).default;
  const client = new pg.Client({
    connectionString: buildDbUrl(cfg),
    connectionTimeoutMillis: 4000,
  });
  try {
    await client.connect();
    const res = await client.query("select value from job_state where key = 'snapshots:keep'");
    const stored = res.rows[0]?.value?.keep;
    return stored === undefined || stored === null ? DEFAULT_KEEP : clampKeep(stored);
  } catch {
    console.log(`(database not reachable; using the default of ${DEFAULT_KEEP})`);
    return DEFAULT_KEEP;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Verbs ───────────────────────────────────────────────────────────────────

function printList(keep: number | null): void {
  const snaps = listSnapshots(dir);
  if (snaps.length === 0) {
    console.log(`No snapshots in ${dir}`);
    return;
  }
  const keepers = keep === null ? null : chooseKeepers(snaps.map((s) => s.ms), keep);
  const total = snaps.reduce((n, s) => n + s.bytes, 0);
  console.log(`${snaps.length} snapshots in ${dir} (${humanBytes(total)})\n`);
  for (const s of snaps) {
    const mark = keepers ? (keepers.has(s.ms) ? "keep" : "drop") : "    ";
    const stamp = s.name.replace(/\.dump$/, "");
    console.log(`  ${mark}  ${stamp}  ${new Date(s.at).toLocaleString()}  ${humanBytes(s.bytes)}`);
  }
  if (keep !== null) console.log(`\nKeeping ${keep}: ${describeSpread(keep)}`);
}

/**
 * Clear a scratch cluster left behind by a PREVIOUS browse session, before
 * standing up a new one.
 *
 * Ctrl+C runs the teardown, and that is the documented way to end a session. But
 * anything else — closing the terminal window, a crash, a reboot mid-session,
 * one process killing another (which on Windows Node cannot catch, the same
 * problem ADR-211 solved for the supervisor with a file) — leaves a postmaster
 * still listening on this port and a gigabyte-plus directory behind. Deleting
 * the directory is not enough on its own: the orphaned postmaster still holds
 * files in it, so the removal fails and the next initdb lands on a half-deleted
 * cluster. So stop it first, with the same `pg_ctl` the supervisor uses for its
 * own graceful shutdown, then remove.
 */
function clearStaleScratch(scratch: string, port: number): void {
  if (!existsSync(scratch)) return;
  console.log(`Clearing a scratch cluster left behind by an earlier session (${scratch})…`);
  const pkg = `${process.platform === "win32" ? "windows" : process.platform}-${
    process.arch === "arm64" ? "arm64" : "x64"
  }`;
  try {
    const bin = dirname(dirname(requireFromRepo.resolve(`@embedded-postgres/${pkg}`)));
    const pgCtl = join(bin, "native", "bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
    // -m immediate: nothing in there is worth a clean checkpoint, it is a copy.
    spawnSync(pgCtl, ["stop", "-D", join(scratch, "pg"), "-m", "immediate"], { encoding: "utf8" });
  } catch {
    // No binaries to stop it with; the removal below reports the real problem.
  }
  const err = rmDirBestEffort(scratch);
  if (err) {
    fail(
      `could not remove the old scratch cluster at ${scratch}: ${err}\n` +
        `Something may still be holding it — check for a postgres listening on port ${port}, ` +
        "then delete that directory and try again."
    );
  }
}

async function browse(rawTime: string): Promise<void> {
  const snaps = listSnapshots(dir);
  // Accept the file name, the stamp, or a prefix of either: nobody should have
  // to type seconds to open the snapshot from 2pm.
  const wanted = rawTime.replace(/\.dump$/, "");
  const matches = snaps.filter((s) => s.name.startsWith(wanted));
  if (matches.length === 0) {
    fail(`no snapshot matching "${rawTime}".\nRun \`npm run local:snapshot -- list\` to see them.`);
  }
  // A prefix like "2026-08-25" matches a whole day; the newest is the useful one.
  const snap = matches[0];
  const dumpPath = join(dir, snap.name);

  const pgRestore = await findPgTool("pg_restore");
  if (!pgRestore) {
    fail(
      "pg_restore is not installed, and the embedded database ships the server only.\n" +
        "  Windows: winget install PostgreSQL.PostgreSQL.18\n" +
        "  macOS:   brew install libpq && brew link --force libpq"
    );
  }

  // A throwaway cluster beside the real one: its own directory, its own port,
  // deleted on the way out. Nothing here can touch the live database.
  const port = cfg.dbPort + 1000;
  const scratch = join(cfg.dataDir, "snapshot-browse");
  clearStaleScratch(scratch, port);
  mkdirSync(scratch, { recursive: true });

  const EmbeddedPostgres = (
    await import(pathToFileURL(requireFromRepo.resolve("embedded-postgres")).href)
  ).default;
  const cluster = new EmbeddedPostgres({
    databaseDir: join(scratch, "pg"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: true,
    // Same flags as every other cluster we create (see local-restore.mjs): a
    // WIN1252 cluster cannot hold real Ledgr bodies.
    initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=en-US", "--locale=C"],
    postgresFlags: tunedPostgresFlags(cfg, totalmem()),
  });

  console.log(`Opening ${snap.name} (${humanBytes(snap.bytes)}) in a throwaway cluster…`);
  await cluster.initialise();
  await cluster.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/ledgr`;
  let ok = false;
  try {
    await cluster.createDatabase("ledgr");
    console.log("pg_restore…");
    const res = spawnSync(pgRestore, ["--no-owner", "--no-privileges", "-d", url, dumpPath], {
      stdio: "inherit",
    });
    // Not --exit-on-error: a dump made with a different client version can warn
    // about extensions it cannot recreate while restoring every row we care
    // about. A hard stop there would make an otherwise readable snapshot
    // unopenable, so the exit code is reported and the session continues.
    if (res.status !== 0) console.log("\npg_restore reported problems; the copy may be partial.");
    ok = true;
    console.log(
      "\nReady. This is a COPY: nothing you do here reaches the live database.\n\n" +
        `  ${url}\n\n` +
        `  psql "${url}" -c "select id, title, updated_at from items order by updated_at desc limit 20"\n\n` +
        "Point Claude at that connection string to look around, or copy rows out with\n" +
        "an ordinary INSERT ... SELECT against the live database.\n\n" +
        "Press Ctrl+C when you are done. The copy is deleted on the way out."
    );
    await new Promise<void>((done) => {
      process.on("SIGINT", () => done());
      process.on("SIGTERM", () => done());
    });
  } finally {
    console.log("\nStopping the throwaway cluster…");
    await cluster.stop().catch(() => {});
    const err = rmDirBestEffort(scratch);
    if (err) console.log(`could not delete ${scratch} (delete it by hand): ${err}`);
    if (!ok) process.exitCode = 1;
  }
}

// One catch for the lot: a missing pg_dump, an unreachable cluster or a bad
// snapshot name should read as a sentence, not a stack trace.
try {
  switch (verb) {
    case "list":
      printList(await readKeep());
      break;
    case "now": {
      const keep = await readKeep();
      const { name, bytes } = await takeSnapshot({ dbUrl: buildDbUrl(cfg), dir });
      console.log(`Took ${name} (${humanBytes(bytes)})`);
      const removed = pruneSnapshots(dir, keep);
      if (removed.length > 0) console.log(`Pruned ${removed.length} older snapshot(s).`);
      printList(keep);
      break;
    }
    case "prune": {
      const keep = await readKeep();
      const removed = pruneSnapshots(dir, keep);
      console.log(removed.length === 0 ? "Nothing to prune." : `Pruned ${removed.length}.`);
      printList(keep);
      break;
    }
    case "browse": {
      const at = verbArgs[0];
      if (!at) fail(`browse needs a snapshot time.\n${USAGE}`);
      await browse(at);
      break;
    }
    default:
      fail(`unknown command "${verb}".\n${USAGE}`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
