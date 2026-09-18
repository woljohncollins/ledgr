// The universal command palette (ADR-063): one Cmd+K surface, available in both
// modes, that searches everything — items (content, via the FTS API), built-in
// pages, saved views, item types, Build/Maintain sections, and named settings.
// Results are grouped by kind and ranked context-aware: the active mode (derived
// from the path) shifts the weighting (content-first in Work, structure-first in
// Build) without changing what's searchable. Supersedes the old SearchModal and
// is opened from the Work nav (search slot / ⌘K) and the Build sidebar alike.
//
// The result model is a `destination | action` union (command-index.ts); only
// destinations are produced this phase, with the seam left for command-results.
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import NavGlyph from "@/components/nav/NavGlyph";
import { isBuildPath } from "@/lib/build-nav";
import {
  type CommandMode,
  type CommandResult,
  dynamicCommandEntries,
  groupOrder,
  rankCommands,
  staticCommandEntries,
} from "@/lib/command-index";
import { parseTypeToken } from "@/components/search/type-token";

type ItemHit = { id: string; title: string; type: string };
type IndexData = {
  types: { key: string; label: string; icon: string | null }[];
  views: { id: string; name: string }[];
  templates: { id: string; name: string; type: string; prototypeItemId: string }[];
};

const EMPTY_GROUP_CAP = 6; // jump-list size per group before any query
const QUERY_GROUP_CAP = 8; // matches shown per group while querying

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const mode: CommandMode = isBuildPath(pathname) ? "build" : "work";

  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemHit[]>([]);
  const [data, setData] = useState<IndexData | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Pull the owner's dynamic entries (types/views/templates) once on open; the
  // static entries (pages/sections/settings) need no fetch.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/command-index", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // A leading "/type" token narrows to one type: "/task budget" searches only
  // tasks; "/person" alone lists recent people. Resolved against the registry
  // the palette already loaded (data.types), so no extra fetch.
  const parsed = useMemo(
    () => parseTypeToken(q, data?.types ?? []),
    [q, data]
  );

  // Item content search (FTS API), debounced; only while the query is non-empty.
  // With a "/type" token the search is type-scoped (or a plain type listing when
  // there's no text yet). Stale hits stay in state when the query is cleared but
  // are ignored at render (itemResults gates on the query), so the effect never
  // sets state directly.
  useEffect(() => {
    if (!q.trim()) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const url =
          parsed && parsed.rest
            ? `/api/search?q=${encodeURIComponent(parsed.rest)}&type=${encodeURIComponent(parsed.type.key)}&limit=8&recency=strong`
            : parsed
              ? `/api/items?type=${encodeURIComponent(parsed.type.key)}&limit=8`
              : `/api/search?q=${encodeURIComponent(q.trim())}&limit=8&recency=strong`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) return;
        const json = (await res.json()) as { items: ItemHit[] };
        setItems(json.items ?? []);
      } catch {
        /* aborted/offline; next keystroke retries */
      }
    }, 180);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q, parsed]);

  const staticEntries = useMemo(() => staticCommandEntries(), []);
  const dynamicEntries = useMemo(
    () => (data ? dynamicCommandEntries(data, mode) : []),
    [data, mode]
  );

  // Non-item results: rank the static + dynamic entries for the query/mode.
  const ranked = useMemo(
    () => rankCommands([...staticEntries, ...dynamicEntries], q, mode),
    [staticEntries, dynamicEntries, q, mode]
  );

  // Item hits as destination results (always the "Items" group). Gated on the
  // query so stale hits never show once the box is cleared.
  const itemResults: CommandResult[] = useMemo(
    () =>
      (q.trim() ? items : []).map((h) => ({
        kind: "destination",
        id: `item:${h.id}`,
        group: "Items",
        label: h.title || "Untitled",
        sublabel: h.type,
        href: `/items/${h.id}`,
        icon: "document",
      })),
    [items, q]
  );

  // Group the merged results in the mode's display order, capping each group and
  // dropping empties. Items come pre-ranked from the API; the rest are ranked.
  const grouped = useMemo(() => {
    const cap = q.trim() ? QUERY_GROUP_CAP : EMPTY_GROUP_CAP;
    return groupOrder(mode)
      .map((group) => {
        // A "/type" token is an item-scoped query — the pages/views/sections
        // groups don't apply, so drop them and show only matching items.
        if (parsed && group !== "Items") return { group, results: [] };
        const all =
          group === "Items"
            ? itemResults
            : ranked.filter((r) => r.group === group);
        return { group, results: all.slice(0, cap) };
      })
      .filter((g) => g.results.length > 0);
  }, [mode, q, ranked, itemResults, parsed]);

  // Flatten for keyboard nav. The active index resets to 0 on each keystroke
  // (in the input's onChange) and is clamped at read time, so a list that
  // shrinks after an async fetch can't leave the highlight out of range — no
  // state-syncing effect needed.
  const flat = useMemo(() => grouped.flatMap((g) => g.results), [grouped]);
  const activeIndex = active < flat.length ? active : 0;

  const openResult = (r: CommandResult) => {
    onClose();
    if (r.kind === "destination") router.push(r.href);
    // action results are not produced yet (the populate-later seam).
  };

  // Hand off to the full search page, carrying whatever is typed. The page reads
  // ?q= as a prefill (the same handoff the Discover panel uses, ADR-127), so the
  // query survives the jump. One function behind both doors: the footer button
  // and Enter-with-no-results.
  const goAdvanced = () => {
    onClose();
    const query = q.trim();
    router.push(query ? `/search?q=${encodeURIComponent(query)}` : "/search");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[activeIndex]) openResult(flat[activeIndex]);
      else if (q.trim()) goAdvanced();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[15vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          placeholder="Jump to anything…"
          aria-label="Command palette query"
          className="w-full bg-neutral-950 px-4 py-3 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
        />

        {parsed && (
          <div className="flex items-center gap-1.5 border-b border-neutral-800 bg-neutral-950 px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            {parsed.type.label}
            {parsed.rest ? "" : " · type to filter"}
          </div>
        )}

        {grouped.length > 0 && (
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {grouped.map(({ group, results }) => (
              <div key={group}>
                <p className="px-4 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                  {group}
                </p>
                <ul>
                  {results.map((r) => {
                    const idx = flat.indexOf(r);
                    const isActive = idx === activeIndex;
                    return (
                      <li key={r.id}>
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault();
                            openResult(r);
                          }}
                          onMouseEnter={() => setActive(idx)}
                          className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm ${
                            isActive
                              ? "bg-neutral-800 text-neutral-100"
                              : "text-neutral-300"
                          }`}
                        >
                          <NavGlyph icon={r.icon} size={16} className="shrink-0 text-neutral-500" />
                          <span className="min-w-0 flex-1 truncate">{r.label}</span>
                          {r.sublabel && (
                            <span className="shrink-0 text-xs text-neutral-500">{r.sublabel}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {q.trim() && grouped.length === 0 && (
          <p className="px-4 py-3 text-sm text-neutral-600">No matches here.</p>
        )}

        {/* The escape hatch out of quick search and into the tuned page
            (ADR-172). Always present, not just on an empty result set: "I can't
            find it" is the exact moment you want stacked criteria, and the
            handoff carries whatever you already typed via ?q= so you never
            retype it. This replaces the palette's old hidden behavior, where
            Enter-with-zero-results silently did the same navigation — the path
            existed, nothing advertised it. */}
        <button
          type="button"
          onClick={goAdvanced}
          className="flex w-full items-center gap-2 border-t border-neutral-800 px-4 py-2 text-left text-xs text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
        >
          <NavGlyph icon="search" size={14} className="shrink-0 text-neutral-500" />
          <span className="min-w-0 flex-1 truncate">
            {q.trim() ? (
              <>
                Advanced search for <span className="text-neutral-200">{q.trim()}</span>
              </>
            ) : (
              "Advanced search: stack up words, a rough date, a type"
            )}
          </span>
        </button>

        <div className="border-t border-neutral-800 px-4 py-1.5 text-xs text-neutral-600">
          ↑↓ to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}
