// The shared list-row context menu (ui-refresh S4, ADR-142). One menu for every
// list row — opened by right-click on desktop and long-press on touch — so the
// always-visible per-row "Trash" text button (which ate width and invited
// mis-taps on a phone) can disappear everywhere. Actions: Complete, Focus,
// Schedule (quick date), Move (deferred to the bulk bar), Trash. Every action is
// optimistic → router.refresh(), and the destructive/one-way ones fire an undo
// toast (soft-delete + the toast are the safety net).
//
// Exposed two ways:
//  - useRowMenu(opts) → { handlers, menu, longPressed } to attach to ANY row
//    element (SubtaskExpandableRow renders its own <li>, so it spreads these).
//  - <RowMenu …> — a thin <li> wrapper for the common plain-row case.
//
// No dependency (Principle 5); long-press mirrors the shipped kanban touch-drag
// timing (a press that doesn't move within the delay opens the menu).
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";
import DateInput from "@/components/ui/DateInput";
import { DeskSendItems } from "@/components/desk/DeskSendMenu";
import { addDaysYmd } from "@/lib/recurrence";

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

export type RowMenuOptions = {
  id: string;
  // Task-like row (has a done status): shows Complete + Focus + Schedule.
  canComplete?: boolean;
  done?: boolean;
  // App-timezone today (YYYY-MM-DD); enables Focus + the Schedule quick dates.
  today?: string;
  focused?: boolean;
  label?: string; // for the toast text ("<label> moved to Trash")
};

type Pos = { x: number; y: number };

function ymdToIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

export function useRowMenu(opts: RowMenuOptions) {
  const { id, canComplete = false, done = false, today, focused = false, label } = opts;
  const router = useRouter();
  const [pos, setPos] = useState<Pos | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Set the instant a long-press fires, so the click it would otherwise trigger
  // on the row's title link is swallowed once.
  const longPressed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<Pos | null>(null);

  const open = useCallback((x: number, y: number, o?: { schedule?: boolean }) => {
    // Clamp so the ~190px menu stays on screen near a right/bottom edge.
    const mx = Math.min(x, window.innerWidth - 200);
    const my = Math.min(y, window.innerHeight - 240);
    setPos({ x: Math.max(8, mx), y: Math.max(8, my) });
    setScheduleOpen(Boolean(o?.schedule));
  }, []);

  const close = useCallback(() => {
    setPos(null);
    setScheduleOpen(false);
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Close on outside click / Esc / scroll while open.
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.("[data-row-menu]")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos, close]);

  const run = useCallback(
    async (fn: () => Promise<Response>, toast?: { text: string; undo?: () => Promise<Response> }) => {
      close();
      try {
        const res = await fn();
        if (!res.ok) throw new Error(String(res.status));
        router.refresh();
        if (toast) {
          showToast(toast.text, toast.undo ? () => void toast.undo!().then(() => router.refresh()) : undefined);
        }
      } catch {
        showToast("Something went wrong");
      }
    },
    [close, router]
  );

  const patch = (body: unknown) =>
    fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const complete = () =>
    run(() => fetch(`/api/items/${id}/complete`, { method: "POST" }), {
      text: done ? "Marked not done" : "Task completed",
      undo: () => fetch(`/api/items/${id}/complete`, { method: "POST" }),
    });

  const toggleFocus = () =>
    run(() =>
      patch({ propertyPatch: { focus: focused ? null : { date: today, order: Date.now() } } })
    );

  const schedule = (ymd: string | null) =>
    run(() => patch({ scheduledDate: ymd ? ymdToIso(ymd) : null }));

  const trash = () =>
    run(() => fetch(`/api/items/${id}`, { method: "DELETE" }), {
      text: `${label ? `"${label}" ` : ""}moved to Trash`,
      undo: () => fetch(`/api/items/${id}/restore`, { method: "POST" }),
    });

  // --- Row element handlers ---
  const handlers = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      longPressed.current = false;
      clearTimer();
      timer.current = setTimeout(() => {
        longPressed.current = true;
        // A haptic tick if the platform supports it.
        navigator.vibrate?.(10);
        open(start.current!.x, start.current!.y);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!start.current) return;
      const t = e.touches[0];
      if (
        Math.abs(t.clientX - start.current.x) > MOVE_CANCEL_PX ||
        Math.abs(t.clientY - start.current.y) > MOVE_CANCEL_PX
      ) {
        clearTimer();
      }
    },
    onTouchEnd: clearTimer,
    onTouchCancel: clearTimer,
    // Swallow the click that a long-press would otherwise fire on the row's link.
    onClickCapture: (e: React.MouseEvent) => {
      if (longPressed.current) {
        e.preventDefault();
        e.stopPropagation();
        longPressed.current = false;
      }
    },
  };

  // Portaled to <body> on purpose. The menu is `position: fixed` at viewport
  // coords (clientX/clientY), and a `transform`ed ancestor becomes the
  // containing block for a fixed child, so inside a react-grid-layout cell (the
  // dashboard widgets, the ADR-069 item canvas) an in-flow menu would be offset
  // by the cell's translate AND clipped by the card's overflow-hidden. The
  // portal escapes both. Safe everywhere: close-on-outside tests
  // `closest("[data-row-menu]")`, Escape/scroll are document/window level, and a
  // portal keeps React context (router, Desk send) intact.
  const menu = pos ? (
    createPortal(<div
      data-row-menu
      role="menu"
      className="fixed z-[70] min-w-[11rem] rounded-card border border-line-strong bg-surface-3 p-1 shadow-2xl shadow-black/50"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {canComplete && (
        <button
          type="button"
          role="menuitem"
          onClick={complete}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-2"
        >
          {done ? "↩ Mark not done" : "✓ Complete"}
        </button>
      )}
      {canComplete && today && (
        <button
          type="button"
          role="menuitem"
          onClick={toggleFocus}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-2"
        >
          {focused ? "☆ Unfocus" : "★ Focus today"}
        </button>
      )}
      {canComplete && (
        <div>
          <button
            type="button"
            role="menuitem"
            onClick={() => setScheduleOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-2"
          >
            <span>◷ Schedule</span>
            <span className="text-ink-subtle">{scheduleOpen ? "▾" : "▸"}</span>
          </button>
          {scheduleOpen && (
            <div className="flex flex-col border-l border-line pl-2 ml-2">
              {today && (
                <>
                  <button type="button" onClick={() => schedule(today)} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
                    Today
                  </button>
                  <button type="button" onClick={() => schedule(addDaysYmd(today, 1))} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
                    Tomorrow
                  </button>
                  <button type="button" onClick={() => schedule(addDaysYmd(today, 7))} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
                    Next week
                  </button>
                </>
              )}
              <label className="flex flex-wrap items-center gap-1 px-2 py-1 text-xs text-ink-subtle">
                Pick
                <DateInput
                  value={null}
                  onCommit={schedule}
                  ariaLabel="Scheduled date"
                  className="rounded border border-line bg-surface-1 px-1 py-0.5 text-xs text-ink"
                />
              </label>
              <button type="button" onClick={() => schedule(null)} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
                Clear date
              </button>
            </div>
          )}
        </div>
      )}
      {/* Send to Desk (ADR-146): desktop-only, renders nothing on touch/small. */}
      <DeskSendItems itemId={id} onDone={close} />
      <button
        type="button"
        role="menuitem"
        onClick={trash}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-red-400 hover:bg-surface-2"
      >
        🗑 Move to Trash
      </button>
    </div>, document.body)
  ) : null;

  // `open`/`complete` are exposed so SwipeRow (S5) can drive the same menu from a
  // long-press and fire the same completion from a right-swipe.
  return { handlers, menu, longPressed, open, complete };
}

// Thin <li> wrapper for the common plain-row case: attaches the handlers and
// renders the menu after the row content.
export default function RowMenu({
  className,
  children,
  ...opts
}: RowMenuOptions & { className?: string; children: ReactNode }) {
  const { handlers, menu } = useRowMenu(opts);
  return (
    <li className={className} {...handlers}>
      {children}
      {menu}
    </li>
  );
}
