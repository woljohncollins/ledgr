// Build → Types → edit: the "Offer as a tool" panel (2026-08-17). Flipping it
// on puts this type in every widget-home record's "Add a Tool" menu as its own
// collection card — a "Chapter" type becomes a Chapters card on a Book project,
// with a typed "+ Add chapter". Saves to users.settings.toolTypes via PATCH
// /api/types/[key]/tool (the TocSettingsEditor posture: owner UI prefs, no
// schema change). Flipping it OFF un-offers the type from the menu; records
// already carrying the card keep it (hide from the record's gear to remove).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ToolTypeToggle({
  typeKey,
  typeLabel,
  initial,
}: {
  typeKey: string;
  typeLabel: string;
  initial: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    setEnabled(next); // optimistic; revert on failure
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/types/${typeKey}/tool`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Save failed (${res.status})`);
        setEnabled(!next);
        return;
      }
      router.refresh();
    } catch {
      setError("Save failed");
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-neutral-800 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-300">
            Offer as a tool
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Put &ldquo;{typeLabel}&rdquo; in the &ldquo;Add a Tool&rdquo; menu on projects and
            other tool-composed pages, as its own card with a typed &ldquo;+
            Add&rdquo;. Turning it off removes it from the menu; pages already
            carrying the card keep it until removed there.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Offer ${typeLabel} as a tool`}
          disabled={saving}
          onClick={() => void toggle()}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            enabled ? "bg-[var(--accent)]" : "bg-neutral-700"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
