// Asking the operating system what a process actually IS, not just whether
// something answers to its number.
//
// Why this file exists (2026-08-27): the peer did not come back from a reboot,
// and the reason was that a process id is not an identity. The supervisor's
// lock named pid 4080; the supervisor was long dead; Windows had reissued 4080
// to an unrelated process; and every check we had — the supervisor's own lock
// check, `local:status`, `local:restart` — asked only "does 4080 exist?" and so
// reported a healthy peer that was not running and refused to start one.
// Postgres had failed the same way minutes earlier, refusing to start because
// its leftover postmaster.pid named a pid that had likewise been reissued.
//
// Pid reuse is not rare on Windows and it is worst exactly when it hurts most:
// right after a boot, when low numbers are being handed out fast and the stale
// files are freshest. So the rule here is that a pid is only evidence, and the
// answer to "is this MY process" comes from the command line or the image name.
//
// Kept out of lib.mjs on purpose: that file is pure and imported by the
// verification suite. The decisions these answers feed are pure and live there;
// only the asking lives here.
import { spawnSync } from "node:child_process";
import { connect } from "node:net";

const isWin = process.platform === "win32";

/** Does a process with this number exist at all? Cheap; safe in a poll loop. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else: alive for our
    // purposes. ESRCH is the only "gone".
    return err?.code === "EPERM";
  }
}

/**
 * The process's executable name, lowercased ("postgres.exe"), or null when we
 * cannot tell. Cheaper than the full command line — no PowerShell — so this is
 * what the Postgres check uses.
 */
export function processImageName(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const res = isWin
    ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
    : spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const out = (res.stdout ?? "").trim();
  if (!out) return null;
  if (!isWin) return out.toLowerCase();
  // tasklist prints an INFO line rather than failing when nothing matches.
  if (out.startsWith("INFO:")) return null;
  const m = /^"([^"]*)"/.exec(out);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The process's full command line, or null when we cannot read it. Costs a
 * PowerShell start (~half a second), so call it where identity decides
 * something — never in a wait loop.
 */
export function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const res = isWin
    ? spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8" }
      )
    : spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const out = (res.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

/**
 * Is anything accepting connections on this local port? The corroborating
 * signal for the case where a pid is alive but unreadable: a supervisor that is
 * genuinely running has a Postgres listening, and a stale lock does not.
 */
export function portListening(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) return resolve(false);
    const sock = connect({ host: "127.0.0.1", port });
    const done = (answer) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(answer);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}
