// The project section grid with drag-to-reorder (Tyler, 2026-07-01). The server
// renders each section's chrome-less body; this client island wraps them in card
// chrome (drag handle · title · remove ×) and lets the owner rearrange the cards
// however they like. Reordering persists the record's composition (the card
// widget order = the array order) via PATCH, then refreshes.
//
// Drag is native HTML5 and handle-gated: a card only becomes draggable while the
// pointer is down on its grip, so the rich content inside (task inputs, editors)
// stays fully interactive. Touch drag is a follow-up (desktop mouse path first).
"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import RemoveSection from "@/components/canvas/RemoveSection";
import SectionCountGear from "@/components/canvas/SectionCountGear";
import type { Composition, RecordWidget } from "@/lib/composition";

// Widgets rendered in the header strip (not cards) — kept out of the reorder.
const HEADER_WIDGETS = new Set(["status", "people", "progress"]);

// Every card gets the hover options gear (Rename lives there, 2026-08-19).
// `countLimit` present → this card previews a collection, so the gear also
// offers "show N" (its current per-card limit). Undefined → no count section
// (Overview, derived single-value cards).
export type SectionItem = {
  instanceId: string;
  // The display title: the per-record rename when set, else defaultTitle.
  title: string;
  defaultTitle: string;
  customTitle: string | null;
  body: ReactNode;
  countLimit?: number;
  // Tasks card only (2026-08-17): the gear also offers "Group by" with these
  // choices, writing options.groupBy through the same composition PATCH.
  groupChoices?: string[];
  groupCurrent?: string;
};

export default function SectionGrid({
  itemId,
  composition,
  variant,
  items,
}: {
  itemId: string;
  composition: Composition;
  variant: "page" | "modal";
  items: SectionItem[];
}) {
  const router = useRouter();
  const [order, setOrder] = useState(() => items.map((i) => i.instanceId));
  // Re-adopt the server order after a refresh (adjust-during-render).
  const key = items.map((i) => i.instanceId).join(",");
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setOrder(items.map((i) => i.instanceId));
  }

  const [armed, setArmed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const byId = new Map(items.map((i) => [i.instanceId, i]));

  async function persist(newOrder: string[]) {
    const header = composition.widgets.filter((w) => HEADER_WIDGETS.has(w.defId));
    const cards = newOrder
      .map((id) => composition.widgets.find((w) => w.instanceId === id))
      .filter((w): w is RecordWidget => Boolean(w));
    const next: Composition = { ...composition, widgets: [...header, ...cards] };
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition: next }),
      });
      if (res.ok) router.refresh();
    } catch {
      // leave the optimistic order; the next refresh re-syncs from the server
    }
  }

  function reorder(dragged: string, target: string) {
    if (dragged === target) return;
    const next = order.filter((id) => id !== dragged);
    const ti = next.indexOf(target);
    if (ti < 0) return;
    next.splice(ti, 0, dragged);
    setOrder(next);
    void persist(next);
  }

  const gridCols = variant === "modal" ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div className={`grid grid-cols-1 gap-3 ${gridCols}`}>
      {order.map((id) => {
        const it = byId.get(id);
        if (!it) return null;
        return (
          <section
            key={id}
            draggable={armed === id}
            onDragStart={(e) => {
              setDragId(id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setArmed(null);
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              if (dragId && dragId !== id) {
                e.preventDefault();
                setOverId(id);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) reorder(dragId, id);
              setOverId(null);
            }}
            className={`group/card rounded-lg border bg-neutral-900/40 p-3 transition-colors ${
              overId === id ? "border-[var(--accent)]" : "border-neutral-800"
            } ${dragId === id ? "opacity-50" : ""}`}
          >
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                aria-label="Drag to reorder"
                title="Drag to reorder"
                onMouseDown={() => setArmed(id)}
                onMouseUp={() => setArmed(null)}
                className="shrink-0 cursor-grab text-neutral-600 hover:text-neutral-400 active:cursor-grabbing"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="9" cy="6" r="1.5" />
                  <circle cx="15" cy="6" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" />
                  <circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="18" r="1.5" />
                  <circle cx="15" cy="18" r="1.5" />
                </svg>
              </button>
              <h3 className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-neutral-500">
                {it.title}
              </h3>
              <SectionCountGear
                // key: a rename PATCHes + refreshes, and the gear's title
                // draft seeds from customTitle — remount on change so a
                // reverted/saved value never shows a stale draft.
                key={`gear:${it.customTitle ?? ""}`}
                itemId={itemId}
                composition={composition}
                instanceId={id}
                current={it.countLimit}
                label={it.title}
                defaultTitle={it.defaultTitle}
                customTitle={it.customTitle}
                groupChoices={it.groupChoices}
                groupCurrent={it.groupCurrent}
              />
              <RemoveSection itemId={itemId} composition={composition} instanceId={id} label={it.title} />
            </div>
            {it.body}
          </section>
        );
      })}
    </div>
  );
}
