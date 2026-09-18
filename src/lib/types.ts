// The type registry store (slice 33, PRD §3.6/§4.10): CRUD + validation for
// the `types` table the Build surface edits. Same discipline as views.ts —
// hand-rolled validation (the shapes are small; a schema lib isn't worth a
// dependency, rule 5), one place that turns request JSON into a well-formed
// definition, and a row->definition coercion so a hand-edited or legacy row
// still reads cleanly.
//
// Types are an instance-global registry, not owner-scoped (one user per
// deploy; the table has no owner_id). The mutations still run behind
// requireOwner in the API, and the items.type -> types.key FK keeps a type
// that's in use from being deleted. A user type is just a row: it inherits the
// default markdown canvas and markdown format from the module registry
// (modules.ts resolvers fall back for any unregistered type), so the builder
// never touches code — it writes label/icon/property_schema, and the registry
// owns code behavior (ADR-043).
import { cache } from "react";
import { eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items, types } from "@/db/schema";
import { parseCanvasLayout, type CanvasLayout } from "@/lib/canvas-layout";
import { parseComposition, type Composition } from "@/lib/composition";
import {
  isStatusMode,
  parseStatusSchema,
  resolveStatusMode,
  resolveStatusSchema,
  validateStatusSchema,
  type StatusDef,
  type StatusMode,
} from "@/lib/status";
import { ItemError } from "@/lib/items";
import { capabilityById } from "@/lib/modules";
// SPIKE (bespoke-tool catalog): registers the workflow modules (Songs, Papers)
// onto core for their side effect, so capability validation here — and the API
// route that calls parseTypeInput — sees the attachable capabilities. Idempotent
// (register.ts guards the duplicate-id throw). The canvas path imports this via
// module-wiring; this is the type-validation path's counterpart.
import "@/lib/modules/register";

// The core property kinds (schema.md "Property kinds"). text/number/date/
// checkbox/url/phone/email are scalar; select/multi_select carry an options list.
// `relation` is a typed item-to-item link the user adds in the builder (ADR-067,
// un-deferred from ADR-044/055): unlike the scalar kinds it stores no value in
// items.properties — its value lives as `relations` edges whose `role` is the
// field's `key` (an "Author" field => edges with role 'author'). It carries a
// targetType (which type the links accept; null = any) and a cardinality.
//
// `phone` and `email` (ADR-192) are `text` with a declared intent: they store the
// string EXACTLY as typed and differ only in how they render — a `tel:`/`mailto:`
// link, and the matching on-screen keyboard. They exist because the intent was
// previously guessed from the field's key ("phone", "mobile", "cell"), which
// worked or silently didn't depending on what the field was named. Nothing
// validates or reformats the value: a field that refuses a valid phone number is
// worse than one that renders an odd one, and phone formats are a swamp
// (extensions, country codes, "x203", letters). Normalization happens only when
// building the href — see telHref in lib/contact-links.ts.
export const PROPERTY_KINDS = [
  "text",
  "number",
  "date",
  "checkbox",
  "url",
  // An image property stores the same plain string a url does (an http(s) URL
  // or a stable /files/<id> attachment address, ADR-228); the kind only
  // changes rendering (ADR-255).
  "image",
  "phone",
  "email",
  "select",
  "multi_select",
  "relation",
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

const KINDS_WITH_OPTIONS: PropertyKind[] = ["select", "multi_select"];

// A relation field's link count rule (ADR-067). `single` replaces its edge on a
// new pick (one Author); `many` accumulates (several Attendees). Enforced in the
// app layer (the typed-relation input), not by a DB constraint.
export const RELATION_CARDINALITIES = ["single", "many"] as const;
export type RelationCardinality = (typeof RELATION_CARDINALITIES)[number];

// One custom field on a type. `key` is the stable identifier (never changes once
// created, so renaming the label doesn't orphan values — for scalar kinds it's
// the items.properties key, for a relation it's the edge `role`); `label` is the
// display name; `options` lists the choices for select/multi_select. For a
// `relation` kind, `targetType` is the type its links accept (null = any type)
// and `cardinality` is single/many; both are unset for the other kinds.
export type PropertyDef = {
  key: string;
  label: string;
  kind: PropertyKind;
  options?: string[];
  targetType?: string | null;
  cardinality?: RelationCardinality;
  // `date` kind only (the range rule, ADR-timeline): when true the field carries
  // an optional END date alongside its start, letting an item span a range on
  // the Planner's Timeline. Start stays the plain ISO scalar at properties[key];
  // the end lives at properties[key + "__end"] (placement.ts END_SUFFIX), so
  // every existing filter/sort on the start key is untouched. Unset = a single
  // date. Declared once here, so no manual "which field is the end" wiring.
  withEnd?: boolean;
  // `date` kind only (ADR-254): when true the field carries a wall-clock TIME as
  // well as a day. The value is then a full ISO instant ("2026-09-11T02:06:00Z")
  // instead of a day scalar ("2026-09-10"); readers tell the two apart by length
  // (placement.ts propInstant), so a field flipped on later keeps its old
  // day-only values readable, and a cleared time falls back to a day. Combined
  // with withEnd, one field is a timed range (a work-log entry's 9:06–9:15 PM).
  withTime?: boolean;
};

export type TypeDefinition = {
  key: string;
  label: string;
  icon: string | null;
  isSystem: boolean;
  propertySchema: PropertyDef[];
  // Configurable statuses (Tasks Polish S2, ADR-082); null = inherit the system
  // default (To Do / Done / Archived). Parsed tolerantly on read — a malformed
  // value reads as null (inherit), mirroring how a bad property_schema → [].
  statusSchema: StatusDef[] | null;
  // How this type presents completion (ADR-106): 'none' | 'checkbox' | 'select'.
  // Resolved (never null) — an unset row resolves via resolveStatusMode. Drives
  // the canvas control, the view-builder status filter/group/column, and list
  // chips/checkboxes. Presentation only; status_category stays the plumbing.
  statusMode: StatusMode;
  showInQuickCapture: boolean;
  // Whether this type's items show a Listen (read-aloud) control on the canvas.
  listenEnabled: boolean;
  // Nested under listenEnabled: redirect to Microsoft Edge instead of playing
  // locally, when the browser supports it and isn't already Edge.
  listenOpenInEdge: boolean;
  // SPIKE (bespoke-tool catalog): the attached module-capability id, or null.
  // The registry (modules.ts) resolves this type's canvas/format/exporters from
  // it when set — see canvasIdForType's third arg.
  capability: string | null;
  // Hidden from everyday surfaces (ADR-059); the type still exists and works.
  hidden: boolean;
  // Arrangeable item-canvas layout (ADR-069, Feature B); null = the generated
  // default (classic stacked render). Parsed tolerantly — a malformed value reads
  // as null, mirroring how a bad property_schema degrades to [].
  canvasLayout: CanvasLayout | null;
  // Per-type default widget composition (Layer 2, ADR-111/PJ2). Raw jsonb —
  // src/lib/composition.ts is the single tolerant parser (resolveComposition),
  // so it's passed through unparsed here. null = the generated default.
  defaultWidgets: unknown;
  // Soft-delete stamp (ADR-058); null = live. A deleted type is hidden from the
  // registry/pickers but its row stays so trashed items keep a valid FK.
  deletedAt: Date | null;
  createdAt: Date;
};

// The editable fields the builder submits. Create also carries `key` (the PK,
// immutable after create); patch never does.
export type TypeInput = {
  label: string;
  icon: string | null;
  propertySchema: PropertyDef[];
  showInQuickCapture: boolean;
  capability: string | null; // SPIKE: attached bespoke-tool capability id
};
export type TypeCreateInput = TypeInput & { key: string };

// Lowercase slug: starts with a letter, then letters/digits/underscore. Used
// for both a type key and a property key (both end up as map keys / FK values,
// so they stay simple and stable). Hyphens are out so a key is a clean JS
// identifier in items.properties.
const SLUG_RE = /^[a-z][a-z0-9_]*$/;

function bad(message: string): never {
  throw new ItemError("bad_request", message);
}

function asTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string") bad(`${field} must be a string`);
  return value.trim();
}

// A display label (type label or property label): required, trimmed, capped at
// 80. Shared by the full builder parse and the inline-rename path (ADR-068).
function parseLabel(raw: unknown): string {
  const label = asTrimmedString(raw, "label");
  if (!label) bad("label is required");
  if (label.length > 80) bad("label too long");
  return label;
}

// A type or property key: slug-shaped and length-capped, normalized to
// lowercase so "Author" and "author" can't both exist.
function parseKey(raw: unknown, field: string): string {
  const key = asTrimmedString(raw, field).toLowerCase();
  if (!key) bad(`${field} is required`);
  if (key.length > 40) bad(`${field} too long (40 max)`);
  if (!SLUG_RE.test(key)) {
    bad(`${field} must start with a letter and use only letters, digits, _`);
  }
  return key;
}

// A relation field's targetType: a type key (slug-shaped), or null for "any
// type". Shape-only (see the caller for why existence isn't checked here).
function parseRelationTarget(raw: unknown, key: string): string | null {
  if (raw == null || raw === "") return null;
  const t = asTrimmedString(raw, `property '${key}' targetType`).toLowerCase();
  if (!t) return null;
  if (t.length > 40 || !SLUG_RE.test(t)) {
    bad(`property '${key}' has an invalid targetType`);
  }
  return t;
}

// Validate the property list: each def has a slug key, a label, a known kind,
// and (for select/multi_select) a non-empty options list. Duplicate keys are
// rejected so item values never collide. Returns a normalized PropertyDef[].
export function parsePropertySchema(raw: unknown): PropertyDef[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) bad("propertySchema must be an array");
  if (raw.length > 50) bad("a type can have at most 50 properties");
  const out: PropertyDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      bad("each property must be an object");
    }
    const e = entry as Record<string, unknown>;
    const key = parseKey(e.key, "property key");
    if (seen.has(key)) bad(`duplicate property key '${key}'`);
    seen.add(key);
    const label = asTrimmedString(e.label, "property label");
    if (!label) bad(`property '${key}' needs a label`);
    if (label.length > 80) bad(`property '${key}' label too long`);
    const kind = e.kind;
    if (!PROPERTY_KINDS.includes(kind as PropertyKind)) {
      bad(`property '${key}' has an unknown kind`);
    }
    const def: PropertyDef = { key, label, kind: kind as PropertyKind };
    // A date field may opt into an end date (the range rule, ADR-timeline).
    // Tolerant: only honored for `date`, only when literally true.
    if (def.kind === "date" && e.withEnd === true) {
      def.withEnd = true;
    }
    if (def.kind === "date" && e.withTime === true) {
      def.withTime = true;
    }
    if (KINDS_WITH_OPTIONS.includes(def.kind)) {
      if (!Array.isArray(e.options)) bad(`property '${key}' needs options`);
      const options = Array.from(
        new Set(
          (e.options as unknown[])
            .map((o) => asTrimmedString(o, `property '${key}' option`))
            .filter(Boolean)
        )
      );
      if (options.length === 0) bad(`property '${key}' needs at least one option`);
      if (options.length > 100) bad(`property '${key}' has too many options`);
      def.options = options;
    }
    if (def.kind === "relation") {
      // A relation field's value is stored as edges with role = this key
      // (ADR-067), so the key can't be one of the reserved roles: 'mention'
      // (body-owned, diff-synced — src/lib/mentions.ts MENTION_ROLE) or
      // 'related' (the generic +Relate default). Either would mix typed-field
      // links with edges the field doesn't own.
      if (key === "mention" || key === "related") {
        bad(`property '${key}' uses a reserved relation role; pick another key`);
      }
      // targetType is a type key (optional; null = links accept any type). We
      // validate its *shape* only, not existence: parsePropertySchema is pure
      // and also runs on every read (rowToDefinition), so it can't hit the DB,
      // and a target type that's later deleted should degrade to "any", not
      // make the whole schema unreadable. The builder's dropdown only offers
      // real, live types, so a bad shape here means a hand-edited row.
      def.targetType = parseRelationTarget(e.targetType, key);
      def.cardinality =
        e.cardinality === "single" ? "single" : "many"; // default many
    }
    out.push(def);
  }
  return out;
}

// SPIKE (bespoke-tool catalog): validate an attached capability id against the
// live registry, so a type can't store a capability no enabled module offers.
// null/"" means a plain custom type (default markdown canvas).
function parseCapability(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const id = asTrimmedString(raw, "capability");
  if (!id) return null;
  if (!capabilityById(id)) bad(`unknown bespoke tool '${id}'`);
  return id;
}

function parseCommon(raw: unknown): {
  r: Record<string, unknown>;
  label: string;
  icon: string | null;
  propertySchema: PropertyDef[];
  showInQuickCapture: boolean;
  capability: string | null;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad("request body must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const label = parseLabel(r.label);
  const icon =
    r.icon == null || r.icon === "" ? null : asTrimmedString(r.icon, "icon");
  const propertySchema = parsePropertySchema(r.propertySchema);
  // Default true (a new type is capturable unless the builder opts it out).
  const showInQuickCapture = r.showInQuickCapture !== false;
  const capability = parseCapability(r.capability);
  return { r, label, icon, propertySchema, showInQuickCapture, capability };
}

export function parseTypeInput(raw: unknown, mode: "create"): TypeCreateInput;
export function parseTypeInput(raw: unknown, mode: "patch"): TypeInput;
export function parseTypeInput(
  raw: unknown,
  mode: "create" | "patch"
): TypeCreateInput | TypeInput {
  const { r, label, icon, propertySchema, showInQuickCapture, capability } =
    parseCommon(raw);
  if (mode === "create") {
    return {
      key: parseKey(r.key, "key"),
      label,
      icon,
      propertySchema,
      showInQuickCapture,
      capability,
    };
  }
  return { label, icon, propertySchema, showInQuickCapture, capability };
}

// Drizzle returns property_schema as unknown; coerce through the parser so a
// legacy/hand-edited row still yields a well-formed definition (a malformed
// schema degrades to [] rather than throwing on read).
function rowToDefinition(row: typeof types.$inferSelect): TypeDefinition {
  let propertySchema: PropertyDef[] = [];
  try {
    propertySchema = parsePropertySchema(row.propertySchema);
  } catch {
    propertySchema = [];
  }
  const statusSchema = parseStatusSchema(row.statusSchema);
  return {
    key: row.key,
    label: row.label,
    icon: row.icon,
    isSystem: row.isSystem,
    propertySchema,
    statusSchema,
    // A custom schema with an unset mode resolves to 'select' (never hide a
    // multi-status type's own statuses); otherwise unset resolves to 'none'.
    statusMode: resolveStatusMode(row.statusMode, statusSchema != null),
    showInQuickCapture: row.showInQuickCapture,
    listenEnabled: row.listenEnabled,
    listenOpenInEdge: row.listenOpenInEdge,
    capability: row.capability,
    hidden: row.hidden,
    canvasLayout: parseCanvasLayout(row.canvasLayout),
    defaultWidgets: row.defaultWidgets ?? null,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

// System types sort first, then alphabetical by label — the same order the nav
// uses (compareTypeKeys), so the Build list reads like the rest of the app.
// Soft-deleted types always drop out. Hidden types (ADR-059) drop out of the
// everyday surfaces too — pass includeHidden:true on the Build → Types page,
// where the whole point is to see and un-hide them.
// The cached inner is keyed on a PRIMITIVE (cache() compares arguments by
// identity, so an options object literal would never hit). Nav and pages both
// list types on every render; cache() folds those into one query per request,
// the resolveOwnerState pattern (owner.ts). Passthrough in route handlers, so
// type mutations never read stale.
const listTypesCached = cache(async (includeHidden: boolean): Promise<TypeDefinition[]> => {
  const where = includeHidden
    ? isNull(types.deletedAt)
    : sql`${types.deletedAt} is null and ${types.hidden} = false`;
  const rows = await getDb().select().from(types).where(where);
  return rows
    .map(rowToDefinition)
    .sort(
      (a, b) =>
        Number(b.isSystem) - Number(a.isSystem) ||
        a.label.localeCompare(b.label)
    );
});

export async function listTypes(
  opts: { includeHidden?: boolean } = {}
): Promise<TypeDefinition[]> {
  return listTypesCached(opts.includeHidden === true);
}

// Whether an item of this type may belong to SEVERAL records at once (ADR-232).
// Derived, never configured: a type with no completion concept (statusMode
// "none" — note, event, link) is a RESOURCE. It can be relevant to two projects
// without living in either, so attaching it to a second record adds a plain
// `related` edge and leaves its home alone. A type that COMPLETES (task,
// milestone) rolls up into one record's progress bar and one record's
// completion sweep, so it lives in exactly one and attaching MOVES it.
//
// Deriving it rather than adding a per-type flag reproduces the split exactly
// (Brandon + Tyler, 2026-08-28) with nothing to configure. The tradeoff is
// real and worth knowing: giving a type a Done checkbox in Build narrows it to
// one record from then on. Existing second edges are left alone (they are
// `related`, which the completion sweep does not touch), they simply stop
// being created for that type.
export async function mayLiveInManyRecords(typeKey: string): Promise<boolean> {
  const t = await getType(typeKey).catch(() => null);
  // Unknown type: fall back to the containing behavior, which is what every
  // attach did before this rule existed.
  return t?.statusMode === "none";
}

export async function getType(key: string): Promise<TypeDefinition> {
  const rows = await getDb().select().from(types).where(eq(types.key, key));
  if (rows.length === 0) throw new ItemError("not_found", "type not found");
  return rowToDefinition(rows[0]);
}

export async function createType(
  input: TypeCreateInput
): Promise<TypeDefinition> {
  // Friendly pre-check rather than surfacing a raw PK-conflict from the driver.
  const existing = await getDb()
    .select({ key: types.key })
    .from(types)
    .where(eq(types.key, input.key));
  if (existing.length > 0) bad(`a type with key '${input.key}' already exists`);

  const rows = await getDb()
    .insert(types)
    .values({
      key: input.key,
      label: input.label,
      icon: input.icon,
      isSystem: false, // the five system types are seeded, never built here
      propertySchema: input.propertySchema,
      showInQuickCapture: input.showInQuickCapture,
      capability: input.capability,
    })
    .returning();
  return rowToDefinition(rows[0]);
}

// Edits label/icon/property_schema/show-in-quick-capture/capability. The key is
// the PK and
// FK target, so it's immutable (renaming it would orphan every item). System
// types are editable here (adding a property to "meeting" is harmless and
// useful); only delete is blocked for them.
export async function updateType(
  key: string,
  input: TypeInput
): Promise<TypeDefinition> {
  await getType(key); // existence
  const rows = await getDb()
    .update(types)
    .set({
      label: input.label,
      icon: input.icon,
      propertySchema: input.propertySchema,
      showInQuickCapture: input.showInQuickCapture,
      capability: input.capability,
    })
    .where(eq(types.key, key))
    .returning();
  return rowToDefinition(rows[0]);
}

// Toggle a type's hidden flag (ADR-059). Works for system and user types alike
// — hiding a built-in like Link is the headline use. A no-op-safe single update;
// editing a type through the builder never touches this column, so the hidden
// state survives edits.
export async function setTypeHidden(key: string, hidden: boolean): Promise<void> {
  await getType(key); // existence (throws not_found)
  await getDb().update(types).set({ hidden }).where(eq(types.key, key));
}

// Toggle whether a type appears in the quick-capture dropdown (the Build → Types
// "Quick Capture" column). A standalone setter so the column can flip it without
// resending the whole definition; the builder's "Show in quick capture" checkbox
// writes the same column through the full PATCH. (A hidden type stays out of
// capture regardless — the Nav query requires both.)
export async function setTypeQuickCapture(
  key: string,
  showInQuickCapture: boolean
): Promise<void> {
  await getType(key); // existence (throws not_found)
  await getDb().update(types).set({ showInQuickCapture }).where(eq(types.key, key));
}

// Toggle whether a type's items show a Listen (read-aloud) control (the Build →
// Types "Listen" column). Mirrors setTypeQuickCapture exactly: a standalone
// setter so the column can flip it without resending the whole definition.
export async function setTypeListenEnabled(
  key: string,
  listenEnabled: boolean
): Promise<void> {
  await getType(key); // existence (throws not_found)
  await getDb().update(types).set({ listenEnabled }).where(eq(types.key, key));
}

// Toggle whether Listen redirects to Microsoft Edge instead of playing locally.
// Only meaningful when listenEnabled is also true; the UI nests this checkbox
// under Listen, but the column itself has no DB-level dependency on it.
export async function setTypeListenOpenInEdge(
  key: string,
  listenOpenInEdge: boolean
): Promise<void> {
  await getType(key); // existence (throws not_found)
  await getDb().update(types).set({ listenOpenInEdge }).where(eq(types.key, key));
}

// Inline label fix (ADR-068): rename a type's display label in place from the
// item view, without opening the full builder. Only the label moves — the key
// (PK/FK) is untouched, so nothing is orphaned. System types are allowed (a
// label is harmless; only delete is blocked for them), matching updateType.
export async function renameTypeLabel(
  key: string,
  rawLabel: unknown
): Promise<TypeDefinition> {
  const label = parseLabel(rawLabel);
  await getType(key); // existence (throws not_found)
  const rows = await getDb()
    .update(types)
    .set({ label })
    .where(eq(types.key, key))
    .returning();
  return rowToDefinition(rows[0]);
}

// Inline label fix (ADR-068): rename one property/relation field's display label
// in place. The property `key` (the items.properties key, or a relation edge's
// `role`) never changes, so stored values and relation edges are untouched — it's
// a pure display rename. The rest of the schema is read back and rewritten as-is.
export async function renamePropertyLabel(
  key: string,
  propertyKey: string,
  rawLabel: unknown
): Promise<TypeDefinition> {
  const label = parseLabel(rawLabel);
  const def = await getType(key); // existence + parsed schema
  let found = false;
  const propertySchema = def.propertySchema.map((p) => {
    if (p.key !== propertyKey) return p;
    found = true;
    return { ...p, label };
  });
  if (!found) bad(`type '${key}' has no property '${propertyKey}'`);
  const rows = await getDb()
    .update(types)
    .set({ propertySchema })
    .where(eq(types.key, key))
    .returning();
  return rowToDefinition(rows[0]);
}

// Save (or reset) a type's item-canvas layout (ADR-069, Feature B). Mirrors the
// focused-endpoint setters (setTypeQuickCapture, renameTypeLabel): a small
// dedicated path the arrange UI PATCHes, never the whole-definition builder, so
// it can't clobber a concurrent schema edit. A null layout resets to the default
// (classic render). A non-null layout is run through parseCanvasLayout so a
// client can't store junk — an unparseable shape is a bad request, not a silent
// corrupt row. Types are instance-global, so this is owner-agnostic (guarded by
// requireOwner at the route).
export async function setTypeCanvasLayout(
  key: string,
  rawLayout: unknown
): Promise<TypeDefinition> {
  await getType(key); // existence (throws not_found)
  let value: CanvasLayout | null = null;
  if (rawLayout != null) {
    value = parseCanvasLayout(rawLayout);
    if (!value) bad("invalid canvas layout");
  }
  const rows = await getDb()
    .update(types)
    .set({ canvasLayout: value })
    .where(eq(types.key, key))
    .returning();
  return rowToDefinition(rows[0]);
}

// Save a type's DEFAULT WIDGET SET — Layer 2 of the composition model
// (ADR-111/PJ3): which sections every record of this type shows before any
// individual record diverges. `types.default_widgets` has been read on the render
// path since PJ3 (resolveComposition overlays record → type → generated) but had
// no writer anywhere in the app until ADR-181; the only editable layer was the
// per-record one. A focused setter like setTypeCanvasLayout / setTypeStatusConfig.
//
// null clears it, which is not the same as an empty widget list: cleared means
// "fall back to the generated default for this type" (the Project/Pursuit/generic
// starting sets), while an empty list means "this type shows no sections." Both
// are legal and different, so the caller's null-vs-[] is preserved exactly.
export async function setTypeDefaultWidgets(
  key: string,
  rawComposition: unknown
): Promise<TypeDefinition> {
  await getType(key); // existence (throws not_found)
  let value: Composition | null = null;
  if (rawComposition != null) {
    value = parseComposition(rawComposition);
    // parseComposition is tolerant by design (bad shape → null) because it runs
    // on the render path; a WRITE must not silently store nothing, so a shape it
    // rejects is an error here rather than a quiet clear.
    if (!value) bad("invalid widget composition (expected { version: 1, widgets: [...] })");
  }
  const rows = await getDb()
    .update(types)
    .set({ defaultWidgets: value })
    .where(eq(types.key, key))
    .returning();
  return rowToDefinition(rows[0]);
}

// Save a type's status configuration — its display MODE (ADR-106) and, in
// 'select' mode, its configurable statuses (Tasks Polish S2, ADR-082). A focused
// setter like setTypeCanvasLayout: the editor PATCHes just this, never the
// whole-definition builder, so it can't clobber a schema edit.
//
// DEFER-BY-HIDING: the stored status_schema is only written in 'select' mode (the
// only mode that edits it). Switching to 'checkbox'/'none' sets the mode and
// leaves the schema untouched, so flipping back to 'select' restores the user's
// statuses verbatim. The category re-sync (re-bucketing items so the hot queries
// never read a stale denormalized status_category) only runs when the schema is
// (re)written. status keys are validated slugs and categories are enum values, so
// the dynamic CASE is built from bound params.
export async function setTypeStatusConfig(
  key: string,
  rawMode: unknown,
  rawSchema: unknown
): Promise<TypeDefinition> {
  await getType(key); // existence (throws not_found)
  if (!isStatusMode(rawMode)) {
    bad("status mode must be 'none', 'checkbox', or 'select'");
  }
  const mode = rawMode;

  // none / checkbox: set the mode, preserve the schema (no write, no re-sync).
  if (mode !== "select") {
    const rows = await getDb()
      .update(types)
      .set({ statusMode: mode })
      .where(eq(types.key, key))
      .returning();
    return rowToDefinition(rows[0]);
  }

  // select: set the mode AND write the schema (null = inherit the default).
  const value: StatusDef[] | null =
    rawSchema == null ? null : validateStatusSchema(rawSchema, (m) => bad(m));
  const rows = await getDb()
    .update(types)
    .set({ statusMode: mode, statusSchema: value })
    .where(eq(types.key, key))
    .returning();

  // Re-bucket existing items against the effective set (custom or default).
  const resolved = resolveStatusSchema(value);
  const cases = resolved.map(
    (s) => sql`when ${s.key} then ${s.category}::status_category`
  );
  await getDb().execute(sql`
    update items
    set status_category =
      case status ${sql.join(cases, sql` `)} else 'not_started'::status_category end
    where type = ${key}
  `);
  return rowToDefinition(rows[0]);
}

// How many items reference this type (across all owners — the type is
// instance-global). Surfaced in the builder so the in-context confirm can offer
// to take the items too.
export async function countItemsOfType(key: string): Promise<number> {
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(eq(items.type, key));
  return count;
}

// Live (non-trashed) items of a type — the set that blocks a plain delete (a
// type can be soft-deleted once nothing live points at it; already-trashed items
// keep their valid FK to the soft-deleted row).
export async function countLiveItemsOfType(key: string): Promise<number> {
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(sql`${items.type} = ${key} and ${items.deletedAt} is null`);
  return count;
}

// Soft-delete to Trash (ADR-058), not a hard delete: deletes move to Trash
// everywhere in Ledgr, and a type is no exception. Blocked for system types.
// Blocked while live items still reference it (reassign them or take the
// withItems path so they go to Trash together) — without that, deleting the
// type would leave live items pointing at a hidden type. An empty type (or one
// whose items are already trashed separately) just gets its deleted_at stamped;
// the row stays so any trashed items keep a valid FK, and it surfaces in Trash
// as a restorable entry.
export async function deleteType(key: string): Promise<void> {
  const def = await getType(key);
  if (def.isSystem) bad("system types can't be deleted");
  const live = await countLiveItemsOfType(key);
  if (live > 0) {
    bad(`type '${key}' is used by ${live} item(s); reassign them or delete the type with its items`);
  }
  await getDb().update(types).set({ deletedAt: sql`now()` }).where(eq(types.key, key));
}

// Soft-delete a type AND its live items in one operation (the "take its items
// too" path). The type and every taken item share one deleted_at timestamp, so
// restoreType can revive exactly the set that went to Trash together. Items go
// to Trash (recoverable for the retention window), not hard-deleted; relations/
// revisions/attachments are untouched until the eventual purge. Descendants of a
// taken item are taken too (recursive on parent_id), matching softDeleteItem's
// parent-cascade. Owner-scoped (the owner-scope invariant; one user per deploy).
export async function softDeleteTypeWithItems(
  ownerId: string,
  key: string
): Promise<{ deletedItems: number }> {
  const def = await getType(key);
  if (def.isSystem) bad("system types can't be deleted");

  const res = await getDb().execute(sql`
    with recursive doomed as (
      select id from items
      where type = ${key} and owner_id = ${ownerId} and deleted_at is null
      union
      select i.id from items i join doomed d on i.parent_id = d.id
      where i.owner_id = ${ownerId} and i.deleted_at is null
    ),
    ts as (select now() as t),
    upd_items as (
      update items
      set deleted_at = (select t from ts), updated_at = (select t from ts)
      where id in (select id from doomed)
      returning id
    ),
    upd_type as (
      update types set deleted_at = (select t from ts) where key = ${key}
      returning key
    )
    select
      (select count(*) from upd_items)::int as items,
      (select count(*) from upd_type)::int as types
  `);
  return { deletedItems: Number((res.rows[0] as { items: number }).items) };
}

// Restore a soft-deleted type and the items trashed alongside it (matched on the
// shared deleted_at). Items the owner trashed separately keep their own stamp
// and stay put — same "deletion unit" rule as restoreItem.
export async function restoreType(
  ownerId: string,
  key: string
): Promise<{ restoredItems: number }> {
  const res = await getDb().execute(sql`
    with t as (
      select deleted_at as ts from types where key = ${key} and deleted_at is not null
    ),
    upd_items as (
      update items set deleted_at = null, updated_at = now()
      where owner_id = ${ownerId} and deleted_at = (select ts from t)
      returning id
    ),
    upd_type as (
      update types set deleted_at = null
      where key = ${key} and deleted_at is not null
      returning key
    )
    select
      (select count(*) from upd_items)::int as items,
      (select count(*) from upd_type)::int as types
  `);
  if (Number((res.rows[0] as { types: number }).types) === 0) {
    throw new ItemError("not_found", "type not found in trash");
  }
  return { restoredItems: Number((res.rows[0] as { items: number }).items) };
}

// Soft-deleted types for the Trash UI, newest-deleted first, each with a count
// of its trashed items so the page can show "Hiring Candidate · 3 items".
export async function listDeletedTypes(): Promise<
  { key: string; label: string; icon: string | null; deletedAt: Date; itemCount: number }[]
> {
  const rows = await getDb()
    .select({
      key: types.key,
      label: types.label,
      icon: types.icon,
      deletedAt: types.deletedAt,
      // Trashed items of this type — the count shown on the Trash entry.
      // (restoreType also revives their descendants of other types; the label
      // just names the type's own items.)
      itemCount: sql<number>`(select count(*)::int from ${items} where ${items.type} = ${types.key} and ${items.deletedAt} is not null)`,
    })
    .from(types)
    .where(sql`${types.deletedAt} is not null`)
    .orderBy(sql`${types.deletedAt} desc`);
  return rows.map((r) => ({
    ...r,
    deletedAt: r.deletedAt as Date,
    itemCount: Number(r.itemCount),
  }));
}
