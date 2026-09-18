// Verification for local snapshots (the "time machine").
//
// PURE by construction, like verify-supervisor.mts: the spread arithmetic and
// the prune decision live in src/lib/snapshots-plan.ts precisely so they can be
// exercised with no cluster, no dump and no disk. The parts that DO touch the
// world (pg_dump, pg_restore, the scratch cluster) stay thin and are proven by
// running them on the rig.
//
// The prune decision is the dangerous code here: it deletes files. So the cases
// below are the ones that would silently destroy history — a gap in the record,
// a lowered budget, several snapshots inside one hour — plus the invariant that
// matters most, that the newest snapshot always survives.
//
// Run: npx tsx scripts/verify-snapshots.mts
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chooseKeepers,
  clampKeep,
  describeSpread,
  DEFAULT_KEEP,
  DUMP_COMPRESSION_RATIO,
  estimateSnapshotBytes,
  humanBytes,
  humanSpan,
  MAX_KEEP,
  MIN_KEEP,
  planSpanMs,
  tierPlan,
  TIERS,
} from "@/lib/snapshots-plan";
import {
  averageSnapshotBytes,
  listSnapshots,
  pruneSnapshots,
  snapshotName,
  snapshotTime,
  takeSnapshot,
} from "@/lib/snapshots";

const HOUR = 3_600_000;
let checks = 0;
function ok(what: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`  ✓ ${what}`);
}

// The dump is asynchronous now (ADR-246: a synchronous pg_dump froze the whole
// single-process server for the length of the dump), so the checks that drive
// it need to await. Kept as a second helper rather than making `ok` async,
// which would mean awaiting all two dozen pure checks that have no need of it.
async function okAsync(what: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${what}`);
}

console.log("Snapshot spread and prune decisions\n");

// ── The knob ────────────────────────────────────────────────────────────────

ok("clampKeep floors, ceilings, rounds, and defaults on nonsense", () => {
  assert.equal(clampKeep(30), 30);
  assert.equal(clampKeep(0), MIN_KEEP);
  assert.equal(clampKeep(-5), MIN_KEEP);
  assert.equal(clampKeep(10_000), MAX_KEEP);
  assert.equal(clampKeep(12.6), 13);
  assert.equal(clampKeep("nope"), DEFAULT_KEEP);
  assert.equal(clampKeep(undefined), DEFAULT_KEEP);
  assert.equal(clampKeep(null), DEFAULT_KEEP);
});

ok("a plan spends the budget exactly — the number typed is the files on disk", () => {
  for (const keep of [MIN_KEEP, 5, 7, 10, 24, 30, 31, 60, 99, 100, 365, MAX_KEEP]) {
    const plan = tierPlan(keep);
    const total = plan.reduce((n, t) => n + t.count, 0);
    assert.equal(total, keep, `keep=${keep} planned ${total}`);
    assert.equal(plan.length, TIERS.length);
    for (const t of plan) assert.ok(t.count >= 1, `keep=${keep} starved a tier`);
  }
});

ok("a plan below the tier count is raised rather than starving a tier", () => {
  const plan = tierPlan(1);
  assert.equal(
    plan.reduce((n, t) => n + t.count, 0),
    MIN_KEEP
  );
});

ok("more snapshots always reach further back", () => {
  let previous = 0;
  for (const keep of [MIN_KEEP, 10, 20, 30, 60, 120, 240, MAX_KEEP]) {
    const span = planSpanMs(tierPlan(keep));
    assert.ok(span > previous, `keep=${keep} did not extend the window`);
    previous = span;
  }
});

ok("the default keeps roughly three weeks, dense at the top", () => {
  const plan = tierPlan(DEFAULT_KEEP);
  // Densest tier gets the most, and the whole thing reaches past a fortnight.
  assert.ok(plan[0].count >= plan[3].count);
  assert.ok(planSpanMs(plan) > 14 * 24 * HOUR, "the default does not reach two weeks");
  assert.ok(planSpanMs(plan) < 60 * 24 * HOUR, "the default reaches implausibly far");
});

// ── The words on the page ───────────────────────────────────────────────────

ok("humanSpan says what a person would say", () => {
  assert.equal(humanSpan(HOUR), "an hour");
  assert.equal(humanSpan(11 * HOUR), "11 hours");
  assert.equal(humanSpan(48 * HOUR), "2 days");
  assert.equal(humanSpan(7 * 24 * HOUR), "a week");
  assert.equal(humanSpan(21 * 24 * HOUR), "3 weeks");
});

ok("describeSpread names every tier and the total, in the house prose style", () => {
  const text = describeSpread(DEFAULT_KEEP);
  for (const t of TIERS) assert.ok(text.includes(t.label), `missing tier "${t.label}"`);
  assert.ok(text.includes("About "), "no total");
  // House style (CLAUDE.md): no em dashes in prose. This string is assembled
  // and shown to the owner, so the rule applies to it as much as to a doc.
  assert.ok(!text.includes("—"), `em dash in "${text}"`);
});

ok("humanBytes scales and never prints a raw float", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(999), "999 B");
  assert.equal(humanBytes(1_000), "1.0 KB");
  assert.equal(humanBytes(240_000_000), "240 MB");
  assert.equal(humanBytes(2_400_000_000), "2.4 GB");
  assert.equal(humanBytes(Number.NaN), "unknown");
});

ok("the size estimate is the stated ratio, and averaging beats estimating", () => {
  assert.equal(estimateSnapshotBytes(1_000_000_000), 1_000_000_000 * DUMP_COMPRESSION_RATIO);
  assert.equal(averageSnapshotBytes([]), null);
  assert.equal(
    averageSnapshotBytes([
      { name: "a", at: "", ms: 1, bytes: 100 },
      { name: "b", at: "", ms: 2, bytes: 300 },
    ]),
    200
  );
});

// ── File names ──────────────────────────────────────────────────────────────

ok("a snapshot name round-trips through a Windows-legal file name", () => {
  const at = new Date("2026-08-25T14:03:07.512Z");
  const name = snapshotName(at);
  assert.ok(!name.includes(":"), "a colon cannot appear in a Windows file name");
  assert.equal(name, "2026-08-25T14-03-07Z.dump");
  assert.equal(snapshotTime(name)?.toISOString(), "2026-08-25T14:03:07.000Z");
});

ok("names sort chronologically as plain strings", () => {
  const names = [
    snapshotName(new Date("2026-08-25T09:00:00Z")),
    snapshotName(new Date("2026-08-25T14:00:00Z")),
    snapshotName(new Date("2026-09-01T00:00:00Z")),
  ];
  assert.deepEqual([...names].sort(), names);
});

ok("anything that is not one of ours is not a snapshot", () => {
  assert.equal(snapshotTime(".2026-08-25T14-00-00Z.dump.part"), null);
  assert.equal(snapshotTime("ledgr-2026-08-25.dump"), null);
  assert.equal(snapshotTime("2026-08-25T14-00-00Z.dump.bak"), null);
  assert.equal(snapshotTime("notes.txt"), null);
});

// ── The prune decision ──────────────────────────────────────────────────────

/** `count` timestamps, one every `stepMs`, newest at `now`. */
function series(now: number, count: number, stepMs: number): number[] {
  return Array.from({ length: count }, (_, i) => now - i * stepMs);
}

// Deliberately not on the hour: a bucket boundary would make "three dumps in
// the same hour" accidentally land in three different buckets.
const NOW = Date.parse("2026-08-25T12:30:00Z");

ok("nothing is deleted while there is room", () => {
  const times = series(NOW, 12, HOUR);
  assert.equal(chooseKeepers(times, 30).size, 12);
});

ok("the newest snapshot always survives", () => {
  for (const keep of [MIN_KEEP, 10, 30, 100]) {
    for (const step of [HOUR / 4, HOUR, 6 * HOUR, 30 * HOUR]) {
      const times = series(NOW, 200, step);
      assert.ok(chooseKeepers(times, keep).has(NOW), `keep=${keep} step=${step} dropped the newest`);
    }
  }
});

ok("an hourly stream thins to exactly the budget", () => {
  // 60 days of hourly dumps: far more than any plan keeps.
  const times = series(NOW, 24 * 60, HOUR);
  for (const keep of [10, 30, 60]) {
    assert.equal(chooseKeepers(times, keep).size, keep, `keep=${keep}`);
  }
});

ok("several dumps inside one hour collapse to one", () => {
  // A rerun, a manual `now`, a retry after a failure: four in the same hour.
  const times = [NOW, NOW - 60_000, NOW - 120_000, NOW - 180_000, NOW - 2 * HOUR];
  const kept = chooseKeepers(times, 30);
  assert.equal(kept.has(NOW), true, "the newest of the hour is the one to keep");
  assert.equal(kept.has(NOW - 60_000), false);
  assert.equal(kept.has(NOW - 2 * HOUR), true);
});

ok("recent snapshots are denser than old ones", () => {
  const times = series(NOW, 24 * 40, HOUR);
  const kept = [...chooseKeepers(times, 30)].sort((a, b) => b - a);
  const newestDay = kept.filter((t) => t > NOW - 24 * HOUR).length;
  const oldestWeek = kept.filter((t) => t < NOW - 21 * 24 * HOUR).length;
  assert.ok(newestDay > oldestWeek, `${newestDay} in the last day vs ${oldestWeek} in the oldest`);
});

ok("a gap in the record does not eat the budget", () => {
  // The machine slept for four days, then ran hourly for twelve hours. A
  // window-walking pruner burns its dense tiers on the empty days and throws
  // away the older history; bucketing keeps both.
  const recent = series(NOW, 12, HOUR);
  const old = series(NOW - 4 * 24 * HOUR, 20, 24 * HOUR);
  const kept = chooseKeepers([...recent, ...old], 30);
  // 32 candidates against a budget of 30, so nearly everything survives: the
  // empty days cost nothing because they have no buckets to spend slots on.
  assert.ok(kept.size >= 26, `the gap collapsed the budget to ${kept.size}`);
  assert.equal(recent.filter((t) => kept.has(t)).length, 12, "recent history was thinned by the gap");
  assert.ok(
    [...kept].some((t) => t < NOW - 18 * 24 * HOUR),
    "the old history was thrown away because of the gap"
  );
});

ok("lowering the budget deletes from the OLD end, never the new", () => {
  const times = series(NOW, 24 * 30, HOUR);
  const wide = [...chooseKeepers(times, 60)].sort((a, b) => b - a);
  const narrow = [...chooseKeepers(times, 10)].sort((a, b) => b - a);
  assert.equal(narrow.length, 10);
  assert.ok(narrow[0] === wide[0], "the newest changed when the budget shrank");
  assert.ok(
    Math.min(...narrow) > Math.min(...wide),
    "a smaller budget somehow reached further back"
  );
});

ok("a single snapshot survives any budget", () => {
  assert.deepEqual([...chooseKeepers([NOW], MIN_KEEP)], [NOW]);
  assert.equal(chooseKeepers([], 30).size, 0);
});

ok("duplicate timestamps are one snapshot, not two", () => {
  assert.equal(chooseKeepers([NOW, NOW, NOW], 30).size, 1);
});

// ── The one part that touches real files ────────────────────────────────────
//
// pruneSnapshots DELETES, so the arithmetic passing is not enough: the listing
// has to agree with the prune about which file is which. Real files in a temp
// directory, no cluster and no database involved.

ok("listing and pruning agree on real files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledgr-snap-"));
  try {
    // 40 hourly snapshots, plus two things that are not snapshots.
    const written = Array.from({ length: 40 }, (_, i) => {
      const name = snapshotName(new Date(NOW - i * HOUR));
      writeFileSync(join(dir, name), "x".repeat(100 + i));
      return name;
    });
    writeFileSync(join(dir, `.${snapshotName(new Date(NOW + HOUR))}.part`), "half a dump");
    writeFileSync(join(dir, "readme.txt"), "not a dump");

    const listed = listSnapshots(dir);
    assert.equal(listed.length, 40, "an in-flight .part or a stray file was counted");
    assert.equal(listed[0].name, written[0], "newest first");
    assert.equal(listed[0].bytes, 100, "size not read");

    const removed = pruneSnapshots(dir, 10);
    assert.equal(removed.length, 30);
    const after = listSnapshots(dir);
    assert.equal(after.length, 10);
    assert.equal(after[0].name, written[0], "the prune deleted the newest snapshot");
    // The .part and the stray file are none of the pruner's business.
    assert.equal(readdirSync(dir).length, 12);
    // Pruning twice is a no-op, not a second round of deletion.
    assert.equal(pruneSnapshots(dir, 10).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

await okAsync("a failed dump leaves no half-file pretending to be a restore point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledgr-snap-"));
  try {
    // No pg_dump at all is a sentence, not a stack trace.
    await assert.rejects(
      () => takeSnapshot({ dbUrl: "postgresql://nowhere/ledgr", dir, pgDump: null }),
      /client tools are not installed/
    );
    // A "pg_dump" that exits non-zero: node itself, handed flags it rejects.
    // The point is the cleanup, not the error text.
    await assert.rejects(
      () =>
        takeSnapshot({
          dbUrl: "postgresql://nowhere/ledgr",
          dir,
          pgDump: process.execPath,
        }),
      /pg_dump failed/
    );
    assert.deepEqual(listSnapshots(dir), [], "a failed dump was listed as a snapshot");
    assert.deepEqual(readdirSync(dir), [], "the partial file was left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

ok("a missing snapshots directory is none, not a crash", () => {
  assert.deepEqual(listSnapshots(join(tmpdir(), "ledgr-snap-does-not-exist")), []);
  assert.deepEqual(pruneSnapshots(join(tmpdir(), "ledgr-snap-does-not-exist"), 30), []);
});

// ── Wiring that has to stay true ────────────────────────────────────────────

// ADR-222 moved the SWITCH out of here. The job is scheduled on every peer that
// asked for nothing, and the endpoint decides whether to dump — which is the
// only way the owner's on/off can be a checkbox rather than a config edit plus a
// service restart. Off-by-default still holds; it just lives in the database.
ok("the supervisor's job catalog carries snapshot, hourly, shared, always scheduled", async () => {
  const lib = await import("../supervisor/lib.mjs");
  const job = lib.LOCAL_JOBS.snapshot;
  assert.ok(job, "no snapshot job in LOCAL_JOBS");
  assert.equal(job.path, "/api/machine/snapshot");
  assert.equal(job.everyMinutes, 60);
  assert.equal(job.shared, true, "a purely local dump is safe on every peer");
  assert.equal(job.on, true, "the GUI switch only works if the job is scheduled to ask");
  assert.ok(job.timeoutMs > 120_000, "a pg_dump needs longer than an API call");
  const def = lib
    .normalizeCrons(undefined)
    .find((j: { name: string }) => j.name === "snapshot");
  assert.ok(def, "a peer that asked for nothing must still schedule the hourly check");
  assert.equal(def.intervalMs, 60 * 60_000);
  assert.equal(def.timeoutMs, job.timeoutMs, "the runner must see the longer timeout");
  // The testing lever survives: an explicit false still schedules nothing.
  assert.equal(
    lib.normalizeCrons({ snapshot: false }).some((j: { name: string }) => j.name === "snapshot"),
    false
  );
});

ok("the endpoint, not the scheduler, is what the owner's switch reaches", () => {
  const src = readFileSync(resolve("src/app/api/machine/snapshot/route.ts"), "utf8");
  assert.match(
    src,
    /readSnapshotsEnabled/,
    "the hourly job must ask whether snapshots are switched on before dumping"
  );
  // The switch is read BEFORE the dump, or it is decoration.
  assert.ok(
    src.indexOf("readSnapshotsEnabled") < src.indexOf("runSnapshot("),
    "the gate must come before the work"
  );

  const api = readFileSync(resolve("src/app/api/snapshots/route.ts"), "utf8");
  assert.match(api, /writeSnapshotsEnabled/, "no way to flip the switch from the app");

  // The whole point: the Snapshots section never sends the owner to a config
  // file. Everything between its heading and the next one is fair game.
  const page = readFileSync(resolve("src/app/build/backups/page.tsx"), "utf8");
  const from = page.indexOf("Snapshots</h2>");
  assert.ok(from > 0, "no Snapshots section on the Backups page");
  const section = page.slice(from);
  assert.doesNotMatch(
    section,
    /config\.json|&quot;snapshot&quot;|"snapshot": true/,
    "the owner must never be sent to a config file to switch restore points on"
  );
});

ok("the cron runner honors a job's own timeout", () => {
  const src = readFileSync(resolve("supervisor/ledgr-supervisor.mjs"), "utf8");
  assert.match(
    src,
    /AbortSignal\.timeout\(job\.timeoutMs \?\? CRON_TIMEOUT_MS\)/,
    "runCronJob ignores job.timeoutMs, so a long dump reports a false failure"
  );
});

ok("both trigger paths take a snapshot through the one runner", () => {
  // The scheduled job and the owner's "Snapshot now" button must be the same
  // act. Two copies of "dump, then prune" is how a manual snapshot quietly
  // stops pruning, or prunes to a different policy.
  const machine = readFileSync(resolve("src/app/api/machine/snapshot/route.ts"), "utf8");
  const owner = readFileSync(resolve("src/app/api/snapshots/route.ts"), "utf8");
  for (const [name, src] of [
    ["the hourly job", machine],
    ["Snapshot now", owner],
  ] as const) {
    assert.match(src, /runSnapshot\(/, `${name} does not call runSnapshot`);
    assert.ok(!/takeSnapshot\(/.test(src), `${name} dumps directly instead of via runSnapshot`);
    assert.match(src, /snapshotTarget\(\)/, `${name} is missing the local-peer gate`);
  }
  assert.match(owner, /export async function POST/, "Snapshot now has no route");
});

ok("the dump never blocks the server's event loop", () => {
  // THE REGRESSION THIS GUARDS (2026-09-02, ADR-246): pg_dump used to run via
  // spawnSync inside the request that triggers it. The app is ONE Node
  // process, so that froze it for the length of the dump: 132 to 160 seconds,
  // every hour, answering nobody from any device. It read as "Ledgr is slow"
  // and "MCP is flaky" for weeks because the machine and network were fine.
  // A synchronous child process anywhere in this file brings that back.
  const src = readFileSync(resolve("src/lib/snapshots.ts"), "utf8");
  for (const banned of ["spawnSync", "execSync", "execFileSync"]) {
    assert.ok(
      !src.includes(`${banned}(`),
      `snapshots.ts calls ${banned}, which freezes the whole server for the dump`
    );
  }
});

ok("nothing restores over the live cluster", () => {
  // The load-bearing safety property: an armed peer's writes fire sync_ops
  // triggers, so an in-place rewind replays old state into the hub. Browsing is
  // the only restore path here, and there must be no `restore` verb to reach for.
  const cli = readFileSync(resolve("scripts/local-snapshot.mts"), "utf8");
  assert.match(cli, /case "browse"/);
  assert.ok(!/case "restore"/.test(cli), "a restore verb appeared; see ADR-217");
  // The scratch cluster must never share the live port.
  assert.match(cli, /cfg\.dbPort \+ 1000/);
});

console.log(`\n${checks} checks passed.`);
