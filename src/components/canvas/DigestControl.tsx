"use client";

// The record's "Check-ins" control (Tyler, 2026-08-17): whether this project
// surfaces on Tasks → Today (and pings) when it's gone quiet, and after how
// many days. A muted line beside "Add a Tool" that opens a small popover —
// toggle + days — writing composition.behaviors.digest through the same item
// PATCH the section controls use. Looking at the project resets the clock (the
// view beacon); there is deliberately NO manual check-in button.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_DIGEST, type Composition, type DigestBehavior } from "@/lib/composition";

export default function DigestControl({
  itemId,
  composition,
}: {
  itemId: string;
  composition: Composition;
}) {
  const router = useRouter();
  const current: DigestBehavior = composition.behaviors.digest ?? DEFAULT_DIGEST;
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(current.enabled);
  const [days, setDays] = useState(String(current.stalenessDays));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    const n = Math.min(365, Math.max(1, Math.round(Number(days)) || DEFAULT_DIGEST.stalenessDays));
    const digest: DigestBehavior = { ...current, enabled, stalenessDays: n };
    setSaving(true);
    try {
      const next: Composition = {
        ...composition,
        behaviors: { ...composition.behaviors, digest },
      };
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition: next }),
      });
      if (res.ok) {
        setDays(String(n));
        router.refresh();
      }
    } finally {
      setSaving(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-neutral-600 hover:text-neutral-400"
      >
        Check-ins: {current.enabled ? `after ${current.stalenessDays}d quiet` : "off"}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-6 left-0 z-20 w-64 rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-lg">
            <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-neutral-200">
              Surface when quiet
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="ledgr-check"
              />
            </label>
            <p className="mt-1 text-xs text-neutral-500">
              If this project isn&rsquo;t opened or touched for the window below,
              it shows under &ldquo;Check in&rdquo; on Tasks → Today. Opening it
              resets the clock.
            </p>
            <label className={`mt-3 flex items-center justify-between gap-3 text-sm ${enabled ? "text-neutral-200" : "text-neutral-600"}`}>
              Quiet window (days)
              <input
                type="number"
                min={1}
                max={365}
                value={days}
                disabled={!enabled}
                onChange={(e) => setDays(e.target.value)}
                className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-right text-sm text-neutral-200 outline-none focus:border-neutral-500 disabled:opacity-50"
              />
            </label>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded bg-[var(--accent)] px-3 py-1 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
