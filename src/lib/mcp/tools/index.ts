// The MCP tool registry (ADR-047, PRD §5.5): search items, read item, create
// item, update item, list by entity/date — plus list_types so the model knows
// the type/property vocabulary before it creates or filters. Every tool is a
// thin wrapper over the same owner-scoped libs the REST API uses, so the MCP
// surface can never drift from the app's own contract or skip owner scoping.
//
// Tool definitions live per-family in sibling files (items/types/relations/
// views/templates/dashboards/workspace/memory); this file only assembles the
// registry and dispatches calls.
//
// A tool handler returns a plain object; callTool serializes it to MCP text
// content. Expected validation failures (ItemError) come back as an isError
// tool result so Claude sees a clean message and the session stays open;
// unexpected errors are captured (rule 9) and returned with a correlation id.
import { getSettings } from "@/lib/settings";
import { ItemError } from "@/lib/items";
import { captureError } from "@/lib/log";
import { attachmentTools } from "./attachments";
import { calendarTools } from "./calendar";
import { contextTools, LIVE_CONTEXT_TOOL_NAMES } from "./context";
import { dashboardTools } from "./dashboards";
import { itemTools } from "./items";
import { MEMORY_TOOL_NAMES, memoryTools } from "./memory";
import { recordTools } from "./records";
import { relationTools } from "./relations";
import { taskTools } from "./tasks";
import { templateTools } from "./templates";
import { typeTools } from "./types";
import { viewTools } from "./views";
import type { McpTool, McpToolDef, ToolCallResult } from "./wire";
import { workspaceTools } from "./workspace";

export type { McpToolDef, ToolCallResult } from "./wire";
export { MEMORY_TOOL_NAMES };

const TOOLS: McpTool[] = [
  ...itemTools,
  ...taskTools,
  ...recordTools,
  ...attachmentTools,
  ...calendarTools,
  ...typeTools,
  ...relationTools,
  ...viewTools,
  ...templateTools,
  ...workspaceTools,
  ...dashboardTools,
  ...memoryTools,
  ...contextTools,
];

const MEMORY_TOOL_SET = new Set<string>(MEMORY_TOOL_NAMES);
const LIVE_CONTEXT_TOOL_SET = new Set<string>(LIVE_CONTEXT_TOOL_NAMES);

// Whether an owner-gated tool is enabled for this owner. A tool that isn't
// behind a gate is always available.
function toolEnabled(
  name: string,
  flags: { aiMemoryEnabled: boolean; liveContextEnabled: boolean }
): boolean {
  if (MEMORY_TOOL_SET.has(name)) return flags.aiMemoryEnabled;
  if (LIVE_CONTEXT_TOOL_SET.has(name)) return flags.liveContextEnabled;
  return true;
}

// The wire definitions (handler stripped) for tools/list. Owner-aware: the
// memory tools drop out unless AI Memory is on; the live-context tools unless
// Live editing context is on.
export async function listToolDefs(ownerId: string): Promise<McpToolDef[]> {
  const flags = await getSettings(ownerId);
  return TOOLS.filter((t) => toolEnabled(t.name, flags)).map(
    ({ handler: _handler, ...def }) => def
  );
}

function toolError(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Run a tool by name. Expected request errors (ItemError) become an isError
// result with the message; anything unexpected is captured and answered with a
// correlation id, never thrown out to the transport (the session survives).
export async function callTool(
  ownerId: string,
  name: string,
  args: unknown
): Promise<ToolCallResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolError(`unknown tool '${name}'`);
  const a =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  try {
    // Defense in depth: a disabled gated tool is rejected even if a client calls
    // it directly without listing (listToolDefs already hides it).
    if (MEMORY_TOOL_SET.has(name) || LIVE_CONTEXT_TOOL_SET.has(name)) {
      const flags = await getSettings(ownerId);
      if (!toolEnabled(name, flags)) {
        const feature = MEMORY_TOOL_SET.has(name) ? "AI Memory" : "Live editing context";
        return toolError(`tool '${name}' is not enabled — turn on ${feature} in User Settings`);
      }
    }
    const payload = await tool.handler(ownerId, a);
    // A handler that returns a string has already rendered its own wire format
    // (the compact memory-stump index, ADR-230). Don't re-encode it as JSON.
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    if (err instanceof ItemError) return toolError(err.message);
    const correlationId = crypto.randomUUID();
    await captureError("mcp", err, { correlationId, detail: { tool: name } });
    return toolError(`internal error (correlationId ${correlationId})`);
  }
}
