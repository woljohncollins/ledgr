// Drag-and-drop for the agenda layout (2026-09-21, John's ask): tasks grouped
// under a day divider, ordered highest priority first, and any row can be
// dragged onto any other day (including an empty one) or to a new spot within a
// day. The server AgendaLayout does the bucketing and renders each row
// (ItemRow) as a node; this client shell owns the ordering, the drop zones, the
// optimistic move, the PATCH, and a long-press touch path.
//
// Order within a day: priority first (P1, P2, P3, then unset), then the manual
// order John dragged them into (properties.dayorder), then the server order.
// Dropping a row between two others adopts the priority of the row it lands
// next to (drop it among the P1s and it becomes P1) and takes a dayorder midway
// between its new neighbours, so the position sticks.
//
// What a drop writes: John keeps ONE date per task, so both scheduledDate and
// dueDate move to the day. "No date" clears both. Same PATCH /api/items/[id] +
// router.refresh() contract as BoardDnd.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const AGENDA_UNDATED = "__undated__";

export type AgendaRow = {
  id: string;
  urgency: number | null; // 1 = highest
  order: number | null; // properties.dayorder
  node: ReactNode;
};
export type AgendaDay = {
  key: string; // YYYY-MM-DD, or AGENDA_UNDATED
  label: string; // "Monday, September 21"
  isToday?: boolean;
  isPast?: boolean;
  rows: AgendaRow[];
};

type Placement = { day: string; urgency: number | null; order: number | null };
type Slot = { day: string; index: number }; // insert BEFORE index (index === rows.length appends)

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE_PX = 10;
const ORDER_STEP = 1000;

function dayIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}
const prio = (u: number | null) => (u == null ? 99 : u);

function sortRows(rows: AgendaRow[]): AgendaRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const p = prio(a.r.urgency) - prio(b.r.urgency);
      if (p !== 0) return p;
      const ao = a.r.order ?? Number.POSITIVE_INFINITY;
      const bo = b.r.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao < bo ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

// Where a dragged row lands: the priority it adopts and the dayorder that puts
// it between `above` and `below` in the day's sorted list (either may be absent).
function placeBetween(
  self: AgendaRow,
  above: AgendaRow | undefined,
  below: AgendaRow | undefined
): { urgency: number | null; order: number } {
  // Adopt the neighbour's priority. Same-priority neighbours are the common
  // case; between two different bands take the one above (you dropped it at the
  // tail of that band). Empty day: keep your own.
  let urgency: number | null;
  if (above && below && prio(above.urgency) === prio(below.urgency)) urgency = above.urgency;
  else if (above) urgency = above.urgency;
  else if (below) urgency = below.urgency;
  else urgency = self.urgency;
  // dayorder is only meaningful within the priority band, so midpoint against
  // neighbours in the same band; otherwise step off the edge of the band.
  const a = above && prio(above.urgency) === prio(urgency) ? above.order : null;
  const b = below && prio(below.urgency) === prio(urgency) ? below.order : null;
  let order: number;
  if (a != null && b != null) order = (a + b) / 2;
  else if (a != null) order = a + ORDER_STEP;
  else if (b != null) order = b - ORDER_STEP;
  else order = ORDER_STEP;
  return { urgency, order };
}

export default function AgendaDnd({
  days,
}: {
  days: AgendaDay[];
  // Kept for the server call site; a drop always writes both dates (one date per task).
  dateField?: "scheduledDate" | "dueDate";
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overSlot, setOverSlot] = useState<Slot | null>(null);
  // Optimistic placements: row id -> where it now sits, pinned to the `days` they
  // were made against. Fresh days from the server (after router.refresh) make the
  // stored moves stale, so they read as empty without an effect.
  const [moveState, setMoveState] = useState<{ base: AgendaDay[]; moves: Record<string, Placement> }>({
    base: days,
    moves: {},
  });
  const moves = useMemo(
    () => (moveState.base === days ? moveState.moves : {}),
    [moveState, days]
  );
  const setMoves = (fn: (m: Record<string, Placement>) => Record<string, Placement>) =>
    setMoveState((s) => ({ base: days, moves: fn(s.base === days ? s.moves : {}) }));

  // Re-bucket and re-sort rows with the optimistic placements applied.
  const shown = useMemo(() => {
    const home = new Map<string, { day: string; row: AgendaRow }>();
    for (const d of days) for (const r of d.rows) home.set(r.id, { day: d.key, row: r });
    const byDay = new Map<string, AgendaRow[]>();
    for (const d of days) byDay.set(d.key, []);
    for (const { day, row } of home.values()) {
      const mv = moves[row.id];
      const eff: AgendaRow = mv ? { ...row, urgency: mv.urgency, order: mv.order } : row;
      const key = mv ? mv.day : day;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(eff);
    }
    return days.map((d) => ({ ...d, rows: sortRows(byDay.get(d.key) ?? []) }));
  }, [days, moves]);

  function commitDrop(id: string | null, slot: Slot | null) {
    setDragId(null);
    setOverSlot(null);
    if (!id || !slot) return;
    const dayRows = shown.find((d) => d.key === slot.day)?.rows ?? [];
    const self = shown.flatMap((d) => d.rows).find((r) => r.id === id);
    if (!self) {
      // Not one of ours: a task dragged in from the Focused-today card. Unfocus it
      // and give it the day; the refresh brings it into this list.
      const value = slot.day === AGENDA_UNDATED ? null : dayIso(slot.day);
      fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledDate: value, dueDate: value, propertyPatch: { focus: null } }),
      })
        .then((res) => {
          if (res.ok) router.refresh();
        })
        .catch(() => {});
      return;
    }
    // Neighbours in the target day, excluding the dragged row itself.
    const others = dayRows.filter((r) => r.id !== id);
    const selfIdx = dayRows.findIndex((r) => r.id === id);
    let idx = slot.index;
    if (selfIdx !== -1 && selfIdx < idx) idx -= 1; // removing self shifts later slots up
    idx = Math.max(0, Math.min(idx, others.length));
    const above = others[idx - 1];
    const below = others[idx];
    const fromDay = shown.find((d) => d.rows.some((r) => r.id === id))?.key ?? null;
    const { urgency, order } = placeBetween(self, above, below);
    const sameSpot =
      fromDay === slot.day && prio(urgency) === prio(self.urgency) && selfIdx !== -1 && idx === selfIdx;
    if (sameSpot) return;

    const before = moves[id];
    const next: Placement = { day: slot.day, urgency, order };
    setMoves((m) => ({ ...m, [id]: next }));
    const value = slot.day === AGENDA_UNDATED ? null : dayIso(slot.day);
    const body: Record<string, unknown> = {
      scheduledDate: value,
      dueDate: value,
      urgency,
      propertyPatch: { dayorder: order },
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

  // Resolve a pointer position to an insertion slot: which day section, and
  // before which row (upper half = before it, lower half = after it).
  function slotAt(x: number, y: number): Slot | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const sec = hit?.closest<HTMLElement>("[data-day]");
    if (!sec) return null;
    const day = sec.dataset.day!;
    const rowsEl = Array.from(sec.querySelectorAll<HTMLElement>("[data-card-id]"));
    for (let i = 0; i < rowsEl.length; i++) {
      const r = rowsEl[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return { day, index: i };
    }
    return { day, index: rowsEl.length };
  }

  // Touch: hold a row ~350ms without moving to lift it, drag to a spot, release.
  // Attached imperatively so touchmove can be non-passive and stop the page
  // scrolling under the drag (same reasoning as useBoardTouchDrag, which is
  // column/x-based and so doesn't fit a vertical agenda).
  const cbRef = useRef({ commitDrop, slotAt });
  useEffect(() => {
    cbRef.current = { commitDrop, slotAt };
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;
    let id: string | null = null;
    let sx = 0, sy = 0, lx = 0, ly = 0;

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      armed = false;
      id = null;
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
      setOverSlot(cbRef.current.slotAt(lx, ly));
    };
    const onEnd = () => {
      if (armed) cbRef.current.commitDrop(id, cbRef.current.slotAt(lx, ly));
      else setDragId(null);
      reset();
    };
    const onCancel = () => {
      setDragId(null);
      setOverSlot(null);
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

  const dropLine = (active: boolean) => (
    <div
      aria-hidden
      className={`h-0.5 rounded transition-opacity ${active ? "bg-[var(--accent)] opacity-100" : "opacity-0"}`}
    />
  );

  return (
    <div ref={containerRef} className="mt-4 flex flex-col gap-4">
      {shown.map((d) => {
        const isOverDay = dragId != null && overSlot?.day === d.key;
        return (
          <section
            key={d.key}
            data-day={d.key}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const s = slotAt(e.clientX, e.clientY);
              if (s && (overSlot?.day !== s.day || overSlot?.index !== s.index)) setOverSlot(s);
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                if (overSlot?.day === d.key) setOverSlot(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              commitDrop(e.dataTransfer.getData("text/plain") || dragId, slotAt(e.clientX, e.clientY));
            }}
            className={`rounded-md border px-2 pb-1 pt-1.5 transition-colors ${
              isOverDay ? "border-[var(--accent)] bg-neutral-800/40" : "border-transparent"
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
                  isOverDay ? "border-[var(--accent)] text-neutral-300" : "border-neutral-800 text-neutral-700"
                }`}
              >
                {dragId ? "Drop here" : "Nothing planned"}
              </div>
            ) : (
              <div className="mt-1">
                {d.rows.map((r, i) => (
                  <div key={r.id}>
                    {dropLine(isOverDay && overSlot?.index === i)}
                    <div
                      data-card-id={r.id}
                      draggable
                      onDragStart={(e) => {
                        setDragId(r.id);
                        e.dataTransfer.setData("text/plain", r.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverSlot(null);
                      }}
                      className={`cursor-grab active:cursor-grabbing ${dragId === r.id ? "opacity-50" : ""}`}
                    >
                      {r.node}
                    </div>
                  </div>
                ))}
                {dropLine(isOverDay && overSlot?.index === d.rows.length)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
