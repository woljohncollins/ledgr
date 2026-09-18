// Verification for the update policy file (the GUI-editable half of
// config.update, 2026-09-12).
//
// WHAT HAS TO HOLD:
//   1. The .mjs parser (the supervisor, the CLI) and the .ts parser (the app
//      route and page) agree on the same bytes, in both directions. Two
//      hand-written parsers for one file is the drift risk; this is the guard.
//   2. Both point at the same file name. A path that differs by one character
//      is a Save button that silently does nothing.
//   3. "Due" arithmetic: manual never fires; auto fires on the first tick after
//      boot and then only once the interval has elapsed.
//   4. The old config word "prompted" still reads as manual, and is never
//      written back.
//   5. The install wizard's seed round-trips: what it asks becomes what the
//      service writes on first boot.
//
// Run: npx tsx scripts/verify-update-policy.mts
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  normalizeConfig,
  parseUpdatePolicy as parseMjs,
  policyFromConfig,
  serializeUpdatePolicy as serializeMjs,
  updateCheckDue,
  updatePolicyPath,
} from "../supervisor/lib.mjs";
import { buildPeerConfig } from "./local-setup-lib.mjs";
import {
  githubSlugOf,
  parseUpdatePolicy as parseTs,
  POLICY_FILE,
  serializeUpdatePolicy as serializeTs,
  validatePolicyInput,
} from "@/lib/update-policy";

let checks = 0;
function ok(what: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`  ✓ ${what}`);
}

ok("both sides name the same file", () => {
  assert.equal(basename(updatePolicyPath("/data")), POLICY_FILE);
});

ok("ts → mjs round-trip", () => {
  const text = serializeTs({ mode: "auto", everyMinutes: 7, branch: "prod-x", repo: "https://github.com/a/b.git" });
  const p = parseMjs(text);
  assert.ok(p);
  assert.deepEqual(
    { mode: p.mode, everyMinutes: p.everyMinutes, branch: p.branch, repo: p.repo },
    { mode: "auto", everyMinutes: 7, branch: "prod-x", repo: "https://github.com/a/b.git" }
  );
});

ok("mjs → ts round-trip", () => {
  const text = serializeMjs({ mode: "manual", everyMinutes: 30, branch: "main", repo: "" });
  const p = parseTs(text);
  assert.ok(p);
  assert.deepEqual(
    { mode: p.mode, everyMinutes: p.everyMinutes, branch: p.branch, repo: p.repo },
    { mode: "manual", everyMinutes: 30, branch: "main", repo: "" }
  );
});

ok('"prompted" reads as manual on both sides and is never written', () => {
  const legacy = JSON.stringify({ mode: "prompted", everyMinutes: 15, branch: "main" });
  assert.equal(parseMjs(legacy)?.mode, "manual");
  assert.equal(parseTs(legacy)?.mode, "manual");
  assert.ok(!serializeMjs(parseMjs(legacy)).includes("prompted"));
});

ok("garbage is null, not a policy", () => {
  assert.equal(parseMjs("not json"), null);
  assert.equal(parseTs("[]"), null);
  assert.equal(parseTs(JSON.stringify({ mode: "sometimes" })), null);
});

ok("due arithmetic", () => {
  const auto = { mode: "auto", everyMinutes: 15 };
  const manual = { mode: "manual", everyMinutes: 15 };
  assert.equal(updateCheckDue(manual, null, 0), false, "manual never fires");
  assert.equal(updateCheckDue(auto, null, 0), true, "first tick after boot checks");
  assert.equal(updateCheckDue(auto, 0, 14 * 60_000), false, "not yet");
  assert.equal(updateCheckDue(auto, 0, 15 * 60_000), true, "on the interval");
});

ok("form validation refuses what the file must never hold", () => {
  assert.equal(validatePolicyInput({ mode: "auto", everyMinutes: 15, branch: "main", repo: "" }).ok, true);
  assert.equal(validatePolicyInput({ mode: "auto", everyMinutes: 0, branch: "main" }).ok, false);
  assert.equal(validatePolicyInput({ mode: "auto", everyMinutes: 15, branch: "two words" }).ok, false);
  assert.equal(validatePolicyInput({ mode: "auto", everyMinutes: 15, branch: "main", repo: "ftp://x" }).ok, false);
  assert.equal(validatePolicyInput({ mode: "prompted", everyMinutes: 15, branch: "main" }).ok, false, "the form speaks the new word only");
});

ok("github slug from a remote URL", () => {
  assert.equal(githubSlugOf("https://github.com/strategicli/ledgr.git"), "strategicli/ledgr");
  assert.equal(githubSlugOf("git@github.com:strategicli/ledgr.git"), "strategicli/ledgr");
  assert.equal(githubSlugOf("https://gitlab.com/a/b.git"), null);
});

ok("the wizard's answers become the first-boot policy", () => {
  const cfg = normalizeConfig(
    buildPeerConfig({
      role: "hub",
      dataDir: "/data",
      ownerEmail: "a@b.c",
      appPort: 3000,
      dbPort: 5433,
      branch: "prod-me",
      autoUpdate: false,
      updateEveryMinutes: 45,
    }),
    "/repo/supervisor"
  );
  const seed = policyFromConfig(cfg, "https://github.com/a/b.git");
  assert.deepEqual(seed, { mode: "manual", everyMinutes: 45, branch: "prod-me", repo: "https://github.com/a/b.git" });
  const defaults = policyFromConfig(
    normalizeConfig(buildPeerConfig({ role: "spoke", dataDir: "/d", ownerEmail: "a@b.c", appPort: 3000, dbPort: 5433 }), "/r/supervisor"),
    ""
  );
  assert.deepEqual(defaults, { mode: "auto", everyMinutes: 15, branch: "main", repo: "" });
});

console.log(`\nverify-update-policy: ${checks} checks passed`);
