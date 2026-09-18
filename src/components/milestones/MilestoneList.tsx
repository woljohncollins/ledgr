"use client";

// The milestone row list, shared by the Milestones tool (card) and the full
// collection page (2026-08-17: "copy the rules we have on the tool to the full
// page"). A milestone's MODE falls out of what it carries (ADR-196):
//
//   - task-linked ("Completes with task"): the row's circle acts on the TASK —
//     one gesture completes both, reopening the task reopens the milestone. A
//     date on it is a target, never a trigger.
//   - dated, no task: date-driven, the original PRD §6 "arrives whether you
//     act or not". NO circle; upcoming/passed derive from the date.
//   - undated, no task: a manual work milestone with a checkbox circle.
//
// Dates are optional; an undated milestone just shows no date. A milestone
// carrying an explicit `points` percent shows it as a chip — its share of the
// project bar. `selectable` adds the ADR-118 SelectCheckbox at the leading
// edge (the collection page wraps this in a SelectionProvider); the card leaves
// it off, like every widget preview.
import { useEffect, useState } from "react";
import Link from "next/link";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import TaskCheckCircle from "@/components/tasks/TaskCheckCircle";
import { onListRefreshFlush } from "@/lib/list-refresh";

export type MilestoneRow = {
  id: string;
  title: string;
  dueDate: string | null;
  mode: "task" | "date" | "manual";
  done: boolean;
  via: "manual" | "task" | "date" | null;
  taskId: string | null;
  taskTitle: string | null;
  taskDone: boolean;
  pct: number;
};

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function MilestoneList({
  items,
  selectable = false,
}: {
  items: MilestoneRow[];
  selectable?: boolean;
}) {
  // Optimistic done state mirrored from the circle (same pattern as TasksWidget)
  // so the row styles the instant it's checked; the coalesced refresh re-syncs.
  const [doneOverride, setDoneOverride] = useState<Record<string, boolean>>({});
  useEffect(() => onListRefreshFlush(() => setDoneOverride({})), []);

  // Open milestones first, then done; within each, by date ascending, undated
  // last (Tyler, 2026-07-01 order, done-sink added with completability).
  const sorted = [...items].sort((a, b) => {
    const ad = a.done ? 1 : 0;
    const bd = b.done ? 1 : 0;
    if (ad !== bd) return ad - bd;
    if (!a.dueDate) return b.dueDate ? 1 : 0;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });

  return (
    <ul className="flex flex-col gap-1.5 empty:hidden">
      {sorted.map((m) => {
        const done = doneOverride[m.id] ?? m.done;
        // "passed" = date-derived (it arrived); a checked-off or
        // task-completed milestone reads "done"; otherwise upcoming/open.
        const badge = done
          ? m.via === "date" && doneOverride[m.id] === undefined
            ? { text: "passed", cls: "bg-neutral-800 text-neutral-500" }
            : { text: "done", cls: "bg-emerald-950/50 text-emerald-300" }
          : { text: m.dueDate ? "upcoming" : "open", cls: "bg-amber-950/50 text-amber-300" };
        return (
          <li key={m.id} className="flex items-center gap-2 text-sm">
            {selectable && <SelectCheckbox id={m.id} />}
            {/* The circle's target depends on mode: a task-linked milestone's
                circle completes the TASK; a manual one completes itself; a
                date-driven one has no circle (the date decides). A DONE
                milestone shows no circle at all (Tyler, 2026-08-17 — the
                badge + strikethrough say it; un-doing happens from the item
                or the task). */}
            {done ? null : m.mode === "task" && m.taskId ? (
              <TaskCheckCircle
                itemId={m.taskId}
                done={doneOverride[m.id] ?? m.taskDone}
                onOptimisticChange={(next) =>
                  setDoneOverride((cur) => ({ ...cur, [m.id]: next }))
                }
              />
            ) : m.mode === "manual" ? (
              <TaskCheckCircle
                itemId={m.id}
                done={doneOverride[m.id] ?? m.via === "manual"}
                onOptimisticChange={(next) =>
                  setDoneOverride((cur) => ({ ...cur, [m.id]: next }))
                }
              />
            ) : null}
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badge.cls}`}
              title={m.taskTitle ? `Completes with task: ${m.taskTitle}` : undefined}
            >
              {badge.text}
            </span>
            <Link
              href={`/items/${m.id}`}
              className={`min-w-0 flex-1 truncate hover:text-neutral-100 ${done ? "text-neutral-500 line-through" : "text-neutral-200"}`}
            >
              {m.title || "Untitled"}
              {m.taskTitle && !done && (
                <span className="text-xs text-neutral-500"> ↳ {m.taskTitle}</span>
              )}
            </Link>
            {m.pct > 0 && (
              <span
                className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                title={`Worth ${m.pct}% of the project`}
              >
                {m.pct}%
              </span>
            )}
            {m.dueDate && (
              <span className="shrink-0 text-xs text-neutral-500">{dayLabel(m.dueDate)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
