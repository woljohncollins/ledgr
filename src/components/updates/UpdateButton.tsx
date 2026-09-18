"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The one-click half of /build/updates: pull the latest code into this
// instance's repository, then wait for the rebuild to take over.
//
// Waiting is the part worth getting right. Pulling the update finishes in about
// a second, but the instance keeps serving the OLD code for a minute or two
// while Vercel builds. Stopping at "pulled" would leave someone reloading a page
// that still shows the old version and concluding the button did nothing, so
// this polls the status route until the running commit is current and only then
// calls the update done. The poll is served by whichever deploy is live, so the
// answer flipping to "current" IS the new code answering.

type Phase = "idle" | "applying" | "deploying" | "done" | "error";

const POLL_MS = 8000;
const GIVE_UP_MS = 6 * 60 * 1000;

export default function UpdateButton({ count }: { count: number }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelled = useRef(false);

  useEffect(() => {
    // Captured once at mount: the array is only ever pushed to, never
    // reassigned, so this reference stays the same one the cleanup needs.
    const pending = timers.current;
    const flag = cancelled;
    return () => {
      flag.current = true;
      for (const t of pending) clearTimeout(t);
    };
  }, []);

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.current.push(setTimeout(resolve, ms));
    });

  const pollUntilCurrent = useCallback(async () => {
    const deadline = Date.now() + GIVE_UP_MS;
    while (!cancelled.current && Date.now() < deadline) {
      await wait(POLL_MS);
      if (cancelled.current) return;
      try {
        const res = await fetch("/api/updates", { cache: "no-store" });
        if (!res.ok) continue;
        const report = (await res.json()) as { code?: { state?: string } };
        if (report.code?.state === "current") {
          setPhase("done");
          setMessage("This instance is now running the latest version.");
          return;
        }
      } catch {
        // A blip while the deploy swaps over is expected, so keep waiting
        // rather than reporting a failure that isn't one.
      }
    }
    if (cancelled.current) return;
    // The update itself succeeded; only the confirmation timed out.
    setPhase("done");
    setMessage(
      "The update was pulled. The rebuild is taking longer than usual, so reload in a few minutes to confirm."
    );
  }, []);

  const run = useCallback(async () => {
    setPhase("applying");
    setMessage(null);
    try {
      const res = await fetch("/api/updates", { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || !body.ok) {
        setPhase("error");
        setMessage(body.error ?? "The update could not be applied.");
        return;
      }
      setPhase("deploying");
      setMessage(body.message ?? "Update pulled. This instance is rebuilding now.");
      await pollUntilCurrent();
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "The update could not be applied.");
    }
  }, [pollUntilCurrent]);

  if (phase === "done") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-emerald-400">{message}</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-card border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-3"
        >
          Reload
        </button>
      </div>
    );
  }

  const busy = phase === "applying" || phase === "deploying";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-card border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {phase === "applying"
            ? "Pulling the update..."
            : phase === "deploying"
              ? "Rebuilding..."
              : `Update now (${count} change${count === 1 ? "" : "s"})`}
        </button>
        {phase === "deploying" && (
          <span className="ui-meta text-ink-subtle">
            This takes a minute or two. You can leave this page open.
          </span>
        )}
      </div>
      {message && (
        <p className={`text-sm ${phase === "error" ? "text-rose-400" : "text-ink-muted"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
