// Drag-and-drop for the agenda layout (2026-09-21, John's ask): tasks grouped
// under a day divider, and any row can be dragged onto any other day, including
// an empty one, to move it there. The server AgendaLayout does the bucketing
// and renders each row (ItemRow) as a node; this client shell owns the drop
// zones, the optimistic move, the PATCH, and a long-press touch path.
//
// What a drop writes: the view's date field for that day (the "plan" property
// writes scheduledDate, per ADR-109/131 — dragging plans the WORK, it does not
// move a deadline unless the view is a due-date view). Dropping on "No date"
// clears it. Same PATCH /api/items/[id] + router.refresh() contract as BoardDnd.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const AGENDA_UNDATED = "__undated__";

export type AgendaRow = { id: string; node: ReactNode };
export type AgendaDay = {
  key: string; // YYYY-MM-DD, or AGENDA_UNDATED
  label: string; // "Monday, September 21"
  isToday?: boolean;
  isPast?: boolean;
  rows: AgendaRow[];
};

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE_PX = 10;

function dayIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

export default function AgendaDnd({
  days,
  dateField,
}: {
  days: AgendaDay[];
  // Which item field a drop writes: scheduledDate (plan / scheduled views) or dueDate.
  dateField: "scheduledDate" | "dueDate";
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  // Optimistic moves: row id -> day key, pinned to the `days` they were made
  // against. Fresh days from the server (after router.refresh) make the stored
  // moves stale, so they read as empty without an effect.
  const [moveState, setMoveState] = useState<{ base: AgendaDay[]; moves: Record<string, string> }>({
    base: days,
    moves: {},
  });
  const moves = useMemo(
    () => (moveState.base === days ? moveState.moves : {}),
    [moveState, days],
  );
  const setMoves = (fn: (m: Record<string, string>) => Record<string, string>) =>
    setMoveState((s) => ({ base: days, moves: fn(s.base === days ? s.moves : {}) }));

  // Re-bucket rows with the optimistic moves applied.
  const shown = useMemo(() => {
    const byId = new Map<string, AgendaRow>();
    const home = new Map<string, string>();
    for (const d of days) for (const r of d.rows) {
      byId.set(r.id, r);
      home.set(r.id, d.key);
    }
    return days.map((d) => ({
      ...d,
      rows: [...byId.values()].filter((r) => (moves[r.id] ?? home.get(r.id)) === d.key),
    }));
  }, [days, moves]);

  function currentDayOf(id: string): string | null {
    if (moves[id]) return moves[id];
    for (const d of days) if (d.rows.some((r) => r.id === id)) return d.key;
    return null;
  }

  function commitDrop(id: string | null, day: string | null) {
    setDragId(null);
    setOverDay(null);
    if (!id || !day) return;
    if (currentDayOf(id) === day) return;
    const before = currentDayOf(id);
    setMoves((m) => ({ ...m, [id]: day }));
    const body: Record<string, unknown> = {
      [dateField]: day === AGENDA_UNDATED ? null : dayIso(day),
    };
    fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        router.refresh();
      })
      .catch(() => {
        setMoves((m) => {
          const nx = { ...m };
          if (before) nx[id] = before;
          else delete nx[id];
          return nx;
        });
      });
  }

  // Touch: hold a row ~350ms without moving to lift it, drag over a day section,
  // release to drop. Attached imperatively so touchmove can be non-passive and
  // stop the page scrolling under the drag (same reasoning as useBoardTouchDrag,
  // which is column/x-based and so doesn't fit a vertical agenda).
  const cbRef = useRef({ commitDrop });
  useEffect(() => {
    cbRef.current = { commitDrop };
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;
    let id: string | null = null;
    let sx = 0;
    let sy = 0;
    let lx = 0;
    let ly = 0;
    let over: string | null = null;

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      armed = false;
      id = null;
      over = null;
    };
    const dayAt = (x: number, y: number): string | null => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      const sec = hit?.closest<HTMLElement>("[data-day]");
      return sec?.dataset.day ?? null;
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const row = (t.target as HTMLElement).closest<HTMLElement>("[data-card-id]");
      if (!row) return;
      id = row.dataset.cardId ?? null;
      sx = lx = t.clientX;
      sy = ly = t.clientY;
      timer = setTimeout(() => {
        armed = true;
        setDragId(id);
        if (navigator.vibrate) navigator.vibrate(10);
      }, LONG_PRESS_MS);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lx = t.clientX;
      ly = t.clientY;
      if (!armed) {
        if (Math.abs(lx - sx) > MOVE_TOLERANCE_PX || Math.abs(ly - sy) > MOVE_TOLERANCE_PX) reset();
        return;
      }
      e.preventDefault();
      const d = dayAt(lx, ly);
      if (d !== over) {
        over = d;
        setOverDay(d);
      }
    };
    const onEnd = () => {
      if (armed) cbRef.current.commitDrop(id, dayAt(lx, ly));
      else setDragId(null);
      reset();
    };
    const onCancel = () => {
      setDragId(null);
      setOverDay(null);
      reset();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, []);

  return (
    <div ref={containerRef} className="mt-4 flex flex-col gap-4">
      {shown.map((d) => {
        const isOver = overDay === d.key && dragId != null;
        return (
          <section
            key={d.key}
            data-day={d.key}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overDay !== d.key) setOverDay(d.key);
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                if (overDay === d.key) setOverDay(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              commitDrop(e.dataTransfer.getData("text/plain") || dragId, d.key);
            }}
            className={`rounded-md border px-2 pb-1 pt-1.5 transition-colors ${
              isOver
                ? "border-[var(--accent)] bg-neutral-800/40"
                : "border-transparent"
            }`}
          >
            <h3
              className={`flex items-baseline gap-2 border-b border-neutral-800 pb-1 text-xs font-semibold uppercase tracking-wide ${
                d.key === AGENDA_UNDATED
                  ? "text-neutral-600"
                  : d.isToday
                    ? "text-neutral-200"
                    : d.isPast
                      ? "text-red-400/80"
                      : "text-neutral-500"
              }`}
            >
              {d.label}
              {d.isToday && (
                <span className="rounded bg-[var(--accent)] px-1.5 py-px text-[10px] font-bold normal-case tracking-normal text-white">
                  Today
                </span>
              )}
              {d.isPast && d.key !== AGENDA_UNDATED && (
                <span className="text-[10px] font-medium normal-case tracking-normal text-red-400/80">
                  overdue
                </span>
              )}
            </h3>
            {d.rows.length === 0 ? (
              <div
                className={`my-1 rounded border border-dashed px-2 py-1.5 text-xs ${
                  isOver ? "border-[var(--accent)] text-neutral-300" : "border-neutral-800 text-neutral-700"
                }`}
              >
                {dragId ? "Drop here" : "Nothing planned"}
              </div>
            ) : (
              <div className="mt-1">
                {d.rows.map((r) => (
                  <div
                    key={r.id}
                    data-card-id={r.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(r.id);
                      e.dataTransfer.setData("text/plain", r.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverDay(null);
                    }}
                    className={`cursor-grab active:cursor-grabbing ${
                      dragId === r.id ? "opacity-50" : ""
                    }`}
                  >
                    {r.node}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
