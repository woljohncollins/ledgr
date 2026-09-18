// Verification for the local-peer supervisor (LH2, ADR-206 decision 6) and
// the localAuthProvider selection rule (plan decision 5). Everything here is
// PURE on purpose: the supervisor's decisions (config validation, the
// keep-last-good pointer flip, npm-ci-only-on-lockfile-change, prune-to-2,
// backoff, env assembly) live in supervisor/lib.mjs precisely so this script
// can exercise them with no Postgres, no git, and no child processes; the
// spawn shell in ledgr-supervisor.mjs stays thin and untested.
//
// NOTE this file must never contain the literal name of the database
// connection env var — verify-ci.mjs classifies any script mentioning it as
// backend-needing and would silently drop this suite from CI. Hence DB_KEY.
//
// Run: npx tsx scripts/verify-supervisor.mts
import { existsSync, readFileSync } from "node:fs";
import { MOVABLE_JOBS, type MovableJob } from "@/lib/job-owners";
import { resolve } from "node:path";
import {
  assembleAppEnv,
  buildDbUrl,
  ctlScriptFor,
  formatSchtasks,
  elevatedCmdScript,
  decideFlip,
  isSupervisorCommandLine,
  lockPath,
  lockVerdict,
  parsePostmasterPid,
  postmasterVerdict,
  needsNpmCi,
  nextBackoffMs,
  normalizeConfig,
  parseLivePointer,
  pruneList,
  serializeLivePointer,
  parseStartupRequest,
  serializeStartupRequest,
  parseStartupState,
  serializeStartupState,
  parseSchtasksLogonMode,
  schtasksCreateArgs,
  startupCaveat,
  startupSignalPath,
  startupStatePath,
  stopSignalPath,
  LOCAL_JOBS,
  normalizeCrons,
  parseDailyAt,
  nextDailyAt,
  nextRunAt,
  initialDueAt,
  jobStaleness,
  serializeCronState,
  standDownDetailOf,
  parseCronState,
  localCronTokenEntry,
  CRON_RETRY_MS,
  CRON_STARTUP_GRACE_MS,
} from "../supervisor/lib.mjs";
import { chooseAuthProvider } from "../src/lib/auth/local";

const DB_KEY = ["DATABASE", "URL"].join("_");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── (1) Config parsing / validation ──────────────────────────────────────────

const goodRaw = {
  role: "spoke",
  dataDir: "/data/ledgr",
  ownerEmail: "brandon@example.com",
  hubs: ["https://hub.example.com"],
  deviceToken: "tok",
  update: { mode: "prompted", pollIntervalMs: 900000 },
  cadence: { pushDebounceMs: 2500, pullMs: 12000 },
};
const cfg = normalizeConfig(goodRaw, "/repo/supervisor");

check("a valid config normalizes", cfg.role === "spoke" && cfg.ownerEmail === "brandon@example.com");
check("dataDir stays absolute", cfg.dataDir === "/data/ledgr");
// resolve() rather than a literal so the check holds on win32 too (where
// resolving "/repo/supervisor/.." gains a drive letter).
check(
  "repoDir defaults to the repo the supervisor lives in",
  cfg.repoDir === resolve("/repo/supervisor", "..")
);
check("ports default sanely", cfg.appPort === 3000 && cfg.dbPort === 5433);
check("cadence knobs are read", cfg.cadence.pushDebounceMs === 2500 && cfg.cadence.pullMs === 12000);
check("update mode + poll interval are read", cfg.update.mode === "prompted" && cfg.update.pollIntervalMs === 900000);

check("missing dataDir is refused", throws(() => normalizeConfig({ ownerEmail: "a@b.c" }, "/x")));
check("missing ownerEmail is refused", throws(() => normalizeConfig({ dataDir: "/d" }, "/x")));
check(
  "a bogus role is refused",
  throws(() => normalizeConfig({ ...goodRaw, role: "server" }, "/x"))
);
check(
  "a bogus update mode is refused",
  throws(() => normalizeConfig({ ...goodRaw, update: { mode: "yolo" } }, "/x"))
);
check("syncMode defaults to full", cfg.syncMode === "full");
check(
  "syncMode: pull-only is accepted",
  normalizeConfig({ ...goodRaw, syncMode: "pull-only" }, "/x").syncMode === "pull-only"
);
check(
  "a bogus syncMode is refused",
  throws(() => normalizeConfig({ ...goodRaw, syncMode: "read-write" }, "/x"))
);
check(
  "syncGuardrails default sanely",
  cfg.syncGuardrails.maxFirstPush === 500 &&
    cfg.syncGuardrails.confirmLargePush === false &&
    cfg.syncGuardrails.skewWarnMs === 5000 &&
    cfg.syncGuardrails.skewHoldMs === 60000
);
check(
  "syncGuardrails are read from config",
  normalizeConfig(
    { ...goodRaw, syncGuardrails: { maxFirstPush: 50, confirmLargePush: true, skewWarnMs: 1000, skewHoldMs: 5000 } },
    "/x"
  ).syncGuardrails.maxFirstPush === 50
);
check(
  "a bogus port is refused",
  throws(() => normalizeConfig({ ...goodRaw, appPort: "eighty" }, "/x"))
);
check(
  "defaults fill for the optional knobs",
  (() => {
    const minimal = normalizeConfig({ dataDir: "/d", ownerEmail: "a@b.c" }, "/x");
    return (
      minimal.role === "spoke" &&
      minimal.update.mode === "prompted" &&
      minimal.cadence.pushDebounceMs === 2000 &&
      minimal.cadence.pullMs === 10000 &&
      minimal.hubs.length === 0
    );
  })()
);

// ── (2) Env assembly ─────────────────────────────────────────────────────────

const env = assembleAppEnv(cfg, "abc1234def") as Record<string, string>;
check("app env points the DB at the local cluster", env[DB_KEY] === buildDbUrl(cfg) && env[DB_KEY].includes("127.0.0.1:5433"));
check("the build sha is stamped (the ADR-194 currency gap)", env.LEDGR_BUILD_SHA === "abc1234def");
check("the local owner identity is passed", env.LEDGR_LOCAL_OWNER_EMAIL === "brandon@example.com");
check("the supervisor signal dir is passed", env.LEDGR_SUPERVISOR_DIR === "/data/ledgr");
check(
  "self-update is on (the supervisor migrates before the swap)",
  env.LEDGR_SELF_UPDATE === "on"
);
check(
  "the tracked branch reaches the app, so Updates asks about the ref we build",
  env.GITHUB_BRANCH === cfg.branch &&
    (assembleAppEnv(
      normalizeConfig({ ...goodRaw, branch: "prod-brandon" }, "/x"),
      "s"
    ) as Record<string, string>).GITHUB_BRANCH === "prod-brandon"
);
check(
  "sync vars arrive from config",
  env.LEDGR_SYNC_HUBS === "https://hub.example.com" && env.LEDGR_SYNC_TOKEN === "tok"
);
check(
  "cadence knobs land as sync env",
  env.LEDGR_SYNC_PUSH_DEBOUNCE_MS === "2500" && env.LEDGR_SYNC_PULL_MS === "12000"
);
check("syncMode lands as sync env", env.LEDGR_SYNC_MODE === "full");
check(
  "guardrail knobs land as sync env",
  env.LEDGR_SYNC_MAX_FIRST_PUSH === "500" &&
    env.LEDGR_SYNC_CONFIRM_LARGE_PUSH === "false" &&
    env.LEDGR_SYNC_SKEW_WARN_MS === "5000" &&
    env.LEDGR_SYNC_SKEW_HOLD_MS === "60000"
);
check(
  "no hubs (or no token) means NO half-armed sync env",
  (() => {
    const e = assembleAppEnv(
      normalizeConfig({ dataDir: "/d", ownerEmail: "a@b.c" }, "/x"),
      "sha"
    ) as Record<string, string>;
    return (
      !("LEDGR_SYNC_HUBS" in e) &&
      !("LEDGR_SYNC_TOKEN" in e) &&
      !("LEDGR_SYNC_MODE" in e) &&
      !("LEDGR_SYNC_MAX_FIRST_PUSH" in e)
    );
  })()
);
check(
  "extraEnv passes through verbatim",
  (assembleAppEnv(
    normalizeConfig({ ...goodRaw, extraEnv: { R2_BUCKET: "b" } }, "/x"),
    "s"
  ) as Record<string, string>).R2_BUCKET === "b"
);

// ── (3) The live pointer + keep-last-good flip ───────────────────────────────

check(
  "a written pointer round-trips",
  (() => {
    const p = parseLivePointer(serializeLivePointer("/data/builds/abc", "abc"));
    return p !== null && p.dir === "/data/builds/abc" && p.sha === "abc";
  })()
);
check("garbage pointer text reads as no live build", parseLivePointer("not json{") === null);
check("a pointer missing its sha reads as no live build", parseLivePointer('{"dir":"/x"}') === null);

check("build ok + migrate ok flips", decideFlip({ buildOk: true, migrateOk: true }) === "flip");
check(
  "A FAILED MIGRATE KEEPS THE LAST GOOD BUILD (the whole point)",
  decideFlip({ buildOk: true, migrateOk: false }) === "keep"
);
check("a failed build keeps the last good build", decideFlip({ buildOk: false, migrateOk: false }) === "keep");
check(
  "undefined outcomes keep, never flip (fail closed)",
  decideFlip({ buildOk: undefined, migrateOk: undefined }) === "keep"
);

// ── (4) npm ci only when the lockfile changed ────────────────────────────────

check("same lockfile hash skips npm ci", needsNpmCi("aaa", "aaa") === false);
check("a changed lockfile hash requires npm ci", needsNpmCi("aaa", "bbb") === true);
check("no previous build requires npm ci", needsNpmCi(null, "bbb") === true);

// ── (5) Prune to the last 2 builds ───────────────────────────────────────────

const builds = [
  { sha: "old1", mtimeMs: 100 },
  { sha: "old2", mtimeMs: 200 },
  { sha: "prev", mtimeMs: 300 },
  { sha: "live", mtimeMs: 400 },
];
check(
  "prune keeps the live build and the newest fallback, drops the rest",
  JSON.stringify(pruneList(builds, "live").sort()) === JSON.stringify(["old1", "old2"])
);
check(
  "the live build is kept even when it is not the newest",
  !pruneList(builds, "old1").includes("old1")
);
check("one build prunes nothing", pruneList([{ sha: "live", mtimeMs: 1 }], "live").length === 0);
check("two builds prune nothing", pruneList(builds.slice(2), "live").length === 0);

// ── (6) Crash backoff ────────────────────────────────────────────────────────

check("first crash restarts fast", nextBackoffMs(0) === 1000);
check("backoff grows exponentially", nextBackoffMs(3) === 8000);
check("backoff caps at 60s", nextBackoffMs(20) === 60000);

// ── (7) localAuthProvider selection (plan decision 5, ADR-184 held) ─────────

const baseEnv = {
  clerkConfigured: false,
  deployed: false,
  localOwnerEmail: undefined as string | undefined,
  nodeEnv: "production" as string | undefined,
  devUserEmail: undefined as string | undefined,
};

check(
  "a configured Clerk always wins (hubs keep Clerk)",
  chooseAuthProvider({ ...baseEnv, clerkConfigured: true, localOwnerEmail: "a@b.c" }) === "clerk"
);
check(
  "local mode: owner email set, no Clerk, not deployed → local, in production builds",
  chooseAuthProvider({ ...baseEnv, localOwnerEmail: "a@b.c" }) === "local"
);
check(
  "A DEPLOYED VERCEL ENV NEVER FALLS INTO LOCAL MODE (ADR-184 fail-closed)",
  chooseAuthProvider({ ...baseEnv, deployed: true, localOwnerEmail: "a@b.c" }) === "null"
);
check(
  "the dev stand-in is unchanged (development + DEV_USER_EMAIL)",
  chooseAuthProvider({ ...baseEnv, nodeEnv: "development", devUserEmail: "d@e.f" }) === "dev"
);
check(
  "local outranks the dev stand-in when both are set",
  chooseAuthProvider({
    ...baseEnv,
    nodeEnv: "development",
    devUserEmail: "d@e.f",
    localOwnerEmail: "a@b.c",
  }) === "local"
);
check(
  "nothing configured means nobody is signed in",
  chooseAuthProvider(baseEnv) === "null"
);
check(
  "DEV_USER_EMAIL alone does nothing in production (the old gate holds)",
  chooseAuthProvider({ ...baseEnv, devUserEmail: "d@e.f" }) === "null"
);

// ── (8) Structural guards ────────────────────────────────────────────────────

check("the supervisor entrypoint exists", existsSync("supervisor/ledgr-supervisor.mjs"));

// The update path is in the untested spawn shell, so this is a structural
// tripwire rather than a behavioral test — but the regression it guards is one
// that ships unreleased code silently, which is worth a grep. `repoDir`
// defaults to the checkout the supervisor lives in, so on a builder's machine
// HEAD is whatever branch somebody last checked out. Resolving the target from
// `origin/<branch>` is what makes that irrelevant; a `git pull` followed by
// `rev-parse HEAD` is the shape that only worked by coincidence.
{
  const shell = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  check(
    "the update target is the tracked branch's remote ref, never the checkout's HEAD",
    // The branch comes from the update policy file now (ADR-257), not cfg.
    shell.includes("`origin/${branch}`") && !shell.includes('"pull", "--ff-only"')
  );
  check(
    "the auto poll compares against what is being SERVED, not against HEAD",
    /liveBuild\(\)\?\.sha !== target\.sha/.test(shell)
  );
}
check("the config template is tracked", existsSync("supervisor/config.example.json"));
check(
  "the real config (device token) is gitignored",
  readFileSync(".gitignore", "utf8").includes("supervisor/config.json")
);
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
};
check("local:supervisor is wired", !!pkg.scripts["local:supervisor"]);
check("local:restore is wired", !!pkg.scripts["local:restore"]);
check(
  "embedded-postgres is a RUNTIME dependency (the local peer needs it at runtime)",
  !!pkg.dependencies["embedded-postgres"] && !pkg.devDependencies?.["embedded-postgres"]
);

const localAuth = readFileSync("src/lib/auth/local.ts", "utf8");
check(
  "local.ts never imports Clerk (the seam holds)",
  !/from\s+["']@clerk\/nextjs/.test(localAuth)
);

const restoreSrc = readFileSync("scripts/local-restore.mjs", "utf8");
check(
  "the restore script clears the cloned sync identity (ops, device, peers, cursors)",
  restoreSrc.includes("truncate sync_ops") &&
    restoreSrc.includes("delete from sync_device") &&
    restoreSrc.includes("truncate sync_peers") &&
    restoreSrc.includes("sync:cursor:")
);
// Regression, 2026-08-23: job_state is INSIDE the fill's copy set, so every
// per-instance key in it must be cleared after a fill or the peer inherits the
// source's. `sync:mode` (the GUI push-mode override) shipped the same day the
// clearing list forgot it, which would have silently armed or disarmed push on
// a re-filled peer. Both fill paths — dump and live pull — have to clear it.
{
  // Count the DELETE statements, not mentions: a comment saying it happens
  // must not satisfy this.
  const clears = restoreSrc
    .split("\n")
    .filter((l) => l.includes("delete from job_state") && l.includes("sync:mode")).length;
  check(
    "BOTH fill paths clear the push-mode override in an actual DELETE",
    clears >= 2,
    `${clears} statement(s)`
  );
}
check(
  "the restore script re-seeds a fresh device identity",
  /insert into sync_device/.test(restoreSrc)
);
check(
  "local-restore.mjs never reads the DB env var directly (writes only ever target 127.0.0.1; the --from-url source connection is the one deliberate, read-only exception)",
  !restoreSrc.includes(`process.env.${DB_KEY}`) && restoreSrc.includes("127.0.0.1")
);
check(
  "the --from-url path is native (no pg_dump/pg_restore shelled out to; copies rows with the pg driver)",
  !restoreSrc.includes('"pg_dump"') && restoreSrc.includes("copyAllTables")
);
check(
  "the --from-url connection string is redacted rather than logged raw",
  restoreSrc.includes("redactConnectionString") && !/console\.(log|error)\(`[^`]*\$\{fromUrl\}/.test(restoreSrc)
);

const supervisorSrc = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
const ctlSrc = readFileSync("supervisor/ledgr-ctl.mjs", "utf8");
const procSrc = readFileSync("supervisor/proc.mjs", "utf8");
check(
  "the supervisor watches the same signal file the updates route writes",
  supervisorSrc.includes("signalPath") &&
    readFileSync("src/app/api/updates/route.ts", "utf8").includes("update-requested") &&
    readFileSync("supervisor/lib.mjs", "utf8").includes('"update-requested"')
);
check(
  "the flip is guarded by decideFlip (keep-last-good is the rule, not a comment)",
  supervisorSrc.includes("decideFlip")
);

// ── Single-instance ownership (regression, 2026-08-23) ──────────────────────
//
// Three supervisors had accumulated on one machine, because stopping
// `npm run local:supervisor` kills npm and orphans its node child. An orphan
// won the race for an update signal file, tried to apply it with its app and
// Postgres already killed underneath it, and the update failed silently. Two
// is also the state README steps 5 and 7 produce on purpose (run it in a
// terminal, then register it at boot), so the lock is the fix, not a warning.
{
  const v = (o: Parameters<typeof lockVerdict>[0]) => lockVerdict(o);
  check("the lock lives in the data dir, beside the other supervisor state", lockPath("/data").endsWith("supervisor.lock"));
  check("no owner recorded (garbage or empty file) -> take it", v({ recordedPid: NaN, ownPid: 42, alive: false }) === "take");
  check("a zero/negative pid is garbage, not an owner", v({ recordedPid: 0, ownPid: 42, alive: false }) === "take");
  check("the recorded owner is gone -> steal the stale lock", v({ recordedPid: 99, ownPid: 42, alive: false }) === "steal");
  check("our own pid -> already mine, never refuse ourselves", v({ recordedPid: 42, ownPid: 42, alive: true }) === "mine");
  check(
    "a live process that IS a supervisor -> REFUSE, this is the whole point",
    v({ recordedPid: 99, ownPid: 42, alive: true, identified: true }) === "refuse"
  );

  // The 2026-08-27 reboot, as three tests. The peer did not come back because
  // the lock named pid 4080, the supervisor behind it was dead, and Windows had
  // reissued 4080 to something else — so "alive" was true and every start was
  // refused. Aliveness must never decide on its own again.
  check(
    "a live process that is NOT a supervisor (a reissued pid) -> steal, not refuse",
    v({ recordedPid: 4080, ownPid: 42, alive: true, identified: false }) === "steal"
  );
  check(
    "identity unreadable and nothing serving -> steal (the reboot case, uncorroborated)",
    v({ recordedPid: 4080, ownPid: 42, alive: true, identified: null, serving: false }) === "steal"
  );
  check(
    "identity unreadable but Postgres IS serving -> refuse; never two supervisors on one dataDir",
    v({ recordedPid: 4080, ownPid: 42, alive: true, identified: null, serving: true }) === "refuse"
  );
  check(
    "a command line naming the supervisor script is recognised, whatever the paths around it",
    isSupervisorCommandLine('"C:\\dev\\node\\node.exe" "C:\\dev\\ledgr\\supervisor\\ledgr-supervisor.mjs" "cfg.json"') &&
      !isSupervisorCommandLine('"C:\\dev\\node\\node.exe" "C:\\dev\\ledgr\\supervisor\\ledgr-ctl.mjs" status') &&
      !isSupervisorCommandLine(null as unknown as string)
  );
}
check(
  "the supervisor takes the lock BEFORE starting postgres (a loser must touch nothing)",
  supervisorSrc.indexOf("await acquireLock()") > 0 &&
    supervisorSrc.indexOf("await acquireLock()") < supervisorSrc.indexOf("await startPostgres()")
);

// ── Postgres's own lock, after an unclean shutdown ───────────────────────────
//
// The half of 2026-08-27 that actually stopped the peer. A reboot that did not
// shut Postgres down leaves postmaster.pid naming the pid it last ran as; if
// Windows has reissued that number — likeliest right after a boot — Postgres
// refuses to start and retrying cannot help. Deleting the file is Postgres's
// own documented recovery; these are the guards that keep the automatic version
// from ever deleting a live cluster's lock.
{
  const sample = ["3144", "C:/ledgr-data-prod/pg", "1787763967", "5433", "", "localhost", "", "ready   "].join("\n");
  const parsed = parsePostmasterPid(sample);
  check("postmaster.pid line 1 is the pid, line 4 is the port", parsed.pid === 3144 && parsed.port === 5433);
  check("a truncated or empty postmaster.pid parses to nulls rather than throwing", parsePostmasterPid("").pid === null);

  const pv = postmasterVerdict;
  check(
    "something IS listening on the port -> live, hands off, whatever the pid says",
    pv({ recordedPid: 3144, alive: false, image: null, portListening: true }) === "live"
  );
  check(
    "the recorded pid is gone and nothing is listening -> stale",
    pv({ recordedPid: 3144, alive: false, image: null, portListening: false }) === "stale"
  );
  check(
    "the recorded pid is alive AND is a postmaster -> live, leave it alone",
    pv({ recordedPid: 3144, alive: true, image: "postgres.exe", portListening: false }) === "live"
  );
  check(
    "the recorded pid is alive but is some other program (a reissued pid) -> stale",
    pv({ recordedPid: 3144, alive: true, image: "svchost.exe", portListening: false }) === "stale"
  );
  check(
    "a garbage pid with nothing listening -> stale",
    pv({ recordedPid: null, alive: false, image: null, portListening: false }) === "stale"
  );
}
check(
  "a cleared postgres lock buys a fresh set of attempts, but only once (no retry loop)",
  supervisorSrc.includes("!rescued && (await clearStalePostmasterPid())") && supervisorSrc.includes("if (cleared) attempt = 0")
);

// The mirror image, and just as fatal: a supervisor that died without stopping
// Postgres leaves it LISTENING. Nothing may be deleted there — the cluster is
// genuinely up — but the port is taken, so a fresh peer can never have it.
check(
  "an orphaned Postgres is cleared BEFORE the attempts, not retried into",
  supervisorSrc.indexOf("await stopOrphanedPostgres()") > 0 &&
    supervisorSrc.indexOf("await stopOrphanedPostgres()") <
      supervisorSrc.indexOf("await startPostgresOnce()")
);

// Postgres refuses to run with administrator rights, and the at-boot task runs
// with an UNFILTERED admin token (Windows only strips admin from interactive
// sign-ins). Spawning postgres.exe directly therefore worked from the tray and
// failed on every single reboot — the peer was down each morning until someone
// started it by hand (2026-08-27, 2026-08-29). pg_ctl drops its own privileges
// before launching the server, so the same command works either way.
check(
  "postgres is started through pg_ctl, so an elevated at-boot task can start it",
  /async function startPostgresOnce[\s\S]*?pgCtl,\s*\[\s*"start"/.test(supervisorSrc)
);
// On Windows pg_ctl does NOT exit once the server is up — it stays alive as the
// restricted-token parent. Waiting on it hung the supervisor with a healthy
// database underneath (2026-08-29). Readiness must come from pg_isready, which
// also answers the right question: the port opens before recovery finishes.
// Scoped to the function body: `run(pgCtl, …)` is still the RIGHT call in
// stopPostgresGracefully, so an unscoped search would read the stop path and
// call the start path guilty.
const startOnceBody = supervisorSrc.slice(
  supervisorSrc.indexOf("async function startPostgresOnce"),
  supervisorSrc.indexOf("\n}", supervisorSrc.indexOf("async function startPostgresOnce"))
);
check(
  "pg_ctl is spawned, never waited on, so a parent that outlives the start cannot hang the supervisor",
  /spawn\(\s*pgCtl,/.test(startOnceBody) &&
    startOnceBody.includes("child.unref()") &&
    !startOnceBody.includes("run(pgCtl")
);
// Readiness must be a real connection. A listening port is not readiness (it
// opens before recovery finishes), and pg_isready is not even present: this
// Postgres build ships initdb, pg_ctl and postgres and nothing else, so a check
// built on that binary reports every healthy cluster as dead.
const pgIsReadyBody = supervisorSrc.slice(
  supervisorSrc.indexOf("async function pgIsReady"),
  supervisorSrc.indexOf("\n}", supervisorSrc.indexOf("async function pgIsReady"))
);
check(
  "readiness is an actual connection, not a listening port and not the absent pg_isready",
  /async function startPostgresOnce[\s\S]*?await pgIsReady\(\)/.test(supervisorSrc) &&
    /new PgClient\([\s\S]*?await client\.connect\(\)/.test(pgIsReadyBody) &&
    // no child process at all: the probe must not depend on a binary, since the
    // one it would reach for is not shipped.
    !/\brun\(|\bspawn/.test(pgIsReadyBody)
);
check(
  "the readiness probe targets the built-in postgres database, which exists before ledgr is created",
  pgIsReadyBody.includes('database: "postgres"')
);
check(
  "the orphan is stopped cleanly through pg_ctl, not killed (the existing shutdown path)",
  /stopOrphanedPostgres[\s\S]*?return stopPostgresGracefully\(\);/.test(supervisorSrc)
);
check(
  "only OUR postmaster is ever stopped: our port, our lock file, and really a postgres",
  /stopOrphanedPostgres[\s\S]*?portListening\(cfg\.dbPort\)[\s\S]*?parsePostmasterPid[\s\S]*?image\.includes\("postgres"\)/.test(
    supervisorSrc
  )
);

// ── The boot path Windows actually runs ──────────────────────────────────────
//
// The scheduled task starts ledgr-ctl's `boot` verb, not the supervisor. A task
// action has no stdout, so a supervisor Windows launches directly writes its
// startup into nowhere: on 2026-08-27 that cost us every word of why Postgres
// would not start. Going through `boot` attaches the peer's log files and
// clears a stale lock on the way past.
{
  const taskArgs = schtasksCreateArgs({
    username: "someone",
    nodePath: "C:\\dev\\node\\node.exe",
    supervisorScript: "C:\\dev\\ledgr\\supervisor\\ledgr-supervisor.mjs",
    configPath: "C:\\dev\\ledgr\\supervisor\\config.json",
    scope: "always",
  });
  const tr = taskArgs[taskArgs.indexOf("/TR") + 1];
  check("the boot task runs the control script, not the supervisor directly", tr.includes("ledgr-ctl.mjs"));
  check("...with the boot verb", / boot /.test(tr));
  check("...and the config it was installed with", tr.includes("--config="));
  // Both separators, because this path describes the machine being CONFIGURED
  // and node's own join/dirname read the separator of the machine RUNNING the
  // code. The first version used them and so passed on the Windows rig and
  // failed in Linux CI — with the Windows case being the one that ships.
  check(
    "the control script is found beside the supervisor, so no caller passes a second path",
    ctlScriptFor("/x/y/ledgr-supervisor.mjs") === "/x/y/ledgr-ctl.mjs"
  );
  check(
    "...and a Windows path keeps its backslashes, whatever platform is asking",
    ctlScriptFor("C:\\dev\\ledgr\\supervisor\\ledgr-supervisor.mjs") ===
      "C:\\dev\\ledgr\\supervisor\\ledgr-ctl.mjs"
  );
  check(
    "the whole task command stays inside schtasks's 261-character /TR limit",
    tr.length <= 261,
    `${tr.length} chars`
  );
  check("boot is a real verb the task can call", ctlSrc.includes("boot: doBoot"));

  // The pasteable fallback, which every "schtasks failed" message tells the
  // owner to run in PowerShell. Without --% PowerShell parses the line itself
  // and re-quotes on the way to the executable, and the /TR value is a command
  // line made of quotes. Brandon pasted the un-prefixed version on 2026-08-27
  // and got "Invalid argument/option"; worse, the two natural repairs both
  // reported SUCCESS while registering a task whose command had lost every
  // quote — fine until a path has a space in it.
  const line = formatSchtasks(taskArgs, { shell: "powershell" });
  check("the pasteable command stops PowerShell parsing it (--%)", line.startsWith("schtasks --% "));
  check(
    "...and still escapes the inner quotes, which schtasks itself then parses",
    line.includes('/TR "\\"C:\\dev\\node\\node.exe\\"')
  );
  // --% is a PowerShell token; in the elevation path's .cmd it would reach
  // schtasks as a literal argument and break the registration the in-app
  // consent dialog performs. Different shells, so the shell is named.
  check(
    "the cmd form does NOT carry --%, which only PowerShell understands",
    formatSchtasks(taskArgs).startsWith("schtasks /Create") &&
      !elevatedCmdScript(taskArgs).includes("--%")
  );
  check(
    "both surfaces that ask the owner to paste use the PowerShell form",
    ctlSrc.includes('formatSchtasks(args, { shell: "powershell" })') &&
      supervisorSrc.includes('formatSchtasks(args, { shell: "powershell" })')
  );
  check(
    "the message offers the elevated npm command first — nothing to mistype there",
    ctlSrc.includes("npm run local:startup -- --always")
  );
  check(
    "boot starts the supervisor with the log files attached (the invisible-failure fix)",
    ctlSrc.includes("spawnDetachedSupervisor") && ctlSrc.includes('openSync(join(cfg.dataDir, "supervisor.log"), "a")')
  );
  check("boot clears a stale lock rather than waiting for a person", ctlSrc.includes("await clearStaleLock(pid)"));
  check(
    "status asks whether a SUPERVISOR is alive, not whether a pid exists",
    ctlSrc.includes("const running = await supervisorAlive(pid)")
  );
}

// ── The tray icon (the only surface that works when the app is down) ─────────
{
  const traySrc = readFileSync("supervisor/ledgr-tray.ps1", "utf8");
  check(
    "the tray's own process query cannot match itself — the pattern is built in halves",
    ctlSrc.includes("'*ledgr-' + 'tray.ps1*'") && !/like '\*ledgr-tray\.ps1\*'/.test(ctlSrc)
  );
  check(
    "the tray is launched through Start-Process; a bare detached spawn of powershell dies at once",
    ctlSrc.includes("Start-Process -FilePath 'powershell.exe'") && !ctlSrc.includes('spawn("powershell", trayArgs()')
  );
  check(
    "the tray never supervises anything itself — every action is a ledgr-ctl verb",
    /Invoke-Ctl[\s\S]*?Start-Process -FilePath \$NodePath/.test(traySrc) &&
      ["boot", "restart", "stop"].every((v) => traySrc.includes(`Invoke-Ctl "${v}"`))
  );
  check(
    "the icon is drawn once, not per poll (GetHicon leaks a handle every call)",
    /\$icons = @\{[\s\S]*?New-DotIcon/.test(traySrc) && !/add_Tick[\s\S]{0,200}New-DotIcon/.test(traySrc)
  );
  check(
    "the tray starts at SIGN-IN from its own shortcut, separately from the service's boot task",
    ctlSrc.includes("Startup") && ctlSrc.includes("Ledgr.lnk") && !ctlSrc.includes(`schtasksCreateArgs({ tray`)
  );
  check(
    "stopping or hiding the icon is worded so it cannot be mistaken for stopping Ledgr",
    traySrc.includes("Ledgr keeps running") && ctlSrc.includes("Ledgr itself is untouched")
  );
}
check(
  "the lock file is created atomically (wx), so a simultaneous start cannot double-take",
  supervisorSrc.includes("writeFileSync(lock") && supervisorSrc.includes('flag: "wx"')
);
check(
  "EPERM counts as alive (the owner exists, it just is not ours); only ESRCH is gone",
  procSrc.includes('err?.code === "EPERM"')
);
check(
  "one pid check, shared: neither entry point carries a private copy to drift from",
  !supervisorSrc.includes("function pidAlive") && !ctlSrc.includes("function pidAlive")
);
check("the lock is released on shutdown", supervisorSrc.includes("releaseLock()"));


// ── (N) The startup signal file — the in-app toggle's channel (ADR-211) ──────
//
// Same signal-file pattern as update-requested, deliberately. A malformed or
// truncated file must read as "no request" — acting on a half-written file is
// how a toggle turns into a surprise.
check(
  "a request round-trips",
  JSON.stringify(parseStartupRequest(serializeStartupRequest(true, "always"))) ===
    JSON.stringify({ enabled: true, scope: "always" })
);
check(
  "a disable request round-trips",
  parseStartupRequest(serializeStartupRequest(false, "logon"))?.enabled === false
);
check("a truncated request is ignored", parseStartupRequest('{"enabled":tr') === null);
check("an empty file is ignored", parseStartupRequest("") === null);
check("a request without enabled is ignored", parseStartupRequest('{"scope":"always"}') === null);
check(
  "a request with a junk scope still parses, defaulting to logon",
  parseStartupRequest('{"enabled":true,"scope":"whenever"}')?.scope === "logon"
);

// The recorded outcome. ok:false is a NORMAL state (elevation refused), so it
// has to survive the round trip with its detail and its escape-hatch command —
// an owner who ticks a box and is not told it failed believes their hub comes
// back after a reboot.
{
  const failed = parseStartupState(
    serializeStartupState({
      enabled: true,
      scope: "always",
      ok: false,
      detail: "Access is denied.",
      command: "schtasks /Create ...",
    })
  );
  check(
    "a failed registration round-trips with its reason and command",
    failed?.ok === false && failed.detail === "Access is denied." && !!failed.command
  );
  const good = parseStartupState(
    serializeStartupState({ enabled: true, scope: "logon", ok: true })
  );
  check("a successful registration round-trips", good?.ok === true && good.scope === "logon");
  check(
    "state defaults to NOT ok when the flag is missing, never to success",
    parseStartupState('{"enabled":true,"scope":"logon"}')?.ok === false
  );
  check("unreadable state is null", parseStartupState("nonsense") === null);
}

check(
  "the startup signal and state files live in the data dir, beside update-requested",
  startupSignalPath("/data/ledgr").endsWith("startup-requested") &&
    startupStatePath("/data/ledgr").endsWith("startup-state.json")
);
check("the stop request lives there too", stopSignalPath("/data/ledgr").endsWith("stop-requested"));

// ── "Start with the computer" asks the owner for no password at all ──────────
//
// The always-on scope used to register /RU with no credential flag, which
// Windows accepts and then silently downgrades to interactive-only: the owner
// ticks "at boot, always on", is told it worked, and the peer still does not
// come back from a boot nobody signs into. /NP (Task Scheduler's "Do not store
// password", an S4U logon) is what closes that without ever asking for a
// Windows password — which a Microsoft-account login does not readily give.
{
  const of = (scope: string) =>
    schtasksCreateArgs({
      username: "colli",
      nodePath: "C:\\node.exe",
      supervisorScript: "C:\\s.mjs",
      configPath: "C:\\c.json",
      scope,
    });
  const always = of("always");
  const logon = of("logon");

  check(
    "the always-on task is registered passwordless (/NP), right after its /RU account",
    always.includes("/NP") && always[always.indexOf("/RU") + 2] === "/NP"
  );
  check(
    "the logon scope stays credential-free: no /RU, and so no /NP to pair with it",
    !logon.includes("/RU") && !logon.includes("/NP")
  );
  check(
    "neither scope ever passes a password (/RP)",
    !always.includes("/RP") && !logon.includes("/RP")
  );

  // The honesty rule still has to fire if Windows hands back something weaker
  // than we asked for, and must NOT fire on the S4U mode /NP produces.
  const modeOf = (v: string) => parseSchtasksLogonMode(`TaskName: X\nLogon Mode:    ${v}\n`);
  check("an S4U registration reads as background", modeOf("Interactive/Background") === "background");
  check("a downgraded registration reads as interactive", modeOf("Interactive only") === "interactive");
  check(
    "the logon-mode regex tolerates indented schtasks output",
    parseSchtasksLogonMode("   Logon Mode:    Interactive only\n") === "interactive"
  );
  check(
    "no caveat when always-on actually runs in the background",
    startupCaveat("always", "background") === null
  );
  check(
    "a downgraded always-on task still says so, and no longer asks for a password",
    (startupCaveat("always", "interactive") ?? "").includes("only run it while you are signed in") &&
      !(startupCaveat("always", "interactive") ?? "").toLowerCase().includes("your windows password")
  );
  check("the logon scope is never caveated", startupCaveat("logon", "interactive") === null);
}

// ── Stopping has to be GRACEFUL, and on Windows a signal cannot be (ADR-211) ─
//
// `process.kill(pid, "SIGTERM")` from another process does not deliver a
// catchable signal on Windows: it terminates outright, so the shutdown handler
// never runs — Postgres is killed rather than shut down (recovery on the next
// start) and the lock file survives looking like a live owner. Observed live on
// the dev rig. The stop path therefore has to ASK through the file the
// supervisor polls, and reach the same handler a Ctrl-C reaches.
check(
  "the supervisor polls the stop request and routes it through shutdown()",
  supervisorSrc.includes("stopSignalPath") && /shutdown\("stop-requested"\)/.test(supervisorSrc)
);
{

  check(
    "stop asks through the file rather than signalling the pid",
    ctlSrc.includes("stopSignalPath") && !/process\.kill\([^)]*"SIGTERM"/.test(ctlSrc)
  );
  check(
    "stop still verifies the process actually went away, rather than assuming",
    ctlSrc.includes("pidAlive(pid)")
  );
  check(
    "status and stop never hard-kill (no SIGKILL anywhere in the control script)",
    !ctlSrc.includes("SIGKILL")
  );
}

// The cluster has to be SHUT DOWN, not killed. embedded-postgres stops it with
// `taskkill /f /t` on Windows, so every stop left the next start replaying WAL
// ("database system was not properly shut down") — seen on the dev rig. Asking
// pg_ctl for a fast shutdown first is what makes "stops cleanly" true.
check(
  "shutdown asks pg_ctl for a real shutdown before falling back to the library kill",
  /pg_ctl/.test(supervisorSrc) &&
    supervisorSrc.includes('"-m", "fast"') &&
    supervisorSrc.includes("stopPostgresGracefully")
);
check(
  "the forced fallback is still there, and bounded so a wedged cluster cannot hang shutdown",
  /async function forceStopPostgres[\s\S]*?for \(let i = 0; i < \d+ && pidAlive/.test(supervisorSrc)
);
// Starting through pg_ctl means there is no child handle to kill, so the
// fallback goes by postmaster.pid — and must keep the same guards the orphan
// path uses, or a reissued pid gets some unrelated process killed.
check(
  "the forced fallback verifies the pid really is a postmaster before killing it",
  /async function forceStopPostgres[\s\S]*?image\.includes\("postgres"\)[\s\S]*?taskkill/.test(
    supervisorSrc
  )
);


// ── (10) Local crons: the scheduler seam on a self-hosted peer (ADR-214) ─────
//
// A local peer has no external scheduler at all, so these decisions are what
// stand between "the oplog prunes" and "it silently never does".

// The load-bearing default. Only jobs that are SAFE on more than one peer at
// once may default on, because a local peer runs alongside the cloud
// deployment, which is still running all of them. Flipping export or
// calendar-sync to `on: true` would have two peers writing one OneDrive folder
// and two peers creating items from the same calendar events.
{
  const defaults = normalizeCrons(undefined).map((j) => j.name).sort();
  check(
    // `snapshot` joined this list in ADR-222 and the three movable exclusive
    // jobs joined it in ADR-225, for the same reason both times: the job is
    // scheduled everywhere and the ENDPOINT decides whether to do the work,
    // which is what lets the owner's answer be a GUI choice instead of a config
    // edit plus a service restart. Before that, ownership was two switches and
    // a job assigned to a peer whose config had it off ran nowhere at all.
    "the shared jobs and the movable exclusive ones run by default",
    JSON.stringify(defaults) ===
      JSON.stringify([
        "calendar-sync",
        "email-import",
        "export",
        "purge",
        "relatedness",
        "snapshot",
        "youtube-transcript",
      ]),
    defaults.join(",")
  );
  // THE INVARIANT THAT REPLACED "exclusive jobs are off by default".
  //
  // Scheduling an exclusive job on every peer is only safe because the endpoint
  // refuses to do the work unless the owner named this machine. So a default-on
  // exclusive job must be one the picker can actually move, AND its route must
  // call the gate. Either half missing is a double writer on one OneDrive folder
  // or one mailbox, which is corrupting rather than merely wasteful.
  for (const [name, job] of Object.entries(LOCAL_JOBS)) {
    if (job.shared || !job.on) continue;
    const def = MOVABLE_JOBS[name as MovableJob];
    check(
      `${name} is scheduled everywhere, so the picker must be able to move it`,
      !!def && def.movable === true
    );
    const route = readFileSync(`src/app/api/machine/${name}/route.ts`, "utf8");
    check(
      `${name} is scheduled everywhere, so its route must stand down when it is not the owner`,
      route.includes("standDownIfNotOwner(")
    );
  }
  check(
    "an exclusive job the picker refuses to move is never scheduled here",
    Object.entries(LOCAL_JOBS).every(
      ([name, j]) =>
        j.shared || !j.on || MOVABLE_JOBS[name as MovableJob]?.movable === true
    )
  );
  check(
    "purge is in the catalog and defaults on — it is the one that prunes the oplog",
    LOCAL_JOBS.purge?.on === true && LOCAL_JOBS.purge?.path === "/api/machine/purge"
  );
  check(
    "every catalog entry says why its sharing verdict is what it is",
    Object.values(LOCAL_JOBS).every((j) => typeof j.why === "string" && j.why.length > 20)
  );
}

// A mistyped job name must throw. Silently scheduling nothing is exactly the
// failure this slice exists to remove.
check("an unknown job name is refused", throws(() => normalizeCrons({ purgee: true })));
check(
  "a non-object crons block is refused",
  throws(() => normalizeCrons(["purge"])) && throws(() => normalizeCrons(7))
);
check("crons: false turns everything off", normalizeCrons(false).length === 0);
check(
  "a job can be turned off individually",
  normalizeCrons({
    purge: false,
    snapshot: false,
    export: false,
    "calendar-sync": false,
    "email-import": false,
    "youtube-transcript": false,
  })
    .map((j) => j.name)
    .join(",") === "relatedness"
);
check(
  // The escape hatch, and only that. Since ADR-225 the owner's lever is the
  // GUI picker, so this block exists to take a job OUT of the schedule while
  // testing — never to be the documented way anything is turned on.
  "an exclusive job can still be forced off per machine for testing",
  !normalizeCrons({ export: false }).some((j) => j.name === "export") &&
    normalizeCrons({}).some((j) => j.name === "export")
);
check(
  "an override is validated, not trusted",
  throws(() => normalizeCrons({ purge: { at: "25:00" } })) &&
    throws(() => normalizeCrons({ purge: { at: "9:5" } })) &&
    throws(() => normalizeCrons({ "todoist-sync": { everyMinutes: 0 } })) &&
    throws(() => normalizeCrons({ purge: "03:00" }))
);
check(
  "an override actually takes effect",
  normalizeCrons({ purge: { at: "05:45" } })[0].at === "05:45" &&
    normalizeCrons({ purge: { everyMinutes: 90 } })[0].intervalMs === 90 * 60_000
);

// A strict HH:MM parse, because "9:5" quietly becoming midnight would move a
// job hours from where the owner put it.
check(
  "parseDailyAt is strict",
  parseDailyAt("03:10")?.h === 3 &&
    parseDailyAt("23:59")?.m === 59 &&
    parseDailyAt("9:5") === null &&
    parseDailyAt("24:00") === null &&
    parseDailyAt("") === null &&
    parseDailyAt(undefined) === null
);

// Strictly after `from`: an "at or after" comparison returns the same instant
// the job just ran at, so a daily job fires on every single tick.
{
  const noon = new Date(2026, 7, 23, 12, 0, 0, 0).getTime();
  const at1210 = nextDailyAt("12:10", noon);
  const at1150 = nextDailyAt("11:50", noon);
  const atNoon = nextDailyAt("12:00", noon);
  check("the next daily slot later today is today", at1210 - noon === 10 * 60_000);
  check("a slot already past today is tomorrow", at1150 - noon === (24 * 60 - 10) * 60_000);
  check(
    "the slot happening exactly now is TOMORROW, not now",
    atNoon - noon === 24 * 60 * 60_000
  );
}

// A failure costs a short retry, not a whole day — and cannot make a job run
// more often than its own schedule allows.
{
  // By name, never by position: the default set grows (ADR-222, ADR-225) and a
  // positional pick silently starts testing a different job.
  const named = (crons: Record<string, unknown>, name: string) =>
    normalizeCrons(crons).find((j) => j.name === name)!;
  const purge = named({ purge: true }, "purge");
  const fast = named({ "transcription-poll": { everyMinutes: 5 } }, "transcription-poll");
  const now = new Date(2026, 7, 23, 12, 0, 0, 0).getTime();
  check(
    "a failed daily job retries in minutes, not tomorrow",
    nextRunAt(purge, now, false) - now === CRON_RETRY_MS
  );
  check(
    "a failure can never make a job run MORE often than its own schedule",
    nextRunAt(fast, now, false) - now === 5 * 60_000
  );
  check(
    "a successful daily job waits for its next slot",
    nextRunAt(purge, now, true) === nextDailyAt("03:10", now)
  );
}

// A laptop asleep every night at 03:10 would never purge, which IS the "the
// oplog never prunes" bug wearing a different hat. Anything overdue by more
// than its own period runs shortly after boot instead.
{
  const [purge] = normalizeCrons({ purge: true, relatedness: false });
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 24 * 3600_000).toISOString();
  const anHourAgo = new Date(now - 3600_000).toISOString();
  check(
    "a job overdue by more than its period runs shortly after boot",
    initialDueAt(purge, twoDaysAgo, now) - now === CRON_STARTUP_GRACE_MS
  );
  check(
    "a job that has never run at all runs shortly after boot",
    initialDueAt(purge, null, now) - now === CRON_STARTUP_GRACE_MS
  );
  check(
    "a job that ran recently waits for its normal slot",
    initialDueAt(purge, anHourAgo, now) === nextDailyAt("03:10", now)
  );
}

// The surfaces have to be able to tell "fine", "the last one failed" and "this
// stopped firing a while ago" apart — the third is what a dead scheduler looks
// like from the outside.
{
  const [purge] = normalizeCrons({ purge: true, relatedness: false });
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  check("no record reads as never", jobStaleness(undefined, purge, now) === "never");
  check(
    "a failed last attempt reads as failing",
    jobStaleness({ lastRunAt: iso(60_000), lastOkAt: iso(3600_000), ok: false }, purge, now) ===
      "failing"
  );
  check(
    "a fresh success reads as ok",
    jobStaleness({ lastRunAt: iso(60_000), lastOkAt: iso(60_000), ok: true }, purge, now) === "ok"
  );
  check(
    "a success older than several periods reads as late",
    jobStaleness(
      { lastRunAt: iso(60_000), lastOkAt: iso(5 * 24 * 3600_000), ok: true },
      purge,
      now
    ) === "late"
  );
}

// The state file is the whole surfacing mechanism (Build → Updates, /health,
// local:status), so it has to survive being half-written or absent.
{
  // Two jobs, so the round-trip count below stays about serialization rather
  // than about how many jobs happen to default on.
  // Two jobs, named explicitly, so the default set can grow without rewriting
  // the expectations below.
  const jobs = normalizeCrons({
    snapshot: false,
    export: false,
    "calendar-sync": false,
    "email-import": false,
    "youtube-transcript": false,
  });
  const now = Date.now();
  const text = serializeCronState(
    jobs,
    {
      purge: {
        dueAt: now + 60_000,
        lastRunAt: new Date(now).toISOString(),
        lastOkAt: new Date(now).toISOString(),
        ok: true,
        detail: null,
        runs: 3,
        fails: 1,
      },
    },
    now
  );
  // lib.mjs is untyped, so name the row shape the surfaces actually consume.
  type Row = { name: string; shared: boolean; runs: number; fails: number; state: string };
  const byName = (text: string, name: string): Row | undefined =>
    (parseCronState(text)?.jobs as Row[] | undefined)?.find((j) => j.name === name);

  check("the recorded state round-trips", parseCronState(text)?.jobs.length === 2);
  check(
    "a recorded run keeps its counts and its verdict",
    byName(text, "purge")?.runs === 3 &&
      byName(text, "purge")?.fails === 1 &&
      byName(text, "purge")?.state === "ok"
  );
  check(
    "a job with nothing recorded is 'never', not silently ok",
    byName(text, "relatedness")?.state === "never"
  );
  check(
    "the exclusive flag survives to the surfaces, so they can warn about it",
    byName(serializeCronState(normalizeCrons({ export: true }), {}, now), "export")?.shared ===
      false
  );
  check(
    "a truncated or garbage record reads as no record, never a throw",
    parseCronState(text.slice(0, 40)) === null &&
      parseCronState("") === null &&
      parseCronState("{}") === null
  );
  check("the credential never appears in the record", !text.includes("Bearer"));
}

// The supervisor's own token is APPENDED to the app's token list. Assigning it
// instead would wipe the owner's configured tokens — taking the MCP server and
// every webhook down in order to run a purge.
{
  const cfg = normalizeConfig(
    { ...goodRaw, extraEnv: { LEDGR_API_TOKENS: "mcp-main:mcp:aaa" } },
    "/base"
  );
  const withCron = assembleAppEnv(cfg, "sha", {
    cronTokenHash: "deadbeef",
    inheritedApiTokens: "inherited:cron:bbb",
  });
  const parts = (withCron.LEDGR_API_TOKENS ?? "").split(",");
  check(
    "the supervisor's cron entry is added alongside the owner's tokens",
    parts.includes("mcp-main:mcp:aaa") &&
      parts.includes("inherited:cron:bbb") &&
      parts.includes(localCronTokenEntry("deadbeef"))
  );
  check(
    "the minted entry carries the cron scope and nothing more",
    localCronTokenEntry("deadbeef") === "local-cron:cron:deadbeef"
  );
  check(
    "with no jobs scheduled, nothing is injected and extraEnv is untouched",
    assembleAppEnv(cfg, "sha", {}).LEDGR_API_TOKENS === "mcp-main:mcp:aaa"
  );
}

// The shell side. These are source checks because the runner is the spawn/fetch
// half, but each names a real way to get this wrong.
{
  check(
    "the runner walks through the ordinary machine-token door, not a bypass",
    /Authorization: `Bearer \$\{CRON_TOKEN\}`/.test(supervisorSrc)
  );
  check(
    "it calls loopback, never a configured hub or a public address",
    supervisorSrc.includes("http://127.0.0.1:${cfg.appPort}${job.path}")
  );
  // The raw credential lives in memory and reaches exactly two places: the two
  // Authorization headers. Anywhere else — a log line, the state file — is a
  // leak, so the allowed lines are enumerated rather than pattern-excluded.
  {
    const bare = supervisorSrc
      .split("\n")
      .filter((l) => /\bCRON_TOKEN\b/.test(l.replace(/CRON_TOKEN_HASH/g, "")));
    check(
      "the raw token only ever appears where it is minted or sent as a Bearer header",
      bare.length > 0 &&
        bare.every((l) => /randomBytes|createHash|cfg\.crons\.length|Bearer \$\{CRON_TOKEN\}/.test(l)),
      bare.find((l) => !/randomBytes|createHash|cfg\.crons\.length|Bearer \$\{CRON_TOKEN\}/.test(l))?.trim()
    );
    check(
      "only the hash reaches the app child's environment",
      supervisorSrc.includes("cronTokenHash: CRON_TOKEN_HASH")
    );
  }
  check(
    "a failed run is reported into error_log the same way the CI workflows do",
    supervisorSrc.includes("/api/machine/report-error") &&
      /if \(!ok\) await reportCronFailure\(/.test(supervisorSrc)
  );
  check(
    "no job fires while an update is in flight (the app is down mid-flip)",
    /if \(cronBusy \|\| updating\) return;/.test(supervisorSrc)
  );
  check(
    "the state file is written at startup, so 'no jobs' and 'no supervisor' differ",
    supervisorSrc.includes("primeCronState()")
  );
  check(
    "every run is recorded, pass or fail",
    /writeCronState\(\);/.test(supervisorSrc) && supervisorSrc.includes('"cron job FAILED"')
  );
  {
    // Both shapes an endpoint uses to say "I deliberately did nothing": the
    // ownership gate's {skipped, detail} (ADR-225) and the snapshot switch's
    // {skipped: "why"} (ADR-222). Anything else has to read as a real run,
    // because inventing a stand-down would hide one.
    const gate = standDownDetailOf(
      JSON.stringify({ ok: true, skipped: true, detail: "this job runs on Cloud, not here." })
    );
    check(
      "a gated job's own words reach the record, as a sentence",
      gate === "This job runs on Cloud, not here."
    );
    check(
      "a switched-off job says which switch",
      standDownDetailOf(JSON.stringify({ ok: true, skipped: "snapshots are switched off" })) ===
        "Snapshots are switched off"
    );
    check(
      "a bare skip still says something rather than nothing",
      standDownDetailOf(JSON.stringify({ ok: true, skipped: true })) === "Stood down."
    );
    check(
      "real work is never reported as a stand-down",
      standDownDetailOf(JSON.stringify({ ok: true, exported: 12 })) === null &&
        standDownDetailOf("<html>a proxy ate it</html>") === null &&
        standDownDetailOf("") === null
    );
  }
  check(
    // ADR-225: an exclusive job is scheduled on every machine and the endpoint
    // decides, so a run that deliberately did nothing must not be recorded as
    // "the backup ran". The endpoint says which machine has it; carry that
    // through to the record rather than flattening it into a plain ok.
    "a run that stood down is recorded as such, not as work done",
    supervisorSrc.includes("standDownDetailOf(body)") &&
      supervisorSrc.includes('"cron job stood down"')
  );
  const ctlSrc2 = readFileSync("supervisor/ledgr-ctl.mjs", "utf8");
  check(
    "status reports the jobs too, so an install agent can verify rather than assume",
    ctlSrc2.includes("recordedCronState") && ctlSrc2.includes("crons:")
  );
}


// ── (11) The performance pass (ADR-215) ──────────────────────────────────────
//
// Local Postgres tuning: RAM-sized flags, an off switch, and manual overrides
// that always win. The stock embedded-postgres defaults (128MB shared_buffers,
// random_page_cost 4) could not hold a real Ledgr database and overpriced the
// index scans every list depends on.
{
  const { tunedPostgresFlags } = await import("../supervisor/lib.mjs");
  const GB = 1024 * 1024 * 1024;
  const base = normalizeConfig({ dataDir: "/d", ownerEmail: "a@b.c" }, "/x");
  const flags32 = tunedPostgresFlags(base, 32 * GB);
  const text32 = flags32.join(" ");
  check(
    "32GB machine: shared_buffers clamps at 1GB (RAM/8 would be 4GB)",
    text32.includes("shared_buffers=1024MB"),
    text32
  );
  check("SSD random_page_cost is set", text32.includes("random_page_cost=1.1"));
  check("work_mem raised from the 4MB stock", text32.includes("work_mem=16MB"));
  const flags8 = tunedPostgresFlags(base, 8 * GB).join(" ");
  check("8GB machine: shared_buffers = RAM/8 = 1024MB", flags8.includes("shared_buffers=1024MB"));
  const flags1 = tunedPostgresFlags(base, 1 * GB).join(" ");
  check(
    "tiny machine: shared_buffers never sizes below the 128MB stock",
    flags1.includes("shared_buffers=128MB"),
    flags1
  );
  check(
    "garbage RAM input still yields safe floors, never NaN flags",
    !tunedPostgresFlags(base, NaN).join(" ").includes("NaN")
  );
  const off = normalizeConfig(
    { dataDir: "/d", ownerEmail: "a@b.c", tunePostgres: false, postgresFlags: ["-c", "work_mem=64MB"] },
    "/x"
  );
  check(
    "tunePostgres:false passes ONLY the owner's own flags (stock otherwise)",
    JSON.stringify(tunedPostgresFlags(off, 32 * GB)) === JSON.stringify(["-c", "work_mem=64MB"])
  );
  const both = normalizeConfig(
    { dataDir: "/d", ownerEmail: "a@b.c", postgresFlags: ["-c", "shared_buffers=64MB"] },
    "/x"
  );
  const merged = tunedPostgresFlags(both, 32 * GB);
  check(
    "a manual flag comes AFTER its tuned counterpart, so it wins (postgres takes the last -c)",
    merged.lastIndexOf("shared_buffers=64MB") > merged.indexOf("shared_buffers=1024MB")
  );
  check(
    "non-string junk in postgresFlags is dropped, not passed to the server",
    normalizeConfig(
      { dataDir: "/d", ownerEmail: "a@b.c", postgresFlags: ["-c", 5, null, "x=1"] },
      "/x"
    ).postgresFlags.join(",") === "-c,x=1"
  );
}

// A restore that hands over a database with no statistics is the A2 bug: the
// planner believed items held 7 rows against 23,470 real, and the related
// panel alone cost 11× the buffers it should have. Both fill paths must end
// with VACUUM ANALYZE.
{
  const restoreSrc = readFileSync("scripts/local-restore.mjs", "utf8");
  check(
    "local-restore actually RUNS vacuum analyze (the query call, not just a log line)",
    restoreSrc.includes('db.query("vacuum analyze")') && restoreSrc.includes("analyzeAfterFill")
  );
  check(
    "BOTH fill paths analyze (the dump restore and --from-url)",
    (restoreSrc.match(/await analyzeAfterFill\(/g) ?? []).length >= 2
  );
  check(
    "the restore cluster starts with the same tuned flags the supervisor uses",
    restoreSrc.includes("tunedPostgresFlags")
  );
}

// The supervisor's cluster gets the tuned flags too.
check(
  "the supervisor passes tuned postgresFlags to embedded-postgres",
  supervisorSrc.includes("postgresFlags: tunedPostgresFlags(cfg, totalmem())")
);

// The two query rewrites are structural, so guard the structure: each one
// regressed means an O(all items) plan comes back on every item-page open /
// Most-linked render (26,653 and 122,194 buffers respectively, measured).
{
  const relationsSrc = readFileSync("src/lib/relations.ts", "utf8");
  check(
    "relatedItemsQuery reads the edges first (UNION ALL), not an OR-join over items",
    relationsSrc.includes("unionAll(") &&
      !/innerJoin\(\s*items,\s*or\(/.test(relationsSrc)
  );
  const viewsSrc = readFileSync("src/lib/views.ts", "utf8");
  check(
    "mostLinked aggregates relations once — the correlated per-row count(*) is gone",
    viewsSrc.includes('sort.field === "mostLinked"') &&
      viewsSrc.includes("unionAll(") &&
      !/select count\(\*\) from relations r where/.test(viewsSrc)
  );
}

// Request-level dedupe on the two reads every page repeats (Nav + page each
// re-queried settings and types per navigation: two extra HTTP round trips
// per click on the neon-http driver).
{
  const settingsSrc = readFileSync("src/lib/settings.ts", "utf8");
  check(
    "getSettings is wrapped in React cache()",
    /export const getSettings = cache\(/.test(settingsSrc)
  );
  const typesSrc = readFileSync("src/lib/types.ts", "utf8");
  check(
    "listTypes dedupes through a cache() keyed on a PRIMITIVE (an object arg never hits)",
    /cache\(async \(includeHidden: boolean\)/.test(typesSrc) &&
      typesSrc.includes("listTypesCached(opts.includeHidden === true)")
  );
}

// The measurement itself stays runnable and read-only: the audit script must
// refuse anything that is not a SELECT, so it stays safe to point at the live
// spoke or the cloud pooler.
{
  const auditSrc = readFileSync("scripts/perf-audit.mts", "utf8");
  check(
    "perf-audit guards every statement through assertSelectOnly",
    auditSrc.includes("assertSelectOnly(q.sql)") &&
      auditSrc.includes('startsWith("select")')
  );
  check(
    "perf-audit measures buffers, not just wall clock",
    auditSrc.includes("ANALYZE, BUFFERS")
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
