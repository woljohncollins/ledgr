// Build → Types → edit: the "List tabs" panel. Customizes the tab strip
// (ListLenses) that the type's list page shows. The owner can rename, reorder,
// remove, and add tabs, then save; "Reset to defaults" drops the override. A
// tab is a SORT (a built-in field or one of the type's properties) or a WIDGET
// (a saved view, rendered with the dashboard's ViewRenderer as that tab). Saves
// to users.settings.listTabs via PATCH /api/types/[key]/list-tabs — no view is
// authored here, only referenced (ViewBuilder stays the one authoring surface).
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { defaultLenses, type Lens, type LensField } from "@/lib/list-lenses";
import type { ViewDefinition } from "@/lib/views";

type PropOption = { key: string; label: string; numeric: boolean };

// The built-in sort fields offered when adding a tab, with a friendly default
// label + direction. Reverse-at-view-time covers the opposite order, so a single
// preset per field is enough.
const FIELD_PRESETS: { field: LensField; label: string; dir: "asc" | "desc" }[] = [
  { field: "updatedAt", label: "Recent", dir: "desc" },
  { field: "createdAt", label: "Newest", dir: "desc" },
  { field: "title", label: "A → Z", dir: "asc" },
  { field: "mostLinked", label: "Most linked", dir: "desc" },
  // Priority (P1 first) is task-only: filtered out of the picker for other
  // types below, since urgency isn't meaningful on notes/links/etc.
  { field: "urgency", label: "Priority", dir: "asc" },
];

// Fields that only make sense for tasks (they read the task-only urgency column).
const TASK_ONLY_FIELDS = new Set<LensField>(["urgency"]);

const FIELD_DESC: Record<LensField, string> = {
  updatedAt: "Recently edited",
  createdAt: "Newest first",
  title: "Alphabetical",
  mostLinked: "Most relations",
  urgency: "Highest priority first",
};

function genId(): string {
  return "l" + Math.random().toString(36).slice(2, 9);
}

function describe(lens: Lens, views: ViewDefinition[] | null): string {
  if (lens.kind === "view") {
    const v = views?.find((x) => x.id === lens.viewId);
    return v ? `Saved view · ${v.layout}` : "Saved view";
  }
  if (lens.kind === "calendar") return "Upcoming calendar events to add";
  if (lens.kind === "timeline") return "Upcoming / past by meeting time";
  if (lens.kind === "board") return "Kanban grouped by status · drag to change";
  if (lens.kind === "completed") return "Completed work, searchable";
  if ("property" in lens.source) return `Sort by ${lens.source.property}`;
  return FIELD_DESC[lens.source.field];
}

// The small kind badge on each tab row: label + tint.
function kindBadge(lens: Lens): { label: string; accent: boolean } {
  if (lens.kind === "view") return { label: "Widget", accent: true };
  if (lens.kind === "calendar") return { label: "Calendar", accent: true };
  if (lens.kind === "timeline") return { label: "Agenda", accent: true };
  if (lens.kind === "board") return { label: "Board", accent: true };
  if (lens.kind === "completed") return { label: "Completed", accent: true };
  return { label: "Sort", accent: false };
}

export default function ListTabsEditor({
  typeKey,
  propertyOptions,
  initialLenses,
  customized,
}: {
  typeKey: string;
  propertyOptions: PropOption[];
  initialLenses: Lens[];
  customized: boolean;
}) {
  const router = useRouter();
  const [lenses, setLenses] = useState<Lens[]>(initialLenses);
  const [views, setViews] = useState<ViewDefinition[] | null>(null);
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The last-saved snapshot, in state (not a ref) so `dirty` is a clean derived
  // render value and the Save/Reset buttons re-enable correctly.
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialLenses));
  const dirty = JSON.stringify(lenses) !== baseline;

  useEffect(() => {
    void fetch("/api/views")
      .then((r) => r.json())
      .then((d: { views: ViewDefinition[] }) => setViews(d.views))
      .catch(() => setViews([]));
  }, []);

  function move(index: number, delta: number) {
    setLenses((ls) => {
      const next = [...ls];
      const j = index + delta;
      if (j < 0 || j >= next.length) return ls;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
    setSaved(false);
  }

  function remove(id: string) {
    setLenses((ls) => ls.filter((l) => l.id !== id));
    setSaved(false);
  }

  function rename(id: string, label: string) {
    setLenses((ls) => ls.map((l) => (l.id === id ? { ...l, label } : l)));
    setSaved(false);
  }

  function addChoice() {
    if (!choice) return;
    const sep = choice.indexOf(":");
    const kind = choice.slice(0, sep);
    const val = choice.slice(sep + 1);
    let lens: Lens | null = null;
    if (kind === "field") {
      const p = FIELD_PRESETS.find((f) => f.field === val);
      if (p) lens = { id: genId(), kind: "sort", label: p.label, source: { field: p.field }, dir: p.dir };
    } else if (kind === "prop") {
      const p = propertyOptions.find((o) => o.key === val);
      if (p)
        lens = {
          id: genId(),
          kind: "sort",
          label: p.label,
          source: { property: p.key, numeric: p.numeric },
          dir: "asc",
        };
    } else if (kind === "view") {
      const v = views?.find((x) => x.id === val);
      if (v) lens = { id: genId(), kind: "view", label: v.name, viewId: v.id };
    } else if (kind === "calendar") {
      lens = { id: genId(), kind: "calendar", label: "Calendar" };
    } else if (kind === "timeline") {
      lens = { id: genId(), kind: "timeline", label: "Agenda" };
    }
    if (lens) {
      setLenses((ls) => [...ls, lens as Lens]);
      setChoice("");
      setSaved(false);
    }
  }

  async function persist(body: { lenses: Lens[] | null }, after: () => void) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/types/${typeKey}/list-tabs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Save failed (${res.status})`);
        return;
      }
      after();
      setSaved(true);
      router.refresh();
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  function save() {
    void persist({ lenses }, () => {
      setBaseline(JSON.stringify(lenses));
    });
  }

  function reset() {
    void persist({ lenses: null }, () => {
      const defs = defaultLenses(typeKey);
      setLenses(defs);
      setBaseline(JSON.stringify(defs));
    });
  }

  const input =
    "rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none";

  return (
    <section className="mt-8 rounded-xl border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-300">
          List tabs
        </h2>
        <span className="text-xs text-neutral-600">
          {customized ? "Customized" : "Defaults"}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        The tab strip on this type&apos;s list page. Sort tabs order the list (each
        reversible from the active tab); a widget tab renders a saved view.
      </p>

      <ul className="mt-3 space-y-1.5">
        {lenses.map((lens, i) => (
          <li
            key={lens.id}
            className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5"
          >
            <div className="flex flex-col leading-none">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label="Move up"
                className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === lenses.length - 1}
                aria-label="Move down"
                className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
              >
                ↓
              </button>
            </div>
            <input
              value={lens.label}
              onChange={(e) => rename(lens.id, e.target.value)}
              maxLength={40}
              aria-label="Tab label"
              className={`${input} w-40`}
            />
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                kindBadge(lens).accent
                  ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                  : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {kindBadge(lens).label}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
              {describe(lens, views)}
            </span>
            <button
              type="button"
              onClick={() => remove(lens.id)}
              aria-label="Remove tab"
              className="shrink-0 rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
            >
              ×
            </button>
          </li>
        ))}
        {lenses.length === 0 && (
          <li className="rounded border border-dashed border-neutral-800 px-2 py-3 text-center text-xs text-neutral-600">
            No tabs. Saving now restores the defaults.
          </li>
        )}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          aria-label="Add a tab"
          className={input}
        >
          <option value="">Add a tab…</option>
          {typeKey === "event" && (
            <optgroup label="Event views">
              <option value="calendar:calendar">Calendar (events to add)</option>
              <option value="timeline:timeline">Agenda (upcoming / past)</option>
            </optgroup>
          )}
          <optgroup label="Sort by field">
            {FIELD_PRESETS.filter(
              (f) => !TASK_ONLY_FIELDS.has(f.field) || typeKey === "task"
            ).map((f) => (
              <option key={f.field} value={`field:${f.field}`}>
                {f.label}
              </option>
            ))}
          </optgroup>
          {propertyOptions.length > 0 && (
            <optgroup label="Sort by property">
              {propertyOptions.map((p) => (
                <option key={p.key} value={`prop:${p.key}`}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Widget (saved view)">
            {views === null ? (
              <option disabled>Loading views…</option>
            ) : views.length === 0 ? (
              <option disabled>No saved views yet</option>
            ) : (
              views.map((v) => (
                <option key={v.id} value={`view:${v.id}`}>
                  {v.name} · {v.layout}
                </option>
              ))
            )}
          </optgroup>
        </select>
        <button
          type="button"
          onClick={addChoice}
          disabled={!choice}
          className="rounded bg-neutral-800 px-2.5 py-1 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          Add
        </button>
        <Link
          href="/views/new"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ＋ New view
        </Link>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save tabs"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={saving || (!customized && !dirty)}
          className="text-sm text-neutral-500 hover:text-neutral-300 disabled:opacity-40"
        >
          Reset to defaults
        </button>
        {saved && !dirty && <span className="text-xs text-emerald-500">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
