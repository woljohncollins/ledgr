// Permanently delete a trashed item (or empty the whole Trash) from the Trash
// page, behind a confirm (John, 2026-10-08). POST /api/items/[id]/purge; `all`
// empties the Trash. Irreversible, so the popover says so.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ConfirmButton from "@/components/ui/ConfirmButton";

export default function PurgeButton({
  id,
  count,
}: {
  // An item id, or "all" to empty the Trash.
  id: string;
  // For the empty-Trash variant: how many items it will remove.
  count?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const all = id === "all";
  const purge = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${id}/purge`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmButton
      title={all ? `Empty the Trash (${count ?? 0} items)?` : "Delete forever?"}
      description={
        all
          ? "Every item in the Trash is permanently deleted. This cannot be undone."
          : "This item is permanently deleted and cannot be restored."
      }
      confirmLabel={all ? "Empty Trash" : "Delete forever"}
      align="right"
      disabled={busy || (all && !count)}
      onConfirm={purge}
      trigger={<span>{busy ? "Deleting…" : all ? "Empty Trash" : "Delete forever"}</span>}
      triggerClassName={
        all
          ? "shrink-0 rounded border border-red-900/70 px-2.5 py-1 text-xs text-red-300 hover:border-red-500 hover:text-red-200 disabled:opacity-50"
          : "shrink-0 rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-500 hover:border-red-600 hover:text-red-300 disabled:opacity-50"
      }
    />
  );
}
