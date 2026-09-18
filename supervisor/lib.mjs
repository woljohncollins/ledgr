// Pure decision logic for the local-peer supervisor (plan phase 2 / LH2,
// ADR-206 decision 6). Everything here is side-effect free and imported by
// scripts/verify-supervisor.mts; the process/spawn shell lives in
// ledgr-supervisor.mjs and stays thin. Node builtins only.
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Validate + normalize supervisor/config.json. `baseDir` anchors relative
 * paths (the directory the config file lives in). Throws with a readable
 * message on anything unusable; fills documented defaults for the rest.
 */
export function normalizeConfig(raw, baseDir) {
  if (!raw || typeof raw !== "object") throw new Error("config must be a JSON object");
  const cfg = raw;

  if (typeof cfg.dataDir !== "string" || cfg.dataDir.length === 0) {
    throw new Error("config.dataDir is required (where Postgres data and builds live)");
  }
  if (typeof cfg.ownerEmail !== "string" || !cfg.ownerEmail.includes("@")) {
    throw new Error("config.ownerEmail is required (the local owner identity, LEDGR_LOCAL_OWNER_EMAIL)");
  }
  const role = cfg.role ?? "spoke";
  if (role !== "hub" && role !== "spoke") {
    throw new Error(`config.role must be "hub" or "spoke", got ${JSON.stringify(role)}`);
  }
  const updateMode = cfg.update?.mode ?? "prompted";
  if (updateMode !== "prompted" && updateMode !== "auto") {
    throw new Error(`config.update.mode must be "prompted" or "auto", got ${JSON.stringify(updateMode)}`);
  }
  const syncMode = cfg.syncMode ?? "full";
  if (syncMode !== "full" && syncMode !== "pull-only") {
    throw new Error(`config.syncMode must be "full" or "pull-only", got ${JSON.stringify(syncMode)}`);
  }
  const hubs = Array.isArray(cfg.hubs) ? cfg.hubs.filter((h) => typeof h === "string" && h.length > 0) : [];

  const abs = (p, fallback) => {
    const v = typeof p === "string" && p.length > 0 ? p : fallback;
    return isAbsolute(v) ? v : resolve(baseDir, v);
  };
  const port = (v, fallback) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${JSON.stringify(v)}`);
    return n;
  };

  return {
    role,
    dataDir: abs(cfg.dataDir),
    // The git clone the supervisor pulls and builds from. Default: the repo
    // the supervisor script itself lives in (config sits in <repo>/supervisor).
    repoDir: abs(cfg.repoDir, ".."),
    branch: typeof cfg.branch === "string" && cfg.branch ? cfg.branch : "main",
    appPort: port(cfg.appPort, 3000),
    dbPort: port(cfg.dbPort, 5433),
    ownerEmail: cfg.ownerEmail,
    hubs,
    deviceToken: typeof cfg.deviceToken === "string" ? cfg.deviceToken : "",
    syncMode,
    update: {
      mode: updateMode,
      pollIntervalMs: Math.max(60_000, Number(cfg.update?.pollIntervalMs) || 15 * 60_000),
    },
    cadence: {
      pushDebounceMs: Number(cfg.cadence?.pushDebounceMs) || 2000,
      pullMs: Number(cfg.cadence?.pullMs) || 10_000,
    },
    // Guardrails 2 & 3 (first-push size guard, clock-skew hold). Defaults
    // mirror src/lib/sync/client.ts's own fallbacks, so an unset config and an
    // unset env var behave identically.
    syncGuardrails: {
      maxFirstPush: Math.max(1, Number(cfg.syncGuardrails?.maxFirstPush) || 500),
      confirmLargePush: cfg.syncGuardrails?.confirmLargePush === true,
      skewWarnMs: Math.max(0, Number(cfg.syncGuardrails?.skewWarnMs) || 5000),
      skewHoldMs: Math.max(0, Number(cfg.syncGuardrails?.skewHoldMs) || 60_000),
    },
    // Which scheduled jobs this peer triggers for itself (ADR-214). Resolved
    // against LOCAL_JOBS below, so a mistyped job name throws here rather than
    // silently running nothing.
    crons: normalizeCrons(cfg.crons),
    // Local Postgres tuning (ADR-215). `tunePostgres: false` turns the
    // auto-sizing off; `postgresFlags` appends raw flags AFTER the tuned set,
    // and for a repeated -c the last occurrence wins, so a manual flag always
    // overrides the automatic one.
    tunePostgres: cfg.tunePostgres !== false,
    postgresFlags: Array.isArray(cfg.postgresFlags)
      ? cfg.postgresFlags.filter((f) => typeof f === "string" && f.length > 0)
      : [],
    // Extra env passed through to the app verbatim (R2 keys, Graph secrets…).
    extraEnv: cfg.extraEnv && typeof cfg.extraEnv === "object" ? { ...cfg.extraEnv } : {},
  };
}

// ── Local Postgres tuning (ADR-215) ──────────────────────────────────────────
//
// embedded-postgres ships stock defaults sized for a machine from 2005:
// shared_buffers 128MB (the prod spoke's whole 798MB database cannot stay
// cached, so any page-heavy query evicts itself every run — the A2 finding),
// random_page_cost 4 (the spinning-disk number; it made the planner overprice
// the index scans every list depends on), work_mem 4MB. The supervisor knows
// the machine's RAM, so size these automatically rather than leaving a number
// in a config file nobody revisits.
//
// Every value here is a session-safe, restart-applied server GUC; none of them
// change what is on disk, so a peer can flip tunePostgres off and restart back
// to stock at any time.

/** Format bytes as a Postgres memory setting (whole MB). */
function asMB(bytes) {
  return `${Math.max(1, Math.floor(bytes / (1024 * 1024)))}MB`;
}

/**
 * The tuned flag set for a machine with `totalMemBytes` of RAM. Pure so the
 * verify suite can sweep sizes. Returns [] when tuning is off.
 *
 *   shared_buffers        RAM/8, clamped [128MB, 1GB] — enough that a real
 *                         Ledgr database (798MB measured) fits entirely, small
 *                         enough to be invisible on an 8GB laptop.
 *   effective_cache_size  RAM/2 — planner-only (allocates nothing); tells it
 *                         the OS cache exists, which stock 4GB already said,
 *                         but keep it honest on small machines.
 *   random_page_cost      1.1 — the SSD number. A peer genuinely on spinning
 *                         rust overrides via postgresFlags.
 *   work_mem              16MB — sorts of 200-row list pages never spill.
 *   maintenance_work_mem  RAM/32 clamped [64MB, 256MB] — VACUUM and
 *                         CREATE INDEX during restores/migrations.
 */
export function tunedPostgresFlags(cfg, totalMemBytes) {
  if (!cfg.tunePostgres) return [...cfg.postgresFlags];
  const mem = Number(totalMemBytes) || 0;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const MB = 1024 * 1024;
  const flags = [
    "-c", `shared_buffers=${asMB(clamp(mem / 8, 128 * MB, 1024 * MB))}`,
    "-c", `effective_cache_size=${asMB(Math.max(mem / 2, 512 * MB))}`,
    "-c", "random_page_cost=1.1",
    "-c", "work_mem=16MB",
    "-c", `maintenance_work_mem=${asMB(clamp(mem / 32, 64 * MB, 256 * MB))}`,
  ];
  // Owner overrides append last: for a repeated -c, postgres takes the last
  // occurrence, so a manual flag beats its tuned counterpart.
  return [...flags, ...cfg.postgresFlags];
}

// ── Env assembly ─────────────────────────────────────────────────────────────

export function buildDbUrl(cfg) {
  return `postgresql://postgres:postgres@127.0.0.1:${cfg.dbPort}/ledgr`;
}

/**
 * The env the app child is spawned with (merged over process.env by the
 * shell). LEDGR_SELF_UPDATE is "on" because the supervisor's apply path runs
 * migrate before the flip, which is exactly the condition "on" encodes
 * (mirror of build:satellite's migrate-then-build ordering).
 *
 * `opts.cronTokenHash` adds the supervisor's own ephemeral cron token to the
 * app's token list (ADR-214) so its scheduled calls come in through the
 * ordinary machine-token door. It is APPENDED to whatever tokens the owner
 * already configured — in `extraEnv` or in the real environment, passed as
 * `opts.inheritedApiTokens` — because clobbering the owner's tokens to make
 * room for ours would take the MCP server down to run a purge.
 */
export function assembleAppEnv(cfg, buildSha, opts = {}) {
  const env = {
    NODE_ENV: "production",
    DATABASE_URL: buildDbUrl(cfg),
    PORT: String(cfg.appPort),
    LEDGR_BUILD_SHA: buildSha ?? "",
    LEDGR_LOCAL_OWNER_EMAIL: cfg.ownerEmail,
    LEDGR_SUPERVISOR_DIR: cfg.dataDir,
    LEDGR_SELF_UPDATE: "on",
    // The branch this install actually tracks, so Build → Updates asks "am I
    // current?" about the same ref the supervisor builds from. Without it the
    // page defaults to `main` and reports a peer that tracks a release branch
    // as behind every time main moves ahead of a release.
    GITHUB_BRANCH: cfg.branch,
    LEDGR_SYNC_PUSH_DEBOUNCE_MS: String(cfg.cadence.pushDebounceMs),
    LEDGR_SYNC_PULL_MS: String(cfg.cadence.pullMs),
    ...cfg.extraEnv,
  };
  // Sync arms only when both halves exist (mirrors startSyncLoop's own gate);
  // a hub, or a spoke not yet joined, gets neither var rather than half.
  if (cfg.hubs.length > 0 && cfg.deviceToken) {
    env.LEDGR_SYNC_HUBS = cfg.hubs.join(",");
    env.LEDGR_SYNC_TOKEN = cfg.deviceToken;
    env.LEDGR_SYNC_MODE = cfg.syncMode;
    env.LEDGR_SYNC_MAX_FIRST_PUSH = String(cfg.syncGuardrails.maxFirstPush);
    env.LEDGR_SYNC_CONFIRM_LARGE_PUSH = String(cfg.syncGuardrails.confirmLargePush);
    env.LEDGR_SYNC_SKEW_WARN_MS = String(cfg.syncGuardrails.skewWarnMs);
    env.LEDGR_SYNC_SKEW_HOLD_MS = String(cfg.syncGuardrails.skewHoldMs);
  }
  // After the extraEnv spread on purpose: the merged list has to win over an
  // extraEnv entry, or the owner's own LEDGR_API_TOKENS would drop ours.
  if (opts.cronTokenHash) {
    env.LEDGR_API_TOKENS = [
      opts.inheritedApiTokens,
      cfg.extraEnv.LEDGR_API_TOKENS,
      localCronTokenEntry(opts.cronTokenHash),
    ]
      .filter((v) => typeof v === "string" && v.length > 0)
      .join(",");
  }
  return env;
}

// ── The live pointer (keep-last-good) ────────────────────────────────────────
//
// Which build directory `next start` runs from is a tiny JSON pointer file,
// <dataDir>/live.json — deliberately not a symlink/junction: a plain file the
// supervisor reads at spawn works identically on win32/darwin/linux, needs no
// privileges, and survives tools that don't follow reparse points.

export function livePointerPath(dataDir) {
  return join(dataDir, "live.json");
}

export function buildsDir(dataDir) {
  return join(dataDir, "builds");
}

export function signalPath(dataDir) {
  return join(dataDir, "update-requested");
}

// ── "Start when Windows starts" (ADR-211) ────────────────────────────────────
//
// Same shape as the update signal above, deliberately: the app cannot register
// a scheduled task itself (the always-on scope wants an elevated prompt), so
// it writes a signal file and the supervisor — already a long-running local
// process the owner started — does the work and records what happened where
// the app can read it. One signal-file pattern, not two.

/**
 * The graceful-stop request. Needed because on Windows `process.kill(pid,
 * "SIGTERM")` does NOT deliver a signal a Node handler can catch — it
 * terminates the process outright, so the supervisor's shutdown path never
 * runs: Postgres is killed rather than shut down (recovery on the next start)
 * and the lock file is left behind looking like a live owner. Asking through a
 * file lets the process stop ITSELF through the same handler a Ctrl-C uses.
 */
export function stopSignalPath(dataDir) {
  return join(dataDir, "stop-requested");
}

export function startupSignalPath(dataDir) {
  return join(dataDir, "startup-requested");
}

export function startupStatePath(dataDir) {
  return join(dataDir, "startup-state.json");
}

// ── Restarting the peer from the app (ADR-227) ───────────────────────────────
//
// THE PROBLEM. The supervisor owns the app, so the app cannot restart the
// supervisor: killing your own parent leaves nobody to start you again. Every
// change to the supervisor's own code therefore ended in "now go restart the
// local service", which is a builder's gesture asked of the person using the
// product — the rule ADR-222 wrote down.
//
// THE MECHANISM is the one already proven twice here: the app writes a REQUEST
// FILE, a local process that can actually do the thing carries it out, and the
// outcome is written back for the app to read (stop-requested, ADR-211;
// startup-requested, ADR-211). Restart is the same shape with one twist — the
// process carrying it out is the one going away, so before it exits it spawns
// its successor and hands it its own pid to wait for.
//
// WHAT MAKES IT RELIABLE, which is the whole requirement (Brandon, 2026-08-26:
// a button he can be confident reaches healthy again, whatever the reason):
//
//   1. the successor WAITS for the outgoing pid to exit before claiming the
//      lock, so the two never fight over Postgres or the port;
//   2. Postgres start RETRIES. Windows keeps a shared-memory segment attached
//      until the last orphaned backend goes, and a start into that window fails
//      with "pre-existing shared memory block is still in use" — one instant
//      failure and the peer stays down. Observed live on 2026-08-26 after a
//      hard kill;
//   3. every phase is written to supervisor-state.json, so a peer that did NOT
//      come back can say why instead of just being absent.

export function restartSignalPath(dataDir) {
  return join(dataDir, "restart-requested");
}

/** What the supervisor is, and what it last did. Written only by it. */
export function supervisorStatePath(dataDir) {
  return join(dataDir, "supervisor-state.json");
}

/** Env var carrying the pid a starting supervisor must outlive. */
export const AWAIT_PID_ENV = "LEDGR_SUPERVISOR_AWAIT_PID";

export function serializeRestartRequest(o = {}) {
  return JSON.stringify(
    { reason: typeof o.reason === "string" && o.reason ? o.reason : "asked from the app", at: o.at ?? new Date().toISOString() },
    null,
    2
  );
}

/**
 * Tolerant read. A request that cannot be parsed still RESTARTS — the file's
 * existence is the instruction and its contents are only the reason, so a
 * half-written or hand-made file must not leave the owner pressing a dead
 * button.
 */
export function parseRestartRequest(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") {
      return {
        reason: typeof v.reason === "string" && v.reason ? v.reason : "asked from the app",
        at: typeof v.at === "string" ? v.at : null,
      };
    }
  } catch {
    // fall through
  }
  return { reason: "asked from the app", at: null };
}

/**
 * The phases, in order. `handing-off` is the last thing the OUTGOING process
 * writes, so a state stuck there means the successor never started — which is
 * exactly the failure the owner needs told, and it cannot be written by the
 * process that would have to report it.
 */
export const RESTART_PHASES = ["requested", "stopping", "handing-off", "healthy", "failed"];

export function serializeSupervisorState(o) {
  return JSON.stringify(
    {
      pid: Number.isInteger(o?.pid) ? o.pid : null,
      startedAt: typeof o?.startedAt === "string" ? o.startedAt : null,
      // The supervisor's own code, as it is RUNNING vs as it sits on disk.
      // Different means an update landed that this process predates, which is
      // the one case the owner has to press the button for.
      runningCode: typeof o?.runningCode === "string" ? o.runningCode : null,
      installedCode: typeof o?.installedCode === "string" ? o.installedCode : null,
      restart: o?.restart
        ? {
            phase: RESTART_PHASES.includes(o.restart.phase) ? o.restart.phase : "failed",
            at: typeof o.restart.at === "string" ? o.restart.at : new Date().toISOString(),
            reason: typeof o.restart.reason === "string" ? o.restart.reason : null,
            detail: typeof o.restart.detail === "string" ? o.restart.detail : null,
            fromPid: Number.isInteger(o.restart.fromPid) ? o.restart.fromPid : null,
          }
        : null,
    },
    null,
    2
  );
}

export function parseSupervisorState(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") return null;
    const r = v.restart && typeof v.restart === "object" ? v.restart : null;
    return {
      pid: Number.isInteger(v.pid) ? v.pid : null,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : null,
      runningCode: typeof v.runningCode === "string" ? v.runningCode : null,
      installedCode: typeof v.installedCode === "string" ? v.installedCode : null,
      restart: r
        ? {
            phase: RESTART_PHASES.includes(r.phase) ? r.phase : "failed",
            at: typeof r.at === "string" ? r.at : null,
            reason: typeof r.reason === "string" ? r.reason : null,
            detail: typeof r.detail === "string" ? r.detail : null,
            fromPid: Number.isInteger(r.fromPid) ? r.fromPid : null,
          }
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * A short, stable fingerprint of the supervisor's own source. Deliberately not
 * a git sha: the supervisor runs from the checkout as it is on disk, and what
 * matters is whether the FILES changed under the running process.
 */
export function codeFingerprint(contents) {
  const h = createHash("sha256");
  for (const c of contents) h.update(String(c ?? ""), "utf8");
  return h.digest("hex").slice(0, 12);
}

/**
 * How long to wait before Postgres start attempt N (1-based). Zero first, then
 * a widening pause: the thing being waited for is Windows releasing a shared
 * memory segment or a port, which takes seconds, not minutes.
 */
export const PG_START_ATTEMPTS = 4;
export function pgStartDelayMs(attempt) {
  return [0, 2000, 5000, 10000][Math.min(Math.max(attempt, 1), PG_START_ATTEMPTS) - 1];
}

/**
 * How many half-second polls to give ONE start attempt before calling it dead.
 * 120 = 60s, which has to cover crash recovery on a real database, not just a
 * clean start. The cost of being generous is a slower failure; the cost of
 * being stingy is declaring a recovering cluster broken and restarting into it.
 */
export const PG_READY_ATTEMPTS = 120;

/** How long a successor waits for the outgoing supervisor to exit. */
export const AWAIT_PID_TIMEOUT_MS = 90_000;

export const STARTUP_TASK_NAME = "Ledgr Supervisor";

/**
 * The two scopes, and the difference matters enough that nothing defaults it
 * silently:
 *   "logon"  — /SC ONLOGON. Needs no elevation, but the peer only comes up
 *              after somebody signs in.
 *   "always" — /SC ONSTART. What a 24/7 hub actually needs (the phone and the
 *              MCP connector reach it whether or not anyone is at the desk),
 *              and it generally wants elevation plus a stored credential.
 */
export function startupScope(raw) {
  return raw === "always" ? "always" : "logon";
}

/** Tolerant parse of the signal file: anything unreadable means "no request". */
export function parseStartupRequest(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || typeof v.enabled !== "boolean") return null;
    return { enabled: v.enabled, scope: startupScope(v.scope) };
  } catch {
    return null;
  }
}

export function serializeStartupRequest(enabled, scope) {
  return JSON.stringify({ enabled: !!enabled, scope: startupScope(scope) }) + "\n";
}

/**
 * The outcome the supervisor records after acting. `ok: false` is a normal,
 * expected state — registering the always-on scope without elevation fails —
 * so `command` carries what the owner can run in an Administrator prompt
 * instead. A silent failure here would be the worst kind: the owner ticks a
 * box, believes their hub survives a reboot, and finds out otherwise.
 */
/**
 * @param {{enabled: boolean, scope?: string, ok: boolean, detail?: string | null,
 *          command?: string | null, at?: string | null, caveat?: string | null}} o
 */
export function serializeStartupState(o) {
  const { enabled, scope, ok, detail = null, command = null, at = null, caveat = null } = o;
  return (
    JSON.stringify(
      {
        enabled: !!enabled,
        scope: startupScope(scope),
        ok: !!ok,
        detail: detail ?? null,
        command: command ?? null,
        caveat: caveat ?? null,
        at: at ?? new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/** Tolerant parse of the recorded state; null when absent or unusable. */
export function parseStartupState(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || typeof v.enabled !== "boolean") return null;
    return {
      enabled: v.enabled,
      scope: startupScope(v.scope),
      ok: v.ok === true,
      detail: typeof v.detail === "string" ? v.detail : null,
      command: typeof v.command === "string" ? v.command : null,
      caveat: typeof v.caveat === "string" ? v.caveat : null,
      at: typeof v.at === "string" ? v.at : null,
    };
  } catch {
    return null;
  }
}

// ── What to type at the hub-URL prompt (ADR-212) ─────────────────────────────
//
// Nothing in the wizard mentioned Tailscale, yet the whole hub story depends on
// it. Rather than a general tour, the ask was narrower and more useful: at the
// field where a hub URL goes, say what to put in it. So detect Tailscale by
// asking it, never by asking the owner to interpret anything.
//
// Counterpart: src/lib/network-addresses.ts does the same read for the app,
// which shows a hub its OWN addresses. Keep them in step.

/** Tolerant read of `tailscale status --json`. Anything unexpected reads as
 * "installed but not usable" rather than throwing. */
export function parseTailscaleJson(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { installed: true, running: false, dnsName: null, ips: [] };
  }
  const dns = typeof v?.Self?.DNSName === "string" ? v.Self.DNSName.replace(/\.$/, "") : "";
  const ips = Array.isArray(v?.Self?.TailscaleIPs)
    ? v.Self.TailscaleIPs.filter((i) => typeof i === "string" && !i.includes(":"))
    : [];
  return {
    installed: true,
    running: v?.BackendState === "Running",
    dnsName: dns || null,
    ips,
  };
}

/**
 * The help text for the hub-URL prompt, given what Tailscale reports and the
 * hub's app port. Pure so the wording is testable without a tailnet.
 *
 * Prefers the MagicDNS hostname over the raw 100.x: both work, but the
 * hostname is readable and survives a re-address.
 */
export function hubUrlHint(ts, port = 3000) {
  const lines = [];
  if (ts && ts.running && ts.dnsName) {
    const mine = ts.dnsName;
    const tailnet = mine.includes(".") ? mine.slice(mine.indexOf(".") + 1) : "your-tailnet.ts.net";
    lines.push(
      "Tailscale is running here, so use the hub's tailnet address:",
      `  http://<the-hub's-machine-name>.${tailnet}:${port}`,
      "",
      `This machine's own tailnet name is ${mine}, so the hub's looks the same`,
      "with its machine name in front. The hub shows you its exact address on its",
      "own Build → Network page — copy it from there rather than typing it out.",
      "",
      "The raw 100.x.y.z address works too, but the name is readable and keeps",
      "working if the addresses change."
    );
  } else if (ts && ts.installed && !ts.running) {
    lines.push(
      "Tailscale is installed here but not signed in yet, so it cannot reach a",
      "hub over the tailnet. Run `tailscale up`, sign in, and the hub's address",
      `will look like http://<machine>.<your-tailnet>.ts.net:${port}.`,
      "",
      "Without it, your options are limited: a LAN address",
      `(http://192.168.x.x:${port}) reaches the hub only from this same network,`,
      "or the hub has to be published on the internet, which is a bigger step."
    );
  } else {
    lines.push(
      "Tailscale is not installed here. It is the easy path: install it on both",
      "machines, sign both into the same tailnet, and the hub's address becomes",
      `http://<machine>.<your-tailnet>.ts.net:${port} from anywhere, with nothing`,
      "exposed to the internet.",
      "",
      "Without it: a LAN address like http://192.168.x.x:" + port + " works only",
      "while both machines are on the same network, or the hub has to be",
      "published publicly (a tunnel), which is a bigger step and only actually",
      "needed for callers that cannot join a tailnet."
    );
  }
  return lines.join("\n");
}

// ── The scheduled-task argv (win32) ──────────────────────────────────────────
// Pure argv builders so both the wizard and the supervisor register the task
// the same way, and `status` can read back what Windows actually holds.

/**
 * @param {{username: string, nodePath: string, supervisorScript: string,
 *          configPath: string, scope?: string}} o — an absent scope means the
 *          SAFE one (logon), never the one that demands elevation.
 */
export function schtasksCreateArgs(o) {
  const { username, nodePath, supervisorScript, configPath, scope = "logon" } = o;
  const always = startupScope(scope) === "always";
  return [
    "/Create",
    "/TN",
    STARTUP_TASK_NAME,
    "/SC",
    // Chosen deliberately (ADR-211). This used to be hardcoded ONSTART, which
    // quietly demanded elevation on every install.
    always ? "ONSTART" : "ONLOGON",
    // /RU + /NP only for the always-on scope, where the account has to be
    // named because the task runs with nobody signed in. For the logon scope
    // the default IS the current user, and naming them can pull in a password
    // requirement the scope exists to avoid.
    //
    // /NP is exactly the "Do not store password" checkbox in Task Scheduler's
    // own dialog: an S4U logon that runs with nobody signed in and asks the
    // owner for no credential at all. Without it, /RU with no /RP silently
    // downgrades to interactive-only (the honesty rule below) and the box the
    // owner ticked does not do what it says. The cost is that the task gets no
    // NETWORK credential: local files, the local Postgres, the local app port
    // and outbound HTTPS all work, but an authenticated SMB share or a mapped
    // drive would not. The supervisor wants none of those — its git remote is
    // a public HTTPS fetch and every job it fires is a localhost call.
    ...(always ? ["/RU", username, "/NP"] : []),
    "/TR",
    // Windows starts the CONTROL script, not the supervisor, and the control
    // script starts the supervisor (`boot`). Two things come free from that
    // indirection, both of which the 2026-08-27 reboot needed and neither of
    // which Windows can do for us:
    //
    //   1. Log files. A task action gets no stdout, so a supervisor launched
    //      straight from Windows writes its startup into nowhere — which is why
    //      that morning's Postgres failure left the phrase "would not start"
    //      and not one word of the reason. `boot` spawns it with supervisor.log
    //      and supervisor.err.log already attached, the same way `restart` has
    //      always done.
    //   2. Self-healing. `boot` clears a stale lock before starting, so a peer
    //      that died badly still comes back on its own.
    `"${nodePath}" "${ctlScriptFor(supervisorScript)}" boot --config="${configPath}"`,
    "/F", // idempotent: re-running replaces the task instead of erroring
  ];
}

/**
 * The control script sits beside the supervisor; every caller already has that
 * path, so nobody has to pass a second one.
 *
 * Deliberately not `join(dirname(...))`: those read the separator of the
 * machine this code is RUNNING on, while the path handed in describes the
 * machine being configured. The two are the same in production and different
 * in the verify suite, which runs on Linux in CI and Windows on the rig — so
 * the node-path version passed here and failed there. Swapping the last
 * segment keeps the caller's own separator, whichever it is.
 */
export function ctlScriptFor(supervisorScript) {
  const cut = Math.max(supervisorScript.lastIndexOf("/"), supervisorScript.lastIndexOf("\\"));
  return cut < 0 ? "ledgr-ctl.mjs" : supervisorScript.slice(0, cut + 1) + "ledgr-ctl.mjs";
}

export function schtasksDeleteArgs() {
  return ["/Delete", "/TN", STARTUP_TASK_NAME, "/F"];
}

export function schtasksQueryArgs() {
  return ["/Query", "/TN", STARTUP_TASK_NAME, "/FO", "LIST", "/V"];
}

/**
 * Read the registered scope back out of `schtasks /Query /FO LIST` output, so
 * `status` reports what Windows holds rather than what we last asked for.
 * Returns "always" | "logon" | null (registered but unrecognized).
 */
export function parseSchtasksScope(text) {
  if (/^\s*Schedule Type:\s*At system start ?up/im.test(text)) return "always";
  if (/^\s*Schedule Type:\s*At logon/im.test(text)) return "logon";
  return null;
}

// ── Registered, but will it actually run? (the ADR-211 honesty rule) ─────────
//
// schtasks /Create with /RU <user> and neither /RP <password> nor /NP succeeds
// and then quietly downgrades to "Interactive only": Windows runs the task ONLY
// while that user is signed in. On the always-on scope that is the exact
// failure the scope exists to prevent — the owner ticks a box, the registration
// reports success, and the hub does not come back from a boot nobody logged
// into.
//
// /NP now fixes that for them (see schtasksCreateArgs), so this should no
// longer fire. It stays as the honesty rule: if Windows ever registers
// something weaker than we asked for, the owner hears it from us rather than
// from a reboot. The old advice — go type your Windows password into Task
// Scheduler — is gone, because no password is involved any more. A downgrade
// now means the account lacks the batch-logon right, which an elevated retry
// resolves.

/** "interactive" (logged-on only), "background" (runs logged out), or null. */
export function parseSchtasksLogonMode(text) {
  // The \s escapes matter: schtasks /FO LIST does not indent today, but the
  // sibling parseSchtasksScope above has always had them and this one lost
  // them, so a `s*` here was matching a literal "s" and only working by luck.
  const m = /^\s*Logon Mode:\s*(.+)$/im.exec(text);
  if (!m) return null;
  const v = m[1].trim().toLowerCase();
  if (v.startsWith("interactive only")) return "interactive";
  if (v.includes("background")) return "background";
  return null;
}

/**
 * The caveat to show beside a SUCCESSFUL registration, or null when there is
 * nothing to warn about. Only the always-on scope can be undercut this way:
 * the logon scope is interactive-only by definition and that is what it says.
 */
export function startupCaveat(scope, logonMode) {
  if (startupScope(scope) !== "always") return null;
  if (logonMode !== "interactive") return null;
  return (
    "Registered, but Windows will only run it while you are signed in — so a " +
    "reboot nobody logs into still leaves this peer down. We asked for a " +
    "no-password (S4U) task and Windows registered a weaker one, which usually " +
    "means this account lacks the \"Log on as a batch job\" right. Tick the box " +
    "again and accept the Administrator prompt; if it keeps happening, open " +
    "Task Scheduler, find \"" + STARTUP_TASK_NAME + "\", and set \"Run whether " +
    "user is logged on or not\" with \"Do not store password\" ticked."
  );
}
/**
 * The schtasks argv as one command line. **The shell matters**, so it is named
 * rather than assumed — the two callers here run in different ones, and the
 * difference is invisible until a path contains a space.
 *
 * `cmd` (default) is for the batch file the elevation path writes, where the
 * backslash-quote escaping is parsed by schtasks itself and nothing else
 * touches the line.
 *
 * `powershell` is for the line printed as "paste this into an Administrator
 * PowerShell", and it needs `--%`, which is load-bearing rather than
 * decoration. Without it PowerShell parses the rest of the line and re-quotes
 * each argument on the way to the executable — and the `/TR` value is itself a
 * command line made of quotes. Measured 2026-08-27, when Brandon pasted the
 * un-prefixed version: it failed outright with "Invalid argument/option", and
 * the two natural repairs (a single-quoted literal, or the value held in a
 * variable) BOTH reported SUCCESS while registering a task whose command had
 * lost every quote. That task runs today, because these paths have no spaces,
 * and stops running the day one does. `--%` hands the rest of the line over
 * verbatim, and Windows stores the quotes.
 *
 * @param {string[]} args
 * @param {{shell?: "cmd" | "powershell"}} [opts]
 */
export function formatSchtasks(args, opts = {}) {
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(" ");
  // --% is a PowerShell token. In a .cmd it would be passed to schtasks as a
  // literal argument, which is why this is not simply always on.
  return `schtasks ${opts.shell === "powershell" ? "--% " : ""}${quoted}`;
}

// ── Single-instance ownership ────────────────────────────────────────────────
//
// One supervisor per dataDir, because two of them fight over everything that
// matters: they race for the update signal file (whoever polls first wins and
// the other never learns), they both try to bind appPort and dbPort, and they
// both drive the same Postgres cluster and the same live.json. Found the hard
// way on 2026-08-23: three had accumulated on one machine (stopping
// `npm run local:supervisor` kills npm and orphans the node child), an orphan
// ate an update signal, and the update failed where nobody could see it.
//
// This is not an exotic state. supervisor/README.md step 5 says run it in a
// terminal and step 7 says register it at boot; doing both, as intended,
// produces exactly two.

export function lockPath(dataDir) {
  return join(dataDir, "supervisor.lock");
}

/**
 * What to do when the lock file already exists.
 *
 * A pid is not an identity. Windows reissues process numbers freely, and most
 * freely right after a boot, which is exactly when this file is most likely to
 * be stale. On 2026-08-27 that took the peer down: the lock named pid 4080, the
 * supervisor behind it was dead, 4080 had been reissued to an unrelated
 * process, and "is 4080 alive?" answered yes — so the peer reported itself
 * healthy while serving nothing, and refused every attempt to start one.
 * (The ponytail comment that used to sit here called this exact window, and
 * judged it too narrow to be worth closing. It was not.)
 *
 * So aliveness alone never decides. `identified` carries the real answer, read
 * from the running process's command line: true means it IS a supervisor,
 * false means the number was reused by something else, null means we could not
 * read it. Only the null case falls back to corroboration, and the corroborator
 * is `serving` — a live supervisor has a Postgres accepting connections, a
 * stale lock does not.
 *
 * @param {object} o
 * @param {number} o.recordedPid pid read from the lock file (NaN when garbage)
 * @param {number} o.ownPid this process
 * @param {boolean} o.alive whether recordedPid is a running process
 * @param {boolean|null} [o.identified] is that process a Ledgr supervisor?
 *   null = could not tell
 * @param {boolean} [o.serving] is the peer's Postgres port accepting
 *   connections? Only consulted when identity is unknown.
 * @returns {"take" | "steal" | "mine" | "refuse"} take = no valid owner
 *   recorded, steal = the recorded owner is gone or was never us, mine = we
 *   already hold it, refuse = a supervisor really is alive on this dataDir
 */
export function lockVerdict({ recordedPid, ownPid, alive, identified = null, serving = false }) {
  if (!Number.isInteger(recordedPid) || recordedPid <= 0) return "take";
  if (recordedPid === ownPid) return "mine";
  if (!alive) return "steal";
  if (identified === true) return "refuse";
  if (identified === false) return "steal";
  // Unknown identity: an unreadable process is usually not one of ours, but
  // guessing wrong here would put two supervisors on one data directory. The
  // port settles it.
  return serving ? "refuse" : "steal";
}

/** Does this command line belong to a Ledgr supervisor? */
export function isSupervisorCommandLine(cmdline) {
  return typeof cmdline === "string" && /ledgr-supervisor\.mjs/i.test(cmdline);
}

/**
 * Read Postgres's own lock file. Its format is positional and stable: line 1 is
 * the postmaster's pid, line 4 is the port it bound.
 */
export function parsePostmasterPid(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const num = (i) => {
    const v = Number.parseInt(lines[i] ?? "", 10);
    return Number.isInteger(v) && v > 0 ? v : null;
  };
  return { pid: num(0), port: num(3) };
}

/**
 * Whether a leftover postmaster.pid may be deleted.
 *
 * This is the other half of the same 2026-08-27 outage, and it is the half that
 * actually stopped the peer. A machine that reboots without a clean shutdown
 * leaves this file behind naming the pid Postgres last ran as. Postgres refuses
 * to start when that pid is a live process — correct when the process really is
 * a postmaster, a dead end when the number was simply reused, because the
 * cluster then never starts again without a person deleting a file by hand.
 *
 * Removing it is Postgres's own documented recovery. Made automatic, it needs
 * two guards to stay safe, because two postmasters on one data directory
 * corrupts it: the port is checked first, so a Postgres that is genuinely up is
 * never disturbed, and the file goes only when nothing is listening AND the
 * process behind the pid is provably not a postmaster.
 *
 * @param {object} o
 * @param {number|null} o.recordedPid pid from line 1
 * @param {boolean} o.alive whether that pid is a running process
 * @param {string|null} o.image its executable name, lowercased
 * @param {boolean} o.portListening is anything accepting connections on the
 *   port from line 4?
 * @returns {"stale" | "live"} stale = safe to delete
 */
export function postmasterVerdict({ recordedPid, alive, image, portListening }) {
  if (portListening) return "live";
  if (!Number.isInteger(recordedPid) || recordedPid <= 0) return "stale";
  if (!alive) return "stale";
  return typeof image === "string" && image.includes("postgres") ? "live" : "stale";
}

/** Tolerant parse: any malformed pointer reads as "no live build". */
export function parseLivePointer(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v.dir === "string" && v.dir && typeof v.sha === "string" && v.sha) {
      return { dir: v.dir, sha: v.sha };
    }
  } catch {
    // fall through
  }
  return null;
}

export function serializeLivePointer(dir, sha) {
  return JSON.stringify({ dir, sha, flippedAt: new Date().toISOString() }, null, 2) + "\n";
}

/**
 * The keep-last-good rule, stated once: the pointer flips only when the build
 * AND the migrate both succeeded. Any failure keeps the previous build
 * serving.
 */
export function decideFlip({ buildOk, migrateOk }) {
  return buildOk === true && migrateOk === true ? "flip" : "keep";
}

/**
 * npm ci is needed only when the lockfile changed between the build being
 * served and the build being made (hashes of package-lock.json). A missing
 * previous hash (first build) also needs it.
 */
export function needsNpmCi(prevLockHash, nextLockHash) {
  return !prevLockHash || prevLockHash !== nextLockHash;
}

/**
 * Prune to the last N builds (default 2: live + one fallback). Input: the
 * build dir names (shas) with their creation order via mtimeMs, plus the live
 * sha, which is always kept regardless of age. Returns the shas to delete.
 */
export function pruneList(builds, liveSha, keep = 2) {
  const sorted = [...builds].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepSet = new Set([liveSha]);
  for (const b of sorted) {
    if (keepSet.size >= keep) break;
    keepSet.add(b.sha);
  }
  return sorted.filter((b) => !keepSet.has(b.sha)).map((b) => b.sha);
}

// ── Crash restart backoff ────────────────────────────────────────────────────
// ponytail: plain exponential backoff capped at 60s, reset after a minute of
// uptime; upgrade to jitter/health-probes only if flapping is ever observed.

export function nextBackoffMs(consecutiveCrashes) {
  const n = Math.max(0, consecutiveCrashes);
  return Math.min(1000 * 2 ** n, 60_000);
}

// ── Local crons: the scheduler seam on a self-hosted peer (ADR-214) ──────────
//
// Scheduled work has always been triggered from OUTSIDE the app: vercel.json
// points Vercel cron at three endpoints, GitHub Actions hits the sub-daily
// ones. Both walk through the same door — GET /api/machine/<job> with a
// cron-scoped machine token — so the scheduler seam already exists at the HTTP
// layer. What a local peer lacks is a TRIGGER, and this is it: the supervisor
// is already a long-running process with timers in it and it knows the app's
// port, so it calls the same endpoints over loopback.
//
// The one that matters is `purge`, because it runs pruneSyncOps: without it a
// local peer's oplog never prunes and ADR-213's retention holds decide nothing.

/**
 * The catalog. Two questions per job, and the second one is the whole reason
 * this is a table rather than a list of paths:
 *
 *   `shared: true`  — safe when more than one peer runs it. Either idempotent,
 *                     or it writes only per-instance state (the oplog, a cache)
 *                     that no other peer can maintain on this peer's behalf.
 *   `shared: false` — EXCLUSIVE. It writes into a shared external system
 *                     (OneDrive, the Graph mailbox, Todoist, the transcription
 *                     provider) or creates items from one, so two peers doing
 *                     it is a conflict rather than a harmless repeat.
 *
 * `on` is the default, and for an exclusive job it no longer means "this peer
 * does it" (ADR-225). It means SCHEDULED: the trigger fires and the endpoint's
 * own ownership gate decides, exactly as ADR-222 does for snapshots. An
 * exclusive job nobody has named stands down on a supervised peer and runs in
 * the cloud, which is what it did before this change — the difference is that
 * naming this machine in Build → Scheduled work is now enough to move it, with
 * no config edit and no restart. That is the whole point: the config file must
 * not be the lever the owner reaches for.
 *
 * The three still `on: false` are the ones the picker refuses to move at all
 * (`movable: false` in src/lib/job-owners.ts). Scheduling a job that can never
 * be named here would fire an endpoint that can only ever stand down.
 */
export const LOCAL_JOBS = {
  purge: {
    path: "/api/machine/purge",
    label: "Trash purge and sync-oplog prune",
    at: "03:10",
    shared: true,
    on: true,
    why:
      "Every peer must run this itself: pruneSyncOps only ever prunes the oplog of " +
      "the instance it runs on. The hard deletes are the same decision from the same " +
      "data on every peer, and deleting an already-deleted row is a no-op.",
  },
  relatedness: {
    path: "/api/machine/relatedness",
    label: "Relatedness cache refresh",
    at: "03:40",
    shared: true,
    on: true,
    why:
      "item_relatedness is a per-instance cache, deliberately outside ADR-206's " +
      "synced-table list, so a local peer's Discover and Loose Ends stay empty until " +
      "it computes its own. Two peers filling their own caches is not a conflict.",
  },
  snapshot: {
    path: "/api/machine/snapshot",
    label: "Local snapshots (restore points)",
    everyMinutes: 60,
    shared: true,
    on: true,
    // A dump of a real database takes longer than an API call; the default
    // 120s ceiling would report a false failure and leave a partial file.
    timeoutMs: 15 * 60_000,
    why:
      "Purely local: it dumps THIS peer's own cluster to THIS peer's own disk, so " +
      "two peers snapshotting is two independent backups rather than a conflict. " +
      "SCHEDULED here, but switched on in the app (ADR-222): the endpoint asks " +
      "`snapshots:enabled` and returns without dumping when the owner has not " +
      "turned restore points on, which is the default. Scheduling it always is " +
      "what lets that switch be a checkbox instead of a config edit and a restart.",
  },
  export: {
    path: "/api/machine/export",
    label: "OneDrive export",
    at: "04:10",
    shared: false,
    on: true,
    why:
      "One OneDrive folder. Two peers writing it would fight over the files and over " +
      "items.exported_at — so the endpoint runs only on the copy named under Scheduled " +
      "work, and stands down everywhere else. Scheduled here always so that naming this " +
      "machine is all it takes (ADR-225).",
  },
  "calendar-sync": {
    path: "/api/machine/calendar-sync",
    label: "Calendar sync",
    everyMinutes: 240,
    shared: false,
    on: true,
    why:
      "Creates items from Graph events. Two peers matching the same event would create " +
      "two rows and sync would propagate both — so the endpoint runs only on the copy " +
      "named under Scheduled work. Scheduled here always (ADR-225).",
  },
  "email-import": {
    path: "/api/machine/email-import",
    label: "Email-in",
    everyMinutes: 240,
    shared: false,
    on: true,
    why:
      "Consumes the mailbox: whichever peer reads a message first is the only one that " +
      "sees it — so the endpoint runs only on the copy named under Scheduled work. " +
      "Scheduled here always (ADR-225).",
  },
  "todoist-sync": {
    path: "/api/machine/todoist-sync",
    label: "Todoist sync",
    everyMinutes: 180,
    shared: false,
    on: false,
    why: "Bidirectional against one Todoist account. Two peers pushing the same tasks is the classic double-write.",
  },
  "transcription-poll": {
    path: "/api/machine/transcription-poll",
    label: "Transcription poll",
    everyMinutes: 15,
    shared: false,
    on: false,
    why: "Claims transcription jobs from the provider; two pollers race for the same job.",
  },
  "youtube-transcript": {
    path: "/api/machine/youtube-transcript",
    label: "Video transcripts",
    everyMinutes: 10,
    shared: false,
    on: true,
    // No custom ceiling needed, and a long one was actively wrong. This
    // endpoint starts the work and answers immediately, because Node destroys
    // any request left open for five minutes: the 30-minute ceiling this once
    // carried could never be reached, and it only meant the scheduler waited
    // five minutes to be told "fetch failed" about work that was going fine
    // (seen on the first real run, 2026-08-31). The default 120s is now
    // generous for a call that returns in under a second.
    why:
      "Writes the transcript into the saved link itself. Two machines transcribing the " +
      "same video would both write the same body and then fight over whose copy wins, so " +
      "the endpoint runs only on the copy named under Scheduled work, and stands down " +
      "everywhere else. Scheduled here always so that naming this machine is all it takes " +
      "(ADR-225).",
  },
  "health-check": {
    path: "/api/machine/health-check",
    label: "Weekly health check",
    at: "07:00",
    shared: false,
    on: false,
    why: "Pushes to the owner's devices. Per-instance push subscriptions a local peer does not have, and it would double the alert where it does.",
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after a failed attempt to try again (never past the next slot). */
export const CRON_RETRY_MS = 10 * 60 * 1000;

/** Grace after boot before an overdue job fires, so the app is up and the
 * first sync exchange is not competing with it. */
export const CRON_STARTUP_GRACE_MS = 3 * 60 * 1000;

/** How stale a successful run may get before the surfaces call it late. */
export const CRON_LATE_MULTIPLE = 3;

/** "HH:MM" to {h, m}, or null. Deliberately strict: a typo must not silently
 * become midnight. */
export function parseDailyAt(raw) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw ?? "").trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/**
 * The next occurrence of a local wall-clock HH:MM strictly after `from` (ms).
 * Local time on purpose — the owner of a machine under their desk thinks
 * "3am", not "08:00Z" — and via setHours/setDate so a DST boundary is the
 * platform's problem rather than ours.
 */
export function nextDailyAt(at, from) {
  const hm = parseDailyAt(at);
  if (!hm) return from + DAY_MS;
  const d = new Date(from);
  d.setHours(hm.h, hm.m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Validate + resolve `config.crons` against the catalog.
 *
 * Shape, one shape only: an object keyed by job name, whose value is
 *   true              — on, with the catalog's own schedule
 *   false             — off
 *   {at}              — on, daily at this local HH:MM
 *   {everyMinutes}    — on, this often
 * An absent key keeps the catalog default. `crons: false` turns every job off
 * (what a dev rig wants). Throws on anything unusable, because a mistyped job
 * name that silently ran nothing is the failure this whole slice exists to
 * prevent.
 *
 * Returns the resolved list the runner works from.
 */
/**
 * The endpoint's own words when a scheduled job stood down, or null when it did
 * the work.
 *
 * Two shapes in the wild and both are honoured: `{skipped: true, detail}` from
 * the ownership gate (ADR-225) and `{skipped: "why"}` from the snapshot switch
 * (ADR-222). Tolerant by design: a non-JSON or unexpected body means "it ran",
 * because inventing a stand-down from a parse failure would hide a real run —
 * the opposite of the failure this whole record exists to prevent.
 */
export function standDownDetailOf(body) {
  if (!body) return null;
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return null; // not JSON; nothing to report
  }
  if (!j || !j.skipped) return null;
  const why =
    typeof j.detail === "string" && j.detail
      ? j.detail
      : typeof j.skipped === "string" && j.skipped
        ? j.skipped
        : "Stood down.";
  // It goes straight into a sentence on the owner's page.
  return why.charAt(0).toUpperCase() + why.slice(1);
}

export function normalizeCrons(raw) {
  if (raw === false) return [];
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("config.crons must be an object keyed by job name, or false");
  }
  const req = raw ?? {};
  for (const name of Object.keys(req)) {
    if (!LOCAL_JOBS[name]) {
      throw new Error(
        `config.crons has no such job "${name}". Known jobs: ${Object.keys(LOCAL_JOBS).join(", ")}`
      );
    }
  }
  const out = [];
  for (const [name, def] of Object.entries(LOCAL_JOBS)) {
    const asked = Object.hasOwn(req, name);
    const v = asked ? req[name] : undefined;
    if (v === false) continue;
    if (asked && v !== true && (typeof v !== "object" || v === null || Array.isArray(v))) {
      throw new Error(`config.crons.${name} must be true, false, or an object with at/everyMinutes`);
    }
    if (!asked && !def.on) continue; // off by default and not asked for
    const o = v && typeof v === "object" ? v : {};

    let intervalMs = null;
    let at = null;
    if (o.everyMinutes !== undefined) {
      const n = Number(o.everyMinutes);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`config.crons.${name}.everyMinutes must be a positive number of minutes`);
      }
      intervalMs = n * 60_000;
    } else if (o.at !== undefined) {
      if (!parseDailyAt(o.at)) {
        throw new Error(
          `config.crons.${name}.at must be a 24-hour "HH:MM", got ${JSON.stringify(o.at)}`
        );
      }
      at = String(o.at).trim();
    } else if (def.everyMinutes) {
      intervalMs = def.everyMinutes * 60_000;
    } else {
      at = def.at;
    }
    out.push({
      name,
      path: def.path,
      label: def.label,
      shared: def.shared === true,
      intervalMs,
      at,
      periodMs: intervalMs ?? DAY_MS,
      // Null = the runner's own default. Only a job that genuinely runs longer
      // than an HTTP call (a pg_dump) sets one.
      timeoutMs: def.timeoutMs ?? null,
    });
  }
  return out;
}

export function cronStatePath(dataDir) {
  return join(dataDir, "cron-state.json");
}

/**
 * When a job should next run. `ok: false` brings it forward to a single soon
 * retry rather than losing a whole day to one bad moment (a run that landed
 * mid-build, say) — but never past the slot it was going to use anyway, so a
 * frequent job cannot be made more frequent by failing.
 */
export function nextRunAt(job, now, ok) {
  const scheduled = job.intervalMs ? now + job.intervalMs : nextDailyAt(job.at, now);
  return ok ? scheduled : Math.min(now + CRON_RETRY_MS, scheduled);
}

/**
 * The due time to adopt at boot for a job we may not have run in a while. A
 * peer that is asleep every night at 03:10 would otherwise never purge, which
 * is exactly the "the oplog never prunes" bug — so anything overdue by more
 * than its own period runs shortly after startup instead of waiting for a slot
 * it keeps missing.
 */
export function initialDueAt(job, lastOkAt, now) {
  const last = lastOkAt ? Date.parse(lastOkAt) : NaN;
  if (!Number.isFinite(last) || now - last > job.periodMs) return now + CRON_STARTUP_GRACE_MS;
  return nextRunAt(job, now, true);
}

/**
 * How a job reads to the owner. "failing" is the last attempt; "late" is a job
 * whose last SUCCESS is older than several periods, which is what a scheduler
 * that quietly stopped firing looks like from the outside.
 */
export function jobStaleness(entry, job, now) {
  if (!entry || (!entry.lastRunAt && !entry.lastOkAt)) return "never";
  if (entry.ok === false) return "failing";
  const lastOk = entry.lastOkAt ? Date.parse(entry.lastOkAt) : NaN;
  if (!Number.isFinite(lastOk)) return "never";
  return now - lastOk > job.periodMs * CRON_LATE_MULTIPLE ? "late" : "ok";
}

/**
 * The record the app and `local:status` read. Same posture as ADR-211's
 * startup-state.json: the supervisor writes what actually happened, including
 * the failures, because a peer that silently stopped exporting is the failure
 * this project keeps trying to make impossible.
 */
export function serializeCronState(jobs, entries, now = Date.now()) {
  return (
    JSON.stringify(
      {
        at: new Date(now).toISOString(),
        jobs: jobs.map((j) => {
          const e = entries[j.name] ?? {};
          return {
            name: j.name,
            label: j.label,
            path: j.path,
            shared: j.shared,
            everyMinutes: j.intervalMs ? Math.round(j.intervalMs / 60_000) : null,
            at: j.at ?? null,
            dueAt: e.dueAt ? new Date(e.dueAt).toISOString() : null,
            lastRunAt: e.lastRunAt ?? null,
            lastOkAt: e.lastOkAt ?? null,
            ok: e.ok ?? null,
            detail: e.detail ?? null,
            runs: e.runs ?? 0,
            fails: e.fails ?? 0,
            state: jobStaleness(e, j, now),
          };
        }),
      },
      null,
      2
    ) + "\n"
  );
}

/** Tolerant read: anything unusable means "no record", never a throw. */
export function parseCronState(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || !Array.isArray(v.jobs)) return null;
    return {
      at: typeof v.at === "string" ? v.at : null,
      jobs: v.jobs.flatMap((j) =>
        j && typeof j.name === "string"
          ? [
              {
                name: j.name,
                label: typeof j.label === "string" ? j.label : j.name,
                path: typeof j.path === "string" ? j.path : "",
                shared: j.shared === true,
                everyMinutes: Number.isFinite(j.everyMinutes) ? j.everyMinutes : null,
                at: typeof j.at === "string" ? j.at : null,
                dueAt: typeof j.dueAt === "string" ? j.dueAt : null,
                lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : null,
                lastOkAt: typeof j.lastOkAt === "string" ? j.lastOkAt : null,
                ok: typeof j.ok === "boolean" ? j.ok : null,
                detail: typeof j.detail === "string" ? j.detail : null,
                runs: Number.isFinite(j.runs) ? j.runs : 0,
                fails: Number.isFinite(j.fails) ? j.fails : 0,
                state: ["ok", "late", "failing", "never"].includes(j.state) ? j.state : "never",
              },
            ]
          : []
      ),
    };
  } catch {
    return null;
  }
}

/**
 * The app-side entry the supervisor adds to LEDGR_API_TOKENS so its own calls
 * walk through the ordinary machine-token door (no bypass, no second auth
 * path). The raw token stays in the supervisor's memory and dies with the
 * process; only this hash reaches the child's env.
 */
export function localCronTokenEntry(hash) {
  return `local-cron:cron:${hash}`;
}

// ── Elevation: ask, rather than give up (ADR-211 follow-up) ──────────────────
//
// The "always" scope (/SC ONSTART) needs Administrator, and the supervisor runs
// unelevated, so schtasks returns access-denied. That used to be the end of it:
// the owner got the command to paste into an Administrator prompt themselves,
// which is a terminal in the middle of a GUI flow.
//
// A background process may not elevate SILENTLY, but it may ASK: ShellExecute's
// "runas" verb (Start-Process -Verb RunAs) raises the ordinary Windows consent
// dialog on the interactive desktop. So on failure we ask, and the owner clicks
// Yes in the same dialog every installer uses.
//
// The schtasks line goes through a temp .cmd file rather than being embedded in
// the PowerShell string. /TR already carries a fully-quoted command line, and
// threading those quotes through Node's argv escaping AND PowerShell's parser
// AND Start-Process's -ArgumentList is three layers of Windows quoting to get
// wrong. A file has no quoting problem at all.

/** ERROR_CANCELLED: the owner dismissed the consent dialog. Not a failure of ours. */
export const ELEVATION_CANCELLED = 1223;

/**
 * Contents of the temp .cmd that the elevated shell runs. Propagates schtasks'
 * exit code so the caller learns whether the task was actually created.
 * @param {string[]} args — the schtasks argv (schtasksCreateArgs/DeleteArgs)
 */
export function elevatedCmdScript(args) {
  return ["@echo off", formatSchtasks(args), "exit /b %ERRORLEVEL%", ""].join("\r\n");
}

/**
 * powershell argv that runs `scriptPath` elevated and exits with its code.
 * Only the path is interpolated, and a dataDir path cannot contain a single
 * quote on Windows (' is legal in a filename, so double it anyway rather than
 * trust that).
 * @param {string} scriptPath
 */
export function elevatedPowershellArgs(scriptPath) {
  const quoted = `'${scriptPath.replaceAll("'", "''")}'`;
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `try { $p = Start-Process -FilePath ${quoted} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit ${ELEVATION_CANCELLED} }`,
  ];
}

// ── Update policy: the GUI-editable half of `config.update` ─────────────────
//
// WHY A FILE, NOT job_state. Snapshots and the sync mode keep their owner
// override in the database because only the app reads them. The update policy
// has two readers that have no database and no login: the supervisor itself
// (whose whole job is to work when the app is down) and the tray icon (which
// exists so the owner can act while sitting at the machine, signed into
// nothing). A JSON file in dataDir, next to the other signal files, is the one
// home all three surfaces can reach. It is per-machine by nature, so it never
// syncs, which is correct.
//
// `config.update` and `config.branch` stay as the INSTALL-TIME SEED (and the
// testing escape hatch): the supervisor writes this file from them on first
// boot when it is missing, then re-reads the file every tick. Editing config
// afterwards changes nothing until the file is deleted (ADR-222: the config
// file is never the owner's lever).

export const UPDATE_POLICY_MODES = ["auto", "manual"];

export function updatePolicyPath(dataDir) {
  return join(dataDir, "update-policy.json");
}

/** Tolerant parse. null when the text is not a policy at all. */
export function parseUpdatePolicy(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  // "prompted" is the old config word for the same thing; read it, never write it.
  const mode = v.mode === "auto" ? "auto" : v.mode === "manual" || v.mode === "prompted" ? "manual" : null;
  if (!mode) return null;
  const every = Number(v.everyMinutes);
  return {
    mode,
    everyMinutes: Number.isFinite(every) && every >= 1 ? Math.round(every) : 15,
    branch: typeof v.branch === "string" && v.branch.trim() ? v.branch.trim() : "main",
    // The git remote URL (what `git remote set-url` takes), or "" for "leave
    // origin alone". Not owner/repo: a non-GitHub host would have neither.
    repo: typeof v.repo === "string" ? v.repo.trim() : "",
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
  };
}

export function serializeUpdatePolicy(p) {
  const norm = parseUpdatePolicy(JSON.stringify({ ...p, mode: p.mode ?? "manual" })) ?? {
    mode: "manual",
    everyMinutes: 15,
    branch: "main",
    repo: "",
  };
  return (
    JSON.stringify(
      {
        mode: norm.mode,
        everyMinutes: norm.everyMinutes,
        branch: norm.branch,
        repo: norm.repo,
        updatedAt: p.updatedAt ?? new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/** The policy a fresh install starts with: what config.json asked for. */
export function policyFromConfig(cfg, originUrl = "") {
  return {
    mode: cfg.update.mode === "auto" ? "auto" : "manual",
    everyMinutes: Math.max(1, Math.round(cfg.update.pollIntervalMs / 60_000)),
    branch: cfg.branch,
    repo: originUrl,
  };
}

/**
 * Pure: is an automatic check due? `lastCheckedAt` is epoch ms of the last
 * fetch this process made (null = never, so the first tick after boot checks).
 */
export function updateCheckDue(policy, lastCheckedAt, now) {
  if (policy.mode !== "auto") return false;
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= policy.everyMinutes * 60_000;
}
