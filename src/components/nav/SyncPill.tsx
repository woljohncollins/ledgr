"use client";

// The sync dot in the nav chrome (ADR-206 phase 3). Local peers ONLY: the
// server nav gates the mount on LEDGR_SYNC_HUBS, so the cloud hub and Tyler's
// instance never render this or fetch anything. Green = synced to the primary
// hub, amber = changes waiting or running on a backup hub, red = no hub
// reachable. Detail lives on /build/network (ADR-209); clicking goes there. The
// tooltip is the CSS-hover standard (group-hover, role=tooltip), minus the
// dotted underline that marks text triggers.
import Link from "next/link";
import { useEffect, useState } from "react";
import { relativeTime } from "@/lib/relative-time";
import type { FullSyncStatus } from "@/lib/sync/client";

const POLL_MS = 15000;

export default function SyncPill({
  tooltipSide = "top",
  tooltipAlign = "right",
}: {
  // Where the tooltip opens, so the top bar drops it downward while the
  // bottom pill / rails / mobile bar float it upward.
  tooltipSide?: "top" | "bottom";
  // Which edge it hugs, so a left-docked rail grows it rightward on screen
  // instead of clipping at the viewport edge.
  tooltipAlign?: "left" | "right";
}) {
  const [status, setStatus] = useState<FullSyncStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/sync/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as FullSyncStatus;
        if (alive) setStatus(data);
      } catch {
        // A failed poll keeps the last known state; the next tick retries.
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!status?.enabled) return null;

  const onBackup = status.activeHubIndex > 0;
  // A decision the loop is waiting on (ADR-210) is the same class of thing as
  // a hold: it must not be silent, and the page it links to is where it is
  // answered.
  const needsDecision = !!status.fallbackPrompt;
  // A silent guardrail is not a guardrail: any hold, or a warn-level clock
  // skew even without a hold, keeps the pill off green.
  const amber =
    status.state === "pending" ||
    status.state === "held" ||
    onBackup ||
    status.skewWarn ||
    needsDecision;
  const color = status.state === "offline" ? "bg-rose-500" : amber ? "bg-amber-500" : "bg-emerald-500";

  const hubName = onBackup ? "backup hub" : "primary hub";
  const skewNote = status.skewWarn ? " · clock skew detected" : "";
  const label = needsDecision
    ? `No usual hub has answered for a while. A backup is available — open Network to decide whether to read from it.`
    : status.state === "offline"
      ? `Offline. No hub reachable${status.lastError ? `: ${status.lastError}` : ""}`
      : status.state === "held"
        ? status.holdReason === "first_push_size"
          ? `Push held: ${status.heldOpsCount} pending changes exceed the first-push limit. Pulling continues.`
          : "Push held: this device's clock is too far off the hub's. Pulling continues."
        : status.state === "pending"
          ? `${status.pendingOps} change${status.pendingOps === 1 ? "" : "s"} waiting to sync to the ${hubName}${skewNote}`
          : `Synced to ${hubName}${status.mode === "pull-only" ? " (pull-only)" : ""}${status.lastSyncAt ? ` · ${relativeTime(status.lastSyncAt)}` : ""}${skewNote}`;

  return (
    <Link
      href="/build/network"
      aria-label={`Sync: ${label}`}
      className="group relative flex shrink-0 items-center justify-center rounded-xl p-2 hover:bg-neutral-800/60"
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-20 w-max max-w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs normal-case text-neutral-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 ${
          tooltipAlign === "left" ? "left-0" : "right-0"
        } ${tooltipSide === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"}`}
      >
        {label}
      </span>
    </Link>
  );
}
