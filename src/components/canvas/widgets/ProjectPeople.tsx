// The project header's People row (Tyler, 2026-07-01): a horizontal, untitled
// strip of the people related to this project, each a chip linking to the
// person, followed by a small "+" that opens a person typeahead. Picking a hit
// relates it; a name that matches nothing creates a `person` and relates it
// (create-on-miss, ADR-067). Relations use role "related" so they surface in the
// People widget's bound query (record-widgets.ts).
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PersonAvatar from "@/components/people/PersonAvatar";

type Person = { id: string; title: string; image: string | null };
type Hit = { id: string; type: string; title: string };

export default function ProjectPeople({
  recordId,
  people,
}: {
  recordId: string;
  people: Person[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  // Stable-by-value key of the already-related people, so the search effect can
  // filter them out without depending on the `people` array's identity.
  const relatedKey = people.map((p) => p.id).join(",");

  const trimmed = q.trim();
  const showCreate =
    trimmed !== "" && !hits.some((h) => h.title.trim().toLowerCase() === trimmed.toLowerCase());
  const rowCount = hits.length + (showCreate ? 1 : 0);

  useEffect(() => {
    if (!open || !trimmed) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/items?type=person&q=${encodeURIComponent(trimmed)}&limit=8`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { items: Hit[] };
        const related = new Set(relatedKey ? relatedKey.split(",") : []);
        setHits(data.items.filter((h) => !related.has(h.id)));
        setActive(0);
      } catch {
        // aborted/offline; next keystroke retries
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [trimmed, open, relatedKey]);

  async function relateTo(targetId: string) {
    const res = await fetch(`/api/items/${recordId}/relations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, role: "related" }),
    });
    if (!res.ok) throw new Error(String(res.status));
  }

  async function removePerson(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${recordId}/relations?targetId=${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function relate(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await relateTo(id);
      setQ("");
      setHits([]);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createAndRelate() {
    if (busy || !trimmed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "person", title: trimmed }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { item } = (await res.json()) as { item: { id: string } };
      await relateTo(item.id);
      setQ("");
      setHits([]);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* "People:" is the affordance only while empty; once someone's added, the
          chips carry the meaning and the label drops away (Tyler, 2026-07-01). */}
      {people.length === 0 && <span className="text-sm text-neutral-500">People:</span>}
      {people.map((p) => (
        <span
          key={p.id}
          className="group/person inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 py-0.5 pl-0.5 pr-1 text-sm text-neutral-300"
        >
          <Link
            href={`/items/${p.id}`}
            title={p.title || "Untitled"}
            className="inline-flex items-center gap-1.5 hover:text-neutral-100"
          >
            {/* The face when the person's Image is set (ADR-202 addendum 4),
                initials otherwise — same avatar the project cards wear. */}
            <PersonAvatar src={p.image} name={p.title} size={20} fallback="initials" />
            <span className="max-w-[10rem] truncate">{p.title || "Untitled"}</span>
          </Link>
          <button
            type="button"
            onClick={() => void removePerson(p.id)}
            disabled={busy}
            aria-label={`Remove ${p.title || "person"}`}
            title="Remove from project"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-700 hover:text-neutral-200 disabled:opacity-40"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      ))}

      {open ? (
        <div className="relative">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, rowCount - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (active < hits.length && hits[active]) void relate(hits[active].id);
                else if (showCreate) void createAndRelate();
              } else if (e.key === "Escape") {
                setQ("");
                setHits([]);
                setOpen(false);
              }
            }}
            onBlur={() => {
              if (!q.trim() && !busy) setOpen(false);
            }}
            disabled={busy}
            placeholder="Add person…"
            className="w-40 rounded-full border border-neutral-700 bg-transparent px-3 py-1 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
          />
          {(hits.length > 0 || showCreate) && (
            <ul className="absolute left-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50">
              {hits.map((hit, i) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void relate(hit.id);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${
                      i === active ? "bg-neutral-800 text-neutral-100" : "text-neutral-300"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{hit.title || "Untitled"}</span>
                  </button>
                </li>
              ))}
              {showCreate && (
                <li>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void createAndRelate();
                    }}
                    onMouseEnter={() => setActive(hits.length)}
                    className={`flex w-full items-center gap-1 px-2 py-1 text-left text-sm ${
                      active === hits.length ? "bg-neutral-800" : ""
                    }`}
                  >
                    <span className="text-neutral-400">Create</span>
                    <span className="min-w-0 flex-1 truncate text-neutral-100">“{trimmed}”</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add person"
          title="Add person"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
        >
          +
        </button>
      )}
    </div>
  );
}
