// Customizable dashboards (dashboards epoch) — the server half: tolerant
// parsers + owner-scoped CRUD over the dashboards table. An owner has many named
// dashboards, each a resizable/draggable grid of widgets. A widget references a
// saved view (kinds "view"/"stat") or is a non-view "action" block; it carries
// its own display settings (which never mutate the backing view) and a
// per-breakpoint grid layout. The whole widget array lives in one jsonb column
// (schema.ts dashboards.widgets), so a dashboard read is one row + a batched
// per-widget fan-out — the same jsonb-config discipline views/templates use.
//
// This supersedes the single-dashboard views.dashboard_order model. The widget
// SHAPES + pure helpers live in src/lib/dashboard-widgets.ts (client-safe, no
// db); this module owns the parsers (tolerant — unknown keys dropped, malformed
// widgets skipped, numbers clamped) and the database access.
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { dashboards } from "@/db/schema";
import {
  ACTION_KINDS,
  CHILD_SOURCES,
  CONTAINER_MODES,
  GRID_BREAKPOINTS,
  GRID_COLS,
  IMAGE_FITS,
  RENDER_STYLES,
  STAGE_BG_KINDS,
  STAGE_DENSITIES,
  WIDGET_ACCENTS,
  WIDGET_BACKGROUNDS,
  WIDGET_KINDS,
  type ActionKind,
  type ChildSource,
  type ContainerMode,
  type Dashboard,
  type DashboardAppearance,
  type DashboardInput,
  type DashboardWidget,
  type GridCell,
  type ImageFit,
  type RenderStyle,
  type StageBackground,
  type StageBgKind,
  type StageDensity,
  type WidgetAccent,
  type WidgetAppearance,
  type WidgetBackground,
  type WidgetKind,
  type WidgetLayout,
  type WidgetSettings,
} from "@/lib/dashboard-widgets";
import { ItemError } from "@/lib/items";
import { isIconRef } from "@/lib/nav-icons";
import { parseSort, UUID_RE, VIEW_LIMIT } from "@/lib/views";

// Re-export the contract so existing importers (API routes, verify script) can
// keep importing widget shapes + applyFocus from "@/lib/dashboards".
export * from "@/lib/dashboard-widgets";

function bad(message: string): never {
  throw new ItemError("bad_request", message);
}

// --- Parsers (tolerant) ---------------------------------------------------

function parseGridCell(raw: unknown): GridCell | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, min: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(min, Math.round(x)) : null;
  };
  const x = num(r.x, 0);
  const y = num(r.y, 0);
  const w = num(r.w, 1);
  const h = num(r.h, 1);
  if (x === null || y === null || w === null || h === null) return null;
  return { x: Math.min(x, GRID_COLS - 1), y, w: Math.min(w, GRID_COLS), h };
}

function parseWidgetLayout(raw: unknown): WidgetLayout {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: WidgetLayout = {};
  for (const bp of GRID_BREAKPOINTS) {
    const cell = parseGridCell(r[bp]);
    if (cell) out[bp] = cell;
  }
  return out;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

// Per-widget chrome (DC1). Absent (undefined) = today's per-kind defaults, so an
// untouched dashboard renders identically; present = a full object (the gear
// always sends every field). Tolerant: a partial object fills with card defaults.
function parseWidgetAppearance(raw: unknown): WidgetAppearance | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    showHeader: bool(r.showHeader, true),
    showBorder: bool(r.showBorder, true),
    background: WIDGET_BACKGROUNDS.includes(r.background as WidgetBackground)
      ? (r.background as WidgetBackground)
      : "panel",
    accent: WIDGET_ACCENTS.includes(r.accent as WidgetAccent) ? (r.accent as WidgetAccent) : "none",
    collapsible: bool(r.collapsible, false),
    collapsed: bool(r.collapsed, false),
  };
}

// Dashboard stage (DC2). null = today's plain dark dashboard. value holds a
// curated color/gradient token or an image/video URL — never bytes.
export function parseDashboardAppearance(raw: unknown): DashboardAppearance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const bgRaw = (r.background && typeof r.background === "object" ? r.background : {}) as Record<
    string,
    unknown
  >;
  const kind = STAGE_BG_KINDS.includes(bgRaw.kind as StageBgKind)
    ? (bgRaw.kind as StageBgKind)
    : "none";
  const background: StageBackground = {
    kind,
    value: str(bgRaw.value, 1000),
    scrim: clamp01(bgRaw.scrim),
    blur: clamp01(bgRaw.blur),
  };
  return {
    background,
    showTitle: bool(r.showTitle, true),
    density: STAGE_DENSITIES.includes(r.density as StageDensity)
      ? (r.density as StageDensity)
      : "comfortable",
    accent: str(r.accent, 40) || null,
  };
}

function parseWidgetSettings(kind: WidgetKind, raw: unknown): WidgetSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (kind === "view") {
    const titleOverride = str(r.titleOverride, 120) || null;
    let itemLimit: number | null = null;
    if (r.itemLimit != null) {
      const n = Number(r.itemLimit);
      if (Number.isFinite(n)) itemLimit = Math.min(Math.max(Math.round(n), 1), VIEW_LIMIT);
    }
    const sortOverride = r.sortOverride != null ? parseSort(r.sortOverride) : null;
    const renderStyle = RENDER_STYLES.includes(r.renderStyle as RenderStyle)
      ? (r.renderStyle as RenderStyle)
      : "compact";
    const hideWhenEmpty = r.hideWhenEmpty === true || r.hideWhenEmpty === "true";
    const fitToContent = r.fitToContent === true || r.fitToContent === "true";
    return { titleOverride, itemLimit, sortOverride, renderStyle, hideWhenEmpty, fitToContent };
  }
  if (kind === "stat") {
    return { label: str(r.label, 60), metric: "count" };
  }
  if (kind === "text") {
    return { heading: str(r.heading, 120), body: str(r.body, 2000) };
  }
  if (kind === "tree") {
    const childSource: ChildSource = CHILD_SOURCES.includes(r.childSource as ChildSource)
      ? (r.childSource as ChildSource)
      : "children";
    return {
      titleOverride: str(r.titleOverride, 120) || null,
      parentLimit: r.parentLimit != null ? intIn(r.parentLimit, 1, VIEW_LIMIT, 5) : null,
      childLimit: intIn(r.childLimit, 1, 50, 5),
      childSource,
      relationRole: str(r.relationRole, 60) || null,
      childType: str(r.childType, 60) || null,
      hideCompletedChildren: bool(r.hideCompletedChildren, true),
      sortOverride: r.sortOverride != null ? parseSort(r.sortOverride) : null,
    };
  }
  if (kind === "embed") {
    return { showBody: bool(r.showBody, true) };
  }
  if (kind === "image") {
    const fit: ImageFit = IMAGE_FITS.includes(r.fit as ImageFit) ? (r.fit as ImageFit) : "cover";
    return { url: str(r.url, 2000), alt: str(r.alt, 300), fit, link: str(r.link, 500) || null };
  }
  if (kind === "container") {
    const mode: ContainerMode = CONTAINER_MODES.includes(r.mode as ContainerMode)
      ? (r.mode as ContainerMode)
      : "tabs";
    // One-level nesting: a container's children are parsed as widgets but any
    // nested container is dropped, so the server fan-out stays a single recursion.
    const children: DashboardWidget[] = [];
    const seen = new Set<string>();
    if (Array.isArray(r.children)) {
      for (const c of r.children) {
        const parsed = parseWidget(c);
        if (parsed && parsed.kind !== "container" && !seen.has(parsed.id)) {
          seen.add(parsed.id);
          children.push(parsed);
        }
      }
    }
    return {
      mode,
      title: str(r.title, 120),
      activeTab: intIn(r.activeTab, 0, Math.max(children.length - 1, 0), 0),
      children,
    };
  }
  // action
  const action = ACTION_KINDS.includes(r.action as ActionKind)
    ? (r.action as ActionKind)
    : "quick-capture";
  return {
    action,
    label: str(r.label, 60),
    icon: isIconRef(r.icon) ? r.icon : null,
    targetType: str(r.targetType, 60) || null,
    templateId: r.templateId != null && UUID_RE.test(String(r.templateId)) ? String(r.templateId) : null,
    href: str(r.href, 500) || null,
  };
}

export function parseWidget(raw: unknown): DashboardWidget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as WidgetKind;
  if (!WIDGET_KINDS.includes(kind)) return null;
  const viewId = r.viewId != null ? String(r.viewId) : null;
  const itemId = r.itemId != null ? String(r.itemId) : null;
  // "view"/"stat"/"tree" must be backed by a real view; drop the widget if not.
  const viewBacked = kind === "view" || kind === "stat" || kind === "tree";
  if (viewBacked && (!viewId || !UUID_RE.test(viewId))) return null;
  // "embed" must name a real item.
  if (kind === "embed" && (!itemId || !UUID_RE.test(itemId))) return null;
  return {
    id: typeof r.id === "string" && UUID_RE.test(r.id) ? r.id : crypto.randomUUID(),
    kind,
    viewId: viewBacked ? viewId : null,
    itemId: kind === "embed" ? itemId : null,
    settings: parseWidgetSettings(kind, r.settings),
    appearance: parseWidgetAppearance(r.appearance),
    layout: parseWidgetLayout(r.layout),
  };
}

export function parseWidgets(raw: unknown): DashboardWidget[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) bad("widgets must be an array");
  const out: DashboardWidget[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const parsed = parseWidget(w);
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      out.push(parsed);
    }
  }
  return out;
}

export function parseDashboardInput(raw: unknown): DashboardInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad("request body must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) bad("name is required");
  if (name.length > 120) bad("name too long");
  let focusItemId: string | null = null;
  if (r.focusItemId != null) {
    if (!UUID_RE.test(String(r.focusItemId))) bad("focusItemId must be a UUID");
    focusItemId = String(r.focusItemId);
  }
  return {
    name,
    focusItemId,
    appearance: parseDashboardAppearance(r.appearance),
    widgets: parseWidgets(r.widgets),
  };
}

function rowToDashboard(row: typeof dashboards.$inferSelect): Dashboard {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    focusItemId: row.focusItemId,
    appearance: parseDashboardAppearance(row.appearance),
    widgets: parseWidgets(row.widgets),
    createdAt: row.createdAt,
  };
}

// --- CRUD -----------------------------------------------------------------

export async function listDashboards(ownerId: string): Promise<Dashboard[]> {
  const rows = await getDb()
    .select()
    .from(dashboards)
    .where(eq(dashboards.ownerId, ownerId))
    .orderBy(asc(dashboards.position), asc(dashboards.name));
  return rows.map(rowToDashboard);
}

export async function getDashboard(ownerId: string, id: string): Promise<Dashboard> {
  const rows = await getDb()
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, id), eq(dashboards.ownerId, ownerId)));
  if (rows.length === 0) throw new ItemError("not_found", "dashboard not found");
  return rowToDashboard(rows[0]);
}

export async function createDashboard(
  ownerId: string,
  input: DashboardInput
): Promise<Dashboard> {
  const maxRows = await getDb()
    .select({ max: sql<number | null>`max(${dashboards.position})` })
    .from(dashboards)
    .where(eq(dashboards.ownerId, ownerId));
  const position = (maxRows[0].max ?? -1) + 1;
  const rows = await getDb()
    .insert(dashboards)
    .values({
      ownerId,
      name: input.name,
      position,
      focusItemId: input.focusItemId,
      appearance: input.appearance,
      widgets: input.widgets,
    })
    .returning();
  return rowToDashboard(rows[0]);
}

// Full replace of name + focus + widgets. This is the single persistence path
// for widget edits AND react-grid-layout drag/resize (the client merges the new
// cells into each widget's layout and PATCHes the whole array back).
export async function updateDashboard(
  ownerId: string,
  id: string,
  input: DashboardInput
): Promise<Dashboard> {
  await getDashboard(ownerId, id); // ownership + existence
  const rows = await getDb()
    .update(dashboards)
    .set({
      name: input.name,
      focusItemId: input.focusItemId,
      appearance: input.appearance,
      widgets: input.widgets,
    })
    .where(and(eq(dashboards.id, id), eq(dashboards.ownerId, ownerId)))
    .returning();
  return rowToDashboard(rows[0]);
}

export async function deleteDashboard(ownerId: string, id: string): Promise<void> {
  await getDashboard(ownerId, id); // ownership + existence
  await getDb()
    .delete(dashboards)
    .where(and(eq(dashboards.id, id), eq(dashboards.ownerId, ownerId)));
}

// Persist a drag-reorder of the dashboards themselves: index becomes position.
// Ids not owned by the caller are skipped (a stale client can't reorder
// someone else's dashboards).
export async function reorderDashboards(
  ownerId: string,
  orderedIds: string[]
): Promise<void> {
  const db = getDb();
  await Promise.all(
    orderedIds.map((id, i) =>
      db
        .update(dashboards)
        .set({ position: i })
        .where(and(eq(dashboards.id, id), eq(dashboards.ownerId, ownerId)))
    )
  );
}

// --- Granular widget helpers (read-modify-write the array) ---------------
// For callers that don't hold the full client widget state (MCP tools, scripts).
// The UI's normal path is the coarse updateDashboard above.

export async function addWidget(
  ownerId: string,
  dashboardId: string,
  widget: DashboardWidget
): Promise<Dashboard> {
  const dash = await getDashboard(ownerId, dashboardId);
  return updateDashboard(ownerId, dashboardId, {
    name: dash.name,
    focusItemId: dash.focusItemId,
    appearance: dash.appearance,
    widgets: [...dash.widgets, widget],
  });
}

export async function updateWidget(
  ownerId: string,
  dashboardId: string,
  widgetId: string,
  patch: Partial<Omit<DashboardWidget, "id">>
): Promise<Dashboard> {
  const dash = await getDashboard(ownerId, dashboardId);
  const widgets = dash.widgets.map((w) =>
    w.id === widgetId ? parseWidget({ ...w, ...patch, id: w.id }) ?? w : w
  );
  return updateDashboard(ownerId, dashboardId, {
    name: dash.name,
    focusItemId: dash.focusItemId,
    appearance: dash.appearance,
    widgets,
  });
}

export async function removeWidget(
  ownerId: string,
  dashboardId: string,
  widgetId: string
): Promise<Dashboard> {
  const dash = await getDashboard(ownerId, dashboardId);
  return updateDashboard(ownerId, dashboardId, {
    name: dash.name,
    focusItemId: dash.focusItemId,
    appearance: dash.appearance,
    widgets: dash.widgets.filter((w) => w.id !== widgetId),
  });
}

// --- View-usage -----------------------------------------------------------
// (applyFocus is a pure helper in dashboard-widgets.ts, re-exported above.)

// Add a view to the owner's default (first) dashboard, creating a "Home"
// dashboard if they have none. The dashboards-epoch replacement for the old
// pinView: a structure-template generator and similar callers use this to
// surface a generated view on Work. Returns the target dashboard id.
export async function addViewToDefaultDashboard(
  ownerId: string,
  viewId: string
): Promise<string> {
  const existing = await listDashboards(ownerId);
  const dash =
    existing[0] ??
    (await createDashboard(ownerId, {
      name: "Home",
      focusItemId: null,
      appearance: null,
      widgets: [],
    }));
  await addWidget(ownerId, dash.id, {
    id: crypto.randomUUID(),
    kind: "view",
    viewId,
    itemId: null,
    settings: { titleOverride: null, itemLimit: null, sortOverride: null, renderStyle: "compact" },
    layout: {},
  });
  return dash.id;
}

// Every view id placed as a widget on any of the owner's dashboards. Powers the
// Views page's "in use as a widget" badge + the Views/Widgets filter. One
// indexed query + in-memory scan — cheap at one-owner scale.
export async function usedViewIds(ownerId: string): Promise<Set<string>> {
  const all = await listDashboards(ownerId);
  const set = new Set<string>();
  const scan = (w: DashboardWidget) => {
    if (w.viewId) set.add(w.viewId);
    // A view can also live inside a container (one-level), so count those too.
    if (w.kind === "container") {
      const s = w.settings as { children?: DashboardWidget[] };
      for (const c of s.children ?? []) if (c.viewId) set.add(c.viewId);
    }
  };
  for (const d of all) for (const w of d.widgets) scan(w);
  return set;
}
