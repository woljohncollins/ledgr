// The supervisor's own state file, parsed — ADR-227.
//
// The twin of `parseSupervisorState` in supervisor/lib.mjs, and deliberately a
// separate implementation rather than an import: the supervisor is plain .mjs
// run by node with no build step, and the app is TypeScript. What keeps them
// honest is `scripts/verify-restart.mts`, which feeds one's output to the other.
//
// Tolerant on purpose. This file is written by a process that may have been
// killed mid-write, and a parse failure must read as "no answer" rather than
// throwing inside a page render.

export const RESTART_PHASES = ["requested", "stopping", "handing-off", "healthy", "failed"] as const;
export type RestartPhase = (typeof RESTART_PHASES)[number];

export type RestartRecord = {
  phase: RestartPhase;
  at: string | null;
  reason: string | null;
  detail: string | null;
  fromPid: number | null;
};

export type SupervisorState = {
  pid: number | null;
  startedAt: string | null;
  /** Fingerprint of the supervisor's source as the RUNNING process read it. */
  runningCode: string | null;
  /** The same fingerprint recomputed from disk, so a landed update shows up. */
  installedCode: string | null;
  restart: RestartRecord | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export function parseSupervisorState(text: string): SupervisorState | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const r = o.restart && typeof o.restart === "object" ? (o.restart as Record<string, unknown>) : null;
  const phase = RESTART_PHASES.includes(r?.phase as RestartPhase) ? (r!.phase as RestartPhase) : null;
  return {
    pid: int(o.pid),
    startedAt: str(o.startedAt),
    runningCode: str(o.runningCode),
    installedCode: str(o.installedCode),
    // A restart block with an unrecognized phase is dropped rather than guessed
    // at: inventing "failed" would raise an alarm nothing reported.
    restart: r && phase
      ? {
          phase,
          at: str(r.at),
          reason: str(r.reason),
          detail: str(r.detail),
          fromPid: int(r.fromPid),
        }
      : null,
  };
}
