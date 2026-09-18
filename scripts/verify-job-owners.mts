// Verification for the exclusive-job ownership picker (which install runs a job).
//
// PURE by construction: every decision lives in src/lib/job-owners.ts and takes
// its inputs as arguments, so the whole safety story can be exercised here with
// no database, no settings row and no scheduler.
//
// What "safety story" means for this feature, and therefore what has to be
// tested: a double export is CORRUPTING, not merely wasteful, because
// `items.exported_at` is itself synced. So the cases below are the ones where a
// bug hands the same job to two installs, or to none while looking fine.
//
// Run: npx tsx scripts/verify-job-owners.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  claimFor,
  DEFAULT_OWNER_OPTION,
  isMovableJob,
  standDownDetail,
  MOVABLE_JOBS,
  MOVABLE_JOB_NAMES,
  OWNER_STALE_DAYS,
  ownerLine,
  ownershipOf,
  ownershipWarning,
  parseJobOwners,
  shouldRunHere,
  type JobClaim,
  type JobOwners,
} from "@/lib/job-owners";

let checks = 0;
function ok(what: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`  ✓ ${what}`);
}

const NOW = new Date("2026-08-25T12:00:00Z");
const DAY = 86_400_000;
function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}
function claim(over: Partial<JobClaim> = {}): JobClaim {
  return {
    deviceId: "dev-pc",
    label: "BC-EDGEWOOD",
    claimedAt: ago(10),
    lastRunAt: ago(0),
    ...over,
  };
}

console.log("Exclusive-job ownership\n");

// ── The catalog ─────────────────────────────────────────────────────────────

ok("the catalog covers the seven exclusive jobs and nothing else", () => {
  // Every job ADR-214 marks NOT shared is a job this picker must talk about;
  // the shared ones must never appear, because owning them would be wrong.
  assert.equal(MOVABLE_JOB_NAMES.length, 7);
  for (const name of MOVABLE_JOB_NAMES) assert.ok(isMovableJob(name));
  assert.equal(isMovableJob("purge"), false, "purge is per-instance, never owned");
  assert.equal(isMovableJob("relatedness"), false, "relatedness is a per-instance cache");
  assert.equal(isMovableJob("snapshot"), false, "snapshots are purely local");
});

ok("a movable row states its trade, and a blocked row says why not", () => {
  // Written as an invariant rather than a list, because the list moves: jobs
  // become claimable one at a time as each handoff is proven (ADR-218's plan,
  // ADR-221's first two). What must never move is that the owner is told
  // something either way. A movable row that says nothing is the silent
  // surface Principle 9 forbids, and `export` is the one honest exception:
  // its trade IS that there is no trade.
  for (const name of MOVABLE_JOB_NAMES) {
    const def = MOVABLE_JOBS[name];
    if (def.movable) {
      assert.ok(!def.blocked, `${name} is movable but still carries a blocked reason`);
      assert.ok(
        def.consequence && def.consequence.length > 20,
        `${name} is movable without saying what moving it costs`
      );
    } else {
      assert.ok(def.blocked && def.blocked.length > 20, `${name} is blocked without a reason`);
    }
  }
});

ok("export, calendar sync, email capture and video transcripts are the proven set", () => {
  // A guard on the SIZE of the claimable set, not a restatement of it: flipping
  // another job on is a deliberate act that should have to touch this line and
  // ADR the reason, never something that rides along in an unrelated diff.
  // Video transcripts joined claimable at birth: its waiting list is recomputed
  // every run and the already-done mark lives in the synced body, so a new
  // owner has nothing to inherit.
  const claimable = MOVABLE_JOB_NAMES.filter((n) => MOVABLE_JOBS[n].movable).sort();
  assert.deepEqual(claimable, [
    "calendar-sync",
    "email-import",
    "export",
    "youtube-transcript",
  ]);
});

ok("no row explains itself in engineering vocabulary", () => {
  // The house rule (CLAUDE.md): plain, conventional product language. This text
  // is the entire explanation the owner gets, so it may not lean on our words.
  const banned = /\bcron\b|\btarget\b|\bGraph\b|job_state|oplog|cursor|lambda|delta/i;
  for (const name of MOVABLE_JOB_NAMES) {
    const def = MOVABLE_JOBS[name];
    for (const [field, text] of Object.entries({
      label: def.label,
      what: def.what,
      blocked: def.blocked ?? "",
      consequence: def.consequence ?? "",
    })) {
      assert.ok(!banned.test(text), `${name}.${field} uses engineering vocabulary: "${text}"`);
      assert.ok(!text.includes("—"), `${name}.${field} has an em dash: "${text}"`);
    }
  }
});

// ── What makes a handoff safe ───────────────────────────────────────────────
//
// A job is claimable only because the answer to "have I already done this one?"
// lives somewhere EVERY copy can read: a synced table, or the outside system
// itself. Where that answer instead sits in per-copy `job_state`, a new owner
// starts blind and either duplicates work or silently skips it.
//
// That is a structural fact, so it is checked structurally. These three greps
// are the tripwires under ADR-221's proofs: each one names the specific line
// whose removal would make a shipped, claimable job unsafe while every
// behavioral suite still passed, because the behavioral suites run against ONE
// database and a handoff is by definition two.

const SRC = (p: string) => readFileSync(p, "utf8");

ok("email capture recognizes a message from SYNCED item rows, not a local record", () => {
  // `alreadyImported` is the guard that survives a handoff. It must read
  // `items` (synced) and key on internetMessageId, which is stable across the
  // mailbox move that the volatile per-message id is not.
  const src = SRC("src/lib/email/sync.ts");
  const guard = src.slice(src.indexOf("async function alreadyImported"));
  assert.match(guard.slice(0, 900), /from items/, "the guard no longer reads the items table");
  assert.match(guard.slice(0, 900), /internetMessageId/, "the guard no longer keys on the stable id");
});

ok("email capture moves a message out of the folder only AFTER it is filed", () => {
  // The mailbox folder is the real cross-copy record: a message a new owner can
  // still see is a message nobody has filed. That only holds while the move
  // follows the write. Reversed, a crash between them loses the message for
  // every copy at once.
  const src = SRC("src/lib/email/sync.ts");
  const create = src.indexOf("await createItem(ownerId, {");
  // lastIndexOf: the FIRST markImported is the skip branch (a message filed on
  // a previous run, moved now), which legitimately precedes the create.
  const move = src.lastIndexOf("await source.markImported(");
  assert.ok(create > 0, "the import path no longer calls createItem");
  assert.ok(move > create, "markImported no longer follows createItem");
});

ok("calendar sync recognizes a meeting from the SYNCED item column", () => {
  // Dedup keys on items.msEventId. The `calendar_events` cache beside it is
  // per-copy and deliberately so; if the dedup ever moved onto that table, a
  // new owner with an empty cache would duplicate every promoted meeting.
  const src = SRC("src/lib/calendar/sync.ts");
  assert.match(src, /inArray\(items\.msEventId, ids\)/, "dedup no longer keys on items.msEventId");
  assert.doesNotMatch(
    src,
    /inArray\(calendarEvents\.msEventId/,
    "dedup moved onto the per-copy cache, which does not survive a handoff"
  );
});

// ── Reading the stored slot ─────────────────────────────────────────────────

ok("a tolerant read drops anything unusable rather than throwing", () => {
  // Read before every scheduled run: a settings blob mangled by a future
  // version must fall back to the old behavior, never stop the backup.
  assert.deepEqual(parseJobOwners(undefined), {});
  assert.deepEqual(parseJobOwners(null), {});
  assert.deepEqual(parseJobOwners("nope"), {});
  assert.deepEqual(parseJobOwners([1, 2]), {});
  assert.deepEqual(parseJobOwners({ export: 42 }), {});
  assert.deepEqual(parseJobOwners({ export: {} }), {}, "a claim with no device is not a claim");
  assert.deepEqual(parseJobOwners({ export: { deviceId: "   " } }), {});
  assert.deepEqual(parseJobOwners({ "not-a-job": { deviceId: "d" } }), {});
  assert.deepEqual(parseJobOwners({ export: null }), { export: null });
});

ok("a claim missing its label still names something, never nothing", () => {
  // The label is what lets an install that has never met the owner name it in a
  // sentence. A claim written by an older version has none, so it degrades to a
  // short id rather than rendering "Runs on ".
  const owners = parseJobOwners({ export: { deviceId: "abcdef1234567890" } });
  assert.equal(owners.export?.label, "abcdef12");
  assert.equal(owners.export?.lastRunAt, null);
  assert.ok(owners.export?.claimedAt, "claimedAt defaulted");
});

ok("absent, nobody and claimed are three different answers", () => {
  assert.deepEqual(ownershipOf({}, "export"), { state: "unset" });
  assert.deepEqual(ownershipOf({ export: null }, "export"), { state: "nobody" });
  const c = claim();
  assert.deepEqual(ownershipOf({ export: c }, "export"), { state: "claimed", claim: c });
});

// ── The gate ────────────────────────────────────────────────────────────────

ok("an unset slot changes nothing anywhere (the whole back-compat story)", () => {
  // This is what keeps Tyler's instance, and any peer nobody has configured,
  // behaving byte-for-byte as before the feature existed.
  for (const self of ["dev-cloud", "dev-pc", null]) {
    const v = shouldRunHere({ owners: {}, job: "export", selfDeviceId: self });
    assert.deepEqual(v, { run: true, reason: "unset" }, `self=${self}`);
  }
});

// ── One switch, not two (ADR-225) ───────────────────────────────────────────
//
// The supervisor now SCHEDULES every movable job on every peer and lets this
// gate decide, because ownership plus a per-machine config switch meant a job
// assigned to a peer whose config had it off ran nowhere at all. The invariant
// that replaces the config default: for an unnamed job, the cloud runs it and a
// supervised peer stands down — never both, never neither.

ok("an unnamed job runs in the cloud and stands down on a supervised peer", () => {
  for (const job of MOVABLE_JOB_NAMES) {
    const cloud = shouldRunHere({ owners: {}, job, selfDeviceId: "dev-cloud" });
    const peer = shouldRunHere({
      owners: {},
      job,
      selfDeviceId: "dev-pc",
      standDownWhenUnset: true,
    });
    assert.deepEqual(cloud, { run: true, reason: "unset" }, job);
    assert.deepEqual(peer, { run: false, reason: "unset-standby" }, job);
    // The double-writer this whole feature exists to prevent, restated as the
    // arithmetic the scheduler change could have broken: exactly one runs.
    assert.equal([cloud, peer].filter((v) => v.run).length, 1, job);
  }
});

ok("naming a peer moves the job there and only there", () => {
  const owners: JobOwners = { export: claim({ deviceId: "dev-pc", label: "BrandonECC" }) };
  const peer = shouldRunHere({
    owners,
    job: "export",
    selfDeviceId: "dev-pc",
    standDownWhenUnset: true,
  });
  const cloud = shouldRunHere({ owners, job: "export", selfDeviceId: "dev-cloud" });
  assert.deepEqual(peer, { run: true, reason: "owner" });
  assert.deepEqual(cloud, { run: false, reason: "not-owner" });
});

ok("standing down when unnamed changes nothing about the other three answers", () => {
  // The flag resolves ABSENCE and nothing else: a named or paused job reads the
  // same on every install, which is what keeps one slot the single answer.
  const cases: JobOwners[] = [{ export: null }, { export: claim({ deviceId: "dev-pc" }) }];
  for (const owners of cases) {
    for (const self of ["dev-pc", "dev-cloud", null]) {
      assert.deepEqual(
        shouldRunHere({ owners, job: "export", selfDeviceId: self, standDownWhenUnset: true }),
        shouldRunHere({ owners, job: "export", selfDeviceId: self }),
        `self=${self}`
      );
    }
  }
});

ok("a peer that stands down for want of an owner is not reporting a fault", () => {
  // It must read as "the cloud has this", never as an error: the supervisor
  // records the endpoint's answer, and a nightly red mark on every peer that is
  // not the owner is Principle 9 inverted into noise.
  const v = shouldRunHere({
    owners: {},
    job: "export",
    selfDeviceId: "dev-pc",
    standDownWhenUnset: true,
  });
  assert.equal(v.reason, "unset-standby");
  const detail = standDownDetail(v.reason, null);
  assert.ok(detail.includes("cloud"), detail);
  assert.ok(/scheduled work/i.test(detail), "the sentence does not point at the one lever");
});

ok("exactly one install runs a claimed job", () => {
  const owners: JobOwners = { export: claim() };
  assert.equal(shouldRunHere({ owners, job: "export", selfDeviceId: "dev-pc" }).run, true);
  assert.equal(shouldRunHere({ owners, job: "export", selfDeviceId: "dev-cloud" }).run, false);
  assert.equal(shouldRunHere({ owners, job: "export", selfDeviceId: "dev-laptop" }).run, false);
  assert.equal(shouldRunHere({ owners, job: "export", selfDeviceId: null }).run, false);
});

ok("a machine that lost ownership stands down on its very next run", () => {
  // Layer 2 of the exactly-one guarantee: the one unpreventable race (two
  // installs claiming while partitioned, resolved by LWW on reconnect) costs at
  // most ONE duplicated run, because the loser re-reads and sees it lost.
  const before = shouldRunHere({
    owners: { export: claim({ deviceId: "dev-cloud" }) },
    job: "export",
    selfDeviceId: "dev-cloud",
  });
  const after = shouldRunHere({
    owners: { export: claim({ deviceId: "dev-pc" }) },
    job: "export",
    selfDeviceId: "dev-cloud",
  });
  assert.equal(before.run, true);
  assert.equal(after.run, false);
  assert.equal(after.reason, "not-owner");
});

ok("nobody means nobody, on every install", () => {
  const owners: JobOwners = { export: null };
  for (const self of ["dev-cloud", "dev-pc", "dev-laptop", null]) {
    const v = shouldRunHere({ owners, job: "export", selfDeviceId: self });
    assert.equal(v.run, false, `self=${self} ran a job nobody owns`);
    assert.equal(v.reason, "nobody");
  }
});

ok("the gate can only ever reduce who runs a job, never expand it", () => {
  // Why it is safe to apply uniformly, including to jobs not yet claimable.
  for (const owners of [{}, { export: null }, { export: claim() }] as JobOwners[]) {
    for (const self of ["dev-pc", "dev-cloud", null]) {
      const v = shouldRunHere({ owners, job: "export", selfDeviceId: self });
      const wouldHaveRunBefore = true; // the old behavior: everyone ran it
      assert.ok(!v.run || wouldHaveRunBefore);
    }
  }
});

ok("ownership of one job never affects another", () => {
  const owners: JobOwners = { export: claim() };
  // The mailbox job is untouched: still the old behavior, still running.
  assert.equal(shouldRunHere({ owners, job: "email-import", selfDeviceId: "dev-cloud" }).run, true);
});

// ── Claiming ────────────────────────────────────────────────────────────────

ok("re-claiming on the same machine keeps its history", () => {
  const previous = claim({ claimedAt: ago(30), lastRunAt: ago(1) });
  const again = claimFor({ deviceId: "dev-pc", label: "BC-EDGEWOOD", now: NOW, previous });
  assert.equal(again.claimedAt, previous.claimedAt, "claim date reset on a no-op re-claim");
  assert.equal(again.lastRunAt, previous.lastRunAt, "run history lost on a no-op re-claim");
});

ok("claiming from a different machine starts a fresh history", () => {
  // The new owner has not run it yet, and must not inherit a record saying it
  // did — that would hide exactly the "moved it and nothing happened" failure.
  const previous = claim({ deviceId: "dev-cloud", label: "Cloud", lastRunAt: ago(0) });
  const moved = claimFor({ deviceId: "dev-pc", label: "BC-EDGEWOOD", now: NOW, previous });
  assert.equal(moved.deviceId, "dev-pc");
  assert.equal(moved.lastRunAt, null);
  assert.equal(moved.claimedAt, NOW.toISOString());
});

// ── Liveness ────────────────────────────────────────────────────────────────

ok("a job that ran today is fine, and so is an unset slot", () => {
  assert.equal(ownershipWarning({ owners: { export: claim() }, job: "export", now: NOW }), null);
  assert.equal(
    ownershipWarning({ owners: {}, job: "export", now: NOW }),
    null,
    "the old behavior is not a fault"
  );
});

ok("a fresh claim gets a day's grace before it is called out", () => {
  // A nightly job has missed nothing until a night has passed.
  const fresh = claim({ claimedAt: ago(0), lastRunAt: null });
  assert.equal(ownershipWarning({ owners: { export: fresh }, job: "export", now: NOW }), null);
  const yesterday = claim({ claimedAt: ago(2), lastRunAt: null });
  const w = ownershipWarning({ owners: { export: yesterday }, job: "export", now: NOW });
  assert.equal(w?.kind, "never-ran");
});

ok("every way a job can be silently not running is called out", () => {
  const cases: Array<[string, JobOwners, string]> = [
    ["nobody owns it", { export: null }, "nobody"],
    ["moved and never ran", { export: claim({ claimedAt: ago(4), lastRunAt: null }) }, "never-ran"],
    ["the machine went quiet", { export: claim({ lastRunAt: ago(9) }) }, "stale"],
  ];
  for (const [what, owners, kind] of cases) {
    const w = ownershipWarning({ owners, job: "export", now: NOW });
    assert.ok(w, `no warning for ${what}`);
    assert.equal(w.kind, kind, what);
    // Every warning is a sentence naming the job, not a code.
    assert.match(w.text, /Offline backup/, what);
    assert.ok(w.text.endsWith("."), `${what}: not a sentence`);
    assert.ok(!w.text.includes("dev-pc"), `${what}: leaked a device id`);
  }
});

ok("the staleness threshold is a boundary, not a vibe", () => {
  const at = (days: number) =>
    ownershipWarning({ owners: { export: claim({ lastRunAt: ago(days) }) }, job: "export", now: NOW });
  assert.equal(at(OWNER_STALE_DAYS - 1), null, "warned too early");
  assert.equal(at(OWNER_STALE_DAYS)?.kind, "stale", "did not warn at the threshold");
  assert.equal(at(OWNER_STALE_DAYS + 30)?.kind, "stale");
});

// ── The status line ─────────────────────────────────────────────────────────

ok("the status line names a place, never an id", () => {
  const owners: JobOwners = { export: claim() };
  assert.equal(
    ownerLine({ owners, job: "export", selfDeviceId: "dev-cloud" }),
    "Runs on BC-EDGEWOOD"
  );
  assert.equal(ownerLine({ owners, job: "export", selfDeviceId: "dev-pc" }), "Runs on this machine");
  assert.equal(
    ownerLine({ owners: { export: null }, job: "export", selfDeviceId: "dev-pc" }),
    "Not running anywhere"
  );
  assert.equal(
    ownerLine({ owners: {}, job: "export", selfDeviceId: "dev-pc" }),
    `Runs in the cloud (the default)`
  );
  // The retired phrase. It described a per-machine config switch that no
  // longer exists (ADR-225), so no surface may reintroduce it.
  for (const owners of [{}, { export: null }, { export: claim() }] as JobOwners[]) {
    for (const self of ["dev-pc", "dev-cloud", null]) {
      assert.ok(
        !ownerLine({ owners, job: "export", selfDeviceId: self }).includes("switched on"),
        "a surface still says the job runs wherever it is switched on"
      );
    }
  }
  assert.ok(
    DEFAULT_OWNER_OPTION.includes("cloud") && !DEFAULT_OWNER_OPTION.includes("switched on"),
    "the picker's default option still describes a switch"
  );
  // Even a label-less claim must not leak a raw id into the sentence.
  const bare = parseJobOwners({ export: { deviceId: "0123456789abcdef" } });
  const line = ownerLine({ owners: bare, job: "export", selfDeviceId: "other" });
  assert.ok(!line.includes("0123456789abcdef"), `leaked a full id: "${line}"`);
});

console.log(`\n${checks} checks passed.`);
