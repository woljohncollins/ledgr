// Per-type item templates — a thin REGISTRY over real prototype items (ADR-093,
// reverses ADR-045). A template's content is an ordinary item + subtree
// (is_template = true), authored in the same canvas as any item; this store
// holds only the metadata row (name, type, prototype, default flag, apply
// config) and the apply logic. Apply = cloneItemSubtree(prototype), which
// carries the prototype's body, properties, subtasks, and relation edges onto a
// fresh real item — so the prototype's own content subsumes the old
// body/property_defaults/relation_defaults blob (no second editor, no drift).
// Same owner-scoped, hand-rolled-validation discipline as views.ts/types.ts.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items, relations, templates, types } from "@/db/schema";
import { isItemBody, type ItemBody } from "@/lib/body";
import { cloneItemSubtree } from "@/lib/clone";
import { getItem, ItemError } from "@/lib/items";
import {
  createItem,
  softDeleteItem,
  updateItem,
  type ItemPatch,
} from "@/lib/item-mutations";
import { MENTION_ROLE } from "@/lib/mentions";
import { dateToYmdUtc, ymdToUtcDate } from "@/lib/recurrence";
import { relateItems } from "@/lib/relations";
import { deriveOffsetChildren, shiftChildDates } from "@/lib/relative-subtask-service";
import { applyOffset, relativeOffsetOf } from "@/lib/relative-subtask";
import { dayDelta, isDuePinned, shiftDay } from "@/lib/date-anchor";
import {
  parseApplyConfig,
  resolveDateRule,
  resolveVars,
  resolveVarsInProps,
  resolveVarsInValue,
  scanAskLabels,
  type ApplyConfig,
} from "@/lib/template-vars";
import {
  parseMatchConfig,
  validateMatchConfig,
  type TemplateMatchConfig,
} from "@/lib/templates/match-config";
import { appTimezoneSync, getAppTimezone, todayBounds } from "@/lib/today";

export type ItemTemplate = {
  id: string;
  type: string;
  name: string;
  // The hidden prototype item this template clones on apply. Author it by
  // opening /items/<prototypeItemId> in the normal canvas.
  prototypeItemId: string;
  // The type's default template (TPL4): "+ New" uses it automatically.
  isDefault: boolean;
  // Apply-time config (TPL3b): rules for the dated fields (none | fixed | offset
  // from the apply date). {} = no rules (the clone's cleared dates stand).
  applyConfig: ApplyConfig;
  // Calendar match rule (EM1, ADR-123), or null for a plain content template.
  matchConfig: TemplateMatchConfig | null;
  createdAt: Date;
};

// Create takes only name + type; the prototype is created empty and authored in
// the canvas afterwards. Type is immutable after create (the prototype is keyed
// to it). Patch edits the metadata only (name, default flag).
export type TemplateCreateInput = { type: string; name: string };
export type TemplatePatchInput = {
  name?: string;
  isDefault?: boolean;
  applyConfig?: ApplyConfig;
  // null clears the rule; an object sets it (strictly validated).
  matchConfig?: TemplateMatchConfig | null;
};

function bad(message: string): never {
  throw new ItemError("bad_request", message);
}

function parseName(raw: unknown): string {
  if (typeof raw !== "string") bad("name must be a string");
  const name = raw.trim();
  if (!name) bad("name is required");
  if (name.length > 120) bad("name too long (120 max)");
  return name;
}

export function parseTemplateInput(raw: unknown, mode: "create"): TemplateCreateInput;
export function parseTemplateInput(raw: unknown, mode: "patch"): TemplatePatchInput;
export function parseTemplateInput(
  raw: unknown,
  mode: "create" | "patch"
): TemplateCreateInput | TemplatePatchInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad("request body must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (mode === "create") {
    if (typeof r.type !== "string" || !r.type.trim()) bad("type is required");
    return { type: r.type.trim(), name: parseName(r.name) };
  }
  const patch: TemplatePatchInput = {};
  if (r.name !== undefined) patch.name = parseName(r.name);
  if (r.isDefault !== undefined) {
    if (typeof r.isDefault !== "boolean") bad("isDefault must be a boolean");
    patch.isDefault = r.isDefault;
  }
  if (r.applyConfig !== undefined) {
    // Tolerant: invalid rules are dropped to {} rather than rejected.
    patch.applyConfig = parseApplyConfig(r.applyConfig);
  }
  if (r.matchConfig !== undefined) {
    // Strict: null clears the rule, an object must validate (a silently-dropped
    // match rule would be a confusing footgun, unlike the date-rule parser).
    patch.matchConfig = r.matchConfig === null ? null : validateMatchConfig(r.matchConfig);
  }
  if (
    patch.name === undefined &&
    patch.isDefault === undefined &&
    patch.applyConfig === undefined &&
    patch.matchConfig === undefined
  ) {
    bad("nothing to update");
  }
  return patch;
}

async function assertTypeExists(type: string): Promise<void> {
  const rows = await getDb()
    .select({ key: types.key })
    .from(types)
    .where(and(eq(types.key, type), isNull(types.deletedAt)));
  if (rows.length === 0) throw new ItemError("bad_request", `unknown type '${type}'`);
}

function rowToTemplate(row: typeof templates.$inferSelect): ItemTemplate {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    prototypeItemId: row.prototypeItemId,
    isDefault: row.isDefault,
    applyConfig: parseApplyConfig(row.applyConfig),
    matchConfig: parseMatchConfig(row.matchConfig),
    createdAt: row.createdAt,
  };
}

// The owner's templates, optionally for one type; type then name order so the
// index reads grouped. Joined to items so a registry row whose prototype was
// soft-deleted directly (orphaning the row until the purge cascade clears it) is
// skipped defensively.
export async function listTemplates(
  ownerId: string,
  type?: string
): Promise<ItemTemplate[]> {
  const where = [eq(templates.ownerId, ownerId), isNull(items.deletedAt)];
  if (type) where.push(eq(templates.type, type));
  const rows = await getDb()
    .select({ t: templates })
    .from(templates)
    .innerJoin(items, eq(items.id, templates.prototypeItemId))
    .where(and(...where))
    .orderBy(asc(templates.type), asc(templates.name));
  return rows.map((r) => rowToTemplate(r.t));
}

// One entry in the "+ New" chooser (TPL4): name + default flag + a small preview
// (subtask count, whether it has a starter body).
export type TemplatePickerEntry = {
  id: string;
  name: string;
  isDefault: boolean;
  subtaskCount: number;
  hasBody: boolean;
};

// Templates for the "+ New" chooser, default first then name. One query: joins
// the live prototype (skips an orphaned row) and counts its direct subtasks.
export async function listTemplatesForPicker(
  ownerId: string,
  type?: string
): Promise<TemplatePickerEntry[]> {
  const typeCond = type ? sql` and t.type = ${type}` : sql``;
  const res = await getDb().execute(sql`
    select t.id, t.name, t.is_default as "isDefault",
      (p.body is not null) as "hasBody",
      (select count(*)::int from items c
        where c.parent_id = t.prototype_item_id and c.deleted_at is null) as "subtaskCount"
    from templates t
    join items p on p.id = t.prototype_item_id and p.deleted_at is null
    where t.owner_id = ${ownerId}${typeCond}
    order by t.is_default desc, t.name asc
  `);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    isDefault: r.isDefault === true,
    subtaskCount: Number(r.subtaskCount) || 0,
    hasBody: r.hasBody === true,
  }));
}

export async function getTemplate(
  ownerId: string,
  id: string
): Promise<ItemTemplate> {
  const rows = await getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.ownerId, ownerId)));
  if (rows.length === 0) throw new ItemError("not_found", "template not found");
  return rowToTemplate(rows[0]);
}

// The registry row a given prototype item backs, or null if the item isn't a
// template root (e.g. it's a template subtask, or not a template at all). Powers
// the canvas "Template" banner (ADR-093, TPL2).
export async function getTemplateByPrototype(
  ownerId: string,
  prototypeItemId: string
): Promise<ItemTemplate | null> {
  const rows = await getDb()
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.ownerId, ownerId),
        eq(templates.prototypeItemId, prototypeItemId)
      )
    );
  return rows.length ? rowToTemplate(rows[0]) : null;
}

// Create a template = a registry row + an empty hidden prototype item, authored
// afterwards in the normal canvas (ADR-093). The prototype is is_template=true
// with a blank body; the user opens /items/<prototypeItemId> to build it out
// (subtasks, body, properties, relations — all real).
export async function createTemplate(
  ownerId: string,
  input: TemplateCreateInput
): Promise<ItemTemplate> {
  await assertTypeExists(input.type);
  const prototype = await createItem(ownerId, {
    type: input.type,
    title: input.name,
    isTemplate: true,
    inbox: false,
  });
  const rows = await getDb()
    .insert(templates)
    .values({
      ownerId,
      type: input.type,
      name: input.name,
      prototypeItemId: prototype.id,
    })
    .returning();
  return rowToTemplate(rows[0]);
}

export async function updateTemplate(
  ownerId: string,
  id: string,
  input: TemplatePatchInput
): Promise<ItemTemplate> {
  const existing = await getTemplate(ownerId, id); // ownership + existence
  // Making this the type's default clears any other default for the same type
  // first (the partial unique index allows only one per owner+type).
  if (input.isDefault === true) {
    await getDb()
      .update(templates)
      .set({ isDefault: false })
      .where(
        and(
          eq(templates.ownerId, ownerId),
          eq(templates.type, existing.type),
          eq(templates.isDefault, true)
        )
      );
  }
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.isDefault !== undefined) set.isDefault = input.isDefault;
  if (input.applyConfig !== undefined) set.applyConfig = input.applyConfig;
  if (input.matchConfig !== undefined) set.matchConfig = input.matchConfig;
  const rows = await getDb()
    .update(templates)
    .set(set)
    .where(and(eq(templates.id, id), eq(templates.ownerId, ownerId)))
    .returning();
  return rowToTemplate(rows[0]);
}

// Delete = drop the registry row AND soft-delete its prototype subtree (the
// prototype is a real item; it goes to Trash like any other). Registry-aware so
// the FK can't dangle; best-effort on the prototype (an already-gone one mustn't
// block the registry delete).
export async function deleteTemplate(ownerId: string, id: string): Promise<void> {
  const tmpl = await getTemplate(ownerId, id); // ownership + existence
  await getDb()
    .delete(templates)
    .where(and(eq(templates.id, id), eq(templates.ownerId, ownerId)));
  try {
    await softDeleteItem(ownerId, tmpl.prototypeItemId);
  } catch (err) {
    if (!(err instanceof ItemError)) throw err;
  }
}

// "Save as template" (TPL2): clone an existing item's subtree into a hidden
// template prototype (is_template=true via cloneItemSubtree's override; the whole
// subtree inherits it) and register it. The clone carries the item's body,
// subtasks, properties, and relation edges — so a meeting's usual attendees, a
// task's subtasks, etc. become the template's presets. Rejects a trashed item or
// one that's already a template (duplicate it instead).
export async function createTemplateFromItem(
  ownerId: string,
  itemId: string,
  name?: string
): Promise<ItemTemplate> {
  const src = await getItem(ownerId, itemId); // ownership + existence
  if (src.deletedAt) throw new ItemError("bad_request", "can't make a template from a trashed item");
  if (src.isTemplate) throw new ItemError("bad_request", "this item is already a template — duplicate it instead");
  const finalName = (name?.trim() || src.title.trim() || "Untitled template").slice(0, 120);
  const { rootId } = await cloneItemSubtree(ownerId, itemId, {
    isTemplate: true,
    inbox: false,
  });
  const rows = await getDb()
    .insert(templates)
    .values({ ownerId, type: src.type, name: finalName, prototypeItemId: rootId })
    .returning();
  return rowToTemplate(rows[0]);
}

// Duplicate a template (TPL2): clone its prototype subtree into a new template
// prototype + registry row. The copy is never the default (a duplicate mustn't
// steal the type's default).
export async function duplicateTemplate(
  ownerId: string,
  id: string
): Promise<ItemTemplate> {
  const tmpl = await getTemplate(ownerId, id); // ownership + existence
  const { rootId } = await cloneItemSubtree(ownerId, tmpl.prototypeItemId, {
    isTemplate: true,
    inbox: false,
  });
  const name = `Copy of ${tmpl.name}`.slice(0, 120);
  const rows = await getDb()
    .insert(templates)
    .values({ ownerId, type: tmpl.type, name, prototypeItemId: rootId })
    .returning();
  return rowToTemplate(rows[0]);
}

// Owner-timezone "today" as YYYY-MM-DD, for the variable resolver (TPL3).
function ymdOf(now: Date, tz = appTimezoneSync()): string {
  const t = todayBounds(now, tz).today;
  return `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
}

// id/title/body for an item + its whole live subtree (one recursive read).
async function subtreeNodes(
  ownerId: string,
  rootId: string
): Promise<{ id: string; title: string; body: unknown; properties: unknown }[]> {
  const res = await getDb().execute(sql`
    with recursive sub as (
      select id, title, body, properties from items
        where id = ${rootId} and owner_id = ${ownerId} and deleted_at is null
      union all
      select i.id, i.title, i.body, i.properties from items i
        join sub s on i.parent_id = s.id
        where i.owner_id = ${ownerId} and i.deleted_at is null
    )
    select id, title, body, properties from sub
  `);
  return res.rows as {
    id: string;
    title: string;
    body: unknown;
    properties: unknown;
  }[];
}

// Resolve {{tokens}} across a freshly-cloned subtree's titles + bodies (ADR-093,
// TPL3). The root title resolves first so {{title}} in bodies/descendants echoes
// the final title; `answers` fill {{ask:Label}}; date tokens resolve to `now`.
async function resolveTemplateVars(
  ownerId: string,
  rootId: string,
  opts: { answers?: Record<string, string>; now?: Date; title?: string }
): Promise<void> {
  const now = opts.now ?? new Date();
  const timeZone = await getAppTimezone(ownerId);
  const base = {
    todayYmd: ymdOf(now, timeZone),
    now,
    timeZone,
    answers: opts.answers,
  };
  const nodes = await subtreeNodes(ownerId, rootId);
  const root = nodes.find((n) => n.id === rootId);
  // {{title}} echoes an explicit title (apply-to-existing → the target's), else
  // the resolved root title (new-item apply).
  const resolvedTitle = opts.title ?? (root ? resolveVars(root.title ?? "", base) : "");
  const ctx = { ...base, title: resolvedTitle };
  for (const n of nodes) {
    const patch: { title?: string; body?: ItemBody; properties?: Record<string, unknown> } = {};
    const newTitle = resolveVars(n.title ?? "", ctx);
    if (newTitle !== (n.title ?? "")) patch.title = newTitle;
    if (isItemBody(n.body) && n.body.text) {
      const newText = resolveVars(n.body.text, ctx);
      if (newText !== n.body.text) patch.body = { format: n.body.format, text: newText };
    }
    // TPL6a: resolve tokens in custom property values too (a date/text property
    // preset to {{today+14d}} or {{ask:Due}} fills on apply, like title/body).
    const props = asRecord(n.properties);
    if (props) {
      const { changed, next } = resolveVarsInProps(props, ctx);
      if (changed) patch.properties = next;
    }
    if (patch.title !== undefined || patch.body !== undefined || patch.properties !== undefined) {
      await updateItem(ownerId, n.id, patch);
    }
  }
}

// The distinct {{ask:Label}} prompts a template will ask on apply (titles +
// bodies across its prototype subtree). The apply UI collects these first.
export async function templateAskLabels(
  ownerId: string,
  id: string
): Promise<string[]> {
  const tmpl = await getTemplate(ownerId, id);
  const nodes = await subtreeNodes(ownerId, tmpl.prototypeItemId);
  const texts: (string | null)[] = [];
  for (const n of nodes) {
    texts.push(n.title ?? null);
    if (isItemBody(n.body)) texts.push(n.body.text);
    // TPL6a: an {{ask:}} inside a custom property value is a prompt too.
    const props = asRecord(n.properties);
    if (props) collectStrings(props, texts);
  }
  return scanAskLabels(texts);
}

// Push every string value inside a properties object (incl. inside arrays) onto
// `out`, for scanning property tokens.
function collectStrings(props: Record<string, unknown>, out: (string | null)[]): void {
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const v of Object.values(props)) walk(v);
}

// Set the cloned ROOT's dated fields from the template's apply rules (TPL3b).
// The clone clears the prototype's own dates, so these rules are the source of an
// applied item's due/scheduled. A "none"/absent rule leaves the field empty.
// Setting scheduledDate cascades to relative subtasks (ADR-085) via updateItem.
async function applyDateRules(
  ownerId: string,
  rootId: string,
  cfg: ApplyConfig,
  now: Date
): Promise<void> {
  const todayYmd = ymdOf(now);
  const dueYmd = resolveDateRule(cfg.dueDate, todayYmd);
  const scheduledYmd = resolveDateRule(cfg.scheduledDate, todayYmd);
  if (!dueYmd && !scheduledYmd) return;
  const patch: { dueDate?: Date; scheduledDate?: Date } = {};
  if (dueYmd) patch.dueDate = ymdToUtcDate(dueYmd);
  if (scheduledYmd) patch.scheduledDate = ymdToUtcDate(scheduledYmd);
  await updateItem(ownerId, rootId, patch);
}

// Apply a template: deep-clone its prototype subtree into a fresh REAL item
// (cloneItemSubtree never copies is_template, so the clone and its children are
// is_template=false), then resolve {{tokens}} over the clone (dates / {{title}}
// echo / {{ask:Label}} answers, TPL3a) and set the root's dates from the apply
// rules (TPL3b). Carries the prototype's body, properties, subtasks, and relation
// edges (carryRelations). Deliberate creation, so not an Inbox arrival (ADR-010).
// Returns the new root item. (TPL4 layers apply-to-existing on top of this.)
export async function createItemFromTemplate(
  ownerId: string,
  id: string,
  opts: { answers?: Record<string, string>; now?: Date } = {}
) {
  const tmpl = await getTemplate(ownerId, id);
  const now = opts.now ?? new Date();
  const { rootId } = await cloneItemSubtree(ownerId, tmpl.prototypeItemId, {
    inbox: false,
  });
  await resolveTemplateVars(ownerId, rootId, { answers: opts.answers, now });
  await applyDateRules(ownerId, rootId, tmpl.applyConfig, now);
  // The clone came out undated (cloneItemSubtree resets descendants), so the
  // prototype's offset checklist resolves against the root's freshly applied
  // date — the one place the ADR-085 offset still drives anything (ADR-253).
  const root = await getItem(ownerId, rootId);
  await deriveOffsetChildren(
    ownerId,
    rootId,
    root.scheduledDate ? dateToYmdUtc(root.scheduledDate) : null
  );
  return getItem(ownerId, rootId);
}

export type ApplyMode = "fill" | "overwrite";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// Apply a template onto an ALREADY-STARTED item (ADR-093, TPL4b). Two modes:
// "fill" (default, "change only the unchanged") sets only empty scalars, skips a
// non-empty body, adds only missing properties, and adds the template's subtasks/
// relations the target doesn't have; "overwrite" replaces the scalars + body
// instead. NEITHER deletes the target's own subtasks/relations — they only ADD
// the template's. Tokens + date rules resolve into the merged content (with
// {{title}} echoing the target's final title). Returns the updated target.
export async function applyTemplateToExisting(
  ownerId: string,
  templateId: string,
  targetId: string,
  opts: { mode?: ApplyMode; answers?: Record<string, string>; now?: Date } = {}
) {
  const mode: ApplyMode = opts.mode === "overwrite" ? "overwrite" : "fill";
  const tmpl = await getTemplate(ownerId, templateId);
  const target = await getItem(ownerId, targetId);
  if (target.deletedAt) throw new ItemError("bad_request", "can't apply a template to a trashed item");
  if (target.isTemplate) throw new ItemError("bad_request", "can't apply a template onto another template");
  if (target.type !== tmpl.type) {
    throw new ItemError("bad_request", `template is for '${tmpl.type}', not '${target.type}'`);
  }
  const proto = await getItem(ownerId, tmpl.prototypeItemId);
  const now = opts.now ?? new Date();
  const timeZone = await getAppTimezone(ownerId);
  const todayYmd = ymdOf(now, timeZone);
  const base = { todayYmd, now, timeZone, answers: opts.answers };
  const over = mode === "overwrite";

  // Title: fill keeps the target's if set; overwrite prefers the template's.
  const protoTitle = resolveVars(proto.title ?? "", base);
  const mergedTitle = over
    ? protoTitle || target.title
    : (target.title ?? "").trim()
      ? target.title
      : protoTitle;
  const ctx = { ...base, title: mergedTitle };

  const patch: ItemPatch = {};
  if (mergedTitle !== target.title) patch.title = mergedTitle;

  // Body: overwrite replaces; fill sets only when the target's is blank.
  const protoBody = isItemBody(proto.body) ? proto.body : null;
  const targetHasBody = isItemBody(target.body) && target.body.text.trim().length > 0;
  if (protoBody && (over || !targetHasBody)) {
    patch.body = { format: protoBody.format, text: resolveVars(protoBody.text, ctx) };
  }

  // Other scalars.
  if (proto.urgency != null && (over || target.urgency == null)) patch.urgency = proto.urgency;
  if (proto.url != null && (over || target.url == null)) patch.url = proto.url;

  // Properties: per-key merge (propertyPatch keeps the target's own keys). fill
  // adds only keys the target lacks; overwrite lets template keys win.
  const protoProps = asRecord(proto.properties);
  const targetProps = asRecord(target.properties) ?? {};
  if (protoProps) {
    const propPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(protoProps)) {
      // TPL6a: resolve tokens in the value being merged in (e.g. {{ask:Due}}).
      if (over || !(k in targetProps)) propPatch[k] = resolveVarsInValue(v, ctx);
    }
    if (Object.keys(propPatch).length) patch.propertyPatch = propPatch;
  }

  // Date rules: same fill/overwrite gate against the target's current value.
  const dueYmd = resolveDateRule(tmpl.applyConfig.dueDate, todayYmd);
  const schedYmd = resolveDateRule(tmpl.applyConfig.scheduledDate, todayYmd);
  if (dueYmd && (over || target.dueDate == null)) patch.dueDate = ymdToUtcDate(dueYmd);
  if (schedYmd && (over || target.scheduledDate == null)) patch.scheduledDate = ymdToUtcDate(schedYmd);

  // Add the template's subtasks the target doesn't already have (by resolved
  // title, case-insensitive). Clone each missing child under the target, then
  // resolve its tokens. Existing subtasks are never removed.
  const protoChildren = await getDb()
    .select()
    .from(items)
    .where(and(eq(items.parentId, proto.id), eq(items.ownerId, ownerId), isNull(items.deletedAt)))
    .orderBy(asc(items.createdAt));
  const existing = await getDb()
    .select({ title: items.title })
    .from(items)
    .where(and(eq(items.parentId, targetId), eq(items.ownerId, ownerId), isNull(items.deletedAt)));
  const existingTitles = new Set(existing.map((c) => (c.title ?? "").trim().toLowerCase()));
  // Pairs of (prototype child, its fresh clone): `cloneItemSubtree` deliberately
  // clones children UNDATED, so the template's internal date shape is re-applied
  // below once the target's own dates are settled.
  const cloned: { protoChild: (typeof protoChildren)[number]; clonedId: string }[] = [];
  for (const child of protoChildren) {
    const childTitle = resolveVars(child.title ?? "", ctx).trim().toLowerCase();
    if (childTitle && existingTitles.has(childTitle)) continue;
    const { rootId: clonedId } = await cloneItemSubtree(ownerId, child.id, { parentId: targetId });
    await resolveTemplateVars(ownerId, clonedId, { answers: opts.answers, now, title: mergedTitle });
    cloned.push({ protoChild: child, clonedId });
  }

  // Apply the scalar/body/date patch. This also carries the target's EXISTING
  // subtasks along if it moves the scheduled date (ADR-253) — the clones added
  // just above are still undated at this point, so they are untouched by it.
  if (Object.keys(patch).length) await updateItem(ownerId, targetId, patch);

  // Re-date the clones by anchoring (ADR-253): each keeps the gap it had from the
  // PROTOTYPE's scheduled date, measured against the target's. So a template whose
  // checklist runs "day 0, day +2, day +5" lands on the target's dates in the same
  // shape. This replaces the ADR-085 offset re-derive, and reaches every clone
  // rather than only the ones carrying a stored offset.
  if (cloned.length) {
    const refreshed = await getItem(ownerId, targetId);
    const targetYmd = refreshed.scheduledDate ? dateToYmdUtc(refreshed.scheduledDate) : null;
    const delta = dayDelta(proto.scheduledDate, refreshed.scheduledDate) ?? 0;
    for (const { protoChild, clonedId } of cloned) {
      const childProps = protoChild.properties as Record<string, unknown> | null;
      // `relativeSchedule` survives ADR-253 as a TEMPLATE authoring device, and
      // only here: a prototype usually carries no concrete dates at all, so there
      // is no gap to measure and the stored offset is the only statement of "day
      // +1 of the checklist". Live subtask trees need none of this — they anchor
      // off the dates they already have.
      const offset = relativeOffsetOf(childProps);
      const scheduledDate =
        offset !== null && targetYmd
          ? ymdToUtcDate(applyOffset(targetYmd, offset))
          : shiftDay(protoChild.scheduledDate, delta);
      // The deadline keeps its gap from the child's own plan date; with no
      // prototype plan date to measure against it rides the root delta.
      const childDelta = dayDelta(protoChild.scheduledDate, scheduledDate) ?? delta;
      const dueDate = isDuePinned(childProps)
        ? protoChild.dueDate
        : shiftDay(protoChild.dueDate, childDelta);
      if (scheduledDate || dueDate) {
        await getDb()
          .update(items)
          .set({ scheduledDate, dueDate, updatedAt: new Date() })
          .where(and(eq(items.id, clonedId), eq(items.ownerId, ownerId)));
      }
      // Deeper levels: offsets resolve against this clone's new date, and any
      // absolutely-dated descendant rides the same delta.
      await deriveOffsetChildren(
        ownerId,
        clonedId,
        scheduledDate ? dateToYmdUtc(scheduledDate) : null
      );
      if (delta !== 0) await shiftChildDates(ownerId, clonedId, delta);
    }
  }

  // Add the template's outgoing relations (skip mentions + ones already present).
  const edges = await getDb()
    .select({ targetId: relations.targetId, role: relations.role })
    .from(relations)
    .where(eq(relations.sourceId, proto.id));
  for (const edge of edges) {
    if (edge.role === MENTION_ROLE || edge.targetId === targetId) continue;
    try {
      await relateItems(ownerId, targetId, edge.targetId, edge.role);
    } catch (err) {
      if (!(err instanceof ItemError)) throw err; // tolerate a vanished target
    }
  }

  return getItem(ownerId, targetId);
}

// Per-type template counts for the owner, e.g. { task: 2, meeting: 1 } — powers
// the "+ New" menu's decision to offer templates and the Build index badges.
// Counts only live-prototype templates.
export async function templateCountsByType(
  ownerId: string
): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ type: templates.type })
    .from(templates)
    .innerJoin(items, eq(items.id, templates.prototypeItemId))
    .where(and(eq(templates.ownerId, ownerId), isNull(items.deletedAt)));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return counts;
}
