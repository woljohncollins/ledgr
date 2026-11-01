"use client";

// Pull-down-to-refresh for the phone (John, 2026-11-01: "it looks like it
// needs a refresh"). The installed app turns off the document rubber-band
// (globals.css, display-mode: standalone), so there is no native way to reload
// a page from the Home Screen icon. This listens for a downward drag that
// starts with the page scrolled to the very top, shows a small pill while the
// finger is down, and on release past the threshold re-fetches the route
// (router.refresh) the same way the focus-refresh does. Touch-only: a mouse
// never triggers it, and it stays out of the way inside the item popup.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const THRESHOLD = 72; // px of pull before release counts
const MAX_PULL = 120;

export default function PullToRefresh() {
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined" || !("ontouchstart" in window)) return;

    const eligible = (target: EventTarget | null) => {
      if (window.scrollY > 0) return false;
      if (document.body.dataset.itemPanel === "open") return false;
      // A drag that begins inside something that scrolls on its own (an editor,
      // a horizontally scrolling bar, a scrollable card) belongs to that element.
      let el = target as HTMLElement | null;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) return false;
        el = el.parentElement;
      }
      return true;
    };

    const onStart = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1 || !eligible(e.target)) { startY.current = null; return; }
      startY.current = e.touches[0].clientY;
      pullRef.current = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || window.scrollY > 0) { if (pullRef.current) { pullRef.current = 0; setPull(0); } return; }
      // Rubber-band the distance so a long drag doesn't fly off the top.
      const eased = Math.min(MAX_PULL, dy * 0.55);
      pullRef.current = eased;
      setPull(eased);
    };
    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      const reached = pullRef.current >= THRESHOLD;
      pullRef.current = 0;
      if (!reached) { setPull(0); return; }
      setBusy(true);
      setPull(THRESHOLD * 0.6);
      router.refresh();
      // router.refresh has no completion signal; hold the pill long enough to
      // read as "done" rather than a flicker, then let it go.
      window.setTimeout(() => { setBusy(false); setPull(0); }, 900);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [busy, router]);

  if (pull <= 0) return null;
  const armed = busy || pull >= THRESHOLD;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center sm:hidden"
      style={{ top: `calc(var(--safe-top, 0px) + ${Math.round(pull * 0.5)}px)`, opacity: Math.min(1, pull / THRESHOLD) }}
    >
      <div className="flex items-center gap-2 rounded-full border border-line bg-surface-1/95 px-3 py-1.5 text-xs text-ink shadow-md backdrop-blur">
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent ${busy ? "animate-spin" : ""}`}
          style={busy ? undefined : { transform: `rotate(${Math.round((pull / THRESHOLD) * 360)}deg)` }}
        />
        {busy ? "Refreshing…" : armed ? "Release to refresh" : "Pull to refresh"}
      </div>
    </div>
  );
}
