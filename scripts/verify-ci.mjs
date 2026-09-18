// Run every verify script that needs NO database and NO running server.
//
// Why this exists: `main` failed to build twice in 2026-08 — an extra named
// export in a page file, and an `unknown` passed to a `string` param — and both
// merged green, because nothing ran `tsc` or `next build` before a merge. The
// same gap had quietly broken SIX verify scripts (stale expectations for the
// longform note canvas, the `/dashboards/<id>` chrome rule, the second
// machine-token helper, and a pre-palette red hex), none of which anyone saw,
// because nothing ran them either. A check nobody runs is not a check.
//
// Discovery over an allowlist, deliberately: a NEW pure verify script joins CI
// the moment it lands, with nobody remembering to register it. That is the exact
// failure this file exists to prevent, so the mechanism must not reintroduce it.
//
// The DB/server-backed suites (verify-mcp*, verify-items, verify-structures, …)
// are excluded: they need real Neon credentials and a dev server, which CI has
// no business holding. They stay a local/manual step — see runbook.md.
//
//   node scripts/verify-ci.mjs            # everything pure
//   node scripts/verify-ci.mjs --list     # just show the classification
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const DIR = "scripts";

// A script is DB/server-backed if it reaches for the db client, a connection
// string, the Neon driver, or a running localhost. Kept as one regex so the
// classification is inspectable in one place, and mirrored in the comment above.
const NEEDS_BACKEND =
  /from "\.\.\/src\/db|@\/db|getDb|localhost:3000|DATABASE_URL|neon\(/;

const all = readdirSync(DIR)
  .filter((f) => /^verify-.*\.(mts|mjs)$/.test(f))
  .sort();

const pure = [];
const backend = [];
for (const f of all) {
  const src = readFileSync(join(DIR, f), "utf8");
  (NEEDS_BACKEND.test(src) ? backend : pure).push(f);
}

if (process.argv.includes("--list")) {
  console.log(`PURE (${pure.length}, run in CI):`);
  for (const f of pure) console.log(`  ${f}`);
  console.log(`\nBACKEND (${backend.length}, local/manual only):`);
  for (const f of backend) console.log(`  ${f}`);
  process.exit(0);
}

console.log(
  `Running ${pure.length} pure verify scripts (${backend.length} DB/server-backed ones skipped).\n`
);

// DATABASE_URL is cleared rather than merely absent: a developer running this
// locally has one in .env.local, and a script that quietly depends on the DB
// while dodging the regex above must fail HERE, not mysteriously in CI.
const env = { ...process.env, DATABASE_URL: "" };

// Spawn tsx's own entry with this node, rather than shelling out to `npx tsx`
// once per script. npx re-resolves the package on every single call, which on
// Windows cost 4719ms per script against 1194ms for the direct spawn
// (measured; across 67 scripts that is minutes, not milliseconds). It also
// needed a shell on win32 to find the .cmd shim, which spends a cmd.exe per
// spawn and earns a DEP0190 warning for passing args through one. Same tsx,
// same argv, no shell. verify-setup.mts guards it, since a regression here is
// silent: the suite still passes, just far slower.
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

const failed = [];
for (const f of pure) {
  const res = spawnSync(process.execPath, [TSX, join(DIR, f)], {
    encoding: "utf8",
    env,
  });
  const ok = res.status === 0;
  if (!ok) failed.push({ f, out: `${res.stdout ?? ""}${res.stderr ?? ""}` });
  console.log(`${ok ? "PASS" : "FAIL"}  ${f}`);
}

if (failed.length) {
  // Print the full output of failures only. A wall of passing output buries the
  // one thing the reader came for.
  for (const { f, out } of failed) {
    console.log(`\n──────── ${f} ────────`);
    // The failing assertions, plus a tail for a crash that printed no FAIL line.
    const lines = out.split("\n");
    const relevant = lines.filter((l) => /^FAIL|FAILURE|Error|error/.test(l));
    console.log((relevant.length ? relevant : lines.slice(-25)).join("\n"));
  }
  console.log(`\n${failed.length} of ${pure.length} verify scripts FAILED.`);
  process.exit(1);
}

console.log(`\nAll ${pure.length} pure verify scripts passed.`);
