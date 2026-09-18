// Slice 24 verification: meeting prep assembly + action-item promotion against
// the live Neon DB under a throwaway owner. Covers person gathering (confirmed
// only), the person's open tasks (done/other-person tasks excluded), recent
// meetings (this one excluded, capped, newest first), default agenda, and
// promotion (task created + related to the meeting and its people, so it then
// shows up in prep). Run: npx tsx scripts/verify-meeting-prep.mts
// Safe to delete once the slice is closed.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { items, relations, users } = await import("../src/db/schema");
const { getMeetingPrep } = await import("../src/lib/meetings/prep");
const { promoteActionItem } = await import("../src/lib/meetings/promote");
const { eq } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const [tempUser] = await db
  .insert(users)
  .values({ email: `verify-prep-${Date.now()}@example.invalid` })
  .returning({ id: users.id });
const ownerId = tempUser.id;

const mk = async (v: Record<string, unknown>) =>
  (await db.insert(items).values({ ownerId, ...(v as object) } as typeof items.$inferInsert).returning({ id: items.id }))[0].id;
const relate = (s: string, t: string, state: "confirmed" | "suggested" = "confirmed", role = "related") =>
  db.insert(relations).values({ sourceId: s, targetId: t, role, matchState: state });

try {
  const roger = await mk({ type: "person", title: "Roger" });
  const other = await mk({ type: "person", title: "Someone Else" });
  const meeting = await mk({ type: "event", title: "Roger 1:1", meetingAt: new Date("2026-06-20T15:00:00Z") });

  // Roger's tasks: one open (should appear), one done (excluded), plus a task
  // for the OTHER person (excluded). And a suggested edge that must not count.
  const openTask = await mk({ type: "task", title: "Prep budget memo", status: "open", dueDate: new Date("2026-06-19T00:00:00Z") });
  // Raw insert sets the status key but not the category bucket the active
  // filter keys off (ADR-082); status_category defaults to not_started, so a
  // "done" fixture must set statusCategory explicitly or it reads as active.
  const doneTask = await mk({ type: "task", title: "Already finished", status: "done", statusCategory: "done" });
  const otherTask = await mk({ type: "task", title: "Not Roger's", status: "open" });
  const suggestedTask = await mk({ type: "task", title: "Only suggested-linked", status: "open" });
  await relate(openTask, roger);
  await relate(doneTask, roger);
  await relate(otherTask, other);
  await relate(suggestedTask, roger, "suggested");

  // Past meetings with Roger: three older + one in the future; this meeting
  // (also Roger's) must be excluded from "recent".
  const past1 = await mk({ type: "event", title: "1:1 May", meetingAt: new Date("2026-05-01T15:00:00Z") });
  const past2 = await mk({ type: "event", title: "1:1 Apr", meetingAt: new Date("2026-04-01T15:00:00Z") });
  const past3 = await mk({ type: "event", title: "1:1 Mar", meetingAt: new Date("2026-03-01T15:00:00Z") });
  const past4 = await mk({ type: "event", title: "1:1 Feb", meetingAt: new Date("2026-02-01T15:00:00Z") });
  // Attendance edges (ADR-144): a person is ON an event via role 'attending'.
  for (const m of [meeting, past1, past2, past3, past4]) await relate(m, roger, "confirmed", "attending");

  // Relate the person to the meeting as well (the meeting<->Roger edge).
  // (meeting already related above.)

  const prep = await getMeetingPrep(ownerId, meeting);
  check("gathers the confirmed attendee", prep.attending.length === 1 && prep.attending[0].id === roger);
  check(
    "open tasks: only Roger's open task (done/other-person/suggested excluded)",
    prep.openTasks.length === 1 && prep.openTasks[0].id === openTask,
    prep.openTasks.map((t) => t.title).join(", ")
  );
  check("recent meetings exclude this meeting and cap at 3", prep.recentMeetings.length === 3 && !prep.recentMeetings.some((m) => m.id === meeting));
  check(
    "recent meetings are newest-first",
    prep.recentMeetings[0].id === past1 && prep.recentMeetings[2].id === past3,
    prep.recentMeetings.map((m) => m.title).join(" > ")
  );

  // --- empty prep (no related person) -------------------------------------
  const lonelyMeeting = await mk({ type: "event", title: "Solo block" });
  const emptyPrep = await getMeetingPrep(ownerId, lonelyMeeting);
  check("a meeting with no people yields empty prep", emptyPrep.attending.length === 0 && emptyPrep.openTasks.length === 0);

  // --- action-item -> task promotion --------------------------------------
  const { task } = await promoteActionItem(ownerId, meeting, {
    type: "task",
    title: "  Follow up on the memo  ",
  });
  check("promotion creates a trimmed, open, non-inbox task", task.type === "task" && task.title === "Follow up on the memo" && task.status === "open" && task.inbox === false);
  const taskRels = await db
    .select({ targetId: relations.targetId, sourceId: relations.sourceId })
    .from(relations)
    .where(eq(relations.sourceId, task.id));
  const relatedIds = new Set(taskRels.flatMap((r) => [r.targetId, r.sourceId]));
  check("promoted task is related to the meeting and the person", relatedIds.has(meeting) && relatedIds.has(roger));

  // The promoted task should now appear in this person's prep open tasks.
  const prep2 = await getMeetingPrep(ownerId, meeting);
  check("promoted task shows up in the next prep read", prep2.openTasks.some((t) => t.id === task.id));

  // Block-linked promotion (ADR-090): a body + the line's ^id anchor ride along.
  // The capture card's parsed fields ride through: body, priority, due date and
  // the edges it already resolved, alongside the source anchor.
  const { task: linked } = await promoteActionItem(
    ownerId,
    meeting,
    {
      type: "task",
      title: "Email the budget",
      body: { format: "markdown", text: "- detail one\n- detail two" },
      urgency: 2,
      dueDate: new Date("2030-01-05T00:00:00.000Z"),
    },
    { blockRef: "a1b2c3", relateTo: [{ targetId: roger, role: "related" }] }
  );
  const src = (linked.properties as { source?: { itemId?: string; blockRef?: string } } | null)?.source;
  check("block-linked promotion stores source.itemId + blockRef", src?.itemId === meeting && src?.blockRef === "a1b2c3");
  const linkedBody = (linked.body as { text?: string } | null)?.text ?? "";
  check("block-linked promotion carries the pulled sub-bullets as the task body", linkedBody.includes("detail one") && linkedBody.includes("detail two"));
  check(
    "promotion carries the capture card's parsed priority + due date",
    linked.urgency === 2 && linked.dueDate?.toISOString().slice(0, 10) === "2030-01-05",
    `urgency=${linked.urgency} due=${String(linked.dueDate)}`
  );

  // --- owner scoping ------------------------------------------------------
  const [otherUser] = await db.insert(users).values({ email: `verify-prep-other-${Date.now()}@example.invalid` }).returning({ id: users.id });
  let crossOwnerEmpty = false;
  try {
    const cross = await getMeetingPrep(otherUser.id, meeting);
    crossOwnerEmpty = cross.attending.length === 0 && cross.openTasks.length === 0;
  } finally {
    await db.delete(users).where(eq(users.id, otherUser.id));
  }
  check("prep is owner-scoped (other owner sees nothing for this meeting)", crossOwnerEmpty);
} finally {
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
