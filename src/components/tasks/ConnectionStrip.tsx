// The connections band on a task row (tasks-row-redesign, ADR-202): tag chips
// plus every other outgoing connection (people, records, links) in one
// horizontal strip. When the chips outgrow the row the strip scrolls sideways —
// it carries [data-scroll-x] so SwipeRow yields the gesture (the ADR-142
// discipline) — and a right-edge fade signals that more chips are hiding.
// Client component only for the overflow measurement; the chips are plain
// links, read-only here (connections are edited on the canvas).
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import PersonAvatar from "@/components/people/PersonAvatar";
import { TAGS_ROLE } from "@/lib/tags";
import type { RowConnection } from "@/lib/task-row-meta";

function PersonIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h7l9 9-7 7-9-9z" />
      <circle cx="8.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function ConnectionStrip({ items }: { items: RowConnection[] }) {
  const scroller = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    // z-[1]: chips must sit above the row's stretched title-link overlay.
    <span className="relative z-[1] min-w-0 flex-1">
      <span
        ref={scroller}
        data-scroll-x
        className="no-scrollbar flex items-center gap-1 overflow-x-auto"
      >
        {items.map((c) => (
          <Link
            key={`${c.role}:${c.id}`}
            href={`/items/${c.id}`}
            title={`${c.title || "Untitled"} (${c.role === TAGS_ROLE ? "tag" : c.type})`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded border border-line px-1.5 text-xs text-ink-subtle hover:border-line-strong hover:text-ink-muted"
          >
            {c.role === TAGS_ROLE ? (
              <TagIcon />
            ) : c.type === "person" ? (
              // The face when the person's built-in Image is set; the glyph
              // otherwise (ADR-202 addendum 3 — "a person assigned to a task").
              c.image ? (
                <PersonAvatar src={c.image} name={c.title} size={14} fallback="icon" />
              ) : (
                <PersonIcon />
              )
            ) : null}
            <span className="truncate">{c.title || "Untitled"}</span>
          </Link>
        ))}
      </span>
      {overflowing && (
        // Rows sit on varying backgrounds (page, hover wash, project cards), so
        // no gradient — a small floating "›" pill signals the hidden tail.
        <span
          aria-hidden
          title="Scroll for more connections"
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center"
        >
          <span className="rounded-full border border-line bg-surface-2 px-1 text-xs leading-4 text-ink-subtle shadow-sm">
            ›
          </span>
        </span>
      )}
    </span>
  );
}
