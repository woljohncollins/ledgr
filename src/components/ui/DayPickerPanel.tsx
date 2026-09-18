// The Todoist-shaped day picker (Tyler 2026-08-18, from a mock — ADR-202
// follow-on): quick-pick rows with the resolved weekday on the right (Today,
// Tomorrow, Later this week, This weekend, Next week, No Date), a real month
// grid (MonthCalendar), and the free-text natural-language box kept from the
// old DayField ("next fri 9am"). Presentational — it reports a picked
// YYYY-MM-DD (or null to clear, plus an optional "HH:MM" when parseTime is on)
// via onPick; the owner does the PATCH. Used by the canvas Schedule/Due
// popovers (via DayField) and the task row's date popup (TaskDateEdit).
"use client";

import MonthCalendar from "@/components/ui/MonthCalendar";
import { addDaysYmd } from "@/lib/recurrence";
import { formatDayLabel } from "@/lib/format-date";
import { parseNaturalDate, parseNaturalWhen } from "@/lib/nl-date";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dowOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0=Sun

const rowClass =
  "flex w-full items-center gap-2.5 rounded px-1.5 py-1.5 text-left text-sm text-ink hover:bg-surface-2";
const iconClass = "h-4 w-4 shrink-0 text-ink-subtle";
const rightClass = "ml-auto shrink-0 text-xs text-ink-subtle";

function SunIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function CalendarIcon({ dot = false }: { dot?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 9h16M8 3v4M16 3v4" />
      {dot && <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />}
    </svg>
  );
}
function CouchIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3" />
      <path d="M3 13a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M5 18v2M19 18v2" />
    </svg>
  );
}
function ArrowIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 12h6M13 9l3 3-3 3" />
    </svg>
  );
}
function NoDateIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M6 18L18 6" />
    </svg>
  );
}

export default function DayPickerPanel({
  valueYmd,
  today,
  onPick,
  parseTime = false,
  autoFocus = false,
}: {
  valueYmd: string | null; // YYYY-MM-DD or null
  today: string; // app-timezone YYYY-MM-DD
  // The picked day (null clears), plus an optional "HH:MM" when parseTime is on
  // and the free-text box carried one ("5am today"). The owner does the PATCH.
  onPick: (ymd: string | null, time?: string) => void;
  parseTime?: boolean;
  autoFocus?: boolean;
}) {
  const dow = dowOf(today);
  const tomorrow = addDaysYmd(today, 1);
  const thisThu = addDaysYmd(today, (4 - dow + 7) % 7);
  const thisSat = addDaysYmd(today, (6 - dow + 7) % 7);
  const nextMon = addDaysYmd(today, ((1 - dow + 7) % 7) || 7);

  const quick: { label: string; ymd: string | null; right: string; icon: React.ReactNode }[] = [
    { label: "Today", ymd: today, right: WEEKDAYS[dowOf(today)], icon: <CalendarIcon dot /> },
    { label: "Tomorrow", ymd: tomorrow, right: WEEKDAYS[dowOf(tomorrow)], icon: <SunIcon /> },
    // Only offered while they still mean something: Thursday/Saturday must be
    // further out than tomorrow, or the row would duplicate one above it.
    ...(thisThu > tomorrow
      ? [{ label: "Later this week", ymd: thisThu, right: WEEKDAYS[dowOf(thisThu)], icon: <CalendarIcon /> }]
      : []),
    ...(thisSat > tomorrow
      ? [{ label: "This weekend", ymd: thisSat, right: WEEKDAYS[dowOf(thisSat)], icon: <CouchIcon /> }]
      : []),
    {
      label: "Next week",
      ymd: nextMon,
      right: `${WEEKDAYS[dowOf(nextMon)]} ${formatDayLabel(nextMon)}`,
      icon: <ArrowIcon />,
    },
    ...(valueYmd ? [{ label: "No date", ymd: null, right: "", icon: <NoDateIcon /> }] : []),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div>
        {quick.map((q) => (
          <button key={q.label} type="button" className={rowClass} onClick={() => onPick(q.ymd)}>
            {q.icon}
            <span>{q.label}</span>
            {q.right && <span className={rightClass}>{q.right}</span>}
          </button>
        ))}
      </div>
      <div className="border-t border-line pt-2">
        <MonthCalendar valueYmd={valueYmd} today={today} onPick={(ymd) => onPick(ymd)} />
      </div>
      <input
        type="text"
        autoFocus={autoFocus}
        className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
        placeholder={parseTime ? "e.g. next fri 9am" : "e.g. next fri"}
        // Parse on Enter/blur; a phrase we don't understand is ignored (the box
        // clears), never guessed.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (!v) return;
          if (parseTime) {
            // parseNaturalWhen defaults the day to today whenever a time is
            // present, so a truthy ymd covers both "5am today" and bare "5am".
            const { ymd, time } = parseNaturalWhen(v, today);
            if (ymd) onPick(ymd, time ?? undefined);
          } else {
            const ymd = parseNaturalDate(v, today);
            if (ymd) onPick(ymd);
          }
          e.target.value = "";
        }}
      />
    </div>
  );
}
