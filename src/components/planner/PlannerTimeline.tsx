// Timeline mode (ADR-166): one continuous horizontal time axis, zoomable from
// Hour to 5-Year, that renders ANY dated item via the placement layer. A
// single-date item is a chip on its day; a start+end item is a bar; overlapping
// items pack into vertical lanes (so the region grows taller). It consumes
// placements and never reads a date field directly, so it works for tasks,
// events, notes, and custom date props alike.
//
// Slice 4 makes it writable: drag a chip/bar to move (a bar preserves its span),
// grab a bar's front/back edge to resize, drop onto the Unscheduled rail to
// clear the date, or drag a rail chip onto the axis to schedule it. All edits go
// through placement.buildPatch (the same seam the verify script covers) and the
// applyTimelineDrag geometry; an item missing a capability just doesn't offer
// that affordance (a read-only created-date anchor is shown but not grabbable).
// One pointer path serves mouse and touch (touch-action:none + pointer capture),
// with an optimistic override + undo toast, mirroring PlannerTimeGrid.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { openItem } from "@/lib/item-nav";
import CompleteButton from "@/components/planner/CompleteButton";
import UnscheduledRail from "@/components/planner/UnscheduledRail";
import { usePlannerComplete } from "@/components/planner/usePlannerComplete";
import { edgeAutoScrollVelocity } from "@/lib/board-touch-drag";
import {
  resolvePlacement,
  buildPatch,
  deriveSpec,
  type Anchor,
  type PlaceableItem,
} from "@/lib/placement";
import {
  addDays,
  dateToX,
  xToDate,
  daysBetween,
  pxPerDay,
  ticks,
  applyTimelineDrag,
  type TimelineDragKind,
} from "@/lib/timeline-geometry";
import { layoutOverlaps } from "@/lib/planner-overlap";
import { formatTime12 } from "@/lib/scheduled-time";
import type { ViewItem } from "@/components/views/ViewRenderer";
import type { DateProperty, PlaceBy, ViewDisplay, TimelineZoom } from "@/lib/views";
import { DISPLAY_DEFAULTS, TIMELINE_ZOOMS } from "@/lib/views";
import type { OverlayEvent } from "@/lib/calendar/overlay";
import type { StatusDef } from "@/lib/status";

type Notify = (text: string, undo?: () => void) => void;

const LANE_H = 32; // px per stacked lane (row), including its gap
const CHIP_MIN = 120; // min chip width at FINE zoom so a point stays readable + grabbable
const DOT_W = 16; // compact chip width at COARSE zoom (label overflows to the right)
const COARSE_PPD = 100; // px-per-day below this = coarse zoom (month and out)
const RULER_H = 34;
const MOVE_THRESHOLD = 4; // px before a press becomes a drag (else it's a click)

// Days of breathing room on each side of the data range, per zoom.
const PAD: Record<TimelineZoom, number> = {
  hour: 1,
  day: 2,
  week: 5,
  month: 14,
  quarter: 45,
  year: 120,
  halfDecade: 365,
};
// A friendly label for the zoom buttons.
const ZOOM_LABEL: Record<TimelineZoom, string> = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  halfDecade: "5-Year",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// An anchor → "Jul 21" or "Jul 21 2:30 PM" for the move toast.
function labelAnchor(a: Anchor): string {
  const [, m, d] = a.ymd.split("-").map(Number);
  const base = `${MONTHS[m - 1]} ${d}`;
  return a.minutes != null ? `${base} ${formatTime12(minToHhmm(a.minutes))}` : base;
}

type Placed = { item: ViewItem; start: Anchor; end: Anchor | null; can: Placement["can"] };
type Placement = ReturnType<typeof resolvePlacement>;
type Override = { start: Anchor | null; end: Anchor | null };

export default function PlannerTimeline({
  items,
  prop,
  display,
  showUnscheduled,
  statuses,
  notify,
  today,
  tz,
  focusDay,
}: {
  items: ViewItem[];
  prop: DateProperty | null;
  placeBy: PlaceBy;
  display: ViewDisplay | null;
  showUnscheduled: boolean;
  calendarEvents?: OverlayEvent[];
  statuses?: StatusDef[];
  notify: Notify;
  today: string;
  tz: string;
  // A day to center the axis on when it changes (e.g. the month grid opening a
  // day here after Multi-day's retirement, ADR-166 slice 5). Falls back to today.
  focusDay?: string | null;
}) {
  const router = useRouter();
  const [zoom, setZoom] = useState<TimelineZoom>(display?.zoom ?? DISPLAY_DEFAULTS.zoom);
  const { effectiveDone, toggle } = usePlannerComplete(statuses, notify);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const spec = useMemo(() => deriveSpec(prop, display), [prop, display]);

  // Optimistic placement while a drag is in flight / awaiting the server; keyed
  // by item id. Kept after a successful commit (it matches the refreshed server
  // data); dropped only on failure or undo.
  const [override, setOverride] = useState<Record<string, Override>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overRail, setOverRail] = useState(false);

  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  // Server-truth placements (ignore override) drive the axis WINDOW, so a live
  // drag never shifts the coordinate system under the pointer.
  const resolved = useMemo(() => {
    const map = new Map<string, Placement>();
    for (const item of items) map.set(item.id, resolvePlacement(item as unknown as PlaceableItem, spec, tz));
    return map;
  }, [items, spec, tz]);

  // Effective placements (override-aware) drive rendering.
  const { placed, rail } = useMemo(() => {
    const placed: Placed[] = [];
    const rail: ViewItem[] = [];
    for (const item of items) {
      const base = resolved.get(item.id)!;
      const o = override[item.id];
      const start = o ? o.start : base.start;
      const end = o ? o.end : base.end;
      if (start) placed.push({ item, start, end, can: base.can });
      else rail.push(item);
    }
    return { placed, rail };
  }, [items, resolved, override]);

  // The axis window: the server-truth data range (plus today) padded by the
  // zoom, clamped so a fine zoom over a wide range can't blow up the canvas.
  const ppd = pxPerDay(zoom);
  const { originYmd, spanDays } = useMemo(() => {
    let min = today;
    let max = today;
    for (const base of resolved.values()) {
      if (base.start) {
        if (base.start.ymd < min) min = base.start.ymd;
        if (base.start.ymd > max) max = base.start.ymd;
      }
      if (base.end) {
        if (base.end.ymd < min) min = base.end.ymd;
        if (base.end.ymd > max) max = base.end.ymd;
      }
    }
    let origin = addDays(min, -PAD[zoom]);
    const rawSpan = daysBetween(origin, addDays(max, PAD[zoom])) + 1;
    const maxSpan = Math.max(7, Math.floor(60000 / ppd));
    if (rawSpan > maxSpan) {
      origin = addDays(today, -Math.floor(maxSpan / 2));
      return { originYmd: origin, spanDays: maxSpan };
    }
    return { originYmd: origin, spanDays: rawSpan };
  }, [resolved, today, zoom, ppd]);

  const contentWidth = spanDays * ppd;
  const coarse = ppd < COARSE_PPD; // month zoom and out
  const ruler = useMemo(() => ticks(originYmd, spanDays, zoom), [originYmd, spanDays, zoom]);

  // Lane-pack placed items by their pixel intervals so overlaps stack vertically.
  // At FINE zoom a chip reserves a readable CHIP_MIN so lanes reflect legible
  // chips. At COARSE zoom (a 1-day chip would otherwise be forced to CHIP_MIN and
  // span weeks, inflating lane count) items pack by their TRUE day-extent, render
  // as a compact dot, and let the label overflow to the right instead.
  const { boxes, laneCount } = useMemo(() => {
    const geom = placed.map((p) => {
      const sx = dateToX(p.start.ymd, p.start.minutes, originYmd, zoom);
      const ex = p.end ? dateToX(p.end.ymd, p.end.minutes, originYmd, zoom) : sx;
      return { sx, gx: Math.max(0, ex - sx) };
    });
    const packW = (i: number) => (coarse ? Math.max(3, geom[i].gx) : Math.max(CHIP_MIN, geom[i].gx));
    const layout = layoutOverlaps(
      placed.map((p, i) => ({ id: p.item.id, startMin: geom[i].sx, endMin: geom[i].sx + packW(i) })),
    );
    const boxes = placed.map((p, i) => {
      const lay = layout.get(p.item.id) ?? { left: 0, width: 1 };
      const lanes = Math.max(1, Math.round(1 / lay.width));
      const lane = Math.round(lay.left / lay.width);
      const isBar = p.end != null;
      // A bar keeps its real extent (min a few px); a chip is a readable pill at
      // fine zoom, a compact dot (label overflowing) at coarse zoom.
      const width = isBar ? Math.max(coarse ? 3 : 8, geom[i].gx) : coarse ? DOT_W : CHIP_MIN;
      return { p, sx: geom[i].sx, width, lane, lanes, isBar };
    });
    const laneCount = boxes.reduce((m, b) => Math.max(m, b.lanes), 1);
    return { boxes, laneCount };
  }, [placed, originYmd, zoom, coarse]);

  const todayX = dateToX(today, null, originYmd, zoom);
  const focusX = focusDay ? dateToX(focusDay, null, originYmd, zoom) : todayX;

  // Center the view on the focus day (or today) after mount + whenever the zoom
  // or focus day changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, focusX - el.clientWidth / 3);
  }, [focusX, zoom]);

  // --- drag plumbing -------------------------------------------------------

  // The in-flight drag. Everything the geometry needs (origin/zoom) is frozen
  // here at press time, so scrolling or state churn mid-drag can't shift the
  // mapping. The window pointer listeners are (re)bound per press.
  const drag = useRef<{
    id: string;
    kind: TimelineDragKind;
    fromRail: boolean;
    pointerId: number;
    startX: number;
    origStart: Anchor | null;
    origEnd: Anchor | null;
    before: Override; // the committed placement, for undo
    origin: string;
    zoom: TimelineZoom;
    moved: boolean;
  } | null>(null);
  const ptr = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const contentX = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clientX - r.left + el.scrollLeft;
  }, []);
  const inRect = (ref: React.RefObject<HTMLElement | null>, x: number, y: number) => {
    const el = ref.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  // What the drag resolves to at a given pointer position (frozen origin/zoom).
  const computeNext = useCallback(
    (d: NonNullable<typeof drag.current>, x: number, y: number): { next: Override; onRail: boolean } => {
      if (d.fromRail) {
        const onAxis = inRect(scrollRef, x, y);
        if (!onAxis) return { next: { start: null, end: null }, onRail: true };
        const a = xToDate(contentX(x), d.origin, d.zoom);
        return { next: { start: a, end: null }, onRail: false };
      }
      if (inRect(railRef, x, y)) {
        // Freeze the axis position; the drop will unschedule.
        return { next: { start: d.origStart, end: d.origEnd }, onRail: true };
      }
      const dx = x - d.startX;
      const res = applyTimelineDrag(d.kind, d.origin, d.origStart!, d.origEnd, dx, d.zoom);
      return { next: res, onRail: false };
    },
    [contentX],
  );

  const commit = useCallback(
    (item: ViewItem, before: Override, next: Override) => {
      const body = buildPatch(item as unknown as PlaceableItem, spec, tz, next);
      setOverride((o) => ({ ...o, [item.id]: next }));
      fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          router.refresh();
          const label = next.start
            ? `Moved “${item.title || "Untitled"}” → ${labelAnchor(next.start)}`
            : `Unscheduled “${item.title || "Untitled"}”`;
          notify(label, () => {
            setOverride((o) => ({ ...o, [item.id]: before }));
            fetch(`/api/items/${item.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(buildPatch(item as unknown as PlaceableItem, spec, tz, before)),
            })
              .then((r) => {
                if (r.ok) router.refresh();
              })
              .catch(() => {});
          });
        })
        .catch(() => {
          setOverride((o) => {
            const n = { ...o };
            delete n[item.id];
            return n;
          });
        });
    },
    [spec, tz, router, notify],
  );

  // A press begins a drag. The move/up handlers live here so they close over a
  // frozen origin/zoom (the coordinate system can't shift mid-drag) and are torn
  // down together via one AbortController — no cross-referencing useCallbacks.
  const beginDrag = useCallback(
    (e: React.PointerEvent, item: ViewItem, kind: TimelineDragKind, fromRail: boolean, p?: Placed) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (drag.current) return; // one pointer at a time
      if (!fromRail && p) {
        if (kind === "move" && !p.can.move) return;
        if (kind === "resizeStart" && !p.can.resizeStart) return;
        if (kind === "resizeEnd" && !p.can.resizeEnd) return;
      }
      // Keep the drag glued to this pointer even if it leaves the element.
      // Guarded: setPointerCapture throws on an inactive pointer id.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* no capture available; window listeners still track the pointer */
      }
      const base = resolved.get(item.id);
      const ac = new AbortController();
      const d = {
        id: item.id,
        kind,
        fromRail,
        pointerId: e.pointerId,
        startX: e.clientX,
        origStart: p ? p.start : null,
        origEnd: p ? p.end : null,
        before: { start: base?.start ?? null, end: base?.end ?? null } as Override,
        origin: originYmd,
        zoom,
        moved: false,
      };
      drag.current = d;
      ptr.current = { x: e.clientX, y: e.clientY };

      const finish = () => {
        ac.abort();
        drag.current = null;
        setDragId(null);
        setOverRail(false);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== d.pointerId) return;
        ptr.current = { x: ev.clientX, y: ev.clientY };
        if (!d.moved) {
          if (Math.abs(ev.clientX - d.startX) < MOVE_THRESHOLD) return;
          d.moved = true;
          setDragId(d.id);
        }
        ev.preventDefault();
        const { next, onRail } = computeNext(d, ev.clientX, ev.clientY);
        setOverRail(onRail && !d.fromRail);
        setOverride((o) => ({ ...o, [d.id]: next }));
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== d.pointerId) return;
        const item = byId.get(d.id);
        const moved = d.moved;
        const result = moved ? computeNext(d, ev.clientX, ev.clientY) : null;
        finish();
        if (!item) return;
        if (!moved) {
          openItem(router, d.id); // a press without a drag opens it
          return;
        }
        const { next, onRail } = result!;
        if (d.fromRail && onRail) {
          // Dropped a rail chip without reaching the axis → leave it unscheduled.
          setOverride((o) => {
            const n = { ...o };
            delete n[d.id];
            return n;
          });
          return;
        }
        commit(item, d.before, !d.fromRail && onRail ? { start: null, end: null } : next);
      };

      window.addEventListener("pointermove", onMove, { signal: ac.signal });
      window.addEventListener("pointerup", onUp, { signal: ac.signal });
      window.addEventListener("pointercancel", onUp, { signal: ac.signal });
    },
    [resolved, originYmd, zoom, byId, computeNext, commit, router],
  );

  // Edge auto-scroll: while dragging near the viewport's left/right edge, pan.
  useEffect(() => {
    if (!dragId) return;
    let raf = 0;
    const tick = () => {
      const el = scrollRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const left = edgeAutoScrollVelocity(ptr.current.x - r.left);
        const right = edgeAutoScrollVelocity(r.right - ptr.current.x);
        if (left > 0) el.scrollLeft -= left * 1.5;
        else if (right > 0) el.scrollLeft += right * 1.5;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragId]);

  const zoomBtn = (z: TimelineZoom) => (
    <button
      key={z}
      onClick={() => setZoom(z)}
      aria-pressed={zoom === z}
      className={`rounded px-2 py-0.5 text-[11px] ${
        zoom === z ? "text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
      }`}
      style={zoom === z ? { backgroundColor: "var(--accent)", color: "var(--accent-fg, #fff)" } : undefined}
    >
      {ZOOM_LABEL[z]}
    </button>
  );

  return (
    <div className="mt-2">
      <div className="mb-2 flex items-center gap-1">
        <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-neutral-800 p-0.5">
          {TIMELINE_ZOOMS.map(zoomBtn)}
        </div>
        <button
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollLeft = Math.max(0, todayX - el.clientWidth / 3);
          }}
          className="ml-2 rounded border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
        >
          Today
        </button>
        <span className="ml-2 text-[11px] text-neutral-600">Drag to move · grab an edge to resize</span>
      </div>

      <div className="flex gap-2">
        {showUnscheduled && (
          <div ref={railRef}>
            <UnscheduledRail
              items={rail}
              dropProps={{}}
              highlight={overRail}
              renderChip={(item) => (
                <div
                  role="button"
                  tabIndex={0}
                  title={item.title || "Untitled"}
                  onPointerDown={(e) => beginDrag(e, item, "move", true)}
                  className={`flex touch-none cursor-grab select-none items-center gap-1 rounded bg-neutral-800 px-1 py-0.5 text-[11px] ${
                    effectiveDone(item) ? "text-neutral-500 line-through" : "text-neutral-300"
                  } ${dragId === item.id ? "opacity-40" : ""}`}
                >
                  <CompleteButton done={effectiveDone(item)} onToggle={() => toggle(item)} />
                  <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
                </div>
              )}
            />
          </div>
        )}

        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-neutral-800"
        >
          <div className="relative" style={{ width: contentWidth }}>
            {/* Ruler */}
            <div className="sticky top-0 z-20 bg-neutral-900" style={{ height: RULER_H }}>
              {ruler.map((t, i) => (
                <div
                  key={i}
                  className="absolute top-0 flex h-full flex-col justify-end border-l pb-1 pl-1"
                  style={{
                    left: t.x,
                    borderColor: t.major ? "rgb(64 64 64)" : "rgb(38 38 38)",
                  }}
                >
                  <span className={`whitespace-nowrap text-[10px] ${t.major ? "text-neutral-300" : "text-neutral-600"}`}>
                    {t.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Lanes area */}
            <div className="relative" style={{ height: Math.max(LANE_H * laneCount + 8, 80) }}>
              {/* gridlines under items */}
              {ruler.map((t, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 border-l"
                  style={{ left: t.x, borderColor: t.major ? "rgb(38 38 38)" : "rgb(28 28 28)" }}
                />
              ))}
              {/* today line */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-10 border-l-2"
                style={{ left: todayX, borderColor: "var(--accent)" }}
              />
              {/* items */}
              {boxes.map(({ p, sx, width, lane, isBar }) => {
                const done = effectiveDone(p.item);
                const dragging = dragId === p.item.id;
                const grabbable = p.can.move;
                return (
                  <div
                    key={p.item.id}
                    title={p.item.title || "Untitled"}
                    onPointerDown={(e) => beginDrag(e, p.item, "move", false, p)}
                    className={`group absolute z-[1] flex touch-none items-center gap-1 rounded px-1 text-[11px] ${
                      coarse ? "overflow-visible" : "overflow-hidden"
                    } ${grabbable ? "cursor-grab" : "cursor-pointer"} ${
                      done ? "text-neutral-500 line-through" : "text-neutral-100"
                    } ${dragging ? "opacity-60" : ""}`}
                    style={{
                      left: sx,
                      width,
                      top: lane * LANE_H,
                      height: LANE_H - 4,
                      backgroundColor: isBar
                        ? "color-mix(in srgb, var(--accent) 22%, rgb(23 23 23))"
                        : "color-mix(in srgb, var(--accent) 30%, rgb(23 23 23))",
                      borderLeft: "2px solid var(--accent)",
                    }}
                  >
                    {/* front edge (resizeStart) */}
                    {isBar && p.can.resizeStart && (
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          beginDrag(e, p.item, "resizeStart", false, p);
                        }}
                        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                        style={{ background: "color-mix(in srgb, var(--accent) 60%, transparent)" }}
                        aria-label="Resize start"
                      />
                    )}
                    <CompleteButton done={done} onToggle={() => toggle(p.item)} />
                    {/* At coarse zoom the label overflows the dot to the right (no
                        truncate) so a 1-day item stays a compact point, not a
                        CHIP_MIN-wide bar that would inflate the lane count. */}
                    <span className={`min-w-0 ${coarse ? "whitespace-nowrap" : "truncate"}`}>
                      {p.item.title || "Untitled"}
                    </span>
                    {p.start.minutes != null && !coarse && (
                      <span className="shrink-0 text-[10px] text-neutral-400">
                        {formatTime12(minToHhmm(p.start.minutes))}
                      </span>
                    )}
                    {/* back edge (resizeEnd) */}
                    {isBar && p.can.resizeEnd && (
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          beginDrag(e, p.item, "resizeEnd", false, p);
                        }}
                        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                        style={{ background: "color-mix(in srgb, var(--accent) 60%, transparent)" }}
                        aria-label="Resize end"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {placed.length === 0 && (
        <p className="mt-3 px-2 text-sm text-neutral-600">
          Nothing to place on the timeline for this view{rail.length ? " (all items are undated — toggle “Show unscheduled”)" : ""}.
        </p>
      )}
    </div>
  );
}

function minToHhmm(minutes: number): string {
  const within = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
}
