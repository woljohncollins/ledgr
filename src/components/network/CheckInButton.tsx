"use client";

// "Check in now": one immediate exchange with every hub, cadence ignored.
//
// The button exists because a cadence the owner chose for cost was also, until
// now, the only speed available: a change made on another copy could not be
// fetched early, and a change made HERE could not be sent early either. Both are
// one click now.
//
// It reports the wait honestly rather than pretending the click did the work:
// the request only arms the loop, which picks it up on its next tick, so the
// button waits a beat and then reloads the page's own reading of when this copy
// last exchanged.
import { useState } from "react";
import { useRouter } from "next/navigation";

// The loop ticks on the push debounce (2s by default), so this is one tick plus
// room for the exchange itself.
// ponytail: a fixed wait, not a poll. If a slow hub ever makes this feel like a
// lie, poll /api/sync/status until lastSyncAt moves.
const SETTLE_MS = 3500;

export default function CheckInButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  async function checkIn() {
    setError(null);
    setState("busy");
    try {
      const res = await fetch("/api/sync/check-in", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That could not be started.");
      }
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState("idle");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
        disabled={state === "busy"}
        onClick={() => void checkIn()}
      >
        {state === "busy" ? "Checking in…" : "Check in now"}
      </button>
      {error && <span className="ui-meta text-rose-400">{error}</span>}
    </span>
  );
}
