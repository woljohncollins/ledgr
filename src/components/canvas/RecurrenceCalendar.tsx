// The completions calendar on a recurring task (Tasks Polish S3, ADR-083) —
// TaskNotes "Completions" style. A month grid where every occurrence date is
// individually checkable in any order: tapping one toggles its entry in the
// per-date completion log (properties.recurrence.completeInstances). The server
// recomputes the next scheduled date + status after each edit, so this surface
// only edits the log.
//
// PLUS the inverted occurrence edit: editing a recurring task edits the SERIES;
// to shape one date differently, carve it out — a fresh DETACHED one-off (cloned
// from the series prototype) is created for that date, the series skips it, and
// you land on the new item to edit it. Edits there never touch the series.
//
// Virtual-series only (the canvas gates it): a materialized series' occurrences
// are their own items with their own checkboxes.
"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { openItem } from "@/lib/item-nav";
import { beginSave, endSave } from "@/lib/save-status";
import {
  addDaysYmd,
  addMonthsYmd,
  enumerateOccurrences,
  instanceState,
  nextUncompletedOnOrAfter,
  toggleCompleteInstance,
  WEEKDAYS,
  WEEKDAY_LABELS,
  weekdayOf,
  type RecurrenceRule,
} from "@/lib/recurrence";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function monthOf(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}
function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${WEEKDAY_LABELS[weekdayOf(ymd)]}, ${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

export default function RecurrenceCalendar({
  itemId,
  initial,
  today,
  bare = false,
}: {
  itemId: string;
  initial: RecurrenceRule;
  today: string; // YYYY-MM-DD in the app timezone
  // Drop the wide centered-column padding so the month grid fills a narrow
  // container (the Schedule popover) instead of being crushed by the
  // full-width canvas's responsive px-* (ADR-108 polish).
  bare?: boolean;
}) {
  const router = useRouter();
  const [rule, setRule] = useState(initial);
  const [viewMonth, setViewMonth] = useState(() =>
    monthOf(nextUncompletedOnOrAfter(initial, today) ?? initial.dtstart ?? today)
  );
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [carveDate, setCarveDate] = useState<string | null>(null);
  const [carving, setCarving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The next uncompleted occurrence on/after today — the "up next" highlight.
  // Computed from local state so it tracks optimistic toggles without a refetch.
  const nextUp = useMemo(
    () => nextUncompletedOnOrAfter(rule, today),
    [rule, today]
  );

  // The 6-week grid (Monday-first, matching WEEKDAYS) for the viewed month, plus
  // the set of occurrence dates in that window.
  const { days, occ } = useMemo(() => {
    const first = viewMonth;
    const lead = WEEKDAYS.indexOf(weekdayOf(first));
    const gridStart = addDaysYmd(first, -lead);
    const cells = Array.from({ length: 42 }, (_, i) => addDaysYmd(gridStart, i));
    const occSet = new Set(
      enumerateOccurrences(
        { rrule: rule.rrule, dtstart: rule.dtstart },
        { from: gridStart, to: cells[41] }
      )
    );
    return { days: cells, occ: occSet };
  }, [viewMonth, rule.rrule, rule.dtstart]);

  const [vy, vm] = viewMonth.split("-").map(Number);
  const monthLabel = `${MONTH_NAMES[vm - 1]} ${vy}`;

  async function toggle(date: string) {
    if (busy.has(date)) return;
    const before = rule;
    setRule(toggleCompleteInstance(rule, date));
    setBusy((b) => new Set(b).add(date));
    setError(null);
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}/occurrence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", date }),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      router.refresh();
    } catch {
      setRule(before);
      setError("Save failed, reverted.");
      endSave(false);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(date);
        return n;
      });
    }
  }

  async function carve(date: string) {
    setCarving(true);
    setError(null);
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}/occurrence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "carve", date }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { itemId: newId } = (await res.json()) as { itemId: string };
      endSave(true);
      openItem(router, newId); // land on the carved one-off to edit it
    } catch {
      setError("Could not carve this occurrence.");
      endSave(false);
      setCarving(false);
      setCarveDate(null);
    }
  }

  return (
    <section
      className={
        bare
          ? "w-full"
          : "mx-auto w-full max-w-3xl px-2 pb-2 pt-1 sm:px-8 md:px-12"
      }
    >
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
        {/* Month header */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setViewMonth(addMonthsYmd(viewMonth, -1))}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              ‹
            </button>
            <span className="min-w-[8.5rem] text-center text-sm font-medium text-neutral-200">
              {monthLabel}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setViewMonth(addMonthsYmd(viewMonth, 1))}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              ›
            </button>
          </div>
          <button
            type="button"
            onClick={() => setViewMonth(monthOf(today))}
            className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Today
          </button>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-neutral-600">
          {WEEKDAYS.map((w) => (
            <div key={w}>{WEEKDAY_LABELS[w].slice(0, 1)}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="mt-1 grid grid-cols-7 gap-1">
          {days.map((d) => {
            const inMonth = d.slice(0, 7) === viewMonth.slice(0, 7);
            const day = Number(d.slice(8, 10));
            if (!occ.has(d)) {
              return (
                <div
                  key={d}
                  className={`flex h-9 items-center justify-center rounded text-xs ${
                    d === today ? "ring-1 ring-inset ring-neutral-700 " : ""
                  }${inMonth ? "text-neutral-600" : "text-neutral-800"}`}
                >
                  {day}
                </div>
              );
            }
            const state = instanceState(rule, d);
            const isNext = d === nextUp;
            const isBusy = busy.has(d);
            const base =
              "group relative flex h-9 items-center justify-center rounded text-xs transition-colors disabled:opacity-50";
            let style: string;
            if (state === "complete") {
              style = "bg-[var(--accent)] font-medium text-black hover:opacity-90";
            } else if (state === "skipped") {
              style =
                "bg-neutral-800/60 text-neutral-500 line-through hover:bg-neutral-800";
            } else if (isNext) {
              style =
                "ring-1 ring-inset ring-[var(--accent)] text-neutral-100 hover:bg-neutral-800";
            } else {
              style =
                "border border-neutral-700/70 text-neutral-300 hover:bg-neutral-800";
            }
            return (
              <button
                key={d}
                type="button"
                disabled={isBusy}
                onClick={() => void toggle(d)}
                title={
                  state === "complete"
                    ? `${fmtDate(d)} — done (tap to undo)`
                    : state === "skipped"
                      ? `${fmtDate(d)} — carved out / skipped`
                      : `${fmtDate(d)} — tap to mark done`
                }
                className={`${base} ${style} ${!inMonth ? "opacity-60" : ""}`}
              >
                {state === "complete" ? "✓" : day}
                {/* Carve affordance: only on a not-yet-done occurrence (desktop
                    hover). Mobile uses the "Edit next occurrence" button below. */}
                {state === "none" && (
                  <span
                    role="button"
                    aria-label="Edit just this date"
                    title="Edit just this date (carve out a one-off; the series skips it)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCarveDate(d);
                    }}
                    className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-neutral-600 bg-neutral-900 text-[9px] text-neutral-300 group-hover:flex hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    ✎
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend + next-occurrence carve (mobile-friendly) */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm bg-[var(--accent)]" />
              done
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm ring-1 ring-inset ring-[var(--accent)]" />
              up next
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm bg-neutral-800/60 line-through text-center leading-3 text-neutral-500">
                ·
              </span>
              carved
            </span>
          </div>
          {nextUp && (
            <button
              type="button"
              onClick={() => setCarveDate(nextUp)}
              className="rounded px-1.5 py-0.5 text-neutral-400 underline decoration-dotted underline-offset-2 hover:text-neutral-200"
            >
              Edit next occurrence ({MONTH_ABBR[Number(nextUp.slice(5, 7)) - 1]}{" "}
              {Number(nextUp.slice(8, 10))}) separately
            </button>
          )}
        </div>

        {/* Inline carve confirm (one UI, two triggers — cell ✎ + the button) */}
        {carveDate && (
          <div className="mt-2 rounded border border-neutral-700 bg-neutral-900 p-2 text-xs">
            <p className="text-neutral-300">
              Edit <span className="font-medium">{fmtDate(carveDate)}</span> as a
              separate one-off? It becomes its own task (copied from this one) and
              the series skips this date.
            </p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={carving}
                onClick={() => setCarveDate(null)}
                className="rounded px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={carving}
                onClick={() => void carve(carveDate)}
                className="rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-black hover:opacity-90 disabled:opacity-50"
              >
                {carving ? "Carving…" : "Carve out"}
              </button>
            </div>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    </section>
  );
}
