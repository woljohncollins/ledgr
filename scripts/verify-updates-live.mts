// The live half of the Updates verification: run the REAL schema check against
// a real database. The pure guards (the fail-closed self-update gate, the
// pending-migration rule, the structural checks) live in verify-updates.mts,
// which runs in CI; this one needs DATABASE_URL, so it stays a local step.
//
// What it proves that the pure script cannot: that the migration journal bundled
// with the running code and the drizzle.__drizzle_migrations table actually line
// up at runtime — the comparison the whole feature rests on.
//
// Run: npx tsx scripts/verify-updates-live.mts
import { readFileSync, existsSync } from "node:fs";
import { getSchemaStatus } from "../src/lib/updates";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// The npm scripts load .env.local via node's --env-file-if-exists; this script is
// run bare with tsx, so it reads the one variable it needs itself.
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/);
    if (m) process.env.DATABASE_URL = m[1];
  }
}

if (!process.env.DATABASE_URL) {
  console.log("SKIP  no DATABASE_URL (set it or add it to .env.local)");
  process.exit(0);
}

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { when: number; tag: string }[];
};

const status = await getSchemaStatus();

check(
  "the live schema check returns a known state",
  ["current", "pending", "empty", "unknown"].includes(status.state),
  status.state
);
check(
  "it counts the same migrations the running code carries",
  status.total === journal.entries.length,
  `${status.total} vs ${journal.entries.length}`
);
check(
  "a reachable database never reports unknown",
  status.state !== "unknown",
  status.detail ?? ""
);
check(
  "pending tags are all real journal tags, never invented",
  status.pending.every((t) => journal.entries.some((e) => e.tag === t))
);
check(
  "a current database reports nothing pending",
  status.state !== "current" || status.pending.length === 0
);

if (status.state === "pending") {
  console.log(
    `\n      This database owes ${status.pending.length} migration(s): ${status.pending.join(", ")}`
  );
  console.log("      Run `npm run db:migrate` against it.");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
