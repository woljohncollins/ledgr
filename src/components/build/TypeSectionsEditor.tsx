// Per-type SECTIONS editor (ADR-181) — the "Record sections" panel on the type
// edit page, and the Build-side face of Layer 2 of the composition model
// (ADR-111/PJ3): what every record of this type shows before an individual record
// diverges from it.
//
// Layer 2 was readable but unwritable everywhere in the app until ADR-181: only a
// single record could be rearranged ("+ Add section" and the gear on the record
// page). This panel is the type-level twin of that, so "every project should show
// Tasks and Milestones but never Timeline" is set once instead of per project.
//
// Two rules the UI has to make visible, because both are easy to fear:
//   1. Turning a section OFF never deletes anything. The tasks/notes/meetings
//      behind it are untouched (hidden=true, the defer-by-hiding standard), so
//      turning it back on restores the card and its contents.
//   2. A record with its OWN layout keeps it. A record diverges from its type; it
//      never defines it, and this panel can't reach back into one that has.
//
// Saving PATCHes the focused /api/types/[key]/widgets route (never the whole
// builder). Reset clears the type default so records fall back to the built-in
// starting set. Styled from the semantic token layer (ADR-141) rather than raw
// neutrals.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Composition, RecordWidget } from "@/lib/composition";
import { WIDGET_LIMIT_ALL, WIDGET_LIMIT_DEFAULT, WIDGET_LIMIT_MAX, widgetLimit } from "@/lib/composition";

// One row of the editor: a catalog tool plus whether this type shows it.
type Row = {
  id: string;
  label: string;
  // "collection"/"relation" cards (and the Timeline) preview N rows then link
  // to the full list, so only those get a count control.
  capped: boolean;
  shown: boolean;
  limit: number;
  // Timeline only: the no-date milestone group's label ("" = "Upcoming").
  undatedLabel?: string;
};

export default function TypeSectionsEditor({
  typeKey,
  typeLabel,
  catalog,
  // The type's stored Layer 2 (null = it has none yet).
  initial,
  // What records of this type show right now — the stored default if there is
  // one, else the built-in starting set. Seeds the editor so the first save is a
  // faithful copy of current behavior plus the one change being made.
  effective,
}: {
  typeKey: string;
  typeLabel: string;
  catalog: { id: string; label: string; capped: boolean }[];
  initial: Composition | null;
  effective: Composition;
}) {
  const router = useRouter();

  function rowsFrom(comp: Composition): Row[] {
    const byId = new Map(comp.widgets.map((w) => [w.defId, w]));
    // Stored order first (that's the on-page order), then the rest of the
    // catalog as available-but-off.
    const ordered = [
      ...comp.widgets.map((w) => w.defId).filter((id) => catalog.some((c) => c.id === id)),
      ...catalog.map((c) => c.id).filter((id) => !byId.has(id)),
    ];
    return ordered.map((id) => {
      const def = catalog.find((c) => c.id === id)!;
      const inst = byId.get(id);
      return {
        id,
        label: def.label,
        capped: def.capped,
        shown: Boolean(inst) && !inst!.hidden,
        limit: inst ? widgetLimit(inst) : WIDGET_LIMIT_DEFAULT,
        // Timeline only: what its no-date milestone group is called (Tyler,
        // 2026-08-17). Blank = the built-in "Upcoming".
        undatedLabel:
          id === "timeline" && typeof inst?.options?.undatedLabel === "string"
            ? inst.options.undatedLabel
            : "",
      };
    });
  }

  const [rows, setRows] = useState<Row[]>(() => rowsFrom(effective));
  const [customized, setCustomized] = useState(initial != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSaved(false);
  }

  function move(index: number, delta: number) {
    setRows((rs) => {
      const to = index + delta;
      if (to < 0 || to >= rs.length) return rs;
      const next = [...rs];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setSaved(false);
  }

  async function send(body: { composition: Composition | null }) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/types/${typeKey}/widgets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `save failed (${res.status})`);
      }
      setSaved(true);
      setCustomized(body.composition != null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    // Every catalog section is written, carrying hidden=true when off, so the
    // stored default keeps its options and its order; turning one back on
    // restores exactly what it had. behaviors (the digest settings) carry
    // through untouched — this panel doesn't own them.
    const widgets: RecordWidget[] = rows.map((r) => {
      const w: RecordWidget = { instanceId: r.id, defId: r.id };
      if (!r.shown) w.hidden = true;
      // "All" reads as Infinity (widgetLimit) but persists as the literal "all"
      // — Infinity doesn't survive JSON.
      if (r.capped && r.limit !== WIDGET_LIMIT_DEFAULT) {
        w.options = { limit: Number.isFinite(r.limit) ? r.limit : WIDGET_LIMIT_ALL };
      }
      // Timeline's custom no-date group label; blank = the built-in "Upcoming".
      if (r.id === "timeline" && r.undatedLabel?.trim()) {
        w.options = { ...w.options, undatedLabel: r.undatedLabel.trim().slice(0, 30) };
      }
      return w;
    });
    void send({
      composition: {
        version: 1,
        widgets,
        behaviors: initial?.behaviors ?? effective.behaviors ?? {},
      },
    });
  }

  function reset() {
    setRows(rowsFrom(effective));
    void send({ composition: null });
  }

  const shownCount = rows.filter((r) => r.shown).length;

  return (
    <fieldset className="mt-6 flex flex-col gap-3 rounded-card border border-line p-4">
      <legend className="px-1 ui-section-label text-ink-muted">Tools</legend>
      <p className="ui-meta text-ink-subtle">
        The default tools every new {typeLabel.toLowerCase()} starts with, and in
        what order. Turning a tool off{" "}
        <span className="text-ink-muted">never deletes anything</span> — the
        tasks, notes and meetings behind it stay exactly where they are, so
        turning it back on brings the card back with its contents. A record that
        has been rearranged on its own page keeps its own arrangement.
      </p>

      <div className="flex items-center gap-2 ui-meta text-ink-subtle">
        {customized ? (
          <span>
            This type has its own tools ({shownCount} shown).
          </span>
        ) : (
          <span>
            Using the built-in starting set ({shownCount} shown). Saving makes it
            this type&apos;s own.
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <li
            key={r.id}
            className={`flex items-center gap-2 rounded border border-line px-2 py-1.5 ${
              r.shown ? "bg-surface-2" : "bg-surface-1 opacity-60"
            }`}
          >
            <label className="flex min-w-0 flex-1 items-center gap-2 ui-row text-ink">
              <input
                type="checkbox"
                className="ledgr-check ledgr-check-sm"
                checked={r.shown}
                onChange={(e) => update(r.id, { shown: e.target.checked })}
              />
              <span className="truncate">{r.label}</span>
            </label>

            {r.capped && r.shown && (
              <span className="flex shrink-0 items-center gap-1 ui-meta text-ink-subtle">
                show
                {Number.isFinite(r.limit) && (
                  <input
                    type="number"
                    min={1}
                    max={WIDGET_LIMIT_MAX}
                    value={r.limit}
                    onChange={(e) =>
                      update(r.id, {
                        limit: Math.min(
                          Math.max(Math.round(Number(e.target.value) || WIDGET_LIMIT_DEFAULT), 1),
                          WIDGET_LIMIT_MAX
                        ),
                      })
                    }
                    className="w-14 rounded border border-line bg-surface-1 px-1.5 py-0.5 text-right ui-meta text-ink outline-none focus:border-line-strong"
                    aria-label={`${r.label}: rows to preview`}
                  />
                )}
                rows
                <label className="ml-1 flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="ledgr-check ledgr-check-sm"
                    checked={!Number.isFinite(r.limit)}
                    onChange={(e) =>
                      update(r.id, {
                        limit: e.target.checked ? Number.POSITIVE_INFINITY : WIDGET_LIMIT_DEFAULT,
                      })
                    }
                    aria-label={`${r.label}: show all rows`}
                  />
                  all
                </label>
              </span>
            )}

            {r.id === "timeline" && r.shown && (
              <label className="flex shrink-0 items-center gap-1 ui-meta text-ink-subtle">
                no-date group
                <input
                  type="text"
                  value={r.undatedLabel ?? ""}
                  onChange={(e) => update(r.id, { undatedLabel: e.target.value })}
                  placeholder="Upcoming"
                  maxLength={30}
                  className="w-24 rounded border border-line bg-surface-1 px-1.5 py-0.5 ui-meta text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
                  aria-label="Timeline: label for the no-date milestone group"
                />
              </label>
            )}

            <span className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="rounded px-1 ui-meta text-ink-subtle hover:text-ink disabled:opacity-30"
                aria-label={`Move ${r.label} up`}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === rows.length - 1}
                className="rounded px-1 ui-meta text-ink-subtle hover:text-ink disabled:opacity-30"
                aria-label={`Move ${r.label} down`}
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {customized && (
          <button
            onClick={reset}
            disabled={busy}
            className="rounded border border-line px-2.5 py-1.5 ui-meta text-ink-muted hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            Reset to built-in
          </button>
        )}
        {saved && <span className="ui-meta text-green-500">Saved</span>}
        {error && <span className="ui-meta text-red-400">{error}</span>}
      </div>
    </fieldset>
  );
}
