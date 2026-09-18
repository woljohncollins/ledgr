// Click-to-edit date on a task row (tasks-row-redesign, ADR-202 + the
// scheduler follow-on). The row's date text is a trigger for the shared
// Popover — portaled to <body> with fixed positioning, so it never clips
// against the row/list (the first cut used an in-flow absolute panel and the
// calendar vanished under the next row), and the panel scrolls internally when
// tall (Tyler). Inside: the Todoist-shaped DayPickerPanel (quick picks + month
// grid + free text) editing the field the row DISPLAYS — scheduled if set,
// else due ("edit what's shown") — plus Time and Repeat expanders reusing the
// canvas's ScheduledTimeControl / RecurrenceControl verbatim (bare mode), the
// SchedulePopover posture. A repeating task shows the loop glyph beside the
// date.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Popover from "@/components/ui/Popover";
import DayPickerPanel from "@/components/ui/DayPickerPanel";
import ScheduledTimeControl from "@/components/canvas/ScheduledTimeControl";
import RecurrenceControl from "@/components/canvas/RecurrenceControl";
import { showToast } from "@/components/ui/ActionToast";
import { reportDateShift } from "@/lib/date-shift-toast";
import { DEFAULT_DURATION_MINUTES, type ScheduledTime } from "@/lib/scheduled-time";
import type { RecurrenceRule } from "@/lib/recurrence";

function ymdToIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

function RepeatIcon({ className = "h-3.5 w-3.5 shrink-0" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function ClockIcon({ className = "h-4 w-4 shrink-0" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export default function TaskDateEdit({
  id,
  ymd,
  label,
  field,
  overdue,
  today,
  scheduledIso,
  dueIso,
  recurrence,
  scheduledTime,
  minimal = false,
  onCommitted,
}: {
  id: string;
  ymd: string | null; // the displayed date as YYYY-MM-DD, or null when undated
  label: string | null; // preformatted server-side ("Aug 18") so SSR and tabs agree
  field: "scheduledDate" | "dueDate"; // which column the click edits (what's shown)
  overdue: boolean;
  today: string; // app-timezone YYYY-MM-DD
  scheduledIso: string | null; // for the Repeat control's anchor
  dueIso: string | null;
  recurrence: RecurrenceRule | null;
  scheduledTime: ScheduledTime | null;
  // Date-only popover: no Time/Repeat expanders. For hosts whose data doesn't
  // carry the task's recurrence/time (the subtask tree rows read the subtree
  // endpoint) — offering those controls there would edit blind, and a "no
  // rule" RecurrenceControl on a task that HAS a rule could overwrite it.
  minimal?: boolean;
  // Fires after a successful date PATCH. Hosts whose display is CLIENT state
  // rather than server render (the subtask tree caches its fetched nodes) use
  // this to refetch — router.refresh() alone can't reach that state, which is
  // how "I clicked Today and nothing happened" looked (the write landed, the
  // stale tree just didn't say so).
  onCommitted?: () => void;
}) {
  const router = useRouter();
  const [showTime, setShowTime] = useState(false);
  const [showRepeat, setShowRepeat] = useState(false);

  // The date write is this component's own; Time and Repeat keep their controls'
  // own optimistic PATCH + refresh (the SchedulePopover posture).
  async function commit(next: string | null, time?: string, close?: () => void) {
    try {
      const body: Record<string, unknown> = { [field]: next ? ymdToIso(next) : null };
      if (time) {
        body.propertyPatch = {
          scheduledTime: {
            start: time,
            durationMinutes: scheduledTime?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
          },
        };
      }
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      close?.();
      // Anchoring (ADR-253) may have carried this task's subtasks along. The undo
      // re-runs onCommitted too, since the trees these rows live in are client
      // state router.refresh() can't reach.
      reportDateShift(await res.json(), () => {
        onCommitted?.();
        router.refresh();
      });
      onCommitted?.();
      router.refresh();
    } catch {
      showToast("Something went wrong");
    }
  }

  const footerBtn =
    "flex w-full items-center justify-center gap-2 rounded-card border border-line px-2 py-1.5 text-sm text-ink-muted hover:border-line-strong hover:bg-surface-2 hover:text-ink";

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      // Clicks inside the date UI must not reach the row's gesture layer.
      onClick={(e) => e.stopPropagation()}
    >
      {recurrence && (
        <span title="Repeats" className={overdue ? "text-red-400" : "text-neutral-500"}>
          <RepeatIcon />
        </span>
      )}
      <Popover
        ariaLabel={ymd ? `Change ${field === "dueDate" ? "due" : "scheduled"} date` : "Set date"}
        align="right"
        width={300}
        triggerClassName={`rounded px-1 text-xs hover:bg-neutral-800 ${
          ymd
            ? overdue
              ? "text-red-400"
              : "text-neutral-600 hover:text-neutral-300"
            : "text-neutral-600 opacity-0 hover:text-neutral-300 focus-visible:opacity-100 group-hover:opacity-100"
        }`}
        trigger={<>{label ?? "＋ date"}</>}
      >
        {(close) => (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {field === "dueDate" ? "Due date" : "Scheduled"}
              </span>
            </div>
            <DayPickerPanel
              valueYmd={ymd}
              today={today}
              parseTime={field === "scheduledDate"}
              onPick={(next, time) => void commit(next, time, close)}
            />
            {!minimal && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <button
                type="button"
                aria-expanded={showTime}
                className={footerBtn}
                onClick={() => setShowTime((v) => !v)}
              >
                <ClockIcon />
                Time
              </button>
              {showTime && (
                <div className="px-0.5 pb-1">
                  <ScheduledTimeControl
                    itemId={id}
                    initial={scheduledTime}
                    hasSchedule={scheduledIso != null || recurrence != null}
                  />
                </div>
              )}
              <button
                type="button"
                aria-expanded={showRepeat}
                className={footerBtn}
                onClick={() => setShowRepeat((v) => !v)}
              >
                <RepeatIcon className="h-4 w-4 shrink-0" />
                Repeat
              </button>
              {showRepeat && (
                <div className="px-0.5 pb-1">
                  <RecurrenceControl
                    itemId={id}
                    initial={recurrence}
                    scheduledDate={scheduledIso}
                    dueDate={dueIso}
                    today={today}
                    bare
                  />
                </div>
              )}
            </div>
            )}
          </div>
        )}
      </Popover>
    </span>
  );
}
