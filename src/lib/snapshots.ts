// Local snapshots: point-in-time recovery on a local peer (the "time machine").
//
// Three recovery mechanisms already exist and each has a hole:
//
//   • `revisions` — per-item body history. Exact, but only bodies, only one
//     item at a time, and nothing about a row that was deleted outright.
//   • the weekly `pg_dump` to OneDrive — the whole database, exactly, but
//     weekly. Losing six days is the price of using it.
//   • the nightly markdown export — lossy by construction (it is the
//     Sunday-proof fire escape, not a restore path).
//
// This fills the middle: tiered `pg_dump` snapshots of a local peer's own
// embedded cluster, dense in the last few hours and thinning out over weeks,
// from ONE number the owner sets. Purely local, so it is safe on every peer.
//
// The spread arithmetic lives in ./snapshots-plan, which imports nothing from
// node, so the settings island in the browser and CI can both have it. Import
// the numbers from there and the files from here.
//
// RESTORING IS BROWSE-ONLY, deliberately. `scripts/local-snapshot.mts browse`
// opens a snapshot in a throwaway cluster on a spare port so the owner (or
// Claude) can read it and copy things out. Nothing here ever restores over the
// live cluster: on an armed peer every write fires a sync_ops trigger, so
// rewinding in place would replay weeks-old state into production as fresh
// edits. In-place restore stays what it already is — the deliberate,
// documented `npm run local:restore` path, which resets the sync identity.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chooseKeepers } from "@/lib/snapshots-plan";

// EVERY child process in this file is spawned ASYNCHRONOUSLY, and that is the
// whole point of this helper rather than a style preference (2026-09-02,
// ADR-246). `spawnSync` blocks the Node event loop, and Ledgr's app is ONE
// process, so a synchronous `pg_dump` here meant the server answered nobody
// for as long as the dump took: 132 to 160 seconds, every hour, from every
// device. That was the "Ledgr is slow" and "MCP is flaky" complaint all along.
// Anything added here that shells out must await this, never spawn*Sync.
const run = promisify(execFile);

/** Did this command exist and exit 0? Never throws, never blocks the loop. */
async function succeeds(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { encoding: "utf8", timeout: 10_000 });
    return true;
  } catch {
    // missing binary, non-zero exit, or timeout: all "cannot use this one"
    return false;
  }
}

// ── Files on disk ───────────────────────────────────────────────────────────
//
// One file per snapshot, named by the instant it was taken. Colons are illegal
// in a Windows filename, so the ISO time carries dashes and `snapshotTime` puts
// them back. The name stays sortable either way, which is what makes "newest
// first" a string sort rather than a parse.

export function snapshotsDir(supervisorDir: string): string {
  return join(supervisorDir, "snapshots");
}

export function snapshotName(at: Date): string {
  return `${at.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.dump`;
}

/** The instant a snapshot file name encodes, or null if it is not one. */
export function snapshotTime(name: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.dump$/.exec(name);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type Snapshot = { name: string; at: string; ms: number; bytes: number };

/** Every snapshot in `dir`, newest first. A missing directory is none. */
export function listSnapshots(dir: string): Snapshot[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Snapshot[] = [];
  for (const name of names) {
    const at = snapshotTime(name);
    if (!at) continue; // a .part in flight, or something we did not write
    let bytes = 0;
    try {
      bytes = statSync(join(dir, name)).size;
    } catch {
      continue; // vanished between readdir and stat
    }
    out.push({ name, at: at.toISOString(), ms: at.getTime(), bytes });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/** Average size of the snapshots that exist, or null when none do. */
export function averageSnapshotBytes(snapshots: Snapshot[]): number | null {
  if (snapshots.length === 0) return null;
  return Math.round(snapshots.reduce((n, s) => n + s.bytes, 0) / snapshots.length);
}

// ── Taking one, and pruning ─────────────────────────────────────────────────

/**
 * Where `pg_dump` / `pg_restore` actually are.
 *
 * The embedded-postgres packages ship the SERVER only (`postgres`, `initdb`,
 * `pg_ctl`, and nothing else), so the client tools are a genuine external
 * dependency here, exactly as they already are for restoring a backup file
 * (`scripts/local-restore.mjs`). install.ps1 installs them and knows to look in
 * Program Files when winget did not touch PATH; this is the same lookup, so a
 * peer set up by the installer finds them with no PATH work.
 */
export async function findPgTool(tool: string): Promise<string | null> {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  if (await succeeds(exe, ["--version"])) return exe;
  const roots =
    process.platform === "win32"
      ? ["C:/Program Files/PostgreSQL", "C:/Program Files (x86)/PostgreSQL"]
      : ["/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin", "/usr/lib/postgresql"];
  const candidates: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      // not a version root; it may be a bin directory itself
    }
    for (const e of entries) candidates.push(join(root, e, "bin", exe));
    candidates.push(join(root, exe));
  }
  // Newest version first: a client must be at least the server's major.
  for (const p of candidates.sort().reverse()) {
    if (existsSync(p) && (await succeeds(p, ["--version"]))) return p;
  }
  return null;
}

export const PG_TOOLS_MISSING =
  "The Postgres client tools are not installed, and the embedded database ships the " +
  "server only. Install them (Windows: winget install PostgreSQL.PostgreSQL.18; " +
  "macOS: brew install libpq) and snapshots start on the next hour.";

/**
 * Dump the local cluster to a new snapshot file. Writes to `.part` and renames,
 * so a dump interrupted halfway (a reboot, a full disk) leaves something the
 * listing ignores rather than a truncated file that looks like a restore point.
 *
 * No stop, no lock: pg_dump takes a consistent snapshot of a running cluster by
 * design, which is the whole reason this can be hourly.
 */
export async function takeSnapshot(opts: {
  dbUrl: string;
  dir: string;
  at?: Date;
  pgDump?: string | null;
}): Promise<{ name: string; bytes: number }> {
  const pgDump = opts.pgDump === undefined ? await findPgTool("pg_dump") : opts.pgDump;
  if (!pgDump) throw new Error(PG_TOOLS_MISSING);
  mkdirSync(opts.dir, { recursive: true });
  const name = snapshotName(opts.at ?? new Date());
  const partial = join(opts.dir, `.${name}.part`);
  const final = join(opts.dir, name);
  // zstd at its cheapest level, measured against the live production database
  // on 2026-09-02 (the hub is a laptop that serves pages while it dumps, so the
  // cost of an hourly snapshot is not academic):
  //
  //   default (gzip:6)  39s → 304 MB     zstd:1  10s → 287 MB
  //   gzip:1            19s → 361 MB     lz4:1   10s → 472 MB
  //
  // Four times faster AND smaller than the default, so there is no trade to
  // weigh. zstd needs pg_dump 16+, which costs nothing here: the client must
  // already be at least the server's major (see findPgTool) and the embedded
  // server is 18, so any pg_dump able to read this cluster can write this file.
  try {
    await run(
      pgDump,
      [
        "--format=custom",
        "--compress=zstd:1",
        "--no-owner",
        "--no-privileges",
        "-f",
        partial,
        opts.dbUrl,
      ],
      // Awaited, not synchronous: see the note on `run` at the top of this file.
      // pg_dump writes the archive to `-f`, so its own output is warnings only.
      { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 }
    );
  } catch (err) {
    try {
      rmSync(partial, { force: true });
    } catch {
      // the dump failing is the news; a leftover .part is ignored by listing
    }
    const e = err as { stderr?: string; message?: string };
    const why = (e.stderr || e.message || "unknown failure").trim();
    throw new Error(`pg_dump failed: ${why.slice(0, 300)}`);
  }
  renameSync(partial, final);
  return { name, bytes: statSync(final).size };
}

/** Delete the snapshots the plan does not keep. Returns what was removed. */
export function pruneSnapshots(dir: string, keep: number): string[] {
  const snaps = listSnapshots(dir);
  const keepers = chooseKeepers(
    snaps.map((s) => s.ms),
    keep
  );
  const removed: string[] = [];
  for (const s of snaps) {
    if (keepers.has(s.ms)) continue;
    try {
      rmSync(join(dir, s.name), { force: true });
      removed.push(s.name);
    } catch {
      // a locked file (a browse session reading it) survives to the next prune
    }
  }
  return removed;
}
