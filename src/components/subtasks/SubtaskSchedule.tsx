// A subtask's scheduled-date control (Tasks Polish S5, ADR-085). The user picks
// a date; if the parent has a scheduled date, Ledgr back-calculates a RELATIVE
// offset (N days from the parent) and stores it, so the subtask shifts whenever
// the parent moves or a recurring occurrence is materialized. With no parent
// date, the pick is just an absolute scheduled date.
//
// The picker is the standard Popover + DayPickerPanel (Tyler, 2026-08-19 —
// "the normal date pop up"; it was a bare date input before). The offset
// commit logic is unchanged: the panel picks the day, save() does the math.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { beginSave, endSave } from "@/lib/save-status";
import { describeOffset, offsetBetween } from "@/lib/relative-subtask";
import Popover from "@/components/ui/Popover";
import DayPickerPanel from "@/components/ui/DayPickerPanel";
import { reportDateShift } from "@/lib/date-shift-toast";

// Local-day fallback for the panel's quick rows (Today/Tomorrow/…): this
// control renders inside the canvas without the app-timezone plumbed through,
// and the browser's day is the right anchor for a control the owner is
// looking at.
function localTodayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const fmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC", // dates are UTC-midnight calendar days (ADR-008)
});

export default function SubtaskSchedule({
  id,
  scheduledIso,
  offsetDays,
  parentScheduledIso,
}: {
  id: string;
  scheduledIso: string | null;
  offsetDays: number | null;
  parentScheduledIso: string | null;
}) {
  const router = useRouter();
  const [sched, setSched] = useState(scheduledIso);
  const [offset, setOffset] = useState(offsetDays);
  const [busy, setBusy] = useState(false);

  const parentYmd = parentScheduledIso ? parentScheduledIso.slice(0, 10) : null;

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    beginSave();
    try {
      const res = await fetch(`/api/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      // A subtask can have subtasks; moving this one carries them (ADR-253).
      reportDateShift(await res.json(), () => router.refresh());
      router.refresh();
      return true;
    } catch {
      endSave(false);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(ymd: string, close?: () => void) {
    // With a parent date, store the back-calculated offset (relative); without,
    // a plain absolute date (clear any stale offset).
    const newOffset = parentYmd ? offsetBetween(parentYmd, ymd) : null;
    const ok = await patch({
      scheduledDate: `${ymd}T00:00:00.000Z`,
      propertyPatch: { relativeSchedule: parentYmd ? { offsetDays: newOffset } : null },
    });
    if (ok) {
      setSched(`${ymd}T00:00:00.000Z`);
      setOffset(newOffset);
      close?.();
    }
  }

  async function clear(close?: () => void) {
    const ok = await patch({ scheduledDate: null, propertyPatch: { relativeSchedule: null } });
    if (ok) {
      setSched(null);
      setOffset(null);
      close?.();
    }
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <Popover
        ariaLabel={sched ? "Change scheduled date" : "Schedule"}
        align="right"
        width={300}
        triggerClassName={
          sched
            ? "shrink-0 rounded px-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            : // Hover-reveal on desktop, always visible on phones (no hover on touch).
              "shrink-0 rounded px-1 text-xs text-neutral-600 opacity-0 transition-opacity hover:bg-neutral-800 hover:text-neutral-300 group-hover/row:opacity-100 max-sm:opacity-100"
        }
        trigger={
          sched ? (
            <span title={offset != null ? `${describeOffset(offset)} from the parent's date` : "Scheduled"}>
              {fmt.format(new Date(sched))}
              {offset != null && (
                <span className="ml-1 text-[var(--accent)]">{describeOffset(offset)}</span>
              )}
            </span>
          ) : (
            <span title={parentYmd ? "Schedule (relative to the parent's date)" : "Schedule"}>＋ when</span>
          )
        }
      >
        {(close) => (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Scheduled
              </span>
              {parentYmd && (
                <span className="text-xs text-ink-faint">follows the parent&rsquo;s date</span>
              )}
            </div>
            <DayPickerPanel
              valueYmd={sched ? sched.slice(0, 10) : null}
              today={localTodayYmd()}
              onPick={(ymd) => {
                if (busy) return;
                if (ymd) void save(ymd, close);
                else void clear(close);
              }}
            />
          </div>
        )}
      </Popover>
    </span>
  );
}
