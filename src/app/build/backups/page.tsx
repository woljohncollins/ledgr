// Backups (Build → SYSTEM): point-in-time recovery on this machine, plus a
// pointer to the weekly database backup and OneDrive export. Split out of
// Updates 2026-09-12 alongside Scheduled Jobs and unchanged Network.
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveOwner } from "@/lib/owner";
import { getUpdateReport } from "@/lib/updates";
import SnapshotKeep from "@/components/updates/SnapshotKeep";
import SnapshotNowButton from "@/components/updates/SnapshotNowButton";
import { databaseBytes, readSnapshotKeep, readSnapshotsEnabled } from "@/lib/snapshot-settings";
import { estimateSnapshotBytes, humanBytes } from "@/lib/snapshots-plan";
import {
  averageSnapshotBytes,
  findPgTool,
  listSnapshots,
  PG_TOOLS_MISSING,
  snapshotsDir,
} from "@/lib/snapshots";
import { readLocalJobsReport, LOCAL_JOBS_UNAVAILABLE } from "@/lib/local-jobs";

export const dynamic = "force-dynamic";

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "info" }) {
  const color =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "bad"
          ? "bg-rose-500"
          : "bg-neutral-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-card border border-line bg-surface-1 p-4">{children}</div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-ink">
      {children}
    </code>
  );
}

/** Coarse relative time, both directions. Good enough for a daily job. */
function when(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "at an unknown time";
  const mins = Math.round(Math.abs(ms) / 60_000);
  const span =
    mins < 1 ? "less than a minute" : mins < 90 ? `${mins} min` : mins < 60 * 36 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return ms < 0 ? `${span} ago` : `in ${span}`;
}

/** A due time already past is "due now", never "next 40 seconds ago". */
function nextRunLine(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  return Number.isFinite(ms) && ms <= 0 ? "Due now." : `Next ${when(iso)}.`;
}

export default async function Backups() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const { instance } = await getUpdateReport();

  // Snapshots (restore points) on this machine. A cloud deployment has no disk
  // and no local cluster to dump, so the whole section renders only on a peer
  // with a supervisor — the same test every other local-only surface uses.
  const localJobs = await readLocalJobsReport(instance.supervisorDir).catch(
    () => LOCAL_JOBS_UNAVAILABLE
  );
  const snapshots = instance.supervisorDir
    ? listSnapshots(snapshotsDir(instance.supervisorDir))
    : [];
  const snapshotJob = localJobs.jobs.find((j) => j.name === "snapshot") ?? null;
  const snapshotKeep = instance.supervisorDir ? await readSnapshotKeep() : 0;
  const snapshotsEnabled = instance.supervisorDir ? await readSnapshotsEnabled() : false;
  const measuredBytes = averageSnapshotBytes(snapshots);
  // Only ask the database its size when there is nothing real to average, and
  // only look for pg_dump when nothing has been dumped — a snapshot on disk is
  // already proof the tools are there.
  const dbBytes =
    instance.supervisorDir && measuredBytes === null ? await databaseBytes() : null;
  const perSnapshotBytes =
    measuredBytes ?? (dbBytes === null ? null : estimateSnapshotBytes(dbBytes));
  const pgToolsMissing = Boolean(
    instance.supervisorDir && snapshots.length === 0 && !(await findPgTool("pg_dump"))
  );
  const snapshotBytes = snapshots.reduce((n, s) => n + s.bytes, 0);

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="ui-title">Backups</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Restore points on this machine, and where the weekly backup and export
        run.
      </p>

      {/* ── Snapshots: point-in-time recovery on this machine ──────────── */}
      {instance.supervisorDir ? (
        <section className="mt-8">
          <h2 className="ui-section-label">Snapshots</h2>
          <Card>
            <p className="text-sm text-ink-muted">
              A snapshot is a complete copy of this machine&rsquo;s database at one
              moment. Keeping a spread of them means a mistake bigger than one
              item&rsquo;s history &mdash; a bad import, a batch delete, a wrong bulk
              edit &mdash; can be answered by looking at how things were an hour
              ago, rather than waiting for the weekly backup.
            </p>

            {/* Switched on here but never scheduled: the local service has not
                restarted since this became a scheduled job (ADR-222), so the
                switch above is set and nothing is calling it. */}
            {snapshotsEnabled && !snapshotJob && (
              <p className="mt-3 flex items-start gap-2 text-sm text-ink">
                <span className="mt-1.5">
                  <StatusDot tone="warn" />
                </span>
                <span>
                  Restore points are switched on, but nothing on this machine is
                  scheduled to take them yet. Restart the local Ledgr service and
                  this will start on the hour.
                </span>
              </p>
            )}

            {pgToolsMissing && (
              <p className="mt-3 flex items-start gap-2 text-sm text-ink">
                <span className="mt-1.5">
                  <StatusDot tone="bad" />
                </span>
                <span>{PG_TOOLS_MISSING}</span>
              </p>
            )}

            <div className="mt-4">
              <SnapshotKeep
                enabled={snapshotsEnabled}
                keep={snapshotKeep}
                perSnapshotBytes={perSnapshotBytes}
                measured={measuredBytes !== null}
              />
            </div>

            <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-[9rem_1fr]">
              <dt className="ui-meta text-ink-subtle">On disk now</dt>
              <dd className="text-sm text-ink">
                {snapshots.length === 0 ? (
                  <span className="text-ink-subtle">None yet</span>
                ) : (
                  <>
                    {snapshots.length} restore point
                    {snapshots.length === 1 ? "" : "s"}, {humanBytes(snapshotBytes)}
                    {/* "oldest" says nothing when it is also the newest. */}
                    {snapshots.length > 1 &&
                      `, oldest ${when(snapshots[snapshots.length - 1].at)}`}
                  </>
                )}
              </dd>

              <dt className="ui-meta text-ink-subtle">Last snapshot</dt>
              <dd className="text-sm text-ink">
                {snapshots.length > 0 ? (
                  when(snapshots[0].at)
                ) : (
                  <span className="text-ink-subtle">Never</span>
                )}
                {snapshotJob?.ok === false && snapshotJob.detail && (
                  <span className="ui-meta ml-2 text-amber-400">
                    Last attempt failed: {snapshotJob.detail}
                  </span>
                )}
              </dd>

              <dt className="ui-meta text-ink-subtle">Next snapshot</dt>
              <dd className="text-sm text-ink">
                {!snapshotsEnabled ? (
                  <span className="text-ink-subtle">Switched off</span>
                ) : snapshotJob?.dueAt ? (
                  nextRunLine(snapshotJob.dueAt)
                ) : (
                  <span className="text-ink-subtle">Not scheduled</span>
                )}
              </dd>
            </dl>

            <SnapshotNowButton disabled={pgToolsMissing} />

            {snapshots.length > 0 && (
              <ul className="mt-4 max-h-72 divide-y divide-line overflow-y-auto border-y border-line">
                {snapshots.map((s) => (
                  <li key={s.name} className="flex items-baseline gap-3 py-1.5">
                    <span className="ui-row min-w-0 flex-1 text-ink">
                      {new Date(s.at).toLocaleString()}
                    </span>
                    <span className="ui-meta shrink-0 text-ink-subtle">{when(s.at)}</span>
                    <span className="ui-meta shrink-0 tabular-nums text-ink-subtle">
                      {humanBytes(s.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="ui-meta mt-3 text-ink-subtle">
              Opening one is read-only, and deliberately never replaces the live
              database: from a terminal on this machine,{" "}
              <Mono>npm run local:snapshot -- browse &lt;time&gt;</Mono> starts a
              throwaway copy on a spare port so you can look through it and copy
              what you need back out.{" "}
              <Mono>npm run local:snapshot -- list</Mono> names them.
            </p>
          </Card>
        </section>
      ) : (
        <section className="mt-8">
          <h2 className="ui-section-label">Snapshots</h2>
          <Card>
            <p className="text-sm text-ink-muted">
              Restore points need a copy of Ledgr running on a machine with its
              own disk. You are looking at the cloud copy, which has neither, so
              there is nothing to show here.
            </p>
          </Card>
        </section>
      )}

      {/* ── Where the weekly backup and export run ──────────────────────── */}
      <section className="mt-8">
        <h2 className="ui-section-label">Weekly backup and export</h2>
        <Card>
          <p className="text-sm text-ink-muted">
            The weekly database backup and the OneDrive export run as scheduled
            jobs, the same as any other job here. Which machine does them is
            chosen on{" "}
            <Link href="/build/jobs#scheduled-work" className="hover:underline">
              Scheduled Jobs
            </Link>
            , not here.
          </p>
        </Card>
      </section>
    </div>
  );
}
