// Verification for the project-completion + board slice (Tyler, 2026-08-25):
// the status-board COLUMN ORDER regression, the sweep's plain-language summary,
// the terminal-category rule the collapsed Done column keys off, and the
// project type's default lens strip. Pure (no DB), so it runs fast and offline.
// Run: npx tsx scripts/verify-project-done.mts
import { defaultLenses } from "../src/lib/list-lenses";
import { describeSweep, sweepDecision } from "../src/lib/project-completion";
import {
  isTerminalCategory,
  orderedStatuses,
  type StatusDef,
} from "../src/lib/status";
import { NONE_GROUP, orderedGroups } from "../src/lib/view-grouping";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}`);
  }
}

// Tyler's real project statuses, in the order they were authored — the exact
// shape that produced the bug report (Blocked and Background were added last,
// so they sit at the end of their categories).
const PROJECT_STATUSES: StatusDef[] = [
  { key: "ongoing", label: "Ongoing", category: "in_progress", color: "#3b82f6", isDefault: true },
  { key: "waiting", label: "Waiting for Others", category: "not_started", color: "#64748b" },
  { key: "paused", label: "Paused", category: "not_started", color: "#64748b" },
  { key: "future", label: "Future", category: "not_started", color: "#64748b", isDefault: true },
  { key: "done", label: "Done", category: "done", color: "#16a34a", isDefault: true },
  { key: "status_6", label: "Blocked", category: "not_started", color: "#64748b" },
  { key: "status_7", label: "Background", category: "in_progress", color: "#3b82f6" },
];

// --- The column-order regression -------------------------------------------
// THE BUG: the list-page lens path never computed a status board's knownOrder,
// so orderedGroups had nothing to order by and every column fell through to its
// ALPHABETICAL tail — which put Done on the FAR LEFT (done < ongoing < status_7)
// and printed raw keys. Both halves are asserted here so a future refactor that
// drops the groupOrder plumbing fails loudly instead of silently reordering a
// board.
const present = new Set(["done", "ongoing", "status_7"]);

const withoutOrder = orderedGroups({ field: "status" }, present, undefined);
check(
  "REGRESSION: no knownOrder → alphabetical, Done wrongly first",
  withoutOrder.join(",") === "done,ongoing,status_7"
);

// THE SECOND HALF OF THE SAME BUG, found by rendering a real board rather than
// trusting this file's first draft: resolveStatusSchema preserves the order the
// statuses were AUTHORED in, so the obvious `statuses.map(s => s.key)` is NOT a
// column order. On the authored order below, "done" sits FIFTH of seven, which
// on a board puts Done mid-strip with Blocked and Background to its right.
// orderedStatuses is the function that sorts by category. Asserting the raw
// order is wrong keeps anyone (including a future me) from "simplifying" the
// call sites back to the plain map.
const rawOrder = PROJECT_STATUSES.map((s) => s.key);
check(
  "TRAP: raw authored order puts Done mid-strip, so it is not a column order",
  rawOrder.indexOf("done") === 4 && rawOrder.at(-1) === "status_7"
);
check(
  "TRAP: a board built from the raw order would not end on Done",
  orderedGroups({ field: "status" }, new Set(rawOrder), rawOrder).at(-1) !== "done"
);

const knownOrder = orderedStatuses(PROJECT_STATUSES).map((s) => s.key);
check(
  "orderedStatuses moves every terminal status to the end",
  knownOrder.at(-1) === "done"
);
const withOrder = orderedGroups({ field: "status" }, present, knownOrder);
check(
  "with knownOrder → schema order, Done LAST",
  withOrder.join(",") === "ongoing,status_7,done"
);
check("Done is rightmost", withOrder[withOrder.length - 1] === "done");

// Full strip, every status present: category order first, author order within.
const allPresent = new Set(PROJECT_STATUSES.map((s) => s.key));
check(
  "empty columns included, ordered by category then author order",
  orderedGroups({ field: "status" }, allPresent, knownOrder).join(",") ===
    "waiting,paused,future,status_6,ongoing,status_7,done"
);

// NONE_GROUP always sorts last, even behind a terminal column.
check(
  "NONE_GROUP stays last",
  orderedGroups({ field: "status" }, new Set(["done", NONE_GROUP, "ongoing"]), knownOrder).at(-1) ===
    NONE_GROUP
);

// --- Terminal categories (what the board collapses by default) --------------
check("done is terminal", isTerminalCategory("done"));
check("archived is terminal", isTerminalCategory("archived"));
check("not_started is NOT terminal", !isTerminalCategory("not_started"));
check("in_progress is NOT terminal", !isTerminalCategory("in_progress"));

// --- The sweep's summary line ----------------------------------------------
// This string is what the confirm dialog shows before a bulk write, so its
// counts have to be exactly right and its plural has to read like English.
check("empty sweep → empty string", describeSweep([]) === "");
check("one task singular", describeSweep([{ type: "task" }]) === "1 task");
check(
  "many pluralize",
  describeSweep([{ type: "task" }, { type: "task" }]) === "2 tasks"
);
check(
  "grouped by type, biggest group first",
  describeSweep([
    { type: "milestone" },
    { type: "task" },
    { type: "task" },
    { type: "task" },
    { type: "milestone" },
  ]) === "3 tasks, 2 milestones"
);
check(
  "ties break alphabetically (stable wording run to run)",
  describeSweep([{ type: "task" }, { type: "milestone" }]) === "1 milestone, 1 task"
);

// --- The sweep is GENERIC over types (Tyler, 2026-08-25) --------------------
// The contract: nothing about which types get completed is hardcoded. The rule
// asks the TYPE two questions — do you track completion, and what do you call
// done — so a type that gains a Done checkbox later is swept from that moment
// with no code change. These assertions exist so nobody "optimizes" the rule
// into an allowlist of task/milestone, which would silently drop every type
// invented after today.

// A brand-new custom type nobody has written code for, with a plain Done
// checkbox. This is the case Tyler was actually asking about.
check(
  "a FUTURE type with a done checkbox is completed",
  sweepDecision({ type: "purchase_order" }, { mode: "checkbox", doneKey: "done" }).action ===
    "complete"
);
// ...and it completes to ITS OWN done key, not a hardcoded "done".
const custom = sweepDecision(
  { type: "shipment" },
  { mode: "select", doneKey: "delivered" }
);
check(
  "it completes to the type's OWN done status, not a literal 'done'",
  custom.action === "complete" && custom.nextStatus === "delivered"
);
// Completion turned off = skipped, and reported as such rather than dropped.
check(
  "a type with completion off is skipped as no_completion",
  sweepDecision({ type: "note" }, { mode: "none", doneKey: "done" }).action === "skip"
);
check(
  "an UNKNOWN type is skipped, never guessed at",
  sweepDecision({ type: "who_knows" }, undefined).action === "skip"
);
// A type that tracks completion but defines no done status can't be written to.
check(
  "checkbox mode with no done key is skipped",
  sweepDecision({ type: "odd" }, { mode: "checkbox", doneKey: null }).action === "skip"
);
// Recurrence wins over completability: the item COULD be completed, but
// completing it would advance it instead of closing it.
// A real stored rule needs BOTH an rrule and a YYYY-MM-DD dtstart — a rule
// missing its anchor is not a recurring task (parseRecurrence returns null), so
// the fixture has to carry both or this asserts nothing.
const rec = sweepDecision(
  {
    type: "task",
    properties: { recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO", dtstart: "2026-08-24" } },
  },
  { mode: "checkbox", doneKey: "done" }
);
check(
  "a repeating task is skipped as recurring, not completed",
  rec.action === "skip" && rec.reason === "recurring"
);
check(
  "an rrule with no dtstart is NOT treated as recurring",
  sweepDecision(
    { type: "task", properties: { recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO" } } },
    { mode: "checkbox", doneKey: "done" }
  ).action === "complete"
);
check(
  "a non-repeating task of the same type IS completed",
  sweepDecision({ type: "task", properties: { focus: {} } }, { mode: "checkbox", doneKey: "done" })
    .action === "complete"
);

// --- The project type's default tabs ---------------------------------------
const projectLenses = defaultLenses("project");
check("project leads with the Board tab", projectLenses[0]?.kind === "board");
check(
  "project ends with the Completed tab",
  projectLenses[projectLenses.length - 1]?.kind === "completed"
);
check(
  "project keeps the generic sort tabs between them",
  projectLenses.some((l) => l.kind === "sort" && l.id === "recent")
);
// Other types are untouched — the board is opt-in per type, not a global change.
check("note type unchanged (no board tab)", !defaultLenses("note").some((l) => l.kind === "board"));
check(
  "event type keeps its calendar-first strip",
  defaultLenses("event")[0]?.kind === "calendar"
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
