// Verification for the roster: one row per copy of Ledgr the owner runs (ADR-220).
//
// PURE by construction. The decisions live in src/lib/installs-plan.ts and take
// their inputs as arguments, so health, collisions and wording are all exercised
// here with no database.
//
// The roster exists to make ONE thing possible: naming a machine you are not
// sitting at. So the checks below are the ones that would make a name unsafe to
// act on — two copies answering to it, a copy that is actually gone reading as
// present, or a surface claiming to know which build is newer when it cannot.
//
// Run: npx tsx scripts/verify-installs.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  duplicateLabels,
  INSTALL_STALE_DAYS,
  installHealth,
  installHealthLine,
  installsOnAnotherBuild,
  labelProblem,
  normalizeLabel,
  type Install,
} from "@/lib/installs-plan";
import { validateMachineName, buildPeerConfig } from "../scripts/local-setup-lib.mjs";

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
function copy(over: Partial<Install> = {}): Install {
  return {
    id: "dev-pc",
    label: "Study PC",
    kind: "local",
    appVersion: "abc1234",
    lastSeenAt: ago(0),
    isSelf: false,
    ...over,
  };
}

console.log("The roster of copies\n");

// ── Health ──────────────────────────────────────────────────────────────────

ok("the copy you are looking at is always present, whatever its timestamp", () => {
  // It is rendering the page. Saying it has gone quiet would be absurd, and the
  // timestamp can legitimately be stale (the daily announce has not run yet).
  const self = copy({ isSelf: true, lastSeenAt: ago(400) });
  assert.equal(installHealth(self, NOW), "here");
  assert.match(installHealthLine(self, NOW), /looking at/);
});

ok("quiet, gone and never are distinguished, because the fix differs", () => {
  assert.equal(installHealth(copy({ lastSeenAt: ago(0) }), NOW), "here");
  assert.equal(installHealth(copy({ lastSeenAt: ago(INSTALL_STALE_DAYS) }), NOW), "quiet");
  assert.equal(installHealth(copy({ lastSeenAt: ago(60) }), NOW), "gone");
  assert.equal(installHealth(copy({ lastSeenAt: null }), NOW), "never");
  assert.equal(installHealth(copy({ lastSeenAt: "nonsense" }), NOW), "never");
});

ok("the staleness threshold is a boundary, not a vibe", () => {
  assert.equal(installHealth(copy({ lastSeenAt: ago(INSTALL_STALE_DAYS - 1) }), NOW), "here");
  assert.equal(installHealth(copy({ lastSeenAt: ago(INSTALL_STALE_DAYS) }), NOW), "quiet");
});

ok("every health state has a sentence, and none of them says a number of ops", () => {
  for (const lastSeenAt of [ago(0), ago(4), ago(60), null]) {
    const line = installHealthLine(copy({ lastSeenAt }), NOW);
    assert.ok(line.length > 8, `too short: "${line}"`);
    assert.ok(!/\bop\b|cursor|seq|uuid/i.test(line), `engineering vocabulary: "${line}"`);
  }
});

// ── Collisions: the whole reason the wizard asks for a name ─────────────────

ok("two copies answering to one name are detected, case and space insensitive", () => {
  const list = [
    copy({ id: "a", label: "Study PC" }),
    copy({ id: "b", label: "study pc" }),
    copy({ id: "c", label: "Cloud" }),
  ];
  assert.deepEqual(duplicateLabels(list), ["Study PC"], "reported the comparison key, not the name");
  assert.deepEqual(duplicateLabels([copy({ id: "a" }), copy({ id: "b", label: "Laptop" })]), []);
  assert.deepEqual(duplicateLabels([]), []);
});

ok("the wizard refuses an empty name rather than falling back to the hostname", () => {
  // Falling back is exactly the hole asking was meant to close: two machines
  // with the same hostname would both answer to one word.
  assert.ok(validateMachineName(""));
  assert.ok(validateMachineName("   "));
  assert.ok(validateMachineName("x".repeat(61)));
  assert.equal(validateMachineName("Study PC"), null);
});

ok("the chosen name reaches the app as the roster seed", () => {
  const cfg = buildPeerConfig({
    role: "hub",
    dataDir: "C:/d",
    ownerEmail: "a@b.com",
    appPort: 3000,
    dbPort: 5433,
    machineName: "Study PC",
  });
  assert.equal(cfg.extraEnv.LEDGR_INSTALL_LABEL, "Study PC");
  // And a wizard run from before this question existed writes nothing, so the
  // app falls back to the hostname rather than to an empty name.
  const old = buildPeerConfig({
    role: "hub",
    dataDir: "C:/d",
    ownerEmail: "a@b.com",
    appPort: 3000,
    dbPort: 5433,
  });
  assert.deepEqual(old.extraEnv, {});
});

// ── Names ───────────────────────────────────────────────────────────────────

ok("a name is always renderable, never blank", () => {
  assert.equal(normalizeLabel("  Study   PC  "), "Study PC");
  assert.equal(normalizeLabel(""), "This machine");
  assert.equal(normalizeLabel(null), "This machine");
  assert.equal(normalizeLabel(42), "This machine");
  assert.equal(normalizeLabel("x".repeat(200)).length, 60);
});

ok("the GUI rejects what the wizard rejects", () => {
  // One rule, two doors: a name typed on the settings page and a name typed at
  // setup must be judged the same way.
  for (const bad of ["", "   ", "x".repeat(61)]) {
    assert.ok(labelProblem(bad), `GUI accepted "${bad.slice(0, 12)}"`);
    assert.ok(validateMachineName(bad), `wizard accepted "${bad.slice(0, 12)}"`);
  }
  assert.equal(labelProblem("Study PC"), null);
});

// ── Builds ──────────────────────────────────────────────────────────────────

ok("a differing build is reported as different, never as behind", () => {
  // This copy cannot tell which build is newer without a commit graph it does
  // not have. Saying "behind" would be claiming more than it knows.
  const list = [
    copy({ id: "self", isSelf: true, appVersion: "aaa" }),
    copy({ id: "other", appVersion: "bbb" }),
    copy({ id: "same", appVersion: "aaa" }),
  ];
  assert.deepEqual(
    installsOnAnotherBuild(list).map((i) => i.id),
    ["other"]
  );
});

ok("an unknown build on either side is not a difference", () => {
  assert.deepEqual(installsOnAnotherBuild([copy({ isSelf: true, appVersion: null }), copy()]), []);
  assert.deepEqual(
    installsOnAnotherBuild([
      copy({ id: "self", isSelf: true, appVersion: "aaa" }),
      copy({ id: "x", appVersion: null }),
    ]),
    []
  );
  assert.deepEqual(installsOnAnotherBuild([copy()]), [], "no self row, no comparison");
});

// ── Wiring that has to stay true ────────────────────────────────────────────

ok("the roster is in the synced set, so every copy sees the same list", () => {
  const engine = readFileSync(resolve("src/lib/sync/engine.ts"), "utf8");
  assert.match(engine, /installs: \{ pk: "id" \}/, "installs is not a synced table");
});

ok("the migration carries the oplog triggers and moves the wire stamp", () => {
  // A synced table with no triggers would sync in one direction only: this copy
  // would accept other copies' rows and never publish its own.
  const sql = readFileSync(resolve("drizzle/0058_installs_roster.sql"), "utf8");
  assert.match(sql, /CREATE TRIGGER installs_sync_id AFTER INSERT OR DELETE ON installs/);
  assert.match(sql, /CREATE TRIGGER installs_sync_u AFTER UPDATE ON installs/);
  assert.match(sql, /UPDATE "sync_schema_ver" SET "ver" = '0058_installs_roster'/);
  // owner_id is what the shared trigger function reads to attribute the row.
  assert.match(sql, /"owner_id" uuid NOT NULL/);
});

ok("the announce rides the one job every instance runs", () => {
  // purge is the only scheduled job ADR-214 marks safe (and required) on every
  // instance, so it is the only one that gets a cloud deploy into the roster.
  const purge = readFileSync(resolve("src/app/api/machine/purge/route.ts"), "utf8");
  assert.match(purge, /announceOwnInstall\(\)/);
});

ok("a re-fill keeps this machine's identity instead of orphaning its jobs", () => {
  // A fill deliberately assigns a NEW sync_device id. Job ownership and the
  // roster are keyed by it, so without the carry-forward a re-filled peer comes
  // back a stranger: claimed jobs point at nothing and the roster shows a ghost.
  const restore = readFileSync(resolve("scripts/local-restore.mjs"), "utf8");
  assert.match(restore, /async function readPriorIdentity/);
  assert.match(restore, /async function carryIdentityForward/);
  // Both fill paths, not just the one someone happened to test.
  assert.equal(
    (restore.match(/await carryIdentityForward\(db, prior\)/g) ?? []).length,
    2,
    "only one fill path carries the identity forward"
  );
  assert.equal(
    (restore.match(/await readPriorIdentity\(pg, cfg\)/g) ?? []).length,
    2,
    "only one fill path reads the prior identity"
  );
});

ok("the periodic announce never writes the label", () => {
  // The owner can rename a machine from any device. A heartbeat that also wrote
  // the label would silently revert that on the next run, which is the exact
  // class of "the surface says something that is not so" this project keeps
  // catching.
  const installs = readFileSync(resolve("src/lib/installs.ts"), "utf8");
  const update = /onConflictDoUpdate\(\{[\s\S]*?\}\)/.exec(installs)?.[0] ?? "";
  assert.ok(update, "no upsert found");
  assert.ok(!/\blabel\b/.test(update), `the announce overwrites the label: ${update}`);
});

console.log(`\n${checks} checks passed.`);
