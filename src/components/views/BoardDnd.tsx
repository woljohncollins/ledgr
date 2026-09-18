// Drag-and-drop for board (kanban) views: drag a card to another column to set
// its grouping value (status, urgency, or a single-select property). Mounted by
// BoardLayout only when the page deems the grouping safe to set by a drop
// (ViewRenderer's boardDraggable) — computed `due` buckets, `type`, and
// multi_select stay read-only. Native HTML5 drag (the NavSlotsEditor pattern,
// no DnD dependency, Principle 5); a drop optimistically moves the card,
// PATCHes /api/items/[id], then router.refresh() reconciles with the server.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { ITEM_STATUSES, URGENCIES } from "@/lib/item-enums";
import { boardDropPatch, groupValueFor, NONE_GROUP, orderedGroups } from "@/lib/view-grouping";
import BoardColumn from "@/components/views/BoardColumn";
import { isTerminalCategory } from "@/lib/status";
import type { ViewGrouping } from "@/lib/views";
import type { StatusDef } from "@/lib/status";
import { useBoardTouchDrag } from "./useBoardTouchDrag";

// What the board needs to group + render a card. dateLabel is precomputed by
// the server BoardLayout so the client needn't reimplement the date calendars.
export type BoardCard = {
  id: string;
  title: string;
  status: string;
  urgency: number | null;
  type: string;
  dueDate: Date | null;
  scheduledDate: Date | null;
  properties: unknown;
  dateLabel: string;
};

// Optimistically rewrite a card's grouping value so it re-buckets immediately;
// mirrors the effect of boardDropPatch on the server row.
function moveCard(card: BoardCard, grouping: ViewGrouping, col: string): BoardCard {
  if (grouping && "propertyKey" in grouping) {
    const props =
      card.properties && typeof card.properties === "object"
        ? { ...(card.properties as Record<string, unknown>) }
        : {};
    props[grouping.propertyKey] = col === NONE_GROUP ? null : col;
    return { ...card, properties: props };
  }
  // A relation grouping (Tags) isn't droppable — boardDropPatch returns null for
  // it, so no write is issued and the optimistic card must not move either.
  if (grouping && "relationRole" in grouping) return card;
  const field = grouping?.field ?? "status";
  if (field === "status") return { ...card, status: col };
  if (field === "urgency") return { ...card, urgency: col === NONE_GROUP ? null : Number(col) };
  return card;
}

export default function BoardDnd({
  cards,
  grouping,
  boardKey,
  groupOrder,
  statuses,
  cardBodies,
}: {
  cards: BoardCard[];
  grouping: ViewGrouping;
  // Scopes each column's remembered collapse state to THIS board (the saved
  // view's id, else the type key) — see board-prefs.ts.
  boardKey: string;
  groupOrder?: string[];
  // The type's resolved statuses (S2): a status board colors its columns.
  statuses?: StatusDef[];
  // Rich card bodies keyed by item id (project boards, 2026-08-17): prebuilt
  // server nodes rendered verbatim inside the draggable <li> instead of the
  // default title+date card. Their internal anchors set draggable={false}, so
  // the row's drag still wins.
  cardBodies?: Record<string, ReactNode>;
}) {
  const router = useRouter();
  const [items, setItems] = useState(cards);
  // Reconcile with the server when it sends new cards (after router.refresh()):
  // adjust state during render, React's blessed alternative to a syncing effect
  // (and what the react-hooks rule wants). `cards` is a stable reference between
  // refreshes, so a client-only drag never resets the optimistic move.
  const [syncedFrom, setSyncedFrom] = useState(cards);
  if (syncedFrom !== cards) {
    setSyncedFrom(cards);
    setItems(cards);
  }
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const now = new Date();
  // Show every valid target column, including empty ones, so a card can be
  // dragged into a status/option that nothing currently has (orderedGroups
  // otherwise renders only present values).
  const statusBoard =
    !grouping || ("field" in grouping && grouping.field === "status");
  const fullKnown: string[] =
    grouping && ("propertyKey" in grouping || "relationRole" in grouping)
      ? [...(groupOrder ?? []), NONE_GROUP]
      : (grouping?.field ?? "status") === "urgency"
        ? [...URGENCIES.map(String), NONE_GROUP]
        : // status: every custom status as a column (S2), in schema order.
          [...(groupOrder ?? ITEM_STATUSES)];
  const present = new Set([
    ...items.map((i) => groupValueFor(i, grouping, now)),
    ...fullKnown,
  ]);
  const columns = orderedGroups(grouping, present, groupOrder);

  async function drop(col: string) {
    const id = dragId;
    setDragId(null);
    setOverCol(null);
    if (!id) return;
    const card = items.find((i) => i.id === id);
    if (!card || groupValueFor(card, grouping, now) === col) return;
    const patch = boardDropPatch(grouping, col);
    if (!patch) return;
    const prev = items;
    setItems((cs) => cs.map((c) => (c.id === id ? moveCard(c, grouping, col) : c)));
    try {
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setItems(prev); // revert on failure; the server stays canonical
    }
  }

  // Touch path: long-press a card to lift it, drag onto a column, release.
  // Desktop mouse keeps the native HTML5 drag wired below; the two never
  // collide (touch events don't fire for mouse). Reuses the same drop().
  useBoardTouchDrag(boardRef, {
    onArm: (id) => setDragId(id),
    onOver: (col) => setOverCol(col),
    onDrop: (col) => {
      if (col) void drop(col);
      else {
        setDragId(null);
        setOverCol(null);
      }
    },
    onCancel: () => {
      setDragId(null);
      setOverCol(null);
    },
  });

  return (
    // data-scroll-x marks this as a horizontal scroller so a future mobile
    // swipe-nav (explorations/mobile-swipe-navigation.md) won't hijack drags.
    // data-scroll-x marks this as a horizontal scroller so a future mobile
    // swipe-nav (explorations/mobile-swipe-navigation.md) won't hijack drags.
    // Scroll-snap gives the phone its one-column-at-a-time swipe, and is dropped
    // WHILE A CARD IS LIFTED: the touch-drag hook auto-scrolls the board
    // imperatively when a finger nears the edge, and mandatory snapping fights
    // that by yanking the scroll back to the nearest column mid-drag. Desktop
    // never snaps (sm:snap-none) — a mouse drag wants free scrolling.
    <div
      ref={boardRef}
      data-scroll-x
      className={`mt-4 flex gap-3 overflow-x-auto pb-2 sm:snap-none ${
        dragId ? "" : "snap-x snap-mandatory"
      }`}
    >
      {columns.map((col) => {
        const colItems = items.filter((i) => groupValueFor(i, grouping, now) === col);
        const sdef = statusBoard ? statuses?.find((s) => s.key === col) : undefined;
        return (
          <BoardColumn
            key={col}
            col={col}
            boardKey={boardKey}
            label={sdef?.label ?? col}
            color={sdef?.color}
            count={colItems.length}
            // Done / archived start collapsed; every other column starts open.
            defaultCollapsed={sdef ? isTerminalCategory(sdef.category) : false}
            highlighted={overCol === col && dragId != null}
            onDragOver={(e) => {
              e.preventDefault();
              if (overCol !== col) setOverCol(col);
            }}
            onDrop={(e) => {
              e.preventDefault();
              void drop(col);
            }}
          >
            <ul className="flex min-h-12 flex-col gap-1.5 p-2">
              {colItems.map((item) => (
                <li
                  key={item.id}
                  data-card-id={item.id}
                  draggable
                  onDragStart={() => setDragId(item.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverCol(null);
                  }}
                  className={`${dragId === item.id ? "opacity-40 " : ""}${
                    cardBodies?.[item.id] ? "cursor-grab active:cursor-grabbing" : ""
                  }`}
                >
                  {cardBodies?.[item.id] ?? (
                    <Link
                      href={`/items/${item.id}`}
                      // Suppress the anchor's native drag so the <li>'s drag wins;
                      // a plain click still navigates to the item.
                      draggable={false}
                      className={`block cursor-grab rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-sm hover:border-neutral-700 active:cursor-grabbing ${
                        item.title ? "text-neutral-200" : "text-neutral-500"
                      } ${item.status === "done" ? "line-through opacity-60" : ""}`}
                    >
                      <span className="block truncate">{item.title || "Untitled"}</span>
                      {item.dateLabel && (
                        <span className="mt-0.5 block text-xs text-neutral-600">
                          {item.dateLabel}
                        </span>
                      )}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </BoardColumn>
        );
      })}
    </div>
  );
}
