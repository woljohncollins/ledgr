// Related-panel render path: structure one type group of an item's related
// items with the owner's chosen lens, rendered through the same ViewRenderer the
// list pages and dashboards use. The group is scoped with ViewFilter.relatedTo
// (the pre-existing "items related to this host, either direction, confirmed
// edges" predicate) plus the group's type, so a saved lens/view reuses verbatim
// — no parallel sort/filter/group machinery. Mirrors view-render.ts's
// orchestration (getView → scope → query + count + grouping) and adds the
// relation scope; body-free and owner-scoped by construction.
import type { ViewItem } from "@/components/views/ViewRenderer";
import { ItemError } from "@/lib/items";
import { resolveLensSort, type Lens } from "@/lib/list-lenses";
import { orderedStatuses, resolveStatusSchema } from "@/lib/status";
import { getType } from "@/lib/types";
import type { ViewLensData } from "@/lib/view-render";
import {
  countViewItems,
  getView,
  queryViewItems,
  VIEW_LIMIT,
  type ListSort,
  type ViewDefinition,
  type ViewFilter,
} from "@/lib/views";

// A row in the shape queryViewItems returns (and resolveEventTaskPull et al.
// hand back) — exactly what toViewItem consumes.
type ResolvedRow = Awaited<ReturnType<typeof queryViewItems>>[number];

// A related group is always one type and always scoped to the host. Override any
// type the view pinned (the group's type wins) and always set relatedTo, so a
// generic lens ("Recent") becomes "this type, related to this item, recent".
function applyRelationScope(filter: ViewFilter, hostId: string, typeKey: string): ViewFilter {
  return { ...filter, type: typeKey, relatedTo: hostId };
}

function toViewItem(i: Awaited<ReturnType<typeof queryViewItems>>[number]): ViewItem {
  return {
    id: i.id,
    type: i.type,
    title: i.title,
    status: i.status,
    statusCategory: i.statusCategory,
    dueDate: i.dueDate,
    scheduledDate: i.scheduledDate,
    urgency: i.urgency,
    meetingAt: i.meetingAt,
    endAt: i.endAt,
    noteDate: i.noteDate,
    url: i.url,
    properties: i.properties,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

// Board column order (for a custom-property grouping) + property labels resolved
// from the group's type — the same metadata view-render.ts computes.
async function groupingFor(typeKey: string, view: ViewDefinition) {
  const type = await getType(typeKey).catch(() => null);
  const statuses = resolveStatusSchema(type?.statusSchema ?? null);
  let groupOrder: string[] | undefined;
  const g = view.grouping;
  if (g && "propertyKey" in g) {
    groupOrder = type?.propertySchema.find((p) => p.key === g.propertyKey)?.options;
  } else if (!g || ("field" in g && g.field === "status")) {
    // Status boards order + label their columns from the type's schema (see the
    // same branch in view-render.ts). Third of the three call sites.
    // Category order, not the raw authored order (see view-render.ts).
    groupOrder = orderedStatuses(statuses).map((s) => s.key);
  }
  const propertyLabels: Record<string, string> = {};
  const propertyKinds: Record<string, string> = {};
  for (const p of type?.propertySchema ?? []) {
    propertyLabels[p.key] = p.label;
    propertyKinds[p.key] = p.kind;
  }
  return { groupOrder, propertyLabels, propertyKinds, statuses };
}

// --- Provided-rows path (rule-pulled groups) ------------------------------
// The meeting "Open tasks" panel (ADR-094 E4) decides its membership by a PULL
// RULE (tasks related to anyone on the event, or by tag), not a ViewFilter — so
// queryViewItems can neither scope nor order it. resolveProvidedGroup renders
// such an in-hand row set through the SAME ViewLensData the lens machinery
// produces, so MeetingPrep reuses ViewRenderer + the multi-select layer instead
// of a bespoke list. A SORT lens contributes ORDER only (applied in memory); the
// rule already chose the rows, so we deliberately keep the plain list layout and
// never apply a view lens's filter here (it would drop rule-pulled rows).

// Sort an in-hand row set by a SORT lens's ListSort, in memory. Mirrors the
// engine's rules: dates/numbers compare naturally with NULLs last in both
// directions; title/select are locale compares. "mostLinked" needs a relation
// count the rows don't carry, so it leaves the given order untouched.
function sortKey(item: ViewItem, sort: ListSort): number | string | null {
  if (sort.field === "property") {
    const v = (item.properties as Record<string, unknown> | null)?.[sort.propertyKey];
    if (v == null) return null;
    return sort.numeric ? Number(v) : String(v);
  }
  switch (sort.field) {
    case "plan":
      return (item.scheduledDate ?? item.dueDate)?.getTime() ?? null;
    case "dueDate":
      return item.dueDate?.getTime() ?? null;
    case "scheduledDate":
      return item.scheduledDate?.getTime() ?? null;
    case "meetingAt":
      return item.meetingAt?.getTime() ?? null;
    case "updatedAt":
      return item.updatedAt.getTime();
    case "createdAt":
      return item.createdAt.getTime();
    case "title":
      return item.title || "";
    default:
      return null; // mostLinked — not computable from a body-free row
  }
}

function sortInMemory(items: ViewItem[], sort: ListSort): ViewItem[] {
  if (sort.field === "mostLinked") return items; // keep the rule's order
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = sortKey(a, sort);
    const bv = sortKey(b, sort);
    if (av === bv) return 0;
    if (av === null) return 1; // nulls last, both directions
    if (bv === null) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return mul * String(av).localeCompare(String(bv));
    }
    return mul * (av - bv);
  });
}

// Render a group whose ROWS are resolved upstream (membership decided by a rule,
// not a ViewFilter) through the chosen SORT lens. Body-free + owner-scoped by
// construction (the caller's rows already are). View lenses don't apply to a
// rule-pulled set (their filter would fight the rule), so the caller passes only
// sort lenses; a non-sort lens falls back to the lens's natural order via a
// harmless default sort.
export async function resolveProvidedGroup(
  rows: ResolvedRow[],
  typeKey: string,
  lens: Lens,
  hideCompleted = false,
  limit = VIEW_LIMIT
): Promise<ViewLensData> {
  const sort = resolveLensSort(lens, false) ?? { field: "updatedAt", dir: "desc" };
  const mapped = rows.map(toViewItem);
  const live = hideCompleted ? mapped.filter((i) => i.statusCategory !== "done") : mapped;
  const items = sortInMemory(live, sort).slice(0, limit);
  const view: ViewDefinition = {
    id: `provided:${typeKey}:${lens.id}`,
    name: lens.label,
    isSystem: true,
    filter: {},
    sort: { field: "updatedAt", dir: "desc" }, // display-only; ViewRenderer sorts nothing
    grouping: null,
    columns: null,
    layout: "list",
    dateProperty: null,
    display: null,
    createdAt: new Date(),
  };
  const grouping = await groupingFor(typeKey, view);
  return {
    view,
    items,
    count: items.length,
    groupOrder: grouping.groupOrder,
    propertyLabels: grouping.propertyLabels,
    propertyKinds: grouping.propertyKinds,
  };
}

// Resolve one related-type group for rendering with the chosen lens. A view lens
// reuses the saved view's filter/sort/grouping/layout/columns; a sort lens
// renders a plain list in the lens's order. Returns null when a view lens points
// at a deleted view, so the caller falls back to the type's default lens.
export async function resolveRelatedGroup(
  ownerId: string,
  hostId: string,
  typeKey: string,
  lens: Lens,
  // Drop completed (done-category) items so the group reads as live work — the
  // related panel's long-standing default. The caller passes true only for the
  // generic sort lenses; a view lens owns its own status filter, so it's left to
  // show exactly what it filters (e.g. a deliberate "Completed" view).
  hideCompleted = false,
  limit = VIEW_LIMIT
): Promise<ViewLensData | null> {
  if (lens.kind === "view") {
    let view: ViewDefinition;
    try {
      view = await getView(ownerId, lens.viewId);
    } catch (err) {
      if (err instanceof ItemError && err.code === "not_found") return null;
      throw err;
    }
    const scoped: ViewDefinition = {
      ...view,
      filter: applyRelationScope(view.filter, hostId, typeKey),
    };
    const [rows, count, grouping] = await Promise.all([
      queryViewItems(ownerId, scoped.filter, view.sort, limit),
      countViewItems(ownerId, scoped.filter),
      groupingFor(typeKey, scoped),
    ]);
    const items = rows.map(toViewItem);
    const visible = hideCompleted
      ? items.filter((i) => i.statusCategory !== "done")
      : items;
    return {
      view: scoped,
      items: visible,
      count: hideCompleted ? visible.length : count,
      groupOrder: grouping.groupOrder,
      propertyLabels: grouping.propertyLabels,
      propertyKinds: grouping.propertyKinds,
    };
  }

  // Sort lens: a plain list in the lens's order. resolveLensSort returns a
  // ListSort (the superset queryViewItems accepts); the synthetic view's own
  // `sort` field is display-only (ViewRenderer sorts nothing), so a harmless
  // default is fine there. A bespoke lens (calendar/timeline) has no sort and
  // shouldn't reach here — related groups filter them out (relatedLensCandidates)
  // — but default it defensively rather than assert non-null.
  const sort = resolveLensSort(lens, false) ?? { field: "updatedAt", dir: "desc" };
  const filter = applyRelationScope({}, hostId, typeKey);
  const view: ViewDefinition = {
    id: `related:${typeKey}:${lens.id}`,
    name: lens.label,
    isSystem: true,
    filter,
    sort: { field: "updatedAt", dir: "desc" },
    grouping: null,
    columns: null,
    layout: "list",
    dateProperty: null,
    display: null,
    createdAt: new Date(),
  };
  const [rows, count, grouping] = await Promise.all([
    queryViewItems(ownerId, filter, sort, limit),
    countViewItems(ownerId, filter),
    groupingFor(typeKey, view),
  ]);
  const items = rows.map(toViewItem);
  const visible = hideCompleted
    ? items.filter((i) => i.statusCategory !== "done")
    : items;
  return {
    view,
    items: visible,
    count: hideCompleted ? visible.length : count,
    groupOrder: grouping.groupOrder,
    propertyLabels: grouping.propertyLabels,
    propertyKinds: grouping.propertyKinds,
  };
}
