// The rail's "Schedule" row (ADR-108): collapses scheduled date, time-of-day,
// repeat, and reminder into one row that opens a single popover holding all of
// them — the Todoist "Date" popover shape (date + time + repeat tucked inside),
// adapted to Ledgr. The resting row summarizes the lot ("Thu, Jun 25 · 8:18 PM ·
// ↻ Daily"). The popover reuses the proven RecurrenceControl / ScheduledTime /
// Reminder controls verbatim (bare mode) — this only relocates them, it doesn't
// reimplement them. The date itself is optimistic here; the sub-controls keep
// their own optimistic + router.refresh writes (which re-feed this row's props).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { beginSave, endSave } from "@/lib/save-status";
import Popover from "@/components/ui/Popover";
import DayField from "./DayField";
import { RowFace, CalendarGlyph } from "./row-ui";
import { RAIL_TRIGGER } from "./styles";
import RecurrenceControl from "@/components/canvas/RecurrenceControl";
import RecurrenceCalendar from "@/components/canvas/RecurrenceCalendar";
import ScheduledTimeControl from "@/components/canvas/ScheduledTimeControl";
import ReminderControl from "@/components/canvas/ReminderControl";
import { formatDayLabel, isOverdueYmd } from "@/lib/format-date";
import { reportDateShift } from "@/lib/date-shift-toast";
import {
  DEFAULT_DURATION_MINUTES,
  formatTime12,
  type ScheduledTime,
} from "@/lib/scheduled-time";
import { describeRule, type RecurrenceRule } from "@/lib/recurrence";

function ymdToIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

// Matches the standardized CanvasSection header text (the canvas redesign) so a
// popover's labels read consistently with the page's section headers — minus the
// card chrome, which doesn't belong inside a floating popover (Brandon, 2026-06-27).
const sectionLabel =
  "mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cs-label)]";

export default function SchedulePopover({
  itemId,
  today,
  scheduled,
  due,
  recurrence,
  scheduledTime,
  reminderMinutes,
  done = false,
}: {
  itemId: string;
  today: string;
  scheduled: string | null; // ISO instant or null
  due: string | null; // ISO instant or null — the recurrence anchor fallback only;
  // the deadline itself is edited in the rail's own Due row (DueRow).
  recurrence: RecurrenceRule | null;
  scheduledTime: ScheduledTime | null;
  reminderMinutes: number | null;
  // A completed task isn't "overdue" however old its scheduled date — suppress it.
  done?: boolean;
}) {
  const router = useRouter();
  const [iso, setIso] = useState(scheduled);
  // Re-adopt the server value after a refresh (adjust-during-render, like
  // SubtaskCheckbox) so enabling a repeat — which seeds scheduled_date server
  // side — reflects here without a remount.
  const [prev, setPrev] = useState(scheduled);
  if (scheduled !== prev) {
    setPrev(scheduled);
    setIso(scheduled);
  }

  // The free-text box may hand back a time too ("5am today"); when it does we set
  // the day and the scheduledTime block in one PATCH (keeping any existing
  // duration). router.refresh re-feeds scheduledTime, so the Time control and
  // summary pick it up.
  async function pickDate(ymd: string | null, time?: string) {
    const before = iso;
    const next = ymd ? ymdToIso(ymd) : null;
    setIso(next);
    beginSave();
    try {
      const body: Record<string, unknown> = { scheduledDate: next };
      if (time) {
        body.propertyPatch = {
          scheduledTime: {
            start: time,
            durationMinutes: scheduledTime?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
          },
        };
      }
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      // Moving the plan date carried the subtask tree (ADR-253); say so, with a
      // way back.
      reportDateShift(await res.json(), () => router.refresh());
      router.refresh();
    } catch {
      setIso(before);
      endSave(false);
    }
  }

  const hasSchedule = iso != null || recurrence != null;
  const day = formatDayLabel(iso, { weekday: true });
  const repeat = recurrence ? describeRule(recurrence) : null;
  const summary: string[] = [];
  if (day) summary.push(day);
  if (scheduledTime) summary.push(formatTime12(scheduledTime.start));
  const empty = !day && !repeat;
  const overdue = !done && isOverdueYmd(iso, today);

  return (
    <Popover
      ariaLabel="Schedule"
      align="right"
      width={344}
      triggerClassName={RAIL_TRIGGER}
      trigger={
        <RowFace
          label="Schedule"
          empty={empty}
          overdue={overdue}
          icon={<CalendarGlyph className={overdue ? "text-red-400" : empty ? "text-ink-faint" : "text-[var(--accent)]"} />}
        >
          {empty ? (
            "Add date"
          ) : (
            <>
              {summary.join(" · ")}
              {repeat && (
                <span className="text-neutral-400">
                  {summary.length ? " · " : ""}↻ {repeat}
                </span>
              )}
            </>
          )}
        </RowFace>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <div className={sectionLabel}>Date</div>
          <DayField
            valueYmd={iso ? iso.slice(0, 10) : null}
            today={today}
            onPick={pickDate}
            parseTime
          />
        </div>
        <div className="border-t border-neutral-800 pt-3">
          <div className={sectionLabel}>Time</div>
          <ScheduledTimeControl
            itemId={itemId}
            initial={scheduledTime}
            hasSchedule={hasSchedule}
          />
        </div>
        {/* Reminder sits above Repeat: it's a far more frequent setting than
            recurrence on a typical task (Brandon, 2026-06-24). */}
        <div className="border-t border-neutral-800 pt-3">
          <div className={sectionLabel}>Reminder</div>
          <ReminderControl
            itemId={itemId}
            initialMinutes={reminderMinutes}
            hasTime={scheduledTime != null}
          />
        </div>
        <div className="border-t border-neutral-800 pt-3">
          <div className={sectionLabel}>Repeat</div>
          <RecurrenceControl
            itemId={itemId}
            initial={recurrence}
            scheduledDate={iso}
            dueDate={due}
            today={today}
            bare
          />
        </div>
        {recurrence && recurrence.occurrenceMode === "virtual" && (
          <RecurrenceCalendar
            itemId={itemId}
            initial={recurrence}
            today={today}
            bare
          />
        )}
      </div>
    </Popover>
  );
}
