// Per-type completion editor (ADR-106, building on Tasks Polish S2 / ADR-082) —
// the "Completion tracking" panel on the type edit page. One control sets HOW a
// type presents completion (the display mode), and — only in "Custom statuses"
// mode — the ClickUp-style status schema underneath it:
//
//   None          → this type has no status anywhere (person, link, a note).
//   Done checkbox → a binary done / not-done checkbox (the task default).
//   Custom statuses → the multi-status dropdown / kanban; reveals the schema
//                     editor (inherit the default, or define your own).
//
// The mode is PRESENTATION ONLY. Underneath, every status still maps to one of
// the four fixed categories the rest of Ledgr keys off (the done category drives
// the checkbox and completing a recurring task) — see src/lib/status.ts. Saving
// PATCHes the focused /api/types/[key]/statuses route (never the whole builder).
// Switching to None/Done-checkbox keeps any custom schema stored (defer-by-
// hiding), so flipping back to Custom statuses restores it.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CATEGORY_DEFAULT_COLOR,
  CATEGORY_META,
  STATUS_CATEGORIES,
  SYSTEM_DEFAULT_STATUSES,
  type StatusCategory,
  type StatusDef,
  type StatusMode,
} from "@/lib/status";

const inputClass =
  "rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600";

const MODE_OPTIONS: { value: StatusMode; label: string; hint: string }[] = [
  {
    value: "none",
    label: "None",
    hint: "No status on this type — no checkbox, chip, or status filter anywhere.",
  },
  {
    value: "checkbox",
    label: "Done checkbox",
    hint: "A simple done / not-done checkbox. Checking it completes the item.",
  },
  {
    value: "select",
    label: "Custom statuses",
    hint: "Multiple stages (To Do, In Progress, Done…), shown as a dropdown and kanban columns.",
  },
];

export default function StatusSchemaEditor({
  typeKey,
  initialMode,
  initial,
}: {
  typeKey: string;
  // The type's resolved display mode (ADR-106).
  initialMode: StatusMode;
  // The type's stored statusSchema (null = inheriting the system default).
  initial: StatusDef[] | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<StatusMode>(initialMode);
  // Inherit-vs-custom only applies inside "Custom statuses" (select) mode.
  const [custom, setCustom] = useState(initial != null);
  // Seed custom editing from the inherited default when the type has none yet,
  // so flipping to "custom" starts from To Do / Done / Archived, not blank.
  const [rows, setRows] = useState<StatusDef[]>(
    initial && initial.length ? initial : SYSTEM_DEFAULT_STATUSES
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update(key: string, patch: Partial<StatusDef>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function remove(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }
  function add(category: StatusCategory) {
    // A fresh stable key not already in use (no Date.now — the purity rule); the
    // key is opaque, the label is what shows.
    setRows((rs) => {
      const used = new Set(rs.map((r) => r.key));
      let n = rs.length + 1;
      while (used.has(`status_${n}`)) n += 1;
      return [
        ...rs,
        {
          key: `status_${n}`,
          label: "New status",
          category,
          color: CATEGORY_DEFAULT_COLOR[category],
        },
      ];
    });
  }
  // Reorder a status WITHIN its category (Tyler, 2026-08-25). A board's columns
  // read left to right in category order first (Not Started → In Progress → Done
  // → Closed) and then in this array's order inside each category — so without
  // this control a status added later was pinned to the end of its group forever
  // ("Blocked" stranded after "Future"), and the only fix was deleting and
  // recreating statuses. Swapping two SAME-CATEGORY entries can't disturb the
  // category grouping, which is why this is a plain positional swap.
  function move(key: string, dir: -1 | 1) {
    setRows((rs) => {
      const row = rs.find((r) => r.key === key);
      if (!row) return rs;
      // Indices of this category's rows, in array order.
      const sameCat = rs.reduce<number[]>((acc, r, i) => {
        if (r.category === row.category) acc.push(i);
        return acc;
      }, []);
      const pos = sameCat.indexOf(rs.findIndex((r) => r.key === key));
      const to = pos + dir;
      if (pos < 0 || to < 0 || to >= sameCat.length) return rs;
      const a = sameCat[pos];
      const b = sameCat[to];
      const next = [...rs];
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
  }

  // One default per category (a radio); clears the flag on the others in it.
  function setDefault(category: StatusCategory, key: string) {
    setRows((rs) =>
      rs.map((r) =>
        r.category === category ? { ...r, isDefault: r.key === key } : r
      )
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/types/${typeKey}/statuses`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // The server writes the schema only in "select" mode (defer-by-hiding),
        // so None/Done-checkbox preserve any custom statuses for later.
        body: JSON.stringify({
          mode,
          statuses: mode === "select" && custom ? rows : null,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `save failed (${res.status})`);
      }
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="mt-6 flex flex-col gap-3 rounded-lg border border-neutral-800 p-4">
      <legend className="px-1 text-sm font-semibold uppercase tracking-wide text-neutral-400">
        Completion tracking
      </legend>
      <p className="text-xs text-neutral-500">
        How this type shows completion. This is display only — under the hood
        every status maps to a fixed category the rest of Ledgr keys off (the
        done category drives the checkbox and completing a recurring task), so
        switching modes never loses data.
      </p>

      <div className="flex flex-col gap-2">
        {MODE_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-start gap-2 text-sm text-neutral-300">
            <input
              type="radio"
              name="status-mode"
              className="ledgr-check ledgr-check-sm mt-0.5"
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
            />
            <span className="flex flex-col">
              <span>{opt.label}</span>
              <span className="text-xs text-neutral-500">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "select" && (
        <div className="mt-1 flex flex-col gap-3 border-t border-neutral-800/60 pt-3">
          <div className="flex gap-4 text-sm text-neutral-300">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="status-schema-source"
                className="ledgr-check ledgr-check-sm"
                checked={!custom}
                onChange={() => setCustom(false)}
              />
              Inherit default (To Do / Done / Archived)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="status-schema-source"
                className="ledgr-check ledgr-check-sm"
                checked={custom}
                onChange={() => setCustom(true)}
              />
              Define statuses
            </label>
          </div>

          {custom && (
            <div className="flex flex-col gap-4">
              {STATUS_CATEGORIES.map((category) => {
                const inCat = rows.filter((r) => r.category === category);
                return (
                  <div key={category} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      {CATEGORY_META[category].label}
                      {category === "done" && (
                        <span className="font-normal normal-case tracking-normal text-neutral-600">
                          (the check-box completes to the default here)
                        </span>
                      )}
                    </div>
                    {inCat.map((s) => (
                      <div key={s.key} className="flex items-center gap-2">
                        <input
                          type="color"
                          value={s.color}
                          onChange={(e) => update(s.key, { color: e.target.value })}
                          className="h-7 w-9 shrink-0 cursor-pointer rounded border border-neutral-800 bg-neutral-900"
                          aria-label={`${s.label} color`}
                        />
                        <input
                          value={s.label}
                          onChange={(e) => update(s.key, { label: e.target.value })}
                          className={`${inputClass} flex-1`}
                          placeholder="Status label"
                        />
                        <label
                          className="flex shrink-0 items-center gap-1 text-xs text-neutral-500"
                          title="The default status in this category"
                        >
                          <input
                            type="radio"
                            name={`default-${category}`}
                            className="ledgr-check ledgr-check-sm"
                            checked={!!s.isDefault}
                            onChange={() => setDefault(category, s.key)}
                          />
                          default
                        </label>
                        {/* Order within this category = board column order. */}
                        <div className="flex shrink-0 flex-col">
                          <button
                            type="button"
                            onClick={() => move(s.key, -1)}
                            disabled={inCat[0]?.key === s.key}
                            className="rounded px-1 text-neutral-500 hover:text-neutral-200 disabled:opacity-25 disabled:hover:text-neutral-500"
                            aria-label={`Move ${s.label} earlier`}
                            title="Move earlier (further left on a board)"
                          >
                            <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                              <path d="M6 15l6-6 6 6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => move(s.key, 1)}
                            disabled={inCat[inCat.length - 1]?.key === s.key}
                            className="rounded px-1 text-neutral-500 hover:text-neutral-200 disabled:opacity-25 disabled:hover:text-neutral-500"
                            aria-label={`Move ${s.label} later`}
                            title="Move later (further right on a board)"
                          >
                            <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => remove(s.key)}
                          className="shrink-0 rounded px-1.5 text-xs text-neutral-500 hover:text-red-400"
                          aria-label={`Remove ${s.label}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => add(category)}
                      className="self-start rounded border border-dashed border-neutral-700 px-2 py-0.5 text-xs text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
                    >
                      + Add status
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-green-500">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </fieldset>
  );
}
