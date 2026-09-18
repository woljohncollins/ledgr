// AI Memory verification (ADR-137): the memory type + get_memory_stumps/remember
// tools + the aiMemoryEnabled gating + pinned-only always-on (ADR-230), end-to-end against live Neon
// through the real MCP dispatcher. Uses a throwaway owner (created + fully cleaned
// up), so it never touches real data. Run:
//   npx tsx scripts/verify-memory.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { items, users, relations } = await import("../src/db/schema");
const { eq, inArray } = await import("drizzle-orm");
const { handleMcpMessage } = await import("../src/lib/mcp/server");
const { createItem } = await import("../src/lib/item-mutations");
const { updateSettings } = await import("../src/lib/settings");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
const resultOf = (r: unknown) => (r as { result?: Record<string, unknown> }).result ?? {};
const toolNames = (r: unknown) =>
  ((resultOf(r).tools ?? []) as { name: string }[]).map((t) => t.name);
// tools/call returns { content:[{text}], isError? }; the text is our JSON payload.
function callPayload(r: unknown): { data: Record<string, unknown>; isError: boolean } {
  const res = resultOf(r) as { content?: { text: string }[]; isError?: boolean };
  const text = res.content?.[0]?.text ?? "{}";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { data, isError: res.isError === true };
}
// A handler may render its own text (the compact stump index, ADR-230).
function callText(r: unknown): string {
  const res = resultOf(r) as { content?: { text: string }[] };
  return res.content?.[0]?.text ?? "";
}
const rpc = (method: string, params: Record<string, unknown>, owner: string) =>
  handleMcpMessage({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }, owner);

// --- throwaway owner --------------------------------------------------------
const email = `verify-memory-${Date.now()}@example.invalid`;
const [owner] = await getDb().insert(users).values({ email }).returning({ id: users.id });
const ownerId = owner.id;
const createdItemIds: string[] = [];
try {
  // A person to link a memory to (the "recall graph" entry point).
  const person = await createItem(ownerId, { type: "person", title: "Verify Person" });
  createdItemIds.push(person.id);

  // --- gating OFF (default) -------------------------------------------------
  const offList = await rpc("tools/list", {}, ownerId);
  check("default: memory tools hidden", !toolNames(offList).some((n) => n === "get_memory_stumps" || n === "remember"));
  const offRemember = await rpc("tools/call", { name: "remember", arguments: { title: "should fail" } }, ownerId);
  check("default: remember rejected when off", callPayload(offRemember).isError);
  const offRes = ((resultOf(await rpc("resources/list", {}, ownerId)).resources ?? []) as { uri: string }[]).map((r) => r.uri);
  check("default: memory-protocol resource hidden", !offRes.includes("ledgr://guide/memory-protocol"));

  // --- turn AI Memory ON ----------------------------------------------------
  await updateSettings(ownerId, { aiMemoryEnabled: true });
  const onList = await rpc("tools/list", {}, ownerId);
  check("on: both memory tools listed", ["get_memory_stumps", "remember"].every((n) => toolNames(onList).includes(n)));
  const onRes = ((resultOf(await rpc("resources/list", {}, ownerId)).resources ?? []) as { uri: string }[]).map((r) => r.uri);
  check("on: memory-protocol resource listed", onRes.includes("ledgr://guide/memory-protocol"));
  const protoRead = resultOf(await rpc("resources/read", { uri: "ledgr://guide/memory-protocol" }, ownerId)) as {
    contents?: { text: string }[];
  };
  check("on: memory-protocol reads", (protoRead.contents?.[0]?.text ?? "").includes("pinned"));

  // --- remember (one-call create + link) ------------------------------------
  const rememberRes = callPayload(
    await rpc(
      "tools/call",
      {
        name: "remember",
        arguments: {
          title: "Verify Person prefers async check-ins",
          bodyMarkdown: "They dislike being cold-called.\n\n**Why:** stated in 1:1.",
          kind: "feedback",
          horizon: "evergreen",
          about: [person.id],
        },
      },
      ownerId
    )
  );
  const memId = rememberRes.data.id as string;
  if (memId) createdItemIds.push(memId);
  check("remember: created a memory", !rememberRes.isError && typeof memId === "string");
  check("remember: type is memory", rememberRes.data.type === "memory");
  check("remember: facets echoed", rememberRes.data.kind === "feedback" && rememberRes.data.horizon === "evergreen");
  check("remember: linked the person", Array.isArray(rememberRes.data.about) && (rememberRes.data.about as string[]).includes(person.id));

  // --- get_memory_stumps: compact TEXT, pinned only (ADR-230) ---------------
  // The unpinned evergreen memory above must NOT load; horizon is a truth
  // property and no longer touches the always-on decision.
  const rawText = callText(await rpc("tools/call", { name: "get_memory_stumps", arguments: {} }, ownerId));
  check("stumps: payload is compact text, not JSON", !rawText.trimStart().startsWith("{"));
  check("stumps: header reports the counts", /shown of \d+ total/.test(rawText));
  check("stumps: unpinned evergreen memory is NOT always-on", !rawText.includes(memId));

  const pinnedMem = await createItem(ownerId, {
    type: "memory",
    title: "Always hand the owner PowerShell, never bash",
    properties: { kind: "feedback", horizon: "evergreen", pinned: true },
  });
  createdItemIds.push(pinnedMem.id);
  const pinnedText = callText(await rpc("tools/call", { name: "get_memory_stumps", arguments: {} }, ownerId));
  check("stumps: a pinned memory IS always-on", pinnedText.includes(pinnedMem.id));
  check("stumps: line carries kind/horizon and an age", /\[feed\/ever\] \(\d{4}-\d{2}-\d{2}, today\)/.test(pinnedText));

  // --- a pinned memory loads however old it is ------------------------------
  await getDb()
    .update(items)
    .set({ updatedAt: new Date(Date.now() - 400 * 86_400_000) })
    .where(eq(items.id, pinnedMem.id));
  const agedText = callText(await rpc("tools/call", { name: "get_memory_stumps", arguments: {} }, ownerId));
  check("stumps: an old pinned memory still loads", agedText.includes(pinnedMem.id));
  check("stumps: its age renders in years", agedText.includes("1y ago"));

  // --- stale hedge: an aged seasonal memory is marked, never hidden ---------
  const seasonal = await createItem(ownerId, {
    type: "memory",
    title: "Searching for a campus pastor",
    properties: { kind: "project", horizon: "seasonal" },
  });
  createdItemIds.push(seasonal.id);
  await getDb()
    .update(items)
    .set({ updatedAt: new Date(Date.now() - 120 * 86_400_000) })
    .where(eq(items.id, seasonal.id));
  const allText = callText(
    await rpc("tools/call", { name: "get_memory_stumps", arguments: { includeAll: true } }, ownerId)
  );
  check("includeAll: the unpinned memories are all there", allText.includes(memId) && allText.includes(seasonal.id));
  check("stale: aged seasonal renders STALE", /\(20\d\d-\d\d-\d\d, 4mo ago, STALE\).*Searching for a campus pastor/.test(allText));
  check("stale: aged evergreen does NOT render STALE", !new RegExp(`${pinnedMem.id}.*STALE`).test(agedText));

  // --- search_items(type: "memory") is the Tier 2 recall path ---------------
  const hitRes = callPayload(
    await rpc(
      "tools/call",
      { name: "search_items", arguments: { query: "PowerShell", type: "memory" } },
      ownerId
    )
  );
  const hits = (hitRes.data.items ?? []) as { id: string; age?: string }[];
  const hit = hits.find((h) => h.id === pinnedMem.id);
  check("search: type=memory finds the memory", !!hit);
  check("search: the hit renders its age", hit?.age === "1y ago");

  // --- turn OFF again: tools + resource disappear, callTool rejects ---------
  await updateSettings(ownerId, { aiMemoryEnabled: false });
  check("off again: tools hidden", !toolNames(await rpc("tools/list", {}, ownerId)).some((n) => n === "remember"));
  const offRead = await rpc("resources/read", { uri: "ledgr://guide/memory-protocol" }, ownerId);
  check("off again: protocol read is refused", !!(offRead as { error?: unknown }).error);
} finally {
  // --- cleanup: relations, items, then the throwaway owner ------------------
  if (createdItemIds.length) {
    await getDb().delete(relations).where(inArray(relations.sourceId, createdItemIds));
    await getDb().delete(relations).where(inArray(relations.targetId, createdItemIds));
    await getDb().delete(items).where(inArray(items.id, createdItemIds));
  }
  await getDb().delete(users).where(eq(users.id, ownerId));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
