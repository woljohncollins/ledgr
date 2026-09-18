"use client";

// "Restart the local service" — ADR-227.
//
// The requirement, in Brandon's words: a button he can press and be confident
// it stops, starts and reaches healthy again, whatever the reason. So this does
// not report success when the request is filed. It records which process is
// serving now, asks for the restart, and then polls until a DIFFERENT one
// answers — which is the only evidence that a restart happened at all.
//
// The peer goes away mid-poll, so every failed fetch is expected and means
// "still down", not "error". Only the deadline is a failure, and it says what to
// do next rather than leaving a spinner.
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmButton from "@/components/ui/ConfirmButton";

type Phase = "idle" | "asking" | "waiting" | "back" | "timeout" | "error";

// A restart stops Postgres cleanly and starts it again, and the successor waits
// for the outgoing process to exit first. Two minutes is generous on purpose:
// giving up early on a peer that is coming back is its own false alarm.
const DEADLINE_MS = 120_000;
const POLL_MS = 2000;

async function serviceState(): Promise<{ pid: number | null } | null> {
  try {
    const res = await fetch("/api/local/service", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as { pid: number | null };
  } catch {
    return null; // down, which is expected for most of a restart
  }
}

export default function RestartServiceButton({ staleCode }: { staleCode: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  async function restart() {
    setError(null);
    setPhase("asking");
    const before = (await serviceState())?.pid ?? null;
    try {
      const res = await fetch("/api/local/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "asked from Build → Updates" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "The restart could not be requested.");
      }
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setPhase("waiting");
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const now = await serviceState();
      // A new pid answering is the proof. Equal pids means the request has not
      // been picked up yet (the supervisor polls every couple of seconds), and
      // no answer at all means it is mid-restart.
      if (now && now.pid !== null && now.pid !== before) {
        setPhase("back");
        router.refresh();
        return;
      }
    }
    setPhase("timeout");
  }

  const busy = phase === "asking" || phase === "waiting";

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmButton
          title="Restart this machine's Ledgr service?"
          description={
            staleCode
              ? "This applies the update that has already been installed. Ledgr on this machine is unavailable for about half a minute — including from your phone and from Claude — and comes back on its own."
              : "Ledgr on this machine is unavailable for about half a minute, including from your phone and from Claude, and comes back on its own. Nothing is lost: the database is shut down cleanly and started again."
          }
          confirmLabel="Restart it"
          panelClassName="w-80"
          trigger={<span>{busy ? "Restarting…" : "Restart the local service"}</span>}
          triggerClassName="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-40"
          onConfirm={() => void restart()}
        >
          <ul className="ui-meta list-disc space-y-1 pl-4 text-ink-muted">
            <li>Scheduled work waits; nothing is skipped permanently.</li>
            <li>This page will tell you when it is serving again.</li>
          </ul>
        </ConfirmButton>

        {phase === "asking" && <span className="ui-meta text-ink-subtle">Asking it to stop…</span>}
        {phase === "waiting" && (
          <span className="ui-meta text-ink-subtle">
            Stopping and starting again. This page keeps checking; it is normal for it to be
            unreachable for a moment.
          </span>
        )}
        {phase === "back" && <span className="ui-meta text-emerald-400">Back up and serving.</span>}
        {phase === "error" && error && <span className="ui-meta text-rose-400">{error}</span>}
      </div>

      {phase === "timeout" && (
        <p className="ui-meta mt-1.5 text-amber-400">
          It has not answered for two minutes, so this page cannot tell you it came back. It may
          still be starting. If this machine stays unreachable, run{" "}
          <code className="font-mono">npm run local:restart</code> in a terminal on it — that prints
          exactly where it is stuck.
        </p>
      )}
    </div>
  );
}
