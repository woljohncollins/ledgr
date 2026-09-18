"use client";

// The whole snapshot configuration: an on/off switch and one number.
//
// BOTH LIVE HERE AND ONLY HERE (ADR-222). Turning restore points on used to
// mean editing `supervisor/config.json` and restarting a service, which is a
// builder's gesture asked of the person using the product. The supervisor now
// schedules the job unconditionally and the switch is a setting in the
// database, so this checkbox is the feature.
//
// The spread the number buys (dense recent, sparse old) and the disk it costs
// both update as you type, because a bare number would be a blind bet: nobody
// can tell from "30" whether that is a day of history or a month.
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  MAX_KEEP,
  MIN_KEEP,
  describeSpread,
  humanBytes,
} from "@/lib/snapshots-plan";

export default function SnapshotKeep({
  enabled,
  keep,
  perSnapshotBytes,
  measured,
}: {
  /** Whether the hourly snapshot actually does anything on this machine. */
  enabled: boolean;
  keep: number;
  /** Average of the real dumps, or an estimate from the database size. */
  perSnapshotBytes: number | null;
  /** True when perSnapshotBytes is measured rather than estimated. */
  measured: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(String(keep));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = Number(draft);
  const valid = Number.isFinite(n) && n >= MIN_KEEP && n <= MAX_KEEP;
  const dirty = valid && Math.round(n) !== keep;

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/snapshots", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "The setting could not be saved.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () => send({ keep: Math.round(n) });

  return (
    <div>
      {/* The switch. No confirm in either direction: switching off keeps every
          restore point already on disk, so neither way loses anything. */}
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-emerald-500"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void send({ enabled: e.target.checked })}
        />
        <span>
          <span className="block text-sm text-ink">Keep hourly restore points on this machine</span>
          <span className="ui-meta block text-ink-subtle">
            {enabled
              ? "On. Takes effect at the next hourly snapshot."
              : "Off. Nothing is being saved beyond the weekly backup and each item's own history."}
          </span>
        </span>
      </label>

      <div className={`mt-4 flex flex-wrap items-center gap-3 ${enabled ? "" : "opacity-60"}`}>
        <label className="group relative ui-meta cursor-help text-ink-subtle" htmlFor="snapshot-keep">
          <span className="underline decoration-dotted decoration-neutral-600 underline-offset-2">
            Restore points to keep
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-80 rounded-card border border-neutral-700 bg-neutral-900 p-2.5 text-xs font-normal normal-case text-ink-muted opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
          >
            A snapshot is taken every hour, but they are not all kept. Older ones
            are thinned out on a schedule, so this one number buys you many
            recent restore points and a few old ones rather than a fixed number
            of hours.
          </span>
        </label>
        <input
          id="snapshot-keep"
          type="number"
          min={MIN_KEEP}
          max={MAX_KEEP}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-20 rounded-card border border-line-strong bg-surface-2 px-2 py-1 text-sm tabular-nums text-ink"
        />
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={() => void save()}
          className="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="ui-meta text-rose-400">{error}</span>}
      </div>

      {valid ? (
        <>
          <p className="mt-2 text-sm text-ink-muted">{describeSpread(n)}</p>
          {perSnapshotBytes !== null && (
            <p className="ui-meta mt-1 text-ink-subtle">
              About {humanBytes(perSnapshotBytes * Math.round(n))} of disk (
              {humanBytes(perSnapshotBytes)} each,{" "}
              {measured ? "measured from the snapshots you have" : "estimated from the database size"}
              ).
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-amber-400">
          Pick a number between {MIN_KEEP} and {MAX_KEEP}.
        </p>
      )}

      {dirty && (
        <p className="ui-meta mt-2 text-ink-faint">
          {Math.round(n) < keep
            ? "Saving a smaller number deletes the extra restore points at the next hourly snapshot."
            : "Takes effect at the next hourly snapshot."}
        </p>
      )}
    </div>
  );
}
