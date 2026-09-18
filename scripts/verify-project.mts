// Project type (Tasks redesign) — verifies the seeded type + the task↔project
// relation that powers an event's "tasks for Project X" pull. Live Neon under a
// throwaway owner. Run: npx tsx scripts/verify-project.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { getDb } = await import("../src/db");
const { users } = await import("../src/db/schema");
const { getType } = await import("../src/lib/types");
const { resolveStatusSchema } = await import("../src/lib/status");
const {
  createItem,
  softDeleteItem,
} = await import("../src/lib/item-mutations");
const { relateItems } = await import("../src/lib/relations");
const { queryViewItems } = await import("../src/lib/views");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const stamp = Date.now();
const db = getDb();
const [owner] = await db
  .insert(users)
  .values({ email: `verify-project-${stamp}@example.invalid` })
  .returning({ id: users.id });

{
  // --- the seeded project type ---
  const proj = await getType("project");
  check("project type exists, not is_system", !!proj && proj.isSystem === false);
  const statuses = resolveStatusSchema(proj.statusSchema);
  const keys = statuses.map((s) => s.key);
  check("project statuses = Todoist buckets",
    ["ongoing", "waiting", "paused", "future", "done"].every((k) => keys.includes(k)), keys.join(","));
  const propKeys = (proj.propertySchema ?? []).map((p) => p.key);
  check("project props: repo/liveurl/stack", ["repo", "liveurl", "stack"].every((k) => propKeys.includes(k)), propKeys.join(","));

  // --- the task `project` relation field ---
  const task = await getType("task");
  const projField = (task.propertySchema ?? []).find((p) => p.key === "project");
  check("task has a `project` relation field", !!projField && projField.kind === "relation");
  check("project field targets `project`, single",
    projField?.targetType === "project" && projField?.cardinality === "single",
    `${projField?.targetType}/${projField?.cardinality}`);

  // --- a new project gets the not_started default status ("ongoing") ---
  const p1 = await createItem(owner.id, { type: "project", title: `Proj ${stamp}` });
  check("new project status = ongoing", p1.status === "ongoing", p1.status);

  // --- task↔project edge → the event task-pull path (relatedTo) finds it ---
  const t1 = await createItem(owner.id, { type: "task", title: `Task ${stamp}` });
  await relateItems(owner.id, t1.id, p1.id, "project");
  const pulled = await queryViewItems(owner.id, { type: "task", relatedTo: p1.id }, { field: "updatedAt", dir: "desc" });
  check("event task-pull: relatedTo(project) returns the task", pulled.some((r) => r.id === t1.id), `${pulled.length} found`);

  // cleanup
  await softDeleteItem(owner.id, t1.id);
  await softDeleteItem(owner.id, p1.id);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
