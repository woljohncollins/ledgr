// A typed relation field on the item canvas (ADR-067 R2). A relation property
// (Author, Attendees) renders as a link box: chips for the current links plus a
// typeahead filtered to the field's targetType. Its value is NOT in
// items.properties — it's the set of `relations` edges from this item with
// role = the field key, so this reads/writes over the relations API (POST to
// add, DELETE ?role= to remove). Cardinality is enforced here (single replaces,
// many accumulates). Create-on-miss is eager and typed: the box knows the type,
// so typing a new name creates an item of targetType and links it without
// leaving the page (the untyped/unmarked path is R3). router.refresh() keeps
// the generic Related panel below in sync.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { RelationCardinality } from "@/lib/types";
import { useAnchoredPanel } from "@/components/ui/Popover";
import { RAIL_LABEL } from "@/components/canvas/rail/styles";
import {
  createMentionTarget,
  createTargets,
  needsTriage,
  type CreateTarget,
} from "@/lib/mention-create";
import { loadTypes, type TypeMeta } from "@/components/search/type-token";
import { announceFloatingOpen } from "@/lib/floating";
import InlineTitle from "./InlineTitle";

const MENU_WIDTH = 256;

type Chip = { id: string; title: string };
type Hit = { id: string; type: string; title: string };

export default function RelationField({
  itemId,
  role,
  targetType,
  targetTypeLabel,
  cardinality,
  initial,
  heading,
  readOnlyChips = [],
}: {
  itemId: string;
  // The field key — the edge role. null = a generic connection (ADR-175): adds
  // write the default 'related' edge and removes are role-blind, so the box
  // reflects edges no matter which writer created them.
  role: string | null;
  targetType: string | null; // null = any type (no typeahead filter, no create)
  targetTypeLabel: string | null;
  cardinality: RelationCardinality;
  initial: Chip[];
  // Todoist-style section mode (the task rail, Tyler 2026-08-18): the field
  // renders its OWN label line with a "+" on the right that opens the add
  // input, chips underneath — so the parent passes the label in here instead
  // of drawing a <dt>. Absent = the classic chips + "+ Add" shape, unchanged.
  heading?: ReactNode;
  // Chips shown before the editable ones but not removable here — PeopleRow's
  // mention-only persons (the body owns that edge, ADR-175).
  readOnlyChips?: { id: string; title: string; hint?: string }[];
}) {
  const router = useRouter();
  const [chips, setChips] = useState<Chip[]>(initial);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The registry, only for a GENERIC field's create rows (a typed field already
  // knows its answer). Loaded when the box opens; memoized in type-token.
  const [types, setTypes] = useState<TypeMeta[]>([]);
  const { anchorRef, coords } = useAnchoredPanel<HTMLInputElement>(open, MENU_WIDTH);

  useEffect(() => {
    if (open && !targetType && types.length === 0) void loadTypes().then(setTypes);
  }, [open, targetType, types.length]);

  // Close any other open floating panel when this box opens (src/lib/floating.ts).
  useEffect(() => {
    if (open) announceFloatingOpen("relation-field");
  }, [open]);

  const atCapacity = cardinality === "single" && chips.length >= 1;
  // Create-on-miss: if the field names a type there's nothing to ask, so it stays
  // one row and creates that type eagerly (no Inbox). A GENERIC field (role null /
  // targetType null, ADR-175) can't know what a bare name is, so it offers the
  // same typed create rows the "@" pickers do (lib/mention-create.ts) instead of
  // silently minting an `unmarked` stub. Either way it links without leaving.
  const trimmed = q.trim();
  const showCreate =
    trimmed !== "" &&
    !hits.some((h) => h.title.trim().toLowerCase() === trimmed.toLowerCase());
  const targets = useMemo(() => {
    if (!showCreate) return [];
    // A declared targetType IS the answer; it isn't in the fetched registry list
    // shape, so hand it through as a single target with the field's own label.
    if (targetType) {
      return [{ key: targetType, label: targetTypeLabel ?? targetType, icon: null }];
    }
    return createTargets(types, null);
  }, [showCreate, targetType, targetTypeLabel, types]);
  const rowCount = hits.length + targets.length;

  useEffect(() => {
    if (!open || !trimmed) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, limit: "8" });
        if (targetType) params.set("type", targetType);
        const res = await fetch(`/api/items?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { items: Hit[] };
        const linked = new Set(chips.map((c) => c.id));
        setHits(data.items.filter((h) => h.id !== itemId && !linked.has(h.id)));
        setActive(0);
      } catch {
        // aborted or offline; the next keystroke retries
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [trimmed, open, itemId, targetType, chips]);

  // A typed field scopes removal to its own role; a generic (null-role) box
  // removes every non-mention edge between the pair, whoever wrote them.
  const removeUrl = (targetId: string) =>
    `/api/items/${itemId}/relations?targetId=${targetId}${
      role ? `&role=${encodeURIComponent(role)}` : ""
    }`;

  // Low-level: relate this item -> target with the field's role. For a single
  // field, the existing edge(s) are cleared first (role-scoped) so it holds one.
  async function relateTarget(target: Chip) {
    if (cardinality === "single" && chips.length > 0) {
      await Promise.all(
        chips.map((c) => fetch(removeUrl(c.id), { method: "DELETE" }))
      );
    }
    const res = await fetch(`/api/items/${itemId}/relations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(role ? { targetId: target.id, role } : { targetId: target.id }),
    });
    if (!res.ok) throw new Error(String(res.status));
    setChips((prev) => (cardinality === "single" ? [target] : [...prev, target]));
  }

  // Every mutation runs through here: one in-flight at a time, reset the input,
  // refresh so the Related panel reflects the new edge, surface a failure.
  async function guard(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await fn();
      setQ("");
      setHits([]);
      setOpen(false);
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const onPick = (hit: Hit) =>
    guard(() => relateTarget({ id: hit.id, title: hit.title || "Untitled" }));

  // Create as the picked type, then link it. Only the "Unsorted" catch-all still
  // lands in the Inbox (needsTriage, in the shared creator) — a named type with a
  // title and a fresh edge has nothing left for triage to decide.
  const onCreate = (target: CreateTarget) => {
    if (!trimmed) return;
    return guard(async () => {
      const made = await createMentionTarget(trimmed, target);
      if (!made) throw new Error("create failed");
      await relateTarget({ id: made.id, title: made.title });
    });
  };

  const onRemove = (chip: Chip) =>
    guard(async () => {
      const res = await fetch(removeUrl(chip.id), { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      setChips((prev) => prev.filter((c) => c.id !== chip.id));
    });

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rowCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active < hits.length) void onPick(hits[active]);
      else {
        const target = targets[active - hits.length];
        if (target) void onCreate(target);
      }
    } else if (e.key === "Escape") {
      setQ("");
      setHits([]);
      setOpen(false);
    }
  }

  // The typeahead menu portals to <body> with fixed coords measured from the
  // input (useAnchoredPanel, same as the rail's Popover rows). It must NOT be an
  // in-flow `absolute` child: the canvas rail is `overflow-y-auto`, which clipped
  // the menu's bottom rows and — since overflow-y:auto makes overflow-x `auto`
  // too — added a stray horizontal scrollbar that shifted the rail's labels.
  const body = (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {readOnlyChips.map((p) => (
        <Link
          key={p.id}
          href={`/items/${p.id}`}
          title={p.hint}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-neutral-700 bg-neutral-800/60 px-2 py-0.5 text-sm text-neutral-200 hover:underline"
        >
          <span className="text-neutral-500">@</span>
          <span className="max-w-[12rem] truncate">{p.title || "Untitled"}</span>
        </Link>
      ))}
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="group/chip inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-neutral-700 bg-neutral-800/60 py-0.5 pl-2 pr-1 text-sm"
        >
          <InlineTitle
            id={chip.id}
            title={chip.title}
            linkClassName={`max-w-[12rem] ${chip.title ? "text-neutral-200" : "text-neutral-500"} hover:underline`}
          />
          <button
            onClick={() => void onRemove(chip)}
            disabled={busy}
            aria-label={`Remove ${chip.title || "link"}`}
            className="shrink-0 rounded px-0.5 text-neutral-500 hover:text-red-400 disabled:opacity-50"
          >
            ✕
          </button>
        </span>
      ))}

      {open ? (
        <>
          <input
            ref={anchorRef}
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value.trim()) setHits([]);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (!q.trim() && !busy) setOpen(false);
            }}
            disabled={busy}
            placeholder={
              targetTypeLabel ? `Search ${targetTypeLabel}…` : "Search items…"
            }
            className="w-48 max-w-full rounded border border-neutral-700 bg-transparent px-2 py-0.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
          />
          {(hits.length > 0 || showCreate) &&
            coords &&
            createPortal(
            <ul
              style={{
                position: "fixed",
                left: coords.left,
                top: coords.top,
                bottom: coords.bottom,
                width: Math.min(MENU_WIDTH, window.innerWidth - 16),
                maxHeight: coords.maxHeight,
              }}
              className="z-[60] overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50"
            >
              {hits.map((hit, i) => (
                <li key={hit.id}>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void onPick(hit);
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
              {/* Create-on-miss. A typed field yields one row (its own type); a
                  generic one yields a row per type the name could be, so the
                  question is asked instead of answered with a stub. */}
              {targets.map((target, n) => (
                <li key={target.key}>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void onCreate(target);
                    }}
                    onMouseEnter={() => setActive(hits.length + n)}
                    className={`flex w-full items-center gap-1 px-2 py-1 text-left text-sm ${
                      active === hits.length + n ? "bg-neutral-800" : ""
                    }`}
                  >
                    <span className="text-neutral-400">Create</span>
                    <span className="min-w-0 flex-1 truncate text-neutral-100">
                      “{trimmed}”
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {needsTriage(target) ? `${target.label} · to Inbox` : `new ${target.label}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>,
            document.body
          )}
        </>
      ) : (
        // In heading mode the label line's "+" is the add affordance, so the
        // inline one only renders in the classic shape.
        !atCapacity &&
        !heading && (
          <button
            onClick={() => setOpen(true)}
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-sm text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300 disabled:opacity-50"
          >
            {chips.length === 0 ? "+ Add" : "+"}
          </button>
        )
      )}
      {error && <span className="text-xs text-red-400">failed</span>}
    </div>
  );

  if (!heading) return body;

  const hasContent = readOnlyChips.length > 0 || chips.length > 0 || open;
  const canAdd = !atCapacity && !open && !busy;
  return (
    // The WHOLE section is the add target (Tyler, 2026-08-18 — "like Priority"):
    // clicking anywhere in it opens the typeahead, except on a chip, the ✕, or
    // the input themselves (the closest() guard), which keep their own jobs.
    <div
      className={`flex w-full flex-col gap-1 rounded-md transition-colors ${
        canAdd ? "cursor-pointer hover:bg-surface-2/60" : ""
      }`}
      onClick={(e) => {
        if (!canAdd) return;
        if ((e.target as HTMLElement).closest("a,button,input")) return;
        setOpen(true);
      }}
    >
      <div className="flex items-center justify-between">
        <span className={RAIL_LABEL}>{heading}</span>
        {!atCapacity && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={busy}
            aria-label="Add"
            className="flex h-5 w-5 items-center justify-center rounded text-ink-subtle hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      {hasContent && body}
    </div>
  );
}
