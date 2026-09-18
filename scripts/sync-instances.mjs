// Push the latest upstream main out to every satellite instance, in the only
// safe order: MIGRATE THE DATABASE FIRST, SYNC THE FORK SECOND.
//
// Why the order is the whole point: syncing a fork pushes commits to its main,
// which triggers that person's Vercel deploy immediately. There is no
// migrate-on-deploy (runbook.md §1a), so code carrying a migration that lands
// before its schema does leaves their instance serving pages its database
// cannot answer. A failed migration therefore BLOCKS that fork's sync and the
// instance stays on the older, working code.
//
// Run: npm run instances:sync            (all instances)
//      npm run instances:sync -- --dry-run
//      npm run instances:sync -- --only michelle
//      npm run instances:sync -- --check  (poll each /health afterwards)
//
// Roster: instances.local.json (gitignored). See instances.example.json.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import {
  loadConfig,
  selectInstances,
  assertPooler,
  assertGh,
  gh,
  headSha,
  hostOf,
} from "./instances-config.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

const dryRun = flag("dry-run");
const force = flag("force");
const check = flag("check");

let config;
let targets;
try {
  config = loadConfig();
  targets = selectInstances(config.instances, value("only"));
  for (const inst of targets) assertPooler(inst.databaseUrl, inst.name);
  if (!dryRun) assertGh();
  else assertGh();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));

const upstreamSha = headSha(config.upstream, config.branch);
if (!upstreamSha) {
  console.error(
    `Could not read ${config.upstream}@${config.branch}. Is the repo name right and gh authenticated?`
  );
  process.exit(1);
}

console.log(
  `${dryRun ? "DRY RUN — " : ""}upstream ${config.upstream}@${config.branch} is at ${upstreamSha.slice(0, 7)}`
);
console.log(`instances: ${targets.map((i) => i.name).join(", ")}\n`);

const results = [];

for (const inst of targets) {
  console.log(`── ${inst.name} ──`);
  const result = { name: inst.name, migrated: 0, synced: false, failed: null };

  // 1. What does this database still owe? (Drizzle applies where when > max applied.)
  let pending;
  try {
    pending = await pendingMigrations(inst.databaseUrl);
  } catch (err) {
    console.log(`   db      ${hostOf(inst.databaseUrl)}`);
    console.log(`   ✖ cannot reach the database: ${err.message}`);
    result.failed = "database unreachable";
    results.push(result);
    console.log("");
    continue;
  }

  console.log(`   db      ${hostOf(inst.databaseUrl)}`);
  console.log(
    pending.fresh
      ? `   schema  EMPTY DATABASE — run: npm run instance:new -- ${inst.name}`
      : `   schema  ${pending.tags.length} pending${pending.tags.length ? `: ${pending.tags.join(", ")}` : ""}`
  );

  // An empty database is a new instance, not a stale one. Seeding matters here
  // (an unseeded owner is the "Signed in, but not recognized" screen), so send
  // it to new-instance.mjs rather than half-provisioning it from the sync path.
  if (pending.fresh) {
    result.failed = "database not initialized";
    results.push(result);
    console.log("");
    continue;
  }

  const forkSha = headSha(inst.fork, inst.branch);
  if (!forkSha) {
    console.log(`   ✖ cannot read ${inst.fork}@${inst.branch} — does the fork exist yet?`);
    result.failed = "fork unreachable";
    results.push(result);
    console.log("");
    continue;
  }
  const alreadyCurrent = forkSha === upstreamSha;
  console.log(
    `   fork    ${inst.fork}@${inst.branch} at ${forkSha.slice(0, 7)}${alreadyCurrent ? " (current)" : ""}`
  );

  if (dryRun) {
    console.log(
      `   would   ${pending.tags.length ? `apply ${pending.tags.length} migration(s), then ` : ""}${
        alreadyCurrent ? "leave the fork as is" : `sync to ${upstreamSha.slice(0, 7)}`
      }`
    );
    results.push(result);
    console.log("");
    continue;
  }

  // 2. Migrate. This gates the sync.
  if (pending.tags.length > 0) {
    try {
      const db = drizzle(neon(inst.databaseUrl));
      await migrate(db, { migrationsFolder: "./drizzle" });
      result.migrated = pending.tags.length;
      console.log(`   ✔ applied ${pending.tags.length} migration(s)`);
    } catch (err) {
      console.log(`   ✖ migration failed: ${err.message}`);
      console.log(`   → fork NOT synced; this instance stays on its working code`);
      result.failed = "migration failed";
      results.push(result);
      console.log("");
      continue;
    }
  }

  // 3. Sync the fork, which is what triggers their deploy.
  if (alreadyCurrent) {
    console.log(`   · fork already current, nothing to sync`);
  } else {
    try {
      const out = gh([
        "repo",
        "sync",
        inst.fork,
        "--source",
        config.upstream,
        "--branch",
        inst.branch,
        ...(force ? ["--force"] : []),
      ]);
      result.synced = true;
      console.log(`   ✔ synced to ${upstreamSha.slice(0, 7)}${out.trim() ? ` — ${out.trim()}` : ""}`);
      if (inst.appUrl) console.log(`   → deploying: ${inst.appUrl}`);
    } catch (err) {
      const stderr = (err.stderr || "").toString().trim();
      console.log(`   ✖ sync failed: ${stderr || err.message}`);
      if (/diverge|fast.?forward/i.test(stderr)) {
        console.log(
          `   → their main has commits upstream doesn't. Re-run with --force to` +
            ` discard them, but look at what they are first.`
        );
      } else {
        console.log(`   → do you have push access on ${inst.fork}?`);
      }
      result.failed = "sync failed";
    }
  }

  // 4. Optional: confirm the deploy came back healthy.
  if (check && inst.appUrl && !result.failed) {
    const health = await pollHealth(inst.appUrl);
    console.log(health.ok ? `   ✔ /health ${health.detail}` : `   ✖ /health ${health.detail}`);
    if (!health.ok) result.failed = "health check failed";
  }

  results.push(result);
  console.log("");
}

// Summary
const failed = results.filter((r) => r.failed);
console.log("──────────");
for (const r of results) {
  const state = r.failed
    ? `FAILED (${r.failed})`
    : dryRun
      ? "ok (dry run)"
      : [r.migrated ? `${r.migrated} migration(s)` : null, r.synced ? "synced" : "already current"]
          .filter(Boolean)
          .join(", ");
  console.log(`${r.name.padEnd(12)} ${state}`);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} instance(s) need attention.`);
  process.exit(1);
}

/**
 * Compare the local drizzle journal against what the database has applied.
 * Mirrors the migrator's own rule: an entry is pending when its `when` is
 * greater than the newest applied timestamp.
 */
async function pendingMigrations(databaseUrl) {
  const sql = neon(databaseUrl);
  const [{ reg }] = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS reg`;
  if (!reg) return { fresh: true, tags: journal.entries.map((e) => e.tag) };
  const [{ max }] =
    await sql`SELECT COALESCE(MAX(created_at), 0)::text AS max FROM drizzle.__drizzle_migrations`;
  const applied = Number(max);
  return {
    fresh: false,
    tags: journal.entries.filter((e) => e.when > applied).map((e) => e.tag),
  };
}

/** A deploy takes a moment; give it a few tries before calling it broken. */
async function pollHealth(appUrl, attempts = 10, delayMs = 6000) {
  const url = `${appUrl.replace(/\/$/, "")}/health`;
  let detail = "no response";
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 3000 : delayMs));
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const body = await res.text();
      detail = `${res.status} ${body.slice(0, 120).replace(/\s+/g, " ")}`;
      if (res.ok) return { ok: true, detail };
    } catch (err) {
      detail = err.message;
    }
  }
  return { ok: false, detail };
}
