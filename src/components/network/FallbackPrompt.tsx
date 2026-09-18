"use client";

// The fallback approval block (ADR-210). Every automatic hub has been failing
// for longer than the threshold and an emergency hub is configured, so the
// loop recorded a pending decision and this is where the owner answers it.
//
// It shows evidence before it asks: what each automatic hub actually said, and
// how stale this backup is (when it last exchanged, and how many of this
// instance's own changes it has not received). Both come from per-hub cursors
// and timestamps that already exist — no new protocol.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { relativeTime } from "@/lib/relative-time";
import { CADENCE_CONTINUOUS, cadenceLabel } from "@/lib/sync/client";
import type { FallbackApproval, FallbackPrompt as Prompt } from "@/lib/sync/client";

const button =
  "rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-60";

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

export function FallbackPromptBlock({ prompt }: { prompt: Prompt }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve(promoteCadence: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/fallback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: prompt.url, promoteCadence }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That could not be approved.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-card border border-amber-700/60 bg-amber-950/20 p-4">
      <h3 className="text-sm font-medium text-amber-300">
        Use a backup copy while the others are down?
      </h3>
      <p className="mt-2 text-sm text-ink-muted">
        Every copy this machine normally reads from has been unreachable for{" "}
        {minutes(prompt.failingForMs)}. Your changes are still being kept safely
        on the backup below, but nothing new from your other devices is arriving.
      </p>

      <p className="ui-section-label mt-4">What your usual copies said</p>
      <ul className="mt-1 space-y-1">
        {prompt.automaticErrors.map((e) => (
          <li key={e.url} className="text-sm">
            <span className="font-mono text-xs text-ink">{e.url}</span>
            <span className="ui-meta ml-2 text-amber-400">
              {e.error ?? "no answer yet"}
            </span>
          </li>
        ))}
      </ul>

      <p className="ui-section-label mt-4">The backup on offer</p>
      <p className="mt-1 text-sm">
        <span className="font-mono text-xs text-ink">{prompt.url}</span>
      </p>
      <p className="ui-meta mt-1 text-ink-subtle">
        {prompt.lastSyncAt
          ? `Last exchanged ${relativeTime(prompt.lastSyncAt)}`
          : "Has not exchanged yet this session"}
        {prompt.behindOps !== null && prompt.behindOps > 0
          ? ` · ${prompt.behindOps} of your change${prompt.behindOps === 1 ? "" : "s"} not delivered to it yet`
          : ""}
        {prompt.cadence > CADENCE_CONTINUOUS
          ? `. It is set to check ${cadenceLabel(prompt.cadence).toLowerCase()}, so reading from it can be that far behind your other devices.`
          : ""}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void approve(false)}
        >
          Read from this backup
        </button>
        {prompt.cadence > CADENCE_CONTINUOUS && (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void approve(true)}
          >
            Read from it, and check it continuously
          </button>
        )}
        {error && <span className="ui-meta text-rose-400">{error}</span>}
      </div>
      <p className="ui-meta mt-2 text-ink-subtle">
        This lasts until one of the usual copies is fully caught up again, then it
        clears itself (along with any speed-up). Nothing about your data changes
        either way: newer edits always win over older ones.
      </p>
    </div>
  );
}

export function FallbackApprovalBlock({ approval }: { approval: FallbackApproval }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function clear() {
    setBusy(true);
    await fetch("/api/sync/fallback", { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="mt-3 rounded-card border border-amber-700/60 bg-amber-950/20 p-4">
      <h3 className="text-sm font-medium text-amber-300">Reading from a backup copy</h3>
      <p className="mt-2 text-sm text-ink-muted">
        You approved reading from <span className="font-mono text-xs">{approval.url}</span>{" "}
        {relativeTime(approval.approvedAt)}
        {approval.promoteCadence ? ", and asked for it to be checked continuously" : ""}. This
        clears itself as soon as one of the usual copies is caught up again.
      </p>
      <button
        type="button"
        className={`${button} mt-3`}
        disabled={busy}
        onClick={() => void clear()}
      >
        Stop reading from it now
      </button>
    </div>
  );
}
