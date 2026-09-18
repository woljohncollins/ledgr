// Bespoke task canvas (Tasks redesign): a focused two-pane view for a task —
// left = parent breadcrumb + title + description + central subtasks; right rail
// = the task's fields (status/scheduled/due/priority), repeat, reminder/focus,
// and its relation fields (Project, Tags) + custom scalars. Composes the same
// proven panels the default canvas uses, just laid out as two panes. Registered
// for the `task` type via the canvas seam (ADR-041); falls back gracefully.
import Link from "next/link";
import MarkdownCanvas from "@/components/canvas/MarkdownCanvas";
import ItemEditor from "@/components/markdown-editor/ItemEditor";
import Subtasks from "@/components/subtasks/Subtasks";
import TaskTitle from "@/components/canvas/TaskTitle";
import RelationProperties from "@/components/relations/RelationProperties";
import PeopleRow from "@/components/relations/PeopleRow";
import CustomProperties from "@/components/build/CustomProperties";
import CanvasTwoPane from "@/components/canvas/CanvasTwoPane";
import SchedulePopover from "@/components/canvas/rail/SchedulePopover";
import DueRow from "@/components/canvas/rail/DueRow";
import PriorityRow from "@/components/canvas/rail/PriorityRow";
import StatusRow from "@/components/canvas/rail/StatusRow";
import { RAIL_ROW, RAIL_STATIC } from "@/components/canvas/rail/styles";
import FocusStar from "@/components/today/FocusStar";
import RelatedPanel from "@/components/relations/RelatedPanel";
import LinkedRow from "@/components/canvas/rail/LinkedRow";
import HistoryPanel from "@/components/canvas/HistoryPanel";
import ItemFilesSection from "@/components/attachments/ItemFilesSection";
import { listItemFilesWithRefs } from "@/lib/attachments";
import { getType } from "@/lib/types";
import { getItem } from "@/lib/items";
import { resolveStatusSchema } from "@/lib/status";
import { parseRecurrence } from "@/lib/recurrence";
import { appTodayYmd } from "@/lib/recurrence-service";
import { parseScheduledTime } from "@/lib/scheduled-time";
import { isFocusedOn } from "@/lib/focus";
import { isDuePinned } from "@/lib/date-anchor";
import { bodyMarkdown } from "@/lib/body";
import type { CanvasProps } from "@/lib/modules";

export default async function TaskCanvas(canvasProps: CanvasProps) {
  const { item, ownerId, arrange = false } = canvasProps;
  const typeDef = await getType("task").catch(() => null);
  // Per-type layout (ADR-069): a saved custom layout — or arrange mode
  // (?arrange=1) — renders the field-level draggable grid every other type gets
  // (the "Customize layout" path, which regressed when ADR-108 moved tasks onto
  // this bespoke rail). The bespoke rail renders in both the full page and the
  // modal — CanvasTwoPane splits on container width, stacking when narrow. Tasks
  // are collapse-only (resizable={false}), so no inner resizer clashes with the
  // modal's own.
  if (arrange || typeDef?.canvasLayout != null) {
    return <MarkdownCanvas {...canvasProps} />;
  }
  const propertySchema = typeDef?.propertySchema ?? [];
  const statuses = resolveStatusSchema(typeDef?.statusSchema ?? null);
  // Display mode (ADR-106): task seeds 'checkbox', so a missing typeDef falls
  // back to checkbox. 'select' keeps status in the field strip (the dropdown);
  // 'checkbox' renders a done-checkbox section instead; 'none' shows no status.
  const statusMode = typeDef?.statusMode ?? "checkbox";
  const statusDone = item.statusCategory === "done";
  const today = appTodayYmd();
  const props = (item.properties as Record<string, unknown>) ?? {};

  const recurrenceRule = parseRecurrence(props.recurrence);
  const reminderObj = props.reminder as Record<string, unknown> | undefined;
  const reminderMinutes =
    typeof reminderObj?.minutesBefore === "number" ? reminderObj.minutesBefore : null;
  const scheduledTime = parseScheduledTime(item.properties);

  const relationFields = propertySchema.filter((p) => p.kind === "relation");
  const scalarFields = propertySchema.filter((p) => p.kind !== "relation");
  // Project leads the rail (the Todoist order, Tyler 2026-08-18): the field that
  // says where the task LIVES reads before the ones that say when.
  const projectFields = relationFields.filter(
    (p) => p.key === "project" || p.targetType === "project"
  );
  const otherRelationFields = relationFields.filter((p) => !projectFields.includes(p));

  // Parent breadcrumb (a subtask points up to its parent task).
  const parent = item.parentId ? await getItem(ownerId, item.parentId).catch(() => null) : null;
  const itemFiles = await listItemFilesWithRefs(ownerId, item.id).catch(() => []);
  const parentLink =
    parent && !parent.deletedAt ? { href: `/items/${parent.id}`, title: parent.title || "Untitled" } : null;

  return (
    // No right padding at the split width (Tyler, 2026-08-18): the rail panel
    // runs to the container's right edge (the scrollbar in the modal). Stacked
    // mobile keeps px-4 on both sides.
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:pl-8 sm:pr-0 md:pl-10">
      {parentLink && (
        <Link
          href={parentLink.href}
          className="mb-2 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
        >
          ↑ <span className="max-w-[20rem] truncate">{parentLink.title}</span>
        </Link>
      )}

      {/* Two-pane: title/body/subtasks + a collapsible details rail. Shared with
          the event canvas (ADR-158); tasks opt out of drag-resize (the compact
          rail rarely needs widening) but keep collapse, remembering its own state
          under the "task" storage key. */}
      <CanvasTwoPane
        storageKey="task"
        resizable={false}
        // The tinted, visually separate properties panel (Tyler, 2026-08-18 —
        // "a completely separate column that stands out"). 248 wide: the rows
        // stack label-over-value, so narrower still reads, and the main pane
        // keeps the width.
        railPanel
        defaultWidth={248}
        main={
          <div className="min-w-0">
            <TaskTitle
              item={{ id: item.id, title: item.title, body: item.body }}
              done={statusDone}
              priority={item.urgency}
              showCircle={statusMode === "checkbox"}
            />
            <div className="mt-3">
              <ItemEditor
                item={{ id: item.id, title: item.title, body: item.body }}
                slot="body"
                collapsibleToolbar
                compactBody
              />
            </div>
            <div className="mt-4">
              <Subtasks
                ownerId={ownerId}
                itemId={item.id}
                parentScheduled={item.scheduledDate ?? null}
                bare
              />
            </div>
            {/* Linked here sits INSIDE the main pane (ADR-253) so it lines up with
                the title and body above it. It used to render below the two-pane
                split, where its own `max-w-3xl mx-auto` re-centered it against the
                full width — rail included — leaving it visibly shoved right and
                not even aligned with the footer beneath it. `bare` drops that
                inner column; the add affordance lives in the rail's Linked row. */}
            <div className="mt-6">
              <RelatedPanel
                ownerId={ownerId}
                itemId={item.id}
                claimPersons
                addBar={false}
                bare
              />
            </div>

          </div>
        }
        rail={
          // The task's details as a clean divided list of rows, in the owner's
          // order (Tyler, 2026-09-11): the two DATES lead, then how urgent, then
          // how it's labelled and who's involved, then where it lives and what
          // it's connected to. The heavy editors (time · repeat · reminder) stay
          // collapsed behind the Schedule row's popover (ADR-108).
          <div className="flex flex-col">
          {/* Status: the completion circle now lives next to the title in
              checkbox mode (TaskTitle), so the rail only carries a status row
              for multi-status 'select' types; 'none' shows nothing (ADR-106/108). */}
          {statusMode === "select" && (
            <div className={RAIL_ROW}>
              <StatusRow itemId={item.id} statuses={statuses} initial={item.status} />
            </div>
          )}

          {/* Schedule: the planned date, plus time / repeat / reminder inside. */}
          <div className={RAIL_ROW}>
            <SchedulePopover
              itemId={item.id}
              today={today}
              scheduled={item.scheduledDate?.toISOString() ?? null}
              due={item.dueDate?.toISOString() ?? null}
              recurrence={recurrenceRule}
              scheduledTime={scheduledTime}
              reminderMinutes={reminderMinutes}
              done={statusDone}
            />
          </div>

          {/* Due: its own row directly under Schedule, so the pair reads together
              (Tyler, 2026-09-11). ADR-253 had folded it into the popover above,
              which fixed "two dates for everything" by making the second date
              invisible — with no deadline set there was no affordance at all.
              The anchoring behavior is unchanged; only its home moved back. */}
          <div className={RAIL_ROW}>
            <DueRow
              itemId={item.id}
              scheduled={item.scheduledDate?.toISOString() ?? null}
              due={item.dueDate?.toISOString() ?? null}
              today={today}
              pinned={isDuePinned(props)}
              done={statusDone}
            />
          </div>

          <div className={RAIL_ROW}>
            <PriorityRow itemId={item.id} initial={item.urgency} />
          </div>

          {/* The remaining fields as self-labelled Todoist-style sections — no
              "Properties" group header (Tyler, 2026-08-18): each field names
              itself, so the umbrella heading only added a level. Tags/relations
              and People get the label-line-with-"+" shape (rail mode); scalar
              custom fields keep their stacked rows. People is a bespoke row, not
              a typed field (ADR-175): it shows every confirmed person edge
              whoever wrote it, so it always renders. */}
          {otherRelationFields.length > 0 && (
            <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
              <RelationProperties ownerId={ownerId} itemId={item.id} typeKey="task" props={otherRelationFields} rail />
            </div>
          )}
          <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
            <PeopleRow ownerId={ownerId} itemId={item.id} rail />
          </div>

          {/* Project: where the task lives. It led the rail under the Todoist
              order (2026-08-18); Tyler moved it below the dates and people
              (2026-09-11), so what you set most often reads first. */}
          {projectFields.length > 0 && (
            <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
              <RelationProperties ownerId={ownerId} itemId={item.id} typeKey="task" props={projectFields} rail />
            </div>
          )}

          {/* Files, directly above Linked (Tyler, 2026-09-11). Everything about
              the task lives in the rail; the body pane is the work. Rendered
              unconditionally but SELF-HIDING: the component returns null with
              zero files and stays mounted listening for upload events, so the
              section appears the moment the first file lands without a reload.
              Gating it on a server-side count here would cost exactly that. */}
          <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
            <ItemFilesSection itemId={item.id} initial={itemFiles} column={false} />
          </div>

          {/* Linked: the connected web, as a label + count + "+" beside its
              relation siblings above. The panel in the main pane lists the
              items; this row is where you ADD one. */}
          <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
            <LinkedRow ownerId={ownerId} itemId={item.id} />
          </div>

          {scalarFields.length > 0 && (
            <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
              <CustomProperties itemId={item.id} typeKey="task" schema={scalarFields} initial={props} hideHeading bare />
            </div>
          )}

          {/* Version History, in the rail directly under Linked (Tyler,
              2026-09-11). It's a disclosure like Linked is, and both are "what
              else is attached to this task" rather than part of the work, so
              they belong together in the details column rather than trailing
              the body. Files stay in the main pane — a file list needs the
              width, and it only renders when there ARE files. */}
          <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
            <HistoryPanel itemId={item.id} currentText={bodyMarkdown(item.body)} bare />
          </div>

          {/* Focus today: a one-tap star, kept in plain sight (not behind a
              popover) since it's a frequent daily action. */}
          <div className={`${RAIL_ROW} ${RAIL_STATIC}`}>
            <span className="flex items-center gap-2 text-sm text-ink">
              <FocusStar itemId={item.id} focused={isFocusedOn(item.properties, today)} today={today} />
              Focus today
            </span>
          </div>
          </div>
        }
      />

    </div>
  );
}
