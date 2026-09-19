// The client nav chrome (v6 redesign + ADR-056 configurable slots). A locked
// Home slot, then the owner's configurable middle slots, then a "+ New" quick
// capture and a "More" kebab. Rendered four ways by the owner's navPosition:
//
//   • bottom  — a floating pill, centered on the bottom edge (also the mobile
//               default on every position).
//   • top     — a full-width docked menu bar across the top.
//   • left /  — a full-height docked side rail with three sizes the collapse
//     right     arrow cycles: fat (icons + names) → thin (icons only) →
//               hidden (a reopen tab at the edge). The kebab uses horizontal
//               dots on the rail.
//
// Middle slots come from settings.navSlots (resolved server-side by Nav.tsx into
// ShellSlot[]). A slot is either a single `destination` or a `tools` group that
// opens a popover of child destinations. Destinations navigate, with two
// href-identified exceptions that open an overlay in place: /favorites (the
// flyout) and /search when the owner's searchMode is "palette" (ADR-182). ⌘K
// always opens the palette regardless of that setting.
// Build has a global shortcut (Ctrl/Cmd+Shift+B) and a glowing entry in More.
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import BuildSidebar from "@/components/nav/BuildSidebar";
import FavoritesFlyout from "@/components/nav/FavoritesFlyout";
import {
  Chevron,
  Icon,
  IconWithCount,
  InlineBadge,
  KebabIcon,
  Logo,
  PlusIcon,
  WrenchIcon,
} from "@/components/nav/NavGlyphs";
import { useHoverPopover } from "@/components/nav/useHoverPopover";
import AppBadgeSync from "@/components/pwa/AppBadgeSync";
import CaptureModal from "@/components/capture/CaptureModal";
import CommandPalette from "@/components/search/CommandPalette";
import Launcher, { type LauncherTile } from "@/components/nav/Launcher";
import ReorderableStrip from "@/components/nav/ReorderableStrip";
import SyncPill from "@/components/nav/SyncPill";
import { isBuildPath } from "@/lib/build-nav";
import { NOTIFICATION_CENTER_ENABLED } from "@/lib/notifications-enabled";
import { BUILD_SIDEBAR_W, navPadVars, RAIL_W } from "@/lib/nav-layout";
import {
  FAVORITES_HREF,
  RECOMMENDED_MOBILE_NAV_SLOTS,
  SEARCH_HREF,
  type NavDensity,
  type NavSlotConfig,
  type NavPosition,
  type RailAnchor,
  type RailSize,
  type SearchMode,
} from "@/lib/settings";

// A single nav destination, resolved for render (icon key + any badge count).
export type ShellDest = {
  label: string;
  href: string;
  icon: string;
  count: number | null;
};

// A configured middle slot: one destination, or a named group of them.
export type ShellSlot = (
  | ({ kind: "destination" } & ShellDest)
  | {
      kind: "tools";
      label: string;
      icon: string;
      count: number | null;
      children: ShellDest[];
    }
) & {
  // Where this slot sits in the stored NavSlotConfig[] it was resolved from
  // (Nav.tsx). Lets the phone bar's drag-to-reorder write the same move back
  // to settings without a second lookup. Unset on the locked Home slot.
  configIndex?: number;
};

// Home is always the first slot and never configurable; prepended at render.
const HOME_SLOT: ShellSlot = {
  kind: "destination",
  label: "Home",
  href: "/",
  icon: "home",
  count: null,
};

// SEARCH (ADR-182, supersedes the ADR-172 follow-up note that used to sit here).
// Ledgr has two search surfaces — the ⌘K palette and the /search page — and the
// old arrangement showed BOTH by default: /search as a seeded nav slot, plus a
// permanent palette button hardcoded into all four layouts beside New/More. So a
// default nav carried two search icons, only one of which the owner could
// configure, and the hardcoded one used its own dimmer color than the slots
// beside it. Now there is ONE Search slot, and `searchMode` decides what it
// opens. The earlier note's concern — that hijacking the slot left the PAGE
// unreachable — is answered by the setting rather than by two icons.
// ⌘K keeps working in both modes: a shortcut costs no space, so the palette is
// never truly unreachable.

// A destination at /favorites opens the favorites flyout rather than navigating.
const isFavoritesHref = (href: string) => href === FAVORITES_HREF;
// The Search slot (ADR-182). Like Favorites, this is a destination whose href
// identifies it rather than being followed blindly: in "palette" mode the slot
// opens the ⌘K overlay instead of navigating to the page.
const isSearchHref = (href: string) => href === SEARCH_HREF;

const POSITIONS: { value: NavPosition; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

// The collapse arrow steps fat → thin → hidden → fat.
const NEXT_RAIL: Record<RailSize, RailSize> = { fat: "thin", thin: "hidden", hidden: "fat" };
// Which way a layout's tools/favorites popover grows from its trigger: beside it
// (side rails), up off the bottom pill, down from the top bar, or the phone
// bar's static centered anchor. placePop reads this.
type PopMode = "side" | "above" | "below" | "mobile";
const TOOLS_POP_W = 208; // w-52
const FAVORITES_POP_W = 256; // w-64
const RAIL_NEXT_LABEL: Record<RailSize, string> = {
  fat: "Collapse to icons",
  thin: "Hide menu",
  hidden: "Show menu",
};

export default function NavShell({
  slots,
  mobileSlots,
  mobileNavConfig = [],
  unreadCount,
  typeOptions,
  buildTypes,
  aiMemoryEnabled,
  navPosition,
  railSize: railSizeProp,
  navDensity: navDensityProp,
  railAnchor: railAnchorProp,
  searchMode,
  syncEnabled = false,
}: {
  slots: ShellSlot[];
  mobileSlots: ShellSlot[];
  // The stored slot list mobileSlots was resolved from (mobileNavSlots, or
  // navSlots when the phone mirrors desktop): what a bar reorder writes back.
  mobileNavConfig?: NavSlotConfig[];
  // Unread notification count: seeds the PWA app-icon badge + the More-menu link.
  unreadCount: number;
  typeOptions: { key: string; label: string }[];
  // The owner's types, for the Build sidebar's Types & Properties dropdown.
  buildTypes: { key: string; label: string; icon: string | null }[];
  // AI Memory on? Gates the Build sidebar's "AI Memory" entry (ADR-137).
  aiMemoryEnabled: boolean;
  navPosition: NavPosition;
  railSize: RailSize;
  navDensity: NavDensity;
  railAnchor: RailAnchor;
  // What the Search slot opens (ADR-182): the ⌘K palette, or the /search page.
  searchMode: SearchMode;
  // This instance syncs against a hub (LEDGR_SYNC_HUBS set): mounts the sync
  // dot. Server-gated so the cloud hub / Tyler render zero sync overhead.
  syncEnabled?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The More menu is PORTALED and viewport-clamped (Tyler, 2026-09-11): it was
  // `absolute` with hand-picked anchor classes (top-0 / bottom-0 / -translate-y-1/2)
  // chosen to "open away from the kebab so it stays on screen". Those classes
  // only know where the kebab sits in its own container, not where the viewport
  // ends, so a rail kebab low on the screen still ran the menu off the bottom —
  // the `max-h-[calc(100vh-1rem)]` on the panel capped its HEIGHT but not its
  // starting offset, so it clipped anyway. Same failure and same fix as the
  // item kebab and the color swatch panel.
  const kebabWrapRef = useRef<HTMLDivElement>(null);
  const [menuCoords, setMenuCoords] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  // Tools-group + Favorites popovers: hover-intent open (hover-capable
  // pointers) or click-toggle (touch), with outside-click dismiss.
  const {
    openId: openTools,
    setOpenId: setOpenTools,
    hoverOpen,
    hoverClose,
    toggle: toggleTools,
  } = useHoverPopover("[data-nav-tools]");
  // A tools/favorites popover is PORTALED and viewport-clamped, exactly like the
  // More menu above and for the same reason (Tyler, 2026-09-14): the old
  // `absolute` anchor classes knew where the trigger sat in its own container
  // but not where the viewport ended, so a group with several children ran off
  // the bottom of a short screen — a rail slot low down, the top bar on a
  // laptop. One popover is open at a time, so one ref + one set of coords does
  // for all of them; popMetaRef carries the opening popover's width and which
  // way it should grow, armed by the trigger that opens it.
  const popWrapRef = useRef<HTMLDivElement>(null);
  const popMetaRef = useRef<{ width: number; mode: PopMode }>({
    width: TOOLS_POP_W,
    mode: "side",
  });
  const [popCoords, setPopCoords] = useState<CSSProperties | null>(null);
  // The phone bottom bar is the first row of the pull-up drawer (ADR-143): the
  // Launcher panel owns the swipe/drag gesture for the whole surface, so the
  // old per-bar swipe-up detection (S6a) is gone.

  const [railSize, setRailSize] = useState<RailSize>(railSizeProp);
  const [density, setDensity] = useState<NavDensity>(navDensityProp);
  const [anchor, setAnchor] = useState<RailAnchor>(railAnchorProp);

  const isRail = navPosition === "left" || navPosition === "right";
  // Build mode is `/build*` only. `/views` is now the Work-side consumer surface
  // (the builder/manager moved to /build/views — ADR-063 producer/consumer split),
  // so it no longer reads as Build.
  const inBuild = isBuildPath(pathname);

  // Re-adopt server values if a refresh changes them (adjust-during-render
  // pattern; an effect would double-render).
  const [prevRailProp, setPrevRailProp] = useState(railSizeProp);
  if (railSizeProp !== prevRailProp) {
    setPrevRailProp(railSizeProp);
    setRailSize(railSizeProp);
  }
  const [prevDensityProp, setPrevDensityProp] = useState(navDensityProp);
  if (navDensityProp !== prevDensityProp) {
    setPrevDensityProp(navDensityProp);
    setDensity(navDensityProp);
  }
  const [prevAnchorProp, setPrevAnchorProp] = useState(railAnchorProp);
  if (railAnchorProp !== prevAnchorProp) {
    setPrevAnchorProp(railAnchorProp);
    setAnchor(railAnchorProp);
  }

  // Keep the body's nav padding in lock-step with whatever chrome is showing.
  // In Build mode the Work nav is replaced by the fixed left sidebar, so the body
  // clears it on the left (desktop) regardless of the Work nav position. In Work
  // mode the four vars follow the position + live rail width, so a rail collapse
  // feels instant (the CSS transition on body smooths it) and crossing the
  // Work/Build line resets the padding cleanly. The vars apply at sm+ only;
  // mobile keeps its fixed bottom clearance (globals.css).
  useEffect(() => {
    const style = document.body.style;
    if (inBuild) {
      style.setProperty("--nav-pt", "0px");
      style.setProperty("--nav-pb", "0px");
      style.setProperty("--nav-pr", "0px");
      style.setProperty("--nav-pl", BUILD_SIDEBAR_W);
      return;
    }
    const vars = navPadVars(navPosition, railSize) as Record<string, string>;
    style.setProperty("--nav-pt", vars["--nav-pt"]);
    style.setProperty("--nav-pb", vars["--nav-pb"]);
    style.setProperty("--nav-pl", vars["--nav-pl"]);
    style.setProperty("--nav-pr", vars["--nav-pr"]);
  }, [inBuild, isRail, navPosition, railSize]);

  // Shortcuts: q = quick capture, Ctrl/Cmd+K = search palette, Ctrl/Cmd+Shift+B
  // = Build. q/B stay inert while typing.
  useEffect(() => {
    function typing(t: EventTarget | null) {
      return (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      );
    }
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        router.push(inBuild ? "/" : "/build");
      } else if (e.key === "q" && !mod && !e.altKey && !typing(e.target)) {
        e.preventDefault();
        setCaptureOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, inBuild]);

  // Close the More menu on an outside click. Two kebabs can be in the DOM
  // (mobile pill + desktop chrome); match either via the data attribute rather
  // than a single ref.
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      // The panel portals to <body>, so it is no longer inside the kebab
      // wrapper — without [data-nav-menu] here, a mousedown on the "Move menu"
      // buttons inside it would close the menu before their click landed.
      if (!(e.target as Element).closest?.("[data-nav-kebab],[data-nav-menu]")) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  // Place the More menu in VIEWPORT coordinates. Horizontal: beside a side rail
  // (so it doesn't cover the rail), else aligned to the kebab's right edge.
  // Vertical: grow away from whichever half of the screen the kebab sits in, so
  // a kebab near the bottom opens upward instead of off the edge — then clamp,
  // and hand the panel a maxHeight so a long menu scrolls rather than clips.
  const placeMenu = useCallback(() => {
    const el = kebabWrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 8;
    const W = 192; // w-48
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left =
      navPosition === "left"
        ? r.right + m
        : navPosition === "right"
          ? r.left - W - m
          : r.right - W;
    left = Math.max(m, Math.min(left, vw - W - m));
    if (r.top + r.height / 2 > vh / 2) {
      setMenuCoords({
        left,
        bottom: Math.max(m, vh - r.bottom),
        maxHeight: Math.max(120, r.bottom - m),
      });
    } else {
      setMenuCoords({
        left,
        top: Math.max(m, r.top),
        maxHeight: Math.max(120, vh - r.top - m),
      });
    }
  }, [navPosition]);

  useLayoutEffect(() => {
    if (menuOpen) placeMenu();
  }, [menuOpen, placeMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    // Capture-phase scroll catches inner scroll containers, so the menu stays
    // glued to its kebab.
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [menuOpen, placeMenu]);

  // Place a tools/favorites popover in VIEWPORT coordinates (see popWrapRef).
  // Horizontal: beside the trigger for a rail, centered on it above the bottom
  // pill, left-aligned under the top bar — then clamped to the screen. Vertical:
  // grow away from whichever half the trigger sits in, and hand the panel a
  // maxHeight so a long list scrolls instead of clipping.
  const placePop = useCallback(() => {
    const el = popWrapRef.current;
    if (!el) return;
    const { width: W, mode } = popMetaRef.current;
    // The phone bar's popover is statically centered above it (MOBILE_POPOVER_STYLE).
    if (mode === "mobile") return;
    const r = el.getBoundingClientRect();
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left =
      mode === "side"
        ? navPosition === "left"
          ? r.right + m
          : r.left - W - m
        : mode === "above"
          ? r.left + r.width / 2 - W / 2
          : r.left;
    left = Math.max(m, Math.min(left, vw - W - m));
    // A side popover sits beside its trigger (aligned to its near edge); an
    // above/below one clears the trigger entirely.
    if (r.top + r.height / 2 > vh / 2) {
      const edge = mode === "side" ? r.bottom : r.top - m;
      setPopCoords({
        position: "fixed",
        left,
        bottom: Math.max(m, vh - edge),
        maxHeight: Math.max(120, edge - m),
      });
    } else {
      const edge = mode === "side" ? r.top : r.bottom + m;
      setPopCoords({
        position: "fixed",
        left,
        top: Math.max(m, edge),
        maxHeight: Math.max(120, vh - edge - m),
      });
    }
  }, [navPosition]);

  useLayoutEffect(() => {
    if (openTools) placePop();
  }, [openTools, placePop]);

  useEffect(() => {
    if (!openTools) return;
    window.addEventListener("resize", placePop);
    window.addEventListener("scroll", placePop, true);
    return () => {
      window.removeEventListener("resize", placePop);
      window.removeEventListener("scroll", placePop, true);
    };
  }, [openTools, placePop]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const slotActive = (slot: ShellSlot): boolean =>
    slot.kind === "tools"
      ? slot.children.some((c) => isActive(c.href))
      : isActive(slot.href);

  const move = async (pos: NavPosition) => {
    setMenuOpen(false);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ navPosition: pos }),
    }).catch(() => {});
    router.refresh();
  };

  const persistSettings = (patch: Record<string, unknown>) => {
    void fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  };

  // Cycle the rail size. Local state flips immediately (the body-padding effect
  // follows); the setting persists in the background, no refresh needed.
  const cycleRail = (to?: RailSize) => {
    const next = to ?? NEXT_RAIL[railSize];
    setRailSize(next);
    persistSettings({ railSize: next });
  };

  // Density (+ rail anchor) chooser. Like the rail size, it flips local state
  // instantly and persists in the background.
  const chooseDensity = (d: NavDensity, a?: RailAnchor) => {
    setDensity(d);
    const patch: Record<string, unknown> = { navDensity: d };
    if (a) {
      setAnchor(a);
      patch.railAnchor = a;
    }
    persistSettings(patch);
  };

  // The locked Home slot leads every layout, then the configured middle slots.
  // Mobile and desktop bars get distinct id prefixes so a tools popover open on
  // one never bleeds into the other (both are in the DOM, one visible).
  const desktopSlots = [HOME_SLOT, ...slots].map((slot, i) => ({
    slot,
    id: i === 0 ? "home" : `d${i}`,
  }));
  // The phone bar reorders by hold-and-drag (ReorderableStrip): the order is
  // local state so the bar follows the finger, then the same permutation is
  // written to the stored phone list and the server re-resolves. Ids stay
  // positional (m1..) so an open popover keyed by id closes cleanly on move.
  // The override is keyed to the prop array it reordered: the server sends a
  // fresh array on every refresh, so a stale override drops by itself.
  type BarOrder = { base: ShellSlot[]; order: ShellSlot[] };
  const [barOverride, setBarOverride] = useState<BarOrder | null>(null);
  const mobileOrder =
    barOverride && barOverride.base === mobileSlots ? barOverride.order : mobileSlots;
  // The latest order for the commit on release (a ref, so the strip's
  // onCommit doesn't read a snapshot from before the last move).
  const barOrderRef = useRef<BarOrder | null>(null);
  const mobileBarSlots = [HOME_SLOT, ...mobileOrder].map((slot, i) => ({
    slot,
    id: i === 0 ? "home" : `m${i}`,
  }));
  // Bar indices include Home at 0; the order state holds the slots after it.
  // from/to index the rendered order, which is exactly `mobileOrder` here.
  const moveBarSlot = (from: number, to: number) => {
    if (from < 1 || to < 1) return;
    const next = [...mobileOrder];
    const [moved] = next.splice(from - 1, 1);
    if (!moved) return;
    next.splice(to - 1, 0, moved);
    const value = { base: mobileSlots, order: next };
    barOrderRef.current = value;
    setOpenTools(null);
    setBarOverride(value);
  };
  const commitBarOrder = async () => {
    const latest = barOrderRef.current;
    if (!latest || latest.base !== mobileSlots) return;
    // Only the slots ON the bar were permuted: swap them among the positions
    // they already occupy in the stored list, leaving everything hidden (the
    // Inbox when it's empty) or beyond the bar exactly where it was.
    const bar = latest.order.slice(0, RECOMMENDED_MOBILE_NAV_SLOTS - 1);
    const idx = bar.map((s) => s.configIndex);
    if (!bar.length || idx.some((i) => i === undefined || !mobileNavConfig[i])) return;
    const order = idx as number[];
    const positions = [...order].sort((a, b) => a - b);
    if (positions.every((p, k) => p === order[k])) return;
    const next = mobileNavConfig.slice();
    positions.forEach((pos, k) => {
      next[pos] = mobileNavConfig[order[k]];
    });
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobileNavSlots: next }),
    }).catch(() => {});
    router.refresh();
  };

  // The pull-up launcher holds every destination — the owner's full nav set (a
  // tools group expands to its children) plus the built-in extras — EXCEPT the
  // ones already visible on the bar row, because the bar IS the drawer's first
  // row now (ADR-143): opening reveals the rest, it doesn't repeat the bar.
  // The permanent Search button on the bar opens the command palette, which is a
  // DIFFERENT tool from the /search page, so /search is no longer seeded here —
  // a Search-page slot earns its own drawer tile. The generic dedupe below still
  // removes it if the owner put it on the bar row itself.
  const visibleBarHrefs = new Set([
    ...mobileBarSlots
      .slice(0, RECOMMENDED_MOBILE_NAV_SLOTS)
      .flatMap(({ slot }) => (slot.kind === "destination" ? [slot.href] : [])),
  ]);
  const launcherTiles: LauncherTile[] = [
    ...[HOME_SLOT, ...slots].flatMap((s) =>
      s.kind === "tools"
        ? s.children.map((c) => ({ label: c.label, href: c.href, icon: c.icon, count: c.count }))
        : [{ label: s.label, href: s.href, icon: s.icon, count: s.count }]
    ),
    { label: "Build", href: "/build", icon: "tools" },
    { label: "Edit nav", href: "/build/navigation", icon: "navigation" },
    { label: "Settings", href: "/settings", icon: "bolt" },
    { label: "Changelog", href: "/changelog", icon: "book" },
    { label: "Trash", href: "/trash", icon: "archive" },
  ]
    .filter((t) => !visibleBarHrefs.has(t.href))
    // The Search tile follows the same rule as the Search slot (ADR-182): in
    // "palette" mode it opens the overlay instead of navigating to the page.
    // Without this, an owner whose Search slot overflowed out of the bar would
    // get a tile that quietly did the OTHER thing.
    .map((t) =>
      isSearchHref(t.href) && searchMode === "palette"
        ? { ...t, onSelect: () => setSearchOpen(true) }
        : t
    );

  const itemColors = (active: boolean) =>
    active
      ? "bg-neutral-800 text-neutral-100"
      : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200";

  const densityBtn = (active: boolean) =>
    `rounded px-2 py-1 text-xs ${
      active ? "bg-neutral-700 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800"
    }`;

  // Per-layout class builders.
  const pillSlot = (active: boolean) =>
    `relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-[10px] ${
      active ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
    }`;
  // Compact, non-shrinking variant for the mobile FIXED bar (Q7): tighter padding
  // (px-2) so ~5 icon-only slots + grip + Search + New fit without scrolling, and
  // `shrink-0` so a tap target never squeezes when the row is full. The active
  // slot's label is width-capped so a long name can't blow out the row.
  const pillSlotMobile = (active: boolean) =>
    `relative flex shrink-0 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[10px] [&_span]:max-w-[3.75rem] [&_span]:truncate ${
      active ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
    }`;
  const topSlot = (active: boolean) =>
    `relative flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${itemColors(active)}`;
  // `w-full` so a tools/favorites button (wrapped in its own `relative` div for
  // the popover) stretches edge-to-edge like a bare destination Link does as a
  // direct flex child — otherwise its hover highlight only hugs the icon+label.
  const railFatSlot = (active: boolean) =>
    `relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm ${itemColors(active)}`;
  const railThinSlot = (active: boolean) =>
    `relative flex w-full items-center justify-center rounded-lg p-2.5 ${itemColors(active)}`;

  // A child row inside a tools popover (always icon + label + inline badge).
  function renderToolsChild(child: ShellDest, key: string) {
    const active = isActive(child.href);
    const cls = `flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-sm ${itemColors(active)}`;
    const inner = (
      <>
        <Icon icon={child.icon} />
        <span className="truncate">{child.label}</span>
        <InlineBadge count={child.count} />
      </>
    );
    return (
      <Link
        key={key}
        role="menuitem"
        href={child.href}
        onClick={() => setOpenTools(null)}
        aria-current={active ? "page" : undefined}
        className={cls}
      >
        {inner}
      </Link>
    );
  }

  // A popover opened from the mobile fixed bar is centered above the bar, pinned
  // to the viewport, and capped so a long group scrolls rather than running off
  // the top. A static anchor is enough here now the scroll strip is gone (Q7).
  const MOBILE_POPOVER_STYLE: CSSProperties = {
    position: "fixed",
    left: "50%",
    transform: "translateX(-50%)",
    bottom: "calc(4.75rem + env(safe-area-inset-bottom))",
    maxHeight: "calc(100vh - 6rem - env(safe-area-inset-bottom) - var(--safe-top))",
  };
  // Every tools/favorites popover portals to <body>. On the mobile bar it has to:
  // the pill has `backdrop-blur` and a centering transform, and each makes a
  // `position: fixed` descendant resolve against the pill's box, not the
  // viewport. On desktop it's what lets placePop position the panel in viewport
  // coordinates instead of inside a container that doesn't know where the screen
  // ends. Wrapped in `data-nav-tools` so the outside-click closer still counts
  // clicks inside it as "inside", and carrying the hover handlers so dragging the
  // pointer from the trigger onto the menu doesn't dismiss it (the portal moves
  // it out of the trigger's subtree).
  const mountPopover = (id: string, node: ReactNode) =>
    typeof document === "undefined"
      ? null
      : createPortal(
          <div data-nav-tools onMouseEnter={() => hoverOpen(id)} onMouseLeave={hoverClose}>
            {node}
          </div>,
          document.body
        );

  // The popover a tools group opens: always `fixed`, positioned by `style` —
  // placePop's measured coords on desktop, MOBILE_POPOVER_STYLE on the phone bar.
  function toolsPopover(
    slot: Extract<ShellSlot, { kind: "tools" }>,
    id: string,
    style: CSSProperties
  ) {
    return (
      <div
        role="menu"
        style={style}
        className="fixed z-50 w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-1.5 shadow-xl shadow-black/50"
      >
        <p className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600">
          {slot.label}
        </p>
        {slot.children.map((c, i) => renderToolsChild(c, `${id}-c${i}`))}
      </div>
    );
  }

  // One slot renderer for every layout: a destination (link, or the search
  // palette button), or a tools group button that toggles its popover.
  // `classNameFor` is the layout's class builder; `popMode` says which way this
  // layout's popovers grow (see placePop) — "mobile" is the phone fixed bar.
  // The count always rides the icon's corner (CountBubble), in every layout.
  function renderSlot(
    slot: ShellSlot,
    id: string,
    classNameFor: (active: boolean) => string,
    showLabel: boolean,
    popMode: PopMode
  ) {
    const mobileBar = popMode === "mobile";
    const className = classNameFor(slotActive(slot));
    // Tell placePop how wide this popover is and which way it grows, before the
    // open that triggers the measurement.
    const arm = (width: number) => {
      popMetaRef.current = { width, mode: popMode };
    };
    const popStyle: CSSProperties | null = mobileBar ? MOBILE_POPOVER_STYLE : popCoords;
    const inner = (
      <>
        <IconWithCount icon={slot.icon} count={slot.count} />
        {showLabel && <span className="truncate">{slot.label}</span>}
      </>
    );

    if (slot.kind === "tools") {
      const open = openTools === id;
      return (
        <div
          key={id}
          data-nav-tools
          ref={open ? popWrapRef : null}
          className="relative"
          onMouseEnter={() => {
            arm(TOOLS_POP_W);
            hoverOpen(id);
          }}
          onMouseLeave={hoverClose}
        >
          <button
            onClick={() => {
              // On the bar row, first collapse the drawer so the popover opens
              // against the docked bar (its fixed anchor assumes the bottom edge).
              if (mobileBar) setLauncherOpen(false);
              arm(TOOLS_POP_W);
              toggleTools(id);
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={slot.label}
            title={slot.label}
            className={className}
          >
            {inner}
          </button>
          {open && popStyle && mountPopover(id, toolsPopover(slot, id, popStyle))}
        </div>
      );
    }

    // Search in "palette" mode: a destination that opens the ⌘K overlay instead
    // of navigating (ADR-182). Rendering it as a slot — rather than the permanent
    // hardcoded button each layout used to carry beside New/More — is what makes
    // it configurable AND fixes its color: it now takes `className` from the same
    // per-layout builder every other icon uses, instead of its own dimmer
    // neutral-500. In "page" mode it falls through to the plain Link below.
    if (isSearchHref(slot.href) && searchMode === "palette") {
      return (
        <button
          key={id}
          onClick={() => {
            if (mobileBar) setLauncherOpen(false);
            setSearchOpen(true);
          }}
          aria-label={slot.label}
          title={`${slot.label} (⌘K)`}
          className={className}
        >
          {inner}
        </button>
      );
    }

    // Favorites: a destination that opens the favorites flyout instead of
    // navigating. Reuses the tools open-state + outside-click closer.
    if (isFavoritesHref(slot.href)) {
      const open = openTools === id;
      return (
        <div
          key={id}
          data-nav-tools
          ref={open ? popWrapRef : null}
          className="relative"
          onMouseEnter={() => {
            arm(FAVORITES_POP_W);
            hoverOpen(id);
          }}
          onMouseLeave={hoverClose}
        >
          <button
            onClick={() => {
              // Collapse the drawer first so the flyout opens against the
              // docked bar (its fixed anchor assumes the bottom edge).
              if (mobileBar) setLauncherOpen(false);
              arm(FAVORITES_POP_W);
              toggleTools(id);
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={slot.label}
            title={slot.label}
            className={className}
          >
            {inner}
          </button>
          {open &&
            popStyle &&
            mountPopover(
              id,
              <FavoritesFlyout fixedStyle={popStyle} onNavigate={() => setOpenTools(null)} />
            )}
        </div>
      );
    }

    return (
      <Link
        key={id}
        href={slot.href}
        // A bar-row tap dismisses the open drawer as it navigates (parity with
        // the drawer's own tiles); on desktop mobileBar is false, so this is inert.
        onClick={mobileBar ? () => setLauncherOpen(false) : undefined}
        aria-label={slot.label}
        // Hover tooltip so the icon-only thin rail (and the mobile bar) stays
        // identifiable — the fat rail / top bar show the label inline anyway.
        title={slot.label}
        aria-current={isActive(slot.href) ? "page" : undefined}
        className={className}
      >
        {inner}
      </Link>
    );
  }

  // The shared More dropdown, portaled to <body> and positioned by placeMenu in
  // viewport coordinates (see there for why the old anchor classes clipped).
  // `data-nav-menu` keeps the outside-click handler from treating clicks inside
  // it as "outside". The Build entry is the highlighted, glowing primary action.
  const renderMenu = () =>
    menuCoords &&
    createPortal(
      <div
        role="menu"
        data-nav-menu
        style={{
          position: "fixed",
          left: menuCoords.left,
          top: menuCoords.top,
          bottom: menuCoords.bottom,
          width: 192,
          maxHeight: menuCoords.maxHeight,
        }}
        className="z-[60] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-1.5 shadow-xl shadow-black/50"
      >
      {/* The Work-side door (destination-named "Build"). The More menu only
          renders in Work mode — in Build the whole Work chrome is replaced by the
          sidebar, whose "Back to Work" is the way out — so this is always Build. */}
      <Link
        href="/build"
        role="menuitem"
        onClick={() => setMenuOpen(false)}
        className="mb-1 flex items-center gap-2 rounded-lg border border-[var(--accent)] bg-[var(--accent)]/15 px-2.5 py-2 text-sm font-semibold text-[var(--accent)] shadow-[0_0_16px_-3px_var(--accent)] transition hover:bg-[var(--accent)]/25"
      >
        <WrenchIcon />
        Build
      </Link>
      {/* Notification center paused (ADR-130): hidden, recoverable via the flag. */}
      {NOTIFICATION_CENTER_ENABLED && (
        <Link
          href="/notifications"
          role="menuitem"
          onClick={() => setMenuOpen(false)}
          className={`${menuItem} flex items-center`}
        >
          Notifications
          <InlineBadge count={unreadCount} />
        </Link>
      )}
      <Link href="/settings" role="menuitem" onClick={() => setMenuOpen(false)} className={menuItem}>
        User Settings
      </Link>
      <Link href="/build/navigation" role="menuitem" onClick={() => setMenuOpen(false)} className={menuItem}>
        Edit navigation
      </Link>
      <Link href="/trash" role="menuitem" onClick={() => setMenuOpen(false)} className={menuItem}>
        Trash
      </Link>
      <Link href="/changelog" role="menuitem" onClick={() => setMenuOpen(false)} className={menuItem}>
        Changelog
      </Link>
      {/* User Guide (ADR-189). It lives in Build, but it's listed here on the
          Work side too: the guide exists because people don't know a feature
          exists, and making them enter Build to find that out defeats it. */}
      <Link href="/build/guide" role="menuitem" onClick={() => setMenuOpen(false)} className={menuItem}>
        User Guide
      </Link>
      <div className="my-1 border-t border-neutral-800" />
      <p className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600">Move menu</p>
      <div className="grid grid-cols-2 gap-1 p-1">
        {POSITIONS.map((p) => (
          <button
            key={p.value}
            onClick={() => void move(p.value)}
            className={`rounded px-2 py-1 text-xs ${
              navPosition === p.value ? "bg-neutral-700 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Density (+ anchor). Hidden for the bottom bar, which is always compact.
          Both the rails and the top bar offer the same four-way choice — Spread
          plus three Compact anchors — so they mirror each other. The anchor is
          stored as top/center/bottom; on the top bar those read left/center/
          right (the same start/center/end idea, just on the horizontal axis). */}
      {navPosition !== "bottom" && (
        <>
          <p className="px-2 pt-1.5 text-[10px] uppercase tracking-wide text-neutral-600">
            Spacing
          </p>
          <div className="grid grid-cols-1 gap-1 p-1">
            <button
              onClick={() => chooseDensity("spread")}
              className={densityBtn(density === "spread")}
            >
              Spread
            </button>
            <button
              onClick={() => chooseDensity("compact", "top")}
              className={densityBtn(density === "compact" && anchor === "top")}
            >
              {isRail ? "Compact (top)" : "Compact (left)"}
            </button>
            <button
              onClick={() => chooseDensity("compact", "center")}
              className={densityBtn(density === "compact" && anchor === "center")}
            >
              Compact (center)
            </button>
            <button
              onClick={() => chooseDensity("compact", "bottom")}
              className={densityBtn(density === "compact" && anchor === "bottom")}
            >
              {isRail ? "Compact (bottom)" : "Compact (right)"}
            </button>
          </div>
        </>
      )}
      </div>,
      document.body
    );

  // The Search / + New / More controls that trail the DESKTOP bottom pill (the
  // full-label variant). The mobile fixed bar uses its own tighter trailing set
  // below (Search + New, icon-only; More retired into the Launcher — Q7).
  const pillTrailingControls = (
    <>
      {syncEnabled && <SyncPill />}
      <button
        onClick={() => setCaptureOpen(true)}
        title="Quick capture (q)"
        className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-[10px] text-[var(--accent)] hover:bg-neutral-800/60"
      >
        <PlusIcon />
        New
      </button>
      <div ref={kebabWrapRef} data-nav-kebab className="relative">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-[10px] text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
        >
          <KebabIcon horizontal={false} />
          More
        </button>
        {menuOpen && renderMenu()}
      </div>
    </>
  );

  // The mobile fixed bar's trailing controls (Q7): + New, icon-only to save
  // width. More is gone from the mobile bar — its contents live in the Launcher
  // (Build/Settings/Trash/Edit-nav/Changelog tiles) and User Settings. Search is
  // no longer here either: it's a configurable slot now (ADR-182), so it sits in
  // the slot row with the other icons instead of being pinned beside New.
  const mobileTrailingControls = (
    <>
      {syncEnabled && <SyncPill />}
      <button
        onClick={() => {
          setLauncherOpen(false);
          setCaptureOpen(true);
        }}
        title="Quick capture (q)"
        aria-label="Quick capture"
        className="flex shrink-0 items-center rounded-xl p-2 text-[var(--accent)] hover:bg-neutral-800/60"
      >
        <PlusIcon />
      </button>
    </>
  );

  // The floating pill (desktop bottom bar). `fill` widens it to the ~40rem
  // canvas width with full labels.
  const floatingPill = (
    barSlots: { slot: ShellSlot; id: string }[],
    extraClass: string,
    { fill = false }: { fill?: boolean } = {}
  ) => (
    <div
      className={`fixed z-40 flex rounded-2xl border border-neutral-800 bg-neutral-900/95 shadow-xl shadow-black/40 backdrop-blur ${
        fill
          ? "items-center w-[40rem] max-w-[calc(100vw-2rem)] justify-between gap-1 p-2 [&_svg]:h-6 [&_svg]:w-6"
          : "items-center gap-1 p-1.5"
      } ${extraClass}`}
    >
      {barSlots.map(({ slot, id }) =>
        renderSlot(slot, id, pillSlot, true, "above")
      )}
      {pillTrailingControls}
    </div>
  );

  // The phone bottom bar row (Q7 → ADR-143): FIXED, icon-only, non-scrolling —
  // the owner's daily few slots (label only under the active one) between an
  // all-destinations toggle and Search + New. It is literally the first row of
  // the pull-up Launcher panel, which wraps it with the grip, the drag gesture,
  // and the tile grid of everything else; a destination's position is stable
  // and muscle memory forms. A bar tools/favorites popover portals above the
  // bar (mobileBar in renderSlot).
  const mobileBarRow = (
    <div className="flex items-center gap-1 px-1.5 pb-1.5">
      <button
        type="button"
        onClick={() => setLauncherOpen((o) => !o)}
        aria-label="All destinations"
        aria-expanded={launcherOpen}
        title="All destinations (pull up)"
        className="flex shrink-0 items-center rounded-xl p-2 text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
      >
        <Icon icon="grid" />
      </button>
      {/* The slot strip scrolls horizontally if it can't fit (no-scrollbar
          hides the bar); the grid toggle and Search/New stay pinned outside it.
          Its tools/favorites popovers portal to <body> (mobileBar), so a scroll
          container here can't clip them. Belt-and-suspenders with the mobile
          overflow-x guard (globals.css): even a pathological width keeps every
          control reachable instead of pushing Search/New off the edge. */}
      <ReorderableStrip
        className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto"
        items={mobileBarSlots.slice(0, RECOMMENDED_MOBILE_NAV_SLOTS).map(({ slot, id }) => ({
          id,
          locked: id === "home",
          node: renderSlot(slot, id, pillSlotMobile, slotActive(slot), "mobile"),
        }))}
        onMove={moveBarSlot}
        onCommit={() => void commitBarOrder()}
      />
      <div className="flex shrink-0 items-center gap-1">{mobileTrailingControls}</div>
    </div>
  );

  // In Build mode the Work nav is replaced by the fixed left sidebar (the clean
  // paradigm break). Everything else — the four Work layouts — renders only on
  // the Work side. The capture + command palette overlays are shared by both.
  return (
    <nav aria-label="Main">
      {/* PWA app-icon badge: only while the notification center is live (ADR-130). */}
      {NOTIFICATION_CENTER_ENABLED && <AppBadgeSync count={unreadCount} />}
      {inBuild && (
        <BuildSidebar
          types={buildTypes}
          aiMemoryEnabled={aiMemoryEnabled}
          onOpenSearch={() => setSearchOpen(true)}
        />
      )}

      {/* Mobile: the bottom bar + pull-up drawer are ONE full-width panel
          (ADR-143) — the Launcher wraps the bar row with the grip, the drag
          gesture, the backdrop, and the tile grid. data-work-nav-pill lets the
          markdown editor hide the whole surface while editing (globals.css),
          so the floating formatting rail and this panel never fight for the
          same bottom-of-screen spot. */}
      {!inBuild && (
        <div className="sm:hidden" data-work-nav-pill>
          <Launcher
            open={launcherOpen}
            onOpenChange={setLauncherOpen}
            tiles={launcherTiles}
            barRow={mobileBarRow}
            onDragClaim={() => setOpenTools(null)}
          />
        </div>
      )}

      {/* Desktop chrome (sm+). One of four layouts. */}
      {!inBuild && navPosition === "bottom" && (
        <div className="hidden sm:block">
          {floatingPill(desktopSlots, "bottom-4 left-1/2 -translate-x-1/2", { fill: true })}
        </div>
      )}

      {!inBuild && navPosition === "top" && (
        // The bar always spans the full top edge (background + border line all
        // the way across), like the rails span the full height. Only the content
        // cluster moves, mirroring the rails: spread pins logo + items to the
        // left and pushes New/More to the right (ml-auto); compact groups the
        // whole cluster together and anchors it left / center / right via the
        // stored top / center / bottom anchor (start / center / end).
        <header className="fixed inset-x-0 top-0 z-40 hidden h-14 border-b border-neutral-800 bg-neutral-900/95 backdrop-blur sm:block">
          <div
            className={`flex h-full items-center gap-1 px-3 ${
              density === "compact"
                ? anchor === "center"
                  ? "justify-center"
                  : anchor === "bottom"
                    ? "justify-end"
                    : "justify-start"
                : ""
            }`}
          >
            <Logo className="-ml-1" />
            {desktopSlots.map(({ slot, id }) =>
              renderSlot(slot, id, topSlot, true, "below")
            )}
            <div className={`flex items-center gap-1 ${density === "spread" ? "ml-auto" : ""}`}>
              {syncEnabled && <SyncPill tooltipSide="bottom" />}
              <button
                onClick={() => setCaptureOpen(true)}
                title="Quick capture (q)"
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-neutral-800/60"
              >
                <PlusIcon />
                New
              </button>
              <div ref={kebabWrapRef} data-nav-kebab className="relative">
                <button
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-label="Menu"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="flex items-center rounded-lg p-2 text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
                >
                  <KebabIcon horizontal={false} />
                </button>
                {menuOpen && renderMenu()}
              </div>
            </div>
          </div>
        </header>
      )}

      {!inBuild && isRail && railSize === "hidden" && (
        <button
          onClick={() => cycleRail("fat")}
          aria-label="Show menu"
          title="Show menu"
          className={`fixed top-1/2 z-40 hidden h-16 w-6 -translate-y-1/2 items-center justify-center border border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)] shadow-[0_0_16px_-2px_var(--accent)] backdrop-blur transition hover:bg-[var(--accent)]/25 sm:flex ${
            navPosition === "left" ? "left-0 rounded-r-lg border-l-0" : "right-0 rounded-l-lg border-r-0"
          }`}
        >
          <Chevron dir={navPosition === "left" ? "right" : "left"} size={22} />
        </button>
      )}

      {!inBuild && isRail && railSize !== "hidden" && (
        <aside
          className={`fixed inset-y-0 z-40 hidden flex-col gap-1 bg-neutral-900/95 p-2 shadow-xl shadow-black/30 backdrop-blur sm:flex ${
            navPosition === "left" ? "left-0 border-r border-neutral-800" : "right-0 border-l border-neutral-800"
          }`}
          style={{ width: RAIL_W[railSize] }}
        >
          {/* Top of the rail: Ledgr logo + the collapse arrow (pointing toward
              the docked edge). Fat puts them on one row (logo left, arrow at the
              edge); thin stacks the compact "L" over a centered arrow. */}
          {(() => {
            const collapseArrow = (
              <button
                onClick={() => cycleRail()}
                aria-label={RAIL_NEXT_LABEL[railSize]}
                title={RAIL_NEXT_LABEL[railSize]}
                className="flex items-center justify-center rounded-lg p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/15"
              >
                <Chevron dir={navPosition === "left" ? "left" : "right"} size={railSize === "fat" ? 16 : 22} />
              </button>
            );
            return railSize === "fat" ? (
              <div className="flex items-center justify-between px-1 pb-1">
                <Logo />
                {collapseArrow}
              </div>
            ) : (
              <div className="flex justify-center pb-1">{collapseArrow}</div>
            );
          })()}

          {/* Spacing via flex-1 spacers around the slots/actions cluster:
              spread → one spacer between them (slots top, utilities bottom);
              compact-top → no spacers; compact-bottom → spacer above; compact-
              center → equal spacers above and below. */}
          {density === "compact" && (anchor === "bottom" || anchor === "center") && (
            <div className="flex-1" />
          )}

          {/* Slots. The rail's tools popovers open to the docked side. */}
          <div className="flex flex-col gap-1">
            {desktopSlots.map(({ slot, id }) =>
              renderSlot(
                slot,
                id,
                railSize === "fat" ? railFatSlot : railThinSlot,
                railSize === "fat",
                "side"
              )
            )}
          </div>

          {density === "spread" && <div className="flex-1" />}

          {/* Search + New + More. */}
          <div className="flex flex-col gap-1">
            {syncEnabled && (
              <div className={railSize === "fat" ? "flex px-1" : "flex justify-center"}>
                <SyncPill tooltipAlign={navPosition === "left" ? "left" : "right"} />
              </div>
            )}
            <button
              onClick={() => setCaptureOpen(true)}
              title="Quick capture (q)"
              className={`flex items-center text-[var(--accent)] hover:bg-neutral-800/60 ${
                railSize === "fat" ? "gap-3 rounded-lg px-3 py-2 text-sm" : "justify-center rounded-lg p-2.5"
              }`}
            >
              <PlusIcon />
              {railSize === "fat" && "New"}
            </button>
            <div ref={kebabWrapRef} data-nav-kebab className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="Menu"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={`flex w-full items-center text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300 ${
                  railSize === "fat" ? "gap-3 rounded-lg px-3 py-2 text-sm" : "justify-center rounded-lg p-2.5"
                }`}
              >
                <KebabIcon horizontal={true} />
                {railSize === "fat" && "More"}
              </button>
              {menuOpen && renderMenu()}
            </div>
          </div>

          {density === "compact" && anchor === "center" && <div className="flex-1" />}
        </aside>
      )}

      {captureOpen && (
        <CaptureModal typeOptions={typeOptions} onClose={() => setCaptureOpen(false)} />
      )}
      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </nav>
  );
}

const menuItem =
  "block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800";
