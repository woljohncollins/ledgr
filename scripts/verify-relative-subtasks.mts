// Date anchoring verification (ADR-253, superseding the ADR-085 contract this
// file used to assert). Two halves:
//   1. PURE (relative-subtask.ts) — parse, offsetBetween, applyOffset, describe.
//      These still matter: the offset survives on the TEMPLATE apply path, where
//      a dateless prototype gives anchoring no gap to measure.
//   2. SERVICE (live Neon) — the anchoring rule itself: every unpinned dated
//      child shifts by the parent's delta (offset or not — that is the ADR-085
//      bug this replaces), a pinned child and a pinned deadline stand still, a
//      deadline keeps its gap down the tree, an explicit deadline in the same
//      patch wins, clearing a parent's date is NOT a move (ADR-085 wiped its
//      children here, which lost work), the undo round-trips, and the
//      clone/materialize path still derives from a stored offset.
// Run: npx tsx scripts/verify-relative-subtasks.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { parseRelativeSchedule, relativeOffsetOf, offsetBetween, applyOffset, describeOffset } =
  await import("../src/lib/relative-subtask");
const { dateToYmdUtc } = await import("../src/lib/recurrence");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
function eq<T>(name: string, got: T, want: T) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : `got ${g}, want ${w}`);
}

console.log("\n# Pure");
eq("parse valid", parseRelativeSchedule({ offsetDays: 2 }), { offsetDays: 2 });
check("parse non-integer → null", parseRelativeSchedule({ offsetDays: 2.5 }) === null);
check("parse missing → null", parseRelativeSchedule({}) === null);
check("parse null → null", parseRelativeSchedule(null) === null);
eq("relativeOffsetOf reads offset", relativeOffsetOf({ relativeSchedule: { offsetDays: -1 } }), -1);
check("relativeOffsetOf without → null", relativeOffsetOf({ foo: 1 }) === null);
eq("offsetBetween +2", offsetBetween("2026-06-18", "2026-06-20"), 2);
eq("offsetBetween -1", offsetBetween("2026-06-18", "2026-06-17"), -1);
eq("offsetBetween 0", offsetBetween("2026-06-18", "2026-06-18"), 0);
eq("applyOffset +2", applyOffset("2026-06-18", 2), "2026-06-20");
eq("applyOffset -1", applyOffset("2026-06-18", -1), "2026-06-17");
eq("applyOffset across month", applyOffset("2026-06-30", 3), "2026-07-03");
eq("describe same day", describeOffset(0), "same day");
eq("describe +2", describeOffset(2), "+2d");
eq("describe -1", describeOffset(-1), "−1d");

// ---------------------------------------------------------------------------
const { getDb } = await import("../src/db");
const { items, users } = await import("../src/db/schema");
const { getItem } = await import("../src/lib/items");
const {
  createItem,
  updateItem,
} = await import("../src/lib/item-mutations");
const { cloneItemSubtree } = await import("../src/lib/clone");
const { restoreChildDates } = await import("../src/lib/relative-subtask-service");
const { eq: dEq, inArray } = await import("drizzle-orm");

const db = getDb();
const stamp = Date.now();
const [owner] = await db
  .insert(users)
  .values({ email: `verify-relsub-${stamp}@example.invalid` })
  .returning({ id: users.id });

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const sched = (i: { scheduledDate: Date | null }) =>
  i.scheduledDate ? dateToYmdUtc(i.scheduledDate) : null;
const due = (i: { dueDate: Date | null }) =>
  i.dueDate ? dateToYmdUtc(i.dueDate) : null;

try {
  console.log("\n# Service: recompute on parent scheduled-date change");
  {
    const parent = await createItem(owner.id, {
      type: "task",
      title: "Plan event",
      scheduledDate: ymdToUtc("2026-06-18"),
    });
    const rel = await createItem(owner.id, {
      type: "task",
      title: "Send invites (+2d)",
      parentId: parent.id,
      scheduledDate: ymdToUtc("2026-06-20"),
      properties: { relativeSchedule: { offsetDays: 2 } },
    });
    // No stored offset, and never dated through the subtask picker: under ADR-085
    // this child was frozen forever (the five-of-six breakage Tyler hit). Under
    // ADR-253 anchoring it tracks like any other.
    const abs = await createItem(owner.id, {
      type: "task",
      title: "Fixed prep",
      parentId: parent.id,
      scheduledDate: ymdToUtc("2026-06-19"),
    });
    // Pinned: the deliberate opt-out, the only thing that stands still now.
    const pinned = await createItem(owner.id, {
      type: "task",
      title: "Immovable",
      parentId: parent.id,
      scheduledDate: ymdToUtc("2026-06-19"),
      properties: { datePins: { scheduled: true } },
    });

    // Move the parent +7 days → every unpinned child moves +7, offset or not.
    await updateItem(owner.id, parent.id, { scheduledDate: ymdToUtc("2026-06-25") });
    eq("child with an offset shifts with parent", sched(await getItem(owner.id, rel.id)), "2026-06-27");
    eq("child WITHOUT an offset shifts too (ADR-253)", sched(await getItem(owner.id, abs.id)), "2026-06-26");
    eq("pinned child stands still", sched(await getItem(owner.id, pinned.id)), "2026-06-19");

    // Clearing the parent's date is not a move: there is no delta to apply, so
    // children keep the dates they have. ADR-085 wiped them here, which lost work.
    await updateItem(owner.id, parent.id, { scheduledDate: null });
    eq("children keep their dates when the parent is cleared", sched(await getItem(owner.id, rel.id)), "2026-06-27");

    // Re-dating a previously undated parent is likewise not a move.
    await updateItem(owner.id, parent.id, { scheduledDate: ymdToUtc("2026-07-01") });
    eq("children unchanged when a cleared parent is re-dated", sched(await getItem(owner.id, rel.id)), "2026-06-27");
  }

  console.log("\n# Service: the deadline rides the plan date (ADR-253)");
  {
    const parent = await createItem(owner.id, {
      type: "task",
      title: "Edit sermon",
      scheduledDate: ymdToUtc("2026-09-11"),
      dueDate: ymdToUtc("2026-09-14"),
    });
    const kid = await createItem(owner.id, {
      type: "task",
      title: "Remove filler words",
      parentId: parent.id,
      scheduledDate: ymdToUtc("2026-09-11"),
      dueDate: ymdToUtc("2026-09-12"),
    });
    const kidPinnedDue = await createItem(owner.id, {
      type: "task",
      title: "Hard external deadline",
      parentId: parent.id,
      scheduledDate: ymdToUtc("2026-09-11"),
      dueDate: ymdToUtc("2026-09-12"),
      properties: { datePins: { due: true } },
    });

    // +3 days: plan and deadline both move, gap preserved, all the way down.
    await updateItem(owner.id, parent.id, { scheduledDate: ymdToUtc("2026-09-14") });
    const p = await getItem(owner.id, parent.id);
    eq("parent plan moved", sched(p), "2026-09-14");
    eq("parent deadline kept its 3-day gap", due(p), "2026-09-17");
    const k = await getItem(owner.id, kid.id);
    eq("child plan moved", sched(k), "2026-09-14");
    eq("child deadline moved with it", due(k), "2026-09-15");
    eq("pinned deadline stood still", due(await getItem(owner.id, kidPinnedDue.id)), "2026-09-12");

    // Setting BOTH dates in one patch is the caller stating them deliberately:
    // no gap-preserving shift on top of an explicit deadline.
    await updateItem(owner.id, parent.id, {
      scheduledDate: ymdToUtc("2026-10-01"),
      dueDate: ymdToUtc("2026-10-02"),
    });
    eq("explicit deadline in the same patch wins", due(await getItem(owner.id, parent.id)), "2026-10-02");
  }

  console.log("\n# Service: the undo puts a shifted tree back (ADR-253)");
  {
    const parent = await createItem(owner.id, {
      type: "task",
      title: "Undo me",
      scheduledDate: ymdToUtc("2026-09-11"),
    });
    const kid = await createItem(owner.id, {
      type: "task",
      title: "Child",
      parentId: parent.id,
      scheduledDate: ymdToUtc("2026-09-13"),
      dueDate: ymdToUtc("2026-09-15"),
    });

    // The shift reports the children AS THEY WERE, which is what the toast undoes.
    const moved = await updateItem(owner.id, parent.id, {
      scheduledDate: ymdToUtc("2026-09-18"),
    });
    const shifted = (moved as { datesShifted?: { id: string }[] }).datesShifted ?? [];
    eq("the write reports what it moved", shifted.length, 1);
    eq("child moved +7", sched(await getItem(owner.id, kid.id)), "2026-09-20");
    eq("child deadline moved +7", due(await getItem(owner.id, kid.id)), "2026-09-22");

    // Undo: every reported row goes back exactly where it was.
    await restoreChildDates(owner.id, shifted as Parameters<typeof restoreChildDates>[1]);
    eq("undo restores the plan date", sched(await getItem(owner.id, kid.id)), "2026-09-13");
    eq("undo restores the deadline", due(await getItem(owner.id, kid.id)), "2026-09-15");

    // A write that moves nothing reports nothing, so the toast stays silent.
    const quiet = await updateItem(owner.id, parent.id, { title: "Undo me (renamed)" });
    check(
      "a write that moves no dates reports nothing",
      (quiet as { datesShifted?: unknown }).datesShifted === undefined
    );
  }

  console.log("\n# Service: offsets chain down the tree");
  {
    const parent = await createItem(owner.id, {
      type: "task", title: "Launch", scheduledDate: ymdToUtc("2026-06-18"),
    });
    const child = await createItem(owner.id, {
      type: "task", title: "Draft (+2d)", parentId: parent.id,
      scheduledDate: ymdToUtc("2026-06-20"), properties: { relativeSchedule: { offsetDays: 2 } },
    });
    const grand = await createItem(owner.id, {
      type: "task", title: "Review (+1d from draft)", parentId: child.id,
      scheduledDate: ymdToUtc("2026-06-21"), properties: { relativeSchedule: { offsetDays: 1 } },
    });
    await updateItem(owner.id, parent.id, { scheduledDate: ymdToUtc("2026-06-25") });
    eq("child re-derives (25+2)", sched(await getItem(owner.id, child.id)), "2026-06-27");
    eq("grandchild chains (27+1)", sched(await getItem(owner.id, grand.id)), "2026-06-28");
  }

  console.log("\n# Service: clone/materialize derives a relative child's date");
  {
    const proto = await createItem(owner.id, { type: "task", title: "Weekly ritual" });
    await createItem(owner.id, {
      type: "task", title: "Prep (+3d)", parentId: proto.id,
      properties: { relativeSchedule: { offsetDays: 3 } },
    });
    await createItem(owner.id, { type: "task", title: "Plain step", parentId: proto.id });

    const { rootId } = await cloneItemSubtree(owner.id, proto.id, {
      scheduledDate: ymdToUtc("2026-07-10"),
    });
    const cloneRoot = await getItem(owner.id, rootId);
    eq("clone root takes the occurrence date", sched(cloneRoot), "2026-07-10");
    const kids = await db
      .select({ id: items.id, title: items.title, scheduledDate: items.scheduledDate })
      .from(items)
      .where(dEq(items.parentId, rootId));
    const prep = kids.find((k) => k.title.startsWith("Prep"));
    const plain = kids.find((k) => k.title.startsWith("Plain"));
    eq("relative clone child derives (10+3)", prep && sched(prep), "2026-07-13");
    check("plain clone child has no date", !!plain && plain.scheduledDate === null);
  }
} finally {
  await db.update(items).set({ parentId: null }).where(dEq(items.ownerId, owner.id));
  await db.delete(items).where(dEq(items.ownerId, owner.id));
  await db.delete(users).where(inArray(users.id, [owner.id]));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
