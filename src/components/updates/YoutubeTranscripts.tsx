"use client";

// The switch that turns video transcripts on, and nothing else.
//
// It is the whole feature, the way the restore-points checkbox is (ADR-222):
// the job is scheduled on every machine regardless, and each run reads this
// setting to decide whether it does any work. Nobody edits a config file and
// restarts a service to turn something on.
//
// Only the checkbox is a client island. Whether this machine has the tools and
// how many videos are waiting are read on the server and rendered around this,
// because they are facts about the machine, not things this component can know.
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function YoutubeTranscripts({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same shape as SnapshotKeep: PATCH, then let the server re-render the card
  // so the switch and everything it explains can never disagree.
  async function send(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ youtubeTranscripts: { enabled: next } }),
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

  return (
    <div>
      {/* No confirm either way: switching off leaves every transcript already
          written exactly where it is, so neither direction loses anything. */}
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-emerald-500"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void send(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-ink">Transcribe saved videos</span>
          <span className="ui-meta block text-ink-subtle">
            {enabled
              ? "On. A video you save from now on starts transcribing straight away, and anything already waiting is picked up on the next run."
              : "Off. Videos you save are left exactly as they are."}
          </span>
        </span>
      </label>
      {error && <p className="ui-meta mt-2 text-rose-400">{error}</p>}
    </div>
  );
}
