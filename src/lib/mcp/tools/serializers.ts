// Response-shaping helpers shared by the MCP tools: compact, body-free views
// of the app's own domain types so a create/update tool can echo back what it
// stored (rule 8: index-backed, no extra query). Split out of the old
// monolithic tools.ts (ADR-047).
import type { Dashboard } from "@/lib/dashboards";
import type { NavSlotConfig, UserSettings } from "@/lib/settings";
import type { TypeDefinition } from "@/lib/types";
import type { ViewDefinition } from "@/lib/views";

// Body-free view of a row (listColumns shape) — the same fields search, list,
// create, and update all surface. Dates serialize to ISO via JSON.stringify.
export function rowView(r: {
  id: string;
  type: string;
  title: string;
  status: string;
  urgency: number | null;
  dueDate: Date | null;
  // The planned date (ADR-073/076) — distinct from the dueDate deadline, and
  // the field a recurring series advances. Optional here only because the FTS
  // row shape (search.ts) doesn't select it; every other source does.
  scheduledDate?: Date | null;
  meetingAt: Date | null;
  url: string | null;
  parentId: string | null;
  inbox: boolean;
  properties: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    status: r.status,
    urgency: r.urgency,
    dueDate: r.dueDate,
    ...(r.scheduledDate !== undefined ? { scheduledDate: r.scheduledDate } : {}),
    meetingAt: r.meetingAt,
    url: r.url,
    parentId: r.parentId,
    inbox: r.inbox,
    properties: r.properties ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// One type with its full property detail — the list_types per-type shape, reused
// so create_type/update_type echo the stored schema back.
export function typeView(t: TypeDefinition) {
  return {
    key: t.key,
    label: t.label,
    icon: t.icon,
    isSystem: t.isSystem,
    hidden: t.hidden,
    showInQuickCapture: t.showInQuickCapture,
    ...(t.capability ? { capability: t.capability } : {}),
    properties: t.propertySchema.map((p) => ({
      key: p.key,
      label: p.label,
      kind: p.kind,
      ...(p.options ? { options: p.options } : {}),
      ...(p.targetType != null ? { targetType: p.targetType } : {}),
      ...(p.cardinality ? { cardinality: p.cardinality } : {}),
    })),
  };
}

// One view's definition — the list_views shape plus columns/dateProperty/display,
// so create_view/update_view echo the full stored view. `display` is echoed
// because update_view REPLACES wholesale: without it in the read, an update
// would silently wipe a view's calendar mode, grain, or custom-date placement.
export function viewView(v: ViewDefinition) {
  return {
    id: v.id,
    name: v.name,
    isSystem: v.isSystem,
    layout: v.layout,
    filter: v.filter,
    sort: v.sort,
    grouping: v.grouping,
    columns: v.columns,
    dateProperty: v.dateProperty,
    display: v.display,
  };
}

// A widget's human label without resolving its backing view (no extra query,
// rule 8): the override/label/heading its settings carry, else null.
function widgetLabel(settings: unknown): string | null {
  const s = (settings ?? {}) as { titleOverride?: unknown; label?: unknown; heading?: unknown };
  for (const v of [s.titleOverride, s.label, s.heading]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// One dashboard with a compact widget list (kind + backing viewId + label). The
// model cross-refs viewId against the views list rather than us fanning out a
// per-widget view query.
export function dashView(d: Dashboard) {
  return {
    id: d.id,
    name: d.name,
    focusItemId: d.focusItemId,
    widgetCount: d.widgets.length,
    widgets: d.widgets.map((w) => ({
      id: w.id,
      kind: w.kind,
      viewId: w.viewId,
      label: widgetLabel(w.settings),
    })),
  };
}

// A nav slot, compactly: a destination's route, or a tools group's children.
// `icon` is returned on every slot and child, and that is load-bearing, not
// detail: update_nav REPLACES the whole slot list, so a caller reads the nav,
// edits one slot, and sends the list back. While this view omitted icons, that
// round-trip stamped the owner's entire nav with the generic fallback glyph,
// because parseNavDestination defaults a missing icon to NAV_ICON_FALLBACK
// rather than rejecting the slot (2026-09-14, Tyler's rail). Same shape as the
// type icon/color loss in ADR-258: a lossy read plus a wholesale write silently
// destroys a presentation choice. Anything added to a slot belongs here too.
function slotView(slot: NavSlotConfig) {
  if (slot.type === "tools") {
    return {
      type: "tools" as const,
      label: slot.label,
      icon: slot.icon,
      children: slot.children.map((c) => ({
        label: c.label,
        href: c.href,
        kind: c.kind,
        icon: c.icon,
        ...(c.badge ? { badge: c.badge } : {}),
      })),
    };
  }
  return {
    type: "destination" as const,
    label: slot.label,
    href: slot.href,
    kind: slot.kind,
    icon: slot.icon,
    ...(slot.badge ? { badge: slot.badge } : {}),
  };
}

// The navigation shape describe_workspace + update_nav report: the layout knobs,
// the assigned home/today dashboards, and the configurable middle slots.
export function navView(s: UserSettings) {
  return {
    position: s.navPosition,
    railSize: s.railSize,
    density: s.navDensity,
    railAnchor: s.railAnchor,
    // What the one Search slot opens (ADR-182): palette | page.
    searchMode: s.searchMode,
    homeDashboardId: s.homeDashboardId,
    todayDashboardId: s.todayDashboardId,
    slots: s.navSlots.map(slotView),
    mobileSlots: s.mobileNavSlots ? s.mobileNavSlots.map(slotView) : null,
  };
}
