// Table of contents (ADR-114, reworked by ADR-167): a Notion-style outline built
// from the item body's headings, universal across every canvas type and every
// surface that renders a body editor.
//
// POSITIONING (ADR-167). The outline is container-relative, not viewport-
// relative: it renders as a `sticky top-0 h-0` layer that must be the FIRST
// child of its [data-toc-scope]. One pattern pins it correctly against whatever
// actually scrolls — the window on the full page, the peek's scroll body in the
// modal, and each Desk panel's own overflow-auto div — with no coordinate math
// and no per-host special-casing. The old `fixed`-to-viewport rail could only
// ever serve one document per screen, which is why the Desk (N panels, N
// documents) had no outline at all.
//
// THREE STATES, chosen from the CONTAINER's measured size (not a viewport media
// query, so a slim Desk panel behaves like a phone and a wide one like a page):
//   1. collapsed — a thin right-edge rail of marks, taking no layout width.
//   2. flyout    — hover (pointer) or click/tap (touch) expands the marks into
//                  the heading list, floating over the content. Its header row
//                  carries the pin.
//   3. pinned    — a docked, drag-resizable sidebar the content makes room for.
//                  Remembered PER ITEM (users.settings.tocPinnedItems) so a long
//                  note you pinned once opens pinned everywhere.
// Below RAIL_MIN the rail gives way to the original round button + bottom sheet.
//
// The engine reads the live editor DOM (.ledgr-prose), so the outline tracks
// edits as you type, and drives scroll + active-section tracking against
// whatever actually scrolls (getScrollParent). It self-gates: with fewer than
// two headings of the enabled levels, it renders nothing. Heading nodes are
// never mutated (ProseMirror owns that DOM); we re-query live by document order
// and key the list by index.
//
// The open presentations also list the body's COMMENTS (ADR-170) below the
// headings, from the same DOM read, so every comment in a note is in one place.
// The collapsed rail stays headings-only, and the two-heading gate is unchanged
// (Brandon, 2026-07-30): a note too short for an outline keeps its comments in
// the margin and on their inline icons.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COMMENT_BUBBLE_PATH } from "@/components/markdown-editor/toolbar-icons";
import { badgeCount } from "@/lib/format-count";

type Heading = { text: string; level: number };
type CommentRow = { note: string; anchor: string };

const MIN_HEADINGS = 2;

// Container width (px) at which the marks rail replaces the button + sheet.
const RAIL_MIN = 560;
// Pinning needs both room for a sidebar AND a tall enough window. Width alone
// can't express "tablet yes, phone no": a landscape phone is WIDER than a
// portrait tablet, so the height clause is what separates them (Brandon,
// 2026-07-27 — a pinned column would eat too much of a phone screen).
const PIN_MIN_W = 640;
const PIN_MIN_H = 600;

// Pinned sidebar width: default and drag bounds (px).
const PIN_DEFAULT_W = 240; // 15rem
const PIN_MIN_PX = 192; // 12rem
const PIN_MAX_PX = 384; // 24rem
// Per-device, like ledgr:peek-width — how wide the rail is is about the screen
// you're on, not about the note (which is why the PIN itself syncs and this
// doesn't).
const PIN_WIDTH_KEY = "ledgr:toc-width";

// Width of a collapsed rail mark and the label indent, per heading level.
const MARK_WIDTH: Record<number, number> = { 1: 18, 2: 13, 3: 9 };
const INDENT_PX: Record<number, number> = { 1: 8, 2: 18, 3: 28 };

function readStoredWidth(): number {
  if (typeof window === "undefined") return PIN_DEFAULT_W;
  try {
    const n = parseInt(localStorage.getItem(PIN_WIDTH_KEY) || "", 10);
    return Number.isFinite(n) ? Math.max(PIN_MIN_PX, Math.min(PIN_MAX_PX, n)) : PIN_DEFAULT_W;
  } catch {
    return PIN_DEFAULT_W;
  }
}

// The nearest scrollable ancestor (the modal body, a Desk panel); null means the
// window/page.
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

// How far down the sticky layer pins, in px. Read off the layer's own resolved
// `top` rather than by parsing --nav-pt/--item-chrome-h: those hold authored
// tokens ("3.5rem"), so getPropertyValue + parseFloat read 3.5px. A positioned
// element's computed `top` is a used length, so this stays right whatever the
// class's calc() sums and whichever breakpoint applies.
function stickyTopOf(layer: HTMLElement | null): number {
  return layer ? parseFloat(getComputedStyle(layer).top) || 0 : 0;
}

// The block a comment segment sits in — how the outline tells "one phrase split by
// a nested mark" (same block) from "a comment bridging two paragraphs" (different
// blocks) when it rebuilds the anchor preview.
function blockOf(el: HTMLElement): Element | null {
  return el.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,pre,figcaption");
}

// A heading's top relative to the scroll viewport (container top, or 0 = window).
function topWithin(el: HTMLElement, container: HTMLElement | null): number {
  const top = el.getBoundingClientRect().top;
  return container ? top - container.getBoundingClientRect().top : top;
}

function scrollToEl(el: HTMLElement, container: HTMLElement | null, offset: number) {
  if (container) {
    const top =
      el.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      offset;
    container.scrollTo({ top, behavior: "smooth" });
  } else {
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: "smooth" });
  }
}

// Monochrome stroke pin, inheriting currentColor like the outline's other icons
// (no emoji, no colored default — Brandon, 2026-07-27).
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      fillOpacity={filled ? 0.15 : undefined}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

export default function FloatingToc({
  itemId,
  levels,
  pinned: initialPinned,
}: {
  // Which item this outline belongs to — the key for the per-item pin.
  itemId: string;
  levels: number[];
  // Whether this item is in users.settings.tocPinnedItems (resolved by the host:
  // server-side on the canvas, from DeskContext in a Desk panel).
  pinned: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLElement | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const scopeRef = useRef<HTMLElement | null>(null);
  const offsetRef = useRef(16);

  const [headings, setHeadings] = useState<Heading[]>([]);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [active, setActive] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Click/tap-held flyout. Hover alone is a pure-CSS affordance that touch can
  // never reach, so the marks are also a button.
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(initialPinned);
  // Lazy-init from localStorage, like Modal.tsx's peek width. Safe against
  // hydration mismatch: the server pass returns the default, and width only
  // reaches the DOM in the pinned branch, which can't render until the
  // ResizeObserver has measured (box.w === 0 short-circuits above).
  const [width, setWidth] = useState(readStoredWidth);
  // The scope's measured box: `w` is the scope's own width, `h` the height of
  // the VISIBLE scroll viewport it lives in (the panel/modal box, or the window
  // below the nav). Both drive the presentation; `h` is also the pinned rail's
  // height. w=0 means "not measured yet" and suppresses everything.
  const [box, setBox] = useState({ w: 0, h: 0 });

  // CSS selector for the enabled heading levels, in document order.
  const selector = [...levels]
    .filter((l) => l >= 1 && l <= 3)
    .sort((a, b) => a - b)
    .map((l) => `h${l}`)
    .join(",");

  // Live heading elements (re-queried, never cached as detached nodes), so a
  // jump/active read always targets a node ProseMirror currently owns.
  const liveEls = useCallback((): HTMLElement[] => {
    const prose = proseRef.current;
    if (!prose || !selector) return [];
    return Array.from(prose.querySelectorAll<HTMLElement>(selector));
  }, [selector]);

  // Same discipline for the comment cards: re-query live, never cache. In the
  // editor these are ProseMirror widget decorations, which it replaces freely.
  const liveNoteEls = useCallback((): HTMLElement[] => {
    const prose = proseRef.current;
    if (!prose) return [];
    return Array.from(prose.querySelectorAll<HTMLElement>(".cmt-note"));
  }, []);

  // Rebuild the outline from the current DOM. Finds the body editor within this
  // canvas's own scope (critical: several scopes can be mounted at once — the
  // page canvas behind an open modal, or four Desk panels — so we must read THIS
  // instance's .ledgr-prose, not document's first).
  const rescan = useCallback(() => {
    const scope = scopeRef.current ?? document.body;
    const prose = scope.querySelector<HTMLElement>(".ledgr-prose");
    proseRef.current = prose;
    if (!prose || !selector) {
      setHeadings([]);
      setComments([]);
      return;
    }
    scrollElRef.current = getScrollParent(prose);
    // Jump offset matches where the sticky layer sits (the page's fixed header
    // plus the item canvas's sticky chrome row; both zeroed by the modal and by a
    // Desk panel, which are their own scroll containers), plus breathing room.
    offsetRef.current = stickyTopOf(rootRef.current) + 16;
    const els = Array.from(prose.querySelectorAll<HTMLElement>(selector));
    setHeadings(
      els.map((el) => ({
        text: (el.textContent || "").trim() || "Untitled",
        level: Number(el.tagName.slice(1)) || 1,
      }))
    );
    // Comments (ADR-170) come from the SAME live DOM read as the headings: each
    // `.cmt-note` is a comment, and the `.cmt` span(s) immediately before it are
    // the text it's anchored to. Reading the rendered DOM rather than the
    // markdown is what makes the list track edits as you type, exactly like the
    // heading list. Only the strings go into state — the nodes are re-queried at
    // click time (liveNoteEls), since ProseMirror owns and replaces them.
    // Each comment carries its note as `data-note` on the card AND on every span
    // of the text it annotates — the attribute that makes a comment BRIDGING
    // several blocks one comment (comment-markdown.ts). One card per comment means
    // one row here even when the anchor runs across three paragraphs, and matching
    // on that attribute rebuilds the whole anchored phrase: across the blocks it
    // bridges, and across the text-node splits a nested **bold** causes.
    const segments = Array.from(prose.querySelectorAll<HTMLElement>("[data-note]")).filter(
      (el) => !el.classList.contains("cmt-note")
    );
    setComments(
      Array.from(prose.querySelectorAll<HTMLElement>(".cmt-note")).map((el) => {
        const key = el.dataset.note;
        const mine = segments.filter((s) => s.dataset.note === key);
        // Joined with nothing WITHIN a block (a **bold** word splits one phrase
        // into several spans and must read as one), with a space between blocks
        // (paragraph one's tail and paragraph two's head are separate sentences).
        const anchor = mine
          .map((s, i) => {
            const gap = i > 0 && blockOf(s) !== blockOf(mine[i - 1]) ? " " : "";
            return gap + (s.textContent || "");
          })
          .join("");
        return {
          note: (el.textContent || "").trim() || "Empty comment",
          anchor: anchor.trim(), // "" for a point comment (.cmt-point)
        };
      })
    );
  }, [selector]);

  // Resolve the scope once, then watch its subtree: catches the (lazy) editor
  // mounting and every heading add/remove/retitle. Debounced — scanning is cheap
  // but edits are bursty. A ResizeObserver on the same element drives the
  // presentation, so a Desk panel dragged narrower switches to the sheet live.
  useEffect(() => {
    const scope = rootRef.current?.closest<HTMLElement>("[data-toc-scope]") ?? document.body;
    scopeRef.current = scope;
    let t: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(rescan, 200);
    };
    // The visible height to measure against: the scroll container's box in a
    // Desk panel or the modal, else the window minus the fixed nav. This is what
    // makes canPin correct in every host — and it's what keeps a landscape phone
    // out (short window) while letting a portrait tablet in.
    const measure = () => {
      // In the window case the visible bottom is above the docked nav, not at
      // innerHeight — read it off body's used padding-bottom (globals.css sets it
      // from --nav-pb), same trick as stickyTopOf. A scroll container's own box
      // already excludes it.
      const h =
        scrollElRef.current?.clientHeight ??
        window.innerHeight -
          stickyTopOf(rootRef.current) -
          (parseFloat(getComputedStyle(document.body).paddingBottom) || 0);
      setBox({ w: scope.clientWidth, h });
    };
    rescan();
    const mo = new MutationObserver(schedule);
    mo.observe(scope, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(measure); // fires once on observe
    ro.observe(scope);
    window.addEventListener("resize", measure);
    return () => {
      if (t) clearTimeout(t);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [rescan]);

  // Close the click-held flyout on Esc or an outside click (hover-out already
  // handles the pointer case; this is the touch/keyboard path).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Active-section tracking: the current section is the last heading scrolled
  // past the offset line. Deterministic and flicker-free; rAF-throttled.
  useEffect(() => {
    if (headings.length < MIN_HEADINGS) return;
    const scroller = scrollElRef.current;
    let frame = 0;
    const recompute = () => {
      frame = 0;
      const els = liveEls();
      if (els.length === 0) return;
      let next = 0;
      for (let i = 0; i < els.length; i++) {
        if (topWithin(els[i], scroller) - offsetRef.current <= 1) next = i;
        else break;
      }
      setActive(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(recompute);
    };
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    recompute();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [headings.length, liveEls]);

  const showRail = box.w >= RAIL_MIN;
  const canPin = box.w >= PIN_MIN_W && box.h >= PIN_MIN_H;
  const isPinned = pinned && canPin && headings.length >= MIN_HEADINGS;

  // Give the content its right inset while pinned. One variable drives BOTH the
  // sidebar's width and the scope's padding, so they cannot drift apart. This
  // writes to a node the component doesn't render (the scope), which is the
  // deliberate trade in ADR-167: the alternative is threading pin state up into
  // three separate server components. Cleanup always restores it.
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    if (!isPinned) {
      scope.style.removeProperty("--toc-pin-w");
      return;
    }
    scope.style.setProperty("--toc-pin-w", `${width}px`);
    return () => {
      scope.style.removeProperty("--toc-pin-w");
    };
  }, [isPinned, width]);

  const jump = useCallback(
    (i: number) => {
      const el = liveEls()[i];
      if (el) scrollToEl(el, scrollElRef.current, offsetRef.current);
    },
    [liveEls]
  );

  const jumpToComment = useCallback(
    (i: number) => {
      const el = liveNoteEls()[i];
      // Prefer the anchored text over the card: on a wide screen the card floats
      // out in the margin and can sit a line or two off from what it points at.
      const prev = el?.previousElementSibling as HTMLElement | null;
      const target = prev?.classList.contains("cmt") ? prev : el;
      if (target) scrollToEl(target, scrollElRef.current, offsetRef.current);
    },
    [liveNoteEls]
  );

  // Persist the pin to owner settings (per item, so it follows the note across
  // devices). Optimistic: flip local state first, then PATCH the existing
  // generic settings route — no bespoke endpoint.
  const togglePin = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    setOpen(false);
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { settings?: { tocPinnedItems?: string[] } } | null) => {
        const current = d?.settings?.tocPinnedItems ?? [];
        const list = next
          ? current.includes(itemId)
            ? current
            : [...current, itemId]
          : current.filter((x) => x !== itemId);
        return fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tocPinnedItems: list }),
        });
      })
      .catch(() => {
        /* offline / failed write: the pin still applies for this session */
      });
  }, [itemId, pinned]);

  // Drag-to-resize the pinned rail, on its inner (left) edge — the same
  // pointer-capture handle Modal.tsx uses for the peek panel, same
  // double-click-to-reset.
  const resizeStart = useRef<{ x: number; w: number } | null>(null);
  const clampW = (n: number) => Math.max(PIN_MIN_PX, Math.min(PIN_MAX_PX, n));
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    resizeStart.current = { x: e.clientX, w: width };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {}
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeStart.current) return;
    // Docked right, so dragging the left edge leftward widens it.
    setWidth(clampW(resizeStart.current.w + (resizeStart.current.x - e.clientX)));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resizeStart.current) return;
    const final = clampW(
      Math.round(resizeStart.current.w + (resizeStart.current.x - e.clientX))
    );
    resizeStart.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {}
    setWidth(final);
    try {
      localStorage.setItem(PIN_WIDTH_KEY, String(final));
    } catch {}
  };
  const onResizeReset = () => {
    setWidth(PIN_DEFAULT_W);
    try {
      localStorage.removeItem(PIN_WIDTH_KEY);
    } catch {}
  };

  // The sticky layer always renders so the mount effect can locate the scope
  // (and measure it) before the editor — and its headings — exist. It must be
  // the scope's first child: a sticky box only pins while its containing block
  // is in view, so mounting it after the content would leave it stuck at the
  // bottom. h-0 keeps it out of the layout entirely.
  //
  // z-40, above the scope's other sticky bars (the editor's formatting bar at
  // z-30, the item chrome row at z-35): being first child means an equal z-index
  // loses the DOM-order tiebreak — they painted over the flyout and the pinned
  // sidebar. This still sits under the app's overlays (z-50+). Don't lower it.
  const layer = (children?: React.ReactNode) => (
    <div
      ref={rootRef}
      className="pointer-events-none sticky top-[calc(var(--nav-pt,0px)_+_var(--safe-top))] z-40 h-0 sm:top-[calc(var(--nav-pt,0px)_+_var(--item-chrome-h,0px)_+_var(--safe-top))]"
    >
      {children}
    </div>
  );

  // Nothing to show, or nothing measured yet (rendering before the first
  // ResizeObserver callback would flash the narrow presentation on a wide page).
  if (headings.length < MIN_HEADINGS || box.w === 0) return layer();

  const pinButton = canPin ? (
    <button
      type="button"
      onClick={togglePin}
      aria-pressed={pinned}
      title={pinned ? "Unpin the outline" : "Pin the outline as a sidebar"}
      aria-label={pinned ? "Unpin the outline" : "Pin the outline as a sidebar"}
      className={`shrink-0 rounded p-1 transition-colors ${
        pinned
          ? "text-[var(--accent)] hover:bg-surface-3"
          : "text-ink-faint hover:bg-surface-3 hover:text-ink"
      }`}
    >
      <PinIcon filled={pinned} />
    </button>
  ) : null;

  const listHeader = (
    <div className="flex items-center justify-between gap-2 px-2 pb-1">
      <p className="ui-section-label text-ink-faint">On this page</p>
      {pinButton}
    </div>
  );

  const labelList = (
    <ul className="space-y-0.5">
      {headings.map((h, i) => (
        <li key={i}>
          <button
            type="button"
            onClick={() => {
              jump(i);
              setSheetOpen(false);
              setOpen(false);
            }}
            style={{ paddingLeft: INDENT_PX[h.level] ?? 8 }}
            className={`block w-full truncate rounded py-1.5 pr-2 text-left text-sm transition-colors ${
              i === active
                ? "bg-[var(--accent)]/15 font-medium text-[var(--accent)]"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );

  // The comment list (ADR-170 follow-on): every comment in the note in one
  // place, click to scroll to it. Two lines per row — the note, then the text
  // it's anchored to — because "tighten this" on its own doesn't say where it
  // points (Brandon, 2026-07-30). Renders in all three OPEN presentations, and
  // deliberately NOT on the collapsed marks rail, which stays headings-only.
  //
  // No active tracking here: highlighting "the comment nearest the viewport"
  // would fight the heading highlight for attention, and the list is short.
  const commentSection = comments.length > 0 && (
    <>
      <div className="my-2 border-t border-line" />
      <p className="ui-section-label px-2 pb-1 text-ink-faint">
        Comments · {badgeCount(comments.length)}
      </p>
      <ul className="space-y-0.5">
        {comments.map((c, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => {
                jumpToComment(i);
                setSheetOpen(false);
                setOpen(false);
              }}
              className="group flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
            >
              {/* --cmt-line-strong is declared on .ledgr-prose and this renders
                  outside it, so the fallback is load-bearing. If that bothers a
                  future reader, promote the --cmt-* vars to a shared scope —
                  don't invent a second yellow. */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                aria-hidden
                className="mt-0.5 shrink-0 text-[var(--cmt-line-strong,#facc15)]"
              >
                <path fill="currentColor" d={COMMENT_BUBBLE_PATH} />
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink-muted group-hover:text-ink">
                  {c.note}
                </span>
                {c.anchor && (
                  <span className="ui-meta block truncate text-ink-faint">{c.anchor}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  // --- Pinned: a docked, resizable column the content makes room for ---------
  if (isPinned) {
    return layer(
      <aside
        aria-label="Table of contents"
        // right: -width, not 0. --toc-pin-w is the scope's padding-right, which
        // also shrinks this sticky layer's content box — so `right: 0` would
        // park the sidebar one full width INSIDE the gutter it just opened and
        // overlap the prose. Offsetting by exactly its own width lands it flush
        // in that gutter, and since both numbers are `width` they can't drift.
        style={{ width, height: box.h, right: -width }}
        className="pointer-events-auto absolute top-0 flex flex-col overflow-hidden border-l border-line bg-surface-1"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the outline"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onDoubleClick={onResizeReset}
          className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none select-none"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-[var(--accent)]"
          />
        </div>
        <div className="overflow-y-auto p-2 pt-3">
          {listHeader}
          {labelList}
          {commentSection}
        </div>
      </aside>
    );
  }

  // --- Wide container: marks rail → hover/click flyout -----------------------
  if (showRail) {
    return layer(
      <nav
        aria-label="Table of contents"
        className="group pointer-events-auto absolute right-2 top-4"
      >
        <button
          type="button"
          aria-label="Table of contents"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex flex-col items-end gap-1.5 py-2 pl-6 transition-opacity duration-150 group-hover:opacity-0 ${
            open ? "opacity-0" : ""
          }`}
        >
          {headings.map((h, i) => (
            <span
              key={i}
              style={{ width: MARK_WIDTH[h.level] ?? 9 }}
              className={`h-[3px] rounded-full transition-colors ${
                i === active ? "bg-[var(--accent)]" : "bg-ink-faint"
              }`}
            />
          ))}
        </button>
        <div
          className={`absolute right-0 top-0 max-h-[70vh] w-64 translate-x-2 overflow-y-auto rounded-card border border-line-strong bg-surface-2 p-2 opacity-0 shadow-xl shadow-black/40 backdrop-blur transition-all duration-150 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 ${
            open ? "pointer-events-auto translate-x-0 opacity-100" : "pointer-events-none"
          }`}
        >
          {listHeader}
          {labelList}
          {commentSection}
        </div>
      </nav>
    );
  }

  // --- Narrow container (phone, slim Desk panel): button + bottom sheet ------
  return layer(
    <>
      <button
        type="button"
        aria-label="Table of contents"
        aria-expanded={sheetOpen}
        onClick={() => setSheetOpen(true)}
        // Bottom of the visible box, not the top: at top-4 it landed on the item
        // chrome row's kebab on a phone (Brandon, 2026-07-31). box.h is the scroll
        // viewport's height, so this stays container-relative (ADR-167) — bottom
        // of the panel in a Desk, bottom of the screen on a page — and 3.75rem
        // clears the button's own height plus a gap.
        style={{ top: `calc(${box.h}px - 3.75rem)` }}
        className="pointer-events-auto absolute right-4 flex h-11 w-11 items-center justify-center rounded-full border border-line-strong bg-surface-2/95 text-ink-muted shadow-lg backdrop-blur transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>

      {sheetOpen && (
        <div
          className="pointer-events-auto fixed inset-0 z-[70] flex flex-col justify-end bg-black/50"
          onClick={() => setSheetOpen(false)}
        >
          <div
            className="max-h-[60vh] overflow-y-auto rounded-t-2xl border-t border-line-strong bg-surface-1 p-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong" />
            {listHeader}
            {labelList}
            {commentSection}
          </div>
        </div>
      )}
    </>
  );
}
