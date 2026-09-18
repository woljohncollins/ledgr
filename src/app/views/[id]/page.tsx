// A stored view's rendered output (slice 27): run the definition's filter +
// sort through the shared owner-scoped, body-free query, then hand the rows to
// the layout renderer. Same query path as the per-type list pages, so a view
// can never select a body or leak across owners.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ViewRenderer from "@/components/views/ViewRenderer";
import { DeskHostProvider } from "@/components/desk/DeskHostContext";
import DuplicateViewButton from "@/components/views/DuplicateViewButton";
import NewItemButton from "@/components/home/NewItemButton";
import BulkActionBar from "@/components/selection/BulkActionBar";
import SelectionProvider from "@/components/selection/SelectionProvider";
import SelectModeToggle from "@/components/selection/SelectModeToggle";
import { bulkConfigForType } from "@/lib/bulk-config";
import { ItemError } from "@/lib/items";
import { resolveOwner } from "@/lib/owner";
import { getAppTimezone } from "@/lib/today";
import { appTodayYmd } from "@/lib/recurrence-service";
import { getType } from "@/lib/types";
import { orderedStatuses, resolveStatusSchema } from "@/lib/status";
import { getView, queryViewItems } from "@/lib/views";
import { projectCardsForView } from "@/lib/project-cards";
import { outgoingRelationsBySource } from "@/lib/relations";
import { childRollups } from "@/lib/subtasks";
import { listCalendarEventsForRange } from "@/lib/calendar/feed";
import { overlayWindow } from "@/lib/calendar/overlay";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ViewPage({ params, searchParams }: Context) {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const { id } = await params;
  const sp = await searchParams;
  // Calendar month to show (the layout's prev/next links set this); ignore
  // anything not YYYY-MM so a junk param falls back to the current month.
  const month =
    typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month)
      ? sp.month
      : undefined;
  let view;
  try {
    view = await getView(owner.id, id);
  } catch (err) {
    if (err instanceof ItemError) notFound();
    throw err;
  }

  const items = await queryViewItems(owner.id, view.filter, view.sort);
  const rollups = await childRollups(owner.id, items.map((i) => i.id));
  const tz = await getAppTimezone(owner.id);
  // Rich project cards (2026-08-17): a project-scoped list/board view renders
  // the configured card (view override → type default → the classic card).
  const projectCards = await projectCardsForView(owner.id, view, items);

  // The read-only calendar overlay is only meaningful on a writable calendar
  // (one that places tasks on scheduled/due/plan — the interactive PlannerCalendar
  // branch). Skip the query for every other layout/date-property.
  const dp = view.dateProperty;
  const overlayApplies =
    view.layout === "calendar" &&
    (dp == null || dp === "plan" || dp === "scheduledDate" || dp === "dueDate");
  let calendarEvents;
  if (overlayApplies) {
    const win = overlayWindow(month);
    calendarEvents = await listCalendarEventsForRange(owner.id, win.start, win.end);
  }

  // Load the view's type once: it powers both the board's column order (group
  // by a custom property) and the labels for any custom-property columns.
  const type = view.filter.type
    ? await getType(view.filter.type).catch(() => null)
    : null;

  // For a board grouped by a custom property, order its columns by the type's
  // option list (a workflow board reads Applied → Interview → Offer, not
  // alphabetically). Falls back to present-value order if the type/prop is gone.
  // The type's resolved statuses (S2): status chips + a status board's column
  // labels/colors render from these.
  const statuses = resolveStatusSchema(type?.statusSchema ?? null);

  let groupOrder: string[] | undefined;
  const grouping = view.grouping;
  if (grouping && "propertyKey" in grouping) {
    groupOrder = type?.propertySchema.find(
      (p) => p.key === grouping.propertyKey
    )?.options;
  } else if (!grouping || ("field" in grouping && grouping.field === "status")) {
    // A status board shows every status as a column, in the type's schema order.
    // Category order, not the raw authored order (see view-render.ts).
    groupOrder = orderedStatuses(statuses).map((s) => s.key);
  }

  // A board's cards can be dragged between columns only when a drop maps to a
  // single clean value: a status/urgency field (the default board groups by
  // status), or a single-select property. Computed `due` buckets, `type`, and
  // multi_select stay read-only.
  const groupPropKind =
    grouping && "propertyKey" in grouping
      ? type?.propertySchema.find((p) => p.key === grouping.propertyKey)?.kind
      : null;
  const fieldGroup =
    !grouping || "field" in grouping ? grouping?.field ?? "status" : null;
  const boardDraggable =
    view.layout === "board" &&
    (fieldGroup === "status" ||
      fieldGroup === "urgency" ||
      groupPropKind === "select");

  // key → label for the type's custom properties, so a property column reads
  // "Stage", not "stage".
  const propertyLabels: Record<string, string> = {};
  // key → kind alongside it, so a phone/email column renders dialable (ADR-192).
  const propertyKinds: Record<string, string> = {};
  for (const p of type?.propertySchema ?? []) {
    propertyLabels[p.key] = p.label;
    propertyKinds[p.key] = p.kind;
  }

  // Group-by-Tags: the column values are `relations` edges, not row data, so they
  // need their own batched read. Fetched ONLY for a relation grouping — every other
  // grouping reads the row it already has, and this would be a wasted query.
  const groupEdges =
    grouping && "relationRole" in grouping
      ? await outgoingRelationsBySource(
          owner.id,
          items.map((i) => i.id),
          grouping.relationRole
        )
      : undefined;

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-12">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
            {view.name}
          </h1>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/views" className="text-neutral-500 hover:text-neutral-300">
              ← All views
            </Link>
            {view.filter.type && <NewItemButton type={view.filter.type} />}
            {!view.isSystem && (
              <Link
                href={`/views/${view.id}/edit`}
                className="text-neutral-400 hover:text-neutral-200"
              >
                Edit
              </Link>
            )}
            {/* Always available — the only way to customize a built-in (system)
                view, which can't be edited in place. */}
            <DuplicateViewButton
              input={{
                name: view.name,
                filter: view.filter,
                sort: view.sort,
                grouping: view.grouping,
                columns: view.columns,
                layout: view.layout,
                dateProperty: view.dateProperty,
              }}
            />
          </div>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {items.length} item{items.length === 1 ? "" : "s"} · {view.layout}
        </p>

        <SelectionProvider ids={items.map((item) => item.id)}>
          {/* Board/calendar render no row checkboxes (ADR-118), so they get no
              select toggle either — list/table/agenda do. The project-card grid
              is a gallery layout, same exception. */}
          {view.layout !== "board" && view.layout !== "calendar" && !projectCards && (
            <SelectModeToggle />
          )}
          <DeskHostProvider
            host={{ kind: "view", viewId: view.id, title: view.name }}
          >
            <ViewRenderer
              view={view}
              items={items}
              groupEdges={groupEdges}
              groupOrder={groupOrder}
              propertyLabels={propertyLabels}
              propertyKinds={propertyKinds}
              boardDraggable={boardDraggable}
              statuses={statuses}
              month={month}
              calendarNavHref={`/views/${view.id}`}
              calendarEvents={calendarEvents}
              selectable
              rollups={rollups}
              today={appTodayYmd(new Date(), tz)}
              tz={tz}
              projectCards={projectCards ?? undefined}
            />
          </DeskHostProvider>
          <BulkActionBar {...(type ? bulkConfigForType(type) : {})} />
        </SelectionProvider>
      </div>
    </main>
  );
}
