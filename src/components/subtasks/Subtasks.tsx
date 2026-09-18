// Subtasks section (slice 7, PRD §3.5): the item's child tree under the
// editor. A task with children reads as a mini-project — checklist rows
// with done-toggles and an "n of m done" rollup on the header and on every
// nested parent. Non-task children (a note filed under a project) list and
// nest but stay out of the rollup. Server component; the query is body-free
// and owner-scoped (src/lib/subtasks.ts).
import Link from "next/link";
import { listSubtree, type SubtaskNode } from "@/lib/subtasks";
import CanvasSection from "@/components/canvas/CanvasSection";
import AddSubtask from "./AddSubtask";
import AddExistingSubtask from "./AddExistingSubtask";
import SubtaskCheckbox from "./SubtaskCheckbox";
import SubtaskSchedule from "./SubtaskSchedule";
import { deadlineDisplay } from "@/lib/format-date";
import { appTodayYmd } from "@/lib/recurrence-service";

// Due and scheduled dates are UTC-midnight calendar days (ADR-008); format in
// UTC so the shown day can't shift with the viewer's timezone.
const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function ProgressBadge({ done, total }: { done: number; total: number }) {
  return (
    <span className="shrink-0 text-xs text-neutral-500">
      {done}/{total} done
    </span>
  );
}

function SubtaskRow({
  node,
  parentScheduled,
  today,
}: {
  node: SubtaskNode;
  parentScheduled: Date | null;
  // App-timezone YMD, for the deadline's overdue cue (ADR-253).
  today: string;
}) {
  const done = node.type === "task" && node.statusCategory === "done";
  return (
    <li>
      <div className="group/row flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800/60">
        {node.type === "task" ? (
          <SubtaskCheckbox id={node.id} done={done} />
        ) : (
          <span className="w-4 shrink-0 text-center text-neutral-600">•</span>
        )}
        <Link
          href={`/items/${node.id}`}
          className={`min-w-0 flex-1 truncate text-sm ${
            node.title ? "text-neutral-200" : "text-neutral-500"
          } ${done ? "text-neutral-500 line-through" : ""}`}
        >
          {node.title || "Untitled"}
        </Link>
        {node.type !== "task" && (
          <span className="shrink-0 rounded bg-neutral-800 px-1.5 text-xs text-neutral-400">
            {node.type}
          </span>
        )}
        {node.progress && <ProgressBadge {...node.progress} />}
        {/* Scheduled date — interactive + relative-aware for task subtasks (S5);
            a plain label for non-task children. */}
        {node.type === "task" ? (
          <SubtaskSchedule
            id={node.id}
            scheduledIso={node.scheduledDate?.toISOString() ?? null}
            offsetDays={node.relativeOffset}
            parentScheduledIso={parentScheduled?.toISOString() ?? null}
          />
        ) : (
          node.scheduledDate && (
            <span className="shrink-0 text-xs text-neutral-500">
              scheduled {dateFmt.format(node.scheduledDate)}
            </span>
          )
        )}
        {/* The deadline shows only when it adds something (ADR-253): same day as
            the plan is redundant, before it or already past is an alert. */}
        {(() => {
          const dl = deadlineDisplay(
            node.dueDate?.toISOString() ?? null,
            node.scheduledDate?.toISOString() ?? null,
            today
          );
          if (!dl) return null;
          return (
            <span
              className={`shrink-0 text-xs ${dl.alert ? "text-red-400" : "text-neutral-500"}`}
            >
              due {dl.label}
            </span>
          );
        })()}
      </div>
      {node.children.length > 0 && (
        // A gentle nesting step (Tyler, 2026-08-14) — enough to read as nested,
        // not the deep ml-4/pl-3 stair the section used to take.
        <ul className="ml-2 border-l border-neutral-800 pl-2.5">

          {node.children.map((child) => (
            // A child's parent (for its relative offset) is THIS node.
            <SubtaskRow
              key={child.id}
              node={child}
              parentScheduled={node.scheduledDate}
              today={today}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function Subtasks({
  ownerId,
  itemId,
  parentScheduled = null,
  bare = false,
}: {
  ownerId: string;
  itemId: string;
  // The parent item's scheduled date — the anchor a relative subtask's offset
  // is measured from (S5, ADR-085). null when the parent isn't dated.
  parentScheduled?: Date | null;
  // Drop the CanvasSection frame: no "SUBTASKS" header, no section divider
  // rule, and none of the section wrapper's reading-column padding (Tyler,
  // 2026-08-14). The bespoke task canvas uses this so subtasks sit directly
  // under the description the way the rest of the pane reads; the stacked
  // default canvas (MarkdownCanvas) keeps the labeled section, where a header
  // earns its place among many sibling panels.
  bare?: boolean;
}) {
  const { children, progress } = await listSubtree(ownerId, itemId);
  const today = appTodayYmd();

  if (bare) {
    return (
      <div>
        {children.length > 0 && (
          <ul className="mb-0.5">
            {children.map((node) => (
              <SubtaskRow key={node.id} node={node} parentScheduled={parentScheduled} today={today} />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <AddSubtask parentId={itemId} />
          <AddExistingSubtask parentId={itemId} />
          {/* The rollup lived on the section header; with the header gone it
              rides the add row so the "n of m done" count isn't lost. */}
          {progress && (
            <span className="ml-auto pr-2">
              <ProgressBadge {...progress} />
            </span>
          )}
        </div>
      </div>
    );
  }

  // No children yet: a labeled section with both capture affordances, so the
  // feature is discoverable rather than a lone faint button.
  if (children.length === 0) {
    return (
      <CanvasSection icon="tasks" title="Subtasks">
        <div className="flex flex-wrap items-center gap-1">
          <AddSubtask parentId={itemId} />
          <AddExistingSubtask parentId={itemId} />
        </div>
      </CanvasSection>
    );
  }

  return (
    <CanvasSection
      icon="tasks"
      title="Subtasks"
      action={progress ? <ProgressBadge {...progress} /> : undefined}
    >
      <ul>
        {children.map((node) => (
          <SubtaskRow key={node.id} node={node} parentScheduled={parentScheduled} today={today} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1">
        <AddSubtask parentId={itemId} />
        <AddExistingSubtask parentId={itemId} />
      </div>
    </CanvasSection>
  );
}
