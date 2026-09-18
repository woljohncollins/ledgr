// A month-grid day picker (the Todoist-shaped scheduler, Tyler 2026-08-18 —
// ADR-202 follow-on): Sunday-first weeks, ‹ ○ › month nav (○ jumps back to the
// current month), the selected day filled with the accent, today marked. Pure
// calendar-day math on YYYY-MM-DD strings (the ADR-008 UTC-midnight
// convention) — never local Date rendering, so the grid can't drift a day.
// No dependency (Principle 5). Presentational: reports the picked day via
// onPick; the owner writes.
"use client";

import { useState } from "react";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// 0=Sun … 6=Sat for the 1st of the month.
const firstDow = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1)).getUTCDay();

function shiftMonth(ym: { y: number; m: number }, by: number) {
  const total = ym.y * 12 + (ym.m - 1) + by;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}

export default function MonthCalendar({
  valueYmd,
  today,
  onPick,
}: {
  valueYmd: string | null; // YYYY-MM-DD or null
  today: string; // app-timezone YYYY-MM-DD
  onPick: (ymd: string) => void;
}) {
  const anchor = valueYmd ?? today;
  const [ym, setYm] = useState({ y: Number(anchor.slice(0, 4)), m: Number(anchor.slice(5, 7)) });
  const todayYm = { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) };
  const onTodayMonth = ym.y === todayYm.y && ym.m === todayYm.m;

  const lead = firstDow(ym.y, ym.m);
  const total = daysIn(ym.y, ym.m);
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: total }, (_, i) => `${ym.y}-${pad(ym.m)}-${pad(i + 1)}`),
  ];

  const navBtn =
    "flex h-6 w-6 items-center justify-center rounded text-ink-subtle hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div>
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-semibold text-ink">
          {MONTH_ABBR[ym.m - 1]} {ym.y}
        </span>
        <span className="flex items-center gap-0.5">
          <button type="button" aria-label="Previous month" className={navBtn} onClick={() => setYm((v) => shiftMonth(v, -1))}>
            ‹
          </button>
          <button
            type="button"
            aria-label="Current month"
            title="Back to this month"
            className={navBtn}
            disabled={onTodayMonth}
            onClick={() => setYm(todayYm)}
          >
            <span aria-hidden className="inline-block h-2 w-2 rounded-full border border-current" />
          </button>
          <button type="button" aria-label="Next month" className={navBtn} onClick={() => setYm((v) => shiftMonth(v, 1))}>
            ›
          </button>
        </span>
      </div>
      <div className="mt-1 grid grid-cols-7 text-center">
        {DOW.map((d, i) => (
          <span key={i} className="py-1 text-xs text-ink-faint">
            {d}
          </span>
        ))}
        {cells.map((ymd, i) =>
          ymd === null ? (
            <span key={`b${i}`} />
          ) : (
            <button
              key={ymd}
              type="button"
              onClick={() => onPick(ymd)}
              aria-label={ymd}
              className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm ${
                ymd === valueYmd
                  ? "bg-[var(--accent)] font-semibold text-white"
                  : ymd === today
                    ? "font-semibold text-[var(--accent)] hover:bg-surface-2"
                    : ymd < today
                      ? "text-ink-faint hover:bg-surface-2 hover:text-ink"
                      : "text-ink hover:bg-surface-2"
              }`}
            >
              {Number(ymd.slice(8, 10))}
            </button>
          )
        )}
      </div>
    </div>
  );
}
