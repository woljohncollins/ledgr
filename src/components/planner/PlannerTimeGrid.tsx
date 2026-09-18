// Multi-day time-grid for the Planner (ADR-131). Days are columns, the full 24h
// is rows (slotMinutes tall) in a scroll viewport that opens near the current
// time (or the work-hours window); an all-day band and the day headers stay
// pinned (sticky) while you scroll. The whole grid scrolls horizontally to reach
// more days, and while dragging it auto-scrolls when the pointer nears an edge
// (Notion-style). Drag a task into a slot (day + start time), onto the band
// (day-only), or to the Unscheduled rail (clear); drag a block's bottom edge to
// resize its duration — releasing on the edge does NOT open the task. Clicking
// an empty slot captures a task there; a "now" line marks the current time;
// overlapping task blocks split the column so none is hidden.
//
// Chips/blocks are <div>s (not <Link>s) so the browser's native anchor-drag
// doesn't fight ours; click navigates. Floating local time lives in
// properties.scheduledTime; the day in scheduled_date (or due_date when placing
// by due). Desktop = HTML5 drag + pointer resize; touch = long-press move.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { openItem } from "@/lib/item-nav";
import { addDaysYmd, ymdToUtcDate } from "@/lib/recurrence";
import {
  DEFAULT_DURATION_MINUTES,
  parseScheduledTime,
  startMinutes,
  splitMinutes,
  formatTime12,
  formatRange,
  formatDuration,
} from "@/lib/scheduled-time";
import { blockHeightPx, blockTopPx, durationFromResizePx } from "@/lib/planner-grid";
import { layoutOverlaps } from "@/lib/planner-overlap";
import { edgeAutoScrollVelocity } from "@/lib/board-touch-drag";
import UnscheduledRail from "@/components/planner/UnscheduledRail";
import CompleteButton from "@/components/planner/CompleteButton";
import QuickCreateInput from "@/components/planner/QuickCreateInput";
import { usePlannerTouchDrag } from "@/components/planner/usePlannerTouchDrag";
import { usePlannerComplete } from "@/components/planner/usePlannerComplete";
import { usePlannerCreate } from "@/components/planner/usePlannerCreate";
import type { ViewItem } from "@/components/views/ViewRenderer";
import type { DateProperty, PlaceBy, ViewDisplay } from "@/lib/views";
import { DISPLAY_DEFAULTS } from "@/lib/views";
import type { OverlayEvent } from "@/lib/calendar/overlay";
import type { StatusDef } from "@/lib/status";

const RAIL = "__none__";
const HOUR_PX = 48;
const GUTTER = 52; // time-label column width
const HEADER_H = 40; // day-header row height
const ALLDAY_H = 56; // all-day band height
const RANGE_DAYS = 28; // how many days are rendered for horizontal scrolling
const pad = (n: number) => String(n).padStart(2, "0");
const ymdToIso = (ymd: string) => `${ymd}T00:00:00.000Z`;
const utcKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
const dayHeadFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const monthShortFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

type Notify = (text: string, undo?: () => void) => void;
type Placement = { ymd: string | null; start: string | null; dur: number };

function localNowMinutes(): number {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

// A month/year label for the visible day window: "July 2026", "Jun – Aug 2026",
// or with years when the window straddles a year boundary.
function rangeLabel(fromYmd: string, toYmd: string): string {
  const f = ymdToUtcDate(fromYmd);
  const t = ymdToUtcDate(toYmd);
  const fy = f.getUTCFullYear();
  const ty = t.getUTCFullYear();
  const fm = f.getUTCMonth();
  const tm = t.getUTCMonth();
  if (fy === ty && fm === tm) {
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(f);
  }
  if (fy === ty) return `${monthShortFmt.format(f)} – ${monthShortFmt.format(t)} ${fy}`;
  return `${monthShortFmt.format(f)} ${fy} – ${monthShortFmt.format(t)} ${ty}`;
}

export default function PlannerTimeGrid({
  items,
  prop,
  placeBy,
  display,
  showUnscheduled = true,
  calendarEvents,
  statuses,
  notify,
  anchor,
  setAnchor,
  today,
}: {
  items: ViewItem[];
  prop: DateProperty | null;
  placeBy: PlaceBy;
  display: ViewDisplay | null;
  showUnscheduled?: boolean;
  calendarEvents?: OverlayEvent[];
  statuses?: StatusDef[];
  notify: Notify;
  anchor: string;
  setAnchor: (ymd: string) => void;
  // App-timezone "today" (YYYY-MM-DD) from the server, so the "today" column
  // marker is deterministic across SSR/hydration (see PlannerCalendar).
  today: string;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragPos = useRef<{ x: number; y: number } | null>(null);
  const handleResizing = useRef(false);
  const justResized = useRef(false);
  const scrollRaf = useRef(0);
  const [colWidth, setColWidth] = useState(170);
  const [scrollLeftPx, setScrollLeftPx] = useState(0);
  const [override, setOverride] = useState<Record<string, Placement>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [creatingSlot, setCreatingSlot] = useState<{ ymd: string; start: string } | null>(null);
  const [nowMin, setNowMin] = useState(localNowMinutes);
  // The "now" line's position is the browser's local time-of-day, which the
  // server can't know — so it's held out of SSR and the first client render
  // (both mounted=false) and revealed after mount, avoiding a hydration
  // mismatch on its `top` style.
  const [mounted, setMounted] = useState(false);
  const { effectiveDone, toggle } = usePlannerComplete(statuses, notify);
  const { create, busy: createBusy } = usePlannerCreate(notify);

  const dayCount = display?.dayCount ?? DISPLAY_DEFAULTS.dayCount;
  const slotMinutes = display?.slotMinutes ?? DISPLAY_DEFAULTS.slotMinutes;
  const workStart = display?.workStartHour ?? DISPLAY_DEFAULTS.workStartHour;
  const slotPx = (HOUR_PX * slotMinutes) / 60;
  const fullRows = Math.round((24 * 60) / slotMinutes);
  const colHeight = 24 * HOUR_PX;

  const field: "scheduledDate" | "dueDate" =
    prop === "dueDate" ? "dueDate" : prop === "scheduledDate" ? "scheduledDate" : placeBy === "due" ? "dueDate" : "scheduledDate";

  const byId = new Map(items.map((it) => [it.id, it]));
  function stored(item: ViewItem): Placement {
    const d = prop === "dueDate" ? item.dueDate : prop === "scheduledDate" ? item.scheduledDate : (item.scheduledDate ?? item.dueDate);
    const st = parseScheduledTime(item.properties);
    return { ymd: d ? utcKey.format(d) : null, start: st?.start ?? null, dur: st?.durationMinutes ?? DEFAULT_DURATION_MINUTES };
  }
  const place = (item: ViewItem): Placement =>
    Object.prototype.hasOwnProperty.call(override, item.id) ? override[item.id] : stored(item);

  const todayYmd = today;
  const days = Array.from({ length: RANGE_DAYS }, (_, i) => addDaysYmd(anchor, i));
  const dayset = new Set(days);

  const allDayByDay = new Map<string, ViewItem[]>();
  const timedByDay = new Map<string, ViewItem[]>();
  const unscheduled: ViewItem[] = [];
  for (const item of items) {
    const p = place(item);
    if (!p.ymd) {
      unscheduled.push(item);
      continue;
    }
    if (!dayset.has(p.ymd)) continue;
    const map = p.start ? timedByDay : allDayByDay;
    if (!map.has(p.ymd)) map.set(p.ymd, []);
    map.get(p.ymd)!.push(item);
  }

  // Read-only synced calendar events, split into all-day (the band) and timed
  // (positioned blocks), bucketed by their (app-tz) day. Context to plan
  // around — never draggable; timed blocks are pointer-events-none so a task
  // can still be dropped onto the slot underneath them.
  const eventAllDayByDay = new Map<string, OverlayEvent[]>();
  const eventTimedByDay = new Map<string, OverlayEvent[]>();
  for (const ev of calendarEvents ?? []) {
    if (!dayset.has(ev.ymd)) continue;
    const map = ev.start ? eventTimedByDay : eventAllDayByDay;
    if (!map.has(ev.ymd)) map.set(ev.ymd, []);
    map.get(ev.ymd)!.push(ev);
  }

  // Fit dayCount columns to the viewport; extra days overflow → horizontal scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setColWidth(Math.max(150, Math.floor((el.clientWidth - GUTTER) / dayCount)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dayCount]);

  // On anchor change (nav / month "+N more"): reset horizontal scroll to day 0,
  // and open vertically near "now" if today is visible, else the work window.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = 0;
    el.scrollTop = dayset.has(todayYmd)
      ? Math.max(0, (nowMin / 60) * HOUR_PX - 3 * HOUR_PX)
      : workStart * HOUR_PX;
    // nowMin/dayset intentionally read once here (initial position); re-running
    // every minute would yank the scroll out from under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, workStart]);

  // Reveal the "now" line after mount (it's browser-local time, held out of SSR
  // to avoid a hydration mismatch — see `mounted`) and advance it each minute.
  // The `nowMin` initializer already reads the client clock on hydration, so no
  // resync is needed here. Same set-state-on-mount pattern as PlannerCalendar's
  // localStorage read.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    const id = setInterval(() => setNowMin(localNowMinutes()), 60000);
    return () => clearInterval(id);
  }, []);

  // Edge auto-scroll while dragging (both axes), Notion-style.
  useEffect(() => {
    if (!dragId) return;
    let raf = 0;
    const tick = () => {
      const el = scrollRef.current;
      const p = dragPos.current;
      if (el && p) {
        const r = el.getBoundingClientRect();
        const left = edgeAutoScrollVelocity(p.x - r.left);
        const right = edgeAutoScrollVelocity(r.right - p.x);
        if (left > 0) el.scrollLeft -= left * 1.5;
        else if (right > 0) el.scrollLeft += right * 1.5;
        const up = edgeAutoScrollVelocity(p.y - r.top);
        const down = edgeAutoScrollVelocity(r.bottom - p.y);
        if (up > 0) el.scrollTop -= up;
        else if (down > 0) el.scrollTop += down;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragId]);

  // Commit a drop. `announce` off for the undo re-drop so undo doesn't re-toast.
  async function commitDrop(id: string | null, key: string | null, announce = true) {
    setDragId(null);
    setOverKey(null);
    if (!id || key === null) return;
    const item = byId.get(id);
    if (!item) return;
    const cur = place(item);
    let next: Placement;
    let body: Record<string, unknown>;
    if (key === RAIL) {
      next = { ymd: null, start: null, dur: cur.dur };
      body = { [field]: null, propertyPatch: { scheduledTime: null } };
    } else {
      const m = key.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/);
      if (!m) return;
      const ymd = m[1];
      const start = m[2] ?? null;
      if (ymd === cur.ymd && start === cur.start) return;
      if (start) {
        const dur = cur.dur || DEFAULT_DURATION_MINUTES;
        next = { ymd, start, dur };
        body = { [field]: ymdToIso(ymd), propertyPatch: { scheduledTime: { start, durationMinutes: dur } } };
      } else {
        next = { ymd, start: null, dur: cur.dur };
        body = { [field]: ymdToIso(ymd), propertyPatch: { scheduledTime: null } };
      }
    }
    setOverride((o) => ({ ...o, [id]: next }));
    try {
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
      if (announce) {
        const where = next.ymd
          ? `${monthShortFmt.format(ymdToUtcDate(next.ymd))} ${Number(next.ymd.slice(8))}${next.start ? ` ${formatTime12(next.start)}` : ""}`
          : "Unscheduled";
        notify(`Moved “${item.title || "Untitled"}” → ${where}`, () => {
          // Re-apply the exact prior placement (day + time), not just a day key.
          setOverride((o) => ({ ...o, [id]: cur }));
          const undoBody = cur.ymd
            ? { [field]: ymdToIso(cur.ymd), propertyPatch: { scheduledTime: cur.start ? { start: cur.start, durationMinutes: cur.dur } : null } }
            : { [field]: null, propertyPatch: { scheduledTime: null } };
          fetch(`/api/items/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(undoBody),
          })
            .then((r) => {
              if (r.ok) router.refresh();
            })
            .catch(() => {});
        });
      }
    } catch {
      setOverride((o) => {
        const nx = { ...o };
        delete nx[id];
        return nx;
      });
    }
  }

  function startResize(e: React.PointerEvent, item: ViewItem) {
    e.preventDefault();
    e.stopPropagation();
    const p = place(item);
    if (!p.start) return;
    handleResizing.current = true;
    setResizingId(item.id);
    const startY = e.clientY;
    const startHeight = blockHeightPx(p.dur, slotMinutes, slotPx);
    let dur = p.dur;
    const move = (ev: PointerEvent) => {
      dur = durationFromResizePx(startHeight + (ev.clientY - startY), slotMinutes, slotPx);
      setOverride((o) => ({ ...o, [item.id]: { ymd: p.ymd, start: p.start, dur } }));
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handleResizing.current = false;
      setResizingId(null);
      justResized.current = true; // suppress the click that follows pointerup
      try {
        const res = await fetch(`/api/items/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyPatch: { scheduledTime: { start: p.start, durationMinutes: dur } } }),
        });
        if (!res.ok) throw new Error(String(res.status));
        router.refresh();
      } catch {
        setOverride((o) => {
          const nx = { ...o };
          delete nx[item.id];
          return nx;
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  usePlannerTouchDrag(containerRef, {
    onArm: (id) => setDragId(id),
    onOver: (key) => setOverKey(key),
    onDrop: (key) => commitDrop(dragId, key),
    onCancel: () => {
      setDragId(null);
      setOverKey(null);
    },
  });

  const dropProps = (key: string) => ({
    "data-day": key,
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overKey !== key) setOverKey(key);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      commitDrop(e.dataTransfer.getData("text/plain") || dragId, key);
    },
  });

  function dragProps(id: string) {
    return {
      "data-card-id": id,
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        if (handleResizing.current) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
        setDragId(id);
      },
      onDragEnd: () => {
        setDragId(null);
        setOverKey(null);
        dragPos.current = null;
      },
      onClick: () => {
        if (justResized.current) {
          justResized.current = false;
          return;
        }
        openItem(router, id);
      },
    };
  }

  const navBtn = "rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200";
  const totalWidth = GUTTER + days.length * colWidth;
  // Which day window is on screen right now (from horizontal scroll), for the
  // header's month/year label.
  const firstIdx = Math.min(days.length - 1, Math.max(0, Math.round(scrollLeftPx / colWidth)));
  const lastIdx = Math.min(days.length - 1, firstIdx + dayCount - 1);
  // Duration of the block being dragged, for the drop-time preview label.
  const draggedDur = dragId ? place(byId.get(dragId) ?? ({} as ViewItem))?.dur || DEFAULT_DURATION_MINUTES : DEFAULT_DURATION_MINUTES;

  return (
    <div ref={containerRef} className="mt-4 flex flex-col gap-3 sm:flex-row">
      {showUnscheduled && (
      <UnscheduledRail
        items={unscheduled}
        dropProps={dropProps(RAIL)}
        highlight={overKey === RAIL}
        renderChip={(item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            title={item.title || "Untitled"}
            {...dragProps(item.id)}
            className={`group flex cursor-grab touch-none select-none items-center gap-1 rounded px-1 py-0.5 text-[11px] ${effectiveDone(item) ? "text-neutral-500 line-through" : "text-neutral-300"} ${dragId === item.id ? "opacity-40" : ""}`}
            style={{ backgroundColor: "rgb(38 38 38)" }}
          >
            <CompleteButton done={effectiveDone(item)} onToggle={() => toggle(item)} />
            <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
          </div>
        )}
      />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-neutral-300">{rangeLabel(days[firstIdx], days[lastIdx])}</p>
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => setAnchor(addDaysYmd(anchor, -dayCount))} aria-label="Previous" className={navBtn}>‹</button>
            {anchor !== todayYmd && (
              <button onClick={() => setAnchor(todayYmd)} className={navBtn}>Today</button>
            )}
            <button onClick={() => setAnchor(addDaysYmd(anchor, dayCount))} aria-label="Next" className={navBtn}>›</button>
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (scrollRaf.current) return;
            scrollRaf.current = requestAnimationFrame(() => {
              scrollRaf.current = 0;
              setScrollLeftPx(el.scrollLeft);
            });
          }}
          onDragOver={(e) => {
            e.preventDefault();
            dragPos.current = { x: e.clientX, y: e.clientY };
          }}
          className="mt-2 overflow-auto rounded-lg border border-neutral-800"
          style={{ maxHeight: "calc(100dvh - 210px)" }}
        >
          <div style={{ width: totalWidth }}>
            {/* Day headers (sticky top) */}
            <div className="sticky top-0 z-20 flex bg-neutral-900" style={{ height: HEADER_H }}>
              <div className="sticky left-0 z-30 shrink-0 bg-neutral-900" style={{ width: GUTTER }} />
              {days.map((ymd) => {
                const isToday = ymd === todayYmd;
                const dnum = Number(ymd.slice(8));
                return (
                  <div key={ymd} className="shrink-0 border-l border-neutral-800 py-1 text-center" style={{ width: colWidth }}>
                    <span className="text-[10px] uppercase tracking-wide text-neutral-500">{dayHeadFmt.format(ymdToUtcDate(ymd))} </span>
                    <span className={`text-xs ${isToday ? "font-bold text-neutral-100" : "text-neutral-400"}`}>
                      {isToday ? (
                        <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1" style={{ backgroundColor: "var(--accent)", color: "var(--accent-fg, #fff)" }}>{dnum}</span>
                      ) : dnum === 1 ? (
                        `${monthShortFmt.format(ymdToUtcDate(ymd))} ${dnum}`
                      ) : (
                        dnum
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* All-day band (sticky, just below the headers) */}
            <div className="sticky z-10 flex border-b border-neutral-800 bg-neutral-950" style={{ top: HEADER_H, height: ALLDAY_H }}>
              <div className="sticky left-0 z-20 flex shrink-0 items-start justify-end bg-neutral-950 py-1 pr-1 text-[10px] text-neutral-600" style={{ width: GUTTER }}>all-day</div>
              {days.map((ymd) => (
                <div
                  key={ymd}
                  {...dropProps(ymd)}
                  className="shrink-0 overflow-y-auto border-l border-neutral-800 p-1"
                  style={{ width: colWidth, height: ALLDAY_H, ...(overKey === ymd ? { outline: "2px solid var(--accent)", outlineOffset: "-2px" } : {}) }}
                >
                  <div className="flex flex-col gap-0.5">
                    {(eventAllDayByDay.get(ymd) ?? []).map((ev) => (
                      <div
                        key={ev.id}
                        title={`${ev.title || "(busy)"}${ev.location ? ` · ${ev.location}` : ""}`}
                        className="block cursor-default select-none truncate rounded px-1 text-[11px] text-neutral-400"
                        style={{
                          backgroundColor: "color-mix(in srgb, #38bdf8 12%, rgb(23 23 23))",
                          borderLeft: "2px solid #38bdf8",
                        }}
                      >
                        {ev.title || "(busy)"}
                      </div>
                    ))}
                    {(allDayByDay.get(ymd) ?? []).map((item) => (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        title={item.title || "Untitled"}
                        {...dragProps(item.id)}
                        className={`group flex touch-none cursor-grab select-none items-center gap-1 rounded px-1 text-[11px] ${effectiveDone(item) ? "text-neutral-500 line-through" : "text-neutral-300"} ${dragId === item.id ? "opacity-40" : ""}`}
                        style={{ backgroundColor: "rgb(38 38 38)" }}
                      >
                        <CompleteButton done={effectiveDone(item)} onToggle={() => toggle(item)} />
                        <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Time body */}
            <div className="flex">
              {/* Hour gutter (sticky left) */}
              <div className="sticky left-0 z-10 shrink-0 bg-neutral-900" style={{ width: GUTTER, height: colHeight }}>
                <div className="relative h-full">
                  {Array.from({ length: 24 }, (_, h) => (
                    <span key={h} className="absolute right-1 text-[10px] text-neutral-600" style={{ top: h * HOUR_PX - 6 }}>
                      {h === 0 ? "" : formatTime12(`${pad(h)}:00`).replace(":00", "")}
                    </span>
                  ))}
                </div>
              </div>
              {/* Day columns */}
              {days.map((ymd) => {
                const timed = timedByDay.get(ymd) ?? [];
                // Split overlapping task blocks into side-by-side lanes so none
                // is hidden behind another.
                const layout = layoutOverlaps(
                  timed.flatMap((it) => {
                    const p = place(it);
                    if (!p.start) return [];
                    const s = startMinutes({ start: p.start, durationMinutes: p.dur });
                    return [{ id: it.id, startMin: s, endMin: s + p.dur }];
                  }),
                );
                return (
                <div key={ymd} className="relative shrink-0 border-l border-neutral-800" style={{ width: colWidth, height: colHeight }}>
                  {Array.from({ length: fullRows }, (_, r) => {
                    const hhmm = `${pad(Math.floor((r * slotMinutes) / 60))}:${pad((r * slotMinutes) % 60)}`;
                    const key = `${ymd}T${hhmm}`;
                    const onHour = (r * slotMinutes) % 60 === 0;
                    const isOver = overKey === key;
                    return (
                      <div
                        key={r}
                        {...dropProps(key)}
                        onClick={() => setCreatingSlot({ ymd, start: hhmm })}
                        className={`${onHour ? "border-b border-neutral-800/50" : "border-b border-neutral-800/20"} ${isOver ? "relative" : ""}`}
                        style={{ height: slotPx, ...(isOver ? { background: "color-mix(in srgb, var(--accent) 22%, transparent)" } : {}) }}
                      >
                        {isOver && dragId && (
                          <span className="pointer-events-none absolute left-1 top-0 z-30 rounded bg-neutral-900/90 px-1 text-[10px] text-neutral-200 shadow">
                            {formatTime12(hhmm)} – {formatTime12(splitMinutes(r * slotMinutes + draggedDur).hhmm)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {/* "Now" line in today's column (client-only, post-mount) */}
                  {mounted && ymd === todayYmd && (
                    <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2" style={{ top: (nowMin / 60) * HOUR_PX, borderColor: "var(--accent)" }}>
                      <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full" style={{ backgroundColor: "var(--accent)" }} />
                    </div>
                  )}
                  {(eventTimedByDay.get(ymd) ?? []).map((ev) => {
                    if (!ev.start) return null;
                    const top = Math.max(0, blockTopPx(startMinutes({ start: ev.start, durationMinutes: ev.durationMinutes }), 0, slotMinutes, slotPx));
                    const height = blockHeightPx(ev.durationMinutes, slotMinutes, slotPx);
                    // pointer-events-none: purely visual context, so a task can
                    // still be dropped onto the slot underneath an event.
                    return (
                      <div
                        key={ev.id}
                        title={`${formatTime12(ev.start)} · ${ev.title || "(busy)"}${ev.location ? ` · ${ev.location}` : ""}`}
                        className="pointer-events-none absolute left-0.5 right-0.5 z-0 overflow-hidden rounded px-1 text-[11px] text-neutral-300"
                        style={{
                          top,
                          height,
                          backgroundColor: "color-mix(in srgb, #38bdf8 14%, rgb(23 23 23))",
                          borderLeft: "2px solid #38bdf8",
                        }}
                      >
                        <div className="truncate">{ev.title || "(busy)"}</div>
                        <div className="truncate text-[10px] text-neutral-500">{formatTime12(ev.start)}</div>
                      </div>
                    );
                  })}
                  {timed.map((item) => {
                    const p = place(item);
                    if (!p.start) return null;
                    const top = Math.max(0, blockTopPx(startMinutes({ start: p.start, durationMinutes: p.dur }), 0, slotMinutes, slotPx));
                    const height = blockHeightPx(p.dur, slotMinutes, slotPx);
                    const lay = layout.get(item.id) ?? { left: 0, width: 1 };
                    const done = effectiveDone(item);
                    return (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        title={item.title || "Untitled"}
                        {...dragProps(item.id)}
                        className={`group absolute z-[1] overflow-hidden rounded px-1 text-[11px] ${done ? "text-neutral-500 line-through" : "text-neutral-100"} ${dragId === item.id ? "opacity-40" : ""}`}
                        style={{
                          top,
                          height,
                          left: `calc(${lay.left * 100}% + 1px)`,
                          width: `calc(${lay.width * 100}% - 2px)`,
                          backgroundColor: "color-mix(in srgb, var(--accent) 30%, rgb(23 23 23))",
                          borderLeft: "2px solid var(--accent)",
                        }}
                      >
                        <div className="flex items-center gap-1">
                          <CompleteButton done={done} onToggle={() => toggle(item)} />
                          <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
                        </div>
                        <div className="truncate text-[10px] text-neutral-400">
                          {formatRange({ start: p.start, durationMinutes: p.dur })}
                          {resizingId === item.id ? ` · ${formatDuration(p.dur)}` : ""}
                        </div>
                        <div
                          onPointerDown={(e) => startResize(e, item)}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                          style={{ background: "color-mix(in srgb, var(--accent) 60%, transparent)" }}
                          aria-label="Resize"
                        />
                      </div>
                    );
                  })}
                  {/* Inline quick-create at the clicked slot */}
                  {creatingSlot?.ymd === ymd && (
                    <div
                      className="absolute left-0.5 right-0.5 z-40 rounded border border-[color:var(--accent)] bg-neutral-900 p-0.5"
                      style={{
                        top: Math.max(0, blockTopPx(startMinutes({ start: creatingSlot.start, durationMinutes: DEFAULT_DURATION_MINUTES }), 0, slotMinutes, slotPx)),
                        height: blockHeightPx(DEFAULT_DURATION_MINUTES, slotMinutes, slotPx),
                      }}
                    >
                      <div className="mb-0.5 px-1 text-[10px] text-neutral-500">{formatTime12(creatingSlot.start)}</div>
                      <QuickCreateInput
                        busy={createBusy}
                        onSubmit={async (title) => {
                          const ok = await create({ ymd: creatingSlot.ymd, start: creatingSlot.start, durationMinutes: DEFAULT_DURATION_MINUTES }, title);
                          if (ok) setCreatingSlot(null);
                        }}
                        onCancel={() => setCreatingSlot(null)}
                      />
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
