// The Favorites flyout: the popover the Favorites nav slot opens (instead of
// navigating). Lists the owner's starred items, fetched on open, each linking to
// its canvas; rows reorder by dragging the handle (mouse + touch via pointer
// events — no DnD dependency, Principle 5) and persist to /api/favorites. A row
// can be unstarred in place. Empty/loading/error states keep it self-contained.
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { navIconPaths } from "@/lib/nav-icons";

type Row = { id: string; title: string; type: string; icon: string };

function Glyph({ icon }: { icon: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      dangerouslySetInnerHTML={{ __html: navIconPaths(icon) }}
    />
  );
}

// The six-dot grab handle.
function GrabHandle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </svg>
  );
}

export default function FavoritesFlyout({
  fixedStyle,
  onNavigate,
}: {
  // The flyout is portaled to <body> and positioned `fixed` from these inline
  // coords (measured by the nav's placePop, or the phone bar's static anchor),
  // so it can't be clipped by the nav's own box or run off a screen edge.
  fixedStyle: React.CSSProperties;
  onNavigate: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const elRefs = useRef(new Map<string, HTMLLIElement>());
  // Latest rows for the commit on pointer-up (avoids a stale closure).
  const rowsRef = useRef<Row[] | null>(null);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    let alive = true;
    fetch("/api/favorites")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setRows(Array.isArray(d.items) ? d.items : []))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  // Move the dragged row to wherever the pointer sits, comparing the pointer's
  // Y to each other row's midpoint.
  function reorderTo(clientY: number) {
    setRows((prev) => {
      if (!prev || !dragId) return prev;
      const dragged = prev.find((r) => r.id === dragId);
      if (!dragged) return prev;
      const others = prev.filter((r) => r.id !== dragId);
      let insert = others.length;
      for (let i = 0; i < others.length; i++) {
        const el = elRefs.current.get(others[i].id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          insert = i;
          break;
        }
      }
      const next = [...others];
      next.splice(insert, 0, dragged);
      if (next.every((r, i) => r.id === prev[i].id)) return prev; // no change
      return next;
    });
  }

  // While dragging, follow the pointer anywhere on the page and commit on
  // release. Pointer events unify mouse and touch.
  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      e.preventDefault();
      reorderTo(e.clientY);
    };
    const onUp = () => {
      setDragId(null);
      const order = (rowsRef.current ?? []).map((r) => r.id);
      void fetch("/api/favorites", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      }).catch(() => {});
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId]);

  async function unstar(id: string) {
    setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: id, favorite: false }),
    }).catch(() => {});
  }

  return (
    <div
      role="menu"
      style={fixedStyle}
      className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-1.5 shadow-xl shadow-black/50"
    >
      <p className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600">
        Favorites
      </p>

      {error && (
        <p className="px-2 py-3 text-sm text-neutral-500">Couldn’t load favorites.</p>
      )}
      {!error && rows === null && (
        <p className="px-2 py-3 text-sm text-neutral-500">Loading…</p>
      )}
      {!error && rows !== null && rows.length === 0 && (
        <p className="px-2 py-3 text-sm text-neutral-500">
          No favorites yet. Open any item and tap the star to add it here.
        </p>
      )}

      {!error && rows !== null && rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              ref={(el) => {
                if (el) elRefs.current.set(row.id, el);
                else elRefs.current.delete(row.id);
              }}
              className={`flex items-center gap-1 rounded ${
                dragId === row.id ? "bg-neutral-800 opacity-80" : "hover:bg-neutral-800/60"
              }`}
            >
              <button
                type="button"
                aria-label="Drag to reorder"
                title="Drag to reorder"
                onPointerDown={(e) => {
                  e.preventDefault();
                  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                  setDragId(row.id);
                }}
                className="cursor-grab touch-none px-1 py-2 text-neutral-600 hover:text-neutral-300"
                style={{ touchAction: "none" }}
              >
                <GrabHandle />
              </button>
              <Link
                href={`/items/${row.id}`}
                role="menuitem"
                onClick={onNavigate}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm text-neutral-300 hover:text-neutral-100"
              >
                <Glyph icon={row.icon} />
                <span className="truncate">{row.title || "Untitled"}</span>
              </Link>
              <button
                type="button"
                aria-label="Remove from favorites"
                title="Remove from favorites"
                onClick={() => void unstar(row.id)}
                className="px-2 py-2 text-neutral-600 hover:text-[var(--accent)]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2l2.9 6.3 6.9.8-5 4.8 1.2 6.9-6-3.3-6 3.3 1.2-6.9-5-4.8 6.9-.8z" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
