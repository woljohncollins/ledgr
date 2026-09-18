// The widget capability registry (Project Type, ADR-111/PJ3). The PRD's §3
// capability model, Layer 1 (universal availability, derived — no hand-written
// allow-lists). A pure, client-safe catalog (no DB, no React) mirroring
// src/lib/modules.ts and the dashboard-widgets.ts ↔ dashboards.ts split, so the
// gear UI and the server both read one source of truth. Per-Type defaults
// (Layer 2) and per-record instances (Layer 3) live in src/lib/composition.ts;
// the rendering fan-out lands in PJ4.
//
// The one idea: a widget declares what it NEEDS (`requires`) and which scopes it
// runs in (`scope`: bound to a record, and/or unscoped against a query). The
// same widget renders on a Dashboard (query) and on a Type page (record) with no
// widget-side branching on Type — availability is computed, not curated.

export type WidgetKind = "property" | "collection" | "relation" | "derived";
export type WidgetScope = "record" | "query";

// A gear-editable per-widget option (PRD §3 "Per-widget options" section).
export type OptionSchema =
  | { kind: "select"; label: string; choices: string[]; default: string }
  | { kind: "boolean"; label: string; default: boolean }
  | { kind: "number"; label: string; default: number; min?: number; max?: number }
  | { kind: "type"; label: string; default: null }; // a type-key picker (null = any)

export interface WidgetDefinition {
  id: string;
  label: string;
  kind: WidgetKind;
  // Property name | collection name | depended-on data source. Availability is
  // satisfied when every entry is satisfiable for the type (see isSatisfiable).
  requires: string[];
  cardinality: "one" | "many";
  scope: WidgetScope[];
  options?: Record<string, OptionSchema>;
  // True for anything with backing data: disabling HIDES (never deletes) it, and
  // re-enabling restores (Layer 3 rule). Derived/property widgets that own no
  // data set false.
  hideOnDisable: boolean;
  // How a record-scope instance binds to the current record at render (PJ4): the
  // collection type + edge role it surfaces (home-scoped), or the derived source.
  // Pure description here; the fan-out consumes it.
  recordQuery?: { collectionType?: string; role?: string; derived?: string };
}

// The catalog (PRD §6). Order is the gear's "available to add" order.
export const WIDGET_CATALOG: WidgetDefinition[] = [
  {
    id: "overview",
    label: "Overview",
    kind: "property",
    requires: ["overview_md"],
    cardinality: "one",
    scope: ["record", "query"],
    hideOnDisable: false,
  },
  {
    // The type's own custom fields on a widget-home record. Without this, a
    // Project's scalar and relation properties had nowhere to render at all:
    // WidgetCanvas renders neither CustomProperties nor RelationProperties, so a
    // field added in Build was invisible and uneditable on every record that
    // used it (found 2026-09-14, a Scope select on Project). Catalog-level, not
    // Project-specific, because every widget-home type has the same hole.
    id: "properties",
    label: "Properties",
    kind: "property",
    requires: ["custom_properties"],
    cardinality: "one",
    scope: ["record"],
    hideOnDisable: false,
  },
  {
    id: "status",
    label: "Status",
    kind: "property",
    requires: ["status"],
    cardinality: "one",
    scope: ["record", "query"],
    hideOnDisable: false,
  },
  {
    id: "tasks",
    label: "Tasks",
    kind: "collection",
    requires: ["tasks"],
    cardinality: "many",
    scope: ["record", "query"],
    hideOnDisable: true,
    options: {
      // Optional grouping for a record's task list (Tyler, 2026-08-17):
      // "milestone" sections tasks under the milestone they complete,
      // "priority" under P1–P6. Off by default; set from the card's hover gear
      // and honored by the full collection page too.
      groupBy: { kind: "select", label: "Group by", choices: ["none", "milestone", "priority"], default: "none" },
    },
    recordQuery: { collectionType: "task", role: "project" },
  },
  {
    id: "notes",
    label: "Notes",
    kind: "collection",
    requires: ["notes"],
    cardinality: "many",
    scope: ["record", "query"],
    hideOnDisable: true,
    recordQuery: { collectionType: "note", role: "contains" },
  },
  {
    id: "meetings",
    label: "Meetings",
    kind: "collection",
    requires: ["meetings"],
    cardinality: "many",
    scope: ["record", "query"],
    hideOnDisable: true,
    recordQuery: { collectionType: "event", role: "contains" },
  },
  {
    id: "milestones",
    label: "Milestones",
    kind: "collection",
    requires: ["milestones"],
    cardinality: "many",
    scope: ["record", "query"],
    hideOnDisable: true,
    options: {
      // Per-milestone hard/soft is a milestone-instance property; this is the
      // widget-level emphasis default (deferred nicety, PRD §6).
      emphasis: { kind: "select", label: "Emphasis", choices: ["soft", "hard"], default: "soft" },
    },
    recordQuery: { collectionType: "milestone", role: "contains" },
  },
  {
    id: "relatedRecords",
    label: "Related Records",
    kind: "relation",
    requires: ["relationships"],
    cardinality: "many",
    scope: ["record"],
    hideOnDisable: true,
    options: {
      typeFilter: { kind: "type", label: "Only show type", default: null },
    },
    recordQuery: { role: "contains" },
  },
  {
    id: "links",
    label: "Links / Resources",
    kind: "collection",
    requires: ["links"],
    cardinality: "many",
    scope: ["record", "query"],
    hideOnDisable: true,
    recordQuery: { collectionType: "link", role: "contains" },
  },
  {
    id: "people",
    label: "People",
    kind: "relation",
    requires: ["people"],
    cardinality: "many",
    scope: ["record", "query"],
    hideOnDisable: true,
    recordQuery: { collectionType: "person", role: "related" },
  },
  {
    id: "mindmap",
    label: "Mindmap",
    kind: "collection",
    requires: ["mindmap"],
    cardinality: "one",
    scope: ["record"],
    hideOnDisable: true,
    recordQuery: { collectionType: "mindmap", role: "contains" },
  },
  {
    id: "nextAction",
    label: "Next Action",
    kind: "derived",
    requires: ["tasks"],
    cardinality: "one",
    scope: ["record", "query"],
    hideOnDisable: false,
    recordQuery: { derived: "nextAction" },
  },
  {
    id: "progress",
    label: "Progress",
    kind: "derived",
    requires: ["tasks"],
    cardinality: "one",
    scope: ["record", "query"],
    hideOnDisable: false,
    options: {
      weighting: {
        kind: "select",
        label: "Weighting",
        choices: ["hierarchical", "flat"],
        default: "hierarchical",
      },
    },
    recordQuery: { derived: "progress" },
  },
  {
    id: "recentActivity",
    label: "Recent Activity",
    kind: "derived",
    requires: ["activity_log"],
    cardinality: "one",
    scope: ["record", "query"],
    hideOnDisable: false,
    recordQuery: { derived: "recentActivity" },
  },
  {
    id: "timeline",
    label: "Timeline",
    kind: "derived",
    requires: ["meetings", "milestones"],
    cardinality: "one",
    scope: ["record"],
    hideOnDisable: false,
    recordQuery: { derived: "timeline" },
  },
  {
    // Files (ADR-236): the record's ATTACHMENTS — the one card backed by the
    // attachments table rather than items, hence "derived" with no
    // collectionType. Upload / open / share / remove ride the shared FilePanel.
    id: "files",
    label: "Files",
    kind: "derived",
    requires: ["files"],
    cardinality: "many",
    scope: ["record"],
    hideOnDisable: true,
    recordQuery: { derived: "files" },
  },
];

const BY_ID = new Map(WIDGET_CATALOG.map((w) => [w.id, w]));

// --- Custom-type tools (Tyler, 2026-08-17) -----------------------------------
// Any owner-created type can be OFFERED AS A TOOL on widget-home records: a
// "Chapter" type becomes a Chapters card on a Book project, with its own typed
// "+ Add". The definition is SYNTHETIC — derived from the type key on demand
// (id "collection:<key>") rather than registered in the catalog — so the
// catalog stays a pure constant and a stored composition referencing one keeps
// resolving forever (reconcileComposition never drops it, even while the type
// is un-offered; the type being deleted is what retires the card, at fan-out).
// Which types are offered lives in settings.toolTypes (owner UI prefs, the
// listTabs/cardsByType posture); src/lib/custom-tools.ts resolves labels.
export const CUSTOM_TOOL_PREFIX = "collection:";

// The type keys already covered by a built-in catalog tool (derived, not
// hand-listed) — offering these as custom tools would render the card twice.
export const BUILTIN_TOOL_TYPE_KEYS: ReadonlySet<string> = new Set(
  WIDGET_CATALOG.map((w) => w.recordQuery?.collectionType).filter(
    (k): k is string => Boolean(k)
  )
);

// The type key inside a synthetic tool id, or null when the id isn't one (or
// isn't slug-shaped — the same shape the types table enforces on keys).
export function customToolTypeKey(id: string): string | null {
  if (!id.startsWith(CUSTOM_TOOL_PREFIX)) return null;
  const key = id.slice(CUSTOM_TOOL_PREFIX.length);
  return /^[a-z][a-z0-9_]*$/.test(key) ? key : null;
}

// Build the synthetic definition. `label` defaults to a readable form of the
// key; callers with the type registry in hand (custom-tools.ts, the fan-out)
// pass the type's real label.
export function customCollectionWidget(typeKey: string, label?: string): WidgetDefinition {
  return {
    id: `${CUSTOM_TOOL_PREFIX}${typeKey}`,
    label: label ?? typeKey.charAt(0).toUpperCase() + typeKey.slice(1).replace(/_/g, " "),
    kind: "collection",
    requires: [], // always satisfiable: any record can contain any collection
    cardinality: "many",
    scope: ["record"],
    hideOnDisable: true,
    recordQuery: { collectionType: typeKey, role: "contains" },
  };
}

export function widgetById(id: string): WidgetDefinition | undefined {
  const hit = BY_ID.get(id);
  if (hit) return hit;
  const key = customToolTypeKey(id);
  return key ? customCollectionWidget(key) : undefined;
}

// Layer 1 availability (derived). A `requires` entry is satisfiable when:
//  - it's a universal base property (overview_md, status) — always, since the
//    shared base carries them (PRD §4); or
//  - it's a collection/relation/derived source (tasks, notes, meetings,
//    milestones, links, people, mindmap, relationships, activity_log) — always,
//    because under the universal containment model any record can contain any
//    collection, and the activity log + relations are global.
// So EVERY catalog widget is available on EVERY type, by construction — which is
// exactly the PRD's "a new Type inherits the whole catalog with zero widget
// authoring." The predicate is kept explicit (not hardcoded `true`) so a future
// type-capability gate has one place to live.
const SATISFIABLE = new Set<string>([
  "overview_md",
  "custom_properties",
  "status",
  "tasks",
  "notes",
  "meetings",
  "milestones",
  "links",
  "people",
  "mindmap",
  "relationships",
  "activity_log",
  "files",
]);

export function isSatisfiable(requirement: string): boolean {
  return SATISFIABLE.has(requirement);
}

export function isWidgetAvailable(def: WidgetDefinition): boolean {
  return def.requires.every(isSatisfiable);
}

// The widgets available to add on a record of `type` (Layer 1). Type-agnostic by
// construction; `type` is accepted for the future capability gate and to keep
// callers honest about scope.
export function availableWidgets(_type?: string): WidgetDefinition[] {
  return WIDGET_CATALOG.filter(isWidgetAvailable);
}

// Widgets that can run in a given scope (record page vs dashboard query).
export function widgetsForScope(scope: WidgetScope): WidgetDefinition[] {
  return WIDGET_CATALOG.filter((w) => w.scope.includes(scope));
}
