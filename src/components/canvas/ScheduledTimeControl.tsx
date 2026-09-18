// Per-task scheduled time-of-day (Stage A time-blocking,
// explorations/calendar-time-blocking.md). Adds an optional start time + block
// length on top of the task's scheduled CALENDAR DAY — written to
// properties.scheduledTime = { start, durationMinutes }, which the published ICS
// feed (ADR-079) turns into a real timed block on the subscribed calendar
// (instead of an all-day event). The day stays the zone-free anchor; this is the
// "when on that day" refinement. Floating local time, no zone.
//
// Optimistic + propertyPatch (the ReminderControl/FieldStrip pattern), so it
// never clobbers the task's other properties. Clearing the start removes the
// block and the task reverts to all-day.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { beginSave, endSave } from "@/lib/save-status";
import {
  DEFAULT_DURATION_MINUTES,
  formatRange,
  type ScheduledTime,
} from "@/lib/scheduled-time";

const DURATIONS: { value: number; label: string }[] = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 45, label: "45 min" },
  { value: 60, label: "1 hr" },
  { value: 90, label: "1.5 hr" },
  { value: 120, label: "2 hr" },
  { value: 180, label: "3 hr" },
  { value: 240, label: "4 hr" },
];

const controlClass =
  "rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

export default function ScheduledTimeControl({
  itemId,
  initial,
  hasSchedule,
}: {
  itemId: string;
  initial: ScheduledTime | null;
  // Whether the task has a scheduled day (a date column or a recurrence anchor).
  // A time only means something on a day, so we gate the inputs on it.
  hasSchedule: boolean;
}) {
  const router = useRouter();
  const [start, setStart] = useState(initial?.start ?? "");
  const [duration, setDuration] = useState(initial?.durationMinutes ?? DEFAULT_DURATION_MINUTES);
  const [error, setError] = useState(false);

  // Re-adopt the server value when it actually changes (compared by value, since
  // `initial` is a fresh object each render) — so a time set elsewhere, e.g. the
  // Schedule date box parsing "5am today", shows here after router.refresh
  // without a remount. Same adjust-during-render pattern as SchedulePopover.
  const initKey = initial ? `${initial.start}|${initial.durationMinutes}` : "";
  const [prevKey, setPrevKey] = useState(initKey);
  if (initKey !== prevKey) {
    setPrevKey(initKey);
    setStart(initial?.start ?? "");
    setDuration(initial?.durationMinutes ?? DEFAULT_DURATION_MINUTES);
  }

  // Write the merged block (or null to clear), reverting on failure.
  async function save(next: ScheduledTime | null) {
    const prev = { start, duration };
    setStart(next?.start ?? "");
    if (next) setDuration(next.durationMinutes);
    setError(false);
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyPatch: { scheduledTime: next } }),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      router.refresh();
    } catch {
      setStart(prev.start);
      setDuration(prev.duration);
      setError(true);
      endSave(false);
    }
  }

  function changeStart(value: string) {
    if (!value) return void save(null); // cleared → all-day again
    void save({ start: value, durationMinutes: duration });
  }

  function changeDuration(value: number) {
    if (!start) return; // no start, nothing to attach a duration to
    void save({ start, durationMinutes: value });
  }

  if (!hasSchedule) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-neutral-600">
        <span className="text-neutral-500">Time</span>
        Set a scheduled date to add a time
      </span>
    );
  }

  return (
    <label className="flex items-center gap-1.5 text-xs text-neutral-500">
      <span
        className="cursor-help underline decoration-dotted decoration-neutral-600 underline-offset-2"
        title="A start time + length turns this into a timed block on your subscribed calendar (instead of an all-day reminder). Local time."
      >
        Time
      </span>
      <input
        type="time"
        className={controlClass}
        value={start}
        onChange={(e) => changeStart(e.target.value)}
      />
      {start && (
        <>
          <span className="text-neutral-600">for</span>
          <select
            className={controlClass}
            value={duration}
            onChange={(e) => changeDuration(Number(e.target.value))}
          >
            {DURATIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          {/* The start/end framing Brandon asked for, derived from start + length. */}
          <span className="text-neutral-600">{formatRange({ start, durationMinutes: duration })}</span>
        </>
      )}
      {error && <span className="text-red-400">Save failed</span>}
    </label>
  );
}
