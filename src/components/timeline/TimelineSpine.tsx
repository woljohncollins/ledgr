// The timeline spine: a vertical center line with entries alternating on either
// side of it, dates popping up opposite the content, grain chips breaking the
// scroll into spans, and a Today marker splitting past from future.
//
// Lifted verbatim out of /items/[id]/timeline (ADR-198, Tyler's everything-
// timeline) so it stops being one page's private rendering (Brandon,
// 2026-09-03). It now takes a TimelineEntry[] from any gatherer, so the same
// display serves a record's history, a saved view of any type, a lens tab, and a
// dashboard widget.
//
// Pure and hook-free on purpose: no data fetching, no routing, no Date.now().
// That is what lets a server page and a client renderer both mount it, and what
// keeps a future spine widget from needing changes here. "Now" arrives as
// `todayBefore` (an index the caller computed), never read from the clock.
import Link from "next/link";
import { grainBucket, DEFAULT_GRAIN, type Grain } from "@/lib/timeline-grain";
import type { TimelineEntry, TimelineUndated } from "@/lib/timeline-entry";

// Per-kind dot + chip colors — the Timeline card's existing vocabulary (sky =
// meeting, amber = milestone) extended with quiet neutrals for the ticks and the
// owner's accent for a generic view row.
const DOT: Record<TimelineEntry["kind"], string> = {
  meeting: "bg-sky-400",
  milestone: "bg-amber-400",
  task: "bg-emerald-600",
  note: "bg-neutral-500",
  link: "bg-neutral-500",
  created: "bg-[var(--accent)]",
  item: "bg-[var(--accent)]",
};

const CHIP: Record<"meeting" | "milestone" | "milestoneDone" | "created" | "item", string> = {
  meeting: "bg-sky-950/50 text-sky-300",
  milestone: "bg-amber-950/50 text-amber-300",
  milestoneDone: "bg-emerald-950/50 text-emerald-300",
  created: "border border-[var(--accent)] bg-surface-1 text-[var(--accent)]",
  item: "bg-surface-2 text-ink-muted",
};

// House-style glyphs (SVG, never emoji) for the small ticks, so a reader
// scanning for "that note" or "that link" finds it by shape (Tyler).
const TICK_ICON: Record<"task" | "note" | "link", string> = {
  task: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.5 12.5l2.5 2.5 4.5-5",
  note: "M7 3h8l4 4v14H7z M15 3v4h4 M10.5 12h6M10.5 16h6",
  link: "M10 14a4.5 4.5 0 0 0 6.36 0l2.5-2.5a4.5 4.5 0 0 0-6.36-6.36l-1.3 1.3 M14 10a4.5 4.5 0 0 0-6.36 0l-2.5 2.5a4.5 4.5 0 0 0 6.36 6.36l1.3-1.3",
};

function TickGlyph({ kind }: { kind: "task" | "note" | "link" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d={TICK_ICON[kind]} />
    </svg>
  );
}

function dayLabel(e: TimelineEntry, tz: string): string {
  return e.date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: e.calendarDay ? "UTC" : tz,
  });
}

function timeLabel(e: TimelineEntry, tz: string): string | null {
  if (!e.hasTime) return null;
  return e.date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

function chipClass(e: TimelineEntry): string {
  if (e.kind === "created") return CHIP.created;
  if (e.kind === "meeting") return CHIP.meeting;
  if (e.kind === "milestone") return e.done ? CHIP.milestoneDone : CHIP.milestone;
  return CHIP.item;
}

// One entry on the spine. Alternation is by running index on desktop; on
// phones everything hangs right of the left-edge spine. The date sits on the
// opposite side of the line from the content (Tyler's "dates popping up on
// the left and right").
function SpineEntry({ e, side, tz }: { e: TimelineEntry; side: "left" | "right"; tz: string }) {
  const big = e.tier === "big";
  const date = dayLabel(e, tz);
  const time = timeLabel(e, tz);
  const dateText = time ? `${date} · ${time}` : date;
  // A link tick's title opens the URL itself (the Links-card rule); everything
  // else opens its item. Titles read as links — ink, underline on hover.
  const href = e.kind === "link" && e.url ? e.url : `/items/${e.itemId}`;
  const external = e.kind === "link" && Boolean(e.url);
  const titleLink = (cls: string) =>
    external ? (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {e.title || "Untitled"}
      </a>
    ) : (
      <Link href={href} className={cls}>
        {e.title || "Untitled"}
      </Link>
    );

  const content = big ? (
    <div className={side === "left" ? "sm:text-right" : ""}>
      {e.label && (
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${chipClass(e)}`}
        >
          {e.label}
        </span>
      )}
      <h3
        className={`mt-1 text-base font-medium leading-snug sm:text-lg ${e.done ? "text-ink-muted" : "text-ink"}`}
      >
        {titleLink("hover:text-ink hover:underline decoration-neutral-600 underline-offset-4")}
      </h3>
      {e.meta && <p className="mt-0.5 text-xs text-ink-subtle">{e.meta}</p>}
      <p className="mt-0.5 text-xs text-ink-subtle sm:hidden">{dateText}</p>
    </div>
  ) : (
    <p
      className={`flex flex-wrap items-center gap-x-1.5 text-sm text-ink-subtle ${
        side === "left" ? "sm:justify-end" : ""
      }`}
    >
      {(e.kind === "task" || e.kind === "note" || e.kind === "link") && <TickGlyph kind={e.kind} />}
      {e.label && <span>{e.label}:</span>}
      {titleLink(
        "text-ink underline decoration-dotted decoration-neutral-600 underline-offset-2 hover:text-ink hover:decoration-[var(--accent)]"
      )}
      <span className="text-ink-faint sm:hidden">· {dateText}</span>
    </p>
  );

  return (
    <li className={`relative ${big ? "py-3" : "py-1.5"}`}>
      {/* The dot, on the spine — vertically centered on the entry (Tyler,
          2026-08-17: top-aligned read as belonging to nothing). */}
      <span
        className={`absolute left-4 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${DOT[e.kind]} ${big ? "h-2.5 w-2.5" : "h-1.5 w-1.5"} sm:left-1/2`}
        aria-hidden
      />
      {/* The date, opposite the content, centered like the dot (desktop only —
          inline on phones). */}
      <span
        className={`absolute top-1/2 hidden -translate-y-1/2 text-xs text-ink-subtle sm:block ${
          side === "left" ? "left-[calc(50%+2rem)]" : "right-[calc(50%+2rem)] text-right"
        }`}
      >
        {dateText}
      </span>
      {/* The content, on its side. */}
      <div className={`pl-10 sm:w-1/2 sm:pl-0 ${side === "left" ? "sm:pr-8" : "sm:ml-auto sm:pl-8"}`}>
        {content}
      </div>
    </li>
  );
}

function SpineChip({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <li className="relative z-10 flex py-3 pl-10 sm:justify-center sm:pl-0">
      <span
        className={`rounded-full border px-3 py-0.5 text-[11px] uppercase tracking-wide ${
          accent
            ? "border-[var(--accent)] bg-surface-1 text-[var(--accent)]"
            : "border-line bg-surface-2 text-ink-subtle"
        }`}
      >
        {children}
      </span>
    </li>
  );
}

export default function TimelineSpine({
  entries,
  tz,
  grain = DEFAULT_GRAIN,
  dir = "asc",
  todayBefore = -1,
  undated = [],
  undatedLabel = "Upcoming",
}: {
  // Ascending by date. The renderer reverses for `dir: "desc"` rather than
  // asking the caller to sort twice.
  entries: TimelineEntry[];
  tz: string;
  grain?: Grain;
  dir?: "asc" | "desc";
  // Index in ASCENDING order before which the Today marker goes; -1 = none.
  // The caller owns "now" (the gatherer's clock read, or a today key), so this
  // component stays pure.
  todayBefore?: number;
  undated?: TimelineUndated[];
  undatedLabel?: string;
}) {
  const ordered = dir === "desc" ? [...entries].reverse() : entries;
  // The ascending boundary, mapped into whichever order we render. Descending
  // puts the future at the top, so the marker sits the same number of entries
  // from the other end.
  const boundary =
    todayBefore > 0 && todayBefore < entries.length
      ? dir === "desc"
        ? entries.length - todayBefore
        : todayBefore
      : -1;

  const rows: React.ReactNode[] = [];
  let bucket = "";
  ordered.forEach((e, i) => {
    if (i === boundary) {
      rows.push(
        <SpineChip key="today" accent>
          Today
        </SpineChip>
      );
    }
    const b = grainBucket(e.date, grain, tz, e.calendarDay);
    if (b.key !== bucket) {
      bucket = b.key;
      rows.push(<SpineChip key={`bucket-${b.key}`}>{b.label}</SpineChip>);
    }
    rows.push(<SpineEntry key={e.id} e={e} side={i % 2 === 0 ? "right" : "left"} tz={tz} />);
  });

  return (
    <>
      {rows.length > 0 && (
        <div className="relative">
          {/* The spine: center on desktop, left edge on phones. */}
          <div className="absolute bottom-0 top-0 left-4 w-px bg-line sm:left-1/2" aria-hidden />
          <ul className="flex flex-col">{rows}</ul>
        </div>
      )}

      {undated.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs uppercase tracking-wide text-ink-subtle sm:text-center">
            {undatedLabel}
          </h2>
          <ul className="mx-auto flex max-w-md flex-col gap-1.5">
            {undated.map((u) => (
              <li key={u.id} className="flex items-center gap-2 text-sm">
                {u.badge && (
                  <span className="shrink-0 rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                    {u.badge}
                  </span>
                )}
                <Link
                  href={`/items/${u.id}`}
                  className="min-w-0 flex-1 truncate text-ink hover:text-ink-muted"
                >
                  {u.title || "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
