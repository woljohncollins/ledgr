// "Attach" — the other half of a collection card's "+" (Brandon, 2026-08-28).
// Every card on a record could only ever CREATE something new; there was no way
// to put an item you already have into one. This is a small typeahead over items
// of the card's type; picking one writes the same home + role edge the create
// path writes (POST …/contain with { itemId }), so it lands in the same card.
//
// Deliberately a SECOND control rather than folding into the "+": creating is
// one click today and typing a name first would be a tax on the common case.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";

type Hit = { id: string; title: string };

export default function AttachExistingButton({
  recordId,
  type,
  label,
}: {
  recordId: string;
  // The item type to search. Custom tools pass their own type key.
  type: string;
  // What the card holds, singular and lowercase ("note", "task", "meeting") —
  // used in the placeholder and the failure toast.
  label: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ type, limit: "8" });
        if (trimmed) params.set("q", trimmed);
        const res = await fetch(`/api/items?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const d = (await res.json()) as { items: Hit[] };
        // Never offer the record itself (a custom tool can hold its own type).
        setHits((d.items ?? []).filter((h) => h.id !== recordId));
      } catch {
        // aborted or offline; the next keystroke retries
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q, open, type, recordId]);

  // Close on any click outside (the card's other controls included).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-attach-pop]")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function attach(hit: Hit) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/records/${recordId}/contain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: hit.id }),
      });
      if (!res.ok) {
        showToast(`Couldn't attach that ${label}`);
        return;
      }
      // Say which of the two things just happened (ADR-232). Reporting it beats
      // a tooltip nobody reads, and it lands exactly when the difference
      // matters.
      //
      // Deliberately NOT "moved here" (Brandon, 2026-08-28): that reads as "it
      // is now inside this record", and containment here is a filing
      // relationship, not a box. softDeleteItem cascades through parent_id
      // only, so deleting a record does NOT delete what it holds. The honest
      // difference is how many records the thing can be filed under.
      const { contained, multi } = (await res.json().catch(() => ({}))) as {
        contained?: boolean;
        multi?: boolean;
      };
      setOpen(false);
      setQ("");
      router.refresh();
      // Three outcomes, three sentences. The middle one matters: a resource
      // filed nowhere is ADOPTED by the first record that takes it, and saying
      // "a note belongs to one record" there would contradict the very feature
      // that just ran (caught in the browser check, 2026-08-28).
      const title = hit.title || "Untitled";
      showToast(
        !contained
          ? `${title} attached — it stays in its other records too`
          : multi
            ? `${title} filed here — attach it elsewhere to share it`
            : `${title} filed here — a ${label} belongs to one record`
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative" data-attach-pop>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setQ(""); }}
        className="flex items-center gap-1.5 rounded px-1 py-1 text-sm text-neutral-500 hover:text-neutral-300"
        title={`Attach an existing ${label} to this record`}
        aria-label={`Attach an existing ${label} to this record`}
      >
        <span className="text-base leading-none text-[var(--accent)]">⇱</span> Attach
      </button>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 flex w-64 flex-col rounded-card border border-line bg-surface-1 p-1 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
            placeholder={`Search ${label}s…`}
            aria-label={`Search ${label}s to attach`}
            className="mb-1 w-full rounded border border-line bg-surface-0 px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <span className="max-h-44 overflow-y-auto">
            {hits.map((h) => (
              <button
                key={h.id}
                type="button"
                disabled={busy}
                onClick={() => void attach(h)}
                className="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 disabled:opacity-50"
              >
                {h.title || "Untitled"}
              </button>
            ))}
            {hits.length === 0 && (
              <span className="block px-2 py-1 text-xs text-ink-faint">No matches.</span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
