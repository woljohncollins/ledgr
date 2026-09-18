// Changelog: a shared, live view of what's been pushed to the repo, so Brandon
// and Tyler can see what each other shipped (the two deploys are separate, so
// git is the shared medium — see src/lib/github/client.ts). The canvas splits in
// half: the commit list on the left (each entry hides its file/line counts and
// sha behind a "Details" toggle), the shared collab notes scratchpad on the
// right (both builders can read, write, and clear it).
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveOwner } from "@/lib/owner";
import { getChangelog, getGithubConfig, GithubError, type ChangelogEntry } from "@/lib/github/client";
import { DEFAULT_TIMEZONE } from "@/lib/today";
import { getSettings, effectiveDisplayName } from "@/lib/settings";
import CollabNotes from "@/components/changelog/CollabNotes";
import V1Progress from "@/components/changelog/V1Progress";

export const dynamic = "force-dynamic";

// Commit dates are real instants, so they render in the owner's timezone. Built
// per-zone (memoized) and threaded from the page render (resolved from settings).
type DayFmts = { dayKey: Intl.DateTimeFormat; dayLabel: Intl.DateTimeFormat; time: Intl.DateTimeFormat };
const fmtCache = new Map<string, DayFmts>();
function dayFmts(tz: string): DayFmts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = {
      dayKey: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
      dayLabel: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }),
      time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
    };
    fmtCache.set(tz, f);
  }
  return f;
}

function groupByDay(entries: ChangelogEntry[], fmts: DayFmts): { key: string; label: string; entries: ChangelogEntry[] }[] {
  const groups: { key: string; label: string; entries: ChangelogEntry[] }[] = [];
  for (const entry of entries) {
    const d = entry.date ? new Date(entry.date) : null;
    const key = d ? fmts.dayKey.format(d) : "unknown";
    const label = d ? fmts.dayLabel.format(d) : "Unknown date";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, label, entries: [entry] });
  }
  return groups;
}

function StatBadge({ value, kind }: { value: number; kind: "files" | "add" | "del" }) {
  if (value <= 0) return null;
  const text = kind === "files" ? `${value} file${value === 1 ? "" : "s"}` : kind === "add" ? `+${value}` : `−${value}`;
  const color = kind === "add" ? "text-emerald-400" : kind === "del" ? "text-rose-400" : "text-neutral-400";
  return <span className={`tabular-nums ${color}`}>{text}</span>;
}

function CommitRow({ entry, timeFmt }: { entry: ChangelogEntry; timeFmt: Intl.DateTimeFormat }) {
  return (
    <li className="flex gap-3 py-3">
      {entry.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.avatarUrl} alt="" width={28} height={28} className="mt-0.5 h-7 w-7 shrink-0 rounded-full" />
      ) : (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs text-neutral-400">
          {entry.authorName.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-100">{entry.subject}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-500">
          <span className="text-neutral-400">{entry.authorName}</span>
          <span>{entry.date ? timeFmt.format(new Date(entry.date)) : ""}</span>
        </div>
        {/* Fine details tucked behind a click — native <details>, no client JS. */}
        <details className="group mt-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-neutral-600 hover:text-neutral-400 [&::-webkit-details-marker]:hidden">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90">
              <path d="m9 6 6 6-6 6" />
            </svg>
            Details
          </summary>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-500">
            <StatBadge value={entry.filesChanged} kind="files" />
            <StatBadge value={entry.additions} kind="add" />
            <StatBadge value={entry.deletions} kind="del" />
            <a href={entry.url} target="_blank" rel="noreferrer" className="font-mono text-neutral-600 hover:text-[var(--accent)]">
              {entry.shortSha}
            </a>
          </div>
          {entry.body && <p className="mt-1.5 whitespace-pre-wrap text-xs text-neutral-500">{entry.body}</p>}
        </details>
      </div>
    </li>
  );
}

function NotConfigured() {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6 text-sm text-neutral-400">
      <p className="text-neutral-200">The Changelog isn&apos;t connected yet.</p>
      <p className="mt-2">
        It reads the repo&apos;s commit history live. Set <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">GITHUB_TOKEN</code> (and
        optionally <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">GITHUB_REPO</code>) in your environment, then redeploy. Setup
        steps are in <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">runbook.md</code>.
      </p>
    </div>
  );
}

export default async function ChangelogPage() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const settings = await getSettings(owner.id);
  const authorName = effectiveDisplayName(settings, owner.email);
  const fmts = dayFmts(settings.timezone ?? DEFAULT_TIMEZONE);
  // Reads need no token (public repo), so this is only false if the env is
  // deliberately emptied; the NotConfigured card stays for that case.
  const configured = getGithubConfig() !== null;
  let entries: ChangelogEntry[] = [];
  let loadError: string | null = null;
  if (configured) {
    try {
      entries = await getChangelog(25);
    } catch (err) {
      loadError = err instanceof GithubError ? err.message : "Could not load commit history.";
    }
  }
  const groups = groupByDay(entries, fmts);

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-6xl px-6 py-10 sm:px-10">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-neutral-100">Changelog</h1>
            <p className="mt-1 text-sm text-neutral-500">What&apos;s been pushed, and notes between the two of us.</p>
          </div>
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
            ← Back
          </Link>
        </div>

        <V1Progress />

        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
          {/* 1/2 — the commit history */}
          <section>
            {!configured ? (
              <NotConfigured />
            ) : loadError ? (
              <div className="rounded-lg border border-rose-900/50 bg-rose-950/20 p-4 text-sm text-rose-300">{loadError}</div>
            ) : entries.length === 0 ? (
              <p className="text-sm text-neutral-500">No commits found.</p>
            ) : (
              <div className="space-y-6">
                {groups.map((group) => (
                  <div key={group.key}>
                    <h2 className="sticky top-0 z-10 -mx-2 bg-[var(--background,#0a0a0a)]/80 px-2 py-1 text-xs font-medium uppercase tracking-wide text-neutral-500 backdrop-blur">
                      {group.label}
                      <span className="ml-2 normal-case text-neutral-600">
                        {group.entries.length} change{group.entries.length === 1 ? "" : "s"}
                      </span>
                    </h2>
                    <ul className="divide-y divide-neutral-800/60">
                      {group.entries.map((entry) => (
                        <CommitRow key={entry.sha} entry={entry} timeFmt={fmts.time} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 1/2 — the shared notes scratchpad */}
          <aside>
            <CollabNotes configured={configured} authorName={authorName} />
          </aside>
        </div>
      </div>
    </main>
  );
}
