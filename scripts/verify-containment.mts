// PJ1 / ADR-111 verification: containment via the relations.home flag + setHome.
// Live Neon: setHome marks a primary residence; homeParentOf resolves it; the
// one-home-per-source invariant holds (a second setHome clears the first); a
// home edge surfaces in the Related panel carrying home; containment emits the
// right activity line on a tracked parent; owner-scoping rejects foreign items.
// Cleans up everything it creates. Run: npx tsx scripts/verify-containment.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getDb } = await import("../src/db");
const { items, users, relations, activityEvents } = await import("../src/db/schema");
const { createItem } = await import("../src/lib/item-mutations");
const { setHome, relateItems, listRelatedItems, filedUnderRecords, unrelateItems } = await import("../src/lib/relations");
const { homeParentOf, listActivity } = await import("../src/lib/activity");
const { mayLiveInManyRecords } = await import("../src/lib/types");
const { queryViewItems } = await import("../src/lib/views");
const { eq, inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const ownerId = (await db.select({ id: users.id }).from(users))[0].id;
const created: string[] = [];
async function make(type: string, title: string) {
  const it = await createItem(ownerId, { type, title });
  created.push(it.id);
  return it;
}

console.log("\n# setHome + homeParentOf");
{
  const projectA = await make("project", "PJ1 containment project A");
  const task = await make("task", "PJ1 contained task");
  await setHome(ownerId, task.id, projectA.id, "project");
  const parent = await homeParentOf(ownerId, task.id);
  check("homeParentOf resolves the home parent", parent?.id === projectA.id, String(parent?.id));
  check("home parent carries its type", parent?.type === "project");

  const edges = await db
    .select({ home: relations.home, role: relations.role })
    .from(relations)
    .where(eq(relations.sourceId, task.id));
  check("the home edge is stored home=true", edges.some((e) => e.home === true && e.role === "project"));
}

console.log("\n# one-home-per-source invariant");
{
  const projA = await make("project", "PJ1 home A");
  const projB = await make("project", "PJ1 home B");
  const task = await make("task", "PJ1 movable task");
  await setHome(ownerId, task.id, projA.id, "project");
  await setHome(ownerId, task.id, projB.id, "project");
  const parent = await homeParentOf(ownerId, task.id);
  check("a second setHome moves the home to the new parent", parent?.id === projB.id, String(parent?.id));
  const homeEdges = await db
    .select({ id: relations.id })
    .from(relations)
    .where(eq(relations.sourceId, task.id));
  const homeCount = (
    await db.select({ home: relations.home }).from(relations).where(eq(relations.sourceId, task.id))
  ).filter((e) => e.home).length;
  check("exactly one home edge remains (invariant)", homeCount === 1, `${homeCount} home of ${homeEdges.length} edges`);
}

console.log("\n# relateItems({home}) + Related panel carries home");
{
  const proj = await make("project", "PJ1 relate-home project");
  const note = await make("note", "PJ1 relate-home note");
  await relateItems(ownerId, note.id, proj.id, "contains", { home: true });
  const parent = await homeParentOf(ownerId, note.id);
  check("relateItems with home:true sets the home parent", parent?.id === proj.id);
  // Related panel (direction-blind) on the note should carry the home flag.
  const related = await listRelatedItems(ownerId, note.id);
  const row = related.find((r) => r.id === proj.id) as { home?: boolean } | undefined;
  check("the Related panel row carries home", row?.home === true);
}

console.log("\n# containment emits the right activity line on a tracked parent");
{
  const proj = await make("project", "PJ1 activity project");
  const task = await make("task", "PJ1 activity task");
  await setHome(ownerId, task.id, proj.id, "project");
  const log = await listActivity(ownerId, proj.id);
  check("setHome emits task_added on the parent", log.some((e) => e.kind === "task_added" && e.actorId === task.id), log.map((e) => e.kind).join(","));

  // A non-tracked parent (note) gets NO containment activity.
  const noteParent = await make("note", "PJ1 non-tracked parent");
  const child = await make("task", "PJ1 child of note");
  await setHome(ownerId, child.id, noteParent.id, "contains");
  const noteLog = await listActivity(ownerId, noteParent.id);
  check("a non-tracked parent logs no containment event", noteLog.length === 0);
}

console.log("\n# owner-scoping");
{
  const proj = await make("project", "PJ1 scope project");
  let threw = false;
  try {
    await setHome(ownerId, "00000000-0000-0000-0000-000000000000", proj.id, "contains");
  } catch {
    threw = true;
  }
  check("setHome rejects a foreign/missing child", threw);

  let selfThrew = false;
  try {
    await setHome(ownerId, proj.id, proj.id, "contains");
  } catch {
    selfThrew = true;
  }
  check("setHome rejects a self-containment", selfThrew);
}

console.log("\n# per-type containment policy (ADR-232)");
{
  // The rule is DERIVED from whether a type has a completion concept, so the
  // split must keep reproducing itself: a type that completes lives in one
  // record, a resource type may be relevant to several.
  check("a task lives in one record", (await mayLiveInManyRecords("task")) === false);
  check("a milestone lives in one record", (await mayLiveInManyRecords("milestone")) === false);
  check("a note may live in many", (await mayLiveInManyRecords("note")) === true);
  check("an event may live in many", (await mayLiveInManyRecords("event")) === true);
  check("a link may live in many", (await mayLiveInManyRecords("link")) === true);
  check(
    "an unknown type falls back to containment",
    (await mayLiveInManyRecords("no-such-type-xyz")) === false
  );
}

console.log("\n# a resource in two records keeps its home");
{
  const projA = await make("project", "ADR232 project A");
  const projB = await make("project", "ADR232 project B");
  const note = await make("note", "ADR232 shared note");
  // Filed in A the way the create path files it, then attached to B the way
  // the attach path attaches a resource.
  await setHome(ownerId, note.id, projA.id, "contains");
  await relateItems(ownerId, note.id, projB.id, "related");

  const parent = await homeParentOf(ownerId, note.id);
  check("attaching to a second record does NOT move the home", parent?.id === projA.id, String(parent?.id));

  const edges = await db
    .select({ target: relations.targetId, role: relations.role, home: relations.home })
    .from(relations)
    .where(eq(relations.sourceId, note.id));
  check(
    "the second edge is `related`, not `contains`",
    edges.some((e) => e.target === projB.id && e.role === "related" && !e.home),
    edges.map((e) => `${e.role}${e.home ? "/home" : ""}`).join(", ")
  );
  // The whole point of role `related`: the completion sweep scopes on
  // `home or role in ('project','contains')`, so a visiting resource is
  // outside it even if its type later gains a Done checkbox.
  check(
    "the second edge is outside the completion sweep's scope",
    !edges.some((e) => e.target === projB.id && (e.home || e.role === "project" || e.role === "contains"))
  );
  // Both cards still show it: the collection queries are home- and role-blind.
  for (const [name, proj] of [["A", projA], ["B", projB]] as const) {
    const rows = await queryViewItems(
      ownerId,
      { type: "note", relatedTo: proj.id },
      { field: "updatedAt", dir: "desc" },
      50
    );
    check(`the note shows in project ${name}'s Docs card`, rows.some((r) => r.id === note.id));
  }
}

console.log("\n# re-filing leaves no ghost on the old record");
{
  // setHome only DEMOTES the previous home edge, and the cards are
  // home-agnostic, so the attach path has to clear the old filing itself or a
  // re-filed task renders on both records' cards — and a completing type has
  // no detach ✕ to get it off the old one. Found in a browser check.
  const projA = await make("project", "ADR232 refile A");
  const projB = await make("project", "ADR232 refile B");
  const task = await make("task", "ADR232 refiled task");
  await setHome(ownerId, task.id, projA.id, "project");

  // What the attach route does for a type that files under one record.
  for (const old of await filedUnderRecords(ownerId, task.id)) {
    if (old === projB.id) continue;
    for (const role of ["project", "contains"]) {
      await unrelateItems(ownerId, task.id, old, { role });
    }
  }
  await setHome(ownerId, task.id, projB.id, "project");

  const filed = await filedUnderRecords(ownerId, task.id);
  check("the task is filed under exactly one record", filed.length === 1 && filed[0] === projB.id, filed.join(", "));
  const stale = await queryViewItems(
    ownerId,
    { type: "task", relatedTo: projA.id },
    { field: "updatedAt", dir: "desc" },
    50
  );
  check("the old record's card no longer lists it", !stale.some((r) => r.id === task.id));
  const now = await queryViewItems(
    ownerId,
    { type: "task", relatedTo: projB.id },
    { field: "updatedAt", dir: "desc" },
    50
  );
  check("the new record's card lists it", now.some((r) => r.id === task.id));
}

// Cleanup: drop activity (cascade covers subject; be explicit anyway), then items.
await db.delete(activityEvents).where(inArray(activityEvents.subjectId, created));
for (const id of created) await db.delete(items).where(eq(items.id, id));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
