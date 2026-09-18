#!/usr/bin/env node
// The supervisor's missing verbs (ADR-211). `npm run local:supervisor` starts a
// peer; until now there was no way to stop one, ask whether one was running, or
// change its boot registration after install. That absence is what let three
// orphaned supervisors accumulate on one machine, it is what an install agent
// needs in order to VERIFY rather than assume, and it is what turns "is my hub
// running?" into a question the owner can answer.
//
//   npm run local:status                 # is it up, which build, boot state
//   npm run local:status -- --json       # the same, machine-readable
//   npm run local:stop                   # graceful shutdown of the running peer
//   npm run local:boot                   # start one if one is not already up
//   npm run local:startup                # what Windows currently holds
//   npm run local:startup -- --logon     # start at sign-in (no elevation)
//   npm run local:startup -- --always    # start at boot (24/7 hub; elevation)
//   npm run local:startup -- --disable
//   npm run local:tray                   # the notification-area icon
//
// A separate entry point from ledgr-supervisor.mjs on purpose: that file boots
// Postgres and the app on import-and-run, so it cannot answer a question
// without becoming the thing it is being asked about.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive, portListening, processCommandLine } from "./proc.mjs";
import {
  formatSchtasks,
  isSupervisorCommandLine,
  lockVerdict,
  livePointerPath,
  lockPath,
  normalizeConfig,
  parseLivePointer,
  parseSchtasksScope,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  schtasksQueryArgs,
  parseSchtasksLogonMode,
  startupCaveat,
  restartSignalPath,
  supervisorStatePath,
  serializeRestartRequest,
  parseSupervisorState,
  AWAIT_PID_ENV,
  serializeStartupRequest,
  startupScope,
  startupSignalPath,
  startupStatePath,
  stopSignalPath,
  parseStartupState,
  STARTUP_TASK_NAME,
  cronStatePath,
  parseCronState,
  parseUpdatePolicy,
  updatePolicyPath,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";

const argv = process.argv.slice(2);
const verb = argv.find((a) => !a.startsWith("-")) ?? "status";
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const configPath = resolve(flagValue("config") ?? join(here, "config.json"));
if (!existsSync(configPath)) {
  console.error(`No config at ${configPath}. Pass --config=<path> or run the setup wizard.`);
  process.exit(2);
}
const cfg = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")), dirname(configPath));

// ── Shared readers ───────────────────────────────────────────────────────────

/**
 * Is the peer's lock owner a REAL supervisor, not just a live process number?
 *
 * The distinction is the whole reason this exists. Asking only "does that pid
 * exist" said yes about a number Windows had recycled after the 2026-08-27
 * reboot, so `status` reported a healthy peer that was serving nothing and
 * `restart` refused to fix it. Identity comes from the process's command line;
 * the Postgres port is the tie-break when that cannot be read. The rules
 * themselves live in lib.mjs lockVerdict, so the supervisor and this script
 * cannot drift apart on what counts as running.
 *
 * Costs a PowerShell start, so it answers the questions that DECIDE something.
 * The wait loops below stay on plain `pidAlive`, which is the right question
 * for them anyway: has the process I already identified gone away yet?
 */
async function supervisorAlive(pid) {
  if (pid === null || !pidAlive(pid)) return false;
  const cmdline = processCommandLine(pid);
  const identified = cmdline === null ? null : isSupervisorCommandLine(cmdline);
  return (
    lockVerdict({
      recordedPid: pid,
      ownPid: process.pid,
      alive: true,
      identified,
      serving: identified === null ? await portListening(cfg.dbPort) : false,
    }) === "refuse"
  );
}

function ownerPid() {
  const lock = lockPath(cfg.dataDir);
  if (!existsSync(lock)) return null;
  const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function liveBuild() {
  const p = livePointerPath(cfg.dataDir);
  return existsSync(p) ? parseLivePointer(readFileSync(p, "utf8")) : null;
}

async function appAnswers() {
  // A supervisor process can be alive while the app it manages is not (a bad
  // build, a crash loop), so "running" and "serving" are separate facts.
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.appPort}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
    });
    return res.status;
  } catch {
    return null;
  }
}

/** What Windows actually holds, not what we last asked for. */
function registeredScope() {
  if (!isWin) return { supported: false, registered: false, scope: null, mode: null };
  const res = spawnSync("schtasks", schtasksQueryArgs(), { encoding: "utf8" });
  if (res.status !== 0) return { supported: true, registered: false, scope: null, mode: null };
  const text = res.stdout ?? "";
  // The logon mode comes from the SAME query, so the caveat below can be
  // computed from what Windows holds right now. It used to be printed from
  // startup-state.json — a string recorded at registration time and never
  // re-checked — so a task later upgraded to run with nobody signed in kept
  // being reported as if it could not (found live 2026-08-26: schtasks said
  // Interactive/Background while this said the opposite, and the advice it gave
  // was for a password Ledgr no longer uses).
  return {
    supported: true,
    registered: true,
    scope: parseSchtasksScope(text),
    mode: parseSchtasksLogonMode(text),
  };
}

/** This peer's own service state, as the supervisor last wrote it. */
function supervisorState() {
  try {
    return parseSupervisorState(readFileSync(supervisorStatePath(cfg.dataDir), "utf8"));
  } catch {
    return null;
  }
}

function recordedStartupState() {
  const p = startupStatePath(cfg.dataDir);
  return existsSync(p) ? parseStartupState(readFileSync(p, "utf8")) : null;
}

/** The scheduled jobs this peer triggers for itself, and how they are doing
 * (ADR-214). What the supervisor recorded, not what the config asked for. */
function recordedCronState() {
  const p = cronStatePath(cfg.dataDir);
  return existsSync(p) ? parseCronState(readFileSync(p, "utf8")) : null;
}

// ── status ───────────────────────────────────────────────────────────────────

async function doStatus() {
  const pid = ownerPid();
  const running = await supervisorAlive(pid);
  const live = liveBuild();
  const http = running ? await appAnswers() : null;
  const boot = registeredScope();
  const recorded = recordedStartupState();
  const crons = recordedCronState();

  const report = {
    running,
    pid: running ? pid : null,
    // A lock naming a dead pid is the stale-lock case the supervisor steals
    // on its next start; surfaced so nobody deletes it by guesswork.
    stalePid: pid !== null && !running ? pid : null,
    dataDir: cfg.dataDir,
    configPath,
    appPort: cfg.appPort,
    dbPort: cfg.dbPort,
    serving: http !== null,
    httpStatus: http,
    build: live ? { sha: live.sha.slice(0, 7), dir: live.dir } : null,
    startup: {
      supported: boot.supported,
      registered: boot.registered,
      scope: boot.scope,
      // Present only when a request went through the app's toggle, and it is
      // the honest record of whether that request actually worked.
      lastRequest: recorded,
    },
    // Scheduled work this peer triggers itself. `jobs: []` means it triggers
    // none, which is a real answer and a different one from "no record".
    crons: crons ? { at: crons.at, jobs: crons.jobs } : null,
  };

  if (flags.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return running ? 0 : 1;
  }

  console.log(`Ledgr peer at ${cfg.dataDir}`);
  console.log(`  supervisor  ${running ? `running (pid ${pid})` : "not running"}`);
  if (report.stalePid) {
    console.log(`              a lock names pid ${report.stalePid}, which is gone (stale)`);
  }
  console.log(
    `  app         ${report.serving ? `answering on :${cfg.appPort} (HTTP ${http})` : `not answering on :${cfg.appPort}`}`
  );
  console.log(`  build       ${report.build ? report.build.sha : "none flipped yet"}`);
  // The update policy is a file the app page and the tray window edit, so the
  // CLI reads the same file rather than quoting config.json's stale seed.
  {
    let policy = null;
    try {
      policy = parseUpdatePolicy(readFileSync(updatePolicyPath(cfg.dataDir), "utf8"));
    } catch {
      // none written yet (a supervisor from before this, or one not started)
    }
    console.log(
      `  updates     ${
        !policy
          ? "no policy written yet (the service writes one on its first start)"
          : policy.mode === "auto"
            ? `checked every ${policy.everyMinutes} min on origin/${policy.branch}`
            : `only when asked from the app (origin/${policy.branch})`
      }`
    );
  }
  if (!boot.supported) {
    console.log("  at boot     not managed here on this platform (see supervisor/README.md)");
  } else if (!boot.registered) {
    console.log("  at boot     not registered — this peer does not come back after a reboot");
  } else {
    console.log(
      `  at boot     registered (${boot.scope === "always" ? "at system start" : boot.scope === "logon" ? "at sign-in" : "unrecognized schedule"})`
    );
  }
  // A successful registration that will not survive a logged-out boot is worse
  // than a failed one: it reads as done. Say so wherever we say "registered".
  // Live when we could ask Windows, recorded only as the fallback.
  const liveCaveat = boot.registered ? startupCaveat(boot.scope, boot.mode) : null;
  const caveat = boot.registered ? liveCaveat : recorded?.ok ? recorded.caveat : null;
  if (caveat) {
    console.log(`  heads up    ${caveat}`);
  }
  if (recorded && !recorded.ok) {
    console.log(`  last change FAILED: ${recorded.detail ?? "unknown"}`);
    if (recorded.command) console.log(`              run this elevated: ${recorded.command}`);
  }
  const self = supervisorState();
  if (self?.runningCode && self.installedCode && self.runningCode !== self.installedCode) {
    console.log("  code        the running service predates the code on disk — restart to apply it");
    console.log(`              (running ${self.runningCode}, installed ${self.installedCode}); npm run local:restart`);
  }
  if (self?.restart) {
    const r = self.restart;
    const when = r.at ? ` (${r.at})` : "";
    if (r.phase === "healthy") console.log(`  last restart came back healthy${when}`);
    else if (r.phase === "failed") console.log(`  last restart FAILED${when}: ${r.detail ?? "unknown"}`);
    else console.log(`  last restart left mid-flight at "${r.phase}"${when} — this peer may not have come back`);
  }
  if (!crons) {
    console.log("  jobs        no record yet (an older supervisor, or one that has not started)");
  } else if (crons.jobs.length === 0) {
    console.log("  jobs        none scheduled here — trash never empties and the sync log");
    console.log("              never prunes on this machine (see crons in config.json)");
  } else {
    for (const j of crons.jobs) {
      const mark = j.state === "ok" ? "ok     " : j.state === "failing" ? "FAILING" : j.state === "late" ? "LATE   " : "pending";
      console.log(`  job         ${mark} ${j.name}${j.shared ? "" : " (exclusive)"}`);
      if (j.detail && j.ok === false) console.log(`                      ${j.detail}`);
    }
  }
  return running ? 0 : 1;
}

// ── restart ──────────────────────────────────────────────────────────────────
//
// The CLI twin of the app's Restart button (ADR-227), and deliberately the same
// mechanism: write the request, let the supervisor hand off to its successor,
// then WATCH until something is actually serving again. "Restarted" that means
// "the request was filed" is the kind of half-truth this project keeps deleting.
async function doRestart() {
  const pid = ownerPid();
  const alive = await supervisorAlive(pid);

  if (!alive) {
    // Nothing to hand off from: start one. Detached, with its output appended
    // to the peer's logs, because a supervisor with nowhere to write is how a
    // startup failure becomes invisible.
    if (pid !== null) await clearStaleLock(pid);
    console.log("No local service running — starting one.");
    const child = spawnDetachedSupervisor();
    if (!child) return 1;
    console.log(`Started (pid ${child}). Waiting for it to serve…`);
    return (await waitForServing(child)) ? 0 : 1;
  }

  writeFileSync(restartSignalPath(cfg.dataDir), serializeRestartRequest({ reason: "asked from the command line" }), "utf8");
  console.log(`Asked pid ${pid} to restart; waiting for the replacement to serve…`);
  return (await waitForServing(null, pid)) ? 0 : 1;
}

function spawnDetachedSupervisor() {
  const script = join(here, "ledgr-supervisor.mjs");
  let out = "ignore";
  let err = "ignore";
  try {
    out = openSync(join(cfg.dataDir, "supervisor.log"), "a");
    err = openSync(join(cfg.dataDir, "supervisor.err.log"), "a");
  } catch {
    // still start it, just blind
  }
  try {
    const child = spawn(process.execPath, [script, configPath], {
      detached: true,
      stdio: ["ignore", out, err],
      cwd: cfg.repoDir,
      env: { ...process.env, [AWAIT_PID_ENV]: "" },
    });
    child.unref();
    return child.pid ?? null;
  } catch (err2) {
    console.error(`Could not start the local service: ${String(err2?.message ?? err2)}`);
    return null;
  }
}

/**
 * Wait for a peer to be genuinely back: a live supervisor that is NOT the one
 * we asked to leave, and an app answering on the port. Two minutes, because a
 * restart stops Postgres cleanly and starts it again.
 */
async function waitForServing(expectPid, replacingPid = null) {
  const deadline = Date.now() + 120_000;
  let lastPhase = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const self = supervisorState();
    const phase = self?.restart?.phase ?? null;
    if (phase && phase !== lastPhase) {
      lastPhase = phase;
      if (phase === "failed") {
        console.error(`Restart failed: ${self.restart.detail ?? "unknown"}`);
        return false;
      }
    }
    const now = ownerPid();
    const fresh = now !== null && pidAlive(now) && now !== replacingPid;
    if (fresh && (await appAnswers())) {
      console.log(`Healthy: pid ${now} is serving on :${cfg.appPort}.`);
      return true;
    }
  }
  console.error(
    "It has not come back within two minutes. npm run local:status shows what it\n" +
      "is doing; the supervisor's own log is in the peer's data directory."
  );
  return false;
}

// ── stop ─────────────────────────────────────────────────────────────────────

async function doStop() {
  const pid = ownerPid();
  if (pid === null) {
    console.log("No supervisor lock — nothing to stop.");
    return 0;
  }
  if (!(await supervisorAlive(pid))) {
    console.log(`The lock names pid ${pid}, which is already gone — clearing the stale lock.`);
    await clearStaleLock(pid);
    return 0;
  }

  // Ask through a FILE, not a signal. Sending a termination signal to another
  // process on Windows is a hard terminate, not something a Node handler can
  // catch: the supervisor's shutdown path never runs, so Postgres is killed
  // rather than shut down (recovery on the next start) and the lock survives
  // looking like a live owner. Observed on the dev rig. The file reaches the
  // same handler a Ctrl-C reaches, on every platform.
  writeFileSync(stopSignalPath(cfg.dataDir), new Date().toISOString(), "utf8");
  console.log(`Asked pid ${pid} to stop cleanly; waiting for it to shut down…`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!pidAlive(pid)) {
      // Postgres shutting down is the slow part, and it happens before the
      // lock is released, so a gone pid means the clean path completed.
      console.log("Stopped.");
      await clearStaleLock(pid);
      return 0;
    }
  }
  console.error(
    `pid ${pid} is still running after 60s. It may be mid-build (an update in\n` +
      "flight is not interrupted). Check with npm run local:status and try again;\n" +
      "kill it by hand only as a last resort, since that skips the clean Postgres\n" +
      "shutdown."
  );
  return 1;
}

/**
 * Remove a lock whose owner is provably not a running supervisor. Never touches
 * a live one — the test is `supervisorAlive`, not "does that number exist", so
 * a lock left behind on a pid Windows has since recycled clears like any other.
 */
async function clearStaleLock(pid) {
  try {
    const lock = lockPath(cfg.dataDir);
    if (!existsSync(lock)) return;
    if (Number.parseInt(readFileSync(lock, "utf8").trim(), 10) !== pid) return;
    if (await supervisorAlive(pid)) return;
    unlinkSync(lock);
  } catch {
    // A lock we cannot clear is not worth failing the stop over; the next
    // start steals it anyway (lockVerdict "steal").
  }
}

// ── boot (what Windows runs at startup) ──────────────────────────────────────

/**
 * Bring this peer up if it is not already up, and say so either way.
 *
 * This is what the scheduled task runs, instead of the supervisor itself, for
 * two reasons the 2026-08-27 reboot made expensive:
 *
 *   A task action has no stdout. A supervisor Windows starts directly writes
 *   its startup into nowhere, so the morning the database refused to start, the
 *   only surviving evidence was the phrase "would not start" and none of the
 *   reason. Going through here means the supervisor is spawned the same way
 *   `restart` has always spawned it, with the peer's two log files attached.
 *
 *   And a peer that died badly has to be able to come back on its own. A stale
 *   lock is cleared here rather than waiting for a person to delete a file,
 *   which is what the outage actually required.
 *
 * Idempotent on purpose: running it when the peer is healthy does nothing, so
 * it is safe to run from a schedule, from a shortcut, or twice by accident.
 */
async function doBoot() {
  const pid = ownerPid();
  if (await supervisorAlive(pid)) {
    console.log(`Already running (pid ${pid}).`);
    return 0;
  }
  if (pid !== null) {
    console.log(`The lock names pid ${pid}, which is not a running supervisor — clearing it.`);
    await clearStaleLock(pid);
  }
  const child = spawnDetachedSupervisor();
  if (!child) return 1;
  console.log(`Started (pid ${child}). Waiting for it to serve…`);
  return (await waitForServing(child)) ? 0 : 1;
}

// ── startup (the boot registration) ──────────────────────────────────────────

function doStartup() {
  if (!isWin) {
    // Deliberately not pretending: the launchd plist / systemd unit are still
    // written by hand, and saying otherwise would be worse than saying so.
    console.log(
      "Boot registration is managed here on Windows only for now.\n" +
        "For macOS (launchd) and Linux (systemd user units), see supervisor/README.md."
    );
    return 2;
  }

  const wantDisable = flags.has("--disable") || flags.has("--off");
  const wantAlways = flags.has("--always") || flags.has("--boot");
  const wantLogon = flags.has("--logon") || flags.has("--signin");

  if (!wantDisable && !wantAlways && !wantLogon) {
    const boot = registeredScope();
    console.log(
      boot.registered
        ? `Registered to start ${boot.scope === "always" ? "at system start (before anyone signs in)" : "when you sign in"}.`
        : "Not registered — this peer does not come back after a reboot."
    );
    console.log(
      "\nChange it with:\n" +
        "  npm run local:startup -- --logon    start when you sign in (no elevation)\n" +
        "  npm run local:startup -- --always   start at boot, before sign-in (needs an\n" +
        "                                      Administrator prompt, and a stored password\n" +
        "                                      if nobody will be signed in)\n" +
        "  npm run local:startup -- --disable"
    );
    return 0;
  }

  if (wantDisable) {
    const res = spawnSync("schtasks", schtasksDeleteArgs(), { stdio: "inherit" });
    if (res.status === 0) {
      console.log(`Removed "${STARTUP_TASK_NAME}". This peer no longer starts on its own.`);
      return 0;
    }
    console.error("Could not remove the task. It may need an Administrator prompt.");
    return 1;
  }

  const scope = startupScope(wantAlways ? "always" : "logon");
  const args = schtasksCreateArgs({
    username: process.env.USERNAME || process.env.USER || "",
    nodePath: process.execPath,
    supervisorScript: join(here, "ledgr-supervisor.mjs"),
    configPath,
    scope,
  });
  const res = spawnSync("schtasks", args, { stdio: "inherit" });
  if (res.status === 0) {
    console.log(
      scope === "always"
        ? "Registered to start at system boot, and to run with nobody signed in — no\n" +
            "  Windows password is stored or needed (/NP, the \"Do not store password\"\n" +
            "  option). The task gets no network credential, which costs this peer nothing:\n" +
            "  it reads a public git remote over HTTPS and calls its own localhost port."
        : "Registered to start when you sign in."
    );
    console.log(`Start it now without rebooting: schtasks /Run /TN "${STARTUP_TASK_NAME}"`);
    return 0;
  }
  // The easier route first, because it is the one with nothing to mistype: the
  // same command, elevated, registers the task through this script and no
  // quoting passes through a shell at all. The raw schtasks line stays below it
  // for the case where npm is not on the elevated PATH.
  console.error(
    "schtasks failed — the always-on scope needs elevation.\n\n" +
      "Easiest fix: open PowerShell as Administrator and run this same command there:\n" +
      "  cd " +
      cfg.repoDir +
      "\n  npm run local:startup -- --always\n\n" +
      "Or paste this line into an Administrator PowerShell (the --% matters; without\n" +
      "it PowerShell eats the quotes and registers a task that breaks on any path\n" +
      "containing a space):\n  " +
      formatSchtasks(args, { shell: "powershell" })
  );
  return 1;
}

// ── tray (the notification-area icon) ────────────────────────────────────────

const TRAY_SCRIPT = join(here, "ledgr-tray.ps1");
const TRAY_SHORTCUT_NAME = "Ledgr.lnk";

/** A value as a PowerShell single-quoted literal (doubling is the only escape). */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Run a PowerShell snippet and hand back its trimmed stdout, or null. */
function psOut(script) {
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) return null;
  return (res.stdout ?? "").trim();
}

/**
 * The pids of any tray icons already running for this machine.
 *
 * The split string is not a style tic. This query runs inside a powershell.exe
 * whose OWN command line therefore contains whatever pattern it searches for,
 * so a literal "ledgr-tray.ps1" here makes the query match itself — which it
 * did, reporting a different "tray pid" on every call and hiding the fact that
 * the real icon was not running at all. Building the pattern from two halves
 * means the contiguous string never appears in this process's command line.
 */
function runningTrayPids() {
  const out = psOut(
    "$pat = '*ledgr-' + 'tray.ps1*'; " +
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -like $pat } | " +
      "ForEach-Object { $_.ProcessId }"
  );
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function stopTray() {
  const pids = runningTrayPids();
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  return pids.length;
}

function trayArgs() {
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    TRAY_SCRIPT,
    "-NodePath",
    process.execPath,
    "-CtlScript",
    join(here, "ledgr-ctl.mjs"),
    "-ConfigPath",
    configPath,
    "-AppPort",
    String(cfg.appPort),
    "-DbPort",
    String(cfg.dbPort),
    "-DataDir",
    cfg.dataDir,
  ];
}

/**
 * Start the icon and hand back the pid it is ACTUALLY running as, or null if it
 * did not come up.
 *
 * Launched through PowerShell's own Start-Process rather than Node's `spawn`,
 * because spawning powershell.exe detached with no stdio does not survive here:
 * it is a console host, and with no console and no handles it exits at once.
 * Measured, not assumed — the direct spawn produced no icon at all, while this
 * produces one that outlives the terminal that asked for it.
 *
 * The pid is then looked up rather than taken from the spawn, since the process
 * we launch is not the process that ends up running. Reporting a number the
 * owner cannot act on is worse than reporting none.
 */
async function startTray() {
  const before = new Set(runningTrayPids());
  const list = trayArgs().map(psQuote).join(", ");
  psOut(`Start-Process -FilePath 'powershell.exe' -ArgumentList @(${list}) -WindowStyle Hidden`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const fresh = runningTrayPids().filter((p) => !before.has(p));
    if (fresh.length > 0) return fresh[0];
  }
  return null;
}

function startupShortcutPath() {
  const appData = process.env.APPDATA ?? "";
  return appData
    ? join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", TRAY_SHORTCUT_NAME)
    : null;
}

/**
 * The tray icon starts at SIGN-IN, from a Startup shortcut, and deliberately
 * not from the scheduled task that starts the service. They answer to different
 * lifetimes: the peer runs whether or not anyone is signed in, and an icon in
 * the notification area only means anything while someone is looking at a
 * desktop. Keeping them separate also means the icon can be turned off without
 * touching whether Ledgr runs.
 */
function installTrayShortcut(lnk) {
  // Two quoting layers, and they are not the same layer. The inner one is for
  // the shortcut's own argument string, where a path with a space needs plain
  // double quotes ("C:\Program Files\nodejs\node.exe"). The outer one is for
  // the PowerShell literal carrying it, where only a single quote is special
  // and doubling it is the whole escape. Getting the inner layer wrong writes a
  // shortcut that fails only on machines whose paths have spaces in them.
  const q = psQuote;
  const argLine = trayArgs()
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");
  const script =
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)}); ` +
    `$s.TargetPath = ${q("powershell.exe")}; ` +
    `$s.Arguments = ${q(argLine)}; ` +
    `$s.WorkingDirectory = ${q(here)}; ` +
    `$s.WindowStyle = 7; ` +
    `$s.Description = 'Ledgr status icon'; ` +
    `$s.Save()`;
  return psOut(script) !== null;
}

async function doTray() {
  if (!isWin) {
    console.log("The tray icon is Windows-only. On macOS and Linux, use npm run local:status.");
    return 2;
  }
  const lnk = startupShortcutPath();

  if (flags.has("--uninstall") || flags.has("--disable") || flags.has("--off")) {
    const stopped = stopTray();
    let removed = false;
    if (lnk && existsSync(lnk)) {
      unlinkSync(lnk);
      removed = true;
    }
    console.log(
      `Tray icon ${stopped > 0 ? "closed" : "was not running"}${removed ? " and removed from startup" : ""}.\n` +
        "Ledgr itself is untouched and still running; check with npm run local:status."
    );
    return 0;
  }

  if (flags.has("--stop")) {
    const stopped = stopTray();
    console.log(stopped > 0 ? "Tray icon closed. Ledgr itself is untouched." : "No tray icon was running.");
    return 0;
  }

  // Installing is the default, because an icon that vanishes at the next sign-in
  // is not the thing anyone was asking for.
  const skipInstall = flags.has("--once") || flags.has("--no-install");
  if (!skipInstall && lnk) {
    if (installTrayShortcut(lnk)) {
      console.log("The icon will come back automatically when you sign in.");
    } else {
      console.error("Could not write the startup shortcut; starting the icon for this session only.");
    }
  }

  // One icon, not one per invocation.
  stopTray();
  const pid = await startTray();
  if (pid === null) {
    console.error("Could not start the tray icon — nothing appeared within eight seconds.");
    return 1;
  }
  console.log(
    `Tray icon started (pid ${pid}). Look near the clock, at the right-hand end of\n` +
      "the taskbar — you may need to click the ^ arrow and drag it out to pin it.\n" +
      "  Green   Ledgr is running\n" +
      "  Amber   starting up, or the app is down while the database is fine\n" +
      "  Red     not running\n" +
      "Right-click it to open Ledgr, open the status window (version, disk use,\n" +
      "jobs, and the update policy you can edit there), start, restart or stop.\n" +
      "Turn it off with: npm run local:tray -- --uninstall"
  );
  return 0;
}

// ── request (what the app's toggle writes; exposed for testing the path) ─────

function doRequest() {
  const enabled = !flags.has("--disable") && !flags.has("--off");
  const scope = startupScope(flags.has("--always") || flags.has("--boot") ? "always" : "logon");
  writeFileSync(startupSignalPath(cfg.dataDir), serializeStartupRequest(enabled, scope), "utf8");
  console.log(
    `Wrote the request the supervisor polls (${enabled ? `enable, ${scope}` : "disable"}).\n` +
      "It acts within a couple of seconds; check with npm run local:status."
  );
  return 0;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const verbs = {
  status: doStatus,
  boot: doBoot,
  restart: doRestart,
  stop: doStop,
  startup: doStartup,
  tray: doTray,
  request: doRequest,
};
const fn = verbs[verb];
if (!fn) {
  console.error(`Unknown verb "${verb}". One of: ${Object.keys(verbs).join(", ")}`);
  process.exit(2);
}
// Set the code and let Node wind down on its own, rather than process.exit().
// Calling exit() while the sockets from a health check are still closing trips
// a libuv assertion on Windows and kills this process with status 127 — after
// the work succeeded. Harmless from a terminal, not harmless from Task
// Scheduler, which would record every successful boot as a failure. Winding
// down naturally is also faster here (~160ms vs ~430ms), because the exit path
// is not racing the teardown.
process.exitCode = (await fn()) ?? 0;
