// A global top loading bar (the YouTube/GitHub-style sliver) that acknowledges a
// tap the instant it lands, then rides out the navigation. App Router has no
// router events, so we detect the *start* by intercepting clicks on internal
// anchors (and back/forward via popstate) and the *finish* by watching for the
// committed pathname to change. Hand-rolled, no dependency (Principle 5).
//
// Why this and not loading.tsx alone: a loading.tsx fallback only appears once
// the destination segment begins rendering, which on a force-dynamic page still
// trails the tap. This bar paints immediately (after a short threshold that lets
// genuinely-instant cached navigations skip it), so the tap never feels ignored.
"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// Wait this long before painting the bar: a navigation that commits faster than
// this (a cached/prefetched route) never flashes a bar at all.
const SHOW_DELAY_MS = 120;
// How often the bar creeps forward while we wait for the route to commit.
const TRICKLE_MS = 300;
// The bar climbs toward this fraction but never reaches the end until the
// navigation actually finishes — the classic "almost there" trickle.
const MAX_TRICKLE = 0.9;
// Safety net: if a navigation never commits (aborted, error), drop the bar
// rather than leave it stuck.
const SAFETY_MS = 12000;
// How long the finished bar lingers at 100% before fading out.
const FADE_MS = 200;

export default function NavProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  // A navigation is in flight (between a qualifying click and the pathname
  // commit). Held in a ref so the document listener reads it without re-binding.
  const active = useRef(false);
  // Whether the bar has actually painted yet (the show-delay has elapsed). Lets
  // finish() cancel silently when the navigation beat the delay.
  const shown = useRef(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trickleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only refs and stable state setters are touched here, so both callbacks are
  // stable for the lifetime of the component — the listeners below bind once.
  const clearWorkTimers = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (trickleTimer.current) clearInterval(trickleTimer.current);
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    showTimer.current = trickleTimer.current = safetyTimer.current = null;
  }, []);

  const finish = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    clearWorkTimers();

    // The navigation beat the show-delay: nothing painted, reset silently.
    if (!shown.current) {
      setVisible(false);
      setProgress(0);
      return;
    }

    setProgress(1);
    fadeTimer.current = setTimeout(() => {
      setVisible(false);
      // Reset width only once it's faded, so the next run starts from the left
      // instead of animating back across the screen.
      fadeTimer.current = setTimeout(() => setProgress(0), FADE_MS);
    }, FADE_MS);
  }, [clearWorkTimers]);

  const begin = useCallback(() => {
    if (active.current) return; // already tracking a navigation
    active.current = true;
    shown.current = false;
    clearWorkTimers();
    if (fadeTimer.current) clearTimeout(fadeTimer.current);

    showTimer.current = setTimeout(() => {
      shown.current = true;
      setProgress(0.08);
      setVisible(true);
      trickleTimer.current = setInterval(() => {
        setProgress((p) => (p >= MAX_TRICKLE ? p : Math.min(MAX_TRICKLE, p + (1 - p) * 0.12 + 0.004)));
      }, TRICKLE_MS);
    }, SHOW_DELAY_MS);

    safetyTimer.current = setTimeout(() => finish(), SAFETY_MS);
  }, [clearWorkTimers, finish]);

  // Finish whenever the committed pathname changes. On mount active is false, so
  // the initial run is a no-op.
  useEffect(() => {
    finish();
  }, [pathname, finish]);

  // Start on a qualifying same-origin link click, or on back/forward.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download") || anchor.dataset.noProgress != null) return;
      const raw = anchor.getAttribute("href");
      if (!raw || raw.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(raw)) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same page (only a hash or search tweak) — no route transition to track.
      if (url.pathname === window.location.pathname) return;
      begin();
    }
    const onPop = () => begin();
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      clearWorkTimers();
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [begin, clearWorkTimers]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-[var(--safe-top)] z-[60] h-0.5">
      <div
        className="h-full origin-left transition-[width,opacity] duration-200 ease-out"
        style={{
          width: `${progress * 100}%`,
          opacity: visible ? 1 : 0,
          background: "var(--accent-gradient, var(--accent))",
          boxShadow: "0 0 8px -1px var(--accent)",
        }}
      />
    </div>
  );
}
