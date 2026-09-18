#!/usr/bin/env node
// The local-peer supervisor (plan phase 2 / LH2, ADR-206 decision 6): ONE
// long-running process that owns everything a local Ledgr peer needs —
// embedded Postgres, the app (`next start` from the current live build), and
// the update apply path (the local half of ADR-194).
//
//   npm run local:supervisor           # config from supervisor/config.json
//   node supervisor/ledgr-supervisor.mjs /path/to/config.json
//
// Update flow (signal file <dataDir>/update-requested, written by the app's
// "Update now" button, or self-written in update.mode "auto"):
//   git pull → fresh worktree checkout in builds/<sha>/ → node_modules (npm ci
//   only if the lockfile changed, else copied from the live build) →
//   next build → migrate → flip live.json → restart the app into the new dir.
// ANY failure leaves the previous build serving (keep-last-good; the flip is
// the last step and only decideFlip says when). Builds are self-contained on
// purpose: nothing ever mutates the directory the running app serves from,
// which is also why this works on Windows (you cannot swap files a process
// is serving from). Kept to node builtins + the repo's own embedded-postgres.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, setPriority, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmDirBestEffort, rmDirRetry } from "./rm-dir.mjs";
import { pidAlive, portListening, processCommandLine, processImageName } from "./proc.mjs";
import {
  assembleAppEnv,
  buildDbUrl,
  isSupervisorCommandLine,
  lockPath,
  lockVerdict,
  parsePostmasterPid,
  postmasterVerdict,
  buildsDir,
  decideFlip,
  livePointerPath,
  needsNpmCi,
  nextBackoffMs,
  normalizeConfig,
  parseLivePointer,
  pruneList,
  serializeLivePointer,
  signalPath,
  formatSchtasks,
  elevatedCmdScript,
  elevatedPowershellArgs,
  ELEVATION_CANCELLED,
  parseSchtasksLogonMode,
  schtasksQueryArgs,
  startupCaveat,
  parseStartupRequest,
  parseStartupState,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  serializeStartupState,
  startupSignalPath,
  startupStatePath,
  stopSignalPath,
  STARTUP_TASK_NAME,
  cronStatePath,
  initialDueAt,
  nextRunAt,
  parseCronState,
  serializeCronState,
  standDownDetailOf,
  restartSignalPath,
  supervisorStatePath,
  parseRestartRequest,
  parseSupervisorState,
  serializeSupervisorState,
  codeFingerprint,
  parseSchtasksScope,
  updatePolicyPath,
  parseUpdatePolicy,
  serializeUpdatePolicy,
  policyFromConfig,
  updateCheckDue,
  AWAIT_PID_ENV,
  AWAIT_PID_TIMEOUT_MS,
  PG_START_ATTEMPTS,
  PG_READY_ATTEMPTS,
  pgStartDelayMs,
  tunedPostgresFlags,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function log(msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), source: "supervisor", msg, ...extra }));
}

// ── Config ───────────────────────────────────────────────────────────────────

const configPath = process.argv[2] ? resolve(process.argv[2]) : join(here, "config.json");
if (!existsSync(configPath)) {
  console.error(`No config at ${configPath}. Copy supervisor/config.example.json to supervisor/config.json and edit it.`);
  process.exit(1);
}
const cfg = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")), dirname(configPath));
mkdirSync(cfg.dataDir, { recursive: true });
mkdirSync(buildsDir(cfg.dataDir), { recursive: true });
log("config loaded", { role: cfg.role, dataDir: cfg.dataDir, appPort: cfg.appPort, dbPort: cfg.dbPort, updateMode: cfg.update.mode });

// ── Small helpers (shell side) ───────────────────────────────────────────────

const isWin = process.platform === "win32";

// `low: true` runs the child at below-normal CPU priority, so a long build
// yields to the app that is still serving pages (2026-09-02: an auto-update
// spends ~4.5 minutes in `next build` on the same laptop that answers phone
// requests, and Windows hands a fresh child the same priority as everything
// else). The trick is that Windows children INHERIT the creating process's
// priority class, and spawnSync blocks, so lowering ourselves for exactly the
// duration of the call is the whole mechanism, with no argument-quoting games
// and nothing to clean up. Restored in `finally` so a throwing child cannot
// leave the supervisor demoted, and deliberately NOT used for `startApp` (the
// app must serve at normal priority) or for migrations (DDL holding locks
// should finish fast, not politely).
function run(cmd, args, opts = {}) {
  const { low = false, ...spawnOpts } = opts;
  if (low) lowerOwnPriority();
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin && cmd === "npm", // npm is npm.cmd on Windows
      ...spawnOpts,
    });
    return {
      ok: res.status === 0,
      code: res.status,
      stdout: (res.stdout ?? "").trim(),
      stderr: (res.stderr ?? "").trim(),
    };
  } finally {
    if (low) restoreOwnPriority();
  }
}

// Best-effort both ways: priority is a nicety, never a reason to fail an
// update. BELOW_NORMAL rather than LOW/IDLE on purpose: idle priority would
// starve the build whenever anything else is busy, stretching the very window
// we are trying to make less intrusive.
function lowerOwnPriority() {
  try {
    setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // no privilege, or an OS without priority classes: run at normal speed
  }
}

function restoreOwnPriority() {
  try {
    setPriority(0, osConstants.priority.PRIORITY_NORMAL);
  } catch {
    // same: the supervisor spends its life asleep, so a stuck demotion is
    // survivable, and the next boot resets it regardless
  }
}

function git(args, cwd = cfg.repoDir) {
  return run("git", args, { cwd });
}

function lockHash(dir) {
  const p = join(dir, "package-lock.json");
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

// ── Embedded Postgres ────────────────────────────────────────────────────────

// Resolve embedded-postgres from the repo clone (it is a runtime dependency
// there); the supervisor dir itself has no node_modules.
const requireFromRepo = createRequire(join(cfg.repoDir, "package.json"));
const EmbeddedPostgres = (await import(pathToFileURL(requireFromRepo.resolve("embedded-postgres")).href)).default;
// node-postgres, for the readiness check. Same dependency embedded-postgres
// itself uses, so this adds nothing to the stack (Principle 5).
const { Client: PgClient } = (await import(pathToFileURL(requireFromRepo.resolve("pg")).href)).default;

// Which @embedded-postgres/<platform> package holds the binaries, so pg_ctl
// can be found beside the postgres binary for a graceful shutdown.
const PG_PLATFORM_PKG = `${process.platform === "win32" ? "windows" : process.platform}-${
  process.arch === "arm64" ? "arm64" : "x64"
}`;

const pgDir = join(cfg.dataDir, "pg");
const firstRun = !existsSync(join(pgDir, "PG_VERSION"));
const pg = new EmbeddedPostgres({
  databaseDir: pgDir,
  user: "postgres",
  password: "postgres",
  port: cfg.dbPort,
  persistent: true,
  // See scripts/local-restore.mjs: a Windows-default cluster is WIN1252 and
  // cannot hold real body text. UTF8 is not optional here.
  initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=en-US", "--locale=C"],
  // RAM-sized server settings (ADR-215): the stock 128MB shared_buffers could
  // not hold a real Ledgr database, so page-heavy queries evicted themselves
  // every run. tunePostgres:false in config restores stock behavior.
  postgresFlags: tunedPostgresFlags(cfg, totalmem()),
});

/**
 * Delete a leftover postmaster.pid, but only when it is provably a leftover.
 *
 * Returns true when a file was removed, so the caller knows the next attempt is
 * into a genuinely different situation. Every uncertainty answers "leave it
 * alone": an unreadable file, a Postgres actually listening, a pid that really
 * does belong to a postmaster.
 */
async function clearStalePostmasterPid() {
  const lockFile = join(pgDir, "postmaster.pid");
  if (!existsSync(lockFile)) return false;
  let recorded;
  try {
    recorded = parsePostmasterPid(readFileSync(lockFile, "utf8"));
  } catch {
    return false;
  }
  const verdict = postmasterVerdict({
    recordedPid: recorded.pid,
    alive: recorded.pid !== null && pidAlive(recorded.pid),
    image: recorded.pid === null ? null : processImageName(recorded.pid),
    portListening: await portListening(recorded.port ?? cfg.dbPort),
  });
  if (verdict !== "stale") return false;
  try {
    unlinkSync(lockFile);
  } catch {
    return false;
  }
  log("removed a stale postmaster.pid left by an unclean shutdown", {
    file: lockFile,
    recordedPid: recorded.pid,
  });
  return true;
}

/**
 * A Postgres still listening from a supervisor that died without stopping it.
 *
 * The mirror image of the stale-lock case, and just as fatal: here the cluster
 * is genuinely up, so nothing may be deleted, but the port is taken and a fresh
 * start cannot have it. Left alone it is a peer that never comes back — the
 * database is fine and the app can never reach it.
 *
 * Shutting the orphan down cleanly is the whole fix, and `pg_ctl stop -m fast`
 * is already here for the ordinary shutdown path. Narrow on purpose: only when
 * OUR port is busy, only when OUR data directory's lock file names the process
 * holding it, and only when that process really is a postmaster. Anything else
 * on that port is somebody else's and gets reported, not stopped.
 */
async function stopOrphanedPostgres() {
  const lockFile = join(pgDir, "postmaster.pid");
  if (!existsSync(lockFile)) return false;
  if (!(await portListening(cfg.dbPort))) return false;
  let recorded;
  try {
    recorded = parsePostmasterPid(readFileSync(lockFile, "utf8"));
  } catch {
    return false;
  }
  if (recorded.pid === null || !pidAlive(recorded.pid)) return false;
  const image = processImageName(recorded.pid);
  if (typeof image !== "string" || !image.includes("postgres")) return false;
  log("a Postgres from a previous run is still listening; shutting it down cleanly", {
    pid: recorded.pid,
    port: cfg.dbPort,
  });
  return stopPostgresGracefully();
}

/**
 * One start attempt, through `pg_ctl start` instead of spawning postgres.exe
 * directly (embedded-postgres's way).
 *
 * The difference is who gets to run: postgres.exe refuses to start with
 * administrator rights, and the at-boot scheduled task (`--always` scope) runs
 * with an UNFILTERED admin token — Windows only strips admin rights from
 * interactive sign-ins, not from boot-time task logons. That took this peer
 * down on every reboot (seen 2026-08-27 and 2026-08-29): the tray "Start"
 * click worked, the boot task never could. pg_ctl exists for exactly this: it
 * drops its own privileges (CreateRestrictedToken) before launching postgres,
 * so the same command works elevated and unelevated.
 *
 * pg_ctl is spawned, never waited on. On Windows it does NOT exit after the
 * server is up: it stays alive as the restricted-token parent holding the job
 * object. A blocking spawnSync here therefore hung the supervisor forever with
 * a perfectly healthy database underneath it (seen on the rig 2026-08-29 —
 * Postgres ready at 12:21:11, supervisor still waiting twenty minutes later).
 *
 * Readiness is an actual connection instead, which is the honest question
 * anyway: the port opens before crash recovery finishes, so "listening" is not
 * "will accept my connection". Postgres's own output goes to postgres.log via
 * -l, and that file is where a failure explains itself.
 */
async function startPostgresOnce() {
  const pgCtl = pgCtlPath();
  if (!pgCtl) {
    // Binaries not resolvable the pg_ctl way — let embedded-postgres try.
    await pg.start();
    return;
  }
  const logFile = join(cfg.dataDir, "postgres.log");
  const child = spawn(
    pgCtl,
    [
      "start",
      "-D", pgDir,
      "-l", logFile,
      // -o is one string handed to postgres; none of our flag values contain
      // spaces (see tunedPostgresFlags), so a plain join is safe.
      "-o", ["-p", String(cfg.dbPort), ...tunedPostgresFlags(cfg, totalmem())].join(" "),
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  for (let i = 0; i < PG_READY_ATTEMPTS; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await pgIsReady()) return;
  }
  throw new Error(`postgres did not become ready; see ${logFile}: ${tailFile(logFile, 3)}`);
}

/**
 * True only once the server will actually accept a connection.
 *
 * Deliberately a real connection and not `pg_isready`: this Postgres build
 * ships three binaries (initdb, pg_ctl, postgres) and pg_isready is not one of
 * them, so a check built on it can never succeed — it silently reported a
 * perfectly healthy cluster as dead until the start timed out (rig, 2026-08-29).
 *
 * Connects to the built-in `postgres` database, which always exists; `ledgr` is
 * only created after this returns.
 */
async function pgIsReady() {
  const client = new PgClient({
    host: "127.0.0.1",
    port: cfg.dbPort,
    user: "postgres",
    password: "postgres",
    database: "postgres",
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.end();
    } catch {
      // nothing to close
    }
  }
}

/** Last few lines of a log file, for putting a reason in an error message. */
function tailFile(file, lines) {
  try {
    return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-lines).join(" | ").slice(0, 300);
  } catch {
    return "no log";
  }
}

/**
 * Start Postgres, retrying a few times before giving up (ADR-227).
 *
 * One attempt was enough right up until it wasn't. A supervisor that goes away
 * without a clean shutdown — a hard kill, a crash, a power cut — can leave an
 * orphaned backend holding the cluster's shared memory, and Windows keeps that
 * segment attached until the last one exits. A start into that window fails
 * instantly with "pre-existing shared memory block is still in use", which took
 * this peer down for ten minutes on 2026-08-26: every restart attempt died on
 * it, including the one the owner ran.
 *
 * The window is seconds long, so waiting through it is the entire fix. Failing
 * loudly after four tries is still the right ending — the alternative is a
 * process that looks alive with no database under it.
 *
 * Waiting is not the whole fix any more, though. A reboot that did not shut
 * Postgres down cleanly also leaves postmaster.pid behind, and if Windows has
 * reissued the pid inside it — likeliest of all right after a boot — Postgres
 * refuses to start and no amount of retrying changes that. That is what stopped
 * this peer on 2026-08-27. So a failed attempt now also clears a postmaster.pid
 * that is provably stale (see postmasterVerdict for the two guards that keep
 * "provably" honest) before the next try.
 */
async function startPostgres() {
  if (firstRun && !existsSync(join(pgDir, "PG_VERSION"))) {
    log("initdb (first run)", { pgDir });
    // ponytail: initdb still runs direct, so a FIRST run from an elevated
    // process (e.g. the at-boot task on a brand-new machine) would fail the
    // same way pg.start() used to. Install is interactive today; route this
    // through `pg_ctl initdb` if that ever changes.
    await pg.initialise();
  }
  // Clear the way before trying, not after failing: an orphan holding the port
  // fails every attempt identically, so retrying into it is pure delay.
  await stopOrphanedPostgres();
  // The stale-lock rescue is worth a fresh budget of attempts, and worth it
  // exactly once: Postgres writes postmaster.pid itself before it decides it
  // cannot run, so a cluster that is broken for some OTHER reason would
  // otherwise leave a freshly stale lock on every pass and retry forever.
  let rescued = false;
  for (let attempt = 1; ; attempt += 1) {
    const wait = pgStartDelayMs(attempt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await startPostgresOnce();
      if (attempt > 1) log("postgres started after retrying", { attempt, rescued });
      break;
    } catch (err) {
      // pg_ctl start puts the reason on its stderr (and Postgres's own output
      // in postgres.log). The legacy pg.start() fallback still rejects with
      // nothing at all, so "undefined" can still appear on that path.
      const detail = String(err?.message ?? err).slice(0, 300);
      const cleared = !rescued && (await clearStalePostmasterPid());
      if (cleared) rescued = true;
      if (attempt >= PG_START_ATTEMPTS && !cleared) {
        log("postgres would not start", { attempt, detail });
        writeSupervisorState({ phase: "failed", detail: `Postgres would not start: ${detail}` });
        throw err;
      }
      log("postgres start failed; retrying", { attempt, detail, clearedStaleLock: cleared });
      if (cleared) attempt = 0;
    }
  }
  try {
    await pg.createDatabase("ledgr");
    log("created database ledgr");
  } catch {
    // already exists — the normal case after the first boot
  }
  log("postgres up", { port: cfg.dbPort });
}

// ── This supervisor's own identity and state (ADR-227) ───────────────────────
//
// One file, written only here, so the app can answer three questions it cannot
// answer for itself: is the local service running, is it running the code that
// is on disk, and how did the last restart end. The third one matters most: the
// process that would report "the successor never came up" is the one that went
// away, so the record has to survive it.
const SUPERVISOR_FILES = ["ledgr-supervisor.mjs", "lib.mjs"];

function installedCodeFingerprint() {
  try {
    return codeFingerprint(SUPERVISOR_FILES.map((n) => readFileSync(join(here, n), "utf8")));
  } catch {
    return null;
  }
}

const RUNNING_CODE = installedCodeFingerprint();
const STARTED_AT = new Date().toISOString();

/** The restart block carried forward across writes, so phases accumulate. */
let restartBlock = null;

function writeSupervisorState(restart) {
  if (restart) {
    restartBlock = {
      phase: restart.phase,
      at: new Date().toISOString(),
      reason: restart.reason ?? restartBlock?.reason ?? null,
      detail: restart.detail ?? null,
      fromPid: restart.fromPid ?? restartBlock?.fromPid ?? null,
    };
  }
  try {
    writeFileSync(
      supervisorStatePath(cfg.dataDir),
      serializeSupervisorState({
        pid: process.pid,
        startedAt: STARTED_AT,
        runningCode: RUNNING_CODE,
        // Re-read every write: this is how "an update landed under me" becomes
        // visible without the owner comparing anything by hand.
        installedCode: installedCodeFingerprint(),
        restart: restartBlock,
      }),
      "utf8"
    );
  } catch (err) {
    log("could not write supervisor state", { error: String(err?.message ?? err) });
  }
}

// ── The app child ────────────────────────────────────────────────────────────

let appChild = null;
let appCrashes = 0;
let shuttingDown = false;
let restartTimer = null;

function liveBuild() {
  const p = livePointerPath(cfg.dataDir);
  if (!existsSync(p)) return null;
  const ptr = parseLivePointer(readFileSync(p, "utf8"));
  if (!ptr || !existsSync(join(ptr.dir, ".next"))) return null;
  return ptr;
}

// The supervisor's own cron credential (ADR-214). Minted per process, kept in
// memory, never written to disk: only its sha256 reaches the app child's env,
// as one more entry in LEDGR_API_TOKENS. So the scheduled calls below walk
// through the same machine-token door as Vercel cron and GitHub Actions rather
// than getting a bypass, and the credential dies with this process.
const CRON_TOKEN = cfg.crons.length > 0 ? randomBytes(32).toString("hex") : null;
const CRON_TOKEN_HASH = CRON_TOKEN ? createHash("sha256").update(CRON_TOKEN).digest("hex") : null;

function startApp(ptr) {
  const nextBin = join(ptr.dir, "node_modules", "next", "dist", "bin", "next");
  const env = {
    ...process.env,
    // The branch the app is told about is the policy's, so Build → Updates
    // asks "am I current?" about the ref this install actually follows now.
    ...assembleAppEnv({ ...cfg, branch: readPolicy().branch }, ptr.sha, {
      cronTokenHash: CRON_TOKEN_HASH,
      inheritedApiTokens: process.env.LEDGR_API_TOKENS,
    }),
  };
  appChild = spawn(process.execPath, [nextBin, "start", "-p", String(cfg.appPort)], {
    cwd: ptr.dir,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const child = appChild;
  log("app started", { pid: child.pid, sha: ptr.sha.slice(0, 7), dir: ptr.dir, port: cfg.appPort });
  const startedAt = Date.now();
  child.on("exit", (code, sig) => {
    if (child !== appChild || shuttingDown) return; // superseded or deliberate
    appCrashes = Date.now() - startedAt > 60_000 ? 0 : appCrashes + 1;
    const wait = nextBackoffMs(appCrashes);
    log("app exited; restarting", { code, sig, inMs: wait });
    restartTimer = setTimeout(() => {
      const cur = liveBuild();
      if (cur && !shuttingDown) startApp(cur);
    }, wait);
    restartTimer.unref?.();
  });
}

function stopApp() {
  return new Promise((done) => {
    const child = appChild;
    appChild = null;
    if (!child || child.exitCode !== null) return done();
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      done();
    });
    child.kill("SIGTERM"); // on win32 Node terminates the process for us
  });
}

// ── The update apply path (keep-last-good) ───────────────────────────────────

let updating = false;

/**
 * The commit this install should be serving: `origin/<branch>`, never `HEAD`.
 *
 * WHY THIS IS NOT A PULL. `repoDir` defaults to the checkout the supervisor
 * itself lives in, which on a builder's machine is the working repo somebody
 * develops in — so `HEAD` is whatever branch was last checked out there. The
 * old path (`git pull --ff-only origin <branch>`, then `rev-parse HEAD`) only
 * tracked the branch while HEAD happened to be sitting on it. Point it at a
 * release branch while the checkout is on `main` and the pull is a silent
 * no-op, because the release branch is an ancestor of `main` — and the build
 * then takes `main`'s tip, so the install serves UNRELEASED code and says
 * nothing. Reading the remote-tracking ref makes the checkout's branch,
 * working tree and staged changes all irrelevant, which is why nothing on this
 * path touches the working tree any more.
 */
// ── Update policy (the GUI-editable half of config.update) ───────────────────
//
// Read from <dataDir>/update-policy.json on EVERY use, never cached: the app
// page and the tray window write it, and "takes effect within a minute, no
// restart" is the promise. config.json is only the seed (see lib.mjs).

function originUrl() {
  const r = git(["remote", "get-url", "origin"]);
  return r.ok ? r.stdout : "";
}

function readPolicy() {
  try {
    const p = parseUpdatePolicy(readFileSync(updatePolicyPath(cfg.dataDir), "utf8"));
    if (p) return p;
  } catch {
    // missing or half-written: fall through to the seed
  }
  return policyFromConfig(cfg, "");
}

function seedPolicyIfMissing() {
  const p = updatePolicyPath(cfg.dataDir);
  if (existsSync(p)) return;
  const seed = policyFromConfig(cfg, originUrl());
  writeFileSync(p, serializeUpdatePolicy(seed), "utf8");
  log("update policy seeded from config", seed);
}

/** Point origin where the policy says, when they differ. Logged, never silent. */
function applyPolicyRepo(policy) {
  if (!policy.repo) return;
  const cur = originUrl();
  if (!cur || cur === policy.repo) return;
  const r = git(["remote", "set-url", "origin", policy.repo]);
  log(r.ok ? "origin repointed by update policy" : "could not repoint origin", {
    from: cur,
    to: policy.repo,
    ...(r.ok ? {} : { stderr: r.stderr }),
  });
}

function targetSha({ fetch = true } = {}) {
  const branch = readPolicy().branch;
  if (fetch) {
    const fetched = git(["fetch", "origin", branch]);
    if (!fetched.ok) return { ok: false, error: `git fetch: ${fetched.stderr}` };
  }
  const ref = git(["rev-parse", `origin/${branch}`]);
  if (ref.ok && ref.stdout) return { ok: true, sha: ref.stdout };
  // No remote-tracking ref yet: a first boot with no network, or a clone
  // fetched under a different refspec. HEAD is the honest answer there, and it
  // is what this did before.
  const head = git(["rev-parse", "HEAD"]);
  return head.ok && head.stdout
    ? { ok: true, sha: head.stdout }
    : { ok: false, error: `rev-parse: ${head.stderr || ref.stderr}` };
}

async function applyUpdate(reason, { fetch = true } = {}) {
  if (updating) return;
  updating = true;
  try {
    log("update starting", { reason, branch: readPolicy().branch });
    const target = targetSha({ fetch });
    if (!target.ok) {
      log("update FAILED: could not resolve the target commit", { error: target.error });
      return;
    }
    const sha = target.sha;
    const live = liveBuild();
    if (live?.sha === sha) {
      log("already serving this commit; nothing to do", { sha: sha.slice(0, 7) });
      return;
    }
    const dir = join(buildsDir(cfg.dataDir), sha);

    // Fresh checkout: a git worktree of the repo clone at the target sha. The
    // running app's directory is never touched.
    if (existsSync(dir)) {
      git(["worktree", "remove", "--force", dir]); // a previous failed attempt
      rmDirRetry(dir);
      git(["worktree", "prune"]);
    }
    const wt = git(["worktree", "add", "--detach", dir, sha]);
    if (!wt.ok) {
      log("update FAILED: worktree add", { stderr: wt.stderr });
      return;
    }

    let buildOk = false;
    let migrateOk = false;
    try {
      // node_modules: real directory per build (Turbopack rejects symlinked
      // node_modules). npm ci only when the lockfile changed; otherwise copy
      // the live build's tree — nothing the running app serves from is
      // mutated either way.
      if (live && !needsNpmCi(lockHash(live.dir), lockHash(dir))) {
        log("lockfile unchanged; copying node_modules from live build");
        cpSync(join(live.dir, "node_modules"), join(dir, "node_modules"), {
          recursive: true,
          verbatimSymlinks: true,
        });
      } else {
        log("running npm ci", { dir });
        const ci = run("npm", ["ci"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"], low: true });
        if (!ci.ok) {
          log("update FAILED: npm ci", { stderr: ci.stderr });
          return;
        }
      }

      log("building", { sha: sha.slice(0, 7) });
      const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next");
      const build = run(process.execPath, [nextBin, "build"], {
        cwd: dir,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, NODE_ENV: "production" },
        low: true,
      });
      buildOk = build.ok;
      if (!buildOk) {
        log("update FAILED: next build (previous build keeps serving)");
        return;
      }

      log("migrating local database");
      const mig = run(process.execPath, [join(dir, "scripts", "migrate.mjs")], {
        cwd: dir,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, DATABASE_URL: buildDbUrl(cfg) },
      });
      migrateOk = mig.ok;
      if (!migrateOk) {
        log("update FAILED: migrate (previous build keeps serving)");
        return;
      }
    } finally {
      if (decideFlip({ buildOk, migrateOk }) === "flip") {
        await stopApp();
        writeFileSync(livePointerPath(cfg.dataDir), serializeLivePointer(dir, sha));
        log("flipped live pointer", { sha: sha.slice(0, 7) });
        startApp({ dir, sha });
        pruneBuilds(sha);
      } else {
        // keep-last-good: drop the failed attempt so a retry starts clean.
        git(["worktree", "remove", "--force", dir]);
        rmDirRetry(dir);
        git(["worktree", "prune"]);
      }
    }
  } finally {
    updating = false;
  }
}

function pruneBuilds(liveSha) {
  const root = buildsDir(cfg.dataDir);
  const builds = readdirSync(root).flatMap((name) => {
    try {
      const st = statSync(join(root, name));
      return st.isDirectory() ? [{ sha: name, mtimeMs: st.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  for (const sha of pruneList(builds, liveSha, 2)) {
    const dir = join(root, sha);
    log("pruning old build", { sha: sha.slice(0, 7) });
    git(["worktree", "remove", "--force", dir]);
    // Best-effort: on Windows the app process we just stopped may still
    // hold handles in here. A build left behind is disk usage the next
    // prune clears, never a reason to fail an update that already flipped.
    const err = rmDirBestEffort(dir);
    if (err) log("prune deferred (directory still in use)", { sha: sha.slice(0, 7), error: String(err) });
  }
  git(["worktree", "prune"]);
}

// ── Signal watching + auto poll ──────────────────────────────────────────────
// ponytail: a 2s existsSync poll instead of fs.watch — watch semantics differ
// per platform and a signal file arrives at most a few times a week.

const signal = signalPath(cfg.dataDir);
setInterval(() => {
  if (!existsSync(signal) || updating) return;
  let target = "";
  try {
    target = readFileSync(signal, "utf8").trim();
    unlinkSync(signal);
  } catch {
    return; // mid-write; next tick gets it
  }
  void applyUpdate(target ? `signal (target ${target.slice(0, 7)})` : "signal");
}, 2000).unref?.();

// A graceful stop, asked for through a file (ADR-211). `npm run local:stop`
// writes it rather than signalling the pid, because on Windows a "SIGTERM"
// from another process is a hard terminate: the handler below never runs, so
// Postgres gets killed instead of shut down and the lock file survives looking
// like a live owner. Reaching the same shutdown path a Ctrl-C reaches is the
// whole point.
const stopSignal = stopSignalPath(cfg.dataDir);
setInterval(() => {
  if (!existsSync(stopSignal)) return;
  try {
    unlinkSync(stopSignal);
  } catch {
    return; // mid-write; next tick gets it
  }
  void shutdown("stop-requested");
}, 2000).unref?.();

// A RESTART, asked for the same way (ADR-227): the app writes the file, this
// process shuts down cleanly and then starts its successor. The app cannot do
// this itself at any price — it is the child — and the owner should not have to
// type it, so the button writes a file and the file is honoured here.
const restartSignal = restartSignalPath(cfg.dataDir);
setInterval(() => {
  if (!existsSync(restartSignal)) return;
  let reason = "asked from the app";
  try {
    reason = parseRestartRequest(readFileSync(restartSignal, "utf8")).reason;
  } catch {
    // unreadable: the file's existence is the instruction, its contents the
    // reason. Restart anyway rather than leave a dead button.
  }
  try {
    unlinkSync(restartSignal);
  } catch {
    return; // mid-write; next tick gets it
  }
  if (updating) {
    // An update is mid-flight and already takes the app down and back up. Doing
    // both at once is how a build gets abandoned half-swapped, so let the update
    // finish; whatever it changed, the restart below still applies it.
    log("restart requested during an update; deferring", { reason });
    writeFileSync(restartSignal, serializeRestartRequest({ reason }), "utf8");
    return;
  }
  log("restart requested", { reason });
  restartAfterShutdown = true;
  writeSupervisorState({ phase: "stopping", reason, fromPid: process.pid });
  void shutdown("restart-requested");
}, 2000).unref?.();

// ── "Start when Windows starts" (ADR-211) ────────────────────────────────────
//
// The app's toggle cannot register a scheduled task itself, so it writes a
// request here and this — a local process the owner started — carries it out.
// Deliberately the SAME signal-file mechanism as the update above rather than
// a second pattern.
//
// The outcome is recorded either way, because the failure is expected: the
// always-on scope generally needs elevation, and this process usually is not
// elevated. An owner who ticks a box and is not told it failed believes their
// hub survives a reboot when it does not.
const startupSignal = startupSignalPath(cfg.dataDir);

function applyStartupRequest(req) {
  const script = join(here, "ledgr-supervisor.mjs");
  const args = req.enabled
    ? schtasksCreateArgs({
        username: process.env.USERNAME || process.env.USER || "",
        nodePath: process.execPath,
        supervisorScript: script,
        configPath,
        scope: req.scope,
      })
    : schtasksDeleteArgs();

  if (!isWin) {
    writeFileSync(
      startupStatePath(cfg.dataDir),
      serializeStartupState({
        enabled: req.enabled,
        scope: req.scope,
        ok: false,
        detail:
          "Boot registration is only automated on Windows so far. On macOS use a " +
          "launchd plist, on Linux a systemd user unit — see supervisor/README.md.",
      }),
      "utf8"
    );
    log("startup request not automated on this platform", { platform: process.platform });
    return;
  }

  // Try unelevated first: the logon scope succeeds that way, and an owner who
  // never needs the consent dialog should never see one.
  let res = run("schtasks", args);
  let elevated = false;
  let cancelled = false;

  // Access denied (the always-on scope, normally) — ask for elevation rather
  // than handing the owner a command to paste. Requires an interactive desktop:
  // with nobody signed in there is nowhere to show a dialog, and Start-Process
  // fails, which lands back on the printed-command fallback below.
  if (!res.ok) {
    const script = join(cfg.dataDir, "elevate-schtasks.cmd");
    try {
      writeFileSync(script, elevatedCmdScript(args), "utf8");
      // ponytail: spawnSync, so the supervisor is frozen while the dialog is up.
      // Windows auto-dismisses an unanswered prompt after ~2 minutes, which caps
      // it; make this async if that pause ever costs something real.
      log("startup registration needs elevation; asking", { scope: req.scope });
      const asked = run("powershell", elevatedPowershellArgs(script));
      cancelled = asked.code === ELEVATION_CANCELLED;
      if (asked.ok) {
        res = asked;
        elevated = true;
      }
    } catch (err) {
      log("elevation attempt failed to start", { detail: String(err?.message || err) });
    } finally {
      try {
        unlinkSync(script);
      } catch {
        // Best effort: a leftover temp .cmd is harmless and gets overwritten.
      }
    }
  }

  const ok = res.ok;

  // A create can succeed and still not do what the scope promised, so ask
  // Windows what it actually registered rather than trusting our own request.
  let caveat = null;
  if (ok && req.enabled) {
    const q = run("schtasks", schtasksQueryArgs());
    caveat = q.ok ? startupCaveat(req.scope, parseSchtasksLogonMode(q.stdout)) : null;
  }

  writeFileSync(
    startupStatePath(cfg.dataDir),
    serializeStartupState({
      enabled: req.enabled,
      scope: req.scope,
      ok,
      detail: ok
        ? null
        : cancelled
          ? "You dismissed the Windows permission prompt. Tick the box again to retry, or run the command below in an Administrator prompt."
          : (res.stderr || res.stdout || "schtasks failed").trim().split("\n")[0] ||
            "schtasks failed",
      // The escape hatch, given verbatim: the owner can paste this into an
      // Administrator PowerShell and get the same result. PowerShell-shaped
      // because that is the prompt Windows 11 opens — the cmd form silently
      // loses the quotes around the task command there (see formatSchtasks).
      command: ok ? null : formatSchtasks(args, { shell: "powershell" }),
      caveat,
    }),
    "utf8"
  );
  log(ok ? "startup registration updated" : "startup registration FAILED", {
    task: STARTUP_TASK_NAME,
    enabled: req.enabled,
    scope: req.scope,
    elevated,
    caveat: caveat ? "interactive-only" : null,
  });
}


/**
 * Re-ask Windows what the boot task actually is, and rewrite the record.
 *
 * startup-state.json used to be written once, at registration, and read
 * forever. A caveat recorded by an older build ("Windows will only run it while
 * you are signed in") outlived the truth: on 2026-09-12 the live task was S4U,
 * Interactive/Background — correct — while the app still showed the warning,
 * because the app reads this file and never asks Windows. The CLI re-queries;
 * now the record does too, on every start, so the two cannot disagree.
 */
function refreshStartupState() {
  if (!isWin) return;
  const p = startupStatePath(cfg.dataDir);
  if (!existsSync(p)) return;
  let recorded;
  try {
    recorded = parseStartupState(readFileSync(p, "utf8"));
  } catch {
    return;
  }
  if (!recorded?.enabled || !recorded.ok) return;
  const q = run("schtasks", schtasksQueryArgs());
  if (!q.ok) return; // task gone or unreadable: leave the record, nothing better to say
  const scope = parseSchtasksScope(q.stdout) ?? recorded.scope;
  const caveat = startupCaveat(scope, parseSchtasksLogonMode(q.stdout));
  if (scope === recorded.scope && caveat === recorded.caveat) return;
  writeFileSync(
    p,
    serializeStartupState({ ...recorded, scope, caveat, at: recorded.at }),
    "utf8"
  );
  log("startup record refreshed from Task Scheduler", { scope, caveat: caveat ? "interactive-only" : null });
}

setInterval(() => {
  if (!existsSync(startupSignal)) return;
  let raw = "";
  try {
    raw = readFileSync(startupSignal, "utf8");
    unlinkSync(startupSignal);
  } catch {
    return; // mid-write; next tick gets it
  }
  const req = parseStartupRequest(raw);
  if (!req) {
    log("ignoring an unreadable startup request");
    return;
  }
  applyStartupRequest(req);
}, 2000).unref?.();

// ── Local crons: the scheduler seam on this peer (ADR-214) ───────────────────
//
// vercel.json points Vercel cron at three endpoints and GitHub Actions hits the
// sub-daily ones, so a LOCAL peer has no scheduler at all: on a self-hosted hub
// none of it runs. The seam already exists at the HTTP layer (both external
// triggers just GET /api/machine/<job> with a cron-scoped token), so what is
// missing is a trigger — and this process is already long-running, already has
// timers, and already knows the app's port.
//
// The load-bearing one is `purge`: it calls pruneSyncOps, so without it a local
// peer's oplog never prunes and ADR-213's retention holds decide nothing.
//
// Which jobs, and why only two default on, is the LOCAL_JOBS table in lib.mjs.

// Generous: relatedness and export both declare maxDuration 60 and an
// attachment-heavy export pass uses all of it.
const CRON_TIMEOUT_MS = 120_000;

/** name -> { dueAt, lastRunAt, lastOkAt, ok, detail, runs, fails } */
const cronEntries = {};
let cronBusy = false;

function writeCronState() {
  try {
    writeFileSync(cronStatePath(cfg.dataDir), serializeCronState(cfg.crons, cronEntries), "utf8");
  } catch (err) {
    log("could not write cron state", { error: String(err) });
  }
}

function primeCronState() {
  // Written even with no jobs configured, so "this peer runs nothing" and
  // "this peer has no supervisor" never look the same to the app.
  const prior = {};
  try {
    const p = cronStatePath(cfg.dataDir);
    if (existsSync(p)) {
      for (const j of parseCronState(readFileSync(p, "utf8"))?.jobs ?? []) prior[j.name] = j;
    }
  } catch {
    // an unreadable record is the same as no record
  }
  const now = Date.now();
  for (const job of cfg.crons) {
    const p = prior[job.name];
    cronEntries[job.name] = {
      lastRunAt: p?.lastRunAt ?? null,
      lastOkAt: p?.lastOkAt ?? null,
      ok: p?.ok ?? null,
      detail: p?.detail ?? null,
      runs: p?.runs ?? 0,
      fails: p?.fails ?? 0,
      dueAt: initialDueAt(job, p?.lastOkAt ?? null, now),
    };
  }
  writeCronState();
  if (cfg.crons.length > 0) {
    log("local crons scheduled", {
      jobs: cfg.crons.map((j) => `${j.name}@${j.at ?? `${Math.round(j.intervalMs / 60_000)}m`}`),
      exclusive: cfg.crons.filter((j) => !j.shared).map((j) => j.name),
    });
  }
}

/**
 * Tell the app about a failed run, exactly the way the GitHub Actions
 * workflows do (POST /api/machine/report-error): the failure lands in
 * error_log, /health counts it, and it surfaces wherever captured errors
 * already surface. No new reporting mechanism for a local trigger.
 *
 * Best-effort by nature — when the reason the job failed is that the app is
 * not answering, this cannot answer either, and the state file plus the log
 * are what remain.
 */
async function reportCronFailure(job, detail) {
  try {
    await fetch(`http://127.0.0.1:${cfg.appPort}/api/machine/report-error`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // The route prefixes this with the calling token's name ("local-cron"),
        // so the recorded source is local-cron:<job>. Naming it here too gave
        // "local-cron:local-cron:export" — seen on the rig.
        source: job.name,
        message: `local cron ${job.name} failed: ${detail}`,
        detail: { path: job.path, dataDir: cfg.dataDir },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // see above
  }
}


async function runCronJob(job) {
  const started = Date.now();
  let ok = false;
  let detail = null;
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.appPort}${job.path}`, {
      headers: { Authorization: `Bearer ${CRON_TOKEN}` },
      signal: AbortSignal.timeout(job.timeoutMs ?? CRON_TIMEOUT_MS),
    });
    ok = res.ok;
    const body = await res.text().catch(() => "");
    if (!ok) {
      detail = `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
    } else {
      // A job can succeed by deliberately doing NOTHING: an exclusive job is
      // scheduled on every peer now and the endpoint's ownership gate decides
      // (ADR-225). Recording that as a bare "ok" would tell the owner the
      // backup ran when another machine holds it, so carry the reason through
      // to cron-state.json and let the surfaces say which.
      detail = standDownDetailOf(body);
    }
  } catch (err) {
    detail = String(err?.message ?? err).slice(0, 300);
  }

  const now = Date.now();
  const e = cronEntries[job.name];
  e.lastRunAt = new Date(now).toISOString();
  e.runs += 1;
  e.ok = ok;
  e.detail = detail;
  if (ok) e.lastOkAt = e.lastRunAt;
  else e.fails += 1;
  e.dueAt = nextRunAt(job, now, ok);
  writeCronState();

  log(ok ? (detail ? "cron job stood down" : "cron job ok") : "cron job FAILED", {
    job: job.name,
    ms: now - started,
    nextAt: new Date(e.dueAt).toISOString(),
    ...(detail ? { detail } : {}),
  });
  if (!ok) await reportCronFailure(job, detail ?? "unknown");
}

async function cronTick() {
  if (cronBusy || updating) return; // an update in flight takes the app down
  const now = Date.now();
  const due = cfg.crons.filter((j) => cronEntries[j.name]?.dueAt <= now);
  if (due.length === 0) return;
  cronBusy = true;
  try {
    // Serially: these are the same endpoints a single-threaded cron calls, and
    // two 60s database jobs at once on one local Postgres helps nobody.
    for (const job of due) await runCronJob(job);
  } finally {
    cronBusy = false;
  }
}

if (cfg.crons.length > 0) {
  setInterval(() => void cronTick(), 60_000).unref?.();
}

// The automatic check runs on a fixed one-minute beat and asks the POLICY
// whether it is due, so switching it off, changing the interval, or moving to
// another branch or repo from the app or the tray takes effect within a minute
// with no restart. (It used to be one setInterval sized from config.json at
// boot, which is exactly the "edit a file and restart the service" shape
// ADR-222 rules out.)
let lastUpdateCheckAt = null;
setInterval(() => {
  if (updating) return;
  const policy = readPolicy();
  if (!updateCheckDue(policy, lastUpdateCheckAt, Date.now())) return;
  lastUpdateCheckAt = Date.now();
  applyPolicyRepo(policy);
  const target = targetSha();
  // Against what we are SERVING, not against the checkout's HEAD: "am I
  // running the branch's tip?" is the actual question, and the old form
  // asked it of a ref this install does not control.
  if (target.ok && liveBuild()?.sha !== target.sha) void applyUpdate("auto poll");
}, 60_000).unref?.();

// ── Boot + shutdown ──────────────────────────────────────────────────────────

// One supervisor per dataDir (see lib.mjs lockVerdict for why). Taken BEFORE
// Postgres starts, so the loser exits without touching the cluster, the live
// pointer, or the ports.
const lock = lockPath(cfg.dataDir);

/**
 * Is the pid in the lock file really a supervisor? true / false / null when the
 * process cannot be read. Costs a PowerShell start, which is why it is asked
 * once, here, and never in a wait loop.
 */
function identifySupervisor(pid) {
  const cmdline = processCommandLine(pid);
  return cmdline === null ? null : isSupervisorCommandLine(cmdline);
}

async function acquireLock() {
  try {
    // wx is the atomic part: create-or-fail, so two supervisors starting in
    // the same instant cannot both believe they took it.
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  let recorded = NaN;
  try {
    recorded = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
  } catch {
    // unreadable counts as garbage, handled by the verdict below
  }
  const alive = Number.isInteger(recorded) && pidAlive(recorded);
  const identified = alive ? identifySupervisor(recorded) : null;
  const verdict = lockVerdict({
    recordedPid: recorded,
    ownPid: process.pid,
    alive,
    identified,
    // Only consulted when the process behind the pid could not be read at all.
    serving: alive && identified === null ? await portListening(cfg.dbPort) : false,
  });
  if (verdict === "steal" && alive) {
    log("the lock names a pid that is not a supervisor; taking it over", {
      ownerPid: recorded,
      lock,
    });
  }
  if (verdict === "refuse") {
    log("another supervisor already owns this data directory; exiting", {
      dataDir: cfg.dataDir,
      ownerPid: recorded,
      lock,
    });
    console.error(
      `
A supervisor is already running for ${cfg.dataDir} (pid ${recorded}).
` +
        `Stop that one first, or delete ${lock} if you are certain it is dead.
`
    );
    process.exit(1);
  }
  if (verdict === "steal") log("taking over a stale lock", { stalePid: recorded });
  writeFileSync(lock, String(process.pid));
}

function releaseLock() {
  try {
    if (Number.parseInt(readFileSync(lock, "utf8").trim(), 10) === process.pid) unlinkSync(lock);
  } catch {
    // never block shutdown on the lock file
  }
}


/**
 * Shut the cluster down the way Postgres wants to be shut down.
 *
 * embedded-postgres's own `stop()` runs `taskkill /pid <postmaster> /f /t` on
 * Windows, which is not a shutdown at all — it is a kill, so every single stop
 * leaves the cluster replaying WAL on the next start ("database system was not
 * properly shut down; automatic recovery in progress", observed on the dev rig
 * 2026-08-23). Recovery is safe, but it is not free, and a hub that gets
 * stopped for every update should not pay it every time.
 *
 * `pg_ctl stop -m fast` is the ordinary answer: refuse new connections, roll
 * back open transactions, checkpoint, exit. pg_ctl ships in the same bin
 * directory as the postgres binary embedded-postgres already resolved.
 */
function pgCtlPath() {
  let bin;
  try {
    // resolve() lands on the package's dist entry; the binaries live one level
    // up in native/bin.
    bin = dirname(dirname(requireFromRepo.resolve("@embedded-postgres/" + PG_PLATFORM_PKG)));
  } catch {
    return null;
  }
  const pgCtl = join(bin, "native", "bin", isWin ? "pg_ctl.exe" : "pg_ctl");
  return existsSync(pgCtl) ? pgCtl : null;
}

function stopPostgresGracefully() {
  const pgCtl = pgCtlPath();
  if (!pgCtl) return false;
  // -w waits for it to finish; -t bounds that wait so a wedged cluster cannot
  // hang shutdown forever (the forced stop below is the fallback).
  const res = run(pgCtl, ["stop", "-D", pgDir, "-m", "fast", "-w", "-t", "30"]);
  if (!res.ok) log("pg_ctl stop did not complete; falling back to a forced stop", {
    detail: res.stderr || res.stdout,
  });
  return res.ok;
}

/**
 * Last resort when `pg_ctl stop` could not finish: kill the postmaster.
 *
 * This used to be embedded-postgres's `pg.stop()`, which kills the child
 * process IT spawned. We start through pg_ctl now, so there is no such child —
 * postgres is its own process and the only handle on it is postmaster.pid.
 * Same outcome (an unclean stop that costs WAL replay on the next start), same
 * guards as the orphan path: only a live pid, only one whose image really is a
 * postmaster, so a reissued pid cannot make us kill an unrelated process.
 */
async function forceStopPostgres() {
  const lockFile = join(pgDir, "postmaster.pid");
  if (!existsSync(lockFile)) return;
  let recorded;
  try {
    recorded = parsePostmasterPid(readFileSync(lockFile, "utf8"));
  } catch {
    return;
  }
  if (recorded.pid === null || !pidAlive(recorded.pid)) return;
  const image = processImageName(recorded.pid);
  if (typeof image !== "string" || !image.includes("postgres")) return;
  log("forcing postgres down", { pid: recorded.pid });
  if (isWin) run("taskkill", ["/pid", String(recorded.pid), "/f", "/t"]);
  else {
    try {
      process.kill(recorded.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  // Bounded wait so shutdown cannot hang on a process that will not die.
  for (let i = 0; i < 20 && pidAlive(recorded.pid); i += 1) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

let restartAfterShutdown = false;

/**
 * Start the successor and leave. Called after Postgres is confirmed down, so
 * the new process is never racing this one for the cluster — and it is handed
 * this pid to outlive as well, because "confirmed down" is about Postgres, not
 * about this process's own exit.
 *
 * Detached with its stdio pointed at the peer's log files: a supervisor started
 * by Task Scheduler has nowhere to write, which is exactly why the failure that
 * prompted all this took a foreground rerun to see.
 */
function spawnSuccessor() {
  const script = join(here, "ledgr-supervisor.mjs");
  let out = "ignore";
  let err = "ignore";
  try {
    out = openSync(join(cfg.dataDir, "supervisor.log"), "a");
    err = openSync(join(cfg.dataDir, "supervisor.err.log"), "a");
  } catch {
    // no log files: still restart, just blind
  }
  const child = spawn(process.execPath, [script, configPath], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, [AWAIT_PID_ENV]: String(process.pid) },
    cwd: cfg.repoDir,
  });
  child.unref();
  log("successor started", { pid: child.pid });
  writeSupervisorState({ phase: "handing-off", detail: null, fromPid: process.pid });
  return child.pid;
}

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down", { sig });
  if (restartTimer) clearTimeout(restartTimer);
  await stopApp();
  const clean = stopPostgresGracefully();
  // pg_ctl start means there is no child handle to lean on, so the forced
  // fallback goes by postmaster.pid instead of pg.stop()'s remembered process.
  if (!clean) await forceStopPostgres();
  log("postgres stopped", { clean });
  releaseLock();
  if (restartAfterShutdown) {
    try {
      spawnSuccessor();
    } catch (err) {
      // Nothing else can report this: the app is down and this process is
      // leaving. The record is what the next surface reads.
      const detail = String(err?.message ?? err).slice(0, 300);
      log("could not start the successor", { detail });
      writeSupervisorState({ phase: "failed", detail: `Could not start the replacement: ${detail}` });
    }
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Run from the repo whatever launched us. Task Scheduler has no "start in"
// field on the action it registers, so a boot-started supervisor inherits
// System32 as its working directory; nothing depends on cwd today, and this
// keeps it that way by construction rather than by luck.
try {
  process.chdir(cfg.repoDir);
} catch {
  // a repoDir that is gone is a bigger problem, reported elsewhere
}

// Handing off from a previous supervisor (ADR-227): wait for it to actually be
// gone before claiming the lock. Bounded — if it never exits, taking the lock
// from a live process is worse than reporting the failure.
const awaitPid = Number(process.env[AWAIT_PID_ENV] ?? "");
if (Number.isInteger(awaitPid) && awaitPid > 0) {
  const deadline = Date.now() + AWAIT_PID_TIMEOUT_MS;
  log("waiting for the outgoing supervisor to exit", { pid: awaitPid });
  while (Date.now() < deadline && pidAlive(awaitPid)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (pidAlive(awaitPid)) {
    log("the outgoing supervisor is still running; not taking over", { pid: awaitPid });
    writeSupervisorState({
      phase: "failed",
      detail: `The previous local service (pid ${awaitPid}) never exited, so this one stood aside.`,
    });
    process.exit(1);
  }
  log("the outgoing supervisor is gone; taking over", { pid: awaitPid });
}

await acquireLock();
// Before the app starts, so the state file exists (and says "nothing due yet")
// from the first moment the app can be asked about it.
primeCronState();
seedPolicyIfMissing();
refreshStartupState();
await startPostgres();
const ptr = liveBuild();
if (ptr) {
  startApp(ptr);
} else {
  // No fetch on first boot: a fresh clone is already current, and an origin
  // hiccup must not block the very first build.
  log("no live build yet; building the target branch as already fetched", {
    branch: readPolicy().branch,
  });
  await applyUpdate("first run", { fetch: false });
  if (!liveBuild()) {
    log("first build failed; supervisor stays up (fix the repo, then touch the signal file)");
  }
}
// "Healthy" means the app ANSWERS, not that a build exists (ADR-227). The
// weaker reading was the first version of this and it was the same class of
// half-truth the rest of this feature exists to delete: a peer whose port never
// opened would have recorded a clean restart.
//
// Reported by the process that achieved it, never predicted by the one that
// asked for it — which is why the outgoing supervisor's last word is
// "handing-off" and only this one can write "healthy".
{
  const prior = (() => {
    try {
      return parseSupervisorState(readFileSync(supervisorStatePath(cfg.dataDir), "utf8"));
    } catch {
      return null;
    }
  })();
  const wasRestart = prior?.restart?.phase === "handing-off" || prior?.restart?.phase === "stopping";
  if (wasRestart) {
    restartBlock = { ...prior.restart, fromPid: prior.restart.fromPid ?? prior.pid ?? null };
  }
  writeSupervisorState(null); // pid + code fingerprints, whatever happens next

  if (wasRestart) {
    void (async () => {
      const detail = await waitForOwnPort();
      writeSupervisorState(
        detail === null
          ? { phase: "healthy", detail: null }
          : { phase: "failed", detail }
      );
    })();
  }
}

/**
 * Wait for this peer's own app to answer. Returns null when it did, or the
 * reason it did not — which is the sentence the owner reads on a page served by
 * some OTHER copy, because this one never came back.
 */
async function waitForOwnPort() {
  const deadline = Date.now() + 90_000;
  let last = "it never answered";
  while (Date.now() < deadline) {
    if (!liveBuild()) {
      last = "there is no usable build to serve";
    } else {
      try {
        const res = await fetch(`http://127.0.0.1:${cfg.appPort}/`, {
          signal: AbortSignal.timeout(3000),
        });
        // Any answer at all means the server is up; a redirect to sign-in is a
        // perfectly healthy Ledgr.
        if (res.status > 0) return null;
      } catch (err) {
        last = String(err?.message ?? err).slice(0, 160);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return `Came back up, but nothing answered on port ${cfg.appPort}: ${last}.`;
}

// The supervisor's own state, refreshed on the same beat as the cron record, so
// "an update landed under the running service" surfaces without a restart.
setInterval(() => writeSupervisorState(null), 60_000).unref?.();

// The interval timers are unref'd; the postgres + app children keep the
// process alive. A bare interval pins the event loop for the no-child window
// between a crash and its restart.
setInterval(() => {}, 60_000);
