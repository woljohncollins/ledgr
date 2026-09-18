// View renderer (slice 27, PRD §4.2/§4.9): one server component that takes a
// stored View Definition's items (already owner-scoped, body-free, filtered,
// and sorted by queryViewItems) and renders them in the view's layout. The
// five layouts are different presentations of the same row set; none of them
// re-queries or reaches for a body. Task rows carry the shared check-off
// control so a view of tasks behaves like the Tasks list.
import type { ReactNode } from "react";
import Link from "next/link";
import BoardDnd, { type BoardCard } from "@/components/views/BoardDnd";
import ProjectCardGrid, { ProjectCardBody, projectCardFrameClass } from "@/components/projects/ProjectCardGrid";
import type { ViewProjectCards } from "@/lib/project-cards";
import PlannerCalendar from "@/components/planner/PlannerCalendar";
import TimelineSpine from "@/components/timeline/TimelineSpine";
import RowMenu from "@/components/lists/RowMenu";
import SwipeRow from "@/components/lists/SwipeRow";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import { SelectBodyCell, SelectHeaderCell } from "@/components/selection/SelectTableCell";
import SubtaskCheckbox from "@/components/subtasks/SubtaskCheckbox";
import SubtaskExpandableRow from "@/components/subtasks/SubtaskExpandableRow";
import { contactLink } from "@/lib/contact-links";
import { imageUrl } from "@/lib/person-image";
import { propInstant } from "@/lib/placement";
import type { Progress } from "@/lib/subtasks";
import { DEFAULT_TIMEZONE } from "@/lib/today";
import { groupValuesFor, orderedGroups, type GroupEdges } from "@/lib/view-grouping";
import BoardColumn from "@/components/views/BoardColumn";
import { DEFAULT_GRAIN, type Grain } from "@/lib/timeline-grain";
import type { TimelineEntry, TimelineUndated } from "@/lib/timeline-entry";
import { DISPLAY_DEFAULTS } from "@/lib/views";
import type { ColumnField, ViewColumn, ViewDefinition } from "@/lib/views";
import type { OverlayEvent } from "@/lib/calendar/overlay";
import { isTerminalCategory, type StatusDef } from "@/lib/status";

// Structural shape of a listColumns row, narrowed to what the layouts use.
// properties rides along so a board can group by a custom select field (the
// query already selects it; ADR-046).
export type ViewItem = {
  id: string;
  type: string;
  title: string;
  status: string;
  statusCategory: string;
  dueDate: Date | null;
  scheduledDate: Date | null;
  urgency: number | null;
  meetingAt: Date | null;
  // The end of a timed item (the range rule): paired with meetingAt for events.
  // null = single-anchor. noteDate is the day a note was taken (ADR-110).
  endAt: Date | null;
  noteDate: Date | null;
  url: string | null;
  properties: unknown;
  createdAt: Date;
  updatedAt: Date;
};

// Due dates are UTC-midnight calendar days (ADR-008); format in UTC. The
// timestamp columns are real instants; format in the owner's timezone.
const utcDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const utcDayLong = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
// en-CA renders YYYY-MM-DD, a sortable day key.
const utcKey = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });

// The timezone-aware formatters are keyed by zone and built lazily (this
// component, unlike the pure UTC formatters above, must render in the owner's
// chosen zone). The zone is threaded in as `tz` — the ViewRenderer `tz` prop
// flows down to the layouts and helpers — so nothing reassigns module state
// during render.
const tzFmtCache = new Map<
  string,
  { day: Intl.DateTimeFormat; dayLong: Intl.DateTimeFormat; key: Intl.DateTimeFormat; dayTime: Intl.DateTimeFormat }
>();
function tzFmts(tz: string) {
  let f = tzFmtCache.get(tz);
  if (!f) {
    f = {
      day: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }),
      dayLong: new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: tz,
      }),
      key: new Intl.DateTimeFormat("en-CA", { timeZone: tz }),
      dayTime: new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz,
      }),
    };
    tzFmtCache.set(tz, f);
  }
  return f;
}

function dateOf(item: ViewItem, prop: ViewDefinition["dateProperty"]): Date | null {
  switch (prop) {
    case "plan":
      // Effective plan date: scheduled if set, else the due deadline (ADR-109).
      return item.scheduledDate ?? item.dueDate;
    case "dueDate":
      return item.dueDate;
    case "scheduledDate":
      return item.scheduledDate;
    case "meetingAt":
      return item.meetingAt;
    case "createdAt":
      return item.createdAt;
    case "updatedAt":
      return item.updatedAt;
    default:
      return item.scheduledDate ?? item.dueDate ?? item.meetingAt;
  }
}

const usesUtc = (prop: ViewDefinition["dateProperty"]) =>
  prop === "plan" || prop === "dueDate" || prop === "scheduledDate";

function dayKey(date: Date, prop: ViewDefinition["dateProperty"], tz: string): string {
  return (usesUtc(prop) ? utcKey : tzFmts(tz).key).format(date);
}

// A deadline date on an open task reads as overdue once its calendar day is past
// (matching the item canvas rail). Only the deadline props (plan/due/scheduled)
// can be late — created/updated/meeting dates never do — and a done task never
// does. Today is the app-timezone day, the same reference the calendar's "today"
// highlight uses.
function isDeadlineOverdue(date: Date | null, key: ColumnField | ViewDefinition["dateProperty"], tz: string): boolean {
  if (!date) return false;
  const prop = key as ViewDefinition["dateProperty"];
  if (!usesUtc(prop)) return false;
  return dayKey(date, prop, tz) < tzFmts(tz).key.format(new Date());
}

// A status chip showing the type's label + color (S2). The resting "not started"
// status renders no chip (matches the old "hide open"); everything else shows.
function StatusChip({ status, statuses }: { status: string; statuses?: StatusDef[] }) {
  const def = statuses?.find((s) => s.key === status);
  if (def?.category === "not_started") return null;
  if (!def && status === "open") return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-neutral-800 px-1.5 text-xs text-neutral-300">
      {def?.color && (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: def.color }}
        />
      )}
      {def?.label ?? status}
    </span>
  );
}

function UrgencyChip({ urgency }: { urgency: number | null }) {
  if (urgency == null || urgency > 2) return null;
  return (
    <span className="shrink-0 rounded bg-amber-950 px-1.5 text-xs text-amber-400">
      {`P${urgency}`}
    </span>
  );
}

// A row's headline date, picked for the layout's date property.
function rowDate(item: ViewItem, prop: ViewDefinition["dateProperty"], tz: string) {
  const d = dateOf(item, prop);
  if (!d) return "";
  return (usesUtc(prop) ? utcDay : tzFmts(tz).day).format(d);
}

// --- configurable columns (Brandon feedback, 2026-06-14) ------------------
// A view can choose which fields/properties the list + table show; null falls
// back to each layout's default. propertyLabels maps a custom property key to
// its label (resolved from the type's schema by the page); missing → the key.

const FIELD_COLUMN_LABELS: Record<ColumnField, string> = {
  type: "Type",
  status: "Status",
  urgency: "Urgency",
  plan: "Plan",
  dueDate: "Due",
  scheduledDate: "Scheduled",
  meetingAt: "When",
  createdAt: "Created",
  updatedAt: "Updated",
  url: "URL",
};

function columnLabel(col: ViewColumn, labels: Record<string, string>): string {
  return col.source === "property"
    ? labels[col.key] ?? col.key
    : FIELD_COLUMN_LABELS[col.key];
}

function formatPropValue(v: unknown, tz?: string): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  // A timed date property (ADR-254) reads as a local day + clock, not raw ISO.
  if (typeof v === "string" && tz) {
    const inst = propInstant(v);
    if (inst) return tzFmts(tz).dayTime.format(inst);
  }
  return String(v);
}

// A table cell's contents: the column's text, wrapped in a tel:/mailto: link
// when the column is a `phone`/`email` property (ADR-192), so a directory-style
// list is dialable without opening each record. Table layout ONLY, deliberately:
// the compact row layout wraps the whole row in a Link to the item, and nesting
// an anchor inside an anchor is invalid HTML that would also steal the row tap.
// `stopPropagation` keeps a tap on the link from bubbling into any row handler.
function columnCell(
  item: ViewItem,
  col: ViewColumn,
  tz: string,
  propertyKinds: Record<string, string>
) {
  const text = columnText(item, col, tz);
  if (!text || col.source !== "property") return text;
  const kind = propertyKinds[col.key];
  if (kind === "image") {
    const src = imageUrl(text);
    if (!src) return text;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-6 w-6 rounded object-cover" />;
  }
  if (kind !== "phone" && kind !== "email") return text;
  const link = contactLink(kind, col.key, text);
  if (!link) return text;
  return (
    <a
      href={link.href}
      title={link.title}
      onClick={(e) => e.stopPropagation()}
      className="hover:text-neutral-100 hover:underline"
    >
      {text}
    </a>
  );
}

// The display text for a column on a row. Dates format in the same calendars
// as everywhere else (due is a UTC calendar day; the rest are real instants).
function columnText(item: ViewItem, col: ViewColumn, tz: string): string {
  if (col.source === "property") {
    const props =
      item.properties && typeof item.properties === "object"
        ? (item.properties as Record<string, unknown>)
        : null;
    return formatPropValue(props?.[col.key], tz);
  }
  switch (col.key) {
    case "type":
      return item.type;
    case "status":
      return item.status;
    case "urgency":
      return item.urgency != null ? `P${item.urgency}` : "";
    case "url":
      return item.url ?? "";
    case "plan": {
      const d = item.scheduledDate ?? item.dueDate;
      return d ? utcDay.format(d) : "";
    }
    case "dueDate":
      return item.dueDate ? utcDay.format(item.dueDate) : "";
    case "scheduledDate":
      return item.scheduledDate ? utcDay.format(item.scheduledDate) : "";
    case "meetingAt":
      return item.meetingAt ? tzFmts(tz).day.format(item.meetingAt) : "";
    case "createdAt":
      return tzFmts(tz).day.format(item.createdAt);
    case "updatedAt":
      return tzFmts(tz).day.format(item.updatedAt);
  }
}

const ITEM_ROW_CLASS = "group flex items-center gap-2.5 rounded px-2 py-1 hover:bg-neutral-800/60";

function ItemRow({
  item,
  prop,
  columns,
  propertyLabels = {},
  statuses,
  selectable,
  rowAction,
  rollup,
  today,
  tz,
}: {
  item: ViewItem;
  prop: ViewDefinition["dateProperty"];
  columns?: ViewColumn[] | null;
  propertyLabels?: Record<string, string>;
  statuses?: StatusDef[];
  selectable?: boolean;
  tz: string;
  // Optional trailing slot for this row (the related panel passes relation
  // controls — confirm/reject/un-relate + mention/suggested markers). Other
  // callers leave it undefined, so their rows are unchanged.
  rowAction?: ReactNode;
  // Subtask rollup for this row; when present with task children, the row grows
  // the expandable "n/m" pill. Undefined → a plain row (defer by hiding).
  rollup?: Progress;
  // App-timezone today (YYYY-MM-DD). When set, the row is interactive (ADR-142):
  // task rows swipe (right=complete, left=schedule) and every row gets the
  // shared right-click/long-press menu. Read-only callers (dashboards, the
  // related panel) leave it undefined, so their rows stay plain (defer by hiding).
  today?: string;
}) {
  const isTask = item.type === "task";
  const done = item.statusCategory === "done";
  const rowOverdue = isTask && !done && isDeadlineOverdue(dateOf(item, prop), prop, tz);
  const inner = (
    <>
      {selectable && <SelectCheckbox id={item.id} />}
      {isTask ? (
        <SubtaskCheckbox id={item.id} done={done} />
      ) : (
        <span className="w-14 shrink-0 truncate text-xs text-neutral-600">
          {item.type}
        </span>
      )}
      <Link
        href={`/items/${item.id}`}
        className={`min-w-0 flex-1 truncate text-sm ${
          item.title ? "text-neutral-200" : "text-neutral-500"
        } ${done ? "line-through opacity-60" : ""}`}
      >
        {item.title || "Untitled"}
      </Link>
      {columns && columns.length > 0 ? (
        // Configured columns: status/urgency keep their chips (the established
        // look); everything else is a labelled value. A blank value renders
        // nothing so the row doesn't fill with empty labels.
        columns.map((col) => {
          if (col.source === "field" && col.key === "status") {
            return <StatusChip key="status" status={item.status} statuses={statuses} />;
          }
          if (col.source === "field" && col.key === "urgency") {
            return <UrgencyChip key="urgency" urgency={item.urgency} />;
          }
          const text = columnText(item, col, tz);
          if (!text) return null;
          const colOverdue =
            isTask &&
            !done &&
            col.source === "field" &&
            isDeadlineOverdue(dateOf(item, col.key as ViewDefinition["dateProperty"]), col.key, tz);
          return (
            <span
              key={`${col.source}:${col.key}`}
              className={`shrink-0 text-xs ${colOverdue ? "text-red-400" : "text-neutral-500"}`}
              title={columnLabel(col, propertyLabels)}
            >
              {text}
            </span>
          );
        })
      ) : (
        <>
          <StatusChip status={item.status} statuses={statuses} />
          <UrgencyChip urgency={item.urgency} />
          <span className={`shrink-0 text-xs ${rowOverdue ? "text-red-400" : "text-neutral-600"}`}>
            {rowDate(item, prop, tz)}
          </span>
        </>
      )}
      {rowAction}
    </>
  );
  const menuOpts = today
    ? { id: item.id, canComplete: isTask, done, today, label: item.title || "Untitled" }
    : undefined;
  // A task with task-children keeps the expandable "n/m" pill (which carries the
  // menu when the surface is interactive).
  if (isTask && rollup && rollup.total > 0) {
    return (
      <SubtaskExpandableRow
        id={item.id}
        done={rollup.done}
        total={rollup.total}
        liClassName={ITEM_ROW_CLASS}
        menuOptions={menuOpts}
      >
        {inner}
      </SubtaskExpandableRow>
    );
  }
  // Interactive surfaces: task rows swipe (right=complete, left=schedule) on top
  // of the shared menu; other types get the menu only. Read-only callers pass no
  // `today`, so their rows stay a plain <li> (defer by hiding).
  if (menuOpts) {
    return isTask ? (
      <SwipeRow className={ITEM_ROW_CLASS} {...menuOpts}>
        {inner}
      </SwipeRow>
    ) : (
      <RowMenu className={ITEM_ROW_CLASS} {...menuOpts}>
        {inner}
      </RowMenu>
    );
  }
  return <li className={ITEM_ROW_CLASS}>{inner}</li>;
}

// --- layouts --------------------------------------------------------------
// (board/agenda grouping lives in src/lib/view-grouping.ts — pure + testable)

function ListLayout({
  items,
  view,
  propertyLabels,
  statuses,
  selectable,
  rowActions,
  rollups,
  today,
  tz,
}: {
  items: ViewItem[];
  view: ViewDefinition;
  propertyLabels: Record<string, string>;
  statuses?: StatusDef[];
  selectable?: boolean;
  rowActions?: Record<string, ReactNode>;
  rollups?: Map<string, Progress>;
  today?: string;
  tz: string;
}) {
  return (
    <ul className="mt-4">
      {items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          prop={view.dateProperty}
          columns={view.columns}
          propertyLabels={propertyLabels}
          statuses={statuses}
          selectable={selectable}
          rowAction={rowActions?.[item.id]}
          rollup={rollups?.get(item.id)}
          today={today}
          tz={tz}
        />
      ))}
    </ul>
  );
}

function TableLayout({
  items,
  view,
  propertyLabels,
  propertyKinds,
  selectable,
  tz,
}: {
  items: ViewItem[];
  view: ViewDefinition;
  propertyLabels: Record<string, string>;
  propertyKinds: Record<string, string>;
  selectable?: boolean;
  tz: string;
}) {
  // The view's chosen columns, or the default four (Type/Status/Urgency/Date)
  // expressed as field columns so one rendering path serves both. "Date" maps
  // to the view's date property so the default keeps its old meaning.
  const defaultDateKey: ColumnField =
    view.dateProperty === "meetingAt"
      ? "meetingAt"
      : view.dateProperty === "createdAt"
        ? "createdAt"
        : view.dateProperty === "updatedAt"
          ? "updatedAt"
          : view.dateProperty === "scheduledDate"
            ? "scheduledDate"
            : view.dateProperty === "dueDate"
              ? "dueDate"
              : "plan";
  const columns: ViewColumn[] =
    view.columns && view.columns.length > 0
      ? view.columns
      : [
          { source: "field", key: "type" },
          { source: "field", key: "status" },
          { source: "field", key: "urgency" },
          { source: "field", key: defaultDateKey },
        ];
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
            {selectable && <SelectHeaderCell />}
            <th className="py-1.5 pr-3 font-medium">Title</th>
            {columns.map((col) => (
              <th key={`${col.source}:${col.key}`} className="py-1.5 pr-3 font-medium">
                {columnLabel(col, propertyLabels)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="group border-b border-neutral-900 hover:bg-neutral-800/40"
            >
              {selectable && <SelectBodyCell id={item.id} />}
              <td className="max-w-xs truncate py-1.5 pr-3">
                <Link
                  href={`/items/${item.id}`}
                  className={`hover:text-neutral-100 ${
                    item.title ? "text-neutral-200" : "text-neutral-500"
                  } ${item.statusCategory === "done" ? "line-through opacity-60" : ""}`}
                >
                  {item.title || "Untitled"}
                </Link>
              </td>
              {columns.map((col) => (
                <td
                  key={`${col.source}:${col.key}`}
                  className="py-1.5 pr-3 text-neutral-400"
                >
                  {columnCell(item, col, tz, propertyKinds)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A board card carrying the rich project-card body (2026-08-17): the same
// element set as the grid, in the board column's compact width. Shared by the
// read-only server board and (as a prebuilt node) the draggable client board.
function boardProjectCard(item: ViewItem, projectCards: ViewProjectCards): ReactNode | null {
  const card = projectCards.byId[item.id];
  if (!card) return null;
  return (
    <div className={`relative rounded border p-2.5 ${projectCardFrameClass(card.favorited)}`}>
      <ProjectCardBody card={card} config={projectCards.config} compact />
    </div>
  );
}

function BoardLayout({
  items,
  view,
  groupOrder,
  draggable,
  statuses,
  tz,
  groupEdges,
  projectCards,
}: {
  items: ViewItem[];
  view: ViewDefinition;
  groupOrder?: string[];
  draggable?: boolean;
  statuses?: StatusDef[];
  tz: string;
  // Edges for a relation grouping (group by Tags), batch-fetched by the page and
  // keyed by source item id. Undefined for every other grouping, which reads its
  // values straight off the row.
  groupEdges?: GroupEdges;
  // Rich project-card data + element config (2026-08-17), resolved by the page
  // for a project-scoped board. Undefined everywhere else → the classic
  // title+date card.
  projectCards?: ViewProjectCards;
}) {
  const now = new Date();
  // A status board colors its column headers with the status colors (S2).
  const statusBoard =
    !view.grouping || ("field" in view.grouping && view.grouping.field === "status");
  // When the page deems the grouping safe to set by a drop (status, urgency, or
  // a single-select property), hand off to the client DnD board; the cards
  // carry a precomputed date label so the client needn't reimplement the
  // calendars. Otherwise the board stays the read-only server render.
  if (draggable) {
    const cards: BoardCard[] = items.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      urgency: i.urgency,
      type: i.type,
      dueDate: i.dueDate,
      scheduledDate: i.scheduledDate,
      properties: i.properties,
      dateLabel: rowDate(i, view.dateProperty, tz),
    }));
    // Rich project cards are prebuilt server nodes keyed by id — the client
    // board renders them verbatim inside its draggable <li>s.
    let cardBodies: Record<string, ReactNode> | undefined;
    if (projectCards) {
      cardBodies = {};
      for (const i of items) {
        const body = boardProjectCard(i, projectCards);
        if (body) cardBodies[i.id] = body;
      }
    }
    return (
      <BoardDnd
        cards={cards}
        grouping={view.grouping}
        boardKey={view.id}
        groupOrder={groupOrder}
        statuses={statuses}
        cardBodies={cardBodies}
      />
    );
  }
  // flatMap, not map: a multi-valued grouping (Tags, multi_select) puts a row in
  // EVERY one of its values, so the set of present columns is the union of all of
  // them. Column totals therefore sum to more than the row count — by design, a
  // task tagged Work and Urgent really is in both.
  const present = new Set(
    items.flatMap((i) => groupValuesFor(i, view.grouping, now, groupEdges))
  );
  const columns = orderedGroups(view.grouping, present, groupOrder);
  return (
    // Snap-scroll on a phone (one column per swipe), free scrolling on desktop.
    // No drag on this read-only path, so unlike BoardDnd it can snap always.
    <div className="mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:snap-none">
      {columns.map((col) => {
        const colItems = items.filter((i) =>
          groupValuesFor(i, view.grouping, now, groupEdges).includes(col)
        );
        const sdef = statusBoard ? statuses?.find((s) => s.key === col) : undefined;
        return (
          <BoardColumn
            key={col}
            col={col}
            boardKey={view.id}
            label={sdef?.label ?? col}
            color={sdef?.color}
            count={colItems.length}
            defaultCollapsed={sdef ? isTerminalCategory(sdef.category) : false}
          >
            <ul className="flex flex-col gap-1.5 p-2">
              {colItems.map((item) => {
                const rich = projectCards ? boardProjectCard(item, projectCards) : null;
                if (rich) return <li key={item.id}>{rich}</li>;
                return (
                  <li key={item.id}>
                    <Link
                      href={`/items/${item.id}`}
                      className={`block rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-sm hover:border-neutral-700 ${
                        item.title ? "text-neutral-200" : "text-neutral-500"
                      } ${item.statusCategory === "done" ? "line-through opacity-60" : ""}`}
                    >
                      <span className="block truncate">
                        {item.title || "Untitled"}
                      </span>
                      {rowDate(item, view.dateProperty, tz) && (
                        <span className="mt-0.5 block text-xs text-neutral-600">
                          {rowDate(item, view.dateProperty, tz)}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </BoardColumn>
        );
      })}
    </div>
  );
}

// --- History spine (2026-09-03) -------------------------------------------
// Turn a view's rows into the shape TimelineSpine renders. This is the second
// gatherer for src/lib/timeline-entry.ts (the first is gatherProjectTimeline):
// one type, one date field, one tier, versus a record's five collections.
//
// Deliberately NOT placement.ts. That seam resolves a DRAGGABLE {ymd, minutes}
// anchor, and the spine is read-only, so going through it would mean converting
// the anchor back into an instant for no gain. What it does honor is
// display.startField, the one thing placement offers that the older dateOf does
// not: a custom date property, which is where a bespoke type (a work log's
// `logdate`) actually keeps its date.
const SPINE_KIND: Record<string, TimelineEntry["kind"]> = {
  event: "meeting",
  milestone: "milestone",
  task: "task",
  note: "note",
  link: "link",
};

function spineDate(
  item: ViewItem,
  view: ViewDefinition,
  grain: Grain
): { date: Date; calendarDay: boolean; hasTime: boolean } | null {
  const start = view.display?.startField;
  if (start && "prop" in start) {
    const props =
      item.properties && typeof item.properties === "object"
        ? (item.properties as Record<string, unknown>)
        : null;
    const raw = props?.[start.prop];
    if (typeof raw !== "string" || raw.length < 10) return null;
    // A withTime prop is a real instant (ADR-254); a day scalar stays a UTC day.
    const inst = propInstant(raw);
    if (inst) return { date: inst, calendarDay: false, hasTime: grain === "hour" || grain === "day" };
    const d = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : { date: d, calendarDay: true, hasTime: false };
  }
  // No explicit start field: the view's date property, or per-item "when" for a
  // view that never chose one (resolving per item keeps a meeting an instant and
  // a scheduled day a UTC calendar day, instead of guessing one rule for both).
  const field: ViewDefinition["dateProperty"] | "endAt" | "noteDate" =
    start && "field" in start
      ? start.field
      : (view.dateProperty ?? (item.meetingAt ? "meetingAt" : "plan"));
  const date =
    field === "endAt"
      ? item.endAt
      : field === "noteDate"
        ? item.noteDate
        : dateOf(item, field);
  if (!date) return null;
  const calendarDay = field === "noteDate" || usesUtc(field as ViewDefinition["dateProperty"]);
  // A time is worth showing when the field carries one AND the reader is looking
  // at that scale, plus always for a meeting (its time is the point).
  const hasTime =
    !calendarDay && (grain === "hour" || grain === "day" || field === "meetingAt");
  return { date, calendarDay, hasTime };
}

function viewEntries(
  items: ViewItem[],
  view: ViewDefinition,
  statuses: StatusDef[] | undefined,
  tz: string,
  grain: Grain
): { entries: TimelineEntry[]; undated: TimelineUndated[] } {
  const entries: TimelineEntry[] = [];
  const undated: TimelineUndated[] = [];
  const cols = view.columns ?? [];
  for (const item of items) {
    const placed = spineDate(item, view, grain);
    if (!placed) {
      undated.push({ id: item.id, title: item.title, badge: item.type });
      continue;
    }
    // The chip follows StatusChip's rule: a not-started status is noise, so it
    // shows nothing rather than a chip on every row. The view's chosen columns
    // become the second line, which is how a work-log spine reads its category.
    const def = statuses?.find((s) => s.key === item.status);
    const meta = cols.map((c) => columnText(item, c, tz)).filter(Boolean).join(" · ");
    entries.push({
      id: item.id,
      itemId: item.id,
      date: placed.date,
      // One tier for a view spine: a homogeneous row set has no natural
      // hierarchy, and inventing one would guess at the owner's intent. The
      // two-tier look stays on the record spine, where meetings and milestones
      // really are the headlines (Brandon, 2026-09-03).
      tier: "big",
      kind: SPINE_KIND[item.type] ?? "item",
      label: def && def.category !== "not_started" ? def.label : "",
      title: item.title,
      hasTime: placed.hasTime,
      calendarDay: placed.calendarDay,
      done: item.statusCategory === "done",
      url: item.type === "link" ? item.url : null,
      meta: meta || undefined,
    });
  }
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { entries, undated };
}

// Where the Today marker goes, by comparing day keys to the app-timezone today
// the caller already threads in. Pure: no clock read, so a client mount and an
// SSR pass agree. Undefined `today` (a dashboard widget) means no marker.
function spineTodayBefore(entries: TimelineEntry[], today: string | undefined, tz: string): number {
  if (!today) return -1;
  return entries.findIndex(
    (e) => (e.calendarDay ? utcKey : tzFmts(tz).key).format(e.date) > today
  );
}

function AgendaLayout({
  items,
  view,
  propertyLabels,
  statuses,
  selectable,
  rollups,
  today,
  tz,
}: {
  items: ViewItem[];
  view: ViewDefinition;
  propertyLabels: Record<string, string>;
  statuses?: StatusDef[];
  selectable?: boolean;
  rollups?: Map<string, Progress>;
  today?: string;
  tz: string;
}) {
  const prop = view.dateProperty;
  const longFmt = usesUtc(prop) ? utcDayLong : tzFmts(tz).dayLong;
  // Bucket by day; sort buckets chronologically; undated last.
  const buckets = new Map<string, { label: string; items: ViewItem[] }>();
  const undated: ViewItem[] = [];
  for (const item of items) {
    const d = dateOf(item, prop);
    if (!d) {
      undated.push(item);
      continue;
    }
    const key = dayKey(d, prop, tz);
    if (!buckets.has(key)) buckets.set(key, { label: longFmt.format(d), items: [] });
    buckets.get(key)!.items.push(item);
  }
  const days = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="mt-4 flex flex-col gap-5">
      {days.map(([key, { label, items: dayItems }]) => (
        <section key={key}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {label}
          </h3>
          <ul className="mt-1">
            {dayItems.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                prop={prop}
                columns={view.columns}
                propertyLabels={propertyLabels}
                statuses={statuses}
                selectable={selectable}
                rollup={rollups?.get(item.id)}
                today={today}
                tz={tz}
              />
            ))}
          </ul>
        </section>
      ))}
      {undated.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
            No date
          </h3>
          <ul className="mt-1">
            {undated.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                prop={prop}
                columns={view.columns}
                propertyLabels={propertyLabels}
                statuses={statuses}
                selectable={selectable}
                rollup={rollups?.get(item.id)}
                today={today}
                tz={tz}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CalendarLayout({
  items,
  view,
  month,
  navHref,
  tz,
}: {
  items: ViewItem[];
  view: ViewDefinition;
  tz: string;
  // Which month to show, "YYYY-MM" (validated by the caller); defaults to the
  // current month. Items aren't month-bounded by the query, so navigating just
  // re-buckets the same rows into the chosen month — no re-fetch.
  month?: string;
  // Base path for the prev/next/today links (e.g. "/views/<id>"). When set, the
  // month nav renders; widgets leave it unset (no URL context) and stay locked
  // to the current month.
  navHref?: string;
}) {
  const prop = view.dateProperty;
  const pad = (n: number) => String(n).padStart(2, "0");
  // The month to show: the provided YYYY-MM or the current month (app TZ).
  const nowParts = tzFmts(tz).key.format(new Date()).split("-"); // YYYY-MM-DD
  const shown = month && /^\d{4}-\d{2}$/.test(month) ? month : `${nowParts[0]}-${nowParts[1]}`;
  const [ys, ms] = shown.split("-");
  const year = Number(ys);
  const monthNum = Number(ms); // 1-12
  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNum - 1, 1)));
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, monthNum - 1, 1)).getUTCDay();
  const todayKey = tzFmts(tz).key.format(new Date());
  const onCurrentMonth = shown === `${nowParts[0]}-${nowParts[1]}`;
  // Prev/next month params (first-of-month math, DST-safe in UTC).
  const toParam = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  const prevMonth = toParam(new Date(Date.UTC(year, monthNum - 2, 1)));
  const nextMonth = toParam(new Date(Date.UTC(year, monthNum, 1)));

  // Bucket items by day key; count any that fall outside the shown month.
  const byDay = new Map<string, ViewItem[]>();
  let outside = 0;
  for (const item of items) {
    const d = dateOf(item, prop);
    if (!d) {
      outside += 1;
      continue;
    }
    const key = dayKey(d, prop, tz);
    if (!key.startsWith(shown)) {
      outside += 1;
      continue;
    }
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(item);
  }

  const cells: ({ day: number; key: string } | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ day: d, key: `${shown}-${pad(d)}` });
  }

  const navLink =
    "rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200";

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-300">{monthLabel}</p>
        {navHref && (
          <div className="flex items-center gap-1 text-xs">
            <Link href={`${navHref}?month=${prevMonth}`} aria-label="Previous month" className={navLink}>
              ‹
            </Link>
            {!onCurrentMonth && (
              <Link href={navHref} className={navLink}>
                Today
              </Link>
            )}
            <Link href={`${navHref}?month=${nextMonth}`} aria-label="Next month" className={navLink}>
              ›
            </Link>
          </div>
        )}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-neutral-800 bg-neutral-800 text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="bg-neutral-900 px-2 py-1 text-center font-medium uppercase tracking-wide text-neutral-500"
          >
            {d}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={`pad-${i}`} className="min-h-20 bg-neutral-950" />;
          const dayItems = byDay.get(cell.key) ?? [];
          const isToday = cell.key === todayKey;
          return (
            <div key={cell.key} className="min-h-20 bg-neutral-900 p-1">
              <div
                className={`mb-1 text-right text-[11px] ${
                  isToday ? "font-bold text-neutral-100" : "text-neutral-600"
                }`}
              >
                {cell.day}
              </div>
              <div className="flex flex-col gap-0.5">
                {dayItems.slice(0, 4).map((item) => (
                  <Link
                    key={item.id}
                    href={`/items/${item.id}`}
                    title={item.title || "Untitled"}
                    className={`block truncate rounded bg-neutral-800 px-1 py-0.5 text-[11px] hover:bg-neutral-700 ${
                      item.statusCategory === "done"
                        ? "text-neutral-500 line-through"
                        : "text-neutral-300"
                    }`}
                  >
                    {item.title || "Untitled"}
                  </Link>
                ))}
                {dayItems.length > 4 && (
                  <span className="px-1 text-[11px] text-neutral-600">
                    +{dayItems.length - 4} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {outside > 0 && (
        <p className="mt-2 text-xs text-neutral-600">
          {outside} item{outside === 1 ? "" : "s"} outside {monthLabel} (no
          date or another month).
        </p>
      )}
    </div>
  );
}

export default function ViewRenderer({
  view,
  items,
  groupOrder,
  propertyLabels = {},
  propertyKinds = {},
  boardDraggable = false,
  statuses,
  month,
  calendarNavHref,
  calendarEvents,
  selectable = false,
  rowActions,
  rollups,
  today,
  tz = DEFAULT_TIMEZONE,
  groupEdges,
  projectCards,
}: {
  view: ViewDefinition;
  items: ViewItem[];
  // Rich project cards (2026-08-17): card data + element config, resolved by
  // the page via projectCardsForView for a project-scoped list/board view.
  // When set, the list layout renders the card grid instead of rows and board
  // cards carry the full card body; undefined leaves every layout unchanged.
  projectCards?: ViewProjectCards;
  // Relation-grouping edges (group by Tags), batch-fetched by the page. Only a
  // board grouped by a relation role reads it; everything else ignores it.
  groupEdges?: GroupEdges;
  // The view type's resolved statuses (S2): status chips + board column labels/
  // colors render from these. Resolved by the page from the type's schema.
  statuses?: StatusDef[];
  // Column order for a board grouped by a custom property (the property's
  // option order); resolved by the page from the type's schema (ADR-046).
  groupOrder?: string[];
  // Labels for the type's custom properties, so a property column shows its
  // label rather than its key. Resolved by the page from the type's schema.
  propertyLabels?: Record<string, string>;
  // Kinds for the type's custom properties, keyed the same way (ADR-192).
  // Only the table layout reads it, and only for `phone`/`email`, to make a
  // contact column dialable. Optional and defaulted, so a caller that hasn't
  // resolved it renders exactly as before.
  propertyKinds?: Record<string, string>;
  // Whether a board's cards can be dragged between columns to set their group
  // value. The page decides (only safe for status/urgency/single-select);
  // dashboards leave it false, so a board widget stays read-only.
  boardDraggable?: boolean;
  // Calendar month to show, "YYYY-MM" (from the page's ?month= param); defaults
  // to the current month.
  month?: string;
  // Base path for the calendar's month-nav links (e.g. "/views/<id>"). Set by
  // the view page; widgets leave it unset so a calendar widget shows the current
  // month with no nav.
  calendarNavHref?: string;
  // Read-only synced calendar events for the writable calendar overlay (plan
  // tasks around what's already scheduled). Passed straight to PlannerCalendar,
  // which gates them behind its "Show calendar" toggle.
  calendarEvents?: OverlayEvent[];
  // Render per-row selection checkboxes (the multi-select layer, ADR-118). The
  // caller wraps this renderer in a SelectionProvider + BulkActionBar; here it
  // only toggles the row affordance. Off for dashboard widgets (read-only) and
  // the board/calendar layouts (selection there is deferred — defer-by-hiding).
  selectable?: boolean;
  // Optional per-row trailing slot, keyed by item id (the related panel passes
  // relation controls). Honored by the list layout; other layouts ignore it for
  // now (defer-by-hiding). Undefined for every other caller.
  rowActions?: Record<string, ReactNode>;
  // Subtask "n/m" rollups keyed by item id, so list/agenda rows can grow the
  // expandable indicator. The list-surface callers compute it (childRollups);
  // dashboards, the board/table/calendar layouts, and the related panel leave
  // it undefined, so those rows are unchanged (defer by hiding).
  rollups?: Map<string, Progress>;
  // App-timezone today (YYYY-MM-DD). When set, the list + agenda rows become
  // interactive (ADR-142): task rows swipe (right=complete, left=schedule) and
  // every row gets the shared right-click/long-press menu. List-surface callers
  // (the view page, view-lens body) pass it; dashboards leave it undefined so a
  // widget's rows stay read-only (defer by hiding).
  today?: string;
  // The owner's resolved timezone (getAppTimezone). The timestamp columns and
  // the calendar/agenda day grouping render in it. Defaults to DEFAULT_TIMEZONE
  // so a caller that hasn't threaded it behaves exactly as before.
  tz?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="mt-6 px-2 text-sm text-neutral-600">
        No items match this view.
      </p>
    );
  }
  switch (view.layout) {
    case "table":
      return (
        <TableLayout
          items={items}
          view={view}
          propertyLabels={propertyLabels}
          propertyKinds={propertyKinds}
          selectable={selectable}
          tz={tz}
        />
      );
    case "board":
      return (
        <BoardLayout
          groupEdges={groupEdges}
          items={items}
          view={view}
          groupOrder={groupOrder}
          draggable={boardDraggable}
          statuses={statuses}
          tz={tz}
          projectCards={projectCards}
        />
      );
    case "calendar": {
      // History (2026-09-03): the vertical spine, ahead of every planner check.
      // It rides display.mode rather than a sixth view_layout, so it needed no
      // enum migration and every ViewRenderer mount picks it up unchanged.
      if ((view.display?.mode ?? DISPLAY_DEFAULTS.mode) === "spine") {
        const grain = view.display?.zoom ?? DEFAULT_GRAIN;
        const { entries, undated } = viewEntries(items, view, statuses, tz, grain);
        return (
          <div className="mt-4">
            <TimelineSpine
              entries={entries}
              tz={tz}
              grain={grain}
              // The view's own Sort direction reads the spine: descending puts
              // the most recent at the top. One less control to invent.
              dir={view.sort.dir === "asc" ? "asc" : "desc"}
              todayBefore={spineTodayBefore(entries, today, tz)}
              undated={undated}
              undatedLabel="No date"
            />
          </div>
        );
      }
      // The Planner (ADR-131, extended by ADR-166): mount the interactive
      // planner whenever the calendar places items on a WRITABLE date field —
      // scheduled/due/plan (calendar days), or a meeting's "When" (meeting_at,
      // now draggable through the placement layer, the ADR-166 gate). The static
      // grid + agenda remain only for genuinely read-only anchors (created/
      // updated), where dragging isn't meaningful.
      const prop = view.dateProperty;
      const interactive =
        prop == null || prop === "plan" || prop === "scheduledDate" ||
        prop === "dueDate" || prop === "meetingAt";
      if (interactive) {
        return (
          <PlannerCalendar
            items={items}
            prop={prop}
            placeBy={view.display?.placeBy ?? DISPLAY_DEFAULTS.placeBy}
            display={view.display}
            month={month}
            navHref={calendarNavHref}
            calendarEvents={calendarEvents}
            statuses={statuses}
            // App-timezone "today", resolved server-side so SSR and the client's
            // first render agree (the planner used to seed today/anchor from the
            // browser's local `new Date()`, which mismatches a UTC server render
            // and tripped a hydration warning). Computed once here and passed as a
            // plain string, so the client never recomputes it.
            today={today ?? tzFmts(tz).key.format(new Date())}
            tz={tz}
          />
        );
      }
      return (
        <>
          <div className="hidden sm:block">
            <CalendarLayout
              items={items}
              view={view}
              month={month}
              navHref={calendarNavHref}
              tz={tz}
            />
          </div>
          <div className="sm:hidden">
            <AgendaLayout
              items={items}
              view={view}
              propertyLabels={propertyLabels}
              statuses={statuses}
              selectable={selectable}
              rollups={rollups}
              today={today}
              tz={tz}
            />
          </div>
        </>
      );
    }
    case "agenda":
      return (
        <AgendaLayout
          items={items}
          view={view}
          propertyLabels={propertyLabels}
          statuses={statuses}
          selectable={selectable}
          rollups={rollups}
          today={today}
          tz={tz}
        />
      );
    default:
      // A project-scoped list view renders the rich card grid (2026-08-17) —
      // the "Recent look" on any tab — in the view's own row order.
      if (projectCards) {
        const cards = items
          .map((i) => projectCards.byId[i.id])
          .filter((c): c is NonNullable<typeof c> => c != null);
        return <ProjectCardGrid cards={cards} config={projectCards.config} />;
      }
      return (
        <ListLayout
          items={items}
          view={view}
          propertyLabels={propertyLabels}
          statuses={statuses}
          selectable={selectable}
          rowActions={rowActions}
          rollups={rollups}
          today={today}
          tz={tz}
        />
      );
  }
}
