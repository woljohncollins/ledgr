// The react-grid-layout grid itself (client-only; loaded via next/dynamic with
// ssr:false from DashboardGridLayout, because RGL measures window width on mount
// and can't server-render). Builds a per-breakpoint layout from each widget's
// stored cell (falling back to a sensible default placement), and reports the
// whole Layouts object up on every drag/resize. Drag is gated to a handle so
// links and scrolling inside a widget never move it.
"use client";

import { Responsive, WidthProvider, type Layout, type Layouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  GRID_BREAKPOINTS,
  widgetFolded,
  type GridBreakpoint,
  type WidgetAppearance,
  type WidgetData,
  type WidgetSettings,
} from "@/lib/dashboard-widgets";
import { defaultCell, defaultH, GRID_MARGIN, ROW_HEIGHT, smOrder } from "@/lib/dashboard-grid";
import WidgetFrame from "./WidgetFrame";
import type { ViewWidgetSettings } from "@/lib/dashboard-widgets";

const ResponsiveGridLayout = WidthProvider(Responsive);

const COLS: Record<GridBreakpoint, number> = { lg: 12, md: 6, sm: 1 };
const BREAKPOINT_PX: Record<GridBreakpoint, number> = { lg: 1024, md: 768, sm: 0 };

type Kind = WidgetData["widget"]["kind"];

function minFor(kind: Kind) {
  if (kind === "stat") return { minW: 2, minH: 2 };
  if (kind === "action") return { minW: 2, minH: 1 };
  if (kind === "text") return { minW: 2, minH: 1 }; // a heading can be one short row
  if (kind === "embed") return { minW: 2, minH: 3 };
  if (kind === "image") return { minW: 2, minH: 2 };
  if (kind === "container") return { minW: 3, minH: 5 };
  return { minW: 3, minH: 4 };
}

// A folded widget (collapsed, or empty in view mode — widgetFolded owns the rule)
// renders one row tall in BOTH modes now, so what you arrange in edit mode is
// what view mode shows. The forced h:1 is presentation only: it's stripped back
// out of the layout RGL reports (keepStoredHeights, below) before the change goes
// up to be persisted. A folded tile is also NOT resizable — the chevron expands
// it first, which is honest, and it means no drag-resize can be silently thrown
// away by that restore.
// Fit-to-content (2026-09-21): a compact view widget flagged fitToContent takes
// the grid height its rows need - header, the rows actually shown, the inline
// add line - instead of its stored cell. View mode only; like folding, the forced
// h is presentation and keepStoredHeights strips it before anything persists.
const FIT_CHROME_PX = 100; // card header + list padding + the "+ Add" line
const FIT_ROW_PX = 34; // one compact row
const FIT_MAX_ROWS = 10;
function fitHeight(wd: WidgetData): number | null {
  if (wd.widget.kind !== "view") return null;
  const s = wd.widget.settings as ViewWidgetSettings;
  if (!s.fitToContent || s.renderStyle === "faithful") return null;
  const n = wd.items.length + (wd.count > wd.items.length ? 1 : 0); // "+N more" line
  const px = FIT_CHROME_PX + Math.max(n, 1) * FIT_ROW_PX;
  const unit = ROW_HEIGHT + GRID_MARGIN[1];
  return Math.min(FIT_MAX_ROWS, Math.max(2, Math.ceil((px + GRID_MARGIN[1]) / unit)));
}

function buildLayouts(widgets: WidgetData[], editMode: boolean, today?: string): Layouts {
  const out: Layouts = { lg: [], md: [], sm: [] };
  const smRank = smOrder(widgets);
  widgets.forEach((wd, i) => {
    const kind = wd.widget.kind;
    const folded = widgetFolded(wd, editMode, today);
    const fit = !editMode && !folded ? fitHeight(wd) : null;
    const min = minFor(kind);
    for (const bp of GRID_BREAKPOINTS) {
      // On sm, an un-placed widget falls in DESKTOP reading order, not creation
      // order (R3/5); a stored sm cell still wins.
      const base = wd.widget.layout[bp] ?? defaultCell(bp, bp === "sm" ? smRank[i] : i, kind);
      (out[bp] as Layout[]).push({
        i: wd.widget.id,
        ...(folded ? { ...base, h: 1 } : fit != null ? { ...base, h: fit } : base),
        minW: min.minW,
        minH: folded || fit != null ? 1 : min.minH,
        ...(folded || fit != null ? { isResizable: false } : null),
      });
    }
  });
  return out;
}

// The other half of honest collapse. handleLayoutChange upstream persists
// whatever RGL reports, and RGL reports the h:1 we just forced — so a folded
// widget would have its stored expanded height overwritten with 1 the moment
// anything in the grid moved, and expanding it later would give back a one-row
// tile. Rewrite each folded widget's h back to its STORED height on the way up.
// x / y / w still come from RGL: those ARE what was just arranged, and they're
// arranged against the folded tile the user can see.
function keepStoredHeights(
  widgets: WidgetData[],
  all: Layouts,
  editMode: boolean,
  today?: string
): Layouts {
  const folded = new Map<string, WidgetData>();
  for (const wd of widgets) {
    if (widgetFolded(wd, editMode, today)) folded.set(wd.widget.id, wd);
    else if (!editMode && fitHeight(wd) != null) folded.set(wd.widget.id, wd); // fitted: same restore
  }
  if (folded.size === 0) return all;
  const out: Layouts = {};
  for (const [bp, cells] of Object.entries(all)) {
    out[bp] = cells.map((c) => {
      const wd = folded.get(c.i);
      if (!wd) return c;
      // No stored cell for this breakpoint yet → the kind's default height, so
      // expanding gives a usable tile rather than the folded sliver.
      return { ...c, h: wd.widget.layout[bp as GridBreakpoint]?.h ?? defaultH(wd.widget.kind) };
    });
  }
  return out;
}

export default function RglInner({
  widgets,
  editMode,
  today,
  focusItemId,
  onLayoutChange,
  onRemove,
  onSettings,
  onAppearance,
  onViewChange,
}: {
  widgets: WidgetData[];
  editMode: boolean;
  today?: string;
  focusItemId?: string | null;
  onLayoutChange: (layouts: Layouts) => void;
  onRemove: (id: string) => void;
  onSettings: (id: string, settings: WidgetSettings) => void;
  onAppearance: (id: string, appearance: WidgetAppearance) => void;
  onViewChange?: (id: string, viewId: string) => void;
}) {
  // A view widget flagged hideWhenEmpty (2026-09-21) drops out of the grid when
  // its view matches nothing; vertical compaction closes the gap. Edit mode keeps
  // every widget visible so the flag can be changed back.
  const shown = editMode
    ? widgets
    : widgets.filter(
        (wd) =>
          !(
            wd.widget.kind === "view" &&
            (wd.widget.settings as ViewWidgetSettings).hideWhenEmpty &&
            wd.count === 0
          )
      );
  return (
    <ResponsiveGridLayout
      className={editMode ? "layout dash-edit" : "layout"}
      layouts={buildLayouts(shown, editMode, today)}
      breakpoints={BREAKPOINT_PX}
      cols={COLS}
      rowHeight={ROW_HEIGHT}
      margin={GRID_MARGIN}
      containerPadding={[0, 0]}
      // DO NOT add `measureBeforeMount` here. In RGL 1.5.3 the flag renders a
      // placeholder div, and the measurement that swaps it for the grid changes
      // the element type — React unmounts the placeholder, but WidthProvider's
      // ResizeObserver stays attached to the DETACHED node, which reports 0×0.
      // That second callback latches width:0 permanently and every widget
      // renders at 0px (the blank-dashboard bug, live 2026-07-11 → 2026-07-29).
      // The load-flash the flag was added for (commit 6012f81) is already solved
      // by DashboardGridLayout's height reservation + skeleton.
      isDraggable={editMode}
      isResizable={editMode}
      draggableHandle=".widget-drag-handle"
      draggableCancel=".cancel-drag"
      compactType="vertical"
      onLayoutChange={(_current, all) =>
        onLayoutChange(keepStoredHeights(shown, all, editMode, today))
      }
    >
      {shown.map((wd) => (
        <div key={wd.widget.id}>
          <WidgetFrame
            data={wd}
            editMode={editMode}
            today={today}
            focusItemId={focusItemId}
            onRemove={onRemove}
            onSettings={onSettings}
            onAppearance={onAppearance}
            onViewChange={onViewChange}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
