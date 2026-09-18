// Stand up a brand-new Ledgr instance's database in one command.
//
// This exists because the setup is four steps that must happen in order, and
// skipping any one of them produces a broken instance that looks like a bug
// rather than a missing step:
//
//   1. migrate  — an empty database behind deployed code 500s on every page
//   2. seed     — the system types, or nothing renders as anything
//   3. owner    — a users row for the address they SIGN IN with, or they hit the
//                 "Signed in, but not recognized" screen (ADR-184) with no nav,
//                 which reads as the app being broken
//   4. verify   — say plainly what is ready and what will quietly not work
//
// Run: npm run instance:new -- michelle          (from instances.local.json)
//      npm run instance:new -- --database-url "postgresql://..." --owner a@b.com
import { spawnSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { loadConfig, assertPooler, hostOf, CONFIG_PATH } from "./instances-config.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
// The instance name is the one bare argument. A flag's VALUE is also bare
// ("--database-url postgresql://..."), so skip anything sitting immediately
// after a flag that takes one — otherwise a connection string is mistaken for
// the instance name and gets printed to the terminal.
const VALUE_FLAGS = new Set(["--database-url", "--owner", "--app-url"]);
const positional = args.find(
  (a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1])
);

let name = positional || "instance";
let databaseUrl = value("database-url") || process.env.DATABASE_URL || null;
let ownerEmail = value("owner") || process.env.SEED_OWNER_EMAIL || null;
let appUrl = value("app-url") || null;

// A name with no explicit connection string means "look me up in the roster".
if (positional && !value("database-url")) {
  try {
    const config = loadConfig();
    const found = config.instances.find((i) => i.name === positional);
    if (!found) {
      console.error(
        `No instance named "${positional}" in ${CONFIG_PATH}. ` +
          `Known: ${config.instances.map((i) => i.name).join(", ")}.`
      );
      process.exit(1);
    }
    name = found.name;
    databaseUrl = found.databaseUrl;
    ownerEmail = ownerEmail || found.ownerEmail;
    appUrl = appUrl || found.appUrl;
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (!databaseUrl) {
  console.error(
    "No database to set up.\n" +
      "Pass --database-url, set DATABASE_URL, or name an instance from " +
      `${CONFIG_PATH}.`
  );
  process.exit(1);
}
if (!ownerEmail) {
  console.error(
    "No owner email.\n" +
      "Pass --owner <the address they sign in with>. Seeding the wrong address " +
      "creates an owner nobody signs in as, and every page renders its null-owner state."
  );
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
  console.error(`"${ownerEmail}" is not a valid email address.`);
  process.exit(1);
}

try {
  assertPooler(databaseUrl, name);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`Setting up "${name}"`);
console.log(`  database  ${hostOf(databaseUrl)}`);
console.log(`  owner     ${ownerEmail}\n`);

// 1. Migrate.
process.stdout.write("  migrating ... ");
try {
  await migrate(drizzle(neon(databaseUrl)), { migrationsFolder: "./drizzle" });
  console.log("done");
} catch (err) {
  console.log("FAILED");
  console.error(`\n  ${err.message}`);
  process.exit(1);
}

// 2 + 3. Seed the system types and the owner row. Reused as a child process
// rather than reimplemented: seed.mjs is the one description of what a fresh
// database contains, and a second copy of it would drift.
process.stdout.write("  seeding ..... ");
const seed = spawnSync(process.execPath, ["scripts/seed.mjs"], {
  env: { ...process.env, DATABASE_URL: databaseUrl, SEED_OWNER_EMAIL: ownerEmail },
  encoding: "utf8",
});
if (seed.status !== 0) {
  console.log("FAILED");
  console.error(`\n${seed.stderr || seed.stdout}`);
  process.exit(1);
}
console.log("done");

// 4. Verify, and say plainly what is and isn't wired up.
const sql = neon(databaseUrl);
const [types] = await sql`select count(*)::int as n from types`;
const [users] = await sql`select count(*)::int as n from users`;
const [ownerRow] = await sql`select email from users where email = ${ownerEmail}`;

console.log(`\n  types     ${types.n}`);
console.log(`  users     ${users.n}`);
console.log(`  owner     ${ownerRow ? `${ownerRow.email} ✔` : "MISSING ✖"}`);

if (!ownerRow) {
  console.error(
    "\nThe owner row was not created. Signing in will land on " +
      '"Signed in, but not recognized". Re-run with the exact sign-in address.'
  );
  process.exit(1);
}

console.log(`\nDatabase ready for "${name}".`);
console.log("\nStill needed on the host (Vercel project → Environment Variables):");
console.log("  DATABASE_URL                        this same pooler string");
console.log("  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   their OWN Clerk app, not a shared one");
console.log("  CLERK_SECRET_KEY                    a missing key is a hard 503, not a partial app");
console.log("  NEXT_PUBLIC_CLERK_SIGN_IN_URL       /sign-in");
console.log("\nOptional, and each degrades quietly if unset:");
console.log("  R2_*                                without it, uploads and attachments do not work");
console.log("  GITHUB_TOKEN                        powers the Changelog and the update check");
console.log("  LEDGR_SELF_UPDATE=safe|on           lets them take updates from Build → Updates");
if (appUrl) console.log(`\nWhen the host is configured: ${appUrl}`);
