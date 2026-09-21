// Client owner of a dashboard: holds widget data + edit-mode + the stage
// appearance, and persists every change through the one PATCH /api/dashboards/[id]
// path.
//
// Data model: the server page fetches each widget's items/count (Date-typed, via
// the RSC boundary). Layout drag/resize is purely presentational, so it persists
// (debounced) WITHOUT a refetch. Changes that alter what data a widget shows —
// adding a widget, changing item-limit/sort/render-style, tree/container settings,
// focus — call router.refresh() after persisting, so the server re-fetches
// correctly-typed rows; router.refresh preserves this component's state (edit-mode
// stays on), and the effects below resync widgets + name + appearance from props.
// Per-widget appearance (chrome) and the stage appearance are display-only, so
// they persist without a refetch.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layouts } from "react-grid-layout";
import AddWidgetMenu from "./AddWidgetMenu";
import BackgroundPanel from "./BackgroundPanel";
import DashboardGridLayout from "./DashboardGridLayout";
import StageBackground from "./StageBackground";
import { FloatingMenu, usePopoverPosition } from "./floating-menu";
import { showToast } from "@/components/ui/ActionToast";
import SearchBar from "@/components/search/SearchBar";
import {
  buildActionWidget,
  buildContainerWidget,
  buildEmbedWidget,
  buildImageWidget,
  buildTextWidget,
  buildViewWidget,
  type ViewWidgetKind,
} from "./widget-defaults";
import { estimateGridHeight } from "@/lib/dashboard-grid";
import {
  GRID_BREAKPOINTS,
  type ActionKind,
  type ContainerMode,
  type DashboardAppearance,
  type DashboardWidget,
  type WidgetAppearance,
  type WidgetData,
  type WidgetLayout,
  type WidgetSettings,
} from "@/lib/dashboard-widgets";
import type { StarterWidget } from "@/lib/starter-widgets";
import type { ViewDefinition } from "@/lib/views";

// Widget kinds whose data changes when their settings change → refetch on save.
const REFETCH_KINDS = new Set(["view", "tree", "container"]);

// The one exception to that rule: a container tab click changes activeTab and
// nothing else. It has to PERSIST (so a tab group reopens where you left it),
// but it must not refetch — "container" is in REFETCH_KINDS, so routing tab
// clicks through the normal settings path would re-run the whole dashboard's
// server fan-out on every click. Compared field-by-field rather than trusting the
// caller, and it fails toward the refetch, so a real settings change can't sneak
// through as a tab click.
function tabOnlyChange(prev: WidgetSettings | undefined, next: WidgetSettings): boolean {
  if (!prev || !("activeTab" in prev) || !("activeTab" in next)) return false;
  if (prev.activeTab === next.activeTab) return false;
  return JSON.stringify({ ...prev, activeTab: 0 }) === JSON.stringify({ ...next, activeTab: 0 });
}

function cellFrom(all: Layouts, bp: keyof Layouts, id: string) {
  const item = (all[bp] ?? []).find((l) => l.i === id);
  return item ? { x: item.x, y: item.y, w: item.w, h: item.h } : undefined;
}

// Fold react-grid-layout's reported cells back into each widget's layout.
function mergeLayouts(widgets: WidgetData[], all: Layouts): WidgetData[] {
  return widgets.map((d) => {
    const layout: WidgetLayout = {};
    for (const bp of GRID_BREAKPOINTS) {
      const cell = cellFrom(all, bp, d.widget.id);
      if (cell) layout[bp] = cell;
    }
    return { ...d, widget: { ...d.widget, layout } };
  });
}

export default function DashboardClient({
  dashboardId,
  name: nameProp,
  focusItemId,
  focusTitle,
  appearance: appearanceProp,
  isHome,
  isToday,
  initialWidgets,
  today,
}: {
  dashboardId: string;
  name: string;
  focusItemId: string | null;
  focusTitle: string | null;
  appearance: DashboardAppearance | null;
  isHome: boolean;
  isToday: boolean;
  initialWidgets: WidgetData[];
  // App-timezone today (YYYY-MM-DD), from the server. When set, widget rows carry
  // the shared row menu (ADR-142); left undefined the rows stay plain.
  today?: string;
}) {
  const router = useRouter();
  const [widgets, setWidgets] = useState(initialWidgets);
  const [name, setName] = useState(nameProp);
  const [appearance, setAppearance] = useState(appearanceProp);
  const [editMode, setEditMode] = useState(false);
  const widgetsRef = useRef(widgets);
  const appearanceRef = useRef(appearance);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-adopt the server name after a refresh (adjust-during-render pattern).
  const [prevName, setPrevName] = useState(nameProp);
  if (prevName !== nameProp) {
    setPrevName(nameProp);
    setName(nameProp);
  }
  const [prevAppearance, setPrevAppearance] = useState(appearanceProp);
  if (prevAppearance !== appearanceProp) {
    setPrevAppearance(appearanceProp);
    setAppearance(appearanceProp);
  }

  // Resync from the server after a router.refresh() (add / settings / focus):
  // the page passes a fresh array, so adopt it during render (React's sanctioned
  // "adjust state when a prop changes" pattern). edit-mode is separate state, so
  // it survives the refresh.
  const [prevInitial, setPrevInitial] = useState(initialWidgets);
  if (prevInitial !== initialWidgets) {
    setPrevInitial(initialWidgets);
    setWidgets(initialWidgets);
  }
  // Keep the handler-facing refs in sync with the rendered state (ref writes, so
  // effect-safe; event handlers also set them eagerly).
  useEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);
  useEffect(() => {
    appearanceRef.current = appearance;
  }, [appearance]);

  // Freshness: the server resolves "today" and every date window at request
  // time, so a board left open in the installed PWA overnight keeps showing
  // yesterday. Refresh when the tab comes back to the foreground — event-driven
  // only, never a polling loop. Keep BOTH guards:
  //   • the 60s throttle, because these routes are force-dynamic and each view
  //     widget costs several DB round trips (repeated alt-tabbing would be rude);
  //   • the edit-mode / pending-write skip, because a refresh adopts fresh
  //     `initialWidgets` during render, which would stomp an in-progress
  //     arrangement or race a debounced layout/settings PATCH.
  const lastRefresh = useRef(0);
  useEffect(() => {
    // Mount counts as a refresh, so a focus right after load doesn't refetch.
    if (!lastRefresh.current) lastRefresh.current = Date.now();
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (editMode || timer.current || settingsTimer.current) return;
      if (Date.now() - lastRefresh.current < 60_000) return;
      lastRefresh.current = Date.now();
      router.refresh();
    };
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("focus", maybeRefresh);
    return () => {
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("focus", maybeRefresh);
    };
  }, [editMode, router]);

  // Cancel a pending debounced layout persist. Nulls the ref as well as clearing
  // the timeout: the freshness effect above reads a non-null `timer.current` as
  // "a write is in flight", so a cleared-but-still-non-null handle would disable
  // the refresh for the rest of the page's life after the first add or remove.
  const cancelPersist = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const persistNow = useCallback(
    (next: WidgetData[]) => {
      const body = {
        name: name.trim() || nameProp,
        focusItemId,
        appearance: appearanceRef.current,
        widgets: next.map((d): DashboardWidget => d.widget),
      };
      return fetch(`/api/dashboards/${dashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    },
    [dashboardId, name, nameProp, focusItemId]
  );

  const schedulePersist = useCallback(() => {
    cancelPersist();
    // Stays non-null until the PATCH resolves, so the freshness effect above can
    // tell a write is still in flight and skip its refresh.
    timer.current = setTimeout(() => {
      const t = timer.current;
      void persistNow(widgetsRef.current).then(() => {
        if (timer.current === t) timer.current = null;
      });
    }, 600);
  }, [persistNow, cancelPersist]);

  // RGL fires onLayoutChange on mount too; ignoring it in view mode avoids both
  // a spurious write and any update loop.
  const handleLayoutChange = useCallback(
    (all: Layouts) => {
      if (!editMode) return;
      const merged = mergeLayouts(widgetsRef.current, all);
      widgetsRef.current = merged;
      setWidgets(merged);
      schedulePersist();
    },
    [editMode, schedulePersist]
  );

  // Commit a change to the widget array immediately, then optionally refetch.
  const commit = useCallback(
    async (next: WidgetData[], refetch: boolean) => {
      cancelPersist();
      widgetsRef.current = next;
      setWidgets(next);
      await persistNow(next);
      if (refetch) router.refresh();
    },
    [persistNow, router, cancelPersist]
  );

  // Removing a widget throws away its settings, appearance AND grid placement, so
  // it gets the ADR-142 treatment: no confirm, an undo toast instead. Undo splices
  // the captured WidgetData back at its original index — the whole object, so the
  // tile returns exactly where and how it was. No refetch: the captured object
  // still carries its resolved data (view/items/count/embedItem/childData), so a
  // router.refresh() would only buy seconds of freshness for a full RSC fan-out.
  const handleRemove = useCallback(
    (id: string) => {
      const idx = widgetsRef.current.findIndex((d) => d.widget.id === id);
      if (idx < 0) return;
      const removed = widgetsRef.current[idx];
      void commit(widgetsRef.current.filter((d) => d.widget.id !== id), false);
      showToast("Widget removed", () => {
        const next = [...widgetsRef.current];
        next.splice(idx, 0, removed);
        void commit(next, false);
      });
    },
    [commit]
  );

  // Settings edits update the widget optimistically + immediately (so a controlled
  // input never loses a keystroke), then DEBOUNCE the persist + refetch. Without
  // the debounce, a text/select change that refetches (view/tree/container) fired
  // router.refresh() per keystroke, and a stale refresh would race the controlled
  // input and blank it (the relation-role glitch). One refresh after typing stops.
  const handleSettings = useCallback(
    (id: string, settings: WidgetSettings) => {
      const prev = widgetsRef.current.find((d) => d.widget.id === id)?.widget;
      const next = widgetsRef.current.map((d) =>
        d.widget.id === id ? { ...d, widget: { ...d.widget, settings } } : d
      );
      widgetsRef.current = next;
      setWidgets(next);
      const kind = next.find((d) => d.widget.id === id)?.widget.kind ?? "";
      const refetch = REFETCH_KINDS.has(kind) && !tabOnlyChange(prev?.settings, settings);
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
      settingsTimer.current = setTimeout(() => {
        const t = settingsTimer.current;
        void persistNow(widgetsRef.current).then(() => {
          if (settingsTimer.current === t) settingsTimer.current = null;
          if (refetch) router.refresh();
        });
      }, 450);
    },
    [persistNow, router]
  );

  // Per-widget chrome (header/border/background/accent/collapse). Display-only —
  // never changes which data shows, so no refetch.
  // Repoint a view-backed widget at a different saved view (the gear's "Shows"
  // picker, R2). viewId is a TOP-LEVEL widget field, so it can't ride
  // handleSettings (which debounces on `settings` and would never see it). The
  // refetch is UNCONDITIONAL, unlike handleSettings: REFETCH_KINDS omits "stat",
  // so a repointed Count widget would otherwise keep showing its stale number.
  const handleViewChange = useCallback(
    (id: string, viewId: string) => {
      const next = widgetsRef.current.map((d) =>
        d.widget.id === id ? { ...d, widget: { ...d.widget, viewId } } : d
      );
      void commit(next, true);
    },
    [commit]
  );

  const handleAppearance = useCallback(
    (id: string, ap: WidgetAppearance) => {
      const next = widgetsRef.current.map((d) =>
        d.widget.id === id ? { ...d, widget: { ...d.widget, appearance: ap } } : d
      );
      void commit(next, false);
    },
    [commit]
  );

  const handleAdd = useCallback(
    (view: ViewDefinition, kind: ViewWidgetKind) => {
      const widget = buildViewWidget(view, kind);
      // Refetch so the new widget shows real, correctly-typed data.
      void commit([...widgetsRef.current, { widget, view, items: [], count: 0 }], true);
    },
    [commit]
  );

  const handleAddText = useCallback(() => {
    const widget = buildTextWidget();
    void commit([...widgetsRef.current, { widget, view: null, items: [], count: 0 }], false);
  }, [commit]);

  const handleAddAction = useCallback(
    (action: ActionKind) => {
      const widget = buildActionWidget(action);
      void commit([...widgetsRef.current, { widget, view: null, items: [], count: 0 }], false);
    },
    [commit]
  );

  // Embed an existing item: optimistically show the title, refetch to load the
  // body (the one place a widget reads a body).
  const handleAddEmbed = useCallback(
    (itemId: string, title: string) => {
      const widget = buildEmbedWidget(itemId);
      const optimistic: WidgetData = {
        widget,
        view: null,
        items: [],
        count: 0,
        embedItem: { id: itemId, title, body: { format: "markdown", text: "" } },
      };
      void commit([...widgetsRef.current, optimistic], true);
    },
    [commit]
  );

  // New note → embed it (a sticky note). Creates the note, then embeds by id.
  const handleAddNote = useCallback(async () => {
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "note", title: "" }),
      });
      if (!res.ok) return;
      const { item } = (await res.json()) as { item: { id: string; title: string } };
      handleAddEmbed(item.id, item.title || "Untitled");
    } catch {
      /* swallow — user can retry */
    }
  }, [handleAddEmbed]);

  const handleAddContainer = useCallback(
    (mode: ContainerMode) => {
      const widget = buildContainerWidget(mode);
      void commit([...widgetsRef.current, { widget, view: null, items: [], count: 0, childData: [] }], false);
    },
    [commit]
  );

  const handleAddImage = useCallback(() => {
    const widget = buildImageWidget();
    void commit([...widgetsRef.current, { widget, view: null, items: [], count: 0 }], false);
  }, [commit]);

  // A prebuilt/starter widget: create its backing view first (a real saved
  // view), then add it via handleAdd.
  const handleAddStarter = useCallback(
    async (starter: StarterWidget, kind: ViewWidgetKind) => {
      try {
        const res = await fetch("/api/views", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(starter.view),
        });
        if (!res.ok) return;
        const { view } = (await res.json()) as { view: ViewDefinition };
        handleAdd(view, kind);
      } catch {
        /* swallow — the menu stays open-less; user can retry */
      }
    },
    [handleAdd]
  );

  // The dashboard stage (background/scrim/title/density). Display-only → persist
  // the explicit new value (not stale state) and update the visual; no refetch.
  const handleSetStageAppearance = useCallback(
    (next: DashboardAppearance | null) => {
      setAppearance(next);
      appearanceRef.current = next;
      cancelPersist();
      void fetch(`/api/dashboards/${dashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || nameProp,
          focusItemId,
          appearance: next,
          widgets: widgetsRef.current.map((d): DashboardWidget => d.widget),
        }),
      }).catch(() => {});
    },
    [dashboardId, name, nameProp, focusItemId, cancelPersist]
  );

  // Assign (or clear) this dashboard as the Home (/) or Today surface.
  const setRole = useCallback(
    (role: "homeDashboardId" | "todayDashboardId", on: boolean) => {
      void fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [role]: on ? dashboardId : null }),
      })
        .then(() => router.refresh())
        .catch(() => {});
    },
    [dashboardId, router]
  );

  // Setting/clearing the dashboard focus re-scopes every view/stat widget, so it
  // PATCHes the new focus (explicit, not the stale prop) then refetches.
  //
  // DO NOT restore <FocusPicker> to the edit header (W4, defer-by-hiding). The
  // dashboard-level focus is a fossil of a superseded model: the need is served
  // by opening the item itself (a person's page lists their tasks and notes), so
  // Brandon decided to hide the way to SET one. Everything else stays wired and
  // working — FocusPicker.tsx, applyFocus, dashboards.focus_item_id, the parser,
  // the resolver — and a dashboard that already has a focus still shows its pill
  // above, whose ✕ calls this. Only the picker is gone.
  const handleSetFocus = useCallback(
    (newFocusId: string | null) => {
      cancelPersist();
      void fetch(`/api/dashboards/${dashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || nameProp,
          focusItemId: newFocusId,
          appearance: appearanceRef.current,
          widgets: widgetsRef.current.map((d): DashboardWidget => d.widget),
        }),
      })
        .then(() => router.refresh())
        .catch(() => {});
    },
    [dashboardId, name, nameProp, router, cancelPersist]
  );

  const density = appearance?.density ?? "comfortable";
  const contentPad = density === "compact" ? "py-6" : "py-10";
  const showTitle = appearance?.showTitle ?? true;

  // Reserve the grid's (estimated) height during load so the widgets don't pile
  // up before RGL measures its width. Estimated from the lg layout — a rough
  // placeholder is fine; the reservation is dropped once RGL reports its layout.
  const reservedHeight = useMemo(() => estimateGridHeight(widgets), [widgets]);

  return (
    <main className="relative min-h-screen">
      <StageBackground appearance={appearance} />
      <div className={`relative z-10 mx-auto w-full max-w-6xl px-6 ${contentPad} sm:px-12`}>
        {/* Two calm rows (W4). Row 1 is the NAME ALONE: sharing a row with the
            controls let seven of them wrap onto three lines and squeezed the
            flex-1 edit input to an unusable ~10px sliver at 375px. `pt-10
            sm:pt-0` clears the shell's floating mobile "Build" pill (fixed
            left-3 top-3, Build chrome per isBuildPath), which sat on the title. */}
        <div className="pt-10 sm:pt-0">
          {editMode ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                const trimmed = name.trim();
                if (trimmed && trimmed !== nameProp) void persistNow(widgetsRef.current);
                else if (!trimmed) setName(nameProp);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              aria-label="Dashboard name"
              className="ui-title w-full rounded-card border border-line bg-surface-1 px-2 py-1"
            />
          ) : showTitle ? (
            <h1 className="ui-title">{name}</h1>
          ) : null}
          {/* One-line search under the title (2026-09-20): Enter hands the words
              to /search. Hidden in edit mode so it never competes with the
              name field and the widget grid controls. */}
          {!editMode && <SearchBar className="mt-3" />}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-sm">
          {focusTitle && (
            /* The focus PILL shows in BOTH modes now: setting a focus is hidden
               (see EditMenu), so its ✕ is the only way to clear an existing one. */
            <span className="mr-auto inline-flex items-center gap-1 rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs text-[var(--accent)]">
              Focus: {focusTitle}
              <button
                onClick={() => handleSetFocus(null)}
                className="hover:opacity-70"
                aria-label="Clear focus"
                title="Clear focus"
              >
                ✕
              </button>
            </span>
          )}
          {!editMode && (
            <Link href="/dashboards" className="text-ink-subtle hover:text-ink">
              All dashboards
            </Link>
          )}
          {editMode && (
            <>
              <EditMenu isHome={isHome} isToday={isToday} onSetRole={setRole} />
              <BackgroundPanel appearance={appearance} onChange={handleSetStageAppearance} />
              <AddWidgetMenu
                onAdd={handleAdd}
                onAddStarter={handleAddStarter}
                onAddText={handleAddText}
                onAddAction={handleAddAction}
                onAddEmbed={handleAddEmbed}
                onAddNote={handleAddNote}
                onAddContainer={handleAddContainer}
                onAddImage={handleAddImage}
              />
            </>
          )}
          <button
            onClick={() => setEditMode((v) => !v)}
            className={`rounded-card border px-3 py-1 ${
              editMode
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-line-strong text-ink-muted hover:text-ink"
            }`}
          >
            {editMode ? "Done" : "Edit"}
          </button>
        </div>

        {widgets.length > 0 ? (
          <div className="mt-4">
            <DashboardGridLayout
              widgets={widgets}
              editMode={editMode}
              today={today}
              focusItemId={focusItemId}
              reservedHeight={reservedHeight}
              onLayoutChange={handleLayoutChange}
              onRemove={handleRemove}
              onSettings={handleSettings}
              onAppearance={handleAppearance}
              onViewChange={handleViewChange}
            />
          </div>
        ) : (
          <p className="mt-8 px-2 text-sm text-neutral-600">
            No widgets yet. Click <span className="text-neutral-400">Edit</span> →{" "}
            <span className="text-neutral-400">Add widget</span> to place one.
          </p>
        )}
      </div>
    </main>
  );
}

// The edit header's ⋯ popover (W4): the two surface-role toggles, which are rare
// and were eating the header row. Same popover primitive as every other
// dashboard menu (portal + flip + Esc/outside-click).
//
// Background is NOT in here: BackgroundPanel owns its own trigger + FloatingMenu,
// and a second portal popover nested inside this one is dismissed by this menu's
// outside-click handler the moment you touch it (the click lands in a sibling
// portal, so `ref.contains` misses, this menu closes, and the panel unmounts
// mid-interaction). It stays a labeled sibling button in the row instead — one
// click, one background UI, nothing duplicated.
function EditMenu({
  isHome,
  isToday,
  onSetRole,
}: {
  isHome: boolean;
  isToday: boolean;
  onSetRole: (role: "homeDashboardId" | "todayDashboardId", on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { triggerRef, pos, measure } = usePopoverPosition(220);
  const row =
    "w-full rounded px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink";
  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => {
          if (!open) measure();
          setOpen((v) => !v);
        }}
        className="rounded-card border border-line-strong px-2.5 py-1 text-ink-muted hover:text-ink"
        title="Dashboard options"
        aria-label="Dashboard options"
      >
        ⋯
      </button>
      {open && (
        <FloatingMenu
          pos={pos}
          width={220}
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
          className="rounded-card border border-line bg-surface-1 p-1 shadow-xl"
        >
          <button
            className={row}
            title="Use this dashboard as your Home (/) surface"
            onClick={() => {
              onSetRole("homeDashboardId", !isHome);
              setOpen(false);
            }}
          >
            {isHome ? "✓ Home surface" : "Set as Home"}
          </button>
          <button
            className={row}
            title="Use this dashboard as your Today surface"
            onClick={() => {
              onSetRole("todayDashboardId", !isToday);
              setOpen(false);
            }}
          >
            {isToday ? "✓ Today surface" : "Set as Today"}
          </button>
        </FloatingMenu>
      )}
    </>
  );
}
