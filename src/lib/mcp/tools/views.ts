// Saved-view tools (ADR-047, ADR-102): list/run are read helpers over an
// owner's saved views; create/update are workspace-shaping writes, thin
// wrappers over the same parseViewInput the Build REST routes use.
import { asUuid } from "@/lib/api";
import {
  DATE_PROPERTIES,
  VIEW_LAYOUTS,
  createView,
  getView,
  listViews,
  parseViewInput,
  queryViewItems,
  updateView,
} from "@/lib/views";
import { optInt } from "./args";
import { rowView, viewView } from "./serializers";
import type { McpTool } from "./wire";

export const viewTools: McpTool[] = [
  {
    name: "list_views",
    title: "List views",
    description:
      "List the owner's saved views (the filtered/sorted/grouped lists they've " +
      "built — 'This week's tasks', a workflow board, etc.). Returns each view's " +
      "id, name, layout, and its filter/sort/grouping so you know what it shows; " +
      "use run_view to get a view's current items.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId) => {
      const defs = await listViews(ownerId);
      return {
        views: defs.map((v) => ({
          id: v.id,
          name: v.name,
          isSystem: v.isSystem,
          layout: v.layout,
          filter: v.filter,
          sort: v.sort,
          grouping: v.grouping,
        })),
      };
    },
  },
  {
    name: "run_view",
    title: "Run view",
    description:
      "Run a saved view by id and return its current items (body-free), using " +
      "the view's own filter and sort. Get the id from list_views. This answers " +
      "'what's in my <view>' without rebuilding the filters.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The view id (UUID), from list_views." },
        limit: { type: "integer", description: "Max items (1–200).", minimum: 1, maximum: 200 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const view = await getView(ownerId, asUuid(args.id, "id"));
      const rows = await queryViewItems(ownerId, view.filter, view.sort, optInt(args, "limit"));
      return {
        view: { id: view.id, name: view.name, layout: view.layout },
        count: rows.length,
        items: rows.map(rowView),
      };
    },
  },
  {
    name: "create_view",
    title: "Create view",
    description:
      "Create a saved view — a named, filtered, sorted list the owner reaches by " +
      "name. `layout` is list | table | board | calendar | agenda. `filter` " +
      "scopes the items: { type, status, due (overdue|today|week|none), " +
      "dateField, withinDays, relatedTo (an item id), propertyFilters: " +
      "[{key, value}] }. For richer AND/OR filtering use `filter.where`: " +
      "{ combinator:'and'|'or', conditions:[{ subject, op, value|values }] } — " +
      "subject is 'property'|'relation' (with `key`) or 'priority'|'status'; op is " +
      "set|empty|eq|neq|contains|gt|lt|gte|lte|anyOf|allOf|noneOf|checked|unchecked " +
      "(relation/tag conditions use anyOf/allOf/noneOf with `values` of item ids). " +
      "Optional `sort` { field, dir } or a property sort " +
      "{ field:'property', propertyKey, numeric }, `grouping` ({ field } or " +
      "{ propertyKey } for a board), `columns`, `dateProperty` (which date a " +
      "calendar/agenda places items on), and `display` (calendar mode + grain; " +
      "layout:'calendar' with display:{ mode:'spine' } is the vertical History " +
      "timeline, readable on any type). Example: \"This week's tasks\" = " +
      "{ name, layout:'list', filter:{ type:'task', due:'week' } }. Use run_view " +
      "afterward to confirm what it returns.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name. E.g. \"This week's tasks\"." },
        layout: { type: "string", enum: [...VIEW_LAYOUTS], description: "list | table | board | calendar | agenda." },
        filter: { type: "object", description: "Item filter (see description). Omit for an unscoped list." },
        sort: { type: "object", description: "{ field, dir } — field one of plan|dueDate|scheduledDate|meetingAt|urgency|updatedAt|createdAt|title (urgency = task priority P1–P6, asc = P1 first); OR a property sort { field:'property', propertyKey, numeric }; dir asc|desc." },
        grouping: { type: "object", description: "Board/agenda grouping: { field: status|urgency|type|due|scheduled } or { propertyKey } for a custom select." },
        columns: { type: "array", description: "Ordered columns for list/table (advanced). Omit for the layout defaults.", items: { type: "object" } },
        dateProperty: { type: "string", enum: [...DATE_PROPERTIES], description: "Which date a calendar/agenda places items on (default dueDate; meetingAt for events)." },
        display: { type: "object", description: "Calendar display options: { mode: month|timeline|spine, zoom: hour|day|week|month|quarter|year|halfDecade, startField: { prop: '<date property key>' } }. mode 'spine' is the vertical History timeline; zoom is its grain. startField places items by a type's own date property (e.g. { prop: 'logdate' }) instead of a built-in field." },
      },
      required: ["name", "layout"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const created = await createView(ownerId, parseViewInput(args));
      return viewView(created);
    },
  },
  {
    name: "update_view",
    title: "Update view",
    description:
      "Edit a saved view by id. REPLACES the view's definition wholesale (name, " +
      "layout, filter, sort, grouping, columns, dateProperty, display), so read the " +
      "current one via list_views first and resend the full shape with your " +
      "changes. System views can't be edited. See create_view for the field " +
      "shapes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The view id (UUID), from list_views/describe_workspace." },
        name: { type: "string", description: "Display name (resend the current one if unchanged)." },
        layout: { type: "string", enum: [...VIEW_LAYOUTS], description: "list | table | board | calendar | agenda." },
        filter: { type: "object", description: "Item filter (see create_view)." },
        sort: { type: "object", description: "{ field, dir } (see create_view)." },
        grouping: { type: "object", description: "Board/agenda grouping (see create_view)." },
        columns: { type: "array", description: "Ordered columns for list/table.", items: { type: "object" } },
        dateProperty: { type: "string", enum: [...DATE_PROPERTIES], description: "Calendar/agenda date field." },
        display: { type: "object", description: "Calendar display options: { mode: month|timeline|spine, zoom: hour|day|week|month|quarter|year|halfDecade, startField: { prop: '<date property key>' } }. mode 'spine' is the vertical History timeline; zoom is its grain. startField places items by a type's own date property (e.g. { prop: 'logdate' }) instead of a built-in field." },
      },
      required: ["id", "name", "layout"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const updated = await updateView(ownerId, id, parseViewInput(args));
      return viewView(updated);
    },
  },
];
