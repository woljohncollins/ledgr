// Template tools (ADR-047): list an owner's item templates and apply one,
// either creating a fresh item from the prototype or merging onto an
// existing item of the same type.
import { asUuid } from "@/lib/api";
import {
  applyTemplateToExisting,
  createItemFromTemplate,
  createTemplate,
  createTemplateFromItem,
  listTemplates,
  updateTemplate,
  templateAskLabels,
} from "@/lib/templates";
import { optEnum, optString, optStringRecord, reqString } from "./args";
import { rowView } from "./serializers";
import type { McpTool } from "./wire";

export const templateTools: McpTool[] = [
  {
    name: "create_template",
    title: "Create a template",
    description:
      "Create an item template for a type (John, 2026-11-17: a new type needs its " +
      "template without a browser login). Either pass `fromItemId` to clone an existing " +
      "item (its title, body, properties, subtasks) into a hidden prototype, or omit it " +
      "to get an EMPTY prototype you then shape with update_item on the returned " +
      "prototypeItemId. A title/body may carry {{ask:Label}} prompts. `isDefault` makes " +
      "it the type's default template.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Type key the template is for (ignored with fromItemId)." },
        name: { type: "string", description: "Template name shown in the New chooser." },
        fromItemId: { type: "string", description: "Optional: an existing item id (UUID) to clone into the prototype." },
        isDefault: { type: "boolean", description: "Make this the type's default template." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const name = reqString(args, "name");
      const from = optString(args, "fromItemId");
      let t = from
        ? await createTemplateFromItem(ownerId, asUuid(from, "fromItemId"), name)
        : await createTemplate(ownerId, { type: reqString(args, "type"), name });
      if (args.isDefault === true) t = await updateTemplate(ownerId, t.id, { isDefault: true });
      return { id: t.id, type: t.type, name: t.name, isDefault: t.isDefault, prototypeItemId: t.prototypeItemId };
    },
  },
  {
    name: "list_templates",
    title: "List templates",
    description:
      "List the owner's item templates — reusable starting points for new items. " +
      "Each is backed by a hidden prototype item (its body, subtasks, properties, " +
      "and related items); apply_template deep-copies that prototype. `isDefault` " +
      "marks the type's default template. `askLabels` are the {{ask:Label}} fill-in " +
      "prompts the template asks on apply — pass values for them as apply_template's " +
      "`answers`. `applyConfig` (when present) describes the due/scheduled date rules " +
      "apply will set. Optionally filter by type.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional: only templates for this type key." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const defs = await listTemplates(ownerId, optString(args, "type"));
      const templates = await Promise.all(
        defs.map(async (t) => ({
          id: t.id,
          type: t.type,
          name: t.name,
          isDefault: t.isDefault,
          prototypeItemId: t.prototypeItemId,
          askLabels: await templateAskLabels(ownerId, t.id),
          ...(Object.keys(t.applyConfig).length ? { applyConfig: t.applyConfig } : {}),
        }))
      );
      return { templates };
    },
  },
  {
    name: "apply_template",
    title: "Apply template",
    description:
      "Apply a template. By default (no targetId) it CREATES a new item: a deep copy " +
      "of the template's prototype (its title, body, subtasks, properties, and " +
      "related items). Pass `targetId` to instead MERGE the template onto an existing " +
      "item of the same type — `mode` 'fill' (default) sets only the target's empty " +
      "fields and adds subtasks/relations it lacks (never overwriting your edits); " +
      "'overwrite' replaces scalars + body. Either way, {{today}}/{{title}} date " +
      "tokens resolve and `answers` (an object keyed by {{ask:Label}}) fills the " +
      "fill-in prompts; unanswered ones resolve to empty. Get the id (and its " +
      "askLabels) from list_templates.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The template id (UUID), from list_templates." },
        answers: {
          type: "object",
          description: "Values for the template's {{ask:Label}} prompts, keyed by label.",
        },
        targetId: {
          type: "string",
          description:
            "Optional: an existing item's id (UUID) to merge the template ONTO instead " +
            "of creating a new item. Must be the same type as the template.",
        },
        mode: {
          type: "string",
          enum: ["fill", "overwrite"],
          description:
            "With targetId: 'fill' (default) changes only the unchanged (empty fields + " +
            "missing subtasks/relations); 'overwrite' replaces scalars + body. Ignored " +
            "without targetId.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const answers = optStringRecord(args, "answers");
      const targetIdStr = optString(args, "targetId");
      if (targetIdStr) {
        const targetId = asUuid(targetIdStr, "targetId");
        const mode = optEnum(args, "mode", ["fill", "overwrite"] as const) ?? "fill";
        const item = await applyTemplateToExisting(ownerId, id, targetId, { mode, answers });
        return rowView(item);
      }
      const created = await createItemFromTemplate(ownerId, id, { answers });
      return rowView(created);
    },
  },
];
