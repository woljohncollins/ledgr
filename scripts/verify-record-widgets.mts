// PJ5 / ADR-111 (+ ADR-196 completable milestones) verification: the milestone
// type (polymorphic, completable by checkbox / linked task / date), the Next
// Action pin + auto-advance, and the milestones fan-out. Live Neon.
// (The editable widget UIs + the /contain endpoint are exercised in-browser; the
// verify covers the server contracts they ride.) Cleans up.
// Run: npx tsx scripts/verify-record-widgets.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getDb } = await import("../src/db");
const { items, users, activityEvents } = await import("../src/db/schema");
const { getItem } = await import("../src/lib/items");
const {
  createItem,
  updateItem,
  toggleItemDone,
} = await import("../src/lib/item-mutations");
const { setHome } = await import("../src/lib/relations");
const { homeParentOf } = await import("../src/lib/activity");
const { getType } = await import("../src/lib/types");
const { resolveComposition } = await import("../src/lib/composition");
const { resolveRecordWidgets } = await import("../src/lib/record-widgets");
const { eq, inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const ownerId = (await db.select({ id: users.id }).from(users))[0].id;
const created: string[] = [];
async function make(type: string, title: string, extra: Record<string, unknown> = {}) {
  const it = await createItem(ownerId, { type, title, ...extra });
  created.push(it.id);
  return it;
}

console.log("\n# milestone type");
{
  const mt = await getType("milestone");
  check("milestone is a system type", mt.isSystem === true);
  check("milestone is hidden + out of quick capture", mt.hidden === true && mt.showInQuickCapture === false);
  check("milestone is completable (status_mode checkbox, ADR-196)", mt.statusMode === "checkbox");
  const keys = mt.propertySchema.map((p) => p.key);
  check("milestone carries the 'task' relation field", keys.includes("task"));
  check("milestone carries the 'points' number field", keys.includes("points"));
}

console.log("\n# milestone: polymorphic attach + completion (ADR-196)");
{
  const note = await make("note", "PJ5 host note");
  const ms = await make("milestone", "Booklet to printer", { dueDate: new Date("2026-07-15T00:00:00.000Z") });
  await setHome(ownerId, ms.id, note.id, "contains");
  const parent = await homeParentOf(ownerId, ms.id);
  check("a milestone attaches to a NON-project type (polymorphic)", parent?.id === note.id);
  check("a milestone starts open (not_started)", ms.statusCategory === "not_started");
  check("the milestone's date is its due_date", ms.dueDate?.toISOString() === "2026-07-15T00:00:00.000Z");

  const { milestoneStates } = await import("../src/lib/milestones");
  const { relateItems } = await import("../src/lib/relations");
  const asRow = (m: { id: string; statusCategory: string; dueDate: Date | null; properties: unknown }) => m;

  // 1. date fallback: dated + no task link + date passed => done via "date",
  //    and the mode is date-driven (no checkbox affordance).
  let states = await milestoneStates(ownerId, [asRow(ms)]);
  check("a dated, un-linked milestone is date-mode", states.get(ms.id)?.mode === "date");
  check("a passed date completes an un-linked milestone (via 'date')", states.get(ms.id)?.via === "date");
  check("a date-mode completion dates itself at the due date", states.get(ms.id)?.completedAt?.getTime() === ms.dueDate?.getTime());

  // 2. manual: an undated, un-linked milestone is checkbox-mode; checking it
  //    off completes it AND stamps properties.completed_at (the Timeline places
  //    it at that day); reopening clears the stamp.
  const manual = await make("milestone", "PJ5 manual milestone");
  states = await milestoneStates(ownerId, [asRow(manual)]);
  check("an undated, un-linked milestone is manual-mode", states.get(manual.id)?.mode === "manual");
  await toggleItemDone(ownerId, manual.id);
  const manualFresh = await getItem(ownerId, manual.id);
  const stamp = (manualFresh.properties as Record<string, unknown> | null)?.completed_at;
  check("completing a milestone stamps properties.completed_at", typeof stamp === "string" && !Number.isNaN(new Date(stamp as string).getTime()));
  states = await milestoneStates(ownerId, [asRow(manualFresh)]);
  check("checking a milestone off completes it (via 'manual')", states.get(manual.id)?.via === "manual");
  check("the state carries the completion date", states.get(manual.id)?.completedAt != null);
  await toggleItemDone(ownerId, manual.id); // reopen
  const manualReopened = await getItem(ownerId, manual.id);
  check("reopening clears the stamp", (manualReopened.properties as Record<string, unknown> | null)?.completed_at === undefined);

  // 3. task link: task-mode; an open linked task holds it open — even past its
  //    date — and the task completing completes it.
  const linked = await make("milestone", "PJ5 linked milestone", { dueDate: new Date("2026-07-15T00:00:00.000Z") });
  const drive = await make("task", "PJ5 driving task");
  await relateItems(ownerId, linked.id, drive.id, "task");
  states = await milestoneStates(ownerId, [asRow(linked)]);
  check("a task-linked milestone is task-mode (even with a date)", states.get(linked.id)?.mode === "task");
  check("an open linked task holds a milestone open (date is a target, not a trigger)", states.get(linked.id)?.done === false);
  await toggleItemDone(ownerId, drive.id);
  states = await milestoneStates(ownerId, [asRow(linked)]);
  check("completing the linked task completes the milestone (via 'task')", states.get(linked.id)?.via === "task");

  // 4. points: an explicit percent becomes a share of the bar.
  const { applyMilestoneShares, milestoneSharePct } = await import("../src/lib/project-progress");
  check("points property reads as a share pct", milestoneSharePct({ points: 30 }) === 30);
  const overlaid = applyMilestoneShares({ done: 0, total: 10, fraction: 0 }, [{ pct: 30, done: true }]);
  check("a done 30% milestone puts the bar at 30% with nothing else done", Math.round((overlaid.fraction ?? 0) * 100) === 30);
  const alone = applyMilestoneShares({ done: 0, total: 0, fraction: null }, [{ pct: 30, done: true }, { pct: 30, done: false }]);
  check("shares alone rescale to the whole bar", Math.round((alone.fraction ?? 0) * 100) === 50);
}

console.log("\n# Next Action pin + auto-advance");
{
  const project = await make("project", "PJ5 next-action project");
  const t1 = await make("task", "PJ5 first task");
  const t2 = await make("task", "PJ5 second task");
  await setHome(ownerId, t1.id, project.id, "project");
  await setHome(ownerId, t2.id, project.id, "project");
  await updateItem(ownerId, project.id, { nextActionTaskId: t1.id });

  await toggleItemDone(ownerId, t1.id); // complete the pinned task
  // The completion stamp widened to tasks (ADR-197) — the project markdown
  // document reports when each task finished.
  const t1Fresh = await getItem(ownerId, t1.id);
  check(
    "completing a task stamps properties.completed_at (ADR-197)",
    typeof (t1Fresh.properties as Record<string, unknown> | null)?.completed_at === "string"
  );
  let p = await getItem(ownerId, project.id);
  check("completing the pinned task auto-advances to the next open task", p.nextActionTaskId === t2.id, String(p.nextActionTaskId));

  await toggleItemDone(ownerId, t2.id); // complete the last open task
  p = await getItem(ownerId, project.id);
  check("completing the last open task clears Next Action", p.nextActionTaskId === null, String(p.nextActionTaskId));

  // A non-pinned task completing must not touch the pin.
  const t3 = await make("task", "PJ5 third task");
  const t4 = await make("task", "PJ5 fourth task");
  await setHome(ownerId, t3.id, project.id, "project");
  await setHome(ownerId, t4.id, project.id, "project");
  await updateItem(ownerId, project.id, { nextActionTaskId: t3.id });
  await toggleItemDone(ownerId, t4.id); // complete a DIFFERENT task
  p = await getItem(ownerId, project.id);
  check("completing a non-pinned task leaves the pin alone", p.nextActionTaskId === t3.id, String(p.nextActionTaskId));
}

console.log("\n# milestones fan-out on a project");
{
  const project = await make("project", "PJ5 milestone project");
  const ms = await make("milestone", "Launch", { dueDate: new Date("2026-08-01T00:00:00.000Z") });
  await setHome(ownerId, ms.id, project.id, "contains");
  const fresh = await getItem(ownerId, project.id);
  const projectType = await getType("project");
  const { composition } = resolveComposition(fresh.composition, projectType.defaultWidgets, "project");
  const data = await resolveRecordWidgets(ownerId, fresh, composition);
  const milestones = data.find((d) => d.def.id === "milestones");
  check("the Milestones widget surfaces the contained milestone", milestones?.items?.some((i) => i.id === ms.id) ?? false);
}

await db.delete(activityEvents).where(inArray(activityEvents.subjectId, created));
for (const id of created) await db.delete(items).where(eq(items.id, id));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
