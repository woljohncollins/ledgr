// The rail's "Due" row (ADR-108; folded into Schedule by ADR-253, then restored
// as its own row on Tyler's call, 2026-09-11).
//
// The fold was an overcorrection. Tucking the deadline inside the Schedule
// popover fixed "two dates for everything" by making the second date INVISIBLE:
// a task with no deadline showed no deadline affordance at all, so there was
// nothing to discover and nothing to click. That breaks the rule that a control
// worth building is worth making legible. The deadline is a peer row again,
// sitting directly under Schedule where the two dates read as a pair.
//
// What it keeps from ADR-253 is the part that mattered: the deadline ANCHORS to
// the plan date (it moves when the plan moves, preserving the gap) unless it is
// pinned, and a deadline landing before the plan day is flagged with a one-click
// fix. All of that lives in DeadlineField, which this row opens.
"use client";

import Popover from "@/components/ui/Popover";
import DeadlineField from "./DeadlineField";
import { RowFace, TargetGlyph, PinGlyph } from "./row-ui";
import { RAIL_TRIGGER } from "./styles";
import { formatDayLabel, isOverdueYmd } from "@/lib/format-date";

export default function DueRow({
  itemId,
  scheduled,
  due,
  today,
  pinned = false,
  done = false,
}: {
  itemId: string;
  // The plan date this deadline hangs off — for the before-the-plan cue.
  scheduled: string | null;
  due: string | null; // ISO instant or null
  today: string;
  pinned?: boolean;
  // A completed task isn't "overdue" however old its due date — suppress the cue.
  done?: boolean;
}) {
  const label = formatDayLabel(due);
  // Two ways a deadline reads as wrong: already past, or sitting before the day
  // the work is planned for (the state that let stale due dates go unnoticed).
  const beforePlan =
    !!due && !!scheduled && due.slice(0, 10) < scheduled.slice(0, 10);
  const alert = !done && (isOverdueYmd(due, today) || beforePlan);

  return (
    <Popover
      ariaLabel="Due date"
      align="right"
      width={300}
      triggerClassName={RAIL_TRIGGER}
      trigger={
        <RowFace
          label="Due"
          empty={!due}
          overdue={alert}
          icon={
            <TargetGlyph
              className={alert ? "text-red-400" : !due ? "text-ink-faint" : "text-[var(--accent)]"}
            />
          }
        >
          {label ?? "Add date"}
          {/* Pinned deadlines stand still while the plan moves — worth saying on
              the resting row, since it changes what a later bump will do. */}
          {due && pinned && (
            <PinGlyph className="ml-1 inline h-3 w-3 shrink-0 text-ink-subtle" />
          )}
        </RowFace>
      }
    >
      <DeadlineField
        itemId={itemId}
        today={today}
        scheduled={scheduled}
        due={due}
        pinned={pinned}
      />
    </Popover>
  );
}
