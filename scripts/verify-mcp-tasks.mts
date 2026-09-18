// ADR-180 verification: the MCP surface can do SUBTASKS and RECURRING TASKS.
// Drives the real dispatcher (callTool) rather than the handlers directly, so
// arg parsing, ItemError→isError, and the response shape are all in the path —
// what a Claude client actually gets. Live Neon under throwaway owners; cleans
// up in finally.
//
// Covers: parentId on create/update (re-parent, lift, cycle guard), add_subtasks
// (mixed shapes, order, all-or-nothing validation), list_subtasks (nesting +
// "n of m done" rollup over task children only), set_recurrence (natural
// language, structured parts, partial edit, log preservation vs resetLog,
// clear, scheduled-date seeding), update_occurrence (idempotent complete/
// uncomplete, carve, non-occurrence + materialized rejections), get_item's
// recurrence block (and its ABSENCE on a plain task), completing a series
// through update_item, and owner scoping on every new tool.
// Run: npx tsx scripts/verify-mcp-tasks.mts
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
const { items, users } = await import("../src/db/schema");
const { callTool, listToolDefs } = await import("../src/lib/mcp/tools");
const { INSTRUCTIONS } = await import("../src/lib/mcp/server");
const { getItem } = await import("../src/lib/items");
const { createItem } = await import("../src/lib/item-mutations");
const { makeRecurrence, dateToYmdUtc } = await import("../src/lib/recurrence");
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
const [owner] = await db
  .insert(users)
  .values({ email: `verify-mcp-tasks-${stamp}@example.invalid` })
  .returning({ id: users.id });
const [other] = await db
  .insert(users)
  .values({ email: `verify-mcp-tasks-other-${stamp}@example.invalid` })
  .returning({ id: users.id });

// Call a tool the way a client does; throw if it came back as an error result.
async function call(ownerId: string, name: string, args: Record<string, unknown>) {
  const res = await callTool(ownerId, name, args);
  if (res.isError) throw new Error(`${name}: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text) as Record<string, any>;
}
// Call expecting a clean isError result; returns the message.
async function callErr(ownerId: string, name: string, args: Record<string, unknown>) {
  const res = await callTool(ownerId, name, args);
  if (!res.isError) throw new Error(`${name}: expected an error, got ${res.content[0]?.text}`);
  return res.content[0].text;
}
function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

try {
  console.log("\n# Registration + discoverability");
  {
    const defs = await listToolDefs(owner.id);
    const names = defs.map((d) => d.name);
    for (const n of ["list_subtasks", "add_subtasks", "set_recurrence", "update_occurrence"]) {
      check(`tools/list advertises ${n}`, names.includes(n));
    }
    const create = defs.find((d) => d.name === "create_item")!;
    const update = defs.find((d) => d.name === "update_item")!;
    const cProps = create.inputSchema.properties as Record<string, unknown>;
    const uProps = update.inputSchema.properties as Record<string, unknown>;
    check("create_item exposes parentId", "parentId" in cProps);
    check("create_item exposes scheduledDate", "scheduledDate" in cProps);
    check("update_item exposes parentId", "parentId" in uProps);
    check("update_item exposes scheduledDate", "scheduledDate" in uProps);
    check("connect instructions mention subtasks", /add_subtasks|list_subtasks/.test(INSTRUCTIONS));
    check("connect instructions mention recurrence", /set_recurrence/.test(INSTRUCTIONS));
  }

  console.log("\n# Subtasks: create under a parent, nest, roll up");
  let parentId = "";
  {
    const parent = await call(owner.id, "create_item", { type: "task", title: "Plan the retreat" });
    parentId = parent.id;

    // create_item + parentId is the single-child path.
    const one = await call(owner.id, "create_item", {
      type: "task",
      title: "Book the venue",
      parentId,
      dueDate: "2026-09-01",
    });
    eq("create_item parentId files the child under the parent", one.parentId, parentId);

    // add_subtasks is the batch path: mixed strings and objects, order kept.
    const added = await call(owner.id, "add_subtasks", {
      parentId,
      subtasks: [
        "Set the theme",
        { title: "Line up speakers", urgency: 2, scheduledDate: "2026-08-20" },
        { title: "Notes from last year", type: "note", bodyMarkdown: "# Lessons\n\n- Start earlier" },
      ],
    });
    eq("add_subtasks created all three", added.count, 3);
    eq(
      "add_subtasks preserved order",
      added.created.map((c: any) => c.title),
      ["Set the theme", "Line up speakers", "Notes from last year"]
    );
    eq("add_subtasks default type is task", added.created[0].type, "task");
    eq("add_subtasks honors a per-entry type", added.created[2].type, "note");
    eq("add_subtasks honors a per-entry urgency", added.created[1].urgency, 2);
    check(
      "add_subtasks child carries its markdown body",
      (await getItem(owner.id, added.created[2].id)).body != null
    );
    // The rollup counts task children only — the note is context, not a step.
    eq("progress counts task children only (0 of 3)", added.progress, { done: 0, total: 3 });

    // A nested grandchild, so the tree is more than one level deep.
    const grandkid = await call(owner.id, "add_subtasks", {
      parentId: added.created[1].id,
      subtasks: ["Email Roger"],
    });

    // Complete one child; the rollup moves.
    await call(owner.id, "update_item", { id: one.id, status: "done" });
    const tree = await call(owner.id, "list_subtasks", { id: parentId });
    eq("list_subtasks progress after one done (1 of 3)", tree.progress, { done: 1, total: 3 });
    eq("list_subtasks returns the four direct children", tree.count, 4);
    const speakers = tree.subtasks.find((s: any) => s.title === "Line up speakers");
    eq("list_subtasks nests the grandchild", speakers.children?.[0]?.id, grandkid.created[0].id);
    eq("a node with task children carries its own rollup", speakers.progress, { done: 0, total: 1 });
    check("list_subtasks omits bodies", !("body" in tree.subtasks[0]));
  }

  console.log("\n# Subtasks: all-or-nothing validation, re-parent, cycle guard");
  {
    const p = await call(owner.id, "create_item", { type: "task", title: "Batch guard" });
    const msg = await callErr(owner.id, "add_subtasks", {
      parentId: p.id,
      subtasks: ["Fine", { title: "" }],
    });
    check("add_subtasks rejects an empty title", /title is required/.test(msg), msg);
    const after = await call(owner.id, "list_subtasks", { id: p.id });
    eq("a rejected batch created NOTHING (no half checklist)", after.count, 0);

    const badType = await callErr(owner.id, "add_subtasks", {
      parentId: p.id,
      subtasks: [{ title: "Nope", type: "not_a_type" }],
    });
    check("add_subtasks rejects an unknown type", /unknown type/.test(badType), badType);
    eq("the unknown-type batch created nothing either", (await call(owner.id, "list_subtasks", { id: p.id })).count, 0);

    // Re-parent an existing item, then lift it back to the top level.
    const loose = await call(owner.id, "create_item", { type: "task", title: "Adopt me" });
    const moved = await call(owner.id, "update_item", { id: loose.id, parentId: p.id });
    eq("update_item parentId re-parents", moved.parentId, p.id);
    const lifted = await call(owner.id, "update_item", { id: loose.id, parentId: null });
    eq("update_item parentId:null lifts to the top level", lifted.parentId, null);

    // The cycle guard the app already enforces, now reachable from MCP.
    await call(owner.id, "update_item", { id: loose.id, parentId: p.id });
    const selfMsg = await callErr(owner.id, "update_item", { id: p.id, parentId: p.id });
    check("an item cannot be its own parent", selfMsg.length > 0, selfMsg);
    const cycleMsg = await callErr(owner.id, "update_item", { id: p.id, parentId: loose.id });
    check("an item cannot be parented under its own descendant", cycleMsg.length > 0, cycleMsg);
  }

  console.log("\n# Recurrence: natural language");
  {
    const cases: [string, string, string][] = [
      ["every day", "FREQ=DAILY", "Daily"],
      ["every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Weekly on Mon, Tue, Wed, Thu, Fri"],
      ["every other tuesday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "Every 2 weeks on Tue"],
      ["every 3 weeks", "FREQ=WEEKLY;INTERVAL=3", "Every 3 weeks"],
      ["the 3rd of the month", "FREQ=MONTHLY;BYMONTHDAY=3", "Monthly on the 3rd"],
      // The phrasing a model reaches for, normalized into the one nl-date knows
      // (without it this silently degrades to a plain FREQ=MONTHLY).
      ["monthly on the 3rd", "FREQ=MONTHLY;BYMONTHDAY=3", "Monthly on the 3rd"],
      ["monthly on the first thursday", "FREQ=MONTHLY;BYDAY=1TH", "Monthly on the first Thursday"],
      ["last of the month", "FREQ=MONTHLY;BYMONTHDAY=-1", "Monthly on the last day"],
      ["first and third thursday", "FREQ=MONTHLY;BYDAY=1TH,3TH", "Monthly on the first & third Thursday"],
      ["yearly", "FREQ=YEARLY", "Yearly"],
    ];
    for (const [phrase, wantRrule, wantDescribe] of cases) {
      const t = await call(owner.id, "create_item", {
        type: "task",
        title: `Repeat: ${phrase}`,
        scheduledDate: "2026-09-01",
      });
      const res = await call(owner.id, "set_recurrence", { id: t.id, repeat: phrase });
      eq(`"${phrase}" → ${wantRrule}`, res.recurrence.rrule, wantRrule);
      eq(`"${phrase}" describes as "${wantDescribe}"`, res.recurrence.describe, wantDescribe);
      eq(`"${phrase}" anchors on the task's planned date`, res.recurrence.dtstart, "2026-09-01");
    }

    const junk = await call(owner.id, "create_item", { type: "task", title: "Junk phrase" });
    const msg = await callErr(owner.id, "set_recurrence", { id: junk.id, repeat: "whenever I feel like it" });
    check("an unreadable phrase errors with examples", /every other tuesday/.test(msg), msg);
    check("the failed set left the task non-recurring", !("recurrence" in (await call(owner.id, "get_item", { id: junk.id }))));
  }

  console.log("\n# Recurrence: structured parts, bounds, anchor, seeding");
  {
    const t = await call(owner.id, "create_item", { type: "task", title: "Structured" });
    const res = await call(owner.id, "set_recurrence", {
      id: t.id,
      freq: "weekly",
      interval: 2,
      byDay: ["mo", "TH"],
      dtstart: "2026-09-07",
      until: "2026-12-31",
    });
    eq("structured parts build the rule", res.recurrence.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231");
    eq("no planned date yet ⇒ scheduled seeded to the first occurrence", dateToYmdUtc(new Date(res.scheduledDate)), "2026-09-07");
    eq("the projection honors interval + byday", res.recurrence.nextOccurrences.slice(0, 4), [
      "2026-09-07",
      "2026-09-10",
      "2026-09-21",
      "2026-09-24",
    ]);

    const both = await callErr(owner.id, "set_recurrence", { id: t.id, freq: "daily", count: 5, until: "2026-10-01" });
    check("count and until together are rejected", /not both/.test(both), both);

    const ord = await call(owner.id, "create_item", { type: "task", title: "Ordinal", scheduledDate: "2026-09-01" });
    const ordRes = await call(owner.id, "set_recurrence", {
      id: ord.id,
      freq: "monthly",
      byDayOrdinal: ["-1FR"],
    });
    eq("byDayOrdinal accepts the RRULE spelling", ordRes.recurrence.rrule, "FREQ=MONTHLY;BYDAY=-1FR");
    const ordObj = await call(owner.id, "set_recurrence", {
      id: ord.id,
      freq: "monthly",
      byDayOrdinal: [{ ordinal: 2, weekday: "we" }],
    });
    eq("byDayOrdinal accepts the object form", ordObj.recurrence.rrule, "FREQ=MONTHLY;BYDAY=2WE");
    const badOrd = await callErr(owner.id, "set_recurrence", { id: ord.id, freq: "monthly", byDayOrdinal: ["9ZZ"] });
    check("a malformed ordinal is rejected", /1SU/.test(badOrd), badOrd);

    const comp = await call(owner.id, "create_item", { type: "task", title: "Completion anchored", scheduledDate: "2026-09-01" });
    const compRes = await call(owner.id, "set_recurrence", { id: comp.id, repeat: "every 3 days", anchorMode: "completion" });
    eq("anchorMode carries through", compRes.recurrence.anchorMode, "completion");
    check("describe says so", /after completion/.test(compRes.recurrence.describe), compRes.recurrence.describe);
  }

  console.log("\n# Recurrence: partial edit keeps the rule and the log; clear");
  {
    const t = await createItem(owner.id, {
      type: "task",
      title: "Live series",
      scheduledDate: ymdToUtc("2026-09-08"),
      properties: {
        recurrence: {
          ...makeRecurrence({ freq: "weekly", byDay: ["TU"], dtstart: "2026-09-01" }),
          completeInstances: ["2026-09-01"],
        },
      },
    });

    // Only `until` passed: the weekly/BYDAY rule carries through untouched.
    const bounded = await call(owner.id, "set_recurrence", { id: t.id, until: "2026-11-30" });
    eq("a partial edit keeps freq + byDay", bounded.recurrence.rrule, "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261130");
    eq("a partial edit KEEPS the completion log", bounded.recurrence.completeInstances, ["2026-09-01"]);

    const widened = await call(owner.id, "set_recurrence", { id: t.id, interval: 2 });
    eq("editing interval keeps byDay and the bound", widened.recurrence.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261130");

    const wiped = await call(owner.id, "set_recurrence", { id: t.id, repeat: "every wednesday", resetLog: true });
    eq("resetLog:true starts a fresh log", wiped.recurrence.completeInstances, []);
    eq("resetLog:true still applies the new rule", wiped.recurrence.rrule, "FREQ=WEEKLY;BYDAY=WE");

    const cleared = await call(owner.id, "set_recurrence", { id: t.id, clear: true });
    eq("clear:true reports the change", cleared.changed, true);
    check("clear:true removes the rule", !("recurrence" in cleared), JSON.stringify(cleared.recurrence ?? null));
    const reread = await call(owner.id, "get_item", { id: t.id });
    check("the cleared task reads back as non-recurring", !("recurrence" in reread));
    const again = await call(owner.id, "set_recurrence", { id: t.id, clear: true });
    eq("clear on a non-recurring task is a no-op, not an error", again.changed, false);

    const noRule = await callErr(owner.id, "set_recurrence", { id: t.id, interval: 4 });
    check("a partial edit with no rule to edit errors helpfully", /does not repeat yet/.test(noRule), noRule);
  }

  console.log("\n# get_item: the recurrence block (and its absence)");
  {
    const plain = await call(owner.id, "create_item", { type: "task", title: "Plain task" });
    const plainRead = await call(owner.id, "get_item", { id: plain.id });
    check("a non-recurring item has NO recurrence key (shape unchanged)", !("recurrence" in plainRead));

    const rec = await call(owner.id, "create_item", { type: "task", title: "Weekly review", scheduledDate: "2026-09-04" });
    await call(owner.id, "set_recurrence", { id: rec.id, repeat: "every friday", count: 4 });
    const read = await call(owner.id, "get_item", { id: rec.id });
    eq("get_item describes the rule", read.recurrence.describe, "Weekly on Fri, 4×");
    eq("get_item projects the bounded series", read.recurrence.nextOccurrences, [
      "2026-09-04",
      "2026-09-11",
      "2026-09-18",
      "2026-09-25",
    ]);
    eq("get_item reports the next uncompleted date", read.recurrence.nextUncompleted, "2026-09-04");
    eq("get_item reports the mode", read.recurrence.occurrenceMode, "virtual");
  }

  console.log("\n# Occurrences: complete / uncomplete / carve");
  {
    const t = await call(owner.id, "create_item", { type: "task", title: "Trash to the curb", scheduledDate: "2026-09-01" });
    await call(owner.id, "set_recurrence", { id: t.id, repeat: "every tuesday" });

    const done = await call(owner.id, "update_occurrence", { id: t.id, date: "2026-09-08", action: "complete" });
    eq("complete stamps that date", done.series.recurrence.completeInstances, ["2026-09-08"]);
    eq("complete reports a change", done.changed, true);
    const twice = await call(owner.id, "update_occurrence", { id: t.id, date: "2026-09-08", action: "complete" });
    eq("complete is IDEMPOTENT (not a toggle)", twice.changed, false);
    eq("the double complete left one stamp", twice.series.recurrence.completeInstances, ["2026-09-08"]);

    const undone = await call(owner.id, "update_occurrence", { id: t.id, date: "2026-09-08", action: "uncomplete" });
    eq("uncomplete removes the stamp", undone.series.recurrence.completeInstances, []);
    const undoneTwice = await call(owner.id, "update_occurrence", { id: t.id, date: "2026-09-08", action: "uncomplete" });
    eq("uncomplete is idempotent too", undoneTwice.changed, false);

    const off = await callErr(owner.id, "update_occurrence", { id: t.id, date: "2026-09-09", action: "complete" });
    check("a date the rule doesn't fire on is rejected", /not an occurrence/.test(off), off);
    const badDate = await callErr(owner.id, "update_occurrence", { id: t.id, date: "next tuesday", action: "complete" });
    check("a non-YYYY-MM-DD date is rejected", /YYYY-MM-DD/.test(badDate), badDate);

    // Carve: that one week becomes its own editable item; the series skips it.
    const carved = await call(owner.id, "update_occurrence", { id: t.id, date: "2026-09-15", action: "carve" });
    check("carve returns a new item id", typeof carved.carvedItemId === "string");
    const clone = await getItem(owner.id, carved.carvedItemId);
    eq("the carved item is planned on that date", dateToYmdUtc(clone.scheduledDate!), "2026-09-15");
    check(
      "the carved item does NOT itself recur",
      (clone.properties as Record<string, unknown>)?.recurrence == null
    );
    eq("the series skips the carved date", carved.series.recurrence.skippedInstances, ["2026-09-15"]);
    check(
      "the series projection still holds the other Tuesdays",
      carved.series.recurrence.nextOccurrences.includes("2026-09-22")
    );

    const plain = await call(owner.id, "create_item", { type: "task", title: "Not recurring" });
    const notRec = await callErr(owner.id, "update_occurrence", { id: plain.id, date: "2026-09-01", action: "complete" });
    check("update_occurrence on a plain task points at set_recurrence", /set_recurrence/.test(notRec), notRec);

    const mat = await call(owner.id, "create_item", { type: "task", title: "Materialized", scheduledDate: "2026-09-01" });
    await call(owner.id, "set_recurrence", { id: mat.id, repeat: "every monday", occurrenceMode: "materialized" });
    const matMsg = await callErr(owner.id, "update_occurrence", { id: mat.id, date: "2026-09-07", action: "complete" });
    check("a materialized series is redirected to its occurrence item", /materializes/.test(matMsg), matMsg);
  }

  console.log("\n# Completing the CURRENT occurrence through update_item");
  {
    const t = await call(owner.id, "create_item", { type: "task", title: "Water the plants", scheduledDate: "2026-09-02" });
    await call(owner.id, "set_recurrence", { id: t.id, repeat: "every wednesday" });
    const after = await call(owner.id, "update_item", { id: t.id, status: "done" });
    eq("the series advanced to the next Wednesday", dateToYmdUtc(new Date(after.scheduledDate)), "2026-09-09");
    const read = await call(owner.id, "get_item", { id: t.id });
    eq("the completed date is logged", read.recurrence.completeInstances, ["2026-09-02"]);
    check("the series did not close", read.status !== "done", read.status);
  }

  console.log("\n# Owner scoping");
  {
    const mine = await call(owner.id, "create_item", { type: "task", title: "Mine only", scheduledDate: "2026-09-01" });
    await call(owner.id, "set_recurrence", { id: mine.id, repeat: "every day" });
    await call(owner.id, "add_subtasks", { parentId: mine.id, subtasks: ["a step"] });
    for (const [name, args] of [
      ["list_subtasks", { id: mine.id }],
      ["add_subtasks", { parentId: mine.id, subtasks: ["sneaky"] }],
      ["set_recurrence", { id: mine.id, repeat: "every friday" }],
      ["update_occurrence", { id: mine.id, date: "2026-09-02", action: "complete" }],
    ] as [string, Record<string, unknown>][]) {
      const msg = await callErr(other.id, name, args);
      check(`${name} is owner-scoped`, msg.length > 0, msg);
    }
    const stillMine = await call(owner.id, "get_item", { id: mine.id });
    eq("the other owner changed nothing", stillMine.recurrence.rrule, "FREQ=DAILY");
    eq("and added no children", (await call(owner.id, "list_subtasks", { id: mine.id })).count, 1);
  }
} finally {
  // parent_id is a self-FK with no cascade: detach before deleting.
  for (const o of [owner.id, other.id]) {
    await db.update(items).set({ parentId: null }).where(dEq(items.ownerId, o));
    await db.delete(items).where(dEq(items.ownerId, o));
  }
  await db.delete(users).where(inArray(users.id, [owner.id, other.id]));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
