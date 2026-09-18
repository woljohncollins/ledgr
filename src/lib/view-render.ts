// View-lens render path: resolve a saved view for rendering as a tab on a
// type's list page, scoped to that type. Self-contained on purpose — it mirrors
// the per-widget orchestration in DashboardView (getView → scope → query +
// count + grouping) without importing or modifying that shared dashboards code,
// so the list-lenses feature touches no dashboard internals. Body-free and
// owner-scoped by construction (queryViewItems / countViewItems).
import type { ViewItem } from "@/components/views/ViewRenderer";
import { ItemError } from "@/lib/items";
import { orderedStatuses, resolveStatusSchema, type StatusDef } from "@/lib/status";
import { getType } from "@/lib/types";
import {
  countViewItems,
  getView,
  queryViewItems,
  VIEW_LIMIT,
  type ViewDefinition,
  type ViewFilter,
} from "@/lib/views";

export type ViewLensData = {
  view: ViewDefinition;
  items: ViewItem[];
  count: number;
  groupOrder?: string[];
  propertyLabels?: Record<string, string>;
  propertyKinds?: Record<string, string>;
  // The type's resolved statuses: a status board's column LABELS and colors come
  // from these. Without them the board printed the raw status key ("status_7"
  // instead of "Background") — the lens path used to omit them entirely.
  statuses?: StatusDef[];
  // The grouped property's kind, so the caller can reproduce /views/[id]'s
  // board-drag guard (only a scalar-writable grouping may be dragged).
  groupPropKind?: string | null;
  // False for a SYNTHETIC lens (board/completed), whose view has no row in the
  // views table. The Desk's "Open beside" anchors a host by view id and links to
  // /views/<id>, so advertising a synthetic id there would hand the owner a
  // dead route. Undefined/true = a real saved view, hostable as before.
  hostable?: boolean;
};

// Scope a view's filter to the current type, mirroring applyFocus: set the type
// only when the view doesn't already pin one, so a generic view ("Recently
// updated") becomes "this type, recently updated" on the type's list, while a
// type-specific view renders unchanged.
export function applyTypeScope(filter: ViewFilter, typeKey: string): ViewFilter {
  if (filter.type) return filter;
  return { ...filter, type: typeKey };
}

// Board column order + property labels resolved from the (scoped) view's type —
// the same metadata the /views/[id] page and DashboardView compute for a
// layout-faithful render.
async function groupingFor(view: ViewDefinition) {
  const type = view.filter.type ? await getType(view.filter.type).catch(() => null) : null;
  const statuses = resolveStatusSchema(type?.statusSchema ?? null);
  let groupOrder: string[] | undefined;
  let groupPropKind: string | null = null;
  const g = view.grouping;
  if (g && "propertyKey" in g) {
    groupOrder = type?.propertySchema.find((p) => p.key === g.propertyKey)?.options;
    groupPropKind =
      type?.propertySchema.find((p) => p.key === g.propertyKey)?.kind ?? null;
  } else if (!g || ("field" in g && g.field === "status")) {
    // A status board shows every status as a column, in the type's schema order
    // (category order, then the author's order within a category). MUST match
    // /views/[id] and DashboardView: without it orderedGroups has no known order,
    // so the columns fall through to the ALPHABETICAL tail — which is how a
    // project board rendered "done, ongoing, status_7" left to right with Done
    // first. Keep these three call sites in step.
    // ORDERED, not the raw stored array (bug found 2026-08-25 by looking at a
    // real board): resolveStatusSchema preserves the order the statuses were
    // AUTHORED in, and the category sort is a separate function. Using the raw
    // order put Done wherever it happened to sit in the schema — middle of the
    // board, with later-added statuses after it. orderedStatuses is what sorts
    // by category (Not Started -> In Progress -> Done -> Closed), which is the
    // left-to-right a kanban must read in.
    groupOrder = orderedStatuses(statuses).map((s) => s.key);
  }
  const propertyLabels: Record<string, string> = {};
  const propertyKinds: Record<string, string> = {};
  for (const p of type?.propertySchema ?? []) {
    propertyLabels[p.key] = p.label;
    propertyKinds[p.key] = p.kind;
  }
  return { groupOrder, propertyLabels, propertyKinds, statuses, groupPropKind };
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

// Resolve a view-lens for rendering. Returns null when the referenced view is
// missing/deleted, so the caller falls back to the default sorted list (the
// same try/catch posture as DashboardView's per-widget fan-out).
export async function resolveViewLens(
  ownerId: string,
  viewId: string,
  typeKey: string,
  limit = VIEW_LIMIT
): Promise<ViewLensData | null> {
  let view: ViewDefinition;
  try {
    view = await getView(ownerId, viewId);
  } catch (err) {
    if (err instanceof ItemError && err.code === "not_found") return null;
    throw err;
  }
  const scoped: ViewDefinition = { ...view, filter: applyTypeScope(view.filter, typeKey) };
  const [rows, count, grouping] = await Promise.all([
    queryViewItems(ownerId, scoped.filter, view.sort, limit),
    countViewItems(ownerId, scoped.filter),
    groupingFor(scoped),
  ]);
  return {
    view: scoped,
    items: rows.map(toViewItem),
    count,
    groupOrder: grouping.groupOrder,
    propertyLabels: grouping.propertyLabels,
    propertyKinds: grouping.propertyKinds,
    statuses: grouping.statuses,
    groupPropKind: grouping.groupPropKind,
  };
}


// --- Synthetic lenses: the board + completed tabs -------------------------
//
// A "view" lens needs a saved view id, which is fine for a tab the owner built
// but useless for a tab a type should ship with by DEFAULT (a fresh instance has
// no saved views). These two lens kinds instead build a ViewDefinition on the
// fly from the type and push it through the very same ViewRenderer pipeline, so
// the board tab gets status columns, project cards, drag-to-change and the
// collapsed Done column for free, with no stored view to create or migrate.
//
// The ids are stable strings (`board:project`), not UUIDs: they key the
// remembered column-collapse state (board-prefs.ts), so they must not change
// between renders. They are deliberately NOT valid view ids — see `hostable`.
export function syntheticViewId(kind: "board" | "completed", typeKey: string): string {
  return `${kind}:${typeKey}`;
}

function syntheticView(
  kind: "board" | "completed",
  typeKey: string,
  label: string
): ViewDefinition {
  return {
    id: syntheticViewId(kind, typeKey),
    name: label,
    isSystem: true,
    filter:
      kind === "board"
        ? { type: typeKey }
        : // Completed = the `done` CATEGORY, never a hardcoded "done" key: a type
          // may name its finished status anything ("Shipped", "Delivered") and
          // may have several, and the category is the indexed column anyway.
          { type: typeKey, statusCategory: "done" },
    sort: { field: "updatedAt", dir: "desc" },
    grouping: kind === "board" ? { field: "status" } : null,
    columns: null,
    layout: kind === "board" ? "board" : "list",
    dateProperty: null,
    display: null,
    createdAt: new Date(0),
  };
}

export async function resolveSyntheticLens(
  ownerId: string,
  typeKey: string,
  kind: "board" | "completed",
  label: string,
  limit = VIEW_LIMIT
): Promise<ViewLensData> {
  const view = syntheticView(kind, typeKey, label);
  const [rows, count, grouping] = await Promise.all([
    queryViewItems(ownerId, view.filter, view.sort, limit),
    countViewItems(ownerId, view.filter),
    groupingFor(view),
  ]);
  return {
    view,
    items: rows.map(toViewItem),
    count,
    groupOrder: grouping.groupOrder,
    propertyLabels: grouping.propertyLabels,
    propertyKinds: grouping.propertyKinds,
    statuses: grouping.statuses,
    groupPropKind: grouping.groupPropKind,
    hostable: false,
  };
}
