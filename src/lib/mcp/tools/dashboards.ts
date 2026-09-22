// Dashboard tools (ADR-047, ADR-102): create a dashboard and append widgets
// to it. Thin wrappers over the same parseDashboardInput/parseWidget the
// Build REST routes use.
import { asUuid } from "@/lib/api";
import {
  addWidget,
  createDashboard,
  getDashboard,
  parseDashboardInput,
  parseWidget,
  removeWidget,
  updateWidget,
  WIDGET_KINDS,
} from "@/lib/dashboards";
import { ItemError } from "@/lib/items";
import { ITEM_OPEN_MODES, updateSettings, type ItemOpenMode, type UserSettings } from "@/lib/settings";
import { dashView } from "./serializers";
import type { McpTool } from "./wire";

export const dashboardTools: McpTool[] = [
  {
    name: "create_dashboard",
    title: "Create dashboard",
    description:
      "Create a dashboard — a named grid of widgets surfaced on Work. Optionally " +
      "pass `widgets` inline, or create it empty and add_widget afterward. A " +
      "`focusItemId` scopes every view widget to items related to that item (a " +
      "person/project dashboard). Widget shape: { kind, viewId?, itemId?, " +
      "settings?, layout? } — see add_widget for the eight kinds and their " +
      "settings. Because view/stat/tree widgets reference a saved view, create " +
      "the view first (create_view) and pass its id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name. E.g. 'Sermon prep'." },
        focusItemId: { type: "string", description: "Optional item id (UUID): scope every view widget to items related to it." },
        widgets: { type: "array", description: "Optional inline widgets (see add_widget for the shape). Malformed widgets are dropped.", items: { type: "object" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const created = await createDashboard(ownerId, parseDashboardInput(args));
      return dashView(created);
    },
  },
  {
    name: "add_widget",
    title: "Add dashboard widget",
    description:
      "Append a widget to a dashboard. `kind` is view (a live list from a saved " +
      "view — needs viewId), stat (a single count from a view — needs viewId), " +
      "action (a button — settings.action quick-capture|new-from-template|link), " +
      "text (a heading/note — settings.heading/body), tree (a two-level " +
      "parent → children outline over a view — needs viewId; settings " +
      "titleOverride/parentLimit/childLimit/childSource children|relation/" +
      "relationRole/childType/hideCompletedChildren), embed (another item " +
      "rendered inline — needs itemId; settings showBody), container (widgets " +
      "grouped one level deep — settings mode tabs|stack|section, title, and " +
      "children[] of non-container widgets), or image (settings url, alt, fit " +
      "cover|contain, link). `settings` carries the per-kind options (a view " +
      "widget's titleOverride/renderStyle; an action's label/targetType/href). " +
      "Omit `layout` to let the widget auto-place on the grid. Create the " +
      "backing view (create_view) before adding a view/stat/tree widget.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardId: { type: "string", description: "The dashboard id (UUID), from describe_workspace." },
        kind: { type: "string", enum: [...WIDGET_KINDS], description: "view | stat | action | text | tree | embed | container | image." },
        viewId: { type: "string", description: "The backing saved view id (UUID) — required for kind view/stat/tree." },
        itemId: { type: "string", description: "The embedded item id (UUID) — required for kind embed." },
        settings: { type: "object", description: "Per-kind display settings (see description)." },
        layout: { type: "object", description: "Optional grid placement per breakpoint; omit to auto-place." },
      },
      required: ["dashboardId", "kind"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const dashboardId = asUuid(args.dashboardId, "dashboardId");
      const widget = parseWidget({
        kind: args.kind,
        viewId: args.viewId,
        itemId: args.itemId,
        settings: args.settings,
        layout: args.layout,
      });
      if (!widget) {
        throw new ItemError(
          "bad_request",
          "invalid widget: check kind, that a view/stat/tree widget has a real viewId, and that an embed widget has a real itemId"
        );
      }
      const updated = await addWidget(ownerId, dashboardId, widget);
      return dashView(updated);
    },
  },
  {
    name: "update_widget",
    title: "Update a dashboard widget",
    description:
      "Change one widget on a dashboard by id (widget ids come from " +
      "describe_workspace / create_dashboard / add_widget). `settings` MERGES into " +
      "the widget's current settings (a view widget's titleOverride, itemLimit, " +
      "sortOverride, renderStyle, hideWhenEmpty, fitToContent — hideWhenEmpty:true drops the " +
      "card from the grid when its view matches nothing; fitToContent:true sizes a " +
      "compact card to its rows); `layout` REPLACES the " +
      "grid placement ({ lg: {x,y,w,h}, md?, sm? }); `viewId` repoints a view/stat/" +
      "tree widget at another saved view. Pass only what you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardId: { type: "string", description: "The dashboard id (UUID)." },
        widgetId: { type: "string", description: "The widget id (UUID) on that dashboard." },
        settings: { type: "object", description: "Settings keys to merge into the widget's settings." },
        layout: { type: "object", description: "Replacement grid placement per breakpoint." },
        viewId: { type: "string", description: "Repoint a view-backed widget at this saved view id." },
      },
      required: ["dashboardId", "widgetId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const dashboardId = asUuid(args.dashboardId, "dashboardId");
      const widgetId = asUuid(args.widgetId, "widgetId");
      const dash = await getDashboard(ownerId, dashboardId);
      const current = dash.widgets.find((w) => w.id === widgetId);
      if (!current) throw new ItemError("not_found", "no widget with that id on this dashboard");
      const patch: Record<string, unknown> = {};
      if (args.settings && typeof args.settings === "object") {
        patch.settings = {
          ...(current.settings as Record<string, unknown>),
          ...(args.settings as Record<string, unknown>),
        };
      }
      if (args.layout && typeof args.layout === "object") patch.layout = args.layout;
      if (typeof args.viewId === "string") patch.viewId = asUuid(args.viewId, "viewId");
      if (Object.keys(patch).length === 0) {
        throw new ItemError("bad_request", "pass settings, layout, and/or viewId");
      }
      const updated = await updateWidget(ownerId, dashboardId, widgetId, patch);
      return dashView(updated);
    },
  },
  {
    name: "remove_widget",
    title: "Remove a dashboard widget",
    description:
      "Remove one widget from a dashboard by id. The backing saved view is NOT " +
      "deleted — only the card on the grid goes. Confirm with the owner first.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardId: { type: "string", description: "The dashboard id (UUID)." },
        widgetId: { type: "string", description: "The widget id (UUID) to remove." },
      },
      required: ["dashboardId", "widgetId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const dashboardId = asUuid(args.dashboardId, "dashboardId");
      const widgetId = asUuid(args.widgetId, "widgetId");
      const updated = await removeWidget(ownerId, dashboardId, widgetId);
      return dashView(updated);
    },
  },
  {
    name: "set_item_open_mode",
    title: "Set where a clicked item opens",
    description:
      "Set the owner's item open mode — the same choice as Settings → 'Where items " +
      "open'. auto = the measured default (a right-docked side panel when the window " +
      "is wide, else a popup); left / right = a docked side panel on that edge; " +
      "center = a popup centered on the screen, pinned to the top. Direct loads and " +
      "'Expand' always use the full page regardless.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: [...ITEM_OPEN_MODES], description: "auto | left | right | center." },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const mode = args.mode;
      if (!(ITEM_OPEN_MODES as readonly string[]).includes(mode as string)) {
        throw new ItemError("bad_request", "mode must be one of auto | left | right | center");
      }
      const settings = await updateSettings(ownerId, { itemOpenMode: mode as ItemOpenMode });
      return { itemOpenMode: settings.itemOpenMode };
    },
  },
  {
    name: "assign_dashboards",
    title: "Assign Home and Today dashboards",
    description:
      "Set which dashboard opens as Home (what the owner sees when they open " +
      "Ledgr) and/or Today, the same as clicking 'Set as Home' / 'Set as Today' " +
      "at /dashboards. Pass either or both; the one you omit is left alone. Pass " +
      "null to clear one back to the fixed built-in layout. Create the dashboard " +
      "first (create_dashboard) — this only assigns an existing one.",
    inputSchema: {
      type: "object",
      properties: {
        homeDashboardId: { type: ["string", "null"], description: "Dashboard id (UUID) to set as Home, or null to clear it." },
        todayDashboardId: { type: ["string", "null"], description: "Dashboard id (UUID) to set as Today, or null to clear it." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const hasHome = "homeDashboardId" in args;
      const hasToday = "todayDashboardId" in args;
      if (!hasHome && !hasToday) {
        throw new ItemError(
          "bad_request",
          "pass homeDashboardId and/or todayDashboardId (a dashboard id, or null to clear)"
        );
      }
      const patch: Partial<UserSettings> = {};
      if (hasHome) {
        const v = args.homeDashboardId;
        patch.homeDashboardId = v === null ? null : asUuid(v, "homeDashboardId");
        if (patch.homeDashboardId) await getDashboard(ownerId, patch.homeDashboardId);
      }
      if (hasToday) {
        const v = args.todayDashboardId;
        patch.todayDashboardId = v === null ? null : asUuid(v, "todayDashboardId");
        if (patch.todayDashboardId) await getDashboard(ownerId, patch.todayDashboardId);
      }
      const settings = await updateSettings(ownerId, patch);
      return {
        homeDashboardId: settings.homeDashboardId,
        todayDashboardId: settings.todayDashboardId,
      };
    },
  },
];
