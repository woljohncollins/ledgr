// Fast per-task processing controls for the Inbox (Slice 1). Rendered on its own
// line under a task row's title so Brandon can schedule, prioritize, assign a
// project, and add people without opening the canvas — the common triage moves.
// Everything is optimistic → router.refresh(); it reuses the same endpoints the
// canvas and RowMenu use (PATCH /api/items/:id for date+priority, the relations
// route for project/people). Non-task rows never render this (see the Inbox page).
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import RelatePicker from "@/components/inbox/RelatePicker";
import DateInput from "@/components/ui/DateInput";
import { addDaysYmd } from "@/lib/recurrence";
import { priorityStyle, PRIORITIES, type Priority } from "@/lib/priority";

// --- inline SVG icons (matching AddTaskCard's set) ---
function I({ d, extra }: { d: string; extra?: React.ReactNode }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
      {extra}
    </svg>
  );
}
const IconCalendar = <I d="M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" extra={<><path d="M4 9h16" /><path d="M8 3v3M16 3v3" /></>} />;
const IconFlag = <I d="M5 21V4" extra={<path d="M5 4h12l-2 4 2 4H5" />} />;
const IconHash = <I d="M4 9h16M4 15h15M10 3L8 21M16 3l-2 18" />;
const IconUser = <I d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" extra={<circle cx="12" cy="8" r="4" />} />;

function ymdToIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

// A Date → app-local "Mon D" label, reading the stored UTC-midnight value.
function scheduleLabel(iso: Date | null, today: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  if (ymd === today) return "Today";
  if (ymd === addDaysYmd(today, 1)) return "Tomorrow";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function InboxTaskControls({
  id,
  today,
  scheduledDate,
  urgency,
  people = [],
  autoRefresh = true,
  onEdited,
}: {
  id: string;
  today: string;
  scheduledDate: Date | null;
  urgency: Priority | null;
  // Persons already connected to this task (any confirmed edge, ADR-175), so
  // the People chip shows who's attached instead of pretending nothing is.
  people?: { id: string; title: string }[];
  // The Inbox list refreshes the server render after an edit so the list stays
  // in sync (default). The triage deck sets this false: it owns a stable local
  // snapshot, so a refresh there would reshuffle the deck under the current
  // card — instead it updates optimistically and reports back via onEdited.
  autoRefresh?: boolean;
  onEdited?: (patch: { scheduledDate?: Date | null; urgency?: Priority | null }) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const dateWrapRef = useRef<HTMLSpanElement>(null);
  // Optimistic local values, used only when autoRefresh is off (deck mode) so
  // the chips update instantly without a server round-trip. The list path stays
  // purely prop-driven (its router.refresh re-renders with fresh props).
  const [localSched, setLocalSched] = useState<Date | null>(scheduledDate);
  const [localPrio, setLocalPrio] = useState<Priority | null>(urgency);
  const [localPeople, setLocalPeople] = useState(people);
  const dispSched = autoRefresh ? scheduledDate : localSched;
  const dispPrio = autoRefresh ? urgency : localPrio;
  const dispPeople = autoRefresh ? people : localPeople;

  useEffect(() => {
    if (!dateOpen) return;
    function onDown(e: MouseEvent) {
      if (!dateWrapRef.current?.contains(e.target as Node)) setDateOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dateOpen]);

  async function patch(body: Record<string, unknown>, optimistic?: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      setDateOpen(false);
      optimistic?.();
      if (autoRefresh) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const schedule = (ymd: string | null) => {
    const d = ymd ? new Date(ymdToIso(ymd)) : null;
    void patch({ scheduledDate: ymd ? ymdToIso(ymd) : null }, () => {
      setLocalSched(d);
      onEdited?.({ scheduledDate: d });
    });
  };

  const dateLabel = scheduleLabel(dispSched, today);
  const pStyle = dispPrio ? priorityStyle(dispPrio) : null;
  const chip =
    "inline-flex items-center gap-1 rounded-card border px-2 py-0.5 text-xs";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Schedule */}
      <span ref={dateWrapRef} className="relative">
        <button
          type="button"
          disabled={busy}
          onClick={() => setDateOpen((v) => !v)}
          className={`${chip} ${dateLabel ? "border-line-strong text-[var(--accent)]" : "border-line text-ink-muted hover:border-line-strong hover:text-ink"} disabled:opacity-50`}
        >
          {IconCalendar} {dateLabel ?? "Schedule"}
        </button>
        {dateOpen && (
          <div className="absolute left-0 top-full z-20 mt-1 flex w-52 flex-col rounded-card border border-line-strong bg-surface-3 p-1 shadow-xl shadow-black/50">
            <button type="button" onClick={() => schedule(today)} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">Today</button>
            <button type="button" onClick={() => schedule(addDaysYmd(today, 1))} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">Tomorrow</button>
            <button type="button" onClick={() => schedule(addDaysYmd(today, 7))} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">Next week</button>
            <label className="flex flex-wrap items-center gap-1 px-2 py-1 text-xs text-ink-subtle">
              Pick
              <DateInput
                value={dispSched ? dispSched.toISOString().slice(0, 10) : null}
                onCommit={schedule}
                ariaLabel="Scheduled date"
                className="rounded border border-line bg-surface-1 px-1 py-0.5 text-xs text-ink"
              />
            </label>
            {dateLabel && (
              <button type="button" onClick={() => schedule(null)} className="rounded px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">Clear date</button>
            )}
          </div>
        )}
      </span>

      {/* Priority */}
      <span className="relative inline-flex items-center">
        <select
          value={dispPrio ?? ""}
          disabled={busy}
          aria-label="Priority"
          onChange={(e) => {
            const p = (e.target.value ? Number(e.target.value) : null) as Priority | null;
            void patch({ urgency: p }, () => {
              setLocalPrio(p);
              onEdited?.({ urgency: p });
            });
          }}
          className={`inline-flex appearance-none items-center gap-1 rounded-card border py-0.5 pl-2 pr-6 text-xs ${pStyle ? `${pStyle.text} ${pStyle.border}` : "border-line text-ink-muted hover:border-line-strong hover:text-ink"} disabled:opacity-50`}
        >
          <option value="">Priority</option>
          {PRIORITIES.map((u) => <option key={u} value={u}>P{u}</option>)}
        </select>
        <span className={`pointer-events-none absolute right-1.5 ${pStyle ? pStyle.text : "text-ink-subtle"}`}>{IconFlag}</span>
      </span>

      {/* Project + People. The People chip names who's already connected (first
          names, any confirmed person edge — ADR-175) and stays a picker for
          adding more; removal lives on the canvas. */}
      <RelatePicker itemId={id} type="project" role="project" label="Project" icon={IconHash} autoRefresh={autoRefresh} />
      <RelatePicker
        itemId={id}
        type="person"
        label={
          dispPeople.length > 0
            ? dispPeople.map((p) => p.title.trim().split(/\s+/)[0] || "?").join(", ")
            : "People"
        }
        icon={IconUser}
        autoRefresh={autoRefresh}
        filled={dispPeople.length > 0}
        excludeIds={dispPeople.map((p) => p.id)}
        onRelated={(hit) => setLocalPeople((prev) => [...prev, hit])}
      />
    </div>
  );
}
