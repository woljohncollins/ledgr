// ADR-181 verification: the MCP surface can shape a project END TO END — its
// status terms, which sections its page shows (per record AND per type), and what
// lives inside those sections. Drives the real dispatcher (callTool), so arg
// parsing, ItemError→isError and the response shape are all in the path a Claude
// client sees. Live Neon under throwaway owners + a throwaway TYPE; cleans up in
// finally.
//
// Types are instance-global (no owner_id), so every type-level write here targets
// a throwaway type. The real `project` type is only ever READ, and this script
// asserts that its default_widgets is left untouched.
// Run: npx tsx scripts/verify-mcp-records.mts
/* eslint-disable @typescript-eslint/no-explicit-any -- dev-only harness: tool
   results arrive as JSON parsed off the MCP wire, which is exactly the untyped
   boundary being asserted about; this script never ships in the app bundle. */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { items, types, users } = await import("../src/db/schema");
const { callTool, listToolDefs } = await import("../src/lib/mcp/tools");
const { applyLayoutOps } = await import("../src/lib/mcp/tools/records");
const { generatedDefaultComposition, resolveComposition } = await import("../src/lib/composition");
const { getItem } = await import("../src/lib/items");
const { getType, deleteType } = await import("../src/lib/types");
const { queryViewItems } = await import("../src/lib/views");
const { eq: dEq, inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${String(detail)}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

const db = getDb();
const stamp = Date.now();
const TYPE_KEY = `vrec_${String(stamp).slice(-8)}`;
const [owner] = await db
  .insert(users)
  .values({ email: `verify-mcp-records-${stamp}@example.invalid` })
  .returning({ id: users.id });
const [other] = await db
  .insert(users)
  .values({ email: `verify-mcp-records-other-${stamp}@example.invalid` })
  .returning({ id: users.id });

async function call(ownerId: string, name: string, args: Record<string, unknown>) {
  const res = await callTool(ownerId, name, args);
  if (res.isError) throw new Error(`${name}: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text) as Record<string, any>;
}
async function callErr(ownerId: string, name: string, args: Record<string, unknown>) {
  const res = await callTool(ownerId, name, args);
  if (!res.isError) throw new Error(`${name}: expected an error, got ${res.content[0]?.text}`);
  return res.content[0].text;
}
const ids = (list: any[]) => list.map((s) => s.id);
// Statuses are keyed by `key` (the opaque stable id items store), sections by `id`.
const keys = (list: any[]) => list.map((s) => s.key);

// The real project type's Layer 2, captured so the teardown can prove this script
// never wrote to it.
const projectDefaultBefore = JSON.stringify((await getType("project")).defaultWidgets ?? null);

try {
  console.log("\n# Registration");
  {
    const names = (await listToolDefs(owner.id)).map((d) => d.name);
    for (const n of ["get_record_layout", "set_record_layout", "set_type_layout", "add_to_record", "set_type_statuses"]) {
      check(`tools/list advertises ${n}`, names.includes(n));
    }
  }

  console.log("\n# Pure layout algebra (no DB)");
  {
    const base = generatedDefaultComposition("project");
    eq(
      "the project starting set is the header strip + four cards",
      base.widgets.map((w) => w.defId),
      ["status", "people", "progress", "tasks", "milestones", "notes", "meetings"]
    );

    const hidden = applyLayoutOps(base, { hide: ["meetings"] });
    check("hide marks hidden, does not remove the instance", hidden.widgets.some((w) => w.defId === "meetings" && w.hidden));
    eq("hide keeps the instance count", hidden.widgets.length, base.widgets.length);

    const reshown = applyLayoutOps(hidden, { show: ["meetings"] });
    check("show clears hidden rather than appending a duplicate", reshown.widgets.filter((w) => w.defId === "meetings").length === 1);
    check("re-shown section is visible again", !reshown.widgets.find((w) => w.defId === "meetings")?.hidden);

    const added = applyLayoutOps(base, { show: ["timeline"] });
    eq("a brand-new section appends to the end", added.widgets[added.widgets.length - 1].defId, "timeline");

    const ordered = applyLayoutOps(base, { order: ["notes", "tasks"] });
    eq("a partial order pulls those to the front, rest keep relative order", ordered.widgets.map((w) => w.defId), [
      "notes", "tasks", "status", "people", "progress", "milestones", "meetings",
    ]);

    const opted = applyLayoutOps(base, { options: { tasks: { limit: 10 } } });
    eq("options merge onto the instance", opted.widgets.find((w) => w.defId === "tasks")?.options, { limit: 10 });
    const opted2 = applyLayoutOps(opted, { options: { tasks: { limit: 3 } } });
    eq("a later options write overrides the earlier value", opted2.widgets.find((w) => w.defId === "tasks")?.options, { limit: 3 });
    const optAbsent = applyLayoutOps(base, { options: { timeline: { } } });
    check("options on an absent section adds it", optAbsent.widgets.some((w) => w.defId === "timeline"));
  }

  console.log("\n# Status terms via MCP (the shaping half of the Build panel)");
  {
    await call(owner.id, "create_type", { key: TYPE_KEY, label: "Verify Record" });

    const set = await call(owner.id, "set_type_statuses", {
      key: TYPE_KEY,
      statuses: [
        { label: "Ongoing", category: "in_progress", isDefault: true },
        { label: "Waiting for Others", category: "not_started" },
        { label: "Paused", category: "not_started", isDefault: true },
        { label: "Shipped", category: "done", isDefault: true },
      ],
    });
    eq("passing statuses implies select mode", set.statusMode, "select");
    eq("keys are derived from labels", keys(set.statuses), ["ongoing", "waiting_for_others", "paused", "shipped"]);
    eq("labels are stored verbatim", set.statuses.map((s: any) => s.label), ["Ongoing", "Waiting for Others", "Paused", "Shipped"]);
    eq("order is preserved", set.statuses.map((s: any) => s.category), ["in_progress", "not_started", "not_started", "done"]);

    // list_types is how a model discovers the terms it may then use.
    const listed = (await call(owner.id, "list_types", {})).types.find((t: any) => t.key === TYPE_KEY);
    eq("list_types reports the mode", listed.statusMode, "select");
    eq("list_types reports the terms", keys(listed.statuses), ["ongoing", "waiting_for_others", "paused", "shipped"]);
    eq("list_types flags them as custom", listed.statusesAreCustom, true);

    // An item on a custom status gets the right category.
    const rec = await call(owner.id, "create_item", { type: TYPE_KEY, title: "A record", status: "waiting_for_others" });
    eq("an item can be created on a custom status", rec.status, "waiting_for_others");

    // RENAME by resending the existing key: the item must stay put.
    const renamed = await call(owner.id, "set_type_statuses", {
      key: TYPE_KEY,
      statuses: [
        { key: "ongoing", label: "Active", category: "in_progress", isDefault: true },
        { key: "waiting_for_others", label: "Blocked", category: "not_started" },
        { key: "paused", label: "Paused", category: "not_started", isDefault: true },
        { key: "shipped", label: "Done", category: "done", isDefault: true },
      ],
    });
    eq("renaming keeps the keys", keys(renamed.statuses), ["ongoing", "waiting_for_others", "paused", "shipped"]);
    eq("renaming changes the labels", renamed.statuses.map((s: any) => s.label), ["Active", "Blocked", "Paused", "Done"]);
    const afterRename = await getItem(owner.id, rec.id);
    eq("the item did NOT move when its term was renamed", afterRename.status, "waiting_for_others");
    eq("and kept its category", afterRename.statusCategory, "not_started");

    // DROPPING a term the item is on: it falls back to the category default.
    await call(owner.id, "set_type_statuses", {
      key: TYPE_KEY,
      statuses: [
        { key: "ongoing", label: "Active", category: "in_progress", isDefault: true },
        { key: "shipped", label: "Done", category: "done", isDefault: true },
      ],
    });
    const orphan = await getItem(owner.id, rec.id);
    eq("an item on a dropped term re-buckets to not_started", orphan.statusCategory, "not_started");

    // Validation the model must not be able to slip past.
    const noDone = await callErr(owner.id, "set_type_statuses", {
      key: TYPE_KEY,
      statuses: [{ label: "Only", category: "in_progress" }],
    });
    check("a schema with no Done term is rejected", /Done/i.test(noDone), noDone);
    const badCat = await callErr(owner.id, "set_type_statuses", {
      key: TYPE_KEY,
      statuses: [{ label: "Nope", category: "someday" }],
    });
    check("an unknown category is rejected with the four listed", /not_started/.test(badCat), badCat);
    const nothing = await callErr(owner.id, "set_type_statuses", { key: TYPE_KEY });
    check("no statuses / mode / inherit is rejected", /statuses/.test(nothing), nothing);

    // Mode-only change keeps the terms (defer-by-hiding).
    const box = await call(owner.id, "set_type_statuses", { key: TYPE_KEY, mode: "checkbox" });
    eq("mode-only change switches the mode", box.statusMode, "checkbox");
    check("and says the terms are kept", /kept/.test(box.note ?? ""), box.note);
    const backToSelect = await call(owner.id, "set_type_statuses", { key: TYPE_KEY, mode: "select" });
    // The terms must come back INTACT. Keys are ongoing/shipped (set from the
    // original labels) while the labels are Active/Done (renamed in place) —
    // exactly the key-vs-label split the rename assertions above establish.
    eq("switching back restores the stored terms", keys(backToSelect.statuses ?? []), ["ongoing", "shipped"]);
    eq("…with their renamed labels", (backToSelect.statuses ?? []).map((s: any) => s.label), ["Active", "Done"]);
    const reread = (await call(owner.id, "list_types", {})).types.find((t: any) => t.key === TYPE_KEY);
    eq("…verified via list_types: the custom terms survived the round trip", keys(reread.statuses), ["ongoing", "shipped"]);
    eq("…and list_types agrees on the labels", reread.statuses.map((s: any) => s.label), ["Active", "Done"]);

    const inherited = await call(owner.id, "set_type_statuses", { key: TYPE_KEY, inherit: true });
    eq("inherit:true drops back to the system default", keys(inherited.statuses), ["open", "done", "archived"]);
    eq("inherit reports itself", inherited.inherited, true);
  }

  console.log("\n# Record layout (Layer 3) — one record's sections");
  let recordId = "";
  {
    const rec = await call(owner.id, "create_item", { type: TYPE_KEY, title: "Layout subject" });
    recordId = rec.id;

    const initial = await call(owner.id, "get_record_layout", { id: recordId });
    eq("a fresh record inherits the generated set", initial.source, "generated");
    eq("the generic starting set is Overview + Status", ids(initial.sections), ["overview", "status"]);
    check("addable lists what's not on the page", initial.addable.some((a: any) => a.id === "tasks"));
    check("sections carry human labels", initial.sections[0].label === "Overview", initial.sections[0].label);

    const shown = await call(owner.id, "set_record_layout", {
      id: recordId,
      show: ["tasks", "notes"],
      options: { tasks: { limit: 10 } },
    });
    eq("showing sections writes the record's own layout", shown.source, "record");
    eq("the shown sections are on the page", ids(shown.sections), ["overview", "status", "tasks", "notes"]);
    eq("the option landed", shown.sections.find((s: any) => s.id === "tasks").options, { limit: 10 });

    const ordered = await call(owner.id, "set_record_layout", { id: recordId, order: ["tasks"] });
    eq("order pulls a section to the front", ids(ordered.sections)[0], "tasks");

    const hidden = await call(owner.id, "set_record_layout", { id: recordId, hide: ["notes"] });
    check("hidden sections leave the page", !ids(hidden.sections).includes("notes"));
    check("…and are reported as hidden, not gone", ids(hidden.hidden).includes("notes"));

    const reset = await call(owner.id, "set_record_layout", { id: recordId, reset: true });
    eq("reset:true drops back to inheriting", reset.source, "generated");
    eq("reset restores the inherited sections", ids(reset.sections), ["overview", "status"]);

    const badSection = await callErr(owner.id, "set_record_layout", { id: recordId, show: ["kanban"] });
    check("an unknown section is rejected and the valid ones listed", /valid sections are/.test(badSection), badSection);
    const badOpt = await callErr(owner.id, "set_record_layout", { id: recordId, options: { tasks: { nope: 1 } } });
    check("an unknown option is rejected", /no option/.test(badOpt), badOpt);
    const badLimit = await callErr(owner.id, "set_record_layout", { id: recordId, options: { tasks: { limit: 900 } } });
    check("an out-of-range limit is rejected", /1–50/.test(badLimit), badLimit);
    const badChoice = await callErr(owner.id, "set_record_layout", { id: recordId, options: { progress: { weighting: "sideways" } } });
    check("a bad select choice is rejected with the choices", /hierarchical/.test(badChoice), badChoice);
    const noOps = await callErr(owner.id, "set_record_layout", { id: recordId });
    check("a no-op call is rejected rather than silently doing nothing", /at least one of/.test(noOps), noOps);
  }

  console.log("\n# Type layout (Layer 2) — every record of the type");
  {
    // The type default had NO writer anywhere in the app before this slice.
    eq("the throwaway type starts with no Layer 2", (await getType(TYPE_KEY)).defaultWidgets, null);

    const typeSet = await call(owner.id, "set_type_layout", {
      typeKey: TYPE_KEY,
      show: ["tasks", "milestones"],
      hide: ["overview"],
      order: ["tasks", "milestones", "status"],
    });
    eq("the type default is written", typeSet.source, "type");
    eq("its sections are the ones asked for, in order", ids(typeSet.sections), ["tasks", "milestones", "status"]);
    check("the hidden one is off the page", !ids(typeSet.sections).includes("overview"));

    // A record with NO layout of its own now follows the type.
    const follower = await call(owner.id, "create_item", { type: TYPE_KEY, title: "Follows the type" });
    const followerLayout = await call(owner.id, "get_record_layout", { id: follower.id });
    eq("a record with no layout of its own reads 'type'", followerLayout.source, "type");
    eq("…and shows the type's sections", ids(followerLayout.sections), ["tasks", "milestones", "status"]);

    // A record that HAS its own layout is untouched — a record diverges from its
    // type, it never defines it.
    await call(owner.id, "set_record_layout", { id: recordId, show: ["meetings"] });
    const diverged = await call(owner.id, "get_record_layout", { id: recordId });
    eq("a diverged record keeps its own layout", diverged.source, "record");
    check("…carrying its own addition", ids(diverged.sections).includes("meetings"));
    // Diverging SNAPSHOTS the effective layout (set_record_layout bases on what
    // the record currently shows, not on an empty set), so a record that diverges
    // after the type hid Overview inherits that hide rather than resurrecting it.
    check("…and the type's hide it inherited at the moment it diverged", !ids(diverged.sections).includes("overview"));

    const typeReset = await call(owner.id, "set_type_layout", { typeKey: TYPE_KEY, reset: true });
    eq("reset clears the type default", typeReset.reset, true);
    eq("the type default is null again", (await getType(TYPE_KEY)).defaultWidgets, null);
    const followerAfter = await call(owner.id, "get_record_layout", { id: follower.id });
    eq("its followers fall back to the generated set", followerAfter.source, "generated");

    const badType = await callErr(owner.id, "set_type_layout", { typeKey: "no_such_type", show: ["tasks"] });
    check("an unknown type is rejected", badType.length > 0, badType);
  }

  console.log("\n# add_to_record — what lives in the sections");
  {
    const project = await call(owner.id, "create_item", { type: "project", title: `Verify project ${stamp}` });

    const layout = await call(owner.id, "get_record_layout", { id: project.id });
    eq("a real project's generated page has the four cards", ids(layout.sections), [
      "status", "people", "progress", "tasks", "milestones", "notes", "meetings",
    ]);

    const added = await call(owner.id, "add_to_record", {
      recordId: project.id,
      type: "task",
      titles: ["Draft the brief", "Book the room", "Send invites"],
    });
    eq("several tasks are created in one call", added.count, 3);
    eq("…in order", added.created.map((c: any) => c.title), ["Draft the brief", "Book the room", "Send invites"]);

    // The real assertion: they show up in the project's Tasks card. That card's
    // query is `type=task AND related to this record`, so this proves the edge
    // the tool wrote is the one the UI reads.
    const inCard = await queryViewItems(owner.id, { type: "task", relatedTo: project.id }, { field: "createdAt", dir: "asc" }, 50);
    eq("all three appear in the project's Tasks card query", inCard.length, 3);

    const note = await call(owner.id, "add_to_record", {
      recordId: project.id,
      type: "note",
      title: "Kickoff notes",
      bodyMarkdown: "# Kickoff\n\n- Scope agreed",
    });
    eq("a note is filed too", note.count, 1);
    const notesInCard = await queryViewItems(owner.id, { type: "note", relatedTo: project.id }, { field: "createdAt", dir: "asc" }, 50);
    eq("and shows in the Notes card query", notesInCard.length, 1);

    const milestone = await call(owner.id, "add_to_record", {
      recordId: project.id, type: "milestone", title: "Launch", dueDate: "2026-10-01",
    });
    check("a milestone carries its date", milestone.created[0].dueDate != null);

    // Filing an EXISTING item in (the "move it into the project" gesture).
    const loose = await call(owner.id, "create_item", { type: "task", title: "Was floating" });
    const filed = await call(owner.id, "add_to_record", { recordId: project.id, itemId: loose.id });
    eq("an existing item can be filed in", filed.filed[0].id, loose.id);
    const inCardNow = await queryViewItems(owner.id, { type: "task", relatedTo: project.id }, { field: "createdAt", dir: "asc" }, 50);
    eq("the filed task now shows in the Tasks card too", inCardNow.length, 4);

    // Hiding the section must NOT touch the items behind it.
    await call(owner.id, "set_record_layout", { id: project.id, hide: ["tasks"] });
    const stillThere = await queryViewItems(owner.id, { type: "task", relatedTo: project.id }, { field: "createdAt", dir: "asc" }, 50);
    eq("hiding the Tasks section deletes NOTHING", stillThere.length, 4);
    await call(owner.id, "set_record_layout", { id: project.id, show: ["tasks"] });
    const back = await call(owner.id, "get_record_layout", { id: project.id });
    check("re-showing brings the section back", ids(back.sections).includes("tasks"));

    const self = await callErr(owner.id, "add_to_record", { recordId: project.id, itemId: project.id });
    check("a record can't contain itself", /itself/.test(self), self);
    const badKind = await callErr(owner.id, "add_to_record", { recordId: project.id, type: "person", title: "Nope" });
    check("an uncontainable type is rejected with the allowed list", /task, note, milestone/.test(badKind), badKind);
    const noTitle = await callErr(owner.id, "add_to_record", { recordId: project.id, type: "task" });
    check("a create with no title is rejected", /title/.test(noTitle), noTitle);
    const bodyMany = await callErr(owner.id, "add_to_record", {
      recordId: project.id, type: "task", titles: ["a", "b"], bodyMarkdown: "shared",
    });
    check("a shared body across several creates is rejected", /single create/.test(bodyMany), bodyMany);
  }

  console.log("\n# Owner scoping");
  {
    const mine = await call(owner.id, "create_item", { type: "project", title: `Scoped ${stamp}` });
    await call(owner.id, "add_to_record", { recordId: mine.id, type: "task", title: "mine" });
    for (const [name, args] of [
      ["get_record_layout", { id: mine.id }],
      ["set_record_layout", { id: mine.id, show: ["timeline"] }],
      ["add_to_record", { recordId: mine.id, type: "task", title: "sneaky" }],
    ] as [string, Record<string, unknown>][]) {
      const msg = await callErr(other.id, name, args);
      check(`${name} is owner-scoped`, msg.length > 0, msg);
    }
    const after = await queryViewItems(owner.id, { type: "task", relatedTo: mine.id }, { field: "createdAt", dir: "asc" }, 50);
    eq("the other owner added nothing", after.length, 1);
    const layout = await call(owner.id, "get_record_layout", { id: mine.id });
    eq("…and changed no layout", layout.source, "generated");
  }

  console.log("\n# The real project type was only read");
  {
    const now = JSON.stringify((await getType("project")).defaultWidgets ?? null);
    eq("project.default_widgets is untouched by this script", now, projectDefaultBefore);
    const gen = resolveComposition(null, null, "project");
    eq("…so projects still resolve to the generated starting set", gen.source, "generated");
  }
} finally {
  for (const o of [owner.id, other.id]) {
    await db.update(items).set({ parentId: null }).where(dEq(items.ownerId, o));
    await db.delete(items).where(dEq(items.ownerId, o));
  }
  await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
  // The throwaway type is instance-global, so remove it explicitly.
  await deleteType(TYPE_KEY).catch(async () => {
    await db.delete(types).where(dEq(types.key, TYPE_KEY));
  });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
