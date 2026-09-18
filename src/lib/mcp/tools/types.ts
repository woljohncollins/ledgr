// Type-catalog tools (ADR-047, ADR-102): list_types is the read every model
// should call before create_item/list_items; create_type/update_type are the
// workspace-shaping writes, thin wrappers over the same parseTypeInput the
// Build REST routes use so the model literally can't persist an illegal type.
import { ItemError } from "@/lib/items";
import {
  CATEGORY_DEFAULT_COLOR,
  CATEGORY_META,
  STATUS_CATEGORIES,
  STATUS_MODES,
  resolveStatusSchema,
  type StatusCategory,
  type StatusDef,
} from "@/lib/status";
import {
  createType,
  getType,
  listTypes,
  parseTypeInput,
  setTypeHidden,
  setTypeStatusConfig,
  updateType,
} from "@/lib/types";
import { surfacesForType } from "@/lib/modules";
import { optEnum, reqString } from "./args";
import { typeView } from "./serializers";
import type { McpTool } from "./wire";

// A status key from a label: "Waiting for Others" → "waiting_for_others". Keys
// are opaque (the label is what shows), so the model never has to invent one —
// but a caller may pass an explicit key to RENAME a label while keeping the key,
// which matters because items store the key.
function keyFromLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(slug) ? slug : `status_${slug || "1"}`;
}

export const typeTools: McpTool[] = [
  {
    name: "list_types",
    title: "List types",
    description:
      "List every item type in this Ledgr (the five system types — task, " +
      "event, note, link, person — plus any custom types) with each type's " +
      "custom properties (key, label, kind, select options, and a relation " +
      "field's target type + cardinality). Call this before create_item/" +
      "list_items when you need the exact type key or the property keys to set. " +
      "A hidden type (see update_type) is omitted unless you pass " +
      "includeHidden:true. " +
      "Each type also reports how it tracks completion — statusMode (none | " +
      "checkbox | select) and, for select, its STATUS TERMS in order with each " +
      "one's category, color, and which is the default. Those are the exact " +
      "status keys create_item/update_item accept; change them with " +
      "set_type_statuses. The type's `icon` and each term's `color` are the " +
      "owner's choices: read them here and resend them if you rewrite a type, " +
      "so an edit can't quietly flatten someone's palette. " +
      "A BESPOKE type also reports `capability` (the bespoke tool attached to it) " +
      "and `surfaces` — the named places content lives on that type. Most types " +
      "have one surface (the markdown body); a paper has Notes, Shape, Quote Bank, " +
      "Outline and Draft, and a song has Notes and Chart. Read `surfaces` before " +
      "writing to a bespoke type: each entry says what belongs there, which format " +
      "it holds, whether it is read-only, and which one is the `primary` finished " +
      "artifact that exports render from. Writing prose into a song's ChordPro " +
      "chart, or scratch notes into a paper's draft, is the mistake this prevents.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", description: "Include types hidden from everyday surfaces (default false)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_ownerId, args) => {
      const defs = await listTypes({ includeHidden: args.includeHidden === true });
      return {
        types: defs.map((t) => ({
          key: t.key,
          label: t.label,
          // The icon and the per-status colors are the owner's choices, and a
          // read that omits them makes a lossless round-trip impossible: an
          // update_type/set_type_statuses caller had nothing to resend, so it
          // silently reset them. Both writes preserve on omission now; returning
          // them here is the other half, so a model can also set them knowingly.
          icon: t.icon,
          isSystem: t.isSystem,
          hidden: t.hidden,
          showInQuickCapture: t.showInQuickCapture,
          // The attached bespoke tool, and the surfaces it brings (ADR-260).
          // describe_workspace already reported `capability`; list_types — the
          // read every model is told to call FIRST — did not, so a song and a
          // paper arrived looking like ordinary single-body types.
          ...(t.capability ? { capability: t.capability } : {}),
          surfaces: surfacesForType(t.key, undefined, t.capability).map((s) => ({
            id: s.id,
            label: s.label,
            storage: s.storage,
            format: s.format,
            description: s.description,
            ...(s.elements ? { elements: s.elements } : {}),
            ...(s.primary ? { primary: true } : {}),
            ...(s.readOnly ? { readOnly: true } : {}),
          })),
          statusMode: t.statusMode,
          // The effective terms, not the raw column: a type storing null
          // inherits the system default, and that's what its items actually use.
          ...(t.statusMode === "select"
            ? {
                statuses: resolveStatusSchema(t.statusSchema).map((s) => ({
                  key: s.key,
                  label: s.label,
                  category: s.category,
                  color: s.color,
                  ...(s.isDefault ? { isDefault: true } : {}),
                })),
                statusesAreCustom: t.statusSchema != null,
              }
            : {}),
          properties: t.propertySchema.map((p) => ({
            key: p.key,
            label: p.label,
            kind: p.kind,
            ...(p.options ? { options: p.options } : {}),
            // Relation fields (kind "relation") carry their target type + how
            // many they accept, so the model knows what create_item /
            // relate_items should link (ADR-067).
            ...(p.targetType != null ? { targetType: p.targetType } : {}),
            ...(p.cardinality ? { cardinality: p.cardinality } : {}),
            // Date fields: a range end lives at `<key>__end`; a timed field
            // stores a full ISO instant instead of a day (ADR-166 / ADR-254).
            ...(p.withEnd ? { withEnd: true } : {}),
            ...(p.withTime ? { withTime: true } : {}),
          })),
        })),
      };
    },
  },
  {
    name: "create_type",
    title: "Create type",
    description:
      "Create a new item type (a kind of item with its own custom properties) — " +
      "the 'make me a place to track X' move. `key` is a lowercase slug, " +
      "immutable once created; `label` is the display name. `propertySchema` is " +
      "the type's fields: each { key, label, kind } where kind is text | number | " +
      "date | checkbox | url | image (a picture: stores an http(s) URL or a " +
      "/files/<id> address; fill it with update_item propertyPatch or attach_file " +
      "propertyKey) | select | multi_select (these need an `options` " +
      "string array) | relation (a typed link — set `targetType` to the type key " +
      "it links to, or omit for any, plus `cardinality` single|many). A `date` " +
      "field may set `withTime: true` (stores a full ISO instant, not a day) " +
      "and/or `withEnd: true` (its end lives at `<key>__end`). Example: a " +
      "'sermon' type with a `series` select, a `date`, and a `passage` relation. " +
      "Call describe_workspace/list_types first to avoid duplicating an existing " +
      "type, and confirm the shape with the owner before creating.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Lowercase slug, immutable (letters, digits, _; starts with a letter). E.g. 'sermon'." },
        label: { type: "string", description: "Display name. E.g. 'Sermon'." },
        icon: { type: "string", description: "Optional icon key." },
        propertySchema: {
          type: "array",
          description: "The type's custom fields (see the description for the per-field shape). Omit for none.",
          items: { type: "object" },
        },
        showInQuickCapture: { type: "boolean", description: "Show this type in the quick-capture picker (default true)." },
        capability: { type: "string", description: "Optional bespoke-tool capability id (advanced; omit for the default markdown canvas)." },
      },
      required: ["key", "label"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (_ownerId, args) => {
      const created = await createType(parseTypeInput(args, "create"));
      return typeView(created);
    },
  },
  {
    name: "update_type",
    title: "Update type",
    description:
      "Edit an existing type by key. This PATCHES: a field you omit keeps its " +
      "stored value, so adding one property or renaming the label can't wipe the " +
      "icon, the capability, or the rest of the schema. `propertySchema` is still " +
      "the one field that replaces wholesale WHEN YOU SEND IT (it's a list, not a " +
      "set of keys), so to add a property read the current one (list_types) and " +
      "resend it with your addition appended. Pass icon:\"\" to deliberately clear " +
      "the icon. The key is immutable and can't change here. System types (task, " +
      "event, note, link, person) can be edited but not deleted. Confirm with the " +
      "owner before changing a type that's in use.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The type's key (slug) to edit." },
        label: { type: "string", description: "Display name. Omit to keep the current one." },
        icon: { type: "string", description: "Icon key. Omit to keep the current one; pass \"\" to clear it." },
        propertySchema: {
          type: "array",
          description: "The FULL property list to store (replaces the existing one) — omit it entirely to leave the schema untouched. See create_type for the per-field shape.",
          items: { type: "object" },
        },
        showInQuickCapture: { type: "boolean", description: "Show in the quick-capture picker." },
        capability: { type: "string", description: "Bespoke-tool capability id, or omit/empty for the default canvas." },
        hidden: {
          type: "boolean",
          description:
            "Hide the type from everyday surfaces (quick capture, +New menus, list " +
            "tabs, nav destination options). The type and its items are untouched. " +
            "Same switch as the Hide column on Build → Types.",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (_ownerId, args) => {
      const key = reqString(args, "key").toLowerCase();
      // PATCH, not replace. parseTypeInput's "patch" mode is shaped for the Build
      // form, which always posts every field, so an omitted key reads as "clear
      // it" — over MCP that silently destroyed the owner's icon on any edit that
      // only meant to add a property (2026-09-14, Tyler's project type). The form
      // contract is left alone; the merge happens here, at the model's boundary,
      // by filling omitted fields from the stored type before parsing.
      const current = await getType(key);
      const merged: Record<string, unknown> = {
        ...args,
        label: "label" in args ? args.label : current.label,
        icon: "icon" in args ? args.icon : current.icon,
        propertySchema:
          "propertySchema" in args ? args.propertySchema : current.propertySchema,
        showInQuickCapture:
          "showInQuickCapture" in args
            ? args.showInQuickCapture
            : current.showInQuickCapture,
        capability: "capability" in args ? args.capability : current.capability,
      };
      let updated = await updateType(key, parseTypeInput(merged, "patch"));
      // hidden isn't a parseTypeInput field (setTypeHidden is its own column
      // write, same as the Build → Types "Hide" toggle), so it's applied after
      // the PATCH and the type re-read so the returned view reflects it.
      if ("hidden" in args && typeof args.hidden === "boolean") {
        await setTypeHidden(key, args.hidden);
        updated = await getType(key);
      }
      return typeView(updated);
    },
  },
  {
    name: "set_type_statuses",
    title: "Set a type's status terms",
    description:
      "Define the STATUS TERMS for a type — what the stages are called and what " +
      "they mean (\"projects should be Ongoing, Waiting for Others, Paused, " +
      "Future, Done\"). Pass statuses as a list, in the order you want them, " +
      "each with a label and a category. Category is the part that carries " +
      "meaning, and there are exactly four: not_started, in_progress, done, " +
      "archived. The label is yours to name; the category is how the rest of " +
      "Ledgr reasons about it (what counts as finished for progress bars and " +
      "roll-ups, what the done checkbox completes to, what a recurring task " +
      "advances on). You need at least one done and one active " +
      "(not_started/in_progress) term.\n\n" +
      "Keys are derived from labels automatically, so you can just send labels. " +
      "RENAMING: items store the key, so to rename a term without re-bucketing " +
      "its items, resend it with its existing key (from list_types) and the new " +
      "label. Dropping a term leaves any item still on it in its category's " +
      "default. Set mode instead of statuses to change HOW completion shows: " +
      "'checkbox' (a plain done box), 'none' (no status at all), or 'select' " +
      "(these named stages, shown as a dropdown and kanban columns). Switching " +
      "away from select KEEPS your terms, so switching back restores them.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The type's key, e.g. 'project' (see list_types)." },
        mode: {
          type: "string",
          enum: [...STATUS_MODES],
          description:
            "How this type shows completion: select (named stages) | checkbox " +
            "(done / not done) | none. Defaults to select when you pass statuses.",
        },
        statuses: {
          type: "array",
          description:
            "The full ordered list of terms (replaces the existing set). Each: " +
            "{ label, category, key?, color?, isDefault? }. category is one of " +
            "not_started | in_progress | done | archived.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "What it's called, e.g. 'Waiting for Others'." },
              category: { type: "string", enum: [...STATUS_CATEGORIES], description: "not_started | in_progress | done | archived." },
              key: { type: "string", description: "Optional existing key — pass it to RENAME a term without moving its items." },
              color: { type: "string", description: "Optional hex color, e.g. '#f59e0b'. Defaults to the category's color." },
              isDefault: { type: "boolean", description: "The default term within its category (one per category)." },
            },
            required: ["label", "category"],
            additionalProperties: false,
          },
        },
        inherit: { type: "boolean", description: "true = drop custom terms and inherit the system default (To Do / Done / Archived)." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (_ownerId, args) => {
      const key = reqString(args, "key").toLowerCase();
      const mode = optEnum(args, "mode", STATUS_MODES);

      // inherit: back to the system default, staying in select mode.
      if (args.inherit === true) {
        const updated = await setTypeStatusConfig(key, mode ?? "select", null);
        return {
          ...typeView(updated),
          statusMode: updated.statusMode,
          statuses: resolveStatusSchema(updated.statusSchema).map((s) => ({
            key: s.key,
            label: s.label,
            category: s.category,
          })),
          inherited: true,
        };
      }

      const raw = args.statuses;
      if (raw === undefined || raw === null) {
        // Mode-only change (e.g. "make projects a simple checkbox"). Passing no
        // schema preserves the stored terms — the defer-by-hiding rule.
        if (!mode) {
          throw new ItemError(
            "bad_request",
            "pass statuses (the terms), mode (how completion shows), or inherit:true"
          );
        }
        // A mode-only change must not disturb the stored terms. That takes care:
        // setTypeStatusConfig treats a null schema in SELECT mode as the explicit
        // "inherit the default" choice (it's what the Build panel's "Inherit
        // default" radio sends), so passing null here would silently wipe the
        // owner's terms on the way back from checkbox. Resend what's stored;
        // `inherit: true` is the deliberate way to clear.
        const current = await getType(key);
        const updated = await setTypeStatusConfig(key, mode, current.statusSchema);
        return {
          ...typeView(updated),
          statusMode: updated.statusMode,
          ...(updated.statusMode === "select"
            ? {
                statuses: resolveStatusSchema(updated.statusSchema).map((s) => ({
                  key: s.key,
                  label: s.label,
                  category: s.category,
                })),
              }
            : {}),
          note:
            mode === "select"
              ? "back to named stages, with your stored terms intact"
              : "your custom terms are kept, so switching back to select restores them",
        };
      }

      if (!Array.isArray(raw)) throw new ItemError("bad_request", "statuses must be an array");
      // A term's color is the owner's choice, and list_types didn't return colors
      // until now, so a read-then-resend round-trip had no way to carry one: every
      // term came back colorless and got flattened to its category default, which
      // is how Tyler's project board lost its palette on 2026-09-14. Keep the
      // stored color for any key the caller isn't explicitly recoloring; only a
      // genuinely new term falls back to the category color.
      const storedColors = new Map(
        resolveStatusSchema((await getType(key)).statusSchema).map((s) => [s.key, s.color])
      );
      const seen = new Set<string>();
      const statuses: StatusDef[] = raw.map((entry, i) => {
        const at = `statuses[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new ItemError("bad_request", `${at} must be an object`);
        }
        const e = entry as Record<string, unknown>;
        const label = typeof e.label === "string" ? e.label.trim() : "";
        if (!label) throw new ItemError("bad_request", `${at}.label is required`);
        const category = typeof e.category === "string" ? e.category.trim().toLowerCase() : "";
        if (!(STATUS_CATEGORIES as readonly string[]).includes(category)) {
          throw new ItemError(
            "bad_request",
            `${at}.category must be one of: ${STATUS_CATEGORIES.join(", ")} ` +
              `(${STATUS_CATEGORIES.map((c) => `${c} = ${CATEGORY_META[c].label}`).join("; ")})`
          );
        }
        const cat = category as StatusCategory;
        let k = typeof e.key === "string" && e.key.trim() ? e.key.trim().toLowerCase() : keyFromLabel(label);
        // Two labels sluggifying the same way would collide; disambiguate rather
        // than fail, since the key is opaque and the label is what shows.
        if (seen.has(k)) {
          let n = 2;
          while (seen.has(`${k}_${n}`)) n += 1;
          k = `${k}_${n}`;
        }
        seen.add(k);
        const color =
          typeof e.color === "string" && /^#[0-9a-fA-F]{6}$/.test(e.color.trim())
            ? e.color.trim()
            : (storedColors.get(k) ?? CATEGORY_DEFAULT_COLOR[cat]);
        return {
          key: k,
          label,
          category: cat,
          color,
          ...(e.isDefault === true ? { isDefault: true as const } : {}),
        };
      });

      // Statuses only mean anything in select mode, so passing terms implies it.
      const updated = await setTypeStatusConfig(key, mode ?? "select", statuses);
      return {
        ...typeView(updated),
        statusMode: updated.statusMode,
        statuses: (updated.statusSchema ?? statuses).map((s) => ({
          key: s.key,
          label: s.label,
          category: s.category,
          ...(s.isDefault ? { isDefault: true } : {}),
        })),
      };
    },
  },
];
