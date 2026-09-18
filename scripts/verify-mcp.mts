// Slice 36 verification (ADR-047): the MCP server. Pure protocol (version
// negotiation, message classification, JSON-RPC envelope), the method
// dispatcher (initialize / tools/list / ping / unknown / notification), and the
// six tools run end-to-end against live Neon (create → relate → get → search →
// list-by-entity/date → update → list_types), plus validation and owner
// scoping. Creates two temp owners and cleans up. Run:
//   npx tsx scripts/verify-mcp.mts
// Safe to delete once the slice is closed.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { items, users, views: viewsTable, templates: templatesTable, types: typesTable, dashboards: dashboardsTable } = await import("../src/db/schema");
const { eq } = await import("drizzle-orm");
const protocol = await import("../src/lib/mcp/protocol");
const { handleMcpMessage, buildInstructions, INSTRUCTIONS } = await import("../src/lib/mcp/server");
const { updateSettings } = await import("../src/lib/settings");
const { getMemoryStumps } = await import("../src/lib/memory");
const { listToolDefs, callTool } = await import("../src/lib/mcp/tools");
const { createView, parseViewInput } = await import("../src/lib/views");
const { createTemplate } = await import("../src/lib/templates");
const { updateItem } = await import("../src/lib/item-mutations");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// Small typed accessors for the JSON-RPC envelopes the dispatcher returns.
const resultOf = (r: unknown) => (r as { result?: Record<string, unknown> }).result ?? {};
const errorOf = (r: unknown) => (r as { error?: { code?: number } }).error;

// --- pure protocol --------------------------------------------------------
check("negotiate echoes a supported version", protocol.negotiateProtocolVersion("2025-03-26") === "2025-03-26");
check("negotiate unsupported -> latest", protocol.negotiateProtocolVersion("1.0.0") === protocol.LATEST_PROTOCOL_VERSION);
check("negotiate undefined -> latest", protocol.negotiateProtocolVersion(undefined) === protocol.LATEST_PROTOCOL_VERSION);
check("isSupportedProtocolVersion true", protocol.isSupportedProtocolVersion("2025-06-18"));
check("isSupportedProtocolVersion false", !protocol.isSupportedProtocolVersion("nope"));
check("classify request", protocol.classifyMessage({ jsonrpc: "2.0", id: 1, method: "ping" }) === "request");
check("classify notification", protocol.classifyMessage({ jsonrpc: "2.0", method: "notifications/initialized" }) === "notification");
check("classify response", protocol.classifyMessage({ jsonrpc: "2.0", id: 1, result: {} }) === "response");
check("classify invalid (empty)", protocol.classifyMessage({}) === "invalid");
check("classify invalid (array, no batching in 2025-06-18)", protocol.classifyMessage([{}]) === "invalid");
const errEnv = protocol.rpcError(7, protocol.JSONRPC.METHOD_NOT_FOUND, "x");
check("rpcError shape", errEnv.jsonrpc === "2.0" && errEnv.id === 7 && "error" in errEnv && errEnv.error.code === -32601);
const resEnv = protocol.rpcResult(8, { ok: true });
check("rpcResult shape", resEnv.jsonrpc === "2.0" && resEnv.id === 8 && "result" in resEnv);

// --- dispatcher (no DB needed) --------------------------------------------
const DUMMY = "00000000-0000-0000-0000-000000000000";
const initRes = await handleMcpMessage(
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } },
  DUMMY
);
const initResult = resultOf(initRes);
check("initialize negotiates the client's version", initResult.protocolVersion === "2025-06-18");
check("initialize advertises tools capability", !!(initResult.capabilities as { tools?: unknown })?.tools);
check("initialize advertises resources capability", !!(initResult.capabilities as { resources?: unknown })?.resources);
check("initialize serverInfo.name = ledgr", (initResult.serverInfo as { name?: string })?.name === "ledgr");
check("initialize includes instructions", typeof initResult.instructions === "string" && (initResult.instructions as string).length > 0);
// AI Memory off (DUMMY has no settings row → default false): the instructions
// must be byte-identical to the base — a vanilla client never learns the memory
// concept from the connect-time instructions (ADR-137).
check("instructions omit the memory addendum when AI Memory off", initResult.instructions === INSTRUCTIONS);
check("instructions omit the memory addendum when AI Memory off (no marker)", !(initResult.instructions as string).includes("AI MEMORY is on"));

const listRes = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, DUMMY);
const toolList = (resultOf(listRes).tools ?? []) as { name: string; description: string; inputSchema: { type: string; properties: unknown }; annotations: { readOnlyHint?: boolean } }[];
const EXPECTED = [
  "search_items", "list_items", "get_item", "create_item", "update_item",
  "move_item_type", // ADR-132
  "list_types", "relate_items", "unrelate_items", "list_views", "run_view",
  "list_templates", "apply_template",
  "link_to_line", // ADR-148
  // attachments (ADR-150)
  "attach_file", "create_upload_url", "embed_attachment",
  // workspace shaping (ADR-102)
  "describe_workspace", "create_type", "update_type", "create_view",
  "update_view", "create_dashboard", "add_widget", "update_nav",
  // subtasks + recurrence (ADR-180)
  "list_subtasks", "add_subtasks", "set_recurrence", "update_occurrence",
  // record/project shaping (ADR-181)
  "get_record_layout", "set_record_layout", "set_type_layout", "add_to_record",
  "set_type_statuses",
];
// The always-on tool set (AI Memory tools are gated off for the dummy owner —
// asserted separately below), so tools/list here is exactly EXPECTED.
check(
  "tools/list returns the always-on tools",
  EXPECTED.every((n) => toolList.some((t) => t.name === n)) && toolList.length === EXPECTED.length
);
check("every tool has an object inputSchema", toolList.every((t) => t.inputSchema?.type === "object" && !!t.inputSchema.properties));
check("every tool has a non-empty description", toolList.every((t) => typeof t.description === "string" && t.description.length > 0));
check("read tools are flagged readOnly", ["search_items", "list_items", "get_item", "list_types", "list_views", "run_view", "list_templates", "describe_workspace", "list_subtasks", "get_record_layout"].every((n) => toolList.find((t) => t.name === n)!.annotations.readOnlyHint === true));
check("write tools are not readOnly", ["create_item", "update_item", "relate_items", "unrelate_items", "apply_template", "create_type", "update_type", "create_view", "update_view", "create_dashboard", "add_widget", "update_nav", "add_subtasks", "set_recurrence", "update_occurrence", "set_record_layout", "set_type_layout", "add_to_record", "set_type_statuses"].every((n) => toolList.find((t) => t.name === n)!.annotations.readOnlyHint === false));
const bareDefs = await listToolDefs(DUMMY);
check("listToolDefs strips the handler", bareDefs.every((d) => !("handler" in (d as Record<string, unknown>))));
// AI Memory (ADR-137) is off for the dummy owner (no settings row → default
// false), so the memory tools must not appear in the listing.
check("memory tools hidden when AI Memory off (default)", !bareDefs.some((d) => d.name === "get_memory_stumps" || d.name === "remember"));

const pingRes = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "ping" }, DUMMY);
check("ping returns an empty result", JSON.stringify(resultOf(pingRes)) === "{}");
const unknownRes = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "frobnicate" }, DUMMY);
check("unknown method -> -32601", errorOf(unknownRes)?.code === -32601);
const notifRes = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, DUMMY);
check("notification -> null (route sends 202)", notifRes === null);
const invalidRes = await handleMcpMessage({}, DUMMY);
check("invalid message -> -32600", errorOf(invalidRes)?.code === -32600);

// --- resources (ADR-102): the workspace-shaping orientation guide -----------
const GUIDE_URI = "ledgr://guide/workspace-shaping";
const USER_GUIDE_URI = "ledgr://guide/using-ledgr";
const MEMORY_PROTOCOL_URI = "ledgr://guide/memory-protocol";
const resListRes = await handleMcpMessage({ jsonrpc: "2.0", id: 30, method: "resources/list" }, DUMMY);
const resList = (resultOf(resListRes).resources ?? []) as { uri: string; name: string; mimeType?: string }[];
// The ungated set: the shaping guide (ADR-102) + the user guide (ADR-189). The
// memory protocol is gated on AI Memory (ADR-137), which is off for the dummy
// owner, so this is an exact set, not a membership test.
check(
  "resources/list returns exactly the two ungated guides",
  resList.length === 2 &&
    [GUIDE_URI, USER_GUIDE_URI].every((u) => resList.some((r) => r.uri === u)) &&
    !resList.some((r) => r.uri === MEMORY_PROTOCOL_URI),
  resList.map((r) => r.uri).join(", ")
);
check(
  "the shaping guide is served as markdown",
  resList.find((r) => r.uri === GUIDE_URI)?.mimeType === "text/markdown"
);
const resReadRes = await handleMcpMessage({ jsonrpc: "2.0", id: 31, method: "resources/read", params: { uri: GUIDE_URI } }, DUMMY);
const resContents = (resultOf(resReadRes).contents ?? []) as { uri: string; text: string }[];
check("resources/read returns the guide markdown", resContents[0]?.uri === GUIDE_URI && resContents[0].text.includes("Shaping a Ledgr workspace"));
const resBadRes = await handleMcpMessage({ jsonrpc: "2.0", id: 32, method: "resources/read", params: { uri: "ledgr://nope" } }, DUMMY);
check("resources/read unknown uri -> -32602", errorOf(resBadRes)?.code === -32602);
const resTmplRes = await handleMcpMessage({ jsonrpc: "2.0", id: 33, method: "resources/templates/list" }, DUMMY);
check("resources/templates/list returns an empty list", Array.isArray((resultOf(resTmplRes) as { resourceTemplates?: unknown }).resourceTemplates));

// --- tools/call against live Neon -----------------------------------------
type Json = Record<string, unknown>;
const db = getDb();
const stamp = Date.now();
const [owner] = await db.insert(users).values({ email: `verify-mcp-${stamp}@example.invalid` }).returning({ id: users.id });
const [owner2] = await db.insert(users).values({ email: `verify-mcp2-${stamp}@example.invalid` }).returning({ id: users.id });
const ownerId = owner.id;
const owner2Id = owner2.id;
// A unique, slug-valid type key for the shaping tools. Types are instance-global
// (no owner_id), so this is cleaned up by key in finally, not by owner.
const shapeTypeKey = `vmcptype${stamp}`;

async function callJson(o: string, name: string, args: Json): Promise<Json> {
  const r = await callTool(o, name, args);
  if (r.isError) throw new Error(`tool ${name} unexpectedly errored: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as Json;
}
async function expectErr(label: string, o: string, name: string, args: Json) {
  const r = await callTool(o, name, args);
  check(label, r.isError === true, r.isError ? r.content[0].text : "did not error");
}
const itemsOf = (j: Json) => (j.items ?? []) as Json[];

try {
  const dueStr = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  const entity = await callJson(ownerId, "create_item", { type: "person", title: `Roger Zentaur ${stamp}` });
  check("create_item returns an id", typeof entity.id === "string");
  check("create_item defaults inbox=false (filed, not captured)", entity.inbox === false);

  const task = await callJson(ownerId, "create_item", {
    type: "task",
    title: `Follow up Zentaur ${stamp}`,
    bodyMarkdown: "Discuss the Zentaur **budget**.",
    dueDate: dueStr,
    status: "open",
    urgency: 4,
    relateTo: [entity.id as string],
  });
  check("create_item made an open task", task.type === "task" && task.status === "open");
  check("create_item recorded the relateTo edge", Array.isArray(task.relatedTo) && (task.relatedTo as string[]).includes(entity.id as string));

  const got = await callJson(ownerId, "get_item", { id: task.id as string });
  check("get_item returns the markdown body verbatim", got.body === "Discuss the Zentaur **budget**.");
  check("get_item lists the related person as confirmed", (got.related as Json[]).some((r) => r.id === entity.id && r.matchState === "confirmed"));

  // LT3: get_item resolveTokens resolves live {{item.*}} tokens in title + body.
  const tokItem = await callJson(ownerId, "create_item", {
    type: "task",
    title: "Token check",
    bodyMarkdown: "Title is {{item.title}}; raw {{item.bogus}} stays.",
  });
  const rawGot = await callJson(ownerId, "get_item", { id: tokItem.id as string });
  check("get_item leaves tokens raw by default", rawGot.body === "Title is {{item.title}}; raw {{item.bogus}} stays.");
  const resGot = await callJson(ownerId, "get_item", { id: tokItem.id as string, resolveTokens: true });
  check("get_item resolveTokens resolves item.title", resGot.body === "Title is Token check; raw {{item.bogus}} stays.");

  const search = await callJson(ownerId, "search_items", { query: "Zentaur" });
  check("search_items finds the items (FTS over title+body)", (search.count as number) >= 2 && itemsOf(search).some((i) => i.id === task.id));
  const searchEntity = await callJson(ownerId, "search_items", { query: "Zentaur", type: "person" });
  check("search_items filters by type", itemsOf(searchEntity).length >= 1 && itemsOf(searchEntity).every((i) => i.type === "person"));

  const byEntity = await callJson(ownerId, "list_items", { type: "task", status: "open", relatedTo: entity.id as string });
  check("list_items by person returns the open task", itemsOf(byEntity).some((i) => i.id === task.id));

  const byWeek = await callJson(ownerId, "list_items", { type: "task", due: "week", dateField: "dueDate" });
  check("list_items due=week includes the +2d task", itemsOf(byWeek).some((i) => i.id === task.id));
  const overdue = await callJson(ownerId, "list_items", { type: "task", due: "overdue", dateField: "dueDate" });
  check("list_items due=overdue excludes the future task", !itemsOf(overdue).some((i) => i.id === task.id));

  const updated = await callJson(ownerId, "update_item", { id: task.id as string, status: "done" });
  check("update_item set status=done", updated.status === "done");
  const stillOpen = await callJson(ownerId, "list_items", { type: "task", status: "open", relatedTo: entity.id as string });
  check("list_items open no longer returns the done task", !itemsOf(stillOpen).some((i) => i.id === task.id));

  const typesOut = await callJson(ownerId, "list_types", {});
  check("list_types lists the five system types", ["task", "event", "note", "link", "person"].every((k) => (typesOut.types as Json[]).some((t) => t.key === k)));

  // Full transport path: a tools/call routed through the dispatcher.
  const dispatched = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_types", arguments: {} } }, ownerId);
  const dispatchedContent = (resultOf(dispatched).content ?? []) as { type: string; text: string }[];
  check("dispatcher tools/call returns text content", dispatchedContent[0]?.type === "text" && dispatchedContent[0].text.includes("\"task\""));

  // --- new tools (ADR-071): propertyPatch, relations, views, templates -----

  // propertyPatch merges one key without clobbering siblings (ADR-069).
  const propItem = await callJson(ownerId, "create_item", {
    type: "task",
    title: `Patch me ${stamp}`,
    properties: { area: "ops", priority: "p2" },
  });
  await callJson(ownerId, "update_item", { id: propItem.id as string, propertyPatch: { priority: "p1" } });
  const patched = await callJson(ownerId, "get_item", { id: propItem.id as string });
  const patchedProps = patched.properties as Json;
  check("update_item propertyPatch merges one key, keeps the rest", patchedProps.priority === "p1" && patchedProps.area === "ops");

  // relate_items / unrelate_items on existing items (both items stay).
  const note = await callJson(ownerId, "create_item", { type: "note", title: `Note re Zentaur ${stamp}` });
  const rel = await callJson(ownerId, "relate_items", { sourceId: note.id as string, targetId: entity.id as string });
  check("relate_items reports a confirmed edge", rel.related === true && rel.matchState === "confirmed");
  const noteGot = await callJson(ownerId, "get_item", { id: note.id as string });
  check("relate_items shows on get_item.related", (noteGot.related as Json[]).some((r) => r.id === entity.id));
  const unrel = await callJson(ownerId, "unrelate_items", { itemId: note.id as string, otherId: entity.id as string });
  check("unrelate_items removes the edge", (unrel.removed as number) >= 1);
  const noteAfter = await callJson(ownerId, "get_item", { id: note.id as string });
  check("unrelate_items leaves no edge but keeps both items", typeof noteAfter.id === "string" && !(noteAfter.related as Json[]).some((r) => r.id === entity.id));

  // list_views / run_view over a view made through the lib (task was set done).
  const view = await createView(ownerId, parseViewInput({
    name: `Done tasks ${stamp}`,
    layout: "list",
    filter: { type: "task", status: "done" },
    sort: { field: "updatedAt", dir: "desc" },
  }));
  const viewsOut = await callJson(ownerId, "list_views", {});
  check("list_views includes the new view", (viewsOut.views as Json[]).some((v) => v.id === view.id));
  const ran = await callJson(ownerId, "run_view", { id: view.id });
  check("run_view returns the view's items (the done task)", itemsOf(ran).some((i) => i.id === task.id));

  // list_templates / apply_template over a template made through the lib. The
  // content now lives on the prototype item (ADR-093), so author one property on
  // it and confirm apply (deep clone) carries it.
  const template = await createTemplate(ownerId, {
    type: "task",
    name: `Standup ${stamp}`,
  });
  await updateItem(ownerId, template.prototypeItemId, {
    propertyPatch: { area: "ops" },
    body: { format: "markdown", text: "Standup topic: {{ask:Topic}}" },
  });
  const tmpls = await callJson(ownerId, "list_templates", { type: "task" });
  const tmplEntry = (tmpls.templates as Json[]).find((t) => t.id === template.id);
  check("list_templates lists the template", !!tmplEntry);
  check("list_templates reports the prototype id", tmplEntry?.prototypeItemId === template.prototypeItemId);
  check("list_templates reports isDefault (TPL5)", tmplEntry?.isDefault === false);
  check("list_templates reports askLabels from the prototype (TPL5)", JSON.stringify(tmplEntry?.askLabels) === JSON.stringify(["Topic"]));
  const fromTemplate = await callJson(ownerId, "apply_template", { id: template.id, answers: { Topic: "Roadmap" } });
  check("apply_template creates a filed item of the template's type", fromTemplate.type === "task" && fromTemplate.inbox === false);
  check("apply_template's item is not a template", fromTemplate.id !== template.prototypeItemId);
  const fromTemplateGot = await callJson(ownerId, "get_item", { id: fromTemplate.id as string });
  check("apply_template carried the prototype's properties", (fromTemplateGot.properties as Json)?.area === "ops");
  check("apply_template resolved {{ask}} from answers (TPL5)", (fromTemplateGot.body as string)?.includes("Roadmap"));

  // apply_template onto an EXISTING item (TPL5): targetId + mode merges the
  // template in and returns the same item (not a new one). fill carries the
  // template's property onto the empty-bodied target and resolves answers.
  const applyTarget = await callJson(ownerId, "create_item", { type: "task", title: `Apply onto me ${stamp}` });
  const merged = await callJson(ownerId, "apply_template", {
    id: template.id,
    targetId: applyTarget.id as string,
    mode: "fill",
    answers: { Topic: "Hiring" },
  });
  check("apply_template with targetId returns the same existing item (TPL5)", merged.id === applyTarget.id);
  const mergedGot = await callJson(ownerId, "get_item", { id: applyTarget.id as string });
  check("apply_template fill carried the template's property onto the target (TPL5)", (mergedGot.properties as Json)?.area === "ops");
  check("apply_template fill filled the empty body with the resolved template body (TPL5)", (mergedGot.body as string)?.includes("Hiring"));
  // The prototype itself must not leak into MCP search/list surfaces.
  const taskList = await callJson(ownerId, "list_items", { type: "task" });
  check("list_items excludes the template prototype", !itemsOf(taskList).some((i) => i.id === template.prototypeItemId));

  // --- workspace shaping (ADR-102): config-level write tools ---------------

  // create_type — the "make me a place to track X" move.
  const createdType = await callJson(ownerId, "create_type", {
    key: shapeTypeKey,
    label: "MCP Shape Type",
    propertySchema: [{ key: "stage", label: "Stage", kind: "select", options: ["a", "b"] }],
  });
  check("create_type returns the new type with its property", createdType.key === shapeTypeKey && (createdType.properties as Json[]).length === 1);

  // describe_workspace — the read-before-write snapshot.
  const desc = await callJson(ownerId, "describe_workspace", {});
  check("describe_workspace returns types/views/dashboards/nav", Array.isArray(desc.types) && Array.isArray(desc.views) && Array.isArray(desc.dashboards) && !!desc.nav);
  check("describe_workspace includes the system types", ["task", "event", "note", "link", "person"].every((k) => (desc.types as Json[]).some((t) => t.key === k)));
  check("describe_workspace summarizes the new type (propertyCount, no full schema)", (desc.types as Json[]).some((t) => t.key === shapeTypeKey && t.propertyCount === 1 && !("properties" in t)));
  check("describe_workspace carries the Build-tool catalog", Array.isArray(desc.buildTools) && (desc.buildTools as Json[]).length > 0 && (desc.buildTools as Json[]).every((b) => typeof b.href === "string"));
  check("describe_workspace nav reports the slots + layout", Array.isArray((desc.nav as Json).slots) && typeof (desc.nav as Json).position === "string");

  // update_type — full-replace the schema with one property added.
  const updatedType = await callJson(ownerId, "update_type", {
    key: shapeTypeKey,
    label: "MCP Shape Type",
    propertySchema: [
      { key: "stage", label: "Stage", kind: "select", options: ["a", "b"] },
      { key: "owner_name", label: "Owner", kind: "text" },
    ],
  });
  check("update_type replaced the schema (now two properties)", (updatedType.properties as Json[]).length === 2);

  // create_view over the new type, then update_view to a grouped board.
  const createdView = await callJson(ownerId, "create_view", {
    name: `Shape view ${stamp}`,
    layout: "list",
    filter: { type: shapeTypeKey },
    sort: { field: "updatedAt", dir: "desc" },
  });
  check("create_view returns a view id + layout", typeof createdView.id === "string" && createdView.layout === "list");
  const updatedView = await callJson(ownerId, "update_view", {
    id: createdView.id as string,
    name: `Shape view ${stamp} (board)`,
    layout: "board",
    filter: { type: shapeTypeKey },
    grouping: { propertyKey: "stage" },
  });
  check("update_view replaced layout + name", updatedView.layout === "board" && (updatedView.name as string).includes("board"));
  const viewsAfter = await callJson(ownerId, "list_views", {});
  check("list_views shows the shaped view", (viewsAfter.views as Json[]).some((v) => v.id === createdView.id));

  // create_dashboard + add_widget (a view widget backed by the new view).
  const createdDash = await callJson(ownerId, "create_dashboard", { name: `Shape dash ${stamp}` });
  check("create_dashboard returns an id with no widgets", typeof createdDash.id === "string" && createdDash.widgetCount === 0);
  const withWidget = await callJson(ownerId, "add_widget", {
    dashboardId: createdDash.id as string,
    kind: "view",
    viewId: createdView.id as string,
  });
  check("add_widget appended a view widget backed by the view", withWidget.widgetCount === 1 && (withWidget.widgets as Json[])[0].viewId === createdView.id);
  const descAfter = await callJson(ownerId, "describe_workspace", {});
  check("describe_workspace reports the dashboard + its widget", (descAfter.dashboards as Json[]).some((d) => d.id === createdDash.id && d.widgetCount === 1));
  await expectErr("add_widget rejects a view widget with no viewId", ownerId, "add_widget", { dashboardId: createdDash.id as string, kind: "view" });

  // MCP widget parity (ADR-171): all 8 widget kinds are on the machine contract,
  // so an agent can assemble a whole activity board. dashView only surfaces
  // id/kind/viewId/label, so the fields it omits (embed's itemId, a container's
  // children) are asserted against the stored jsonb.
  const withTree = await callJson(ownerId, "add_widget", {
    dashboardId: createdDash.id as string,
    kind: "tree",
    viewId: createdView.id as string,
    settings: { titleOverride: "Outline", childSource: "children", childLimit: 3 },
  });
  check("add_widget places a tree widget backed by the view", (withTree.widgets as Json[]).some((w) => w.kind === "tree" && w.viewId === createdView.id));
  await callJson(ownerId, "add_widget", {
    dashboardId: createdDash.id as string,
    kind: "embed",
    itemId: note.id as string,
    settings: { showBody: true },
  });
  await callJson(ownerId, "add_widget", {
    dashboardId: createdDash.id as string,
    kind: "container",
    settings: {
      mode: "tabs",
      title: "Both",
      children: [
        { kind: "view", viewId: createdView.id as string },
        { kind: "text", settings: { heading: "Notes" } },
      ],
    },
  });
  const withImage = await callJson(ownerId, "add_widget", {
    dashboardId: createdDash.id as string,
    kind: "image",
    settings: { url: "https://example.invalid/banner.png", alt: "Banner", fit: "contain" },
  });
  check("add_widget placed all eight kinds' new arrivals (tree/embed/container/image)", ["tree", "embed", "container", "image"].every((k) => (withImage.widgets as Json[]).some((w) => w.kind === k)));
  const [dashRow] = await db.select().from(dashboardsTable).where(eq(dashboardsTable.id, createdDash.id as string));
  const storedWidgets = (dashRow?.widgets ?? []) as Json[];
  const embedStored = storedWidgets.find((w) => w.kind === "embed");
  check("the stored embed widget names the item", embedStored?.itemId === note.id);
  const containerStored = storedWidgets.find((w) => w.kind === "container");
  const containerChildren = ((containerStored?.settings as Json)?.children ?? []) as Json[];
  check("the stored container carries its two non-container children", containerChildren.length === 2 && containerChildren.every((c) => c.kind !== "container"));
  const imageStored = storedWidgets.find((w) => w.kind === "image");
  check("the stored image widget kept its url + fit", (imageStored?.settings as Json)?.url === "https://example.invalid/banner.png" && (imageStored?.settings as Json)?.fit === "contain");
  await expectErr("add_widget rejects an embed widget with no itemId", ownerId, "add_widget", { dashboardId: createdDash.id as string, kind: "embed" });
  await expectErr("add_widget rejects an embed widget with a bogus itemId", ownerId, "add_widget", { dashboardId: createdDash.id as string, kind: "embed", itemId: "not-a-uuid" });

  // update_nav — set the middle slots + a layout knob, read them back.
  const navOut = await callJson(ownerId, "update_nav", {
    navSlots: [
      { type: "destination", kind: "view", href: `/views/${createdView.id}`, label: "Sermons", icon: "views" },
      { type: "destination", kind: "builtin", href: "/tasks", label: "Tasks", icon: "tasks" },
    ],
    position: "left",
  });
  check("update_nav set the position", navOut.position === "left");
  check("update_nav stored the two slots in order", (navOut.slots as Json[]).length === 2 && (navOut.slots as Json[])[0].href === `/views/${createdView.id}`);
  await expectErr("update_nav with no fields errors", ownerId, "update_nav", {});
  await expectErr("update_nav rejects a non-array navSlots", ownerId, "update_nav", { navSlots: "nope" });

  // create_type validation (safety lives in the parsers).
  await expectErr("create_type rejects a duplicate key", ownerId, "create_type", { key: shapeTypeKey, label: "Dup" });
  await expectErr("create_type rejects an unknown property kind", ownerId, "create_type", { key: `vmcpbad${stamp}`, label: "Bad", propertySchema: [{ key: "x", label: "X", kind: "frobnicate" }] });
  await expectErr("create_type rejects a bad key slug", ownerId, "create_type", { key: "Bad-Key!", label: "Bad" });
  await expectErr("update_type on a missing type errors", ownerId, "update_type", { key: `vmcpmissing${stamp}`, label: "Nope" });

  // owner scoping holds for the shaping write tools (views/dashboards/nav are
  // owner-scoped; types are instance-global by design).
  await expectErr("owner2 cannot update_view owner1's view", owner2Id, "update_view", { id: createdView.id as string, name: "x", layout: "list" });
  await expectErr("owner2 cannot add_widget to owner1's dashboard", owner2Id, "add_widget", { dashboardId: createdDash.id as string, kind: "text" });
  const desc2 = await callJson(owner2Id, "describe_workspace", {});
  check("describe_workspace is owner-scoped for views + dashboards", !(desc2.views as Json[]).some((v) => v.id === createdView.id) && !(desc2.dashboards as Json[]).some((d) => d.id === createdDash.id));

  // owner scoping holds for the new tools too.
  await expectErr("owner2 cannot run_view owner1's view", owner2Id, "run_view", { id: view.id });
  await expectErr("owner2 cannot relate owner1's items", owner2Id, "relate_items", { sourceId: note.id as string, targetId: entity.id as string });
  await expectErr("owner2 cannot apply_template onto owner1's item", owner2Id, "apply_template", { id: template.id, targetId: applyTarget.id as string });

  // Validation / error surfacing (isError results, not thrown).
  await expectErr("create_item with an unknown type errors", ownerId, "create_item", { type: `nope_${stamp}`, title: "x" });
  await expectErr("create_item missing type errors", ownerId, "create_item", { title: "x" });
  await expectErr("get_item with a bad UUID errors", ownerId, "get_item", { id: "not-a-uuid" });
  await expectErr("get_item for a missing item errors", ownerId, "get_item", { id: DUMMY });
  await expectErr("an unknown tool errors", ownerId, "frobnicate", {});
  await expectErr("update_item with no fields errors", ownerId, "update_item", { id: task.id as string });

  // Owner scoping: owner2 cannot see owner1's data.
  await expectErr("owner2 cannot get_item owner1's item", owner2Id, "get_item", { id: task.id as string });
  const owner2List = await callJson(owner2Id, "list_items", { type: "task" });
  check("owner2's list excludes owner1's task", !itemsOf(owner2List).some((i) => i.id === task.id));

  // --- AI Memory (ADR-137 + AI Memory improvements) -----------------------
  // Gated off by default: the memory tools are absent and the connect-time
  // instructions carry no memory addendum.
  const memToolsOff = await listToolDefs(ownerId);
  check("memory tools absent before enabling", !memToolsOff.some((d) => d.name === "get_memory_stumps" || d.name === "remember"));
  const instrOff = await buildInstructions(ownerId);
  check("instructions omit memory addendum before enabling", instrOff === INSTRUCTIONS);
  await expectErr("remember rejected before enabling", ownerId, "remember", { title: "should not be stored" });

  // Turn AI Memory on for this throwaway owner and re-check the surface.
  await updateSettings(ownerId, { aiMemoryEnabled: true });
  const memToolsOn = await listToolDefs(ownerId);
  check("memory tools appear once enabled", memToolsOn.some((d) => d.name === "get_memory_stumps") && memToolsOn.some((d) => d.name === "remember"));
  const instrOn = await buildInstructions(ownerId);
  check("instructions gain the memory addendum once enabled", instrOn.startsWith(INSTRUCTIONS) && instrOn.includes("AI MEMORY is on") && instrOn.includes("get_memory_stumps"));

  // remember: partial-link hardening — a bad `about` id fails the whole call
  // and creates NO memory (the fix: validate ids before the create).
  const beforeBad = (await getMemoryStumps(ownerId, { includeAll: true })).stumps;
  await expectErr("remember with a bad about id errors", ownerId, "remember", {
    title: `Should not persist ${stamp}`,
    about: [DUMMY], // a well-formed UUID that isn't an owned item
  });
  const afterBad = (await getMemoryStumps(ownerId, { includeAll: true })).stumps;
  check("failed remember created no memory (no partial write)", afterBad.length === beforeBad.length);

  // remember: the happy path links the memory to a real item.
  const goodMem = await callJson(ownerId, "remember", {
    title: `Roger reports up ${stamp}`,
    bodyMarkdown: "Test memory.",
    kind: "reference",
    horizon: "evergreen",
    about: [entity.id as string],
  });
  check("remember returns a linked memory", (goodMem.about as string[])?.includes(entity.id as string));
  const { stumps: stumpsDefault } = await getMemoryStumps(ownerId);
  check(
    "an unpinned evergreen memory is NOT always-on (horizon no longer loads, ADR-230)",
    !stumpsDefault.some((s) => s.id === goodMem.id)
  );
  const { stumps: allStumps } = await getMemoryStumps(ownerId, { includeAll: true });
  const remembered = allStumps.find((s) => s.id === goodMem.id);
  check("includeAll still returns it", !!remembered);
  check("the stump carries its linked neighbour", !!remembered?.linked.some((l) => l.id === entity.id));

  // Pinned is the ONLY always-on dial, and it ignores age entirely: the axes are
  // orthogonal, so a stale-marked seasonal memory still loads when pinned.
  const pinnedMem = await callJson(ownerId, "remember", {
    title: `Pinned rule ${stamp}`,
    horizon: "seasonal",
    pinned: true,
  });
  await db
    .update(items)
    .set({ updatedAt: new Date(Date.now() - 200 * 86_400_000) })
    .where(eq(items.id, pinnedMem.id as string));
  const { stumps: pinnedOnly, total } = await getMemoryStumps(ownerId);
  check("a pinned memory loads however old it is", pinnedOnly.some((s) => s.id === pinnedMem.id));
  check("the always-on set is pinned and nothing else", pinnedOnly.every((s) => s.pinned));
  check("total counts the whole store, not just the pinned", total > pinnedOnly.length);
} finally {
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(items).where(eq(items.ownerId, owner2Id));
  await db.delete(dashboardsTable).where(eq(dashboardsTable.ownerId, ownerId));
  await db.delete(dashboardsTable).where(eq(dashboardsTable.ownerId, owner2Id));
  await db.delete(viewsTable).where(eq(viewsTable.ownerId, ownerId));
  await db.delete(templatesTable).where(eq(templatesTable.ownerId, ownerId));
  // Types are instance-global (no owner_id) — clean up the shaping test type by key.
  await db.delete(typesTable).where(eq(typesTable.key, shapeTypeKey));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, owner2Id));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
