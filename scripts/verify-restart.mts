// Verification for restarting the local service from the GUI (ADR-227).
//
// WHAT HAS TO HOLD, and why each one is here rather than assumed:
//
//   1. The app writes the file the supervisor watches. The two halves live in
//      different languages and different processes; a path that drifts by one
//      character is a button that silently does nothing, which is the worst
//      possible failure for a control whose entire job is confidence.
//   2. The .mjs writer and the .ts reader agree about the state file. Same
//      split, same risk: two hand-written parsers for one format.
//   3. The handoff is actually wired: request -> clean shutdown -> successor,
//      and the successor waits for the outgoing pid before claiming the lock.
//   4. Postgres start retries. A single attempt is what turned one hard kill
//      into a ten-minute outage on 2026-08-26, because Windows had not yet
//      released the old cluster's shared memory.
//   5. Nothing claims a restart succeeded without evidence. "Requested" and
//      "healthy" are different words written by different processes.
//
// Run: npx tsx scripts/verify-restart.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AWAIT_PID_ENV,
  AWAIT_PID_TIMEOUT_MS,
  codeFingerprint,
  parseRestartRequest,
  PG_START_ATTEMPTS,
  pgStartDelayMs,
  restartSignalPath,
  serializeRestartRequest,
  serializeSupervisorState,
  supervisorStatePath,
} from "../supervisor/lib.mjs";
import { parseSupervisorState, RESTART_PHASES } from "@/lib/supervisor-state";
import {
  lastRestartLine,
  LOCAL_SERVICE_UNAVAILABLE,
  serviceLine,
  type LocalServiceReport,
} from "@/lib/local-service";

let checks = 0;
function ok(what: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`  ✓ ${what}`);
}

const report = (over: Partial<LocalServiceReport> = {}): LocalServiceReport => ({
  ...LOCAL_SERVICE_UNAVAILABLE,
  available: true,
  known: true,
  pid: 4242,
  startedAt: "2026-08-26T14:00:00.000Z",
  ...over,
});

// ── 1. The app and the supervisor name the same file ────────────────────────

ok("the app writes exactly the file the supervisor watches", () => {
  const route = readFileSync("src/app/api/local/restart/route.ts", "utf8");
  // The supervisor's path builder is the authority; the route joins the same
  // basename onto the data dir.
  const basename = restartSignalPath("BASE").split(/[\\/]/).pop();
  assert.equal(basename, "restart-requested");
  assert.ok(
    route.includes(`"${basename}"`),
    `the restart route does not write "${basename}" — the button would do nothing`
  );
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  assert.ok(sup.includes("restartSignalPath(cfg.dataDir)"), "the supervisor does not watch for it");
});

ok("the service endpoint reads the file the supervisor writes", () => {
  const basename = supervisorStatePath("BASE").split(/[\\/]/).pop();
  assert.equal(basename, "supervisor-state.json");
  const lib = readFileSync("src/lib/local-service.ts", "utf8");
  assert.ok(lib.includes(`"${basename}"`), "local-service.ts reads a different file");
});

// ── 2. Two implementations, one format ──────────────────────────────────────

ok("the app parses what the supervisor writes, field for field", () => {
  const written = serializeSupervisorState({
    pid: 321,
    startedAt: "2026-08-26T14:00:00.000Z",
    runningCode: "aaaaaaaaaaaa",
    installedCode: "bbbbbbbbbbbb",
    restart: {
      phase: "healthy",
      at: "2026-08-26T14:01:00.000Z",
      reason: "asked from the app",
      detail: null,
      fromPid: 320,
    },
  });
  const read = parseSupervisorState(written);
  assert.deepEqual(read, {
    pid: 321,
    startedAt: "2026-08-26T14:00:00.000Z",
    runningCode: "aaaaaaaaaaaa",
    installedCode: "bbbbbbbbbbbb",
    restart: {
      phase: "healthy",
      at: "2026-08-26T14:01:00.000Z",
      reason: "asked from the app",
      detail: null,
      fromPid: 320,
    },
  });
});

ok("both sides know the same phases", () => {
  // A phase one side can write and the other cannot name would render as
  // nothing at all on the page.
  const fromLib = readFileSync("supervisor/lib.mjs", "utf8");
  for (const phase of RESTART_PHASES) {
    assert.ok(fromLib.includes(`"${phase}"`), `supervisor/lib.mjs does not know phase ${phase}`);
  }
});

ok("a half-written or missing state file reads as no answer, never as fine", () => {
  assert.equal(parseSupervisorState("{"), null);
  assert.equal(parseSupervisorState(""), null);
  assert.equal(parseSupervisorState("null"), null);
  assert.equal(parseSupervisorState("[]"), null);
  // An unrecognized phase is dropped, not guessed at: inventing "failed" would
  // raise an alarm nothing reported.
  const odd = parseSupervisorState(JSON.stringify({ pid: 1, restart: { phase: "wat" } }));
  assert.equal(odd?.restart, null);
});

ok("a restart request always yields a reason, even from junk", () => {
  assert.equal(parseRestartRequest("nonsense").reason, "asked from the app");
  assert.equal(parseRestartRequest("").reason, "asked from the app");
  const round = parseRestartRequest(serializeRestartRequest({ reason: "after an update" }));
  assert.equal(round.reason, "after an update");
});

// ── 3. The handoff is wired, in order ───────────────────────────────────────

ok("a restart request leads to a clean shutdown, not a kill", () => {
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  assert.match(sup, /restartAfterShutdown = true;\s*\n\s*writeSupervisorState/);
  assert.ok(sup.includes('void shutdown("restart-requested")'));
  // The successor is started only AFTER Postgres is confirmed down: two
  // postmasters on one data directory is the failure that took the peer out.
  const pgStopped = sup.indexOf('log("postgres stopped"');
  const spawnCall = sup.indexOf("spawnSuccessor();");
  assert.ok(pgStopped > 0 && spawnCall > pgStopped, "the successor starts before Postgres is down");
});

ok("the successor waits for the outgoing process before taking the lock", () => {
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  const wait = sup.indexOf("waiting for the outgoing supervisor to exit");
  const lock = sup.indexOf("acquireLock();");
  assert.ok(wait > 0, "nothing waits for the outgoing supervisor");
  assert.ok(wait < lock, "the lock is claimed before the old process is gone");
  assert.ok(sup.includes(`process.env[AWAIT_PID_ENV]`), "the pid to await is never read");
  assert.equal(AWAIT_PID_ENV, "LEDGR_SUPERVISOR_AWAIT_PID");
  assert.ok(AWAIT_PID_TIMEOUT_MS >= 30_000, "too little patience for a clean Postgres shutdown");
});

ok("the successor is detached, with its output going somewhere", () => {
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  const fn = sup.slice(sup.indexOf("function spawnSuccessor()"), sup.indexOf("async function shutdown("));
  assert.ok(fn.includes("detached: true"), "a child that dies with its parent is not a restart");
  assert.ok(fn.includes("supervisor.log"), "the successor writes its output nowhere");
  assert.ok(fn.includes("child.unref()"));
});

// ── 4. Postgres start retries ───────────────────────────────────────────────

ok("Postgres start retries, with a widening wait", () => {
  assert.ok(PG_START_ATTEMPTS >= 3, "too few attempts to outlast a lingering cluster");
  const delays = [1, 2, 3, 4].map(pgStartDelayMs);
  assert.equal(delays[0], 0, "the first attempt must not be delayed");
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] > delays[i - 1], "the wait does not widen");
  }
  // Enough total patience for Windows to release a shared-memory segment.
  assert.ok(delays.reduce((a, b) => a + b, 0) >= 10_000);
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  assert.ok(
    sup.includes("postgres start failed; retrying"),
    "the retry loop is not in startPostgres"
  );
  assert.ok(
    sup.includes('writeSupervisorState({ phase: "failed"'),
    "a Postgres that never starts is not recorded, so nothing could report it"
  );
});

// ── 5. Nothing claims success without evidence ──────────────────────────────

ok("the route reports the request, never the outcome", () => {
  const route = readFileSync("src/app/api/local/restart/route.ts", "utf8");
  assert.ok(route.includes("requested: true"), "the route does not report a request");
  assert.ok(!/restarted:\s*true/.test(route), "the route claims a restart it cannot have witnessed");
});

ok("the button proves a restart by a CHANGED pid", () => {
  const btn = readFileSync("src/components/updates/RestartServiceButton.tsx", "utf8");
  assert.ok(
    btn.includes("now.pid !== before"),
    "the button accepts any answer as proof, so a request that was never picked up reads as success"
  );
  assert.ok(btn.includes("setPhase(\"timeout\")"), "a restart that never lands has no ending");
});

ok("a cloud copy has no local service to restart", () => {
  const route = readFileSync("src/app/api/local/restart/route.ts", "utf8");
  assert.ok(
    route.includes("process.env.VERCEL_ENV"),
    "a deployed copy with a stray env var would try to restart something that is not there"
  );
});

// ── The sentences the owner reads ───────────────────────────────────────────

ok("stale code is the one state that asks the owner to act", () => {
  const stale = serviceLine(report({ staleCode: true }));
  assert.match(stale ?? "", /restart/i);
  const fresh = serviceLine(report());
  assert.ok(fresh && !/restart/i.test(fresh), "a healthy service still nags about restarting");
  assert.equal(serviceLine(LOCAL_SERVICE_UNAVAILABLE), null, "a cloud copy is offered a restart");
});

ok("an unknown state says so rather than implying health", () => {
  const line = serviceLine(report({ known: false, pid: null, startedAt: null }));
  assert.ok(line && !/running the code/i.test(line));
});

ok("we only claim stale code when we know both halves", () => {
  // The parse keeps them separate for exactly this reason: one missing
  // fingerprint must read as "no answer", never as "you need to act".
  const partial = parseSupervisorState(
    serializeSupervisorState({ pid: 1, startedAt: null, runningCode: "aaa", installedCode: null, restart: null })
  );
  assert.equal(partial?.installedCode, null);
  assert.equal(
    serviceLine(report({ staleCode: false })),
    "Running the code that is installed."
  );
});

ok("every restart ending has a sentence, and only failure is loud", () => {
  const healthy = lastRestartLine(report({ restart: { phase: "healthy", at: null, reason: null, detail: null, fromPid: 1 } }));
  assert.equal(healthy?.tone, "ok");
  const failed = lastRestartLine(
    report({ restart: { phase: "failed", at: null, reason: null, detail: "Postgres would not start", fromPid: 1 } })
  );
  assert.equal(failed?.tone, "warn");
  assert.match(failed?.text ?? "", /Postgres would not start/);
  // The one that cannot report itself: the outgoing process wrote this and the
  // successor never overwrote it.
  const stuck = lastRestartLine(
    report({ restart: { phase: "handing-off", at: null, reason: null, detail: null, fromPid: 1 } })
  );
  assert.equal(stuck?.tone, "warn");
  assert.match(stuck?.text ?? "", /local:restart/);
  assert.equal(lastRestartLine(report({ restart: null })), null);
});

// ── The fingerprint ─────────────────────────────────────────────────────────

ok("the code fingerprint changes when the code does, and only then", () => {
  const a = codeFingerprint(["one", "two"]);
  assert.equal(a, codeFingerprint(["one", "two"]));
  assert.notEqual(a, codeFingerprint(["one", "two!"]));
  // Order matters: two files swapped is a different program.
  assert.notEqual(a, codeFingerprint(["two", "one"]));
  assert.equal(a.length, 12);
});

ok("the running fingerprint is taken once, the installed one every write", () => {
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  assert.ok(sup.includes("const RUNNING_CODE = installedCodeFingerprint();"));
  // Inside writeSupervisorState, so it re-reads from disk on every write —
  // that is what makes "an update landed under me" appear without a restart.
  const fn = sup.slice(sup.indexOf("function writeSupervisorState("), sup.indexOf("// ── The app child"));
  assert.ok(fn.includes("installedCode: installedCodeFingerprint()"));
  assert.ok(fn.includes("runningCode: RUNNING_CODE"));
});

// ── The CLI twin, and the boot-task caveat it used to get wrong ─────────────

ok("the CLI has a restart verb that waits for the peer to serve", () => {
  const ctl = readFileSync("supervisor/ledgr-ctl.mjs", "utf8");
  assert.ok(ctl.includes("restart: doRestart,"), "no restart verb");
  assert.ok(ctl.includes("waitForServing("), "the CLI reports a restart it did not witness");
  assert.ok(
    ctl.includes("spawnDetachedSupervisor()"),
    "restart cannot start a peer that is currently down"
  );
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["local:restart"], "node supervisor/ledgr-ctl.mjs restart");
});

ok("the boot-task caveat is computed from Windows, not from a stored string", () => {
  // It was printed from startup-state.json — recorded at registration time and
  // never re-checked — so a task later upgraded to run with nobody signed in
  // was still reported as if it could not (live, 2026-08-26).
  const ctl = readFileSync("supervisor/ledgr-ctl.mjs", "utf8");
  assert.ok(ctl.includes("startupCaveat(boot.scope, boot.mode)"), "the caveat is not live");
  assert.ok(ctl.includes("parseSchtasksLogonMode(text)"), "the logon mode is never read");
  const order = ctl.indexOf("const liveCaveat") < ctl.indexOf("recorded?.ok ? recorded.caveat");
  assert.ok(order, "the recorded caveat still wins over the live one");
});

ok("the supervisor runs from its own repo whatever launched it", () => {
  // Task Scheduler registers no working directory, so a boot-started service
  // inherits System32. Nothing depends on cwd today; this keeps it that way by
  // construction rather than by luck.
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  assert.ok(sup.includes("process.chdir(cfg.repoDir)"));
});

ok("'healthy' means the port answered, not merely that a build exists", () => {
  // The first version wrote healthy whenever a build pointer existed, so a peer
  // whose port never opened would have recorded a clean restart — the same
  // half-truth this whole feature exists to delete.
  const sup = readFileSync("supervisor/ledgr-supervisor.mjs", "utf8");
  assert.ok(sup.includes("async function waitForOwnPort()"), "nothing waits for the port");
  const probe = sup.slice(sup.indexOf("async function waitForOwnPort()"));
  assert.ok(probe.includes("cfg.appPort") && probe.includes("fetch("), "the port is never probed");
  assert.ok(probe.includes("nothing answered on port"), "a port that never opens has no sentence");
  // healthy is written only from the probe's result.
  const boot = sup.slice(sup.indexOf("writeSupervisorState(null); //"), sup.indexOf("async function waitForOwnPort()"));
  assert.ok(boot.includes("await waitForOwnPort()"), "healthy is written without waiting");
  assert.ok(
    boot.indexOf("detail === null") < boot.indexOf('phase: "healthy"'),
    "healthy is not conditional on the probe"
  );
});

console.log(`\n${checks} checks passed.`);
