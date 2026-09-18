// The local service (the supervisor), as the app can see it — ADR-227.
//
// WHY THIS EXISTS. The supervisor owns the app process, so the app can neither
// restart it nor inspect it directly: asking your own parent to die leaves
// nobody to start you again. What the app CAN do is read what the supervisor
// wrote down and ask for a restart through a file, which is the same seam
// `stop-requested` and `startup-requested` already use (ADR-211).
//
// What the owner gets out of it, which is the whole point (Brandon,
// 2026-08-26 — "the GUI should handle 99% of tasks on a Ledgr install"): a
// Restart button, and an honest answer about whether the service is running the
// code that is installed. Every supervisor-side change used to end in "now go
// restart the local service", typed into a terminal.
//
// Same posture as local-jobs.ts: fail closed. No record means "no answer",
// never "fine".
import { parseSupervisorState, type SupervisorState } from "@/lib/supervisor-state";

export type LocalServiceReport = {
  /** False on any instance without a supervisor — every cloud deploy. */
  available: boolean;
  /** True when a state file exists at all (an older supervisor writes none). */
  known: boolean;
  pid: number | null;
  startedAt: string | null;
  /**
   * The service is running code older than what is on disk. THE case the
   * owner has to act on, and the one nothing used to tell them: an update can
   * change the supervisor's own file (the job catalog, the schedule, its update
   * logic) and a running process holds the version it started with.
   */
  staleCode: boolean;
  restart: SupervisorState["restart"];
};

export const LOCAL_SERVICE_UNAVAILABLE: LocalServiceReport = {
  available: false,
  known: false,
  pid: null,
  startedAt: null,
  staleCode: false,
  restart: null,
};

/** One sentence about the service itself, or null when there is nothing to say. */
export function serviceLine(r: LocalServiceReport): string | null {
  if (!r.available) return null;
  if (!r.known) {
    return "This machine's service has not said anything about itself yet. It reports in once it has been restarted on a build that knows how.";
  }
  if (r.staleCode) {
    return "An update has arrived that this service predates, so part of it is not in effect yet. Restarting applies it.";
  }
  return "Running the code that is installed.";
}

/**
 * What the LAST restart did, said plainly, or null when none is on record.
 *
 * A phase left mid-flight is the one that matters: the process that would have
 * reported "the replacement never came up" is the process that went away, so
 * the leftover phase is the only evidence.
 */
export function lastRestartLine(r: LocalServiceReport): { text: string; tone: "ok" | "warn" } | null {
  const x = r.restart;
  if (!x) return null;
  switch (x.phase) {
    case "healthy":
      return { text: "The last restart came back healthy.", tone: "ok" };
    case "failed":
      return {
        text: x.detail
          ? `The last restart did not finish: ${x.detail}`
          : "The last restart did not finish, and no reason was recorded.",
        tone: "warn",
      };
    default:
      return {
        text: `A restart was left part-way through (${x.phase}). If this machine is working, it recovered on its own; if not, start it from a terminal with npm run local:restart.`,
        tone: "warn",
      };
  }
}

/** Read the supervisor's own record. `dir` is LEDGR_SUPERVISOR_DIR. */
export async function readLocalServiceReport(dir: string | null): Promise<LocalServiceReport> {
  if (!dir) return LOCAL_SERVICE_UNAVAILABLE;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let state: SupervisorState | null = null;
  try {
    state = parseSupervisorState(await readFile(join(dir, "supervisor-state.json"), "utf8"));
  } catch {
    // No file yet: a supervisor from before this shipped, or one that has not
    // written its first record. Available, nothing known.
  }
  if (!state) return { ...LOCAL_SERVICE_UNAVAILABLE, available: true };
  return {
    available: true,
    known: true,
    pid: state.pid,
    startedAt: state.startedAt,
    // Both halves have to be present to claim a difference. Missing either is
    // "we do not know", which must never render as "you need to act".
    staleCode:
      !!state.runningCode && !!state.installedCode && state.runningCode !== state.installedCode,
    restart: state.restart,
  };
}
