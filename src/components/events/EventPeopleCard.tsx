"use client";

// The unified People card on an event canvas (ADR-144): ONE place to see and
// manage everyone involved, replacing the old three-way split (People chips /
// Attending field / Linked-here persons). Two rows + a footnote:
//   For  — the group(s) driving the meeting (hexagon chips, never confusable
//          with a person). Edge: event→group role 'group'.
//   Here — individuals, in three states: solid = attending (confirmed edge),
//          struck OUT = absent (explicit 'absent' edge — absence is memory,
//          not a silent gap), dashed ghost = unresolved (roster member or
//          suggestion) with one-tap ✓/✕. "✓ all here" confirms the roster in
//          one gesture; exceptions get marked OUT after.
//   Also mentioned — @-mentions / loose links, read-only (the body owns them).
// All writes go through /api/events/[id]/attendance and the relations API;
// router.refresh() re-pulls prep so the server stays the source of truth.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PrepGhost, PrepPerson } from "@/lib/meetings/prep";
import type { EventGroup } from "@/lib/events/people";
import { EVENT_GROUP_ROLE } from "@/lib/events/people";
import { createMentionTarget, createRowText } from "@/lib/mention-create";

// Rosters render inline up to this many unresolved chips (sized for the ~12
// regular pastors, Brandon 2026-07-05); larger sets collapse behind "+N more".
const INLINE_GHOSTS = 15;

// Initials for a person chip's avatar: first + last word, else first two letters.
function initials(title: string): string {
  const parts = (title || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ title, dim = false }: { title: string; dim?: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] ${
        dim ? "bg-surface-2 text-ink-faint" : "bg-neutral-700 text-neutral-100"
      }`}
    >
      {initials(title)}
    </span>
  );
}

type Hit = { id: string; title: string; type: string };

// A shared typeahead popover for the "+ person" / "+ group" affordances.
//
// Create-on-miss goes through the shared creator (lib/mention-create.ts), like
// the other five pickers in the app (Brandon, 2026-08-28): this one had its own
// search and no create at all, so a person who wasn't in Ledgr yet couldn't be
// added to a meeting from the meeting — you had to leave, make the person, come
// back. The type is declared here, so there's nothing to ask: one create row,
// the same eager typed create RelationField does.
function AddPicker({
  label,
  typeKey,
  typeLabel,
  placeholder,
  exclude,
  onPick,
}: {
  label: string;
  typeKey: string;
  // What the create row says on its right edge ("Person", "Group").
  typeLabel: string;
  placeholder: string;
  exclude: Set<string>;
  onPick: (hit: Hit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      if (!trimmed) {
        setHits([]);
        return;
      }
      try {
        const params = new URLSearchParams({ q: trimmed, limit: "8", type: typeKey });
        const res = await fetch(`/api/items?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { items: Hit[] };
        // Keep the UNFILTERED results: the already-added ones are hidden at
        // render, but they still have to count for the create-on-miss test —
        // otherwise typing the name of someone already on the event would offer
        // to create a second person by that name.
        setHits(data.items);
      } catch {
        /* aborted or offline; next keystroke retries */
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q, open, typeKey, exclude]);

  const trimmed = q.trim();
  // Offer the create row for a name that matches nothing (case-blind), the same
  // test every other create-on-miss surface uses.
  const showCreate =
    trimmed !== "" &&
    !hits.some((h) => (h.title || "").trim().toLowerCase() === trimmed.toLowerCase());

  const close = () => {
    setQ("");
    setHits([]);
    setOpen(false);
  };

  // Create the named item as this picker's type, then hand it to onPick exactly
  // as if it had been a hit — so the caller's attendance/relation write is
  // unchanged. A failed create leaves the typed text alone to retry.
  const createAndPick = async () => {
    if (creating || !trimmed) return;
    setCreating(true);
    const made = await createMentionTarget(trimmed, {
      key: typeKey,
      label: typeLabel,
      icon: null,
    });
    setCreating(false);
    if (!made) return;
    onPick({ id: made.id, title: made.title, type: made.type ?? typeKey });
    close();
  };

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center rounded-full border border-dashed border-line px-2.5 py-0.5 text-sm text-ink-faint hover:border-line-strong hover:text-ink-muted"
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-64 rounded-card border border-line bg-surface-1 p-1 text-left shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              // Enter creates when nothing matched — the whole point of typing a
              // name that isn't there yet.
              if (e.key === "Enter" && showCreate) {
                e.preventDefault();
                void createAndPick();
              }
            }}
            placeholder={placeholder}
            className="w-full rounded border border-line bg-surface-0 px-2 py-1 text-sm text-ink outline-none"
          />
          <ul className="mt-1 max-h-40 overflow-auto">
            {hits
              .filter((h) => !exclude.has(h.id))
              .map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(h);
                    close();
                  }}
                  className="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2"
                >
                  {h.title || "Untitled"}
                </button>
              </li>
            ))}
            {showCreate && (
              <li>
                <button
                  type="button"
                  onClick={() => void createAndPick()}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {createRowText(trimmed, creating)}
                  </span>
                  <span className="shrink-0 text-xs text-ink-faint">{typeLabel}</span>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </span>
  );
}

export default function EventPeopleCard({
  eventId,
  groups,
  attending,
  absent,
  ghosts,
  mentioned,
}: {
  eventId: string;
  groups: EventGroup[];
  attending: PrepPerson[];
  absent: PrepPerson[];
  ghosts: PrepGhost[];
  mentioned: PrepPerson[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Dismissed live suggestions (no edge to delete — hide locally this render).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showAllGhosts, setShowAllGhosts] = useState(false);

  const visibleGhosts = ghosts.filter((g) => !dismissed.has(g.id));
  const shownGhosts = showAllGhosts ? visibleGhosts : visibleGhosts.slice(0, INLINE_GHOSTS);
  const hiddenCount = visibleGhosts.length - shownGhosts.length;
  const rosterUnresolved = visibleGhosts.some((g) => g.kind === "roster");

  async function mark(personId: string, state: "here" | "absent" | "none") {
    setBusy(true);
    try {
      const res = await fetch(`/api/events/${eventId}/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId, state }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function allHere() {
    setBusy(true);
    try {
      const res = await fetch(`/api/events/${eventId}/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allHere: true }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function relate(targetId: string, role?: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${eventId}/relations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(role ? { targetId, role } : { targetId }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function unrelate(targetId: string) {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/items/${eventId}/relations?targetId=${targetId}`,
        { method: "DELETE" }
      );
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function dismissGhost(g: PrepGhost) {
    if (g.kind === "roster") {
      void mark(g.id, "absent");
    } else {
      // A DB-suggested edge is cleared by 'none'; a live-only guess has no
      // edge — hide it locally either way so the row responds instantly.
      setDismissed((prev) => new Set(prev).add(g.id));
      void mark(g.id, "none");
    }
  }

  const yesNo = (onYes: () => void, onNo: () => void, noTitle: string) => (
    <span className="ml-0.5 inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onYes}
        disabled={busy}
        title="Here"
        className="text-xs font-semibold text-[var(--accent)] hover:opacity-80 disabled:opacity-40"
      >
        ✓
      </button>
      <button
        type="button"
        onClick={onNo}
        disabled={busy}
        title={noTitle}
        className="text-xs font-semibold text-ink-faint hover:text-red-400 disabled:opacity-40"
      >
        ✕
      </button>
    </span>
  );

  const empty =
    groups.length === 0 &&
    attending.length === 0 &&
    absent.length === 0 &&
    visibleGhosts.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {/* For — the category driving this meeting. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-11 shrink-0 text-xs text-ink-faint">For</span>
        {groups.map((g) => (
          <span key={g.id} className="group/grp relative inline-flex">
            <Link
              href={`/items/${g.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)]/60 bg-[var(--accent)]/10 px-2.5 py-0.5 text-sm font-medium text-[var(--accent)] hover:border-[var(--accent)]"
            >
              <span aria-hidden="true" className="text-xs">⬡</span>
              {g.title || "Untitled"}
              {g.memberCount > 0 && (
                <span className="text-xs font-normal opacity-70">· {g.memberCount}</span>
              )}
            </Link>
            <button
              type="button"
              onClick={() => unrelate(g.id)}
              disabled={busy}
              title="Remove this group from the meeting"
              className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-surface-3 text-[10px] text-ink-muted hover:text-red-400 group-hover/grp:flex"
            >
              ✕
            </button>
          </span>
        ))}
        <AddPicker
          label="+ group"
          typeKey="group"
          typeLabel="Group"
          placeholder="Search groups…"
          exclude={new Set(groups.map((g) => g.id))}
          onPick={(h) => void relate(h.id, EVENT_GROUP_ROLE)}
        />
      </div>

      {/* Here — individuals: attending, OUT, then the unresolved ghosts. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-11 shrink-0 text-xs text-ink-faint">Here</span>
        {empty && (
          <span className="text-sm text-ink-faint">
            No one yet — add a group or a person.
          </span>
        )}
        {attending.map((p) => (
          <span key={p.id} className="group/chip relative inline-flex">
            <Link
              href={`/items/${p.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-0.5 pl-1 pr-2.5 text-sm text-ink hover:border-line-strong"
            >
              <Avatar title={p.title} />
              {p.title || "Untitled"}
            </Link>
            <button
              type="button"
              onClick={() => mark(p.id, "none")}
              disabled={busy}
              title="Remove from this meeting"
              className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-surface-3 text-[10px] text-ink-muted hover:text-red-400 group-hover/chip:flex"
            >
              ✕
            </button>
          </span>
        ))}
        {absent.map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-line/60 py-0.5 pl-1 pr-2 text-sm text-ink-faint"
          >
            <Avatar title={p.title} dim />
            <Link href={`/items/${p.id}`} className="line-through decoration-ink-faint hover:text-ink-muted">
              {p.title || "Untitled"}
            </Link>
            <span className="text-[10px] font-semibold tracking-wide text-red-400/70">OUT</span>
            {yesNo(() => void mark(p.id, "here"), () => void mark(p.id, "none"), "Clear the mark")}
          </span>
        ))}
        {shownGhosts.map((g) => (
          <span
            key={g.id}
            title={g.kind === "roster" ? "Expected (in the group) — here?" : "Suggested — here?"}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line py-0.5 pl-1 pr-2 text-sm text-ink-muted"
          >
            <Avatar title={g.title} dim />
            {g.title || "Untitled"}
            {yesNo(
              () => void mark(g.id, "here"),
              () => dismissGhost(g),
              g.kind === "roster" ? "Not here (mark OUT)" : "Dismiss"
            )}
          </span>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllGhosts(true)}
            className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-sm text-ink-faint hover:text-ink-muted"
          >
            +{hiddenCount} more
          </button>
        )}
        {rosterUnresolved && (
          <button
            type="button"
            onClick={() => void allHere()}
            disabled={busy}
            title="Confirm everyone still unresolved from the group"
            className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/50 bg-[var(--accent)]/5 px-2.5 py-0.5 text-sm font-medium text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40"
          >
            ✓ all here
          </button>
        )}
        <AddPicker
          label="+ person"
          typeKey="person"
          typeLabel="Person"
          placeholder="Search people…"
          exclude={
            new Set([
              ...attending.map((p) => p.id),
              ...absent.map((p) => p.id),
              ...visibleGhosts.map((g) => g.id),
            ])
          }
          onPick={(h) => void mark(h.id, "here")}
        />
      </div>

      {/* Also mentioned — read-only; the body/related panel owns these links. */}
      {mentioned.length > 0 && (
        <p className="pl-11 text-xs text-ink-faint">
          Also mentioned:{" "}
          {mentioned.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <Link href={`/items/${p.id}`} className="text-ink-subtle underline decoration-line underline-offset-2 hover:text-ink-muted">
                {p.title || "Untitled"}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
