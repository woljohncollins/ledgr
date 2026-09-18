// "+ Relate" (slice 15): inline typeahead over the owner's items (the same
// title-substring q= the @-mention picker uses), Notion-default add-in-place.
// Enter or click relates the highlighted hit and keeps the input open for
// rapid entry; Escape or an empty blur closes it. Create-on-miss: when the typed
// name matches nothing, the picker offers one TYPED create row per type it could
// be (src/lib/mention-create.ts, shared with the three "@" pickers) and relates
// whichever is picked — so you can link to something that doesn't exist yet
// without leaving the item, and without minting an untyped stub.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  loadTypes,
  parseTypeToken,
  type TypeMeta,
} from "@/components/search/type-token";
import {
  createMentionTarget,
  createTargets,
  needsTriage,
  type CreateTarget,
} from "@/lib/mention-create";
import { announceFloatingOpen } from "@/lib/floating";

type Hit = { id: string; type: string; title: string };

export default function AddRelation({
  itemId,
  rail = false,
}: {
  itemId: string;
  // Rail mode (ADR-253): render the compact "+" used by the rail's other
  // relation rows (Project / Tags / People) instead of the "+ Relate" pill, so
  // the task rail's Linked row matches its siblings. The picker itself is
  // identical either way.
  rail?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [types, setTypes] = useState<TypeMeta[]>([]);

  // Load the registry once the box opens so "/type" tokens resolve.
  useEffect(() => {
    if (open && types.length === 0) void loadTypes().then(setTypes);
  }, [open, types.length]);

  // Close any other open floating panel when this box opens (src/lib/floating.ts).
  useEffect(() => {
    if (open) announceFloatingOpen("add-relation");
  }, [open]);

  // A leading "/type" token ("/person jane") narrows to one type; the rest is
  // the title query, and "/person" alone browses recent people.
  const parsed = useMemo(() => parseTypeToken(q, types), [q, types]);
  const effective = (parsed ? parsed.rest : q).trim();
  const typeKey = parsed?.type.key ?? "";

  // Offer create-on-miss whenever the name doesn't exactly match a hit: one row
  // per type it could become, or the single scoped type when "/person" is active.
  const showCreate =
    effective !== "" &&
    !hits.some((h) => h.title.trim().toLowerCase() === effective.toLowerCase());
  const targets = useMemo(
    () => (showCreate ? createTargets(types, parsed?.type ?? null) : []),
    [showCreate, types, parsed]
  );
  const rowCount = hits.length + targets.length;

  // Empty queries clear hits in the onChange handler, not here, so the
  // effect only ever talks to the network (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open || (!effective && !typeKey)) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "8" });
        if (effective) params.set("q", effective);
        if (typeKey) params.set("type", typeKey);
        const res = await fetch(`/api/items?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { items: Hit[] };
        setHits(data.items.filter((h) => h.id !== itemId));
        setActive(0);
      } catch {
        // aborted or offline; the next keystroke retries
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [effective, typeKey, open, itemId]);

  async function relateTo(targetId: string) {
    const res = await fetch(`/api/items/${itemId}/relations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId }),
    });
    if (!res.ok) throw new Error(String(res.status));
  }

  async function relate(hit: Hit) {
    if (state === "busy") return;
    setState("busy");
    try {
      await relateTo(hit.id);
      setQ("");
      setHits([]);
      setState("idle");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  // Create-on-miss as the picked type, then relate it like any other hit. Only
  // the "Unsorted" catch-all still lands in the Inbox (needsTriage) — a named
  // type with a title and a fresh edge has nothing left to triage.
  async function createAndRelate(target: CreateTarget) {
    if (state === "busy" || !effective) return;
    setState("busy");
    try {
      const made = await createMentionTarget(effective, target);
      if (!made) throw new Error("create failed");
      await relateTo(made.id);
      setQ("");
      setHits([]);
      setState("idle");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  if (!open) {
    if (rail) {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Link an item"
          className="flex h-5 w-5 items-center justify-center rounded text-ink-subtle hover:bg-surface-2 hover:text-ink"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      );
    }
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
      >
        + Relate
      </button>
    );
  }

  return (
    <div className="relative flex items-center gap-2 px-2 py-1">
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          if (!e.target.value.trim()) setHits([]);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, rowCount - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (active < hits.length && hits[active]) void relate(hits[active]);
            else {
              const target = targets[active - hits.length];
              if (target) void createAndRelate(target);
            }
          } else if (e.key === "Escape") {
            setQ("");
            setHits([]);
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!q.trim() && state !== "busy") setOpen(false);
        }}
        disabled={state === "busy"}
        placeholder="Search items to relate…"
        className="w-full max-w-sm rounded border border-neutral-700 bg-transparent px-2 py-0.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
      />
      {state === "error" && (
        <span className="text-xs text-red-400">Failed, Enter to retry</span>
      )}
      {(hits.length > 0 || showCreate || parsed) && (
        <ul className="absolute left-2 top-full z-10 mt-1 w-full max-w-sm overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50">
          {parsed && (
            <li className="flex items-center gap-1.5 border-b border-neutral-800 px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              {parsed.type.label}
            </li>
          )}
          {hits.map((hit, i) => (
            <li key={hit.id}>
              <button
                // mousedown, not click: a click would blur the input first
                // and the dropdown would vanish under the pointer.
                onMouseDown={(e) => {
                  e.preventDefault();
                  void relate(hit);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${
                  i === active ? "bg-neutral-800 text-neutral-100" : "text-neutral-300"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {hit.title || "Untitled"}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {hit.type}
                </span>
              </button>
            </li>
          ))}
          {/* Create-on-miss: one row per type the name could become. The right
              edge names the type, and says "to Inbox" only for the catch-all —
              the one target that still needs triage. */}
          {targets.map((target, n) => (
            <li key={target.key}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  void createAndRelate(target);
                }}
                onMouseEnter={() => setActive(hits.length + n)}
                className={`flex w-full items-center gap-1 px-2 py-1 text-left text-sm ${
                  active === hits.length + n ? "bg-neutral-800" : ""
                }`}
              >
                <span className="text-neutral-400">Create</span>
                <span className="min-w-0 flex-1 truncate text-neutral-100">
                  “{effective}”
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {needsTriage(target) ? `${target.label} · to Inbox` : target.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
