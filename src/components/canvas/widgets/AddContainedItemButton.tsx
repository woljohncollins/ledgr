// "+ Add {label}" that creates a contained item and opens it in the item modal
// (Tyler, 2026-07-01) — used by the Docs (note) and Links widgets. It files the
// new item as contained by this project (so it's associated the moment it's
// created), then navigates to the item, which the intercepting route opens as a
// modal editor — mirroring the app's "+ New" (NewItemButton). We do NOT
// router.refresh() first: that invalidates the router cache and makes the
// intercepted modal fall through to the full page (Tyler saw the link jump to
// the full page). The card picks up the new item on the next navigation/refresh.
// An abandoned blank item is left associated (same as "+ New"); delete like any.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { openItem } from "@/lib/item-nav";
import { showToast } from "@/components/ui/ActionToast";
import AttachExistingButton from "@/components/canvas/widgets/AttachExistingButton";

export default function AddContainedItemButton({
  recordId,
  type,
  label,
}: {
  recordId: string;
  type: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/records/${recordId}/contain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, title: "" }),
      });
      if (!res.ok) {
        // Rule 9: this used to return silently, which is how the custom-tool
        // add bug (ADR-204) hid — the button clicked and nothing happened.
        showToast(`Couldn't add ${label}`);
        return;
      }
      const { item } = (await res.json()) as { item: { id: string } };
      openItem(router, item.id);
    } finally {
      setBusy(false);
    }
  }

  // "Add note" / "Add link" → "note" / "link" for the attach control's copy.
  const singular = label.replace(/^Add\s+/i, "").toLowerCase() || "item";

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => void create()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded px-1 py-1 text-sm text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
      >
        <span className="text-base leading-none text-[var(--accent)]">+</span> {label}
      </button>
      <AttachExistingButton recordId={recordId} type={type} label={singular} />
    </div>
  );
}
