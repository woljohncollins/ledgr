// The widget-composed canvas (Project Type, redesigned 2026-07-01). A record
// whose type carries the `widget-home` capability renders here instead of
// MarkdownCanvas — that's Project, Pursuit, and every CUSTOM type by default.
//
// The redesigned project homepage has three zones:
//   1. Title.
//   2. A HEADER strip rendered without card chrome or titles: Status as a pill
//      pinned top-right, and a People row + Progress bar stacked on the left.
//   3. A uniform GRID of section cards (Tasks, Milestones, Docs, Meetings by
//      default) — 2-up in the modal, 3-up on the full page — followed by a big
//      "+ Add section" button (the replacement for the old Customize gear).
// Each card carries a quiet "×" to remove it (which returns it to the + menu).
//
// Widgets still come from the shared catalog bound to THIS record (record-
// widgets.ts binds relatedTo to the record; nothing here branches on Type). What
// changed is presentation: a fixed header set vs. cards, uniform card sizing by
// surface variant, and add/remove editing in place instead of via a gear.
import Link from "next/link";
import DetachButton from "@/components/lists/DetachButton";
import type { ReactNode } from "react";
import ItemEditor from "@/components/markdown-editor/ItemEditor";
import AddSectionButton from "@/components/canvas/AddSectionButton";
import HeaderOverview from "@/components/canvas/HeaderOverview";
import ProjectDoneCheckbox from "@/components/canvas/widgets/ProjectDoneCheckbox";
import SectionGrid from "@/components/canvas/SectionGrid";
import TasksWidget from "@/components/canvas/widgets/TasksWidget";
import NotesWidget from "@/components/canvas/widgets/NotesWidget";
import LinksWidget from "@/components/canvas/widgets/LinksWidget";
import MilestonesWidget from "@/components/canvas/widgets/MilestonesWidget";
import MeetingsWidget from "@/components/canvas/widgets/MeetingsWidget";
import MindmapWidget from "@/components/canvas/widgets/MindmapWidget";
import FilePanel from "@/components/attachments/FilePanel";
import ProjectPeople from "@/components/canvas/widgets/ProjectPeople";
import ProjectStatusChip from "@/components/canvas/widgets/ProjectStatusChip";
import CanvasSection from "@/components/canvas/CanvasSection";
import CustomProperties from "@/components/build/CustomProperties";
import RelationProperties from "@/components/relations/RelationProperties";
import type { CanvasProps } from "@/lib/modules";
import { bodyMarkdown } from "@/lib/body";
import { resolveComposition, widgetLimit, widgetTitle, type Composition } from "@/lib/composition";
import { progressPct } from "@/lib/project-progress";
import { resolveStatusSchema } from "@/lib/status";
import { availableWidgets, customToolTypeKey } from "@/lib/widgets";
import { customToolDefs } from "@/lib/custom-tools";
import { parseTaskGroupBy, TASK_GROUP_MODES } from "@/lib/task-grouping";
import AddContainedItemButton from "@/components/canvas/widgets/AddContainedItemButton";
import RecordViewBeacon from "@/components/records/RecordViewBeacon";
import DigestControl from "@/components/canvas/DigestControl";
import { resolveRecordWidgets, type RecordWidgetData } from "@/lib/record-widgets";
import { getType } from "@/lib/types";

// Widgets that render in the header strip (no card, no title); everything else
// is a section card. Overview joined the header 2026-08-17 (Tyler): the
// project's one-paragraph identity reads directly under the title as an
// inline-editable block, not as a peer of the collection cards.
const HEADER_WIDGETS = new Set(["status", "people", "progress", "overview", "properties"]);

// Card title overrides — the Notes collection reads as "Docs" on a project
// (Tyler's wording), without renaming the widget everywhere else.
const CARD_TITLE: Record<string, string> = { notes: "Docs" };

// The sections a Project offers on the "+ Add section" menu (Tyler, 2026-07-01):
// the four defaults (so a removed one can return) plus Overview / Recent Activity
// / Timeline / Mindmap, and the header widgets (so a removed Status/People/
// Progress can be re-added). Mindmap is opt-in (added as a block, not a default).
const PROJECT_SECTIONS = new Set([
  "tasks",
  "milestones",
  "notes",
  "meetings",
  "links",
  "mindmap",
  "overview",
  "recentActivity",
  "timeline",
  "files",
  "status",
  "people",
  "progress",
  "properties",
]);

const CATEGORY_DOT: Record<string, string> = {
  not_started: "bg-neutral-500",
  in_progress: "bg-amber-500",
  done: "bg-green-500",
  archived: "bg-neutral-700",
};

function fmtDay(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function relTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const day = 86_400_000;
  if (diff < day) return "today";
  const days = Math.floor(diff / day);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-neutral-500">{children}</p>;
}

// `recordId` is optional so the unscoped/fallback uses stay unchanged; given
// it, a merely-related row wears the detach ✕ (ADR-232), like every other card.
function ItemList({ data, recordId }: { data: RecordWidgetData; recordId?: string }) {
  const items = data.items ?? [];
  if (items.length === 0) return <EmptyState>Nothing here yet.</EmptyState>;
  // Overflow ("+N more") is handled by the shared CardBody footer as a link into
  // the full collection page, so the list itself just renders its preview rows.
  return (
    <ul className="flex flex-col gap-1">
      {items.map((it) => {
        const day = fmtDay(it.scheduledDate ?? it.dueDate ?? it.meetingAt);
        const done = it.statusCategory === "done";
        return (
          <li key={it.id} className="flex items-center gap-2 text-sm">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CATEGORY_DOT[it.statusCategory] ?? "bg-neutral-600"}`} />
            <Link href={`/items/${it.id}`} className={`truncate hover:text-neutral-200 ${done ? "text-neutral-500 line-through" : "text-neutral-300"}`}>
              {it.title || "Untitled"}
            </Link>
            {day && <span className="ml-auto shrink-0 text-xs text-neutral-500">{day}</span>}
            {recordId && it.contained === false && (
              <DetachButton recordId={recordId} itemId={it.id} label={it.title} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// The header progress bar (weighted points; no title, per Tyler's spec).
function HeaderProgress({ data }: { data: RecordWidgetData }) {
  const p = data.progress;
  if (!p) return null;
  const pct = progressPct(p);
  return (
    <div className="flex max-w-2xl flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>{pct === null ? "Nothing to track yet" : `${pct}% complete`}</span>
      </div>
      {/* Track is a translucent step, not a fixed neutral: bg-neutral-800 was
          invisible against the peek modal's bg-surface-2 (Tyler, 2026-08-17). */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-700/50">
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

// A card widget that surfaces its own collection page (Tasks/Docs/Meetings/
// Milestones/Links, and Related Records) — the ones the drill-down + count gear
// apply to. People renders in the header, not a card, so it's excluded; so is
// Mindmap (cardinality "one" — a launcher, no "show N"/drill-down).
function isBucketWidget(data: RecordWidgetData): boolean {
  return (
    (Boolean(data.def.recordQuery?.collectionType) && data.def.cardinality === "many") ||
    data.def.id === "relatedRecords"
  );
}

// The card footer for a collection preview: when there are more items than the
// card shows, link into the full collection page (Tyler, 2026-07-01). The
// Timeline card drills into its own full chronological page instead.
function CardOverflowLink({ recordId, defId, shown, total }: { recordId: string; defId: string; shown: number; total: number }) {
  const href = defId === "timeline" ? `/items/${recordId}/timeline` : `/items/${recordId}/collection/${defId}`;
  return (
    <Link
      href={href}
      className="mt-2 inline-block text-xs text-neutral-500 transition-colors hover:text-neutral-300"
    >
      Showing {shown} of {total} →
    </Link>
  );
}

function CardBody(props: { data: RecordWidgetData; recordId: string; projectTitle: string; body: unknown }) {
  const { data, recordId } = props;
  const isTimeline = data.def.id === "timeline";
  const shown = isTimeline
    ? (data.timeline?.length ?? 0) + (data.timelineUndated?.length ?? 0)
    : (data.items?.length ?? 0);
  const total = data.count ?? shown;
  return (
    <>
      <WidgetInner {...props} />
      {(isBucketWidget(data) || isTimeline) && total > shown && (
        <CardOverflowLink recordId={recordId} defId={data.def.id} shown={shown} total={total} />
      )}
      {/* The review timeline is reachable even when nothing overflows (Tyler,
          2026-08-17 — a gear set to "All" used to eat the only link to it). */}
      {isTimeline && total > 0 && total <= shown && (
        <Link
          href={`/items/${recordId}/timeline`}
          className="mt-2 inline-block text-xs text-neutral-500 transition-colors hover:text-neutral-300"
        >
          Open timeline →
        </Link>
      )}
    </>
  );
}

function WidgetInner({
  data,
  recordId,
  projectTitle,
  body,
}: {
  data: RecordWidgetData;
  recordId: string;
  projectTitle: string;
  body: unknown;
}) {
  switch (data.def.id) {
    case "tasks":
      return (
        <TasksWidget
          recordId={recordId}
          projectTitle={projectTitle}
          items={(data.items ?? []).map((i) => ({ id: i.id, title: i.title, statusCategory: i.statusCategory, urgency: i.urgency, recurrence: i.recurrence, subtasks: i.subtasks ?? null, milestone: i.completesMilestone ?? null }))}
          doneCount={data.doneCount ?? 0}
          groupBy={parseTaskGroupBy(data.instance.options?.groupBy)}
        />
      );
    case "notes":
      return (
        <NotesWidget
          recordId={recordId}
          items={(data.items ?? []).map((i) => ({ id: i.id, title: i.title, contained: i.contained }))}
        />
      );
    case "links":
      return (
        <LinksWidget
          recordId={recordId}
          items={(data.items ?? []).map((i) => ({ id: i.id, title: i.title, url: i.url, contained: i.contained }))}
        />
      );
    case "files":
      // The record's attachments (ADR-236) — the shared FilePanel, same rows the
      // file type's canvas renders, so the card and the canvas can't drift.
      return <FilePanel itemId={recordId} initial={data.files ?? []} />;
    case "milestones":
      return (
        <MilestonesWidget
          recordId={recordId}
          items={(data.items ?? []).map((i) => ({
            id: i.id,
            title: i.title,
            dueDate: i.dueDate ? i.dueDate.toISOString() : null,
            // Mode + completion resolved server-side (ADR-196); fall back to
            // the row's own status if the milestone info is somehow missing.
            mode: i.milestone?.mode ?? (i.dueDate ? ("date" as const) : ("manual" as const)),
            done: i.milestone?.done ?? i.statusCategory === "done",
            via: i.milestone?.via ?? (i.statusCategory === "done" ? "manual" : null),
            taskId: i.milestone?.taskId ?? null,
            taskTitle: i.milestone?.taskTitle ?? null,
            taskDone: i.milestone?.taskDone ?? false,
            pct: i.milestone?.pct ?? 0,
          }))}
        />
      );
    case "meetings":
      return (
        <MeetingsWidget
          recordId={recordId}
          items={(data.items ?? []).map((i) => ({
            id: i.id,
            title: i.title,
            when: (i.meetingAt ?? i.scheduledDate ?? i.dueDate)?.toISOString() ?? null,
            contained: i.contained,
          }))}
        />
      );
    case "mindmap":
      return (
        <MindmapWidget
          recordId={recordId}
          items={(data.items ?? []).map((i) => ({ id: i.id, title: i.title, contained: i.contained }))}
        />
      );
    case "overview":
      return (
        <ItemEditor
          item={{ id: recordId, title: "", body: body as never }}
          slot="body"
          collapsibleToolbar
          compactBody
        />
      );
    case "nextAction": {
      // Not on the Project default anymore, but other widget-home types (Pursuit)
      // still carry it as a card.
      const na = data.nextAction;
      if (na?.taskId) {
        return (
          <Link href={`/items/${na.taskId}`} className={`text-sm hover:text-neutral-200 ${na.done ? "text-neutral-500 line-through" : "text-neutral-200"}`}>
            {na.taskTitle || "Untitled task"}
          </Link>
        );
      }
      if (na?.text) return <p className="text-sm text-neutral-200">{na.text}</p>;
      return <EmptyState>No next action set.</EmptyState>;
    }
    case "recentActivity": {
      const ev = data.activity ?? [];
      if (ev.length === 0) return <EmptyState>No activity yet.</EmptyState>;
      return (
        <ul className="flex flex-col gap-1.5">
          {ev.slice(0, 12).map((e) => (
            <li key={e.id} className="flex items-baseline gap-2 text-sm">
              <span className="truncate text-neutral-300">{e.summary}</span>
              <span className="ml-auto shrink-0 text-xs text-neutral-500">{relTime(e.occurredAt)}</span>
            </li>
          ))}
        </ul>
      );
    }
    case "timeline": {
      const entries = data.timeline ?? [];
      const undated = data.timelineUndated ?? [];
      if (entries.length === 0 && undated.length === 0) {
        return <EmptyState>No meetings or milestones yet.</EmptyState>;
      }
      return (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col gap-1 empty:hidden">
            {entries.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="flex items-center gap-2 text-sm">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${e.kind === "milestone" ? "bg-amber-950/50 text-amber-300" : "bg-sky-950/50 text-sky-300"}`}>
                  {e.kind}
                </span>
                <Link
                  href={`/items/${e.id}`}
                  className={`min-w-0 flex-1 truncate hover:text-neutral-100 ${e.done ? "text-neutral-500 line-through" : "text-neutral-200"}`}
                >
                  {e.title || "Untitled"}
                </Link>
                <span className="shrink-0 text-xs text-neutral-500">{fmtDay(e.date)}</span>
              </li>
            ))}
          </ul>
          {/* Open milestones with no date to plot (Tyler, 2026-08-17): they sit
              here until completed, when the completion stamp places them on the
              axis above at the day they finished. The group label defaults to
              "Upcoming" and is owner-configurable per type (Build → Tools). */}
          {undated.length > 0 && (
            <div className="mt-1 border-t border-neutral-800 pt-1.5">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">
                {typeof data.instance.options?.undatedLabel === "string" && data.instance.options.undatedLabel
                  ? data.instance.options.undatedLabel
                  : "Upcoming"}
              </p>
              <ul className="flex flex-col gap-1">
                {undated.map((u) => (
                  <li key={u.id} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0 rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">milestone</span>
                    <Link href={`/items/${u.id}`} className="min-w-0 flex-1 truncate text-neutral-200 hover:text-neutral-100">
                      {u.title || "Untitled"}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    }
    default: {
      // A custom-type tool (collection:<key>, 2026-08-17): the generic preview
      // rows plus the type's own "+ Add", which creates an item of that type
      // contained by this record and opens it — the Docs/Links launcher shape.
      const customType = customToolTypeKey(data.def.id);
      if (customType) {
        return (
          <div className="flex flex-col gap-2">
            <ItemList data={data} recordId={recordId} />
            <AddContainedItemButton
              recordId={recordId}
              type={customType}
              label={`Add ${data.def.label.toLowerCase()}`}
            />
          </div>
        );
      }
      // collection + relation widgets (relatedRecords, …)
      return <ItemList data={data} />;
    }
  }
}

// The "+ Add section" menu contents: catalog sections not already present, plus
// the owner's custom-type tools (settings.toolTypes → customToolDefs). For a
// Project we curate the CATALOG list (PROJECT_SECTIONS); custom tools always
// offer — designating a type as a tool is itself the curation.
function addableSections(
  type: string,
  comp: Composition,
  customDefs: { id: string; label: string }[]
): { id: string; label: string }[] {
  const present = new Set(comp.widgets.map((w) => w.defId));
  return [
    ...availableWidgets(type)
      .filter((w) => (type === "project" ? PROJECT_SECTIONS.has(w.id) : true))
      .map((w) => ({ id: w.id, label: CARD_TITLE[w.id] ?? w.label })),
    ...customDefs,
  ].filter((w) => !present.has(w.id));
}

export default async function WidgetCanvas({ item, ownerId, variant }: CanvasProps) {
  const typeDef = await getType(item.type).catch(() => null);
  const { composition } = resolveComposition(item.composition, typeDef?.defaultWidgets, item.type);
  const [widgets, customDefs] = await Promise.all([
    resolveRecordWidgets(ownerId, item, composition),
    customToolDefs(ownerId),
  ]);

  // Render order = composition array order (header widgets are pulled out by id).
  const headerWidgets = widgets.filter((d) => HEADER_WIDGETS.has(d.def.id));
  const cardWidgets = widgets.filter((d) => !HEADER_WIDGETS.has(d.def.id));

  const statusData = headerWidgets.find((d) => d.def.id === "status");
  const peopleData = headerWidgets.find((d) => d.def.id === "people");
  const progressData = headerWidgets.find((d) => d.def.id === "progress");
  const overviewData = headerWidgets.find((d) => d.def.id === "overview");
  // NEVER let written text be invisible. The canvas used to render the Overview
  // only when the composition carried the widget — but the 2026-07-01 project
  // redesign dropped `overview` from the default project layout, so every
  // project whose description lived in its body silently stopped showing it
  // (the text was still in the DB the whole time, just unreachable). The rule is
  // now: show the Overview when the layout asks for it, OR whenever the body has
  // content and the owner hasn't deliberately hidden the section. The `hidden`
  // check keeps defer-by-hiding intact — turning the section off still turns it
  // off — while an absent section can no longer swallow real text. Self-healing,
  // so no migration touches records.
  const overviewHidden = composition.widgets.some(
    (w) => w.defId === "overview" && w.hidden
  );
  const hasOverviewText = bodyMarkdown(item.body).trim().length > 0;
  const showOverview = Boolean(overviewData) || (hasOverviewText && !overviewHidden);

  // Properties, on the same self-healing rule as the Overview above and for the
  // same reason: this canvas rendered the type's custom fields NOWHERE, so a
  // Scope select added on Build was invisible and uneditable on every project
  // that had it (2026-09-14). A stored composition is never back-filled with a
  // new catalog widget (reconcileComposition only drops vanished ones), so
  // waiting for the composition to list it would leave every existing record
  // blind. Show it when the layout asks for it, OR whenever the type actually
  // defines fields and the owner hasn't deliberately hidden the section.
  const propertySchema = typeDef?.propertySchema ?? [];
  const propsObj = (item.properties as Record<string, unknown> | null) ?? {};
  const propertiesHidden = composition.widgets.some(
    (w) => w.defId === "properties" && w.hidden
  );
  const showProperties =
    headerWidgets.some((d) => d.def.id === "properties") ||
    (propertySchema.length > 0 && !propertiesHidden);
  // A locked record (items.properties.locked, the canvas "⋯" menu) renders its
  // fields read-only, matching MarkdownCanvas.
  const locked = Boolean(propsObj.locked);

  const statuses = resolveStatusSchema(typeDef?.statusSchema ?? null);
  const statusMode = typeDef?.statusMode ?? "checkbox";
  const showStatus = Boolean(statusData) && statusMode !== "none" && statuses.length > 0;

  const hasHeader = showStatus || Boolean(peopleData) || Boolean(progressData);
  const addable = addableSections(
    item.type,
    composition,
    customDefs.map((d) => ({ id: d.id, label: d.label }))
  );

  return (
    // Same container as the breadcrumb row + the other canvases (max-w-3xl,
    // widened to ~5xl by .canvas-wide on the full page) so the header/title and
    // cards line up exactly with the "Trash · Project · ⋯" row above (Tyler).
    <div className="mx-auto w-full max-w-3xl px-2 pb-24 pt-4 sm:px-8 md:px-12">
      <div className="mb-3 min-w-0">
        <ItemEditor item={{ id: item.id, title: item.title, body: item.body }} slot="title" />
      </div>

      {/* Overview sits directly under the title (Tyler, 2026-08-17): rendered
          only when written; empty, it collapses to a small lines-glyph button
          that expands the editor (HeaderOverview). */}
      {showOverview && (
        // The overview reads a couple of points smaller than the note canvas
        // (John, 2026-09-23: "the text under the project ... is very large").
        // Two nested vars because a custom property cannot reference itself on
        // the same element; the outer captures the owner's prose size, the inner
        // steps it down 2px for everything inside.
        <div
          className="mb-4 min-w-0"
          style={{ "--overview-base": "var(--prose-font-size, 1rem)" } as React.CSSProperties}
        >
          <div style={{ "--prose-font-size": "calc(var(--overview-base) - 2px)" } as React.CSSProperties}>
          <HeaderOverview
            itemId={item.id}
            body={item.body}
            hasContent={hasOverviewText}
          />
          </div>
        </div>
      )}

      {hasHeader && (
        // Progress on top spanning the header (Tyler, 2026-07-01), then People on
        // the left and the Status pill on the right beneath it.
        <div className="mb-5 flex flex-col gap-3">
          {progressData && <HeaderProgress data={progressData} />}
          {(peopleData || showStatus) && (
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                {peopleData && (
                  <ProjectPeople
                    recordId={item.id}
                    people={(peopleData.items ?? []).map((p) => ({ id: p.id, title: p.title, image: p.image }))}
                  />
                )}
              </div>
              {showStatus && (
                // The completion checkbox rides ABOVE the status pill, both
                // right-aligned: the checkbox is the one-gesture "this is
                // finished" (it also completes what's open inside — see
                // ProjectDoneCheckbox), the pill is the full stage picker. Only
                // shown when the type actually defines a Done status, since the
                // checkbox has nothing to complete to otherwise.
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {statuses.some((st) => st.category === "done") && (
                    <ProjectDoneCheckbox
                      itemId={item.id}
                      statuses={statuses}
                      status={item.status}
                    />
                  )}
                  <ProjectStatusChip itemId={item.id} statuses={statuses} initial={item.status} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {cardWidgets.length === 0 ? (
        <EmptyState>No sections yet. Use “Add section” below to add one.</EmptyState>
      ) : (
        <SectionGrid
          itemId={item.id}
          composition={composition}
          variant={variant}
          items={cardWidgets.map((data) => {
            // A per-record rename (the gear's Rename, options.title) wins over
            // the catalog default (2026-08-19).
            const defaultTitle = CARD_TITLE[data.def.id] ?? data.def.label;
            const customTitle = widgetTitle(data.instance);
            return {
              instanceId: data.instance.instanceId,
              title: customTitle ?? defaultTitle,
              defaultTitle,
              customTitle,
              body: <CardBody data={data} recordId={item.id} projectTitle={item.title} body={item.body} />,
              // Collection/related cards and the Timeline get the "show N"
              // count section in the gear (default 5); Status / derived
              // single-value cards get the gear (Rename) without it.
              countLimit:
                isBucketWidget(data) || data.def.id === "timeline"
                  ? widgetLimit(data.instance)
                  : undefined,
              // The Tasks card's gear also offers "Group by" (2026-08-17).
              ...(data.def.id === "tasks"
                ? {
                    groupChoices: [...TASK_GROUP_MODES],
                    groupCurrent: parseTaskGroupBy(data.instance.options?.groupBy),
                  }
                : {}),
            };
          })}
        />
      )}

      {/* The type's own fields: scalar ones over items.properties, relation ones
          over relation edges, the same pairing MarkdownCanvas uses so a field
          behaves identically wherever its type happens to render. Image-kind
          properties are excluded for the same reason as there: they get their
          own box rather than a text row.

          BELOW the tool cards, not above them (Tyler, 2026-09-14): the cards are
          what a project is read for, and a field strip between the header and
          the grid pushed them down the page. `wide` lays the fields out across
          the full width instead of one narrow column, which left most of the
          row empty on this canvas. */}
      {showProperties && propertySchema.length > 0 && (
        <CanvasSection icon="properties" title="Properties" className="mt-5 mb-5">
          <div className="flex flex-col gap-3">
            <CustomProperties
              itemId={item.id}
              typeKey={item.type}
              schema={propertySchema.filter((pr) => pr.kind !== "image")}
              initial={propsObj}
              locked={locked}
              hideHeading
              bare
              wide
            />
            <RelationProperties
              ownerId={ownerId}
              itemId={item.id}
              typeKey={item.type}
              props={propertySchema}
              hideHeading
            />
          </div>
        </CanvasSection>
      )}

      <div className="flex items-center justify-between gap-3">
        <AddSectionButton itemId={item.id} composition={composition} addable={addable} />
        {/* Per-record quiet-surfacing control (tracked container types only). */}
        {(item.type === "project" || item.type === "pursuit") && (
          <DigestControl itemId={item.id} composition={composition} />
        )}
      </div>
      {/* Looking at the record IS the check-in (Tyler, 2026-08-17): the beacon
          resets the Digest staleness clock so an actively-read project never
          surfaces as "gone quiet." Throttled server-side to one stamp / 12h. */}
      <RecordViewBeacon itemId={item.id} />
    </div>
  );
}
