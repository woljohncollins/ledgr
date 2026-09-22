// Inline add for a view-backed widget (W2): one quiet input line at the TOP of
// the widget body, directly above the list it adds to (John, 2026-09-22 — it
// sat at the bottom until then, which put the capture line out of reach on a
// card tall enough to scroll).
// Type a title, press Enter, the item lands in the view and
// you stay on the board — the whole point of a dashboard as an activity surface
// (the action widget's quick-capture navigates away; this doesn't).
//
// Rendered automatically wherever the backing view's filter pins a type (zero
// configuration, Brandon's call). What a new item inherits is DETERMINISTIC or
// nothing (Principle 3): the pinned type always, and today's date only when the
// filter is explicitly a today window. No status guessing, no relation
// guessing, no model in the create path.
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";
import { openItem } from "@/lib/item-nav";
import type { ViewFilter } from "@/lib/views";

// Which date column a new item inherits from a today-window filter, or null for
// "send no date at all". The filter names the field it windows on (dateField,
// default "plan" = scheduled ?? due, ADR-109), so the inherited field is the
// one that actually makes the item match:
//   • plan / scheduledDate → scheduledDate (the plan date's primary column)
//   • dueDate              → dueDate
//   • meetingAt / createdAt / updatedAt → null: a timestamp, not a plain day;
//     guessing a time of day is exactly the kind of inference we don't do.
// focusedToday is its own today window (the Top-3 widget): it matches on the
// focus day-stamp, so an item captured there gets the stamp — a plain date
// wouldn't put it in the view.
export function inheritedDate(
  filter: ViewFilter
): { field: "scheduledDate" | "dueDate"; focus?: true } | null {
  if (filter.focusedToday) return { field: "scheduledDate", focus: true };
  if (filter.due !== "today") return null;
  const on = filter.dateField ?? "plan";
  if (on === "plan" || on === "scheduledDate") return { field: "scheduledDate" };
  if (on === "dueDate") return { field: "dueDate" };
  return null;
}

export default function InlineViewAdd({
  filter,
  today,
  focusItemId,
  mode = "inline",
}: {
  filter: ViewFilter;
  // dialog (2026-09-22): a button creates the item and opens it in the item
  // popup instead of the type-and-Enter line.
  mode?: "inline" | "dialog";
  // App-timezone today (YYYY-MM-DD) from the server — never recomputed from the
  // browser clock, so a late-night capture lands on the owner's day.
  today?: string;
  // The host dashboard's focus item, when it has one. The resolver applies the
  // focus to the QUERY only, so the filter arriving here is the stored
  // (unfocused) one: without relating the new item to the focus, it would match
  // the type and date but not the focus scope and vanish on the next refresh.
  // Relating it is the same deterministic create-inherits rule as ADR-028
  // ("+ Add creates an item of the filtered type and relates it to the host").
  // Skipped when the view pins its own `relatedTo` — applyFocus ignores the
  // dashboard focus in exactly that case, so relating to it would be a lie.
  focusItemId?: string | null;
}) {
  const type = filter.type!;
  const router = useRouter();
  const [text, setText] = useState("");
  // Optimistic rows: titles posted but not yet reflected in the server data.
  // startTransition(router.refresh) keeps isPending true until the fresh RSC
  // payload commits, so they clear exactly when the real rows arrive (and clear
  // even when the new item doesn't match the view — no permanent fake row).
  const [pending, setPending] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
  // Adjust-during-render (SubtaskCheckbox's idiom) rather than an effect: when
  // the refresh transition finishes, the server rows are authoritative.
  const [wasPending, setWasPending] = useState(false);
  if (isPending !== wasPending) {
    setWasPending(isPending);
    if (!isPending) setPending([]);
  }

  const label = type.replace(/_/g, " ");
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  const [busy, setBusy] = useState(false);

  // Same inherit rules as the inline add (type, today-window date, focus stamp,
  // dashboard focus relation), then straight into the item popup.
  async function addViaDialog() {
    if (busy) return;
    setBusy(true);
    try {
      const date = inheritedDate(filter);
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: "",
          ...(date && today
            ? {
                [date.field]: `${today}T00:00:00.000Z`,
                ...(date.focus ? { properties: { focus: { date: today, order: Date.now() } } } : null),
              }
            : null),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { item } = (await res.json()) as { item: { id: string } };
      const host = filter.relatedTo ? null : focusItemId;
      if (host) {
        await fetch(`/api/items/${item.id}/relations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: host }),
        }).catch(() => {});
      }
      openItem(router, item.id);
    } catch {
      showToast(`Couldn't create ${article} ${label}`);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "dialog") {
    return (
      <div className="shrink-0 px-2 pt-1.5">
        <button
          type="button"
          onClick={() => void addViaDialog()}
          disabled={busy}
          className="cancel-drag w-full rounded border border-dashed border-line px-2 py-1 text-left text-sm text-ink-muted hover:border-line-strong hover:bg-surface-2 hover:text-ink disabled:opacity-60"
        >
          {busy ? "Creating…" : `+ New ${label}…`}
        </button>
      </div>
    );
  }

  async function add() {
    const title = text.trim();
    if (!title) return;
    setText("");
    setPending((p) => [...p, title]);
    try {
      const date = inheritedDate(filter);
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title,
          ...(date && today
            ? {
                [date.field]: `${today}T00:00:00.000Z`,
                ...(date.focus ? { properties: { focus: { date: today, order: Date.now() } } } : null),
              }
            : null),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // POST /api/items can't carry a relation, so the edge is a second call to
      // the existing relations endpoint — the same create-then-relate pair
      // AddRelation's create-on-miss already uses. No new endpoint.
      const host = filter.relatedTo ? null : focusItemId;
      if (host) {
        const { item } = (await res.json()) as { item: { id: string } };
        const rel = await fetch(`/api/items/${item.id}/relations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: host }),
        });
        // The item exists either way, so a failed edge is NOT the create error
        // path (retrying would duplicate it): say what actually happened.
        if (!rel.ok) showToast("Added, but couldn't link it to the focus");
      }
      startTransition(() => router.refresh());
    } catch {
      // Don't lose what was typed.
      setPending((p) => p.filter((t) => t !== title));
      setText((t) => t || title);
      showToast("Couldn't add that");
    }
  }

  return (
    <div className="shrink-0 px-2 pt-1.5">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape") {
            setText("");
            e.currentTarget.blur();
          }
        }}
        placeholder={`+ Add ${article} ${label}…`}
        aria-label={`Add ${article} ${label}`}
        // cancel-drag: react-grid-layout must never start a drag from here.
        className="cancel-drag w-full rounded bg-transparent px-1.5 py-1 text-sm text-ink placeholder:text-ink-faint focus:bg-surface-2 focus:outline-none"
      />
      {/* Provisional rows sit BELOW the input, against the list they are about
          to join, so an add reads as landing on the list rather than stacking
          upward away from it. */}
      {pending.map((t, i) => (
        <div key={`${t}-${i}`} className="truncate px-1.5 py-1 text-sm text-ink-subtle">
          {t}
        </div>
      ))}
    </div>
  );
}
