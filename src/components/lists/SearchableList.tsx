// A list with a search box over it (Tyler, 2026-08-25) — the body of the
// "Completed" tab, where the whole point is finding one finished thing again
// months later rather than browsing.
//
// The rows arrive as PREBUILT SERVER NODES keyed by title, the same trick
// BoardDnd uses for its rich project cards: the server renders each row (a full
// project card, avatars and all), and this client shell only decides which of
// them to show. That keeps the search instant — no round trip, no refetch, no
// re-render of the cards themselves — while the rows stay as rich as anywhere
// else in the app. Filtering by title reuses the related panel's filterByQuery,
// so "search" means the same thing here as it does there.
//
// Scope is honest: it filters the LOADED window, not the whole table, and says so
// when there is more behind it — a silent partial search is worse than a
// labelled one (no-silent-caps).
"use client";

import { useState, type ReactNode } from "react";
import { filterByQuery } from "@/lib/related-lens";

export type SearchableRow = { id: string; title: string; node: ReactNode };

export default function SearchableList({
  rows,
  total,
  placeholder = "Search…",
  emptyLabel = "Nothing here yet.",
  layout = "list",
}: {
  rows: SearchableRow[];
  // The true match count in the database, which can exceed rows.length.
  total: number;
  placeholder?: string;
  emptyLabel?: string;
  // "grid" for card rows (projects), "list" for plain rows.
  layout?: "list" | "grid";
}) {
  const [q, setQ] = useState("");
  const query = q.trim();
  const shown = filterByQuery(rows, query);
  const truncated = total > rows.length;

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="relative flex min-w-0 flex-1 items-center">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            className="pointer-events-none absolute left-2.5 h-4 w-4 text-ink-faint"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M16.5 16.5L21 21" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="w-full rounded-card border border-line bg-surface-1 py-1.5 pl-8 pr-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
          />
        </label>
        <span className="ui-meta shrink-0 text-ink-faint">
          {query
            ? `${shown.length} of ${rows.length}`
            : `${rows.length}${truncated ? ` of ${total}` : ""}`}
        </span>
      </div>

      {truncated && !query && (
        // Never let a capped window read as "this is everything".
        <p className="ui-meta text-ink-faint">
          Showing the {rows.length} most recent. Search covers these; older ones
          are in the full list.
        </p>
      )}

      {shown.length === 0 ? (
        <p className="ui-meta text-ink-subtle">
          {query ? `Nothing matches "${query}".` : emptyLabel}
        </p>
      ) : layout === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <div key={r.id}>{r.node}</div>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => (
            <li key={r.id}>{r.node}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
