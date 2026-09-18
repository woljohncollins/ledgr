// The item-canvas grid (ADR-069, Feature B) — the graduated spike engine. One
// react-grid-layout grid for the whole item window, each field its own card.
// Every card's height follows its content (measured natural height → rows, fed
// back as RGL `h`); nothing scrolls inside a cell. The stored `mode` (flow/fixed,
// ADR-069) is still parsed for back-compat but no longer rendered — the fixed
// box produced scrollbars and dead space (ADR-256, 2026-09-11). The
// feedback loop is broken exactly as the /scratch/layout spike proved: measure
// the card's NATURAL height (never the RGL box), rAF-debounced, only re-set state
// when the row count changes.
//
// Client-only (RGL measures window width on mount) — loaded via next/dynamic
// ssr:false from ItemLayoutGrid, mirroring DashboardGridLayout → RglInner. The
// card *contents* are server components rendered by MarkdownCanvas and handed in
// as a Record<CardId, ReactNode>; this grid only positions them. Engine
// constants + the .dash-edit edit affordances are shared with the dashboards.
"use client";

import { useRouter } from "next/navigation";
import { openItem } from "@/lib/item-nav";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Responsive,
  WidthProvider,
  type Layout,
  type Layouts,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  BREAKPOINTS,
  GRID_BREAKPOINT_PX,
  GRID_COLS,
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  type Breakpoint,
  type CanvasLayout,
  type CardId,
  type CardMeta,
  type Cell,
} from "@/lib/canvas-layout";

const ResponsiveGridLayout = WidthProvider(Responsive);

// px of natural content → RGL rows (inverse of RGL's box math). Matches the
// spike; same ROW_HEIGHT/margin as the dashboards.
function rowsForHeight(px: number): number {
  const marginY = GRID_MARGIN[1];
  return Math.max(1, Math.ceil((px + marginY) / (GRID_ROW_HEIGHT + marginY)));
}

// The breakpoint RGL is rendering, by the grid container's width — mirroring
// RGL's own getBreakpointFromWidth (the largest breakpoint whose min-width is
// below the width). We recompute this ourselves rather than rely on
// onBreakpointChange, which fires ONLY on a change: when the grid mounts
// straight into `md` (the item modal, ~768px) no change event fires, so a
// hardcoded activeBp seed would stay "lg". The flow measurer would then write
// every card's measured height to `lg` while `md` renders with its stale
// placeholder heights — the body card keeps its 8-row box, its taller content
// overflows it (flow cards don't clip), and the cards below collapse onto the
// spillover. That is the "body runs into the properties section" overlap. Do
// not revert this to onBreakpointChange-only.
function bpForWidth(width: number): Breakpoint {
  const ascending = [...BREAKPOINTS].sort(
    (a, b) => GRID_BREAKPOINT_PX[a] - GRID_BREAKPOINT_PX[b]
  );
  let match = ascending[0];
  for (const bp of ascending) if (width > GRID_BREAKPOINT_PX[bp]) match = bp;
  return match;
}

function stripCell(c: Cell): Cell {
  return { i: c.i, x: c.x, y: c.y, w: c.w, h: c.h };
}

// One grid cell. It measures its own natural height and reports rows up. In
// arrange mode the card gets a frame + a header (drag handle, hide); read-only
// it's chrome-free so a customized item still reads like a document.
function CardCell({
  id,
  arrange,
  node,
  onRows,
  onHide,
}: {
  id: CardId;
  arrange: boolean;
  node: ReactNode;
  onRows: (id: CardId, rows: number) => void;
  onHide: (id: CardId) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRows = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rows = rowsForHeight(el.offsetHeight);
        if (rows !== lastRows.current) {
          lastRows.current = rows;
          onRows(id, rows);
        }
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [id, onRows]);

  return (
    <div
      ref={ref}
      className={`flex flex-col ${
        arrange ? "rounded-lg border border-neutral-800 bg-neutral-900/40" : ""
      }`}
    >
      {arrange && (
        // No per-card label (Brandon, 2026-06-17): the field/panel below names
        // itself, so the header is just the drag handle + hide. The drag handle takes the full width so the card is easy to grab.
        <header className="flex shrink-0 items-center gap-1.5 border-b border-neutral-800 px-2 py-1 text-xs">
          <span
            className="canvas-drag flex-1 cursor-grab select-none text-neutral-600"
            title="Drag to move"
            aria-hidden
          >
            ⠿
          </span>
          <button
            onClick={() => onHide(id)}
            className="cancel-drag shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-red-500 hover:text-red-300"
            title="Hide this card"
          >
            ✕
          </button>
        </header>
      )}
      {/* cancel-drag so typing/scrolling inside never starts a drag; the panels
          carry their own canvas chrome, neutralized by .canvas-card-content. */}
      <div
        className={`canvas-card-content cancel-drag min-h-0 ${arrange ? "p-2" : ""}`}
      >
        {node}
      </div>
    </div>
  );
}

export type ItemRglInnerProps = {
  itemId: string;
  typeKey: string;
  // Vocabulary order (all cards), the content nodes, and labels — built server-
  // side by MarkdownCanvas.
  order: CardId[];
  nodes: Record<CardId, ReactNode>;
  labels: Record<CardId, string>;
  initialLayout: CanvasLayout;
  arrange: boolean;
};

export default function ItemRglInner({
  itemId,
  typeKey,
  order,
  nodes,
  labels,
  initialLayout,
  arrange,
}: ItemRglInnerProps) {
  const router = useRouter();
  const [cards, setCards] = useState<Record<CardId, CardMeta>>(
    initialLayout.cards
  );
  const [cells, setCells] = useState<Record<Breakpoint, Cell[]>>(
    initialLayout.layouts
  );
  // Mirror the latest state into a ref so the debounced persist + the Done button
  // read current values without re-subscribing. Synced in an effect (not during
  // render) — handlers/timeouts run after commit, so the ref is always current.
  const stateRef = useRef({ cards, cells });
  useEffect(() => {
    stateRef.current = { cards, cells };
  }, [cards, cells]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Which responsive layout the user is editing (Brandon, 2026-06-17). The full-
  // page editor is the one place to arrange ALL breakpoints: this constrains the
  // grid container to a breakpoint's width so RGL switches to it and the user can
  // drag that layout (overriding the auto-derived md/sm). Default Desktop (lg).
  const [arrangeWidth, setArrangeWidth] = useState<Breakpoint>("lg");
  // RGL's WidthProvider measures the container only on mount and on window resize,
  // not when we change the container's max-width. Rather than nudge it (unreliable
  // — it can latch a stale/mid-change width), we remount the grid on width change
  // via a key (see the grid's `key` below): a fresh mount measures the already-
  // constrained container cleanly and picks the right breakpoint.
  // The breakpoint RGL is currently showing, so the flow measurer writes a card's
  // height to the right breakpoint only (heights differ by width). Seeded "lg"
  // but corrected to the real rendered breakpoint by a width measurement on mount
  // (see the layout effect below), because RGL won't report a breakpoint it
  // mounted directly into.
  const activeBp = useRef<Breakpoint>("lg");
  // Each flow card's last measured row count, so a breakpoint flip can re-seat
  // known heights onto the now-active breakpoint: a full-width card is the same
  // width across breakpoints, so its ResizeObserver doesn't re-fire on the flip
  // and the new breakpoint would otherwise keep its stale placeholder `h`.
  const measuredRows = useRef<Record<CardId, number>>({});
  // Wraps the grid so we can measure the rendered grid element's width.
  const wrapRef = useRef<HTMLDivElement>(null);

  const visibleIds = useMemo(
    () => order.filter((id) => nodes[id] != null && !cards[id]?.hidden),
    [order, nodes, cards]
  );
  const hiddenIds = useMemo(
    () => order.filter((id) => nodes[id] != null && cards[id]?.hidden),
    [order, nodes, cards]
  );

  // Build RGL's per-breakpoint Layouts from the stored cells (visible cards only),
  // with width-only resize handles so dragging the bottom edge can't fight the
  // auto-height.
  const layouts: Layouts = useMemo(() => {
    const out: Layouts = { lg: [], md: [], sm: [] };
    for (const bp of BREAKPOINTS) {
      const byId = new Map(cells[bp].map((c) => [c.i, c]));
      out[bp] = visibleIds.map((id): Layout => {
        const c = byId.get(id) ?? { i: id, x: 0, y: 9999, w: GRID_COLS[bp], h: 4 };
        return { ...c, minW: 2, resizeHandles: ["e", "w"] };
      });
    }
    return out;
  }, [cells, visibleIds]);

  const persist = useCallback(
    (cardsState: Record<CardId, CardMeta>, cellsState: Record<Breakpoint, Cell[]>) => {
      const layout: CanvasLayout = {
        version: 1,
        cards: cardsState,
        layouts: {
          lg: cellsState.lg.map(stripCell),
          md: cellsState.md.map(stripCell),
          sm: cellsState.sm.map(stripCell),
        },
      };
      return fetch(`/api/types/${encodeURIComponent(typeKey)}/layout`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout }),
      }).catch(() => {});
    },
    [typeKey]
  );

  const schedulePersist = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Clear the handle when it fires, so `timer.current` is non-null ONLY while
      // a real change is waiting to save — which is how Done knows whether to
      // commit (see below).
      timer.current = null;
      const s = stateRef.current;
      void persist(s.cards, s.cells);
    }, 600);
  }, [persist]);

  // Leave Arrange. Only flush a pending change — never force a fresh save — so
  // merely opening Arrange and clicking Done doesn't convert a classic item to a
  // grid one (Brandon, 2026-06-17). Any real drag/resize/pin/hide already
  // scheduled a save; this commits it immediately, then navigates.
  const handleDone = useCallback(() => {
    const go = () => openItem(router, itemId);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      const s = stateRef.current;
      void persist(s.cards, s.cells).then(go);
    } else {
      go();
    }
  }, [persist, itemId, router]);

  // Flow measurement: write the measured rows into `h` across breakpoints, only
  // when changed. Never persists — a flow height is ephemeral (re-measured on
  // load), so it must not write to the type's saved layout (the spike's lesson).
  const handleRows = useCallback((id: CardId, rows: number) => {
    // Only the breakpoint currently on screen — a card's natural height differs by
    // width, so a measurement at md shouldn't overwrite lg's height.
    measuredRows.current[id] = rows;
    const bp = activeBp.current;
    setCells((prev) => {
      let changed = false;
      const mapped = prev[bp].map((c) => {
        if (c.i === id && c.h !== rows) {
          changed = true;
          return { ...c, h: rows };
        }
        return c;
      });
      return changed ? { ...prev, [bp]: mapped } : prev;
    });
  }, []);

  // Re-seat every known measured height onto a breakpoint — run when the active
  // breakpoint flips so a card whose width didn't change (so its ResizeObserver
  // never re-fired) still gets its real height instead of the placeholder.
  const applyMeasured = useCallback((bp: Breakpoint) => {
    setCells((prev) => {
      let changed = false;
      const mapped = prev[bp].map((c) => {
        const m = measuredRows.current[c.i];
        if (m != null && c.h !== m) {
          changed = true;
          return { ...c, h: m };
        }
        return c;
      });
      return changed ? { ...prev, [bp]: mapped } : prev;
    });
  }, []);

  // Pin activeBp to the breakpoint actually on screen by measuring the rendered
  // grid element (what RGL's WidthProvider measures too). This is the fix for the
  // mount-at-md overlap: onBreakpointChange never fires for a directly-mounted
  // breakpoint, so without this the flow heights land on the wrong breakpoint and
  // the body overflows onto the cards below. Re-runs on arrange-width switch (the
  // grid remounts via its key, so the element to observe is new).
  useLayoutEffect(() => {
    const grid =
      wrapRef.current?.querySelector<HTMLElement>(".react-grid-layout") ?? null;
    if (!grid) return;
    const sync = () => {
      const bp = bpForWidth(grid.clientWidth);
      if (bp !== activeBp.current) {
        activeBp.current = bp;
        applyMeasured(bp);
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [applyMeasured, arrangeWidth]);

  // RGL geometry on drag/resize/compaction/mount/flow-measure: merge reported
  // (visible) cells over stored cells, preserving any hidden card's saved
  // position. This keeps the grid visually correct but NEVER persists — mount and
  // flow-height reflow both fire here, and neither should write to the type's
  // saved layout. Persistence is gated to real user gestures (onDragStop/
  // onResizeStop below) so merely opening Arrange doesn't commit a layout.
  const handleLayoutChange = useCallback((all: Layouts) => {
    setCells((prev) => {
      const next: Record<Breakpoint, Cell[]> = { lg: [], md: [], sm: [] };
      for (const bp of BREAKPOINTS) {
        const reported = new Map((all[bp] ?? []).map((c) => [c.i, c]));
        next[bp] = prev[bp].map((c) => {
          const r = reported.get(c.i);
          return r ? { i: c.i, x: r.x, y: r.y, w: r.w, h: r.h } : c;
        });
      }
      return next;
    });
  }, []);

  // A finished drag/resize is the only geometry change worth persisting (the
  // debounced persist reads the merged cells from stateRef, current by the time
  // it fires).
  const handleGestureEnd = useCallback(() => schedulePersist(), [schedulePersist]);

  const handleHide = useCallback(
    (id: CardId) => {
      setCards((prev) => ({
        ...prev,
        [id]: { mode: prev[id]?.mode ?? "flow", hidden: true },
      }));
      schedulePersist();
    },
    [schedulePersist]
  );

  const handleShow = useCallback(
    (id: CardId) => {
      setCards((prev) => ({ ...prev, [id]: { mode: prev[id]?.mode ?? "flow" } }));
      schedulePersist();
    },
    [schedulePersist]
  );

  const handleReset = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await fetch(`/api/types/${encodeURIComponent(typeKey)}/layout`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout: null }),
    }).catch(() => {});
    openItem(router, itemId);
    router.refresh();
  }, [typeKey, itemId, router]);

  const grid = (
    <ResponsiveGridLayout
      // Remount when the arrange width changes so WidthProvider measures the
      // newly-constrained container from scratch (clean breakpoint, no stale width).
      key={arrangeWidth}
      className={arrange ? "layout dash-edit" : "layout"}
      layouts={layouts}
      breakpoints={GRID_BREAKPOINT_PX}
      cols={GRID_COLS}
      rowHeight={GRID_ROW_HEIGHT}
      margin={GRID_MARGIN}
      containerPadding={[0, 0]}
      // Transforms ONLY while arranging. RGL's default (cssTransforms) positions
      // every cell with `transform: translate(...)`, and a transformed ancestor
      // re-bases the coordinate system of any `position: sticky` descendant — so
      // the body editor's formatting bar tracked its own grid cell instead of
      // pinning to the scroll container, reading as "the style bar is frozen
      // partway down the note" (Tyler, 2026-08-12). Notes are the only type with
      // a saved canvas_layout, which is why it looked note-specific. At rest
      // there is no drag to animate, so left/top costs nothing; while arranging
      // transforms come back for a smooth drag, where no sticky bar is in play.
      useCSSTransforms={arrange}
      isDraggable={arrange}
      isResizable={arrange}
      draggableHandle=".canvas-drag"
      draggableCancel=".cancel-drag"
      compactType="vertical"
      onLayoutChange={(_current, all) => handleLayoutChange(all)}
      onDragStop={handleGestureEnd}
      onResizeStop={handleGestureEnd}
    >
      {visibleIds.map((id) => (
        <div key={id}>
          <CardCell
            id={id}
            arrange={arrange}
            node={nodes[id]}
            onRows={handleRows}
            onHide={handleHide}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );

  if (!arrange) {
    // Fill the container: the full page → full browser width (Desktop/lg), the
    // modal panel (~768) → Tablet/md. The breakpoint follows the surface.
    return (
      <div ref={wrapRef} className="w-full px-6 py-6 sm:px-10">
        {grid}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="w-full px-6 py-6 sm:px-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-[var(--accent)]">Arranging</span>
        {/* Width switcher: arrange each responsive layout from the one editor. */}
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-700 text-xs">
          {(
            [
              ["lg", "Desktop"],
              ["md", "Tablet"],
              ["sm", "Phone"],
            ] as const
          ).map(([bp, lbl]) => (
            <button
              key={bp}
              onClick={() => setArrangeWidth(bp)}
              aria-pressed={arrangeWidth === bp}
              title={`Arrange the ${lbl.toLowerCase()} layout`}
              className={`px-2.5 py-1 ${
                arrangeWidth === bp
                  ? "bg-[var(--accent)] text-white"
                  : "text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <span className="text-xs text-neutral-500">
          Switch width to arrange each layout. Drag ⠿, resize edges, or hide.
          Auto-saves to every item of this type.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleReset}
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
            title="Discard this type's saved layout and return to the default"
          >
            Reset to default
          </button>
          <button
            onClick={handleDone}
            className="rounded-md border border-[var(--accent)] px-3 py-1 text-sm text-[var(--accent)] hover:brightness-110"
          >
            Done
          </button>
        </div>
      </div>

      {hiddenIds.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-neutral-800 px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-neutral-600">
            Hidden
          </span>
          {hiddenIds.map((id) => (
            <button
              key={id}
              onClick={() => handleShow(id)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"
              title="Show this card again"
            >
              + {labels[id] ?? id}
            </button>
          ))}
        </div>
      )}

      {/* Constrain the grid to the chosen breakpoint's width so RGL renders that
          layout; Desktop fills the page. Centered, with a frame when narrowed so
          the device bounds are clear. */}
      <div
        className={`mx-auto ${
          arrangeWidth === "lg"
            ? ""
            : "rounded-lg border border-dashed border-neutral-800 p-2"
        }`}
        style={
          arrangeWidth === "md"
            ? { maxWidth: 700 } // ≈ the modal's content width, so Tablet is WYSIWYG
            : arrangeWidth === "sm"
              ? { maxWidth: 420 }
              : undefined
        }
      >
        {grid}
      </div>
    </div>
  );
}
