// "Add existing task" on the Subtasks section: the inverse of "+ Add subtask".
// Instead of creating a new child, it searches the owner's items and reparents
// an existing one under this item (sets the picked item's parentId). Reuses the
// shared MoveUnderMenu typeahead; the server's assertValidParent rejects a pick
// that would form a cycle.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import MoveUnderMenu from "@/components/items/MoveUnderMenu";

export default function AddExistingSubtask({ parentId }: { parentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pick(id: string | null) {
    if (!id || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setOpen(false);
      router.refresh();
    } catch {
      setError(true); // e.g. a cycle was rejected; leave the picker open
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        // A step dimmer than "Add subtask" beside it — the secondary path.
        className="rounded px-2 py-1 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        Add existing task
      </button>
      {open && (
        <MoveUnderMenu
          busy={busy}
          onPick={pick}
          className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[90vw] rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-xl shadow-black/50"
          placeholder="Search a task to nest here…"
          showTopLevel={false}
        />
      )}
      {error && (
        <span className="ml-2 text-xs text-red-400">Couldn&apos;t nest that item.</span>
      )}
    </div>
  );
}
