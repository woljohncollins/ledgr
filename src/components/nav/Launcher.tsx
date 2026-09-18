// The mobile nav drawer (ADR-143, supersedes the S6 pop-up sheet + S6a bar
// swipe). ONE always-mounted, full-width, bottom-flush panel: grip row + the
// bar row (passed in by NavShell) + the tile grid beneath it. Closed, the
// panel is translated down so only grip + bar show; opening slides the same
// panel up to reveal the grid: the bar IS the drawer's first row, so the two
// can never differ in width, corners, or icons. Height is content-determined
// (the measured grid height is the travel distance), never a fixed vh.
//
// Gesture model: the whole panel is draggable. A touch anywhere claims the
// drag after ~8px of mostly-vertical movement (so taps still navigate),
// then tracks the finger 1:1 with direct DOM writes (no re-render per frame).
// On release it snaps open/closed by velocity first (a flick wins regardless
// of distance), else by the halfway point, with an eased CSS settle. Every
// gesture starts from the panel's LIVE transform, so a new drag mid-settle or
// mid-anything grabs it in place and there is no stuck-partway state. Scroll
// isolation is CSS touch-action (React's root touch listeners are passive, so
// preventDefault is unreliable). No dependency (Principle 5).
"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { Icon } from "@/components/nav/NavGlyphs";
import { badgeCount } from "@/lib/format-count";

export type LauncherTile = {
  label: string;
  href: string;
  icon: string;
  count?: number | null;
  // An overlay tile (ADR-182): Search in "palette" mode opens the command
  // palette rather than navigating, so the drawer tile must do what the bar slot
  // does. `href` still identifies the tile (it's the React key and the
  // already-in-the-bar filter), it just isn't followed.
  onSelect?: () => void;
};

// Pre-hydration fallback for the closed offset: the SSR frame can't know the
// measured grid height, so it hides everything below the grip + bar row via
// calc(). Must roughly track the grip + bar row's rendered height; the precise
// measured value takes over in the first layout effect.
const CLOSED_FALLBACK = "translateY(calc(100% - 4.75rem - env(safe-area-inset-bottom)))";

// Release faster than this (px/ms) counts as a flick and wins over position.
const FLICK_VELOCITY = 0.4;

export default function Launcher({
  open,
  onOpenChange,
  tiles,
  barRow,
  onDragClaim,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tiles: LauncherTile[];
  // The bar slots row, rendered by NavShell: the drawer's always-visible first row.
  barRow: ReactNode;
  // Fires the moment a real drag is claimed (not a tap), so NavShell can close
  // any open bar popover: a swipe fires no click, so the outside-click closer
  // that normally dismisses it never runs.
  onDragClaim?: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  // The drag travel distance = the grid section's rendered height.
  const [reveal, setReveal] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => setReveal(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Lock the page scroll behind the drawer while it's open, so a drag on the
  // drawer can't scroll the page underneath. Locks <html> (not body) so the
  // grid's own inner scroll (the max-h safety valve) still works.
  useEffect(() => {
    if (!open) return;
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = "hidden";
    return () => {
      el.style.overflow = prev;
    };
  }, [open]);

  // --- The drag state machine ------------------------------------------------
  // Kept in a ref: touchmove writes styles straight to the DOM, so dragging
  // never re-renders React. `claimed` flips after the slop threshold; a tap
  // that never claims leaves click handling untouched.
  const drag = useRef<{
    startX: number;
    startY: number;
    startTy: number;
    lastY: number;
    lastT: number;
    v: number;
    claimed: boolean;
  } | null>(null);
  const swallowClick = useRef(false);

  const currentTy = () => {
    const el = panel.current;
    if (!el) return 0;
    const t = getComputedStyle(el).transform;
    return t === "none" ? 0 : new DOMMatrixReadOnly(t).m42;
  };

  // Write the panel position straight to the DOM. `animate: false` pins the
  // transition off (finger tracking); `animate: true` clears the inline
  // override so the motion-safe transition classes take over for the settle —
  // which is also what keeps prefers-reduced-motion honored, in CSS.
  const applyTy = (ty: number, animate: boolean) => {
    const max = reveal ?? 0;
    const el = panel.current;
    const bd = backdrop.current;
    if (el) {
      el.style.transition = animate ? "" : "none";
      el.style.transform = `translateY(${ty}px)`;
    }
    if (bd) {
      bd.style.transition = animate ? "" : "none";
      bd.style.opacity = String(max > 0 ? 1 - ty / max : 0);
    }
  };

  const onTouchStart = (e: ReactTouchEvent) => {
    if (reveal == null) return;
    const t = e.touches[0];
    drag.current = {
      startX: t.clientX,
      startY: t.clientY,
      // Read the LIVE position so a drag grabs the panel mid-settle cleanly.
      startTy: currentTy(),
      lastY: t.clientY,
      lastT: e.timeStamp,
      v: 0,
      claimed: false,
    };
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const d = drag.current;
    if (!d || reveal == null) return;
    const t = e.touches[0];
    const dx = t.clientX - d.startX;
    const dy = t.clientY - d.startY;
    if (!d.claimed) {
      // Horizontal intent: not ours, stand down for the rest of this touch.
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        drag.current = null;
        return;
      }
      if (Math.abs(dy) < 8 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
      // Inside a scrolled grid, a downward drag means "scroll back up", not
      // "dismiss" (mirrors the old scrollTop guard); the grid's touch-pan-y
      // handles the scrolling natively. And an upward drag with the panel
      // already fully open has nowhere to go — don't claim, so the grid can
      // scroll down if it overflows.
      const g = grid.current;
      if (g?.contains(e.target as Node) && (g?.scrollTop ?? 0) > 0) {
        drag.current = null;
        return;
      }
      if (dy < 0 && d.startTy <= 0) return;
      d.claimed = true;
      onDragClaim?.();
      navigator.vibrate?.(8);
    }
    // Follow the finger 1:1, clamped to the panel's travel range.
    applyTy(Math.min(Math.max(d.startTy + dy, 0), reveal), false);
    // Smoothed velocity so one jittery last sample doesn't decide the snap.
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) {
      d.v = 0.6 * ((t.clientY - d.lastY) / dt) + 0.4 * d.v;
    }
    d.lastY = t.clientY;
    d.lastT = e.timeStamp;
  };

  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.claimed || reveal == null) return;
    // Swallow the click this drag may synthesize — but only briefly: browsers
    // usually fire no click at all after a moved touch, and a flag left armed
    // would eat the user's NEXT real tap.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 80);
    // Velocity first: a flick opens/closes regardless of how far the panel
    // travelled. Otherwise, whichever side of halfway it rests on wins.
    const next = Math.abs(d.v) > FLICK_VELOCITY ? d.v < 0 : currentTy() < reveal / 2;
    applyTy(next ? 0 : reveal, true);
    onOpenChange(next);
  };

  // A claimed drag must not also fire the tap it started on (a slot link, a
  // tile). Capture-phase swallow, cleared per gesture.
  const onClickCapture = (e: ReactMouseEvent) => {
    if (swallowClick.current) {
      e.preventDefault();
      e.stopPropagation();
      swallowClick.current = false;
    }
  };

  const restingTransform =
    reveal == null
      ? open
        ? "translateY(0px)"
        : CLOSED_FALLBACK
      : `translateY(${open ? 0 : reveal}px)`;

  return (
    <>
      {/* Backdrop: always mounted so its opacity can track the drag; it only
          intercepts touches while the drawer is open. */}
      <div
        ref={backdrop}
        aria-hidden
        onClick={() => open && onOpenChange(false)}
        className="fixed inset-0 z-[39] bg-black/60 motion-safe:transition-opacity motion-safe:duration-[280ms] sm:hidden"
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
      />
      <div
        ref={panel}
        className="fixed inset-x-0 bottom-0 z-40 touch-none select-none rounded-t-2xl border-t border-neutral-800 bg-neutral-900/95 shadow-2xl shadow-black/50 backdrop-blur motion-safe:[transition:transform_0.28s_cubic-bezier(0.2,0.9,0.3,1)] sm:hidden"
        style={{ transform: restingTransform }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={onClickCapture}
      >
        {/* Grip: tap toggles; the sheet-grabber affordance for the drag. */}
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-label={open ? "Close all destinations" : "All destinations (pull up)"}
          aria-expanded={open}
          className="flex w-full justify-center py-1.5"
        >
          <span className="h-1 w-8 rounded-full bg-neutral-600" aria-hidden />
        </button>
        {/* The bar row owns the safe-area clearance: closed it keeps the icons
            above the home indicator, open the same padding reads as the gap
            between the bar and the grid. */}
        <div className="pb-[env(safe-area-inset-bottom)]">{barRow}</div>
        {/* The revealed section. Its measured height IS the drag travel, so
            the drawer is exactly as tall as its contents. Inert while closed
            so offscreen tiles can't take focus or clicks. max-h is a safety
            valve only (inner scroll), not a design height. */}
        <div
          ref={grid}
          inert={!open}
          className="max-h-[65vh] touch-pan-y overflow-y-auto overscroll-contain"
        >
          <div className="ui-section-label px-4 pb-1 pt-1">Go to</div>
          <div className="grid grid-cols-5 gap-1 px-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {tiles.map((t) => {
              const tileClass =
                "relative flex flex-col items-center gap-1.5 rounded-card px-0.5 py-2.5 text-ink-muted hover:bg-surface-2 hover:text-ink";
              const body = (
                <>
                  <span className="relative inline-flex">
                    <Icon icon={t.icon} />
                    {t.count != null && t.count > 0 && (
                      <span
                        className="absolute -right-2 -top-1 rounded-full px-1 text-[9px] font-medium leading-tight text-white"
                        style={{ background: "var(--accent-gradient, var(--accent))" }}
                      >
                        {badgeCount(t.count)}
                      </span>
                    )}
                  </span>
                  <span className="w-full truncate text-center text-[10px]">{t.label}</span>
                </>
              );
              // A tile that opens an overlay closes the drawer first, so the
              // overlay isn't stacked behind it (same order the bar slot uses).
              return t.onSelect ? (
                <button
                  key={t.href}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    t.onSelect!();
                  }}
                  className={tileClass}
                >
                  {body}
                </button>
              ) : (
                <Link
                  key={t.href}
                  href={t.href}
                  onClick={() => onOpenChange(false)}
                  className={tileClass}
                >
                  {body}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
