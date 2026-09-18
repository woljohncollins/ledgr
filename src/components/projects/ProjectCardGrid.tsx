// The rich project card (Tyler, 2026-07-01; configurable + everywhere,
// 2026-08-17): title, status pill, a progress bar (weighted points), item
// counts, people, key links, and a Timeline button — with the element set
// decided by the resolved ProjectCardConfig (Build → Types → Project sets the
// type default; a saved view's card panel can override). The same card body
// renders on the /list/project grid, a project view's list layout, and board
// (kanban) cards, so "the Recent look" travels to any tab the owner makes.
//
// Click model: the whole card opens the project via a stretched title link
// (an absolutely-positioned ::after overlay), while the tool chips — counts,
// key links, Timeline — sit above it (relative z-[1]) and deep-link into their
// tools: "6 tasks" → the full task list, the Timeline chip → the spine page.
// Server component, no client JS. Internal anchors set draggable={false} so a
// draggable board card's drag always wins.
//
// Selection/bulk-select is deliberately off here (a gallery layout, like the
// board/calendar exceptions in CLAUDE.md); the plain list lens still has it.
import Link from "next/link";
import PersonAvatar from "@/components/people/PersonAvatar";
import type { ReactNode } from "react";
import { progressPct } from "@/lib/project-progress";
import {
  cardShows,
  DEFAULT_PROJECT_CARD,
  type ProjectCardConfig,
} from "@/lib/project-card-config";
import type { ProjectCard } from "@/lib/project-cards";


// One count segment, deep-linking into the collection's full list page.
function CountBit({
  projectId,
  collection,
  count,
  noun,
}: {
  projectId: string;
  collection: string;
  count: number;
  noun: string;
}) {
  return (
    <Link
      href={`/items/${projectId}/collection/${collection}`}
      draggable={false}
      className="relative z-[1] hover:text-neutral-300 hover:underline"
    >
      {count} {noun}
      {count === 1 ? "" : "s"}
    </Link>
  );
}

function CountBits({ card }: { card: ProjectCard }) {
  const bits: ReactNode[] = [];
  if (card.counts.tasks)
    bits.push(<CountBit key="t" projectId={card.id} collection="tasks" count={card.counts.tasks} noun="task" />);
  if (card.counts.milestones)
    bits.push(<CountBit key="ms" projectId={card.id} collection="milestones" count={card.counts.milestones} noun="milestone" />);
  if (card.counts.meetings)
    bits.push(<CountBit key="mt" projectId={card.id} collection="meetings" count={card.counts.meetings} noun="meeting" />);
  if (bits.length === 0) return <span className="text-neutral-600">Empty</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1">
      {bits.map((b, i) => (
        <span key={i} className="flex items-center gap-x-1">
          {i > 0 && <span aria-hidden>·</span>}
          {b}
        </span>
      ))}
    </span>
  );
}

// The spine glyph for the Timeline chip (house style: stroke 1.8, currentColor).
function TimelineGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 shrink-0">
      <path d="M12 3v18" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="2.4" />
      <circle cx="12" cy="16.5" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

// The card's inner content, shared by the grid card and a board (kanban) card.
// `compact` tightens spacing for the narrow board column.
export function ProjectCardBody({
  card,
  config = DEFAULT_PROJECT_CARD,
  compact = false,
}: {
  card: ProjectCard;
  config?: ProjectCardConfig;
  compact?: boolean;
}) {
  const pct = progressPct(card.progress);
  const shown = card.people.slice(0, 5);
  const extra = card.people.length - shown.length;
  const showCounts = cardShows(config, "counts");
  const showProgress = cardShows(config, "progress");
  const showChips = cardShows(config, "timeline") || (cardShows(config, "links") && card.links.length > 0);
  return (
    <div className={`flex flex-col ${compact ? "gap-2" : "gap-3"}`}>
      <div className="flex items-start justify-between gap-2">
        {/* The stretched link: the whole card is clickable, the chips float above. */}
        <h3 className={`min-w-0 flex-1 break-words font-medium text-neutral-100 ${compact ? "text-sm" : ""}`}>
          {card.favorited && (
            /* Favorited (⋯ → star): a small filled star riding the title.
               Visual only, deliberately — no reordering (Tyler, 2026-08-17). */
            <svg
              aria-label="Favorited"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="mb-0.5 mr-1.5 inline-block h-3.5 w-3.5 text-[var(--accent)]"
            >
              <path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.65 1.13 6.58L12 17.57l-5.9 3.1 1.13-6.58L2.45 9.44l6.6-.96L12 2.5z" />
            </svg>
          )}
          <Link
            href={`/items/${card.id}`}
            draggable={false}
            className="after:absolute after:inset-0 after:content-['']"
          >
            {card.title || "Untitled project"}
          </Link>
        </h3>
        {cardShows(config, "status") && card.status && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: card.status.color }} />
            {card.status.label}
          </span>
        )}
      </div>

      {(showCounts || showProgress) && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
            {showCounts ? <CountBits card={card} /> : <span />}
            {showProgress && pct !== null && (
              <span className="shrink-0 text-neutral-400">{pct}%</span>
            )}
          </div>
          {showProgress && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-700/50">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct ?? 0}%` }} />
            </div>
          )}
        </div>
      )}

      {cardShows(config, "people") && card.people.length > 0 && (
        <div className="flex items-center">
          {shown.map((p, i) => (
            // Face when the person's built-in Image is set, initials otherwise
            // (the pre-avatar look) — ADR-202 addendum 3.
            <span key={p.id} style={{ marginLeft: i === 0 ? 0 : -6 }} className="flex">
              <PersonAvatar src={p.image ?? null} name={p.title} size={24} fallback="initials" />
            </span>
          ))}
          {extra > 0 && <span className="ml-1.5 text-xs text-neutral-500">+{extra}</span>}
        </div>
      )}

      {showChips && (
        <div className="flex flex-wrap items-center gap-1.5">
          {cardShows(config, "timeline") && (
            <Link
              href={`/items/${card.id}/timeline`}
              draggable={false}
              className="relative z-[1] inline-flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
            >
              <TimelineGlyph />
              Timeline
            </Link>
          )}
          {cardShows(config, "links") &&
            card.links.map((l) =>
              l.url ? (
                <a
                  key={l.id}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  draggable={false}
                  className="relative z-[1] inline-flex max-w-40 items-center rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
                >
                  <span className="truncate">{l.title || l.url}</span>
                </a>
              ) : (
                <Link
                  key={l.id}
                  href={`/items/${l.id}`}
                  draggable={false}
                  className="relative z-[1] inline-flex max-w-40 items-center rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
                >
                  <span className="truncate">{l.title || "Untitled"}</span>
                </Link>
              )
            )}
        </div>
      )}
    </div>
  );
}

// A favorited card gets a whisper of the accent: a tinted border + a faint
// glow, subtle on purpose (Tyler, 2026-08-17 — "nothing crazy").
export function projectCardFrameClass(favorited: boolean): string {
  return favorited
    ? "border-[var(--accent)]/40 bg-neutral-900/40 shadow-[0_0_14px_-6px_var(--accent)] hover:border-[var(--accent)]/60"
    : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900/70";
}

function Card({ card, config }: { card: ProjectCard; config: ProjectCardConfig }) {
  return (
    <div className={`relative rounded-xl border p-4 transition-colors ${projectCardFrameClass(card.favorited)}`}>
      <ProjectCardBody card={card} config={config} />
    </div>
  );
}

export default function ProjectCardGrid({
  cards,
  config = DEFAULT_PROJECT_CARD,
}: {
  cards: ProjectCard[];
  config?: ProjectCardConfig;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.id} card={card} config={config} />
      ))}
    </div>
  );
}
