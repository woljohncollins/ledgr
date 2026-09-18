// Updates (Build → SYSTEM): is this instance running the latest Ledgr, how
// does it take updates, has its database caught up, and does the local
// service start with the computer?
//
// Two axes, because they fail independently and for different people:
//
//   • CODE — a satellite instance deploys from a fork, so a change someone
//     pushes upstream sits there until the fork is synced. The Update button is
//     that sync, so the person using the instance can take an update without
//     needing a terminal, a GitHub account, or a builder on call.
//   • SCHEMA — there is no migrate-on-deploy, so a push carrying a migration
//     reaches every instance's CODE while each database stays put. That one
//     catches source instances too (the deploy follows main automatically, the
//     database does not), which is the failure COLLAB.md keeps re-learning.
//
// Scheduled jobs, snapshots, and the sync topology moved to their own pages
// (Scheduled Jobs, Backups, Network) 2026-09-12; this page kept the code/schema
// currency check, update policy, and the local service/startup surfaces.
//
// Everything is read server-side; the only client islands are the buttons and
// the update-policy form.
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveOwner } from "@/lib/owner";
import { getUpdateReport } from "@/lib/updates";
import UpdateButton from "@/components/updates/UpdateButton";
import StartupToggle from "@/components/updates/StartupToggle";
import RestartServiceButton from "@/components/updates/RestartServiceButton";
import UpdatePolicyForm from "@/components/updates/UpdatePolicy";
import { readUpdatePolicy } from "@/lib/update-policy";
import {
  lastRestartLine,
  readLocalServiceReport,
  serviceLine,
} from "@/lib/local-service";
import { readStartupReport, STARTUP_UNAVAILABLE } from "@/lib/startup";

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

export default async function Updates() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const { instance, code, schema, canApply, blockedReason } = await getUpdateReport();

  // The same reader the client island polls through /api/startup, so the first
  // paint and every refresh can never disagree about it.
  const startup = await readStartupReport(instance.supervisorDir).catch(
    () => STARTUP_UNAVAILABLE
  );

  const policy = await readUpdatePolicy(instance.supervisorDir);

  const service = await readLocalServiceReport(
    process.env.VERCEL_ENV ? null : (process.env.LEDGR_SUPERVISOR_DIR ?? null)
  );

  const commitUrl =
    instance.sha && instance.deployRepo
      ? `https://github.com/${instance.deployRepo}/commit/${instance.sha}`
      : null;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="ui-title">Updates</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Ledgr is one shared codebase running as separate instances, one per
        person. This page tells you whether yours is running the latest
        version, how it takes updates, whether its database has caught up, and
        whether the local service starts with the computer.
      </p>

      {/* ── This version ─────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="ui-section-label">This instance</h2>
        <Card>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[9rem_1fr]">
            <dt className="ui-meta text-ink-subtle">Version</dt>
            <dd className="text-sm text-ink">
              {instance.shortSha ? (
                commitUrl ? (
                  <a
                    href={commitUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:underline"
                  >
                    {instance.shortSha}
                  </a>
                ) : (
                  <span className="font-mono">{instance.shortSha}</span>
                )
              ) : (
                <span className="text-ink-subtle">
                  Unknown (this looks like local development)
                </span>
              )}
            </dd>

            <dt className="ui-meta text-ink-subtle">Deploys from</dt>
            <dd className="text-sm text-ink">
              {instance.deployRepo ? (
                <a
                  href={`https://github.com/${instance.deployRepo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {instance.deployRepo}
                </a>
              ) : (
                <span className="text-ink-subtle">Not connected to a repository</span>
              )}
              {instance.isSatellite && (
                <span className="ui-meta ml-2 text-ink-subtle">
                  (a copy of {instance.upstreamRepo})
                </span>
              )}
            </dd>

            <dt className="ui-meta text-ink-subtle">Migrations</dt>
            <dd className="text-sm text-ink tabular-nums">{schema.total}</dd>
          </dl>
        </Card>
      </section>

      {/* ── Code ─────────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="ui-section-label">Ledgr version</h2>
        <Card>
          {code.state === "source" && (
            <p className="flex items-start gap-2 text-sm text-ink-muted">
              <span className="mt-1.5">
                <StatusDot tone="ok" />
              </span>
              <span>
                This instance deploys straight from the shared repository, so it
                picks up every change automatically. There is nothing to pull
                here.
              </span>
            </p>
          )}

          {code.state === "not_configured" && (
            <p className="flex items-start gap-2 text-sm text-ink-muted">
              <span className="mt-1.5">
                <StatusDot tone="info" />
              </span>
              <span>
                Not connected to a repository, so this instance cannot tell
                whether a newer version exists. A public repository needs no
                token; check the repository on the update policy below.
              </span>
            </p>
          )}

          {code.state === "unknown" && (
            <p className="flex items-start gap-2 text-sm text-ink-muted">
              <span className="mt-1.5">
                <StatusDot tone="info" />
              </span>
              <span>
                Could not check for updates. {code.detail}
              </span>
            </p>
          )}

          {code.state === "current" && (
            <p className="flex items-start gap-2 text-sm text-ink-muted">
              <span className="mt-1.5">
                <StatusDot tone="ok" />
              </span>
              <span>Up to date. You are running the latest version of Ledgr.</span>
            </p>
          )}

          {code.state === "behind" && (
            <div>
              <p className="flex items-start gap-2 text-sm text-ink">
                <span className="mt-1.5">
                  <StatusDot tone="warn" />
                </span>
                <span>
                  <strong className="font-medium">
                    {code.count} update{code.count === 1 ? "" : "s"} available.
                  </strong>{" "}
                  <span className="text-ink-muted">
                    {code.truncated
                      ? "Showing the most recent changes."
                      : "Here is what changed since your version."}
                  </span>
                </span>
              </p>

              <ul className="mt-3 divide-y divide-line border-y border-line">
                {code.commits.slice(0, 20).map((c) => (
                  <li key={c.sha} className="flex gap-3 py-2">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ui-meta shrink-0 font-mono text-ink-subtle hover:underline"
                    >
                      {c.shortSha}
                    </a>
                    <span className="ui-row min-w-0 flex-1 text-ink">{c.subject}</span>
                    <span className="ui-meta shrink-0 text-ink-subtle">{c.authorName}</span>
                  </li>
                ))}
              </ul>

              {code.touchesSchema && (
                <p className="mt-3 text-sm text-amber-400">
                  This update changes the database structure, so the database has
                  to be migrated as part of applying it.
                </p>
              )}

              <div className="mt-4">
                {canApply ? (
                  <UpdateButton count={code.count} />
                ) : (
                  <p className="text-sm text-ink-muted">
                    {blockedReason ?? "Updating is not available on this instance."}{" "}
                    {instance.isSatellite && instance.selfUpdate === "off" && (
                      <>
                        Ask whoever set this up to run the update, or turn on{" "}
                        <Mono>LEDGR_SELF_UPDATE</Mono> to allow it from here.
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* ── Update policy: how this machine takes new versions ──────────── */}
      {instance.supervisorDir && (
        <section className="mt-8" id="update-policy">
          <h2 className="ui-section-label">Update policy</h2>
          <Card>
            <p className="text-sm text-ink-muted">
              How this machine takes new versions: check on its own every so
              often, or only when you press Update now. Which branch and
              repository it follows is set here too. Changes take effect within
              a minute, with no restart.
            </p>
            <div className="mt-3">
              <UpdatePolicyForm initial={policy} />
            </div>
          </Card>
        </section>
      )}

      {/* ── Schema ───────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="ui-section-label">Database</h2>
        <Card>
          {schema.state === "current" && (
            <p className="flex items-start gap-2 text-sm text-ink-muted">
              <span className="mt-1.5">
                <StatusDot tone="ok" />
              </span>
              <span>
                In step with the code. All {schema.total} database changes have
                been applied.
              </span>
            </p>
          )}

          {schema.state === "pending" && (
            <div>
              <p className="flex items-start gap-2 text-sm text-ink">
                <span className="mt-1.5">
                  <StatusDot tone="warn" />
                </span>
                <span>
                  <strong className="font-medium">
                    {schema.pending.length} database change
                    {schema.pending.length === 1 ? "" : "s"} not yet applied.
                  </strong>{" "}
                  <span className="text-ink-muted">
                    This instance is running code that expects a newer database
                    than it has, which is the usual cause of pages failing right
                    after an update.
                  </span>
                </span>
              </p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {schema.pending.map((tag) => (
                  <li key={tag}>
                    <Mono>{tag}</Mono>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-ink-muted">
                Fix it by running <Mono>npm run db:migrate</Mono> against this
                instance&apos;s database.
              </p>
            </div>
          )}

          {schema.state === "empty" && (
            <p className="flex items-start gap-2 text-sm text-ink">
              <span className="mt-1.5">
                <StatusDot tone="warn" />
              </span>
              <span>
                This database has never been set up. Run{" "}
                <Mono>npm run instance:new</Mono> against it before using this
                instance.
              </span>
            </p>
          )}

          {schema.state === "unknown" && (
            <p className="flex items-start gap-2 text-sm text-ink-muted">
              <span className="mt-1.5">
                <StatusDot tone="info" />
              </span>
              <span>Could not read the database migration state. {schema.detail}</span>
            </p>
          )}
        </Card>
      </section>

      {/* ── This device: does it come back after a reboot? (ADR-211) ───── */}
      {startup.available && (
        <section className="mt-8">
          <h2 className="ui-section-label">Start with the computer</h2>
          <Card>
            <p className="text-sm text-ink-muted">
              Ledgr runs on this machine as a local service. Unless it starts on
              its own, a reboot leaves it down until someone starts it by hand —
              and anything pointed at it (your phone, Claude, your other devices)
              stays down with it.
            </p>
            <div className="mt-3">
              <StartupToggle initial={startup} />
            </div>
            <p className="ui-meta mt-3 text-ink-subtle">
              From a terminal on this machine: <Mono>npm run local:status</Mono>{" "}
              answers &ldquo;is it running?&rdquo;, <Mono>npm run local:stop</Mono>{" "}
              stops it cleanly, and <Mono>npm run local:startup</Mono> shows or
              changes this same setting.
            </p>
          </Card>
        </section>
      )}

      {/* ── The local service itself (ADR-227) ──────────────────────────── */}
      {service.available && (
        <section className="mt-8" id="local-service">
          <h2 className="ui-section-label">This machine&rsquo;s Ledgr service</h2>
          <Card>
            <p className="text-sm text-ink-muted">
              The service is what keeps Ledgr running on this machine: it holds the
              database, serves the app, and triggers the scheduled work below. It
              starts itself with the computer, so most of the time there is nothing
              to do here.
            </p>
            {(() => {
              const line = serviceLine(service);
              const last = lastRestartLine(service);
              return (
                <>
                  {line && (
                    <p className="mt-3 flex items-start gap-2 text-sm text-ink">
                      <span className="mt-1.5">
                        <StatusDot tone={service.staleCode ? "warn" : service.known ? "ok" : "info"} />
                      </span>
                      <span>{line}</span>
                    </p>
                  )}
                  {service.startedAt && (
                    <p className="ui-meta mt-1 text-ink-subtle">
                      Started {when(service.startedAt)}
                      {service.pid ? ` (process ${service.pid})` : ""}.
                    </p>
                  )}
                  {last && (
                    <p
                      className={`ui-meta mt-1 ${last.tone === "warn" ? "text-amber-400" : "text-ink-subtle"}`}
                    >
                      {last.text}
                    </p>
                  )}
                  <RestartServiceButton staleCode={service.staleCode} />
                  <p className="ui-meta mt-3 text-ink-subtle">
                    An update to Ledgr itself is applied here without a restart. A
                    restart is only needed when the update changes the service &mdash;
                    which is when this page says so, rather than leaving you to guess.
                  </p>
                </>
              );
            })()}
          </Card>
        </section>
      )}

      {/* ── Where the rest of this page moved ───────────────────────────── */}
      <section className="mt-8">
        <h2 className="ui-section-label">Moved</h2>
        <Card>
          <p className="text-sm text-ink-muted">
            Scheduled jobs and video transcripts are now on{" "}
            <Link href="/build/jobs" className="text-ink hover:underline">
              Scheduled Jobs
            </Link>
            . Snapshots are on{" "}
            <Link href="/build/backups" className="text-ink hover:underline">
              Backups
            </Link>
            . The sync topology — the hubs this instance syncs to and the
            devices that sync from it — is on{" "}
            <Link href="/build/network" className="text-ink hover:underline">
              Network
            </Link>
            .
          </p>
        </Card>
      </section>

      <p className="mt-8 text-sm text-ink-muted">
        Looking for what actually changed in each release? The{" "}
        <Link href="/changelog" className="hover:underline">
          Changelog
        </Link>{" "}
        has the full history.
      </p>
    </div>
  );
}
