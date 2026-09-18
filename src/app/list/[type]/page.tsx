// Generic focused list for one type (slice 33 follow-up, ADR-044): the
// destination for a custom type and for People. The five system types have
// their own bespoke pages (/tasks etc.); every other type renders here — a
// plain list of its live items with create/open/trash. notFound() for an
// unknown type key.
//
// Every type's list carries the customizable tab strip ("list lenses",
// ListLenses): four virtual sort defaults (Recent / Newest / A→Z / Most linked)
// plus any the owner added in Build, including saved-view ("widget") tabs. The
// active lens decides the body: a sort lens orders this plain list; a view lens
// renders its saved view via ViewRenderer (scoped to the type).
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import FilterBar, { type FilterSelect } from "@/components/lists/FilterBar";
import ListLenses from "@/components/lists/ListLenses";
import ListPage from "@/components/lists/ListPage";
import LoadMore from "@/components/lists/LoadMore";
import ViewLensBody from "@/components/lists/ViewLensBody";
import CompletedLensBody from "@/components/lists/CompletedLensBody";
import CalendarFeed from "@/components/calendar/CalendarFeed";
import EventTimeline from "@/components/events/EventTimeline";
import { listCalendarFeed, type FeedEvent } from "@/lib/calendar/feed";
import NewItemButton from "@/components/home/NewItemButton";
import ProjectCardGrid from "@/components/projects/ProjectCardGrid";
import RowMenu from "@/components/lists/RowMenu";
import SwipeRow from "@/components/lists/SwipeRow";
import BulkActionBar from "@/components/selection/BulkActionBar";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import SelectionProvider from "@/components/selection/SelectionProvider";
import SelectModeToggle from "@/components/selection/SelectModeToggle";
import SubtaskExpandableRow from "@/components/subtasks/SubtaskExpandableRow";
import { childRollups } from "@/lib/subtasks";
import { bulkConfigForType } from "@/lib/bulk-config";
import { ItemError } from "@/lib/items";
import { lensesForType, resolveLensSort, selectLens } from "@/lib/list-lenses";
import { relatedSummaryFor } from "@/lib/relations";
import { appTodayYmd } from "@/lib/recurrence-service";
import { DEFAULT_TIMEZONE } from "@/lib/today";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import { getType } from "@/lib/types";
import { listProjectCardData } from "@/lib/project-cards";
import { resolveProjectCardConfig } from "@/lib/project-card-config";
import { resolveSyntheticLens, resolveViewLens } from "@/lib/view-render";
import {
  countViewItems,
  parseListWindow,
  PROPERTY_FILTER_NONE,
  propertyFilterOptions,
  propertyFiltersFromParams,
  queryViewItems,
} from "@/lib/views";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export default async function TypeList({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const { type } = await params;
  const typeDef = await getType(type).catch((err) => {
    if (err instanceof ItemError && err.code === "not_found") notFound();
    throw err;
  });

  const sp = await searchParams;
  const now = new Date();
  const settings = await getSettings(owner.id);
  const tz = settings.timezone ?? DEFAULT_TIMEZONE;
  const lenses = lensesForType(settings, type);
  const active = selectLens(lenses, typeof sp.lens === "string" ? sp.lens : undefined);
  const reversed = sp.rev === "1";

  // A view lens renders its saved view; a missing/deleted view (null) falls back
  // to the default sorted list below.
  // A view lens renders its saved view; the BOARD and COMPLETED lenses render a
  // view definition synthesized from the type (no saved view needed, so a type
  // can ship a kanban as its default tab). All three land in the same
  // ViewRenderer pipeline below.
  const viewData =
    active.kind === "view"
      ? await resolveViewLens(owner.id, active.viewId, type)
      : active.kind === "board" || active.kind === "completed"
        ? await resolveSyntheticLens(owner.id, type, active.kind, active.label)
        : null;

  // Sort path: the type's select/multi_select properties become list filters,
  // and the active sort lens (reversible) orders a window of rows (Load-more
  // grows it). The count is the true match total (filters included). Bespoke
  // lenses (calendar/timeline) ignore the sort and render their own body.
  const filterProps = propertyFilterOptions(typeDef.propertySchema);
  const propFilters = propertyFiltersFromParams(sp, typeDef.propertySchema);
  const filter = { type, ...(propFilters.length ? { propertyFilters: propFilters } : {}) };
  const show = parseListWindow(sp.show);
  let items: Awaited<ReturnType<typeof queryViewItems>> = [];
  let count: number;
  let feed: FeedEvent[] | null = null;
  // Timeline: one meeting-time-ordered fetch, split into upcoming/past/undated.
  let timeline: {
    rows: Awaited<ReturnType<typeof queryViewItems>>;
    upcoming: Awaited<ReturnType<typeof queryViewItems>>;
    past: Awaited<ReturnType<typeof queryViewItems>>;
    undated: Awaited<ReturnType<typeof queryViewItems>>;
  } | null = null;
  if (viewData) {
    count = viewData.count;
  } else if (active.kind === "calendar") {
    [feed, count] = await Promise.all([
      listCalendarFeed(owner.id, { now }),
      countViewItems(owner.id, filter),
    ]);
  } else if (active.kind === "timeline") {
    let rows: Awaited<ReturnType<typeof queryViewItems>>;
    [rows, count] = await Promise.all([
      queryViewItems(owner.id, filter, { field: "meetingAt", dir: "desc" }, show),
      countViewItems(owner.id, filter),
    ]);
    timeline = {
      rows,
      upcoming: rows.filter((m) => m.meetingAt != null && m.meetingAt >= now).reverse(),
      past: rows.filter((m) => m.meetingAt != null && m.meetingAt < now),
      undated: rows.filter((m) => m.meetingAt == null),
    };
  } else {
    [items, count] = await Promise.all([
      queryViewItems(owner.id, filter, resolveLensSort(active, reversed) ?? undefined, show),
      countViewItems(owner.id, filter),
    ]);
  }

  // The Projects list renders as a card grid (Tyler, 2026-07-01) on the default
  // sort path; a saved view lens still renders via ViewRenderer (which resolves
  // its own project cards for a project-scoped list/board lens). The card's
  // element set is the owner's type default (Build → Types → Project → "Card
  // elements"), falling back to the classic card.
  const cardConfig = resolveProjectCardConfig(null, settings.cardsByType["project"]);
  const projectCards =
    type === "project" && !viewData && items.length > 0
      ? await listProjectCardData(owner.id, items, cardConfig, new Set(settings.favorites))
      : [];

  // Subtask "n/m" rollups + a linked-item summary for the in-view rows (empty
  // for the non-list lenses, which leave `items` empty). Two extra owner-scoped,
  // body-free queries. The linked summary powers the richer row (ui-refresh S2):
  // now that the list uses the full width, each row shows who it's linked to and
  // when it was touched instead of a lone title on a mostly-empty line. Skipped
  // for the Projects card grid (it renders its own richer cards).
  const rowIds = type === "project" ? [] : items.map((i) => i.id);
  const [rollups, linked] = await Promise.all([
    childRollups(owner.id, items.map((i) => i.id)),
    rowIds.length
      ? relatedSummaryFor(owner.id, rowIds)
      : Promise.resolve(new Map<string, { id: string; title: string; type: string }[]>()),
  ]);
  const listRowClass = "group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2";
  // App-timezone today for the row menu's Focus + Schedule quick-dates (S4).
  const today = appTodayYmd(now, tz);

  const selects: FilterSelect[] = filterProps.map((fp) => ({
    param: `prop_${fp.key}`,
    label: fp.label,
    options: [
      { value: "", label: "any" },
      ...fp.options.map((o) => ({ value: o, label: o })),
      { value: PROPERTY_FILTER_NONE, label: "not set" },
    ],
  }));

  return (
    <ListPage
      tab={type}
      title={typeDef.label}
      subtitle={`${count} item${count === 1 ? "" : "s"}`}
      actions={<NewItemButton type={type} />}
      width="list"
    >
      <ListLenses
        lenses={lenses}
        activeId={active.id}
        reversed={reversed}
        basePath={`/list/${type}`}
        params={sp}
        editHref={`/build/types/${type}/edit`}
      />
      {viewData && active.kind === "completed" ? (
        // Completed work gets the search box instead of the bulk-select layer:
        // the job here is finding one finished thing again, not acting on many.
        <CompletedLensBody data={viewData} ownerId={owner.id} typeLabel={typeDef.label} />
      ) : viewData ? (
        <ViewLensBody data={viewData} bulkConfig={bulkConfigForType(typeDef)} ownerId={owner.id} />
      ) : active.kind === "calendar" ? (
        <CalendarFeed events={feed ?? []} now={now} tz={tz} />
      ) : timeline ? (
        <SelectionProvider
          ids={[...timeline.upcoming, ...timeline.past, ...timeline.undated].map((m) => m.id)}
        >
          <SelectModeToggle />
          <EventTimeline
            upcoming={timeline.upcoming}
            past={timeline.past}
            undated={timeline.undated}
            now={now}
            tz={tz}
          />
          <LoadMore
            shown={timeline.rows.length}
            total={count}
            basePath={`/list/${type}`}
            params={sp}
          />
          <BulkActionBar {...bulkConfigForType(typeDef)} />
        </SelectionProvider>
      ) : (
        <>
          {selects.length > 0 && (
            <div className="mt-4">
              <FilterBar selects={selects} />
            </div>
          )}
          {items.length > 0 && type === "project" ? (
            <>
              <ProjectCardGrid cards={projectCards} config={cardConfig} />
              <LoadMore shown={items.length} total={count} basePath={`/list/${type}`} params={sp} />
            </>
          ) : items.length > 0 ? (
            <SelectionProvider ids={items.map((item) => item.id)}>
              <SelectModeToggle />
              <ul className="mt-4">
                {items.map((item) => {
                  const rollup = rollups.get(item.id);
                  const rel = linked.get(item.id) ?? [];
                  const extra = rel.length > 1 ? rel.length - 1 : 0;
                  const isTask = item.type === "task";
                  const menuOpts = {
                    id: item.id,
                    canComplete: isTask,
                    done: item.statusCategory === "done",
                    today,
                    label: item.title || "Untitled",
                  };
                  const inner = (
                    <>
                      <SelectCheckbox id={item.id} />
                      <Link
                        href={`/items/${item.id}`}
                        data-peek-row
                        className={`ui-row min-w-0 flex-1 truncate ${
                          item.title ? "text-ink" : "text-ink-subtle"
                        }`}
                      >
                        {item.title || "Untitled"}
                      </Link>
                      {rel[0] && (
                        <Link
                          href={`/items/${rel[0].id}`}
                          className="hidden shrink-0 max-w-[28%] truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-muted hover:text-ink sm:inline"
                          title={`Linked to ${rel[0].title || "Untitled"}${extra ? ` +${extra} more` : ""}`}
                        >
                          {rel[0].title || "Untitled"}
                          {extra ? ` +${extra}` : ""}
                        </Link>
                      )}
                      <span className="ui-meta shrink-0 tabular-nums">
                        {dateFmt.format(new Date(item.updatedAt))}
                      </span>
                    </>
                  );
                  // Trash + Complete/Focus/Schedule now live in the shared row
                  // menu (right-click / long-press), not an always-visible button.
                  return rollup && rollup.total > 0 ? (
                    <SubtaskExpandableRow
                      key={item.id}
                      id={item.id}
                      done={rollup.done}
                      total={rollup.total}
                      liClassName={listRowClass}
                      menuOptions={menuOpts}
                    >
                      {inner}
                    </SubtaskExpandableRow>
                  ) : isTask ? (
                    // Task rows get swipe (right = complete, left = schedule) on
                    // top of the shared menu; other types get the menu only.
                    <SwipeRow key={item.id} className={listRowClass} {...menuOpts}>
                      {inner}
                    </SwipeRow>
                  ) : (
                    <RowMenu key={item.id} className={listRowClass} {...menuOpts}>
                      {inner}
                    </RowMenu>
                  );
                })}
              </ul>
              <LoadMore shown={items.length} total={count} basePath={`/list/${type}`} params={sp} />
              <BulkActionBar {...bulkConfigForType(typeDef)} />
            </SelectionProvider>
          ) : (
            <p className="ui-row mt-6 px-2 text-ink-subtle">
              {propFilters.length
                ? "No items match these filters."
                : `No ${typeDef.label.toLowerCase()} items yet.`}
            </p>
          )}
        </>
      )}
    </ListPage>
  );
}
