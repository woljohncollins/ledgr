// Local scheduled jobs, the read side (ADR-214).
//
// A local peer has no external scheduler: the Vercel crons and GitHub Actions
// workflows only ever point at the cloud deployment. So the supervisor triggers
// the same authenticated /api/machine/* endpoints itself and records every run
// in <supervisorDir>/cron-state.json. This reads that record.
//
// Same shape and same reasoning as src/lib/startup.ts: the app cannot do the
// work, so the supervisor does it and writes down what happened — including the
// failures, because a peer that quietly stopped exporting is precisely the
// failure this is here to prevent.
export type LocalJobState = "ok" | "late" | "failing" | "never";

export type LocalJob = {
  name: string;
  label: string;
  path: string;
  // False = EXCLUSIVE: it writes into a shared external system (OneDrive, the
  // mailbox, Todoist), so exactly one peer should be running it.
  shared: boolean;
  everyMinutes: number | null;
  at: string | null;
  dueAt: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  ok: boolean | null;
  detail: string | null;
  runs: number;
  fails: number;
  state: LocalJobState;
};

export type LocalJobsReport = {
  // False on any instance without a supervisor (every cloud deploy, where the
  // platform cron and GitHub Actions are the scheduler). Keeps this
  // fail-closed rather than implying a local peer that isn't one.
  available: boolean;
  // When the supervisor last wrote the record. Null when it never has.
  at: string | null;
  jobs: LocalJob[];
};

export const LOCAL_JOBS_UNAVAILABLE: LocalJobsReport = {
  available: false,
  at: null,
  jobs: [],
};

/** Worst state present, for a one-line summary. */
export function worstJobState(jobs: LocalJob[]): LocalJobState | null {
  const order: LocalJobState[] = ["failing", "late", "never", "ok"];
  for (const s of order) if (jobs.some((j) => j.state === s)) return s;
  return null;
}

/** How often a job runs, in words. */
export function jobCadence(job: LocalJob): string {
  if (job.at) return `daily at ${job.at}`;
  if (!job.everyMinutes) return "on its own schedule";
  if (job.everyMinutes % 60 === 0) {
    const h = job.everyMinutes / 60;
    return h === 1 ? "hourly" : `every ${h} hours`;
  }
  return `every ${job.everyMinutes} min`;
}

export async function readLocalJobsReport(dir: string | null): Promise<LocalJobsReport> {
  if (!dir) return LOCAL_JOBS_UNAVAILABLE;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let at: string | null = null;
  let jobs: LocalJob[] = [];
  try {
    const raw = JSON.parse(await readFile(join(dir, "cron-state.json"), "utf8")) as {
      at?: unknown;
      jobs?: unknown;
    };
    at = typeof raw.at === "string" ? raw.at : null;
    if (Array.isArray(raw.jobs)) {
      jobs = raw.jobs.flatMap((entry) => {
        const j = (entry ?? {}) as Record<string, unknown>;
        if (typeof j.name !== "string" || !j.name) return [];
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        return [
          {
            name: j.name,
            label: str(j.label) ?? j.name,
            path: str(j.path) ?? "",
            shared: j.shared === true,
            everyMinutes: num(j.everyMinutes),
            at: str(j.at),
            dueAt: str(j.dueAt),
            lastRunAt: str(j.lastRunAt),
            lastOkAt: str(j.lastOkAt),
            ok: typeof j.ok === "boolean" ? j.ok : null,
            detail: str(j.detail),
            runs: num(j.runs) ?? 0,
            fails: num(j.fails) ?? 0,
            state: (["ok", "late", "failing", "never"] as const).includes(
              j.state as LocalJobState
            )
              ? (j.state as LocalJobState)
              : "never",
          },
        ];
      });
    }
  } catch {
    // No file yet (a supervisor from before this shipped, or one that has not
    // written its first record): available, nothing recorded. That is a real
    // answer and the surfaces say so.
  }
  return { available: true, at, jobs };
}
