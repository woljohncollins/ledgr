// Record-shaping tools (ADR-181): let the model shape a Project (or any
// widget-composed record type) end to end — which sections show, in what order,
// with what options, and what lives inside them.
//
// The composition model has three layers (ADR-111/PJ3, resolveComposition):
//   Layer 1  the catalog — every widget is available on every type, derived.
//   Layer 2  types.default_widgets — what every record of a type shows.
//   Layer 3  items.composition — one record diverging from its type.
// The record page could already edit Layer 3 ("+ Add section", the gear), but
// **Layer 2 had no writer anywhere in the app** — read on the render path since
// PJ3 and never written. `setTypeDefaultWidgets` (types.ts) is that writer, and
// set_type_layout here is its first caller.
//
// Same posture as the rest of the MCP layer: thin wrappers over the libs the
// REST routes already call (composition.ts, widgets.ts, types.ts,
// item-mutations.ts, relations.ts). The one rule worth stating: hiding a section
// NEVER deletes it, and never touches the items behind it — hidden=true is the
// defer-by-hiding standard, so re-showing restores the card and its contents.
import { asUuid } from "@/lib/api";
import {
  WIDGET_LIMIT_MAX,
  resolveComposition,
  type Composition,
  type RecordWidget,
} from "@/lib/composition";
import { ItemError, getItem } from "@/lib/items";
import { createItem, updateItem } from "@/lib/item-mutations";
import { setHome } from "@/lib/relations";
import { getType, setTypeDefaultWidgets } from "@/lib/types";
import {
  availableWidgets,
  widgetById,
  widgetsForScope,
  type OptionSchema,
  type WidgetDefinition,
} from "@/lib/widgets";
import { optBodyMarkdown, optString } from "./args";
import { rowView, typeView } from "./serializers";
import type { McpTool } from "./wire";

// The widgets that can sit on a record page at all (scope "record" ∩ available).
function recordWidgetDefs(): WidgetDefinition[] {
  const avail = new Set(availableWidgets().map((d) => d.id));
  return widgetsForScope("record").filter((d) => avail.has(d.id));
}

function widgetIdList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ItemError("bad_request", `${key} must be an array of section ids`);
  const allowed = new Set(recordWidgetDefs().map((d) => d.id));
  return v.map((x) => {
    const s = typeof x === "string" ? x.trim() : "";
    if (!allowed.has(s)) {
      throw new ItemError(
        "bad_request",
        `unknown section '${String(x)}' — valid sections are: ${[...allowed].join(", ")}`
      );
    }
    return s;
  });
}

// Validate an options patch against the widget's own declared option schema, so
// a layout write can't store a value the gear would never produce (a bad select
// choice, a limit of 900). A widget with no declared options takes none.
function validateOptions(
  def: WidgetDefinition,
  raw: unknown
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ItemError("bad_request", `options for '${def.id}' must be an object`);
  }
  const schema: Record<string, OptionSchema> = def.options ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // `limit` is the universal per-card preview cap (composition.widgetLimit),
    // not a per-widget declared option, so it's accepted on any collection card.
    if (k === "limit") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > WIDGET_LIMIT_MAX) {
        throw new ItemError("bad_request", `limit must be an integer 1–${WIDGET_LIMIT_MAX}`);
      }
      out.limit = n;
      continue;
    }
    const opt = schema[k];
    if (!opt) {
      const known = [...Object.keys(schema), "limit"].join(", ") || "limit";
      throw new ItemError("bad_request", `'${def.id}' has no option '${k}' (it accepts: ${known})`);
    }
    if (opt.kind === "select") {
      const s = typeof v === "string" ? v : "";
      if (!opt.choices.includes(s)) {
        throw new ItemError("bad_request", `'${def.id}'.${k} must be one of: ${opt.choices.join(", ")}`);
      }
      out[k] = s;
    } else if (opt.kind === "boolean") {
      if (typeof v !== "boolean") throw new ItemError("bad_request", `'${def.id}'.${k} must be true or false`);
      out[k] = v;
    } else if (opt.kind === "number") {
      const n = Number(v);
      const min = opt.min ?? Number.NEGATIVE_INFINITY;
      const max = opt.max ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new ItemError("bad_request", `'${def.id}'.${k} must be a number in range`);
      }
      out[k] = n;
    } else {
      // A type-key picker: null = any, else a type key (existence checked by the
      // caller, which has the async getType).
      out[k] = v === null ? null : typeof v === "string" ? v.trim() : null;
    }
  }
  return out;
}

// Apply show / hide / order / options to a composition. Pure, so Layer 2 and
// Layer 3 share one implementation and can't drift.
function applyLayoutOps(
  comp: Composition,
  ops: {
    show?: string[];
    hide?: string[];
    order?: string[];
    options?: Record<string, Record<string, unknown>>;
  }
): Composition {
  let widgets = comp.widgets.map((w) => ({ ...w }));

  // show: unhide if present, append if absent. Append keeps the record page's
  // "+ Add section" behavior (a new card lands at the end).
  for (const id of ops.show ?? []) {
    const at = widgets.findIndex((w) => w.defId === id);
    if (at >= 0) {
      const { hidden: _hidden, ...rest } = widgets[at];
      widgets[at] = rest as RecordWidget;
    } else {
      widgets.push({ instanceId: id, defId: id });
    }
  }

  // hide: present → hidden=true (never removed, never touching backing items);
  // absent → record it as hidden so the type default can't re-introduce it.
  for (const id of ops.hide ?? []) {
    const at = widgets.findIndex((w) => w.defId === id);
    if (at >= 0) widgets[at] = { ...widgets[at], hidden: true };
    else widgets.push({ instanceId: id, defId: id, hidden: true });
  }

  for (const [id, patch] of Object.entries(ops.options ?? {})) {
    const at = widgets.findIndex((w) => w.defId === id);
    // Options on a section that isn't on the page yet imply adding it — that's
    // what "set the Tasks card to show 10" means when Tasks was removed.
    if (at < 0) widgets.push({ instanceId: id, defId: id, options: patch });
    else widgets[at] = { ...widgets[at], options: { ...(widgets[at].options ?? {}), ...patch } };
  }

  // order: listed sections lead, in the given order; everything else keeps its
  // relative position after them. A partial list is therefore a "pull to front".
  if (ops.order?.length) {
    const rank = new Map(ops.order.map((id, i) => [id, i]));
    const listed = widgets.filter((w) => rank.has(w.defId));
    listed.sort((a, b) => rank.get(a.defId)! - rank.get(b.defId)!);
    widgets = [...listed, ...widgets.filter((w) => !rank.has(w.defId))];
  }

  return { ...comp, widgets };
}

// The read shape for a resolved composition: what shows, in order, what's
// hidden, and what could still be added — the same three buckets the record
// page's UI works from.
function layoutView(comp: Composition, source: string) {
  const label = (id: string) => widgetById(id)?.label ?? id;
  const present = new Set(comp.widgets.map((w) => w.defId));
  return {
    source,
    sections: comp.widgets
      .filter((w) => !w.hidden)
      .map((w) => ({
        id: w.defId,
        label: label(w.defId),
        kind: widgetById(w.defId)?.kind,
        ...(w.options && Object.keys(w.options).length ? { options: w.options } : {}),
      })),
    hidden: comp.widgets.filter((w) => w.hidden).map((w) => ({ id: w.defId, label: label(w.defId) })),
    addable: recordWidgetDefs()
      .filter((d) => !present.has(d.id))
      .map((d) => ({ id: d.id, label: d.label, kind: d.kind })),
    ...(comp.behaviors.digest ? { digest: comp.behaviors.digest } : {}),
  };
}

// Shared arg reading for the two layout writers.
function readLayoutOps(args: Record<string, unknown>) {
  const show = widgetIdList(args, "show");
  const hide = widgetIdList(args, "hide");
  const order = widgetIdList(args, "order");
  let options: Record<string, Record<string, unknown>> | undefined;
  if (args.options !== undefined && args.options !== null) {
    if (typeof args.options !== "object" || Array.isArray(args.options)) {
      throw new ItemError("bad_request", "options must be an object keyed by section id");
    }
    options = {};
    for (const [id, patch] of Object.entries(args.options as Record<string, unknown>)) {
      const def = widgetById(id.trim());
      if (!def) {
        throw new ItemError("bad_request", `unknown section '${id}' in options`);
      }
      options[def.id] = validateOptions(def, patch);
    }
  }
  const touched = show || hide || order || options;
  if (!touched && args.reset !== true) {
    throw new ItemError(
      "bad_request",
      "pass at least one of show, hide, order, options, or reset:true"
    );
  }
  return { show, hide, order, options };
}

// The types a record can contain through add_to_record — the same allow-list the
// REST contain route uses (/api/records/[id]/contain), so both doors agree.
const CONTAINABLE = ["task", "note", "milestone", "event", "link", "mindmap"] as const;

export const recordTools: McpTool[] = [
  {
    name: "get_record_layout",
    title: "Get a record's sections",
    description:
      "Read how one record's page is composed — which SECTIONS (widgets) it " +
      "shows and in what order, which are hidden, which could still be added, " +
      "and where the layout comes from: 'record' (this record has its own " +
      "layout), 'type' (it's using the type's default) or 'generated' (neither " +
      "is set, so it's the built-in starting set for that type). Call this " +
      "before set_record_layout so you change from a known state. A project's " +
      "sections are things like Tasks, Milestones, Notes, Meetings, Progress, " +
      "People, Timeline, Recent Activity.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The record's item id (UUID) — e.g. a project." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const item = await getItem(ownerId, id);
      const typeDef = await getType(item.type).catch(() => null);
      const { composition, source } = resolveComposition(
        item.composition,
        typeDef?.defaultWidgets,
        item.type
      );
      return {
        id: item.id,
        title: item.title,
        type: item.type,
        ...layoutView(composition, source),
      };
    },
  },
  {
    name: "set_record_layout",
    title: "Set a record's sections",
    description:
      "Change which SECTIONS one record's page shows, and how. show adds or " +
      "re-reveals sections; hide removes them from the page; order rearranges " +
      "them (a partial list pulls those to the front); options tunes one section " +
      "(e.g. {\"tasks\":{\"limit\":10}} to preview 10 rows, " +
      "{\"progress\":{\"weighting\":\"flat\"}}, " +
      "{\"relatedRecords\":{\"typeFilter\":\"project\"}}). reset:true drops this " +
      "record's own layout so it follows its type's default again.\n\n" +
      "HIDING NEVER DELETES: the tasks, notes and meetings behind a section stay " +
      "exactly where they are, so re-showing it brings the card back with its " +
      "contents. This changes ONE record; to change every record of a type, use " +
      "set_type_layout.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The record's item id (UUID)." },
        show: { type: "array", items: { type: "string" }, description: "Section ids to add or re-reveal (see get_record_layout's addable/hidden)." },
        hide: { type: "array", items: { type: "string" }, description: "Section ids to take off the page. Never deletes their contents." },
        order: { type: "array", items: { type: "string" }, description: "Section ids in the order you want; a partial list pulls those to the front." },
        options: { type: "object", description: "Per-section settings keyed by section id, e.g. {\"tasks\":{\"limit\":10}}. Validated against each section's own option list." },
        reset: { type: "boolean", description: "true = clear this record's own layout so it inherits the type default again." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const item = await getItem(ownerId, id);
      const typeDef = await getType(item.type).catch(() => null);

      if (args.reset === true) {
        const updated = await updateItem(ownerId, id, { composition: null });
        const { composition, source } = resolveComposition(
          updated.composition,
          typeDef?.defaultWidgets,
          updated.type
        );
        return { ...rowView(updated), reset: true, ...layoutView(composition, source) };
      }

      const ops = readLayoutOps(args);
      // Start from the EFFECTIVE layout, not an empty one: editing a record
      // that's still inheriting must keep the sections it currently shows.
      const { composition: base } = resolveComposition(
        item.composition,
        typeDef?.defaultWidgets,
        item.type
      );
      const next = applyLayoutOps(base, ops);
      const updated = await updateItem(ownerId, id, { composition: next });
      const { composition, source } = resolveComposition(
        updated.composition,
        typeDef?.defaultWidgets,
        updated.type
      );
      return { ...rowView(updated), ...layoutView(composition, source) };
    },
  },
  {
    name: "set_type_layout",
    title: "Set a type's default sections",
    description:
      "Change which SECTIONS every record of a type shows by default — the " +
      "type-level template (e.g. 'every project should show Tasks, Milestones " +
      "and Notes, in that order, and never Timeline'). Same show / hide / order " +
      "/ options / reset vocabulary as set_record_layout, applied one level up.\n\n" +
      "A record that has its OWN layout keeps it and is unaffected: a record " +
      "diverges from its type, it never defines it. reset:true clears the type " +
      "default so records fall back to the built-in starting set for that type. " +
      "Use get_record_layout on an example record to see the current shape and " +
      "whether it reads 'type' or 'generated'.",
    inputSchema: {
      type: "object",
      properties: {
        typeKey: { type: "string", description: "The type key, e.g. 'project' (see list_types)." },
        show: { type: "array", items: { type: "string" }, description: "Section ids every record of this type should show." },
        hide: { type: "array", items: { type: "string" }, description: "Section ids no record of this type should show by default." },
        order: { type: "array", items: { type: "string" }, description: "Section ids in the order you want them to appear." },
        options: { type: "object", description: "Per-section defaults keyed by section id, e.g. {\"tasks\":{\"limit\":10}}." },
        reset: { type: "boolean", description: "true = clear the type default so records use the built-in starting set." },
      },
      required: ["typeKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const typeKey = optString(args, "typeKey");
      if (!typeKey) throw new ItemError("bad_request", "typeKey is required");
      const typeDef = await getType(typeKey);

      if (args.reset === true) {
        const updated = await setTypeDefaultWidgets(typeKey, null);
        return {
          type: typeView(updated),
          reset: true,
          note: "records of this type now use the built-in starting set",
          ...layoutView(resolveComposition(null, null, typeKey).composition, "generated"),
        };
      }

      const ops = readLayoutOps(args);
      // Base on the type's stored default if it has one, else the generated set
      // for this type — so a first edit starts from what records actually show.
      const { composition: base } = resolveComposition(null, typeDef.defaultWidgets, typeKey);
      const next = applyLayoutOps(base, ops);
      const updated = await setTypeDefaultWidgets(typeKey, next);
      return {
        type: typeView(updated),
        ...layoutView(resolveComposition(null, updated.defaultWidgets, typeKey).composition, "type"),
        note: "records with their own layout are unchanged; they diverge from the type, not the reverse",
      };
    },
  },
  {
    name: "add_to_record",
    title: "Add something to a record",
    description:
      "Put something INSIDE a record — the 'add these tasks to that project' / " +
      "'file this note under the project' move. Two ways:\n" +
      "  create new — pass type + title (+ bodyMarkdown, dueDate, meetingAt, " +
      "urgency, and titles for several at once). The new item is created and " +
      "filed as living in this record, so it shows up in the matching section " +
      "(a task in Tasks, a note in Notes, an event in Meetings, a milestone in " +
      "Milestones, a link in Links).\n" +
      "  file an existing one — pass itemId instead, and that item moves in.\n" +
      "This sets the item's HOME (its primary residence), which is what makes it " +
      "belong to the record rather than merely be linked to it — so a project " +
      "digest, breadcrumb and roll-up all count it. Use relate_items instead " +
      "when you only want a cross-reference. To nest one task under another " +
      "task, use add_subtasks (parent/child), not this.",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string", description: "The container record's item id (UUID) — e.g. the project." },
        type: { type: "string", enum: [...CONTAINABLE], description: "What to create: task | note | milestone | event | link | mindmap." },
        title: { type: "string", description: "Title of the new item." },
        titles: { type: "array", items: { type: "string" }, description: "Create several of the same type at once, in order. Use instead of title." },
        bodyMarkdown: { type: "string", description: "Body as markdown (single create only). Also accepted as `body`." },
        dueDate: { type: "string", description: "Deadline, ISO 8601 — a milestone's or task's date." },
        scheduledDate: { type: "string", description: "Planned work date, ISO 8601 (tasks)." },
        meetingAt: { type: "string", description: "Start time, ISO 8601 date-time (events)." },
        urgency: { type: "number", description: "Priority 1–6 (tasks; 1 highest)." },
        url: { type: "string", description: "URL (links)." },
        itemId: { type: "string", description: "File an EXISTING item into this record instead of creating one." },
      },
      required: ["recordId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const recordId = asUuid(args.recordId, "recordId");
      const record = await getItem(ownerId, recordId); // owner scope + existence

      // Tasks keep the existing "project" role so the task→project field stays
      // one mechanism; everything else is the generic "contains" (matches the
      // REST contain route exactly).
      const roleFor = (t: string) => (t === "task" ? "project" : "contains");

      // Move an existing item in.
      const existingId = args.itemId != null ? asUuid(args.itemId, "itemId") : undefined;
      if (existingId) {
        if (existingId === recordId) {
          throw new ItemError("bad_request", "a record can't contain itself");
        }
        const existing = await getItem(ownerId, existingId);
        await setHome(ownerId, existingId, recordId, roleFor(existing.type));
        return {
          recordId,
          recordTitle: record.title,
          filed: [rowView(existing)],
          created: 0,
          note: `${existing.type} now lives in this record`,
        };
      }

      const type = optString(args, "type");
      if (!type || !(CONTAINABLE as readonly string[]).includes(type)) {
        throw new ItemError(
          "bad_request",
          `type must be one of: ${CONTAINABLE.join(", ")} (or pass itemId to file an existing item)`
        );
      }

      const single = optString(args, "title");
      const many = args.titles;
      let titles: string[];
      if (Array.isArray(many)) {
        titles = many.map((t, i) => {
          const s = typeof t === "string" ? t.trim() : "";
          if (!s) throw new ItemError("bad_request", `titles[${i}] is empty`);
          return s;
        });
        if (!titles.length) throw new ItemError("bad_request", "titles must be a non-empty array");
        if (titles.length > 50) throw new ItemError("bad_request", "at most 50 per call");
      } else if (single) {
        titles = [single];
      } else {
        throw new ItemError("bad_request", "pass title (or titles) for the item(s) to create, or itemId");
      }

      const asDate = (key: string): Date | undefined => {
        const raw = optString(args, key);
        if (!raw) return undefined;
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) throw new ItemError("bad_request", `${key} is not a valid date`);
        return d;
      };
      const dueDate = asDate("dueDate");
      const scheduledDate = asDate("scheduledDate");
      const meetingAt = asDate("meetingAt");
      const url = optString(args, "url");
      const bodyMarkdown = optBodyMarkdown(args);
      let urgency: number | undefined;
      if (args.urgency !== undefined && args.urgency !== null) {
        const n = Number(args.urgency);
        if (!Number.isInteger(n) || n < 1 || n > 6) {
          throw new ItemError("bad_request", "urgency must be an integer 1–6");
        }
        urgency = n;
      }
      // A body only makes sense for a single create; several titles sharing one
      // body would be a copy-paste, not a checklist.
      if (bodyMarkdown && titles.length > 1) {
        throw new ItemError("bad_request", "bodyMarkdown applies to a single create — omit it when passing titles");
      }

      const created = [];
      for (const title of titles) {
        const item = await createItem(ownerId, {
          type,
          title,
          ...(bodyMarkdown ? { body: { format: "markdown", text: bodyMarkdown } } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(scheduledDate ? { scheduledDate } : {}),
          ...(meetingAt ? { meetingAt } : {}),
          ...(urgency !== undefined ? { urgency: urgency as never } : {}),
          ...(url ? { url } : {}),
        });
        await setHome(ownerId, item.id, recordId, roleFor(type));
        created.push(rowView(item));
      }
      return { recordId, recordTitle: record.title, type, count: created.length, created };
    },
  },
];

// Exported for the verify script: the pure op algebra, so show/hide/order/options
// can be asserted without a database.
export { applyLayoutOps };
