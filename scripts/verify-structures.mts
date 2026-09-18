// Slice 35 verification: workflow & wiki structure templates + the board
// property-grouping helpers. Pure planning (planStructure → a valid type +
// views), the presets, the pure grouping helpers (groupValueFor / orderedGroups
// / dueBucket), and applyStructurePlan against live Neon (creates the type +
// views, pins the primary view, then cleans up). Run:
//   npx tsx scripts/verify-structures.mts
// Safe to delete once the slice is closed.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { dashboards, items, types, users, views } = await import("../src/db/schema");
const { usedViewIds } = await import("../src/lib/dashboards");
const {
  planStructure,
  applyStructurePlan,
  STRUCTURE_PRESETS,
  STAGE_KEY,
} = await import("../src/lib/structure-templates");
const {
  groupValueFor,
  groupValuesFor,
  orderedGroups,
  boardDropPatch,
  dueBucket,
  NONE_GROUP,
} = await import("../src/lib/view-grouping");
const { ItemError } = await import("../src/lib/items");
const { eq } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
async function throws(name: string, fn: () => Promise<unknown> | unknown, code?: string) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    const ok = err instanceof ItemError && (!code || err.code === code);
    check(name, ok, err instanceof Error ? err.message : String(err));
  }
}

const now = new Date("2026-06-13T12:00:00Z");

// --- pure: planWorkflow ---------------------------------------------------
const wf = planStructure({
  kind: "workflow",
  name: "Hiring Candidate",
  stages: ["Applied", "Interview", "Offer"],
  properties: [{ key: "role", label: "Role", kind: "text" }],
});
check("workflow type key slugified", wf.type.key === "hiring_candidate");
check("workflow leads with a stage select", wf.type.propertySchema[0].key === STAGE_KEY && wf.type.propertySchema[0].kind === "select");
check("stage options are the stages in order", JSON.stringify(wf.type.propertySchema[0].options) === JSON.stringify(["Applied", "Interview", "Offer"]));
check("workflow keeps the extra property", wf.type.propertySchema.some((p) => p.key === "role"));
check("workflow makes a board + a table", wf.views.length === 2 && wf.views.some((v) => v.layout === "board") && wf.views.some((v) => v.layout === "table"));
const board = wf.views.find((v) => v.layout === "board")!;
check("board groups by the stage property", !!board.grouping && "propertyKey" in board.grouping && board.grouping.propertyKey === STAGE_KEY);
check("board filters to the type", board.filter.type === "hiring_candidate");
check("primary view is the board", wf.primaryViewName === board.name);
await throws("workflow needs >=2 stages", () =>
  planStructure({ kind: "workflow", name: "X", stages: ["only"] }), "bad_request");

// --- pure: planWiki -------------------------------------------------------
const wiki = planStructure({
  kind: "wiki",
  name: "Trip",
  properties: [{ key: "location", label: "Location", kind: "text" }],
});
check("wiki type has no stage", !wiki.type.propertySchema.some((p) => p.key === STAGE_KEY));
check("wiki keeps its property", wiki.type.propertySchema[0]?.key === "location");
check("wiki makes one table view", wiki.views.length === 1 && wiki.views[0].layout === "table");
check("wiki table sorts by title", wiki.views[0].sort.field === "title");
await throws("rejects a blank name", () => planStructure({ kind: "wiki", name: "   " }), "bad_request");
await throws("rejects an unknown kind", () =>
  // @ts-expect-error testing a bad kind at runtime
  planStructure({ kind: "nope", name: "X" }), "bad_request");

// --- presets all plan cleanly ---------------------------------------------
for (const preset of STRUCTURE_PRESETS) {
  try {
    const plan = planStructure({
      kind: preset.kind,
      name: preset.name,
      stages: preset.stages,
      properties: preset.properties,
    });
    check(`preset '${preset.id}' plans cleanly`, !!plan.type.key && plan.views.length >= 1);
  } catch (err) {
    check(`preset '${preset.id}' plans cleanly`, false, err instanceof Error ? err.message : String(err));
  }
}

// --- pure: grouping helpers -----------------------------------------------
const mk = (props: Record<string, unknown> | null, id = "item-1") => ({
  id,
  status: "open",
  urgency: null,
  kind: null,
  type: "hiring_candidate",
  dueDate: null,
  scheduledDate: null,
  properties: props,
});
const stageGrouping = { propertyKey: STAGE_KEY };
check("groupValueFor reads a property", groupValueFor(mk({ stage: "Interview" }), stageGrouping, now) === "Interview");
check("missing property is the none group", groupValueFor(mk({}), stageGrouping, now) === NONE_GROUP);
check("field grouping still works", groupValueFor(mk(null), { field: "status" }, now) === "open");

// Fan-out (2026-08-12). A multi-valued grouping now puts a row in EVERY one of its
// values rather than one combined "a, b" column — that composite column was shared
// with nothing, which is the opposite of grouping. groupValueFor keeps returning a
// single value for the board-DnD path, so it reports the FIRST.
check(
  "multi_select fans out to each value",
  JSON.stringify(groupValuesFor(mk({ stage: ["a", "b"] }), stageGrouping, now)) ===
    JSON.stringify(["a", "b"])
);
check(
  "groupValueFor takes the first of a multi value",
  groupValueFor(mk({ stage: ["a", "b"] }), stageGrouping, now) === "a"
);
check(
  "a single-valued property is still one group",
  JSON.stringify(groupValuesFor(mk({ stage: "Interview" }), stageGrouping, now)) ===
    JSON.stringify(["Interview"])
);
check(
  "empty multi_select is the none group",
  JSON.stringify(groupValuesFor(mk({ stage: [] }), stageGrouping, now)) ===
    JSON.stringify([NONE_GROUP])
);
check(
  "duplicate values collapse (a row can't appear twice in one column)",
  JSON.stringify(groupValuesFor(mk({ stage: ["a", "a"] }), stageGrouping, now)) ===
    JSON.stringify(["a"])
);

// Relation grouping (group by Tags): values come from edges keyed by source id, not
// from the row, so a missing map entry must read as untagged rather than throw.
const tagGrouping = { relationRole: "tags" };
const tagEdges = new Map([
  ["item-1", [{ id: "t1", title: "Work" }, { id: "t2", title: "Urgent" }]],
  ["item-2", []],
]);
check(
  "relation grouping fans out to each tag",
  JSON.stringify(groupValuesFor(mk(null, "item-1"), tagGrouping, now, tagEdges)) ===
    JSON.stringify(["Work", "Urgent"])
);
check(
  "a row with no edges is the none group",
  JSON.stringify(groupValuesFor(mk(null, "item-2"), tagGrouping, now, tagEdges)) ===
    JSON.stringify([NONE_GROUP])
);
check(
  "a row absent from the edge map is the none group",
  JSON.stringify(groupValuesFor(mk(null, "item-99"), tagGrouping, now, tagEdges)) ===
    JSON.stringify([NONE_GROUP])
);
check(
  "no edge map at all is the none group, not a crash",
  JSON.stringify(groupValuesFor(mk(null, "item-1"), tagGrouping, now)) ===
    JSON.stringify([NONE_GROUP])
);
check(
  "a blank tag title is ignored",
  JSON.stringify(
    groupValuesFor(mk(null, "x"), tagGrouping, now, new Map([["x", [{ id: "t", title: "  " }]]]))
  ) === JSON.stringify([NONE_GROUP])
);
// A tag board must not be droppable: moving a card would mean rewriting edges, and
// with fan-out "dragged out of Work" is ambiguous when the card is also in Urgent.
check("a relation grouping is not droppable", boardDropPatch(tagGrouping, "Work") === null);
check(
  "a select property grouping still IS droppable",
  boardDropPatch(stageGrouping, "Offer") !== null
);

const present = new Set(["Interview", "Applied", NONE_GROUP]);
const ordered = orderedGroups(stageGrouping, present, ["Applied", "Interview", "Offer"]);
check("orderedGroups follows the option order, none last", JSON.stringify(ordered) === JSON.stringify(["Applied", "Interview", NONE_GROUP]));
const noOrder = orderedGroups(stageGrouping, new Set(["Zed", "Alpha", NONE_GROUP]));
check("orderedGroups falls back to alpha, none last", JSON.stringify(noOrder) === JSON.stringify(["Alpha", "Zed", NONE_GROUP]));
check("dueBucket: overdue", dueBucket(new Date("2026-06-10T00:00:00Z"), now) === "overdue");
check("dueBucket: today", dueBucket(new Date("2026-06-13T00:00:00Z"), now) === "today");
check("dueBucket: later", dueBucket(new Date("2026-09-01T00:00:00Z"), now) === "later");
check("dueBucket: no date", dueBucket(null, now) === "no date");

// --- applyStructurePlan against Neon --------------------------------------
const stamp = Date.now();
const typeKey = `vstruct${stamp}`;
const db = getDb();
const [owner] = await db
  .insert(users)
  .values({ email: `verify-structures-${stamp}@example.invalid` })
  .returning({ id: users.id });

try {
  const plan = planStructure({
    kind: "workflow",
    name: `Pipeline ${stamp}`,
    key: typeKey,
    stages: ["Applied", "Interview", "Offer"],
    properties: [{ key: "role", label: "Role", kind: "text" }],
  });
  const result = await applyStructurePlan(owner.id, plan, { addToDashboard: true });
  check("apply created the type", result.typeKey === typeKey);
  check("apply created two views", result.viewIds.length === 2);
  check("apply set a primary view", !!result.primaryViewId);
  check("apply pinned the primary view", result.pinnedViewId === result.primaryViewId);

  const typeRow = await db.select().from(types).where(eq(types.key, typeKey));
  check("the type exists with a stage select", typeRow.length === 1);

  const viewRows = await db.select().from(views).where(eq(views.ownerId, owner.id));
  check("two views persisted", viewRows.length === 2);
  const boardRow = viewRows.find((v) => v.layout === "board");
  check("board persisted its property grouping", JSON.stringify(boardRow?.grouping) === JSON.stringify({ propertyKey: STAGE_KEY }));
  const used = await usedViewIds(owner.id);
  check("primary view is a widget on a dashboard", result.pinnedViewId != null && used.has(result.pinnedViewId));

  await throws("apply rejects a duplicate type key", () =>
    applyStructurePlan(owner.id, plan), "bad_request");
} finally {
  await db.delete(dashboards).where(eq(dashboards.ownerId, owner.id));
  await db.delete(items).where(eq(items.ownerId, owner.id));
  await db.delete(views).where(eq(views.ownerId, owner.id));
  await db.delete(types).where(eq(types.key, typeKey));
  await db.delete(users).where(eq(users.id, owner.id));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
