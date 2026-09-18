// ADR-243 verification: setting a CUSTOM status through the write path. Statuses
// are user-defined per type but items.status is plain text, so every writer used
// to be able to store a key the type never had (it renders as nothing and buckets
// as not_started) — while the MCP tools + REST list filters were pinned to the
// INHERITED default set (open/done/archived) and so couldn't send a real custom
// stage at all. This checks both halves: custom keys and labels resolve, bogus
// names are refused by name, and the inherited default set still works.
// Against the DATABASE_URL branch. Run: npx tsx scripts/verify-status-write.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getDb } = await import("../src/db");
const { items, types, users } = await import("../src/db/schema");
const { createType, deleteType } = await import("../src/lib/types");
const { createItem, updateItem } = await import("../src/lib/item-mutations");
const { setTypeStatusConfig } = await import("../src/lib/types");
const { resolveStatusKey, resolveStatusSchema } = await import("../src/lib/status");
const { ItemError } = await import("../src/lib/items");
const { eq, inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
// Run a write and capture the ItemError message instead of throwing.
async function err(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof ItemError ? `${e.code}: ${e.message}` : `UNEXPECTED: ${String(e)}`;
  }
}

const TYPE_KEY = "zz_status_probe";
const createdIds: string[] = [];
const db = getDb();

try {
  const owner = await db.select({ id: users.id }).from(users).limit(1);
  if (owner.length === 0) throw new Error("no users row in this DB");
  const ownerId = owner[0].id;
  console.log(`owner ${ownerId}\n`);

  // --- 1. the pure resolver -------------------------------------------------
  const schema = resolveStatusSchema([
    { key: "someday", label: "Someday", category: "not_started", color: "#888888", isDefault: true },
    { key: "active", label: "Active", category: "in_progress", color: "#888888", isDefault: true },
    { key: "achieved", label: "Achieved", category: "done", color: "#888888", isDefault: true },
  ]);
  console.log("resolveStatusKey (pure)");
  check("exact key", resolveStatusKey(schema, "active") === "active");
  check("key, wrong case", resolveStatusKey(schema, "ACTIVE") === "active");
  check("label", resolveStatusKey(schema, "Achieved") === "achieved");
  check("label, wrong case + padding", resolveStatusKey(schema, "  someday  ") === "someday");
  check("unknown name → null", resolveStatusKey(schema, "open") === null);
  check("empty → null", resolveStatusKey(schema, "   ") === null);

  // --- 2. a type with custom stages ----------------------------------------
  await deleteType(TYPE_KEY).catch(() => {}); // leftover from a failed run
  await db.delete(types).where(eq(types.key, TYPE_KEY)); // hard-remove the soft-delete
  await createType({
    key: TYPE_KEY,
    label: "Status Probe",
    icon: null,
    propertySchema: [],
    showInQuickCapture: false,
    capability: null,
  });
  await setTypeStatusConfig(TYPE_KEY, "select", [
    { key: "someday", label: "Someday", category: "not_started", color: "#888888", isDefault: true },
    { key: "active", label: "Active", category: "in_progress", color: "#888888", isDefault: true },
    { key: "waiting", label: "Waiting for Others", category: "not_started", color: "#888888" },
    { key: "achieved", label: "Achieved", category: "done", color: "#888888", isDefault: true },
  ]);

  console.log("\ncreateItem with a custom stage");
  // The reported symptom: no status passed → the type's default non-terminal
  // stage, which is "Someday". This is correct behavior, and the reason passing
  // a status explicitly has to work.
  const dflt = await createItem(ownerId, { type: TYPE_KEY, title: "probe default" });
  createdIds.push(dflt.id);
  check("omitted status → the type's default stage", dflt.status === "someday", `got ${dflt.status}`);

  const byKey = await createItem(ownerId, { type: TYPE_KEY, title: "probe key", status: "active" });
  createdIds.push(byKey.id);
  check("status by KEY is stored", byKey.status === "active", `got ${byKey.status}`);
  check("...and buckets to its category", byKey.statusCategory === "in_progress", `got ${byKey.statusCategory}`);

  const byLabel = await createItem(ownerId, { type: TYPE_KEY, title: "probe label", status: "Waiting for Others" });
  createdIds.push(byLabel.id);
  check("status by LABEL resolves to the key", byLabel.status === "waiting", `got ${byLabel.status}`);
  check("...and buckets to its category", byLabel.statusCategory === "not_started", `got ${byLabel.statusCategory}`);

  const bogus = await err(() => createItem(ownerId, { type: TYPE_KEY, title: "nope", status: "open" }));
  check("a status the type lacks is REFUSED", bogus?.startsWith("bad_request") === true, `got ${bogus}`);
  check("...and the error names the real stages", (bogus ?? "").includes("waiting") && (bogus ?? "").includes("Waiting for Others"), bogus ?? "");

  console.log("\nupdateItem to a custom stage");
  const moved = await updateItem(ownerId, dflt.id, { status: "waiting" });
  check("update by KEY", moved.status === "waiting" && moved.statusCategory === "not_started", `${moved.status}/${moved.statusCategory}`);
  const moved2 = await updateItem(ownerId, dflt.id, { status: "Active" });
  check("update by LABEL", moved2.status === "active" && moved2.statusCategory === "in_progress", `${moved2.status}/${moved2.statusCategory}`);
  const done = await updateItem(ownerId, dflt.id, { status: "achieved" });
  check("update into the done category", done.status === "achieved" && done.statusCategory === "done", `${done.status}/${done.statusCategory}`);
  const badUpdate = await err(() => updateItem(ownerId, byKey.id, { status: "in_progress" }));
  check("bogus update is REFUSED", badUpdate?.startsWith("bad_request") === true, `got ${badUpdate}`);
  check("...and the item is untouched", (await db.select({ s: items.status }).from(items).where(eq(items.id, byKey.id)))[0].s === "active");

  // --- 3. regression: the inherited default set still works -----------------
  console.log("\nregression: types that inherit the default stages");
  const note = await createItem(ownerId, { type: "note", title: "probe note" });
  createdIds.push(note.id);
  check("note defaults to open", note.status === "open", `got ${note.status}`);
  const noteDone = await updateItem(ownerId, note.id, { status: "done" });
  check("note → done still works", noteDone.status === "done" && noteDone.statusCategory === "done", `${noteDone.status}/${noteDone.statusCategory}`);
  const noteArch = await updateItem(ownerId, note.id, { status: "archived" });
  check("note → archived still works", noteArch.status === "archived" && noteArch.statusCategory === "archived", `${noteArch.status}/${noteArch.statusCategory}`);
  const task = await createItem(ownerId, { type: "task", title: "probe task" });
  createdIds.push(task.id);
  const taskDone = await updateItem(ownerId, task.id, { status: "done" });
  check("task checkbox completion still works", taskDone.statusCategory === "done", `got ${taskDone.statusCategory}`);
  const noteBogus = await err(() => updateItem(ownerId, note.id, { status: "achieved" }));
  check("a custom stage from ANOTHER type is refused on note", noteBogus?.startsWith("bad_request") === true, `got ${noteBogus}`);
} finally {
  if (createdIds.length > 0) await db.delete(items).where(inArray(items.id, createdIds));
  await db.delete(items).where(eq(items.type, TYPE_KEY));
  await db.delete(types).where(eq(types.key, TYPE_KEY));
  console.log(`\ncleaned up ${createdIds.length} items + type ${TYPE_KEY}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
