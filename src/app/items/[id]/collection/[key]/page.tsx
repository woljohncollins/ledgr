// The collection drill-down page (Tyler, 2026-07-01): a record's widget card
// (Tasks / Docs / Meetings / Milestones / Links / Related Records) shows only a
// capped preview; clicking "Showing N of M →" lands here, which lists EVERY item
// of that collection associated with the record as a clickable list. This keeps
// the record homepage glanceable while nothing is buried. The query is exactly
// the one the card previews (record-widgets.ts boundFilter), just uncapped, so
// the two never diverge. Multi-select + bulk actions per the standard (ADR-118).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import BulkActionBar from "@/components/selection/BulkActionBar";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import SelectionProvider from "@/components/selection/SelectionProvider";
import SelectModeToggle from "@/components/selection/SelectModeToggle";
import RowAction from "@/components/home/RowAction";
import InlineAddTask from "@/components/tasks/InlineAddTask";
import AddContainedItemButton from "@/components/canvas/widgets/AddContainedItemButton";
import InlineContainAdd from "@/components/canvas/widgets/InlineContainAdd";
import LinkList, { type LinkRow } from "@/components/links/LinkList";
import MeetingList, { type MeetingRow } from "@/components/meetings/MeetingList";
import MindmapList, { type MindmapRow } from "@/components/mindmaps/MindmapList";
import NoteList, { type NoteRow } from "@/components/notes/NoteList";
import MilestoneList, { type MilestoneRow } from "@/components/milestones/MilestoneList";
import TaskList from "@/components/tasks/TaskListRow";
import { taskRowMeta } from "@/lib/task-row-meta";
import { bulkConfigForType } from "@/lib/bulk-config";
import { milestoneStates } from "@/lib/milestones";
import { getItem } from "@/lib/items";
import { resolveOwner } from "@/lib/owner";
import { appTodayYmd } from "@/lib/recurrence-service";
import { resolveStatusSchema } from "@/lib/status";
import { childRollups } from "@/lib/subtasks";
import { getAppTimezone, todayBounds } from "@/lib/today";
import { getType } from "@/lib/types";
import { boundFilter, milestoneFlagsFor, sortTasksDoneLast } from "@/lib/record-widgets";
import { customToolTypeKey, widgetById } from "@/lib/widgets";
import { resolveComposition, widgetTitle } from "@/lib/composition";
import { groupTasks, parseTaskGroupBy, type TaskGroupBy } from "@/lib/task-grouping";
import { countViewItems, queryViewItems, VIEW_MAX, type ViewSort } from "@/lib/views";

export const dynamic = "force-dynamic";

// The Notes collection reads as "Docs" on a record (matches the card title).
const COLLECTION_TITLE: Record<string, string> = { notes: "Docs" };

const CATEGORY_DOT: Record<string, string> = {
  not_started: "bg-neutral-500",
  in_progress: "bg-amber-500",
  done: "bg-green-500",
  archived: "bg-neutral-700",
};

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; key: string }>;
}): Promise<Metadata> {
  const { id, key } = await params;
  try {
    const owner = await resolveOwner();
    if (!owner) return {};
    const [record, def] = [await getItem(owner.id, id), widgetById(key)];
    const collection = def ? COLLECTION_TITLE[def.id] ?? def.label : "Items";
    return { title: `${collection} · ${record.title || "Untitled"}` };
  } catch {
    return {};
  }
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, key } = await params;
  const sp = await searchParams;
  const owner = await resolveOwner();
  if (!owner) notFound();

  const def = widgetById(key);
  // Only collection/related widgets have a drill-down; property/derived don't.
  const collectionType = def?.recordQuery?.collectionType ?? null;
  const isRelated = def?.id === "relatedRecords";
  if (!def || (!collectionType && !isRelated)) notFound();

  let record;
  try {
    record = await getItem(owner.id, id);
  } catch {
    notFound();
  }

  const baseFilter = boundFilter(def, id);
  if (!baseFilter) notFound();

  // Task collections tuck their completed tail behind an "N tasks completed"
  // line at the bottom (Tyler, 2026-08-17: "have a '3 Tasks Completed' and the
  // user can click that to see them"). Hidden is the DEFAULT; ?done=1 shows
  // them. Hiding narrows the QUERY (statusCategory: "active"), not just the
  // render, so the count and the "showing first N" window stay honest.
  const showDone = sp.done === "1";
  const hideDone = collectionType === "task" && !showDone;
  const filter = hideDone ? { ...baseFilter, statusCategory: "active" } : baseFilter;

  const sort: ViewSort =
    collectionType === "event"
      ? { field: "meetingAt", dir: "asc" }
      : collectionType === "milestone"
        ? { field: "dueDate", dir: "asc" }
        : { field: "updatedAt", dir: "desc" };

  const [rowsRaw, total] = await Promise.all([
    queryViewItems(owner.id, filter, sort, VIEW_MAX),
    countViewItems(owner.id, filter),
  ]);
  // Tasks: done always sinks to the bottom (same rule as the card preview).
  const rows = collectionType === "task" ? sortTasksDoneLast(rowsRaw) : rowsRaw;

  // A custom-type tool's synthetic def carries a placeholder label; the type's
  // real label wins (same dressing the record fan-out applies).
  // Typed collection → that type's bulk actions; mixed Related Records → the
  // generic Move + Delete only (bulkConfigForType(null)).
  const typeDef = collectionType ? await getType(collectionType).catch(() => null) : null;
  const bulkConfig = typeDef ? bulkConfigForType(typeDef) : {};
  const isCustomTool = customToolTypeKey(def.id) !== null;
  // The record's composition instance for this card: a per-record rename
  // (options.title, the card gear's Rename — 2026-08-19) retitles this full
  // page too, so the card and its drill-down never disagree. The same instance
  // carries the Tasks card's groupBy (read below), which is why this resolution
  // is hoisted from the old task-only block.
  const recordTypeDef = await getType(record.type).catch(() => null);
  const { composition } = resolveComposition(
    record.composition,
    recordTypeDef?.defaultWidgets,
    record.type
  );
  const inst =
    composition.widgets.find((w) => w.defId === def.id && !w.hidden) ??
    composition.widgets.find((w) => w.defId === def.id);
  const label =
    (inst ? widgetTitle(inst) : null) ??
    COLLECTION_TITLE[def.id] ??
    (isCustomTool ? typeDef?.label ?? def.label : def.label);

  // A task collection renders the SAME rows as the Tasks tabs (TaskListRow,
  // 2026-08-17): completable in place (SubtaskCheckbox), swipe + row menu, tag
  // chips, and the expandable "n/m" pill that folds a task's subtasks out
  // beneath it — the subtasks ride along with their parent rather than
  // cluttering the top level. Two extra batched queries, same as /tasks.
  const isTaskList = collectionType === "task";
  const [taskRollups, taskMeta, tz, doneCount, milestoneFlags] = await Promise.all([
    isTaskList ? childRollups(owner.id, rows.map((r) => r.id)) : undefined,
    isTaskList ? taskRowMeta(owner.id, rows.map((r) => r.id)) : undefined,
    isTaskList ? getAppTimezone(owner.id) : undefined,
    // The completed tail's size, for the "N tasks completed" line at the bottom.
    isTaskList
      ? countViewItems(owner.id, { ...baseFilter, statusCategory: "done" })
      : 0,
    // taskId → the milestone it completes, for the subtle flag chip on rows.
    isTaskList ? milestoneFlagsFor(owner.id, id) : undefined,
  ]);
  const taskStatuses = isTaskList ? resolveStatusSchema(typeDef?.statusSchema ?? null) : [];
  const { dueToday } = isTaskList && tz ? todayBounds(new Date(), tz) : { dueToday: new Date() };
  const todayYmd = isTaskList && tz ? appTodayYmd(new Date(), tz) : "";

  // The full list honors the Tasks card's "Group by" (options.groupBy on the
  // record's tasks widget instance, set from the card's hover gear) — the card
  // and its full page group the same way.
  const taskGroupBy: TaskGroupBy = isTaskList
    ? parseTaskGroupBy(inst?.options?.groupBy)
    : "none";
  const taskGroups = isTaskList
    ? groupTasks(rows, taskGroupBy, (r) => milestoneFlags?.get(r.id))
    : [];

  // Milestone and meeting collections render the SAME rows as their cards
  // (Tyler, 2026-08-17: "copy the rules we have on the tool to the full page"):
  // the shared MilestoneList (mode-dependent circles, badges, points chips,
  // done-sink sort) and MeetingList (tz-aware date labels), plus the tool's
  // "+ Milestone" / "+ Meeting" add box — with selection on top (ADR-118).
  const isMilestoneList = collectionType === "milestone";
  const isMeetingList = collectionType === "event";
  let milestoneRows: MilestoneRow[] = [];
  if (isMilestoneList) {
    // Same state resolution + row mapping as the card's fan-out (WidgetCanvas).
    const states = await milestoneStates(owner.id, rows);
    milestoneRows = rows.map((m) => {
      const s = states.get(m.id);
      return {
        id: m.id,
        title: m.title,
        dueDate: m.dueDate ? m.dueDate.toISOString() : null,
        mode: s?.mode ?? (m.dueDate ? ("date" as const) : ("manual" as const)),
        done: s?.done ?? m.statusCategory === "done",
        via: s?.via ?? (m.statusCategory === "done" ? ("manual" as const) : null),
        taskId: s?.task?.id ?? null,
        taskTitle: s?.task?.title ?? null,
        taskDone: s?.task?.done ?? false,
        pct: s?.pct ?? 0,
      };
    });
  }
  const meetingRows: MeetingRow[] = isMeetingList
    ? rows.map((m) => ({
        id: m.id,
        title: m.title,
        when: (m.meetingAt ?? m.scheduledDate ?? m.dueDate)?.toISOString() ?? null,
      }))
    : [];
  const isNoteList = collectionType === "note";
  const isLinkList = collectionType === "link";
  const isMindmapList = collectionType === "mindmap";
  const noteRows: NoteRow[] = isNoteList ? rows.map((n) => ({ id: n.id, title: n.title })) : [];
  const linkRows: LinkRow[] = isLinkList
    ? rows.map((l) => ({ id: l.id, title: l.title, url: l.url ?? null }))
    : [];
  const mindmapRows: MindmapRow[] = isMindmapList
    ? rows.map((m) => ({ id: m.id, title: m.title }))
    : [];
  // Every typed collection with a card now renders the card's own rows + add
  // affordance; only the mixed Related Records (and people) keep the generic list.
  const upgraded =
    isTaskList || isMilestoneList || isMeetingList || isNoteList || isLinkList || isMindmapList;

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-2 pb-24 pt-4 sm:px-8 md:px-12">
        <nav className="mb-1 text-xs text-neutral-500">
          <Link href={`/items/${id}`} className="hover:text-neutral-300">
            {record.title || "Untitled"}
          </Link>
          <span className="px-1.5 text-neutral-700">/</span>
          <span className="text-neutral-400">{label}</span>
        </nav>
        <h1 className="mb-4 text-lg font-medium text-neutral-100">
          {label}
          <span className="ml-2 text-sm font-normal text-neutral-500">{total}</span>
        </h1>

        {rows.length === 0 && !upgraded ? (
          <p className="mt-6 px-2 text-sm text-neutral-600">Nothing here yet.</p>
        ) : upgraded ? (
          <SelectionProvider ids={rows.map((r) => r.id)}>
            <SelectModeToggle />
            {rows.length === 0 ? (
              <p className="mt-4 px-2 text-sm text-neutral-600">Nothing here yet.</p>
            ) : isTaskList ? (
              taskGroups.map((g) => (
                <div key={g.key}>
                  {g.label && (
                    <p className="mt-3 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      {g.label}
                    </p>
                  )}
                  <TaskList
                    tasks={g.rows}
                    dueToday={dueToday}
                    statuses={taskStatuses}
                    rollups={taskRollups}
                    today={todayYmd}
                    meta={taskMeta}
                    // These rows already live under this record; the project
                    // chip would repeat the page header.
                    showProject={false}
                    // Milestone sections already name the milestone; the
                    // per-row flag would repeat it.
                    milestonesByTask={taskGroupBy === "milestone" ? undefined : milestoneFlags}
                  />
                </div>
              ))
            ) : isMilestoneList ? (
              <div className="mt-3">
                <MilestoneList items={milestoneRows} selectable />
              </div>
            ) : isMeetingList ? (
              <div className="mt-3">
                <MeetingList items={meetingRows} selectable />
              </div>
            ) : isNoteList ? (
              <div className="mt-3">
                <NoteList items={noteRows} selectable />
              </div>
            ) : isLinkList ? (
              <div className="mt-3">
                <LinkList items={linkRows} selectable />
              </div>
            ) : (
              <div className="mt-3">
                <MindmapList items={mindmapRows} selectable />
              </div>
            )}
            {/* The completed tail, folded behind its count at the bottom of the
                list — where the done rows would sit. Query-narrowing links, so
                the header count stays honest either way. */}
            {isTaskList && doneCount > 0 && (
              <div className="mt-2 px-2">
                <Link
                  href={`/items/${id}/collection/${key}${showDone ? "" : "?done=1"}`}
                  className="text-sm text-neutral-500 hover:text-neutral-300"
                >
                  {showDone
                    ? "Hide completed"
                    : `${doneCount} task${doneCount === 1 ? "" : "s"} completed ›`}
                </Link>
              </div>
            )}
            {/* Add in place, pre-bound to this record — the same affordance as
                the record's card ("copy the rules we have on the tool"). */}
            <div className="mt-3 px-2">
              {isTaskList ? (
                <InlineAddTask
                  host={{
                    id,
                    label: record.title || "This record",
                    role: def.recordQuery?.role ?? "project",
                  }}
                  lockDestination
                />
              ) : isMilestoneList ? (
                <InlineContainAdd recordId={id} type="milestone" label="Milestone" />
              ) : isMeetingList ? (
                <InlineContainAdd recordId={id} type="event" label="Meeting" withTime />
              ) : isNoteList ? (
                <AddContainedItemButton recordId={id} type="note" label="Add note" />
              ) : isLinkList ? (
                <AddContainedItemButton recordId={id} type="link" label="Add link" />
              ) : (
                <AddContainedItemButton recordId={id} type="mindmap" label="Add mindmap" />
              )}
            </div>
            {rows.length < total && (
              <p className="mt-4 px-2 text-xs text-neutral-600">
                Showing the first {rows.length} of {total}.
              </p>
            )}
            <BulkActionBar {...bulkConfig} />
          </SelectionProvider>
        ) : (
          <SelectionProvider ids={rows.map((r) => r.id)}>
            <SelectModeToggle />
            <ul className="mt-2 flex flex-col">
              {rows.map((r) => {
                const done = r.statusCategory === "done";
                const day = r.scheduledDate ?? r.dueDate ?? r.meetingAt;
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 border-b border-neutral-900 py-2 last:border-0"
                  >
                    <SelectCheckbox id={r.id} />
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CATEGORY_DOT[r.statusCategory] ?? "bg-neutral-600"}`} />
                    <Link
                      href={`/items/${r.id}`}
                      className={`min-w-0 flex-1 truncate text-sm hover:text-neutral-100 ${done ? "text-neutral-500 line-through" : "text-neutral-200"}`}
                    >
                      {r.title || "Untitled"}
                    </Link>
                    {day && <span className="shrink-0 text-xs text-neutral-500">{dateFmt.format(day)}</span>}
                    <RowAction id={r.id} action="trash" />
                  </li>
                );
              })}
            </ul>
            {/* A custom-type tool's full page carries the card's typed add. */}
            {isCustomTool && collectionType && (
              <div className="mt-3 px-2">
                <AddContainedItemButton
                  recordId={id}
                  type={collectionType}
                  label={`Add ${label.toLowerCase()}`}
                />
              </div>
            )}
            {rows.length < total && (
              <p className="mt-4 px-2 text-xs text-neutral-600">
                Showing the first {rows.length} of {total}.
              </p>
            )}
            <BulkActionBar {...bulkConfig} />
          </SelectionProvider>
        )}
      </div>
    </main>
  );
}
