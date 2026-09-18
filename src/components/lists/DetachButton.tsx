// The detach ✕ on a related-but-not-contained row (ADR-232).
//
// It is the only visible difference between a resource that LIVES in this
// record and one that is merely relevant to it (Brandon, 2026-08-28): a row
// with an ✕ is a visitor, a row without one lives here. That is why it is an
// always-rendered per-row control rather than a RowMenu entry, which is the
// standing pattern for row actions (ADR-142) — the affordance is carrying
// information, not just offering an action, and a menu you have to open cannot
// tell you anything at a glance.
//
// It removes the association only, never the item: one `related` edge, scoped
// by role so it cannot touch a home or `contains` edge even if one also
// exists. Undo re-relates.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";

export default function DetachButton({
  recordId,
  itemId,
  label,
}: {
  // The record to detach FROM (the page you are on).
  recordId: string;
  itemId: string;
  // The row's title, for the toast and the accessible name.
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const name = label.trim() || "Untitled";

  const url = `/api/items/${recordId}/relations?targetId=${itemId}&role=related`;

  async function detach() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        showToast("Couldn't detach that");
        return;
      }
      router.refresh();
      // Undo re-relates FROM the item, matching the direction the attach wrote
      // (item -> record). The card query is direction-blind so either works,
      // but flipping the stored orientation on every undo is the kind of drift
      // that makes a later query surprising.
      showToast(`${name} detached`, () => {
        void fetch(`/api/items/${itemId}/relations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetId: recordId, role: "related" }),
        }).then(() => router.refresh());
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void detach()}
      disabled={busy}
      aria-label={`Detach ${name} from this record`}
      title="Related to this record, not filed in it. Click to detach."
      // Always-visible controls have to be READABLE to earn the space: at
      // text-ink-faint it read as a stray mark rather than a marker (browser
      // check, 2026-08-28). -my-1 py-1 px-1.5 keeps the row height while
      // giving the glyph a touch-sized box.
      className="-my-1 shrink-0 rounded px-1.5 py-1 text-xs leading-none text-ink-subtle hover:bg-surface-2 hover:text-red-400 disabled:opacity-50"
    >
      ✕
    </button>
  );
}
