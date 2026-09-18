// Item search/list/CRUD tools (ADR-047): thin wrappers over the same
// owner-scoped libs the REST API uses (search.ts, views.ts, items.ts,
// relations.ts), so the MCP surface can never drift from the app's own
// contract or skip owner scoping. create/update reuse parseItemPayload, so
// MCP writes validate exactly like /api/items writes.
import { asUuid, parseItemPayload } from "@/lib/api";
import { BODY_WINDOW_CHARS, bodyMarkdown, isLargeBody, makeMarkdownBody, windowBody } from "@/lib/body";
import { resolveSurfaceTarget, resolveSurfaces } from "@/lib/item-surfaces";
import {
  ensureAnchorOnLine,
  findLineByText,
  lineWithBlockId,
  stripAnchorFromLine,
} from "@/lib/editor/block-anchor";
import { ItemError, URGENCIES, getItem, getItemType } from "@/lib/items";
import { createItem, moveItemType, updateItem } from "@/lib/item-mutations";
import { MEMORY_TYPE, memoryAge, memoryFacets, memoryMarker, supersededByFor } from "@/lib/memory";
import { resolveItemBodyTokens } from "@/lib/item-tokens-service";
import { listRelatedItems, relateItems } from "@/lib/relations";
import { searchItems } from "@/lib/search";
import { listTypes } from "@/lib/types";
import {
  DATE_PROPERTIES,
  DUE_WINDOWS,
  SORT_FIELDS,
  queryViewItems,
  type DateProperty,
  type DueWindow,
  type SortField,
  type ViewFilter,
  type ViewSort,
} from "@/lib/views";
import { buildWriteRaw, optEnum, optInt, optString, optUuidArray, reqString } from "./args";
import { rowView } from "./serializers";
import { recurrenceView } from "./tasks";
import type { McpTool } from "./wire";

export const itemTools: McpTool[] = [
  {
    name: "search_items",
    title: "Search items",
    description:
      "Full-text search across the owner's items (titles and bodies). Use this " +
      "to find an item or a person by words — e.g. find the 'Roger' person, " +
      "or notes mentioning a topic. Returns matching items with a " +
      "highlighted snippet. To then list everything related to a person, pass " +
      "its id as relatedTo to list_items. For AI-memory recall, pass " +
      "type: \"memory\": when you meet an unfamiliar person, project, or system, " +
      "search for it by name before assuming you know nothing about it. Without " +
      "the type filter, memories are buried under notes, transcripts, and " +
      "commentaries. Memory hits render their age, so you can tell a current " +
      "claim from one that was true a year ago.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search words (supports \"quoted phrases\", OR, -exclude)." },
        type: { type: "string", description: "Optional: restrict to one type key (e.g. task, event, note, person)." },
        limit: { type: "integer", description: "Max results (1–50, default 50).", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const found = await searchItems(ownerId, reqString(args, "query"), {
        type: optString(args, "type"),
        limit: optInt(args, "limit"),
      });
      // A retired (archived) memory stays in the store for the record but is
      // no longer a claim to recall, so it drops out of memory search (ADR-259).
      // Other types keep their archived rows: "find that archived note" is real.
      const rows = found.filter((r) => !(r.type === MEMORY_TYPE && r.statusCategory === "archived"));
      // Memory hits carry their age (ADR-230) plus the same STALE / SUPERSEDED
      // marker the stump index renders (ADR-259): Tier 2 memories are reached
      // by search, so the hedge has to appear here or it never appears.
      const memoryIds = rows.filter((r) => r.type === MEMORY_TYPE).map((r) => r.id);
      const superseded = await supersededByFor(ownerId, memoryIds);
      return {
        count: rows.length,
        items: rows.map((r) => ({
          ...rowView(r),
          ...(r.type === MEMORY_TYPE
            ? {
                age:
                  memoryAge(r.updatedAt) +
                  memoryMarker(
                    memoryFacets(r.properties).horizon,
                    r.updatedAt,
                    superseded.get(r.id) ?? null
                  ),
              }
            : {}),
          snippet: r.snippet,
        })),
      };
    },
  },
  {
    name: "list_items",
    title: "List items",
    description:
      "List the owner's items with structured filters — by type, status, " +
      "due-date window, or related item. This is the 'list by person/date' " +
      "tool: e.g. open tasks related to a person (type=task, status=open, " +
      "relatedTo=<person>), or events in the next 7 days (type=event, " +
      "dateField=meetingAt, withinDays=7). Bodies are not included; open an item " +
      "with get_item for its body.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Type key (e.g. task, event, note, link, person, or a custom type)." },
        status: { type: "string", description: "Item status filter — a status KEY for the type. The inherited default keys are open | done | archived; a type with named stages has its own (see list_types), e.g. status='active' for goals. Filtering by a status the type doesn't have simply matches nothing." },
        relatedTo: { type: "string", description: "Only items with a confirmed relation to this item id (either direction)." },
        due: { type: "string", enum: [...DUE_WINDOWS], description: "Date window: overdue | today | week | none (no date)." },
        withinDays: { type: "integer", description: "Items dated today through N days out (1–366). Wins over `due`.", minimum: 1, maximum: 366 },
        dateField: { type: "string", enum: [...DATE_PROPERTIES], description: "Which date `due`/`withinDays` apply to (default `plan` = scheduled date if set, else due; use meetingAt for events)." },
        sort: { type: "string", enum: [...SORT_FIELDS], description: "Sort field (default updatedAt)." },
        sortDir: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default desc)." },
        limit: { type: "integer", description: "Max results (1–200, default 50).", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const filter: ViewFilter = {};
      const type = optString(args, "type");
      if (type) filter.type = type;
      // Not enum-gated against ITEM_STATUSES (ADR-243): that list is only the
      // INHERITED default set, so pinning it here made every custom stage
      // ("active", "waiting") unfilterable.
      const status = optString(args, "status");
      if (status) filter.status = status.toLowerCase();
      const relatedTo = args.relatedTo != null ? asUuid(args.relatedTo, "relatedTo") : undefined;
      if (relatedTo) filter.relatedTo = relatedTo;
      const dateField = optEnum<DateProperty>(args, "dateField", DATE_PROPERTIES);
      if (dateField) filter.dateField = dateField;
      const due = optEnum<DueWindow>(args, "due", DUE_WINDOWS);
      if (due) filter.due = due;
      const withinDays = optInt(args, "withinDays");
      if (withinDays !== undefined) {
        if (withinDays < 1 || withinDays > 366) {
          throw new ItemError("bad_request", "withinDays must be 1–366");
        }
        filter.withinDays = withinDays;
      }
      const sortField = optEnum<SortField>(args, "sort", SORT_FIELDS) ?? "updatedAt";
      const sortDir = optEnum(args, "sortDir", ["asc", "desc"] as const) ?? "desc";
      const sort: ViewSort = { field: sortField, dir: sortDir };
      const rows = await queryViewItems(ownerId, filter, sort, optInt(args, "limit"));
      return { count: rows.length, items: rows.map(rowView) };
    },
  },
  {
    name: "get_item",
    title: "Get item",
    description:
      "Read one item in full by id: its fields, its markdown body, and its " +
      "related items (the relations graph — backlinks, mentions, tagged " +
      "people, with each edge's role and whether it's confirmed or only " +
      "suggested). Use after search_items/list_items to read an item's contents. " +
      "Normal-size bodies come back whole. A very large body (an imported PDF/" +
      "ebook) is PAGED so it can't flood the context: the read returns the first " +
      `~${BODY_WINDOW_CHARS} characters with a truncation marker, plus a bodyInfo ` +
      "object {totalChars, offset, returnedChars, truncated, nextOffset}. To read " +
      "more, call get_item again with bodyOffset set to the previous nextOffset. " +
      "A BESPOKE type (paper, song, or a type carrying one of their bespoke tools) " +
      "also returns `surfaces`: the named places its content lives, each with what " +
      "belongs there and what is currently stored. A paper returns Notes, Shape, " +
      "Quote Bank, Outline and Draft; a song returns Notes and Chart. The surface " +
      "whose storage is the body reports no `content` of its own — that is the " +
      "top-level `body` field above it (which is also the one that pages) — and is " +
      "flagged `isBody: true`. Read `surfaces` before writing: it is what tells you " +
      "that a paper's notes are NOT its draft, and that a song's body is ChordPro.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The item id (UUID)." },
        bodyOffset: {
          type: "integer",
          description:
            "Start reading the body at this character offset (default 0). Pass the " +
            "nextOffset from a previous truncated read to page through a long body.",
          minimum: 0,
        },
        bodyLimit: {
          type: "integer",
          description:
            `Max characters of body to return this read (1–${BODY_WINDOW_CHARS}, ` +
            `default ${BODY_WINDOW_CHARS}). Smaller windows page a huge body in more, ` +
            "lighter reads; a body under the limit always returns whole.",
          minimum: 1,
          maximum: BODY_WINDOW_CHARS,
        },
        resolveTokens: {
          type: "boolean",
          description:
            "When true, resolve live {{item.*}} tokens in the title + body against " +
            "the item's current state (its dates, properties, related items) — the " +
            "same values a print/export shows. Default false returns the raw tokens.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const bodyOffset = optInt(args, "bodyOffset");
      const bodyLimit = optInt(args, "bodyLimit");
      const item = await getItem(ownerId, id);
      // LT3: optionally resolve live tokens so a client sees the rendered values.
      if (args.resolveTokens === true) {
        const resolved = await resolveItemBodyTokens(ownerId, {
          id: item.id,
          title: item.title,
          body: item.body,
        });
        item.title = resolved.title;
        item.body = resolved.body;
      }
      const related = await listRelatedItems(ownerId, id);
      const relatedView = related.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        status: r.status,
        dueDate: r.dueDate,
        roles: r.roles,
        matchState: r.matchState,
      }));

      // The type's named surfaces with their stored content (ADR-260). One
      // request-cached type lookup, no per-surface fan-out. The body-storage
      // surface deliberately carries no content: it would duplicate `body`
      // verbatim (doubling a long paper's cost) and would sidestep the paging
      // above, so it is reported as `isBody` and points back at that field.
      const surfaces = (await resolveSurfaces(item)).map((sf) => {
        const isBody = sf.storage.kind === "body";
        return {
          id: sf.id,
          label: sf.label,
          storage: sf.storage,
          format: sf.format,
          description: sf.description,
          ...(sf.elements ? { elements: sf.elements } : {}),
          empty: sf.empty,
          ...(sf.primary ? { primary: true } : {}),
          ...(sf.readOnly ? { readOnly: true } : {}),
          ...(isBody ? { isBody: true } : { content: sf.content }),
        };
      });
      // Only worth reporting when the type actually has more than the plain body,
      // so an ordinary note/task response is byte-for-byte what it always was.
      const surfaceView =
        surfaces.length > 1 || surfaces.some((sf) => !("isBody" in sf))
          ? { surfaces }
          : {};

      const fullText = bodyMarkdown(item.body);
      const paging = bodyOffset !== undefined || bodyLimit !== undefined;
      // A normal-size body (and no explicit paging) returns whole and byte-for-
      // byte unchanged — the body contract is untouched. Only a large body, or a
      // caller that explicitly pages, takes the windowed path below.
      const recurrence = recurrenceView(item.properties);
      if (!isLargeBody(fullText) && !paging) {
        return { ...rowView(item), body: fullText, ...recurrence, ...surfaceView, related: relatedView };
      }

      const win = windowBody(fullText, { offset: bodyOffset, limit: bodyLimit });
      let body = win.text;
      if (win.truncated) {
        body +=
          `\n\n…[truncated: ${win.returnedChars} of ${win.totalChars} chars shown ` +
          `(offset ${win.offset}–${win.nextOffset}). Call get_item again with ` +
          `bodyOffset=${win.nextOffset} to read the next window.]`;
      }
      return {
        ...rowView(item),
        body,
        ...recurrence,
        ...surfaceView,
        bodyInfo: {
          totalChars: win.totalChars,
          offset: win.offset,
          returnedChars: win.returnedChars,
          truncated: win.truncated,
          nextOffset: win.nextOffset,
        },
        related: relatedView,
      };
    },
  },
  {
    name: "link_to_line",
    title: "Get a deep link to a line",
    description:
      "Get a shareable deep link to one specific line of an item's markdown body " +
      "— a URL that opens the item and scrolls to that line. Point at the line " +
      "one of three ways: line (a 1-based line number in the body get_item " +
      "returned), lineText (a snippet of the line's text — most natural; matches " +
      "the anchor-stripped line, errors if it's ambiguous), or blockRef (an " +
      "existing ^anchor id you already saw in the body — a pure read, no change). " +
      "If the line has no anchor yet, one stable ^id marker is appended to that " +
      "line and saved (mirrors the app's own 'copy link to this line'); a line " +
      "that's already anchored reuses its id, so repeat calls return the same " +
      "link. Drop the returned url into a chat, a note, or another doc. Blank " +
      "lines and lines inside fenced code blocks can't be linked.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The item id (UUID)." },
        line: {
          type: "integer",
          description:
            "1-based line number in the item's markdown body (as get_item returns it).",
          minimum: 1,
        },
        lineText: {
          type: "string",
          description:
            "A snippet of the target line's text. Matched against the line with " +
            "its ^anchor removed; must resolve to exactly one line or it errors " +
            "(pass line to disambiguate).",
        },
        blockRef: {
          type: "string",
          description:
            "An existing anchor id (the part after ^ in a line you saw via " +
            "get_item). Builds the link for that line without changing the body.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const item = await getItem(ownerId, id);
      const markdown = bodyMarkdown(item.body);

      // Resolve which line to point at. Precedence: an anchor id you already
      // have (pure read) → a 1-based line number → a text snippet.
      const blockRef = optString(args, "blockRef");
      const line = optInt(args, "line");
      const lineText = optString(args, "lineText");

      let index: number;
      if (blockRef !== undefined) {
        const at = lineWithBlockId(markdown, blockRef);
        if (at < 0) {
          throw new ItemError("not_found", `no line in this item carries the anchor ^${blockRef}`);
        }
        index = at;
      } else if (line !== undefined) {
        index = line - 1;
      } else if (lineText !== undefined) {
        const found = findLineByText(markdown, lineText);
        if ("notFound" in found) {
          throw new ItemError(
            "not_found",
            `no line matches "${lineText}" — pass line (a 1-based line number) instead`
          );
        }
        if ("ambiguous" in found) {
          const nums = found.ambiguous.map((i) => i + 1).join(", ");
          throw new ItemError(
            "bad_request",
            `"${lineText}" matches ${found.ambiguous.length} lines (${nums}) — pass line to pick one`
          );
        }
        index = found.index;
      } else {
        throw new ItemError(
          "bad_request",
          "pass one of: line (1-based number), lineText (a snippet), or blockRef (an existing ^anchor id)"
        );
      }

      const result = ensureAnchorOnLine(markdown, index);
      if ("error" in result) {
        throw new ItemError("bad_request", `can't link to that line: ${result.error}`);
      }
      if (result.created) {
        await updateItem(ownerId, id, { body: makeMarkdownBody(result.markdown) });
      }

      const origin = (process.env.NEXT_PUBLIC_APP_URL || "https://ledgr-teal.vercel.app").replace(/\/+$/, "");
      const resolvedLine = stripAnchorFromLine(result.markdown.split("\n")[index]).trim();
      return {
        url: `${origin}/items/${id}#^${result.id}`,
        blockRef: result.id,
        line: index + 1,
        lineText: resolvedLine,
        created: result.created,
      };
    },
  },
  {
    name: "create_item",
    title: "Create item",
    description:
      "Create a new item of a given type. Common uses: 'file this as a task due " +
      "Friday' (type=task, title, dueDate), or capture a note. Body is markdown " +
      "(bodyMarkdown). Use relateTo to link the new item to existing items by id " +
      "(e.g. relate a task to a person). Items default to filed (not in " +
      "the inbox) unless the owner routed Claude's captures elsewhere in their " +
      "Capture settings; set inbox=true to capture for later triage. Call list_types " +
      "first if unsure which type or custom properties exist. Pass parentId to " +
      "file it as a SUBTASK under another item. For a task that REPEATS, create " +
      "it first, then call set_recurrence on the new id.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Type key (task, event, note, link, person, or a custom type — see list_types)." },
        title: { type: "string", description: "Item title." },
        bodyMarkdown: { type: "string", description: "Body as markdown (also accepted as `body`). To link inline to another item so it renders as Ledgr's native @-mention chip and auto-creates a relation, write [@Title](ledgr://item/<id>) (look up the id via search_items/list_items first)." },
        status: { type: "string", description: "Starting status. Accepts the status KEY or its LABEL from list_types (e.g. 'active' or 'Active' for a goal). Omit to get the type's default starting stage — which for a type with named stages is often NOT the one you want, so pass this explicitly when the stage matters. A name the type doesn't have is rejected with the list of its real ones." },
        dueDate: { type: "string", description: "Due date (the deadline), ISO 8601 (e.g. 2026-06-19). Tasks only, conventionally." },
        scheduledDate: { type: "string", description: "Planned date — the day you intend to WORK on it, as opposed to dueDate (the deadline). ISO 8601. This is what Today/Planner and a recurring series read." },
        parentId: {
          type: "string",
          description:
            "File this item as a SUBTASK (child) of that item id. Any type can " +
            "nest under any other; a task under a task is the checklist case. " +
            "The parent's 'n of m done' rollup counts task-type children. To " +
            "add several children at once use add_subtasks instead.",
        },
        meetingAt: { type: "string", description: "Event start time, ISO 8601 date-time. Events only." },
        urgency: { type: "number", enum: [...URGENCIES], description: "Priority 1–6 (tasks; 1 highest)." },
        url: { type: "string", description: "URL (links)." },
        properties: { type: "object", description: "Custom property values keyed by the type's property keys (see list_types)." },
        inbox: { type: "boolean", description: "true = capture into the inbox for later triage; default false (filed). Beats `source` whenever both are sent." },
        source: { type: "string", description: "Which arrival path this came from, when it isn't you: one of quick_capture, share_target, web_clipper, email_in, todoist, mention_create, ai_mcp. The owner's Capture settings say where each one files. Omit it and `inbox` both, and this lands wherever they route ai_mcp (filed, by default)." },
        relateTo: { type: "array", items: { type: "string" }, description: "Item ids to relate this new item to (confirmed edges)." },
      },
      required: ["type"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const raw = buildWriteRaw(args, ["type", "source"], ["relateTo"]);
      // Name the arrival path when the caller named neither (ADR-249), so the
      // owner can route what Claude files. Purely additive: a caller that sends
      // `inbox` still wins outright, and ai_mcp defaults to filed, which is what
      // an omitted `inbox` has always meant here.
      if (raw.inbox === undefined && raw.source === undefined) raw.source = "ai_mcp";
      const input = parseItemPayload(raw, "create");
      const created = await createItem(ownerId, input);
      const relateTo = optUuidArray(args, "relateTo");
      for (const targetId of relateTo) {
        await relateItems(ownerId, created.id, targetId);
      }
      return { ...rowView(created), relatedTo: relateTo };
    },
  },
  {
    name: "update_item",
    title: "Update item",
    description:
      "Update fields on an existing item by id: title, status (e.g. mark a task " +
      "done), due date, urgency, body (bodyMarkdown replaces the whole body), " +
      "custom properties, etc. Only the fields you pass change. To change an " +
      "item's relations use the relations on create_item, not this tool. Marking " +
      "a RECURRING task done here is the right way to complete its current " +
      "occurrence: the series advances to the next date instead of closing. To " +
      "change the repeat rule itself, use set_recurrence, not properties. " +
      "On a BESPOKE type, write to a named SURFACE instead of guessing: pass " +
      "`surface` (an id from list_types/get_item, e.g. \"notes\") with `content`, " +
      "and it lands wherever that surface actually lives. This is how you add " +
      "notes to a paper without touching its draft, or to a song without " +
      "corrupting its ChordPro chart. Read-only surfaces (a paper's Shape, Quote " +
      "Bank and Outline) are refused with the list of writable ids.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The item id (UUID)." },
        title: { type: "string", description: "New title." },
        bodyMarkdown: { type: "string", description: "New body markdown, replacing the entire body (also accepted as `body`). To link inline to another item so it renders as Ledgr's native @-mention chip and auto-creates a relation, write [@Title](ledgr://item/<id>) (look up the id via search_items/list_items first)." },
        status: { type: "string", description: "New status. Accepts the status KEY or its LABEL from list_types (e.g. 'waiting' or 'Waiting for Others' on a project). This is how you set a CUSTOM stage; it is not limited to open/done/archived. A name the type doesn't have is rejected with the list of its real ones." },
        dueDate: { type: "string", description: "New due date / deadline (ISO 8601), or null to clear." },
        scheduledDate: { type: "string", description: "New planned date — the day you intend to work on it (ISO 8601), or null to clear. On a recurring task this is the next occurrence, so prefer letting status=done advance it." },
        parentId: {
          type: "string",
          description:
            "Re-parent this item: the id of the item it should become a SUBTASK " +
            "of, or null to lift it back to the top level. Its own children " +
            "travel with it. A cycle (making an item its own descendant) is " +
            "rejected.",
        },
        meetingAt: { type: "string", description: "New meeting time (ISO 8601), or null to clear." },
        urgency: { type: "number", enum: [...URGENCIES], description: "New priority 1–6, or null to clear." },
        url: { type: "string", description: "New URL, or null to clear." },
        properties: { type: "object", description: "Replace the whole custom-properties object. Prefer propertyPatch to change one key without clobbering the rest." },
        propertyPatch: { type: "object", description: "Merge these custom-property keys into the existing properties (atomic per-key; other keys untouched). Set a key to null to clear it. An image-kind property takes an image URL string, or null to remove it." },
        inbox: { type: "boolean", description: "Move into (true) or out of (false) the inbox." },
        surface: { type: "string", description: "Write to this named surface instead of a specific field — an id from the type's `surfaces` (list_types / get_item), e.g. \"notes\", \"draft\", \"chart\". Requires `content`. Routes to the body or the backing property automatically, so a caller never has to know which. Read-only surfaces are refused." },
        content: { type: "string", description: "The content to write to `surface`, replacing what it holds. Use the surface's own `format`: markdown for a paper's Notes or Draft, ChordPro for a song's Chart." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      // A surface-targeted write (ADR-260) is translated into the ordinary patch
      // fields BEFORE parsing, so it goes down exactly the same validation,
      // revision-snapshot and body_text path as a direct write. `content` alone
      // is meaningless, and `surface` alone is a no-op, so both are required
      // together and rejected clearly rather than silently ignored.
      const surfaceId = optString(args, "surface");
      const surfaceContent = optString(args, "content");
      if ((surfaceId === undefined) !== (surfaceContent === undefined)) {
        throw new ItemError(
          "bad_request",
          "`surface` and `content` go together: pass both to write a named surface, or neither"
        );
      }
      if (surfaceId !== undefined && surfaceContent !== undefined) {
        const { type } = await getItemType(ownerId, id);
        const defs = await listTypes({ includeHidden: true });
        const capability = defs.find((t) => t.key === type)?.capability ?? null;
        const target = resolveSurfaceTarget(type, surfaceId, capability);
        if (!target.ok) {
          throw new ItemError(
            "bad_request",
            target.reason === "unknown"
              ? `unknown surface '${surfaceId}' on type '${type}'; it has: ${target.known.join(", ")}`
              : `surface '${surfaceId}' is read-only (it is structured or derived — edit what it is built from); writable surfaces: ${target.known.join(", ")}`
          );
        }
        // The body write goes in as a plain markdown wrapper; createItem/
        // updateItem re-stamp it with the type's canonical format, so a song's
        // chart is stored as chordpro without this path knowing about formats.
        if (target.surface.storage.kind === "body") {
          args = { ...args, bodyMarkdown: surfaceContent };
        } else if (target.surface.storage.kind === "property") {
          const prev = (args.propertyPatch ?? {}) as Record<string, unknown>;
          args = {
            ...args,
            propertyPatch: { ...prev, [target.surface.storage.key]: surfaceContent },
          };
        }
        delete (args as Record<string, unknown>).surface;
        delete (args as Record<string, unknown>).content;
      }
      const patch = parseItemPayload(buildWriteRaw(args, ["propertyPatch"], ["id"]), "patch");
      // Catch the empty patch here, where we can name the tool's own fields
      // (bodyMarkdown especially — the shared lib's "no fields to update"
      // can't mention it, and used to fire exactly when a caller mis-named it).
      if (Object.keys(patch).length === 0) {
        throw new ItemError(
          "bad_request",
          "no fields to update: pass at least one of title, bodyMarkdown, status, " +
            "dueDate, scheduledDate, meetingAt, urgency, url, parentId, " +
            "properties, propertyPatch, inbox"
        );
      }
      const updated = await updateItem(ownerId, id, patch);
      return rowView(updated);
    },
  },
  {
    name: "move_item_type",
    title: "Change an item's type",
    description:
      "Move an item to a different type (e.g. a note that should become a " +
      "meeting). Properties the target type also has carry over; properties it " +
      "lacks are written into the body as a YAML block (and kept in the item too, " +
      "so nothing is lost). Relations are unaffected. Pass dryRun:true first to " +
      "preview what will carry over vs. be moved into the body. Call list_types " +
      "to see target types and their properties.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The item id (UUID)." },
        targetType: { type: "string", description: "The type key to move the item to (see list_types)." },
        dryRun: { type: "boolean", description: "If true, return the reconciliation summary without changing the item." },
      },
      required: ["id", "targetType"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const targetType =
        typeof args.targetType === "string" ? args.targetType.trim() : "";
      if (!targetType) throw new ItemError("bad_request", "targetType is required");
      const { summary, item } = await moveItemType(ownerId, id, targetType, {
        dryRun: args.dryRun === true,
      });
      return item ? { summary, item: rowView(item) } : { summary };
    },
  },
];
