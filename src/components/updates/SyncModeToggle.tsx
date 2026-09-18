"use client";

// This instance's own push mode, on /build/updates (ADR-206 addendum 4's
// arming sequence, spoke side). Previously this was LEDGR_SYNC_MODE in the
// supervisor config, which meant editing a JSON file and restarting to arm a
// peer — the hub's own side has had a button all along, so this is the other
// half of the same lever.
//
// Enabling push confirms with its consequences; going back to pull-only does
// not, because putting a safety catch back on should never need a second click.
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmButton from "@/components/ui/ConfirmButton";
import type { SyncMode } from "@/lib/sync/client";

export default function SyncModeToggle({ mode }: { mode: SyncMode }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function set(next: SyncMode) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/mode", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "The mode could not be changed.");
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const button =
    "rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-60";

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      {mode === "pull-only" ? (
        <ConfirmButton
          title="Let this device push to the hub?"
          description="Your edits here start flowing to the hub on the next sync, within seconds. Until now this device could only receive."
          confirmLabel="Allow push"
          panelClassName="w-80"
          trigger={<span>Allow push from this device</span>}
          triggerClassName={button}
          onConfirm={() => set("full")}
        >
          <ul className="ui-meta list-disc space-y-1 pl-4 text-ink-muted">
            <li>
              Conflicts resolve per field by whichever write is newer, so if this
              device&apos;s clock is wrong or its copy is stale, it can overwrite newer
              values on the hub.
            </li>
            <li>
              A losing body is kept in that item&apos;s revisions and flagged. Other
              fields are not recoverable that way.
            </li>
            <li>
              After an update that ran a migration here, check what is pending before
              the next sync: a migration&apos;s own writes count as this device&apos;s
              changes.
            </li>
            <li>
              The hub decides too. If it has not allowed this device to push, its
              pushes are refused there regardless of this setting.
            </li>
          </ul>
        </ConfirmButton>
      ) : (
        <button type="button" className={button} disabled={busy} onClick={() => void set("pull-only").catch((e) => setError(String(e instanceof Error ? e.message : e)))}>
          Stop pushing (pull-only)
        </button>
      )}
      {error && <span className="ui-meta text-rose-400">{error}</span>}
    </div>
  );
}
