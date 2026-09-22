// Relation tools (ADR-047): link/unlink two existing items. Thin wrappers over
// relations.ts, same owner-scoped edge logic the REST API uses.
import { asUuid } from "@/lib/api";
import { relateItems, unrelateItems } from "@/lib/relations";
import { autoLinkAllTasks } from "@/lib/project-autolink";
import { optString } from "./args";
import type { McpTool } from "./wire";

export const relationTools: McpTool[] = [
  {
    name: "autolink_project_tasks",
    title: "File tasks under projects by title",
    description:
      "Walk every open task that has no project and link it to the live project " +
      "whose name, name-without-year, short name before a dash, or comma-separated " +
      "`aliases` property appears in the task title (word-boundary; a short ALL-CAPS " +
      "alias like LDC/TI/YES must appear in caps). New and renamed tasks get this " +
      "automatically; call this to backfill after adding a project or an alias. " +
      "Returns what it linked.",
    inputSchema: {
      type: "object",
      properties: {
        includeDone: { type: "boolean", description: "Also scan completed tasks (default false)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => autoLinkAllTasks(ownerId, { includeDone: args.includeDone === true }),
  },
  {
    name: "relate_items",
    title: "Relate items",
    description:
      "Create a link (relation) between two existing items — e.g. tag a task " +
      "with a person, or relate a note to an event. Relating an already-" +
      "suggested pair confirms it (relating is the confirm gesture). The " +
      "optional role names a typed relation field (a type's 'author' or " +
      "'attendees' field, see list_types); omit it for a plain link.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The item the link is from (UUID)." },
        targetId: { type: "string", description: "The item the link is to (UUID)." },
        role: { type: "string", description: "Optional relation-field key (default 'related'). Can't be 'mention' (those are body-managed)." },
      },
      required: ["sourceId", "targetId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const sourceId = asUuid(args.sourceId, "sourceId");
      const targetId = asUuid(args.targetId, "targetId");
      const row = await relateItems(ownerId, sourceId, targetId, optString(args, "role"));
      return { related: true, sourceId, targetId, role: row.role, matchState: row.matchState };
    },
  },
  {
    name: "unrelate_items",
    title: "Unrelate items",
    description:
      "Remove the link(s) between two existing items — both items stay, nothing " +
      "is deleted. By default removes every non-mention edge between the pair in " +
      "both directions; pass role to remove only one typed field's edge, or " +
      "suggestedOnly=true to reject a provisional match while keeping confirmed " +
      "links.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "One item (UUID)." },
        otherId: { type: "string", description: "The other item (UUID)." },
        role: { type: "string", description: "Optional: remove only edges with this role." },
        suggestedOnly: { type: "boolean", description: "Only remove suggested (provisional) edges — the 'reject match' gesture." },
      },
      required: ["itemId", "otherId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const itemId = asUuid(args.itemId, "itemId");
      const otherId = asUuid(args.otherId, "otherId");
      const res = await unrelateItems(ownerId, itemId, otherId, {
        role: optString(args, "role"),
        suggestedOnly: args.suggestedOnly === true,
      });
      return { removed: res.removed };
    },
  },
];
