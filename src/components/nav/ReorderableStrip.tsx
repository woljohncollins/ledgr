"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";

// A horizontal strip whose children reorder by hold-and-drag (the phone
// bottom bar, Brandon 2026-09-19). Pointer events unify mouse and touch, the
// same posture as FavoritesFlyout's row reorder; what's different here is that
// the strip lives INSIDE the Launcher panel, whose own touch handlers claim a
// vertical drag. So a plain press stays a tap (the slot's Link/button keeps
// its click), a press that moves right away is left to the Launcher, and only
// a HOLD arms the reorder, after which the strip stops touch events from
// bubbling so the panel never sees the horizontal drag.
//
// Live reorder: while dragging, `onMove(from, to)` fires whenever the pointer
// sits nearest another slot, and the parent re-renders the new order.
// `onCommit` fires once on release. A `locked` item (Home) neither drags nor
// gets displaced.

const HOLD_MS = 350;
const SLOP_PX = 6;

export type StripItem = { id: string; node: ReactNode; locked?: boolean };

const NO_CALLOUT = { WebkitTouchCallout: "none" } as CSSProperties;

export default function ReorderableStrip({
  items,
  onMove,
  onCommit,
  className,
}: {
  items: StripItem[];
  onMove: (from: number, to: number) => void;
  onCommit: () => void;
  className?: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const wrappers = useRef(new Map<string, HTMLElement>());
  // The press waiting to become a hold.
  const hold = useRef<{
    id: string;
    x: number;
    y: number;
    pointerId: number;
    el: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // The armed drag (a ref so the touch handlers read it synchronously).
  const drag = useRef<{ id: string } | null>(null);
  const swallowClick = useRef(false);

  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };

  const arm = () => {
    const h = hold.current;
    if (!h) return;
    hold.current = null;
    drag.current = { id: h.id };
    setDragId(h.id);
    h.el.setPointerCapture?.(h.pointerId);
    navigator.vibrate?.(10);
  };

  const finish = () => {
    clearHold();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setDragId(null);
    // A held slot must not also fire the tap it started on: browsers send no
    // click after a moved pointer, but a hold released in place still would.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 300);
    onCommit();
  };

  const onPointerDown = (item: StripItem, e: ReactPointerEvent<HTMLElement>) => {
    if (item.locked || items.filter((i) => !i.locked).length < 2) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    clearHold();
    hold.current = {
      id: item.id,
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      el: e.currentTarget,
      timer: setTimeout(arm, HOLD_MS),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const h = hold.current;
    if (h) {
      // Moved before the hold matured: a tap, a scroll, or the Launcher's drag.
      if (Math.abs(e.clientX - h.x) > SLOP_PX || Math.abs(e.clientY - h.y) > SLOP_PX) clearHold();
      return;
    }
    const d = drag.current;
    if (!d) return;
    const from = items.findIndex((i) => i.id === d.id);
    if (from < 0) return;
    // The slot whose center is nearest the pointer is the target; locked slots
    // are never targets, so Home stays first.
    let to = from;
    let best = Infinity;
    items.forEach((it, idx) => {
      if (it.locked) return;
      const el = wrappers.current.get(it.id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dist = Math.abs(e.clientX - (r.left + r.width / 2));
      if (dist < best) {
        best = dist;
        to = idx;
      }
    });
    if (to !== from) onMove(from, to);
  };

  // While armed, keep the touch sequence from reaching the Launcher panel,
  // whose touchmove would otherwise claim a vertical drag mid-reorder.
  const onTouchMove = (e: ReactTouchEvent<HTMLElement>) => {
    if (drag.current) e.stopPropagation();
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (swallowClick.current) {
      e.preventDefault();
      e.stopPropagation();
      swallowClick.current = false;
    }
  };

  return (
    <div className={className}>
      {items.map((item) => (
        <div
          key={item.id}
          ref={(el) => {
            if (el) wrappers.current.set(item.id, el);
            else wrappers.current.delete(item.id);
          }}
          onPointerDown={(e) => onPointerDown(item, e)}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onTouchMove={onTouchMove}
          onClickCapture={onClickCapture}
          // The hold must not open the platform's own long-press menu (the iOS
          // link callout, the Android context menu) on a draggable slot.
          onContextMenu={(e) => {
            if (!item.locked) e.preventDefault();
          }}
          style={item.locked ? undefined : NO_CALLOUT}
          className={`shrink-0 select-none transition-transform ${
            dragId === item.id ? "z-10 scale-110 opacity-80" : ""
          }`}
        >
          {item.node}
        </div>
      ))}
    </div>
  );
}
