"use client";

// "Snapshot now": one restore point, right now, for the moment before something
// risky (a big import, a bulk edit, a migration). The schedule covers the
// ordinary case; this covers the case where you already know.
//
// Synchronous and honest: a real dump takes seconds to a minute, so the button
// says it is working, disables itself, and then reports the file it wrote rather
// than leaving the owner to reload and guess.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { humanBytes } from "@/lib/snapshots-plan";

export default function SnapshotNowButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function take() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/snapshots", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        bytes?: number;
        removed?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "The snapshot could not be taken.");
      const pruned = data.removed?.length ?? 0;
      setDone(
        `Saved a restore point${typeof data.bytes === "number" ? ` (${humanBytes(data.bytes)})` : ""}` +
          `${pruned > 0 ? `, and thinned out ${pruned} older one${pruned === 1 ? "" : "s"}` : ""}.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => void take()}
          className="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
        >
          {busy ? "Taking a snapshot…" : "Snapshot now"}
        </button>
        {busy && (
          <span className="ui-meta text-ink-subtle">
            Copying the whole database. This can take up to a minute.
          </span>
        )}
        {!busy && done && <span className="ui-meta text-emerald-400">{done}</span>}
        {!busy && error && <span className="ui-meta text-rose-400">{error}</span>}
      </div>
      {!busy && !done && !error && (
        <p className="ui-meta mt-1.5 text-ink-faint">
          Worth doing before anything you might want to undo: a large import, a
          bulk edit, a change you are unsure about.
        </p>
      )}
    </div>
  );
}
