// "+ Add a Tool" (Tyler, 2026-07-01; renamed from "Add section" 2026-08-17 —
// the sections ARE the project's tools). A large button below the project's
// card grid; clicking it lists the tools not already on the page (Overview,
// Recent Activity, Timeline, plus any default card that was removed) and adds
// the chosen one as a new card. Adding appends a visible widget to the
// record's composition and PATCHes it — the same hide-not-delete substrate the
// gear used, just additive and in place. When everything is already on the
// page it says so instead of vanishing, so the affordance stays discoverable.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Composition } from "@/lib/composition";

export default function AddSectionButton({
  itemId,
  composition,
  addable,
}: {
  itemId: string;
  composition: Composition;
  // Sections not currently present, in menu order.
  addable: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add(defId: string) {
    if (busy) return;
    setBusy(true);
    const next: Composition = {
      ...composition,
      widgets: [...composition.widgets, { instanceId: defId, defId }],
    };
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition: next }),
      });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (addable.length === 0) {
    return (
      <p className="mt-3 py-2 text-center text-xs text-neutral-600">All tools already added.</p>
    );
  }

  return (
    <div className="mt-3">
      {open ? (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-2">
          <p className="px-1 pb-1.5 text-xs uppercase tracking-wide text-neutral-500">Add a Tool</p>
          <div className="flex flex-wrap gap-1.5">
            {addable.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={busy}
                onClick={() => void add(a.id)}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800/60 disabled:opacity-50"
              >
                + {a.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-800 py-3 text-sm text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
        >
          <span className="text-lg leading-none text-[var(--accent)]">+</span> Add a Tool
        </button>
      )}
    </div>
  );
}
