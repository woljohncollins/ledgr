"use client";

// Tasks widget body (Project Type): the record's contained tasks as a first-class
// list. Each row uses the SAME completion circle as the task type (TaskCheckCircle
// — fills with the user's highlight color when done). Adding a task expands the
// shared AddTaskCard with this project pre-selected; since the destination is
// already this project, the destination picker is hidden (lockDestination), which
// leaves the Add / Cancel buttons the room they need (Tyler, 2026-07-01).
import { useEffect, useState } from "react";
import Link from "next/link";
import InlineAddTask from "@/components/tasks/InlineAddTask";
import AttachExistingButton from "@/components/canvas/widgets/AttachExistingButton";
import TaskCheckCircle from "@/components/tasks/TaskCheckCircle";
import MilestoneFlag from "@/components/milestones/MilestoneFlag";
import SubtaskExpandableRow from "@/components/subtasks/SubtaskExpandableRow";
import { onListRefreshFlush } from "@/lib/list-refresh";
import { groupTasks, type TaskGroupBy } from "@/lib/task-grouping";

type Row = {
  id: string;
  title: string;
  statusCategory: string;
  urgency: number | null;
  recurrence: string | null;
  // "n/m done" over the task's direct subtasks; null = no subtasks. Subtasks
  // ride along with their parent (Tyler, 2026-08-17): they don't clutter the
  // card as top-level rows, they fold out beneath it via the shared pill.
  subtasks: { done: number; total: number } | null;
  // The milestone this task completes (ADR-196); a subtle flag chip names it,
  // so it's clear which tasks go with a milestone (Tyler, 2026-08-17).
  milestone: { id: string; title: string } | null;
};

export default function TasksWidget({
  recordId,
  projectTitle,
  items,
  doneCount = 0,
  groupBy = "none",
}: {
  recordId: string;
  projectTitle: string;
  items: Row[];
  // How many of the record's tasks are done — they leave the card's rows, so
  // the card offers "N tasks completed" into the full list showing them.
  doneCount?: number;
  // Optional grouping (the card gear's "Group by"): sections under the
  // milestone each task completes, or under priority. "none" = the flat list.
  groupBy?: TaskGroupBy;
}) {
  // Optimistic done state, mirrored from each row's circle so the TITLE strikes
  // through the instant the circle fills. The server prop stays the source of
  // truth: overrides are dropped once a coalesced refresh flushes, by which point
  // the server tree carries the real statusCategory.
  const [doneOverride, setDoneOverride] = useState<Record<string, boolean>>({});
  useEffect(() => onListRefreshFlush(() => setDoneOverride({})), []);

  const groups = groupTasks(items, groupBy, (t) => t.milestone);

  function renderRow(t: Row) {
    const done = doneOverride[t.id] ?? t.statusCategory === "done";
    const inner = (
      <>
        <TaskCheckCircle
          itemId={t.id}
          done={done}
          priority={t.urgency}
          onOptimisticChange={(next) =>
            setDoneOverride((cur) => ({ ...cur, [t.id]: next }))
          }
        />
        <Link
          href={`/items/${t.id}`}
          className={`min-w-0 flex-1 truncate hover:text-neutral-200 ${done ? "text-neutral-500 line-through" : "text-neutral-200"}`}
        >
          {t.title || "Untitled"}
          {/* Recurrence reads inline, in the accent color, right in the
              flow of the task name (Tyler): "Water the plants Weekly on Mon". */}
          {t.recurrence && !done && (
            <span className="text-[var(--accent)]"> {t.recurrence}</span>
          )}
        </Link>
        {/* Grouped-by-milestone sections already NAME the milestone; the
            per-row flag would repeat it. */}
        {t.milestone && !done && groupBy !== "milestone" && (
          <MilestoneFlag id={t.milestone.id} title={t.milestone.title} />
        )}
      </>
    );
    // A task with subtasks gets the expandable "n/m" pill (same component
    // as the list surfaces); its subtasks fold out beneath it in place.
    if (t.subtasks && t.subtasks.total > 0) {
      return (
        <SubtaskExpandableRow
          key={t.id}
          id={t.id}
          done={t.subtasks.done}
          total={t.subtasks.total}
          liClassName="flex items-center gap-2.5 text-sm"
        >
          {inner}
        </SubtaskExpandableRow>
      );
    }
    return (
      <li key={t.id} className="flex items-center gap-2.5 text-sm">
        {inner}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {items.length === 0 && <p className="text-sm text-neutral-500">No tasks yet.</p>}
      {groups.map((g) => (
        <div key={g.key}>
          {g.label && (
            <p className="mb-1 mt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              {g.label}
            </p>
          )}
          <ul className="flex flex-col gap-1.5">{g.rows.map(renderRow)}</ul>
        </div>
      ))}
      {/* Done tasks leave the card (it previews what's left to do); their count
          stays reachable — "N tasks completed" opens the full list with the
          completed tail expanded (Tyler, 2026-08-17). */}
      {doneCount > 0 && (
        <Link
          href={`/items/${recordId}/collection/tasks?done=1`}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          {doneCount} task{doneCount === 1 ? "" : "s"} completed ›
        </Link>
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <InlineAddTask
          host={{ id: recordId, label: projectTitle || "This project", role: "project" }}
          lockDestination
        />
        <AttachExistingButton recordId={recordId} type="task" label="task" />
      </div>
    </div>
  );
}
