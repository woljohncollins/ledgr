// The shared task list row (extracted from /tasks 2026-08-17; redesigned
// 2026-08-18, ADR-202). A stacked, Todoist-like row: title line (title,
// milestone flag, P-badge, status chip, click-to-edit date + repeat glyph),
// then a one-line body excerpt when the task has one, then a meta line — the
// expandable "n/m" subtask pill, the scrollable connections strip (tags,
// people, other records), and the project breadcrumb chip on the far right.
// Wrapped in the standard interaction layer — SwipeRow (right = complete,
// left = schedule) or, for a task with subtasks, the expandable pill row
// (ADR-142). Used by the Tasks tabs and by a record's full task list
// (/items/[id]/collection/tasks) so the two never drift. Server-renderable;
// the interactive bits are the client children it composes.
import Link from "next/link";
import SwipeRow from "@/components/lists/SwipeRow";
import MilestoneFlag from "@/components/milestones/MilestoneFlag";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import SubtaskCheckbox from "@/components/subtasks/SubtaskCheckbox";
import SubtaskExpandableRow, { SubtaskPillSlot } from "@/components/subtasks/SubtaskExpandableRow";
import ConnectionStrip from "@/components/tasks/ConnectionStrip";
import TaskDateEdit from "@/components/tasks/TaskDateEdit";
import { priorityStyle, type Priority } from "@/lib/priority";
import { parseRecurrence } from "@/lib/recurrence";
import { parseScheduledTime } from "@/lib/scheduled-time";
import type { Progress } from "@/lib/subtasks";
import type { StatusDef } from "@/lib/status";
import {
  emptyTaskRowMeta,
  PROJECT_ROLE,
  type RowConnection,
  type TaskRowMeta,
} from "@/lib/task-row-meta";

// Structural row shape — what queryViewItems rows carry, narrowed to what the
// row renders, so any list surface's rows fit without conversion.
export type TaskRowItem = {
  id: string;
  title: string;
  status: string;
  statusCategory: string;
  dueDate: Date | null;
  scheduledDate: Date | null;
  urgency: number | null;
  // jsonb properties ride along in list columns; the row only peeks at
  // `recurrence` to show the repeat glyph.
  properties?: unknown;
};

const dayFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

// The date that places a task: its effective plan date — scheduled (planned)
// day if set, else the due deadline (ADR-109); undated when neither is set.
export function effTaskDate(t: {
  scheduledDate: Date | null;
  dueDate: Date | null;
}): Date | null {
  return t.scheduledDate ?? t.dueDate ?? null;
}

// items-start (not center): the row is now up to three lines tall, and the
// checkboxes hang with the title line (the h-5 wrapper below). `relative`
// anchors the title link's stretched overlay, which makes the WHOLE row a
// click target (Tyler, 2026-08-18) — interactive bits raise above it with
// z-[1].
export const TASK_ROW_CLASS =
  "group relative flex items-start gap-2.5 rounded px-2 py-1 hover:bg-neutral-800/60";

export function TaskRow({
  task,
  dueToday,
  statuses,
  rollup,
  today,
  excerpt,
  connections,
  projectParent,
  showProject = true,
  milestone,
  defaultOpenSubtasks = false,
}: {
  task: TaskRowItem;
  dueToday: Date;
  statuses: StatusDef[];
  rollup?: Progress;
  today: string;
  // One plain-text body line (task-row-meta excerpts), shown under the title.
  excerpt?: string;
  // Every outgoing connection; the first project edge becomes the right-edge
  // chip, the rest render in the scrollable strip.
  connections?: RowConnection[];
  // The project chip's own home parent, for the "Parent / Project" breadcrumb.
  projectParent?: { id: string; title: string };
  // Project-scoped surfaces (the Projects tab's cards, a record's task list)
  // already say which project every row belongs to — they hide the chip.
  showProject?: boolean;
  // The milestone this task completes (record-context surfaces pass it via
  // milestoneFlagsFor); renders as a subtle flag chip after the title.
  milestone?: { id: string; title: string };
  // The Today fold (ADR-205): start this row's subtask tree expanded because a
  // subtask that would otherwise be its own row folded under it.
  defaultOpenSubtasks?: boolean;
}) {
  const done = task.statusCategory === "done";
  const sdef = statuses.find((s) => s.key === task.status);
  const date = effTaskDate(task);
  const overdue = !done && date != null && date < dueToday;
  const pri = task.urgency != null ? (task.urgency as Priority) : null;
  const props = task.properties as { recurrence?: unknown } | null | undefined;
  const recurrence = parseRecurrence(props?.recurrence);
  const scheduledTime = parseScheduledTime(task.properties);

  const all = connections ?? [];
  // The primary project is excluded from the strip even when the chip is hidden
  // (a project-scoped surface already names it); secondary project edges stay.
  const primaryProject =
    all.find((c) => c.role === PROJECT_ROLE && c.home) ??
    all.find((c) => c.role === PROJECT_ROLE);
  const project = showProject ? primaryProject : undefined;
  const strip = all.filter((c) => c !== primaryProject);

  const hasPill = rollup != null && rollup.total > 0;
  const hasMeta = hasPill || strip.length > 0 || project != null;
  const inner = (
    <>
        {/* h-5 matches the title line's text-sm line height, so the circles sit
            on the first line of a multi-line row. */}
        <span className="relative z-[1] flex h-5 shrink-0 items-center gap-2.5">
          <SelectCheckbox id={task.id} />
          {/* vanishRow: completing from a list optimistically fades the row out
              (these surfaces all drop done rows), so it doesn't linger until the
              coalesced refresh returns from the server. */}
          <SubtaskCheckbox
            id={task.id}
            done={done}
            vanishRow
            openSubtasks={rollup ? rollup.total - rollup.done : 0}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {/* The stretched overlay (after:inset-0) makes the whole row open
                the task; SwipeRow's sliding div (transformed) or the row <li>
                (relative) is its containing block. */}
            <Link
              href={`/items/${task.id}`}
              className={`min-w-0 flex-1 truncate text-sm after:absolute after:inset-0 after:content-[''] ${task.title ? "text-neutral-200" : "text-neutral-500"} ${done ? "line-through opacity-60" : ""}`}
            >
              {task.title || "Untitled"}
            </Link>
            {milestone && (
              <span className="relative z-[1] flex shrink-0">
                <MilestoneFlag id={milestone.id} title={milestone.title} />
              </span>
            )}
            {pri != null && pri <= 5 && (
              <span className={`shrink-0 rounded border px-1.5 text-xs ${priorityStyle(pri).text} ${priorityStyle(pri).border}`}>
                P{pri}
              </span>
            )}
            {sdef && sdef.category !== "not_started" && (
              <span className="hidden shrink-0 items-center gap-1 rounded bg-neutral-800 px-1.5 text-xs text-neutral-400 sm:inline-flex">
                {sdef.color && <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: sdef.color }} />}
                {sdef.label}
              </span>
            )}
            <span className="relative z-[1] flex shrink-0">
            <TaskDateEdit
              id={task.id}
              ymd={date ? date.toISOString().slice(0, 10) : null}
              label={date ? dayFmt.format(date) : null}
              field={task.scheduledDate ? "scheduledDate" : date ? "dueDate" : "scheduledDate"}
              overdue={overdue}
              today={today}
              scheduledIso={task.scheduledDate ? task.scheduledDate.toISOString() : null}
              dueIso={task.dueDate ? task.dueDate.toISOString() : null}
              recurrence={recurrence}
              scheduledTime={scheduledTime}
            />
            </span>
          </span>
          {/* Plain text, not a link — the row's stretched overlay opens the task. */}
          {excerpt && (
            <span className="mt-0.5 block truncate text-xs text-neutral-500">
              {excerpt}
            </span>
          )}
          {hasMeta && (
            <span className="mt-0.5 flex items-center gap-2">
              {hasPill && (
                <span className="relative z-[1] flex shrink-0">
                  <SubtaskPillSlot />
                </span>
              )}
              <ConnectionStrip items={strip} />
              {project && (
                // Accent so a project-homed task pops in the list (Tyler,
                // 2026-08-18); the parent breadcrumb stays muted.
                <Link
                  href={`/items/${project.id}`}
                  title={
                    projectParent
                      ? `${projectParent.title || "Untitled"} / ${project.title || "Untitled project"}`
                      : project.title || "Untitled project"
                  }
                  className="relative z-[1] ml-auto inline-flex max-w-[14rem] shrink-0 items-center text-xs"
                >
                  {projectParent && (
                    <>
                      <span className="max-w-[6rem] truncate text-neutral-500">{projectParent.title || "Untitled"}</span>
                      <span className="px-0.5 text-neutral-700">/</span>
                    </>
                  )}
                  <span className="truncate text-[var(--accent)] hover:underline">{project.title || "Untitled project"}</span>
                </Link>
              )}
            </span>
          )}
        </span>
      </>
    );

  // Trash + Complete/Focus/Schedule live in the shared row menu (right-click /
  // long-press), not an always-visible button; task rows also swipe (right =
  // complete, left = schedule). ADR-142, mirroring /list/[type].
  const menuOpts = {
    id: task.id,
    canComplete: true,
    done,
    today,
    label: task.title || "Untitled",
  };
  // A task with task-children gets the expandable pill — placed on the meta
  // line via the pill slot; everything else stays a plain stacked row with
  // swipe + menu.
  if (hasPill) {
    return (
      <SubtaskExpandableRow
        id={task.id}
        done={rollup!.done}
        total={rollup!.total}
        liClassName={TASK_ROW_CLASS}
        menuOptions={menuOpts}
        pillPlacement="slot"
        defaultOpen={defaultOpenSubtasks}
        today={today}
      >
        {inner}
      </SubtaskExpandableRow>
    );
  }
  return (
    <SwipeRow className={TASK_ROW_CLASS} {...menuOpts}>
      {inner}
    </SwipeRow>
  );
}

export default function TaskList({
  tasks,
  dueToday,
  statuses,
  rollups,
  today,
  meta,
  showProject = true,
  milestonesByTask,
  expandIds,
}: {
  tasks: TaskRowItem[];
  dueToday: Date;
  statuses: StatusDef[];
  rollups?: Map<string, Progress>;
  today: string;
  // The batched per-row extras (excerpt, connections, project breadcrumb) —
  // taskRowMeta(ownerId, ids), one set of queries per page, never per row.
  meta?: TaskRowMeta;
  showProject?: boolean;
  // taskId → the milestone it completes (milestoneFlagsFor); record-context
  // surfaces pass it, the global Tasks tabs leave it undefined.
  milestonesByTask?: Map<string, { id: string; title: string }>;
  // Rows whose subtask tree starts expanded (the Today fold's expandIds).
  expandIds?: Set<string>;
}) {
  const m = meta ?? emptyTaskRowMeta();
  return (
    <ul className="mt-1">
      {tasks.map((t) => {
        const connections = m.connections.get(t.id);
        const project = connections?.find((c) => c.role === PROJECT_ROLE && c.home) ?? connections?.find((c) => c.role === PROJECT_ROLE);
        return (
          <TaskRow
            key={t.id}
            task={t}
            dueToday={dueToday}
            statuses={statuses}
            rollup={rollups?.get(t.id)}
            today={today}
            excerpt={m.excerpts.get(t.id)}
            connections={connections}
            projectParent={project ? m.projectParents.get(project.id) : undefined}
            showProject={showProject}
            milestone={milestonesByTask?.get(t.id)}
            defaultOpenSubtasks={expandIds?.has(t.id) ?? false}
          />
        );
      })}
    </ul>
  );
}
