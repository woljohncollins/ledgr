// The MCP method dispatcher (ADR-047): one JSON-RPC message in, one response
// (or null for a notification, which the route turns into a 202). Pure
// orchestration over the protocol envelope (protocol.ts) and the tool registry
// (tools.ts) — the route owns transport (auth, headers, status codes), this
// owns the MCP semantics. The method set is the stable core: initialize,
// tools/list, tools/call, resources/list, resources/read, and ping.
import {
  JSONRPC,
  classifyMessage,
  negotiateProtocolVersion,
  rpcError,
  rpcResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";
import { callTool, listToolDefs } from "@/lib/mcp/tools";
import {
  GUIDE_RESOURCE,
  MEMORY_PROTOCOL_RESOURCE,
  MEMORY_PROTOCOL_URI,
  readGuideResource,
} from "@/lib/mcp/guide";
import { USER_GUIDE_RESOURCE } from "@/lib/mcp/user-guide";
import { getSettings } from "@/lib/settings";

// Free-form version string for clients to display; tracks the PRD epoch
// (v0.18, the Markdown epoch), not the package.json build number.
const LEDGR_VERSION = "0.18";

export const SERVER_INFO = {
  name: "ledgr",
  title: "Ledgr",
  version: LEDGR_VERSION,
};

// Surfaced to the model by the client at connect time — what Ledgr is and how
// these tools fit together, so the first tool call is well-aimed.
export const INSTRUCTIONS = [
  "Ledgr is the owner's personal life-management system: meetings, tasks,",
  "notes, links, and people stored as typed",
  "items with relations between them.",
  "",
  "Use search_items to find an item or person by words; list_items to list by",
  "type, status, due-date window, or related item; get_item to read an item's",
  "body and its relations; create_item to file a task/note or capture something;",
  "and update_item to change fields (e.g. mark a task done). Call list_types to",
  "learn the available types and their custom properties before creating or",
  "filtering. A typical flow for \"what's open with Roger\": search_items for the",
  "Roger person, then list_items with that relatedTo, type=task, status=open.",
  "Tasks nest and tasks repeat. To break a task down, call add_subtasks with a",
  "list of titles (or create_item with parentId); read the tree back with",
  "list_subtasks, which carries an \"n of m done\" rollup. To make a task repeat,",
  "call set_recurrence with a phrase like \"every other tuesday\" or \"monthly on",
  "the 3rd\". A repeating task is ONE item holding the rule plus a log of which",
  "dates are done, so nothing stacks up when it's missed: completing it with",
  "update_item advances it to its next date rather than closing it. Use",
  "update_occurrence to tick a specific date, or to carve one date out into its",
  "own item when that one is different.",
  "",
  "Use attach_file to add an image or file to an item — pass a sourceUrl to fetch",
  "or base64 bytes, and by default it embeds the image/link in the item's body.",
  "For a LOCAL or LARGE file, use create_upload_url (get a presigned PUT), PUT the",
  "bytes to it, then embed_attachment — the bytes go straight to storage.",
  "",
  "To link to another item INLINE from within a body (so it renders as Ledgr's",
  "native @-mention chip, not a plain URL, and auto-creates a relation on save),",
  "write a markdown link of the form [@Title](ledgr://item/<id>) — the title as",
  "the label, the item's id after ledgr://item/. Look up the id first (search_items",
  "or list_items). Keep the label in sync with the item's actual title, since the",
  "chip displays that label text verbatim. This is separate from relateTo/",
  "relate_items, which link two items without touching either body.",
  "",
  "You can also SHAPE the workspace, not just its content: call describe_workspace",
  "for a snapshot of the types, views, dashboards, and navigation, then",
  "create_type/update_type, create_view/update_view, create_dashboard/add_widget,",
  "and update_nav to build what the owner asks for in plain language (\"make me a",
  "place to track sermons\", \"set up my main toolbar\"). Read the",
  "workspace-shaping-guide resource first, and confirm a config change with the",
  "owner before committing it.",
  "",
  "All data belongs to the single owner of this Ledgr; you only ever see and",
  "modify their items.",
].join("\n");

// Appended to INSTRUCTIONS only when the owner has AI Memory on (ADR-137). The
// connect-time instructions are the one place every client reliably surfaces to
// the model, so this is what actually gets the memory system used: tool
// descriptions are only read once a tool is already under consideration, and
// most clients never fetch resources unprompted. Kept short — it points at the
// protocol resource for the full contract rather than restating it. When AI
// Memory is off, INSTRUCTIONS is emitted byte-for-byte unchanged.
const MEMORY_INSTRUCTIONS = [
  "",
  "AI MEMORY is on. The owner keeps durable memories about themselves, their",
  "people, and their work in Ledgr, in two tiers. Call get_memory_stumps at the",
  "START of the session: it returns the small PINNED set, the standing rules you",
  "need on every run. Everything else is retrieved on demand — when a person,",
  "project, or system comes up that you don't already know, search_items for it",
  "by name with type: \"memory\", then get_item the stump for detail. When you",
  "learn something durable worth carrying into a later session, file it with",
  "remember. Read the memory-protocol resource (ledgr://guide/memory-protocol)",
  "for the full contract.",
].join("\n");

// Appended to INSTRUCTIONS only when the owner has Live editing context on
// (ADR-162). Like the memory addendum, the connect-time instructions are the one
// place every client reliably surfaces to the model, so this is what actually
// gets the co-editing loop used. Kept short; points at the tools.
const LIVE_CONTEXT_INSTRUCTIONS = [
  "",
  "LIVE EDITING CONTEXT is on. The owner may refer to \"this note\", \"this page\",",
  "\"the draft\", \"this sentence\", \"this\", or \"it\" to mean whatever they",
  "currently have open in Ledgr. Call get_active_context to resolve that — it",
  "returns the open note's freshly-read body and any text they've highlighted.",
  "Re-read it whenever they reference the note again or ask what you think of it;",
  "they edit directly with keyboard and mouse, so don't trust a body you saw",
  "earlier. To change the note, use edit_item_body (a surgical find-and-replace on",
  "one spot) rather than update_item (which resends the whole body), so you never",
  "clobber an edit they made elsewhere. Confirm before writing unless they've told",
  "you to go ahead.",
].join("\n");

// The instructions the client sees at initialize, owner-aware: the stable base,
// plus the memory addendum when AI Memory is on and the live-context addendum
// when Live editing context is on.
export async function buildInstructions(ownerId: string): Promise<string> {
  const { aiMemoryEnabled, liveContextEnabled } = await getSettings(ownerId);
  let out = INSTRUCTIONS;
  if (aiMemoryEnabled) out += `\n${MEMORY_INSTRUCTIONS}`;
  if (liveContextEnabled) out += `\n${LIVE_CONTEXT_INSTRUCTIONS}`;
  return out;
}

export async function handleMcpMessage(
  message: unknown,
  ownerId: string
): Promise<JsonRpcResponse | null> {
  const kind = classifyMessage(message);
  // Notifications (e.g. notifications/initialized) and stray responses get no
  // reply — the route answers them with 202 Accepted.
  if (kind === "notification" || kind === "response") return null;
  if (kind === "invalid") {
    return rpcError(null, JSONRPC.INVALID_REQUEST, "invalid JSON-RPC message");
  }

  const req = message as JsonRpcRequest;
  const { id, method } = req;

  switch (method) {
    case "initialize": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        // tools + resources; listChanged false since both sets are static (no
        // subscribe — the guide doesn't change per connection).
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: await buildInstructions(ownerId),
      });
    }

    case "tools/list":
      return rpcResult(id, { tools: await listToolDefs(ownerId) });

    case "resources/list": {
      // The stable workspace-shaping and user guides, plus the AI Memory
      // protocol when the owner has AI Memory on (ADR-137) — so a vanilla client
      // never sees it. The user guide (ADR-189) is ungated: "what can Ledgr do"
      // is useful to every client, and it holds no owner data.
      const { aiMemoryEnabled } = await getSettings(ownerId);
      const resources = aiMemoryEnabled
        ? [GUIDE_RESOURCE, USER_GUIDE_RESOURCE, MEMORY_PROTOCOL_RESOURCE]
        : [GUIDE_RESOURCE, USER_GUIDE_RESOURCE];
      return rpcResult(id, { resources });
    }

    case "resources/templates/list":
      // No templated resources; answer the optional probe cleanly rather than
      // method-not-found so clients that call it don't log an error.
      return rpcResult(id, { resourceTemplates: [] });

    case "resources/read": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (typeof params.uri !== "string") {
        return rpcError(id, JSONRPC.INVALID_PARAMS, "resources/read requires a string 'uri'");
      }
      // The memory protocol is gated: when AI Memory is off it's unlisted, and
      // reading it directly answers unknown-resource just like any other URI.
      if (params.uri === MEMORY_PROTOCOL_URI && !(await getSettings(ownerId)).aiMemoryEnabled) {
        return rpcError(id, JSONRPC.INVALID_PARAMS, `unknown resource '${params.uri}'`);
      }
      const contents = readGuideResource(params.uri);
      if (!contents) {
        return rpcError(id, JSONRPC.INVALID_PARAMS, `unknown resource '${params.uri}'`);
      }
      return rpcResult(id, { contents: [contents] });
    }

    case "tools/call": {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (typeof params.name !== "string") {
        return rpcError(id, JSONRPC.INVALID_PARAMS, "tools/call requires a string 'name'");
      }
      const result = await callTool(ownerId, params.name, params.arguments);
      return rpcResult(id, result);
    }

    case "ping":
      return rpcResult(id, {});

    default:
      return rpcError(id, JSONRPC.METHOD_NOT_FOUND, `unknown method '${method}'`);
  }
}
