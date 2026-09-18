// Chrome for the intercepted item route (PRD §4.13). Two shapes, chosen at
// render time from the available content width (ui-refresh S2b):
//   - PEEK  — a panel docked to the trailing (right) edge of the content region
//             when there's room (≥1280px of content, measured inside the nav
//             frame) and the nav isn't docked on the right. Non-modal: the list
//             stays visible and interactive underneath, ↑/↓ walk its rows with
//             the peek following, Enter/click a row re-navigates.
//   - CENTER — the original center modal, used when the window is narrow or a
//             right rail already occupies the trailing edge.
// Close = Esc, backdrop click (center only), or ✕ — router.back() while the URL
// still points at this item, which tears down the intercepting @modal slot and
// returns to the launching surface. Once the main pane has soft-navigated on
// (the slot stays mounted, the URL doesn't), close just unmounts the panel:
// back() there would walk the main pane's history instead of closing.
// Arrow-walk uses router.replace so ↑/↓ browsing the list doesn't grow history.
// While the panel owns the URL, ANY navigation to another item is forced to
// replace, not push — the capture-phase click interceptor below handles anchor
// clicks (list rows, related rows), and openItem() in src/lib/item-nav.ts
// handles programmatic pushes (it reads the body[data-item-panel] flag set
// here) — so history never grows past the launching surface and one back()
// always closes back to it, no matter how many items were viewed in the panel.
// Expand is a plain anchor (hard navigation) so the same URL re-renders as the
// full page form.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import ConfirmButton from "@/components/ui/ConfirmButton";
import ItemActionsMenu from "@/components/canvas/ItemActionsMenu";
import ActionGlyph from "@/components/canvas/action-icons";
import TypeCue from "@/components/canvas/TypeCue";
import type { ItemOpenMode } from "@/lib/settings";

// The content region must be at least this wide (px, inside the nav frame) for
// the peek panel; below it the center modal is the better use of space. Matches
// the brief's ≥1280px-of-content threshold.
const PEEK_MIN_CONTENT = 1280;

// Decide the shape from the live layout. Reads the body's resolved padding —
// globals.css turns the nav's --nav-pl/pr vars into real padding at sm+, so
// paddingLeft/Right ARE the docked rail widths. A right rail (paddingRight > 0)
// means the trailing edge is taken, so we fall back to the center modal there
// (and under any future right/split config) exactly as the brief specifies.
// Below this viewport width the item view is a bottom sheet (ui-refresh S6),
// matching the sm breakpoint the nav uses to switch to the floating bar.
const SHEET_MAX = 640;

// "peek" is the docked side panel; which edge it takes comes from `side` below.
type Mode = "sheet" | "peek" | "center";
type Side = "left" | "right";

// Drag-to-resize bounds for the peek panel (px). Min keeps it usefully wide;
// max never lets it swallow the screen. Persisted under PEEK_WIDTH_KEY so the
// chosen width sticks across items and sessions; cleared → the responsive
// default width strings below.
const PEEK_WIDTH_KEY = "ledgr:peek-width";
const PEEK_MIN_PX = 480; // ~30rem
function peekMaxPx() {
  if (typeof window === "undefined") return 1600;
  return Math.min(window.innerWidth * 0.9, 1600); // min(90vw, 100rem)
}
function readStoredPeekWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const n = parseInt(localStorage.getItem(PEEK_WIDTH_KEY) || "", 10);
    return Number.isFinite(n) ? Math.max(PEEK_MIN_PX, Math.min(peekMaxPx(), n)) : null;
  } catch {
    return null;
  }
}

// Decide the shape + which edge a docked panel takes, from the owner's preference
// narrowed by what the layout can actually do (ADR: item open mode, 2026-08-12).
//
// The preference is honored wherever it's physically possible, and only overruled
// by two hard constraints:
//   1. Below `sm` there is no room for a side panel — always the bottom sheet.
//   2. A docked nav rail owns its edge; a panel can't share it. An explicit
//      left/right that collides with the rail falls back to the OTHER edge if
//      that one is free, and to the center popup if neither is.
// "auto" keeps the original measured rule exactly: a right dock when there's
// ≥1280px of content and no right rail, else the center popup.
function computeShape(pref: ItemOpenMode): { mode: Mode; side: Side } {
  if (typeof window === "undefined") return { mode: "center", side: "right" };
  if (window.innerWidth < SHEET_MAX) return { mode: "sheet", side: "right" };
  const cs = getComputedStyle(document.body);
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  const content = window.innerWidth - pl - pr;
  // A real docked rail on that edge, not sub-pixel noise.
  const leftRail = pl > 8;
  const rightRail = pr > 8;

  if (pref === "center") return { mode: "center", side: "right" };
  if (pref === "left" || pref === "right") {
    const wantLeft = pref === "left";
    const blocked = wantLeft ? leftRail : rightRail;
    if (!blocked) return { mode: "peek", side: wantLeft ? "left" : "right" };
    // Chosen edge is taken by the rail — try the opposite edge before giving up
    // on the docked shape entirely, since "panel, not popup" is the stronger half
    // of the preference.
    const otherBlocked = wantLeft ? rightRail : leftRail;
    if (!otherBlocked) return { mode: "peek", side: wantLeft ? "right" : "left" };
    return { mode: "center", side: "right" };
  }
  return content >= PEEK_MIN_CONTENT && !rightRail
    ? { mode: "peek", side: "right" }
    : { mode: "center", side: "right" };
}

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  );
}

export default function Modal({
  itemId,
  children,
  wide = false,
  title = "",
  type = "",
  typeLabel = "",
  typeIcon = null,
  isTemplate = false,
  locked = false,
  favorited = false,
  openMode = "auto",
}: {
  itemId: string;
  children: React.ReactNode;
  // Wider panel for canvases that need the room (a song's two-column chart);
  // the default keeps note/task previews compact.
  wide?: boolean;
  // For the actions menu's "Save as template" default name; and to swap chrome
  // on a template prototype (its delete is the registry-aware banner action, not
  // the generic item Trash, which would orphan the registry row) — ADR-093 TPL2.
  title?: string;
  // The item's type, for the actions menu's "Apply template…" picker (TPL4b).
  type?: string;
  // The type's human label + nav icon, for the quiet type cue beside "Trash"
  // (ADR-132). Resolved by the modal page; empty label hides the cue.
  typeLabel?: string;
  typeIcon?: string | null;
  isTemplate?: boolean;
  // Whether the item is locked (items.properties.locked) — drives the menu's
  // lock/unlock label.
  locked?: boolean;
  // Whether the item is in the owner's favorites — drives the menu's star label.
  favorited?: boolean;
  // The owner's item-open preference (settings.itemOpenMode). Narrowed by the
  // live layout in computeShape — a phone is always the sheet, and a docked nav
  // rail wins its edge. Defaults to "auto", the pre-setting measured behavior.
  openMode?: ItemOpenMode;
}) {
  const router = useRouter();
  // Whether the URL still points at this item. A soft nav in the main pane
  // (clicking the nav, a list link elsewhere) leaves this slot mounted — Next
  // preserves an unmatched parallel slot — while pushing its own history entry,
  // so the item URL is no longer the entry back() would pop. Closing with
  // back() there walked the main pane instead of closing the panel.
  const pathname = usePathname();
  const stale = pathname !== `/items/${itemId}`;
  const [dismissed, setDismissed] = useState(false);
  // Back to the surface the peek launched from. router.back() tears down the
  // intercepting @modal slot and returns to the launching list/page. Shared by
  // Esc, the ✕, the center backdrop, sheet-dismiss, and the post-delete path.
  // Once the URL has moved on there's nothing to pop — the panel is the only
  // thing left to close, so just unmount it and leave the main pane alone.
  const close = useCallback(() => {
    if (stale) setDismissed(true);
    else router.back();
  }, [router, stale]);
  // No reset needed: opening another item swaps loading.tsx into the slot, which
  // remounts this component with a fresh `dismissed`.
  // sheet (mobile) / peek (docked panel) / center — the owner's `openMode`
  // preference narrowed by the live layout on mount and kept current on resize.
  // Client-only guard makes the SSR pass (never hit in practice — the @modal slot
  // only fills on a client nav) fall to center.
  const [shape, setShape] = useState(() => computeShape(openMode));
  const mode = shape.mode;
  const peek = mode === "peek";
  // Which edge the docked panel takes. Drives the dock offset, which border edge
  // is drawn, and which inner edge carries the resize handle — all three have to
  // agree or the handle ends up on the outside of the panel.
  const dockLeft = shape.side === "left";
  // User-chosen peek width in px (null → the responsive default). Lazy-init from
  // localStorage on the client so a restored width shows without a flash (the
  // peek only ever mounts on a client nav). Persisted on drag-end.
  const [peekWidth, setPeekWidth] = useState<number | null>(readStoredPeekWidth);
  const panelRef = useRef<HTMLDivElement>(null);
  // Drag origin for the resize handle: the pointer x + panel width at grab.
  const resizeStart = useRef<{ x: number; w: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    resizeStart.current = {
      x: e.clientX,
      w: panelRef.current?.offsetWidth ?? PEEK_MIN_PX,
    };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {}
  };
  // Drag-to-widen, in the direction that matches the dock. The handle always sits
  // on the panel's INNER edge, so "away from the docked edge" is what widens:
  // dragging left on a right-docked panel, right on a left-docked one. Getting the
  // sign wrong here makes the panel shrink as you pull it open.
  const resizeDelta = (clientX: number) => {
    if (!resizeStart.current) return 0;
    return dockLeft
      ? clientX - resizeStart.current.x
      : resizeStart.current.x - clientX;
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeStart.current) return;
    const next = resizeStart.current.w + resizeDelta(e.clientX);
    setPeekWidth(Math.max(PEEK_MIN_PX, Math.min(peekMaxPx(), next)));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resizeStart.current) return;
    const final = Math.round(
      Math.max(
        PEEK_MIN_PX,
        Math.min(peekMaxPx(), resizeStart.current.w + resizeDelta(e.clientX))
      )
    );
    resizeStart.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {}
    setPeekWidth(final);
    try {
      localStorage.setItem(PEEK_WIDTH_KEY, String(final));
    } catch {}
  };
  // Double-click the handle → forget the custom width, back to the default.
  const onResizeReset = () => {
    setPeekWidth(null);
    try {
      localStorage.removeItem(PEEK_WIDTH_KEY);
    } catch {}
  };
  // Drag-to-dismiss offset for the bottom sheet (px the sheet is pulled down).
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number | null>(null);
  // The sheet's scroll container, so a body drag can tell whether the content is
  // at its top before it decides to dismiss vs. scroll.
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the in-progress drag is allowed to dismiss: true for a header drag
  // (chrome), and for a body drag only while the content is at the top.
  const canDismiss = useRef(false);
  const dragFromBody = useRef(false);

  useEffect(() => {
    const onResize = () => setShape(computeShape(openMode));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [openMode]);

  // Advertise the open panel to the rest of the app while it owns the URL.
  // src/lib/item-nav.ts reads this flag to replace instead of push on
  // programmatic item navigations, keeping close() a single back() to the
  // launching surface.
  useEffect(() => {
    if (stale) return;
    document.body.dataset.itemPanel = "open";
    return () => {
      delete document.body.dataset.itemPanel;
    };
  }, [stale]);

  // One close() must always return to the launching surface, no matter how
  // many items were viewed in the panel (the "close cycles back through every
  // item" bug). While this panel owns the URL, a plain left-click on any
  // /items/ link — a background list row, a related-item row, a rendered
  // mention link — re-renders the panel via replace instead of push, so
  // history never grows past the launcher. Capture phase beats next/link's
  // own click handler (Link bails on defaultPrevented). Modified/middle
  // clicks, target/download links, and data-hard-nav anchors (Expand needs a
  // real document load) keep their native behavior.
  useEffect(() => {
    if (stale) return;
    const onClickCapture = (e: MouseEvent) => {
      if (
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        e.defaultPrevented
      )
        return;
      const a = (e.target as Element | null)?.closest?.('a[href^="/items/"]');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target || a.hasAttribute("download") || a.hasAttribute("data-hard-nav"))
        return;
      e.preventDefault();
      const href = a.getAttribute("href")!;
      // Same item (e.g. clicking the open item's own row): nothing to do.
      if (href !== pathname) router.replace(href, { scroll: false });
    };
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [stale, pathname, router]);

  // Lock the page scroll behind a full overlay (sheet or center modal), so a
  // drag on/near the sheet can't scroll the list underneath — the "main page
  // scrolls while I'm aiming at the drawer" report. Peek is non-modal (the list
  // stays live and walkable), so it deliberately does NOT lock. Locking the
  // <html> element (not body) leaves the sheet's own inner scroll container free.
  useEffect(() => {
    if (peek) return;
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = "hidden";
    return () => {
      el.style.overflow = prev;
    };
  }, [peek]);

  // Walk the list rows with ↑/↓ while the peek is open. Both the list (in the
  // page's <main>) and this panel (in the @modal slot) share one document, so we
  // read the list's ordered /items links straight from the DOM and router.replace
  // to the sibling row — the intercepted route re-renders the peek in place, and
  // replace (not push) keeps a single Back to the list. Suppressed while typing
  // in the editor so arrows still move the caret.
  const walk = useCallback(
    (delta: number) => {
      // Prefer the marked row-title links so the walk skips secondary /items
      // anchors in a row (the linked-item chip added in S2). Fall back to every
      // /items link for lists that don't mark their rows yet.
      let links = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('main a[data-peek-row][href^="/items/"]')
      );
      if (links.length === 0) {
        links = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('main a[href^="/items/"]')
        );
      }
      const hrefs: string[] = [];
      for (const a of links) {
        const h = a.getAttribute("href");
        if (h && !hrefs.includes(h)) hrefs.push(h);
      }
      if (hrefs.length === 0) return;
      const cur = hrefs.findIndex((h) => h === `/items/${itemId}`);
      const next = cur === -1 ? 0 : cur + delta;
      if (next < 0 || next >= hrefs.length) return;
      // Replace (not push): the peek re-renders in place and close still returns
      // to the one launching URL, so arrow-walking never grows the history.
      router.replace(hrefs[next], { scroll: false });
    },
    [itemId, router]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // BlockNote popovers (slash menu, mention picker) consume their own
      // Escape and prevent default; only an unclaimed Esc closes.
      if (e.key === "Escape" && !e.defaultPrevented) {
        close();
        return;
      }
      if (
        peek &&
        !e.defaultPrevented &&
        !isTyping(e.target) &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        e.preventDefault();
        walk(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, peek, walk]);

  // Peek only: a click on a non-interactive area of the background (the list /
  // canvas behind the panel) closes the peek, like clicking off a popover. The
  // peek is deliberately non-modal (no backdrop), so we listen on the document
  // and bail when the click is inside the panel or lands on an interactive
  // element — a list row (<a data-peek-row>), the nav, a button/field — so those
  // still act (a row still re-navigates the peek to that item) instead of
  // closing. A text-selection drag (non-collapsed selection) is not a click-off.
  useEffect(() => {
    if (!peek) return;
    const onDocClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (
        target.closest(
          'a, button, input, textarea, select, label, summary, [role="button"], [role="menuitem"], [contenteditable="true"], [data-peek-row]'
        )
      )
        return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      close();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [peek, close]);

  // Center modal owns the scroll context (one panel); the peek is non-modal, so
  // the list underneath must keep scrolling — only lock the body in center mode.
  useEffect(() => {
    if (peek) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [peek]);

  // Title/field edits made here must show in the list underneath the moment it
  // closes; refresh-on-unmount runs after back() lands.
  useEffect(() => {
    return () => router.refresh();
  }, [router]);

  // Closed while stale: the slot stays mounted until another item replaces it,
  // so render nothing rather than pushing the main pane around.
  if (dismissed && stale) return null;

  // The shared header (Trash · type cue · actions · Expand · Close) and the
  // scrolling canvas body, kept separate so the sheet can make ONLY the header
  // its drag-to-dismiss zone (the body must scroll + text-select freely).
  const header = (
      <div className="flex shrink-0 items-center justify-between gap-1 px-3 pt-2">
        <div className="flex items-center gap-1">
          {/* A template prototype's destructive/templatize actions live in its
              canvas banner (registry-aware); the generic item chrome is hidden. */}
          {!isTemplate && (
            <ConfirmButton
              title="Move to Trash?"
              description="This item moves to Trash and can be recovered for 30 days."
              confirmLabel="Trash"
              trigger={<ActionGlyph icon="trash" />}
              triggerLabel="Move to Trash"
              triggerClassName="rounded p-1 text-ink-subtle hover:bg-surface-2 hover:text-red-400"
              align="left"
              onConfirm={async () => {
                const res = await fetch(`/api/items/${itemId}`, { method: "DELETE" });
                if (!res.ok) throw new Error(`Failed (${res.status})`);
                close();
              }}
            />
          )}
          {/* Quiet type cue beside Trash (ADR-132): no extra vertical space. */}
          {!isTemplate && typeLabel && (
            <TypeCue icon={typeIcon} label={typeLabel} className="px-1" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Save as template, Apply template, Customize layout, and the lock
              toggle all live behind the "⋯" menu (a template's are hidden). */}
          {!isTemplate && (
            <ItemActionsMenu
              itemId={itemId}
              type={type}
              title={title}
              locked={locked}
              favorited={favorited}
            />
          )}
          {/* Plain <a>, not <Link>: a soft nav to the same URL would stay
              intercepted; a document load renders the full page form. */}
          <a
            href={`/items/${itemId}`}
            data-hard-nav
            className="rounded px-2 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
            title="Expand to full page"
          >
            ⤢ Expand
          </a>
          <button
            onClick={close}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>
  );
  const bodyClass = "min-h-0 flex-1 overflow-y-auto overscroll-contain pb-12";
  // The modal is its own scroll container below its own header — there's no page
  // top-nav over it to clear. Zero out --nav-pt so the body editor's sticky
  // mode-row/toolbar (top: var(--nav-pt)) pin to the modal's top instead of
  // 56px below it, which left a scroll-through gap above the toolbar when the
  // owner's nav is docked top (--nav-pt = 3.5rem).
  const bodyStyle = { "--nav-pt": "0px" } as React.CSSProperties;
  const body = <div className={bodyClass} style={bodyStyle}>{children}</div>;
  const panel = (
    <>
      {header}
      {body}
    </>
  );

  if (mode === "sheet") {
    // Bottom sheet (mobile). Drag down to dismiss: from the grabber/header
    // anywhere, or from the body when it's scrolled to the top. Mid-scroll body
    // drags scroll normally (scrollTop guard), so the editor still scrolls and
    // text-selects freely.
    const onDragStart = (e: React.TouchEvent, fromBody: boolean) => {
      dragStart.current = e.touches[0].clientY;
      dragFromBody.current = fromBody;
      // Header drag always dismisses (it's chrome); a body drag only when the
      // content is already at its top — otherwise it's a scroll. Mirrors
      // Launcher.tsx's scrollTop guard, no gesture fight.
      canDismiss.current = !fromBody || (bodyRef.current?.scrollTop ?? 0) <= 0;
      setDragging(true);
    };
    const onDragMove = (e: React.TouchEvent) => {
      if (dragStart.current == null || !canDismiss.current) return;
      // If a body drag scrolled away from the top mid-gesture, hand it back to
      // the scroller instead of dismissing.
      if (dragFromBody.current && (bodyRef.current?.scrollTop ?? 0) > 0) return;
      const dy = e.touches[0].clientY - dragStart.current;
      // Downward only: the sheet follows the finger toward the bottom of the
      // screen; an upward drag from the top just scrolls the content.
      if (dy > 0) setDragY(dy);
    };
    const onDragEnd = () => {
      if (dragY > 120) close();
      else setDragY(0);
      dragStart.current = null;
      canDismiss.current = false;
      dragFromBody.current = false;
      setDragging(false);
    };
    return (
      <div className="fixed inset-0 z-50 bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div
          role="dialog"
          aria-label={title || "Item"}
          className="fixed inset-x-0 bottom-0 flex max-h-[92vh] flex-col overflow-hidden rounded-t-2xl border-t border-line-strong bg-[var(--background)] shadow-2xl shadow-black/50"
          // Only take on a transform while actually dragging. A resting
          // `translateY(0px)` is still a transform, which makes this sheet the
          // containing block for any `position: fixed` descendant — that traps
          // the editor's mobile formatting toolbar (fixed, pinned above the
          // keyboard) inside the sheet so it can't anchor to the viewport. At
          // rest we drop the transform entirely; the drag/close path is
          // unaffected (you're never typing while dismissing the sheet).
          style={{
            transform: dragY ? `translateY(${dragY}px)` : undefined,
            transition: dragging ? "none" : "transform 0.2s ease",
          }}
        >
          {/* Grabber + header: always a drag-to-dismiss zone. touch-none keeps the
              browser from treating the downward drag as a page scroll / pull-to-
              refresh (React's touchmove is passive, so preventDefault alone can't)
              — the drag is fully JS-owned here. */}
          <div className="touch-none" onTouchStart={(e) => onDragStart(e, false)} onTouchMove={onDragMove} onTouchEnd={onDragEnd} onTouchCancel={onDragEnd}>
            <div className="flex justify-center pt-2 pb-1">
              <span className="h-1 w-10 rounded-full bg-line-strong" aria-hidden />
            </div>
            {header}
          </div>
          {/* Body: scrolls and text-selects freely. When it's already at the top,
              a downward drag here also slides the sheet closed (scrollTop guard in
              onDragStart/onDragMove), so the whole sheet — not just the grabber —
              can be flicked away; mid-scroll drags still scroll. Not touch-none:
              it must keep its native scroll. */}
          <div
            ref={bodyRef}
            className={bodyClass}
            style={bodyStyle}
            onTouchStart={(e) => onDragStart(e, true)}
            onTouchMove={onDragMove}
            onTouchEnd={onDragEnd}
            onTouchCancel={onDragEnd}
          >
            {children}
          </div>
        </div>
      </div>
    );
  }

  if (peek) {
    // Docked to one edge of the content region: top/bottom clear a top/bottom bar,
    // and the docked edge clears that side's rail (0 unless a rail is there, and
    // computeShape already refuses an edge a rail occupies). Non-modal — no
    // backdrop, so the list stays live underneath.
    //
    // The three edge-dependent details have to agree: the dock offset, the border
    // (drawn on the panel's inner side, facing the content), and the resize handle
    // (also inner). A left dock mirrors all three.
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-label={title || "Item"}
        className={`fixed z-40 flex flex-col overflow-hidden bg-surface-2 shadow-2xl shadow-black/50 ${
          dockLeft ? "border-r border-line-strong" : "border-l border-line-strong"
        }`}
        style={{
          top: "var(--nav-pt, 0px)",
          bottom: "var(--nav-pb, 0px)",
          ...(dockLeft
            ? { left: "var(--nav-pl, 0px)" }
            : { right: "var(--nav-pr, 0px)" }),
          // A dragged width wins (persisted); otherwise the responsive default:
          // non-wide holds the ~48rem canvas column comfortably (up from 34rem,
          // which squished it); wide (song chord charts) stays roomier. The vw
          // cap keeps the default responsive — it shrinks with the window, and
          // the peek only activates at ≥1280px of content (PEEK_MIN_CONTENT).
          width:
            peekWidth != null
              ? `${peekWidth}px`
              : wide
                ? "min(60rem, 50vw)"
                : "min(52rem, 46vw)",
        }}
      >
        {/* Drag handle on the panel's INNER edge — the one facing the content, so
            it's the resizable one: right edge when docked left, left edge when
            docked right. A 6px hit strip along the full height; the visible
            hairline brightens on hover/drag. touch-none so a touch drag resizes
            instead of scrolling. Double-click resets to default. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onDoubleClick={onResizeReset}
          className={`group absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none select-none ${
            dockLeft ? "right-0" : "left-0"
          }`}
        >
          <span
            aria-hidden
            className={`absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-[var(--accent,#2563eb)] ${
              dockLeft ? "right-0" : "left-0"
            }`}
          />
        </div>
        {panel}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 py-3 sm:px-6 sm:py-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-line bg-[var(--background)] shadow-2xl ${
          wide ? "max-w-5xl" : "max-w-3xl"
        }`}
      >
        {panel}
      </div>
    </div>
  );
}
