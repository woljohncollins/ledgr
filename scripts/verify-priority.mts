// Priority P1–P6 (ADR-096) — pure verification of the vocab/codec. No DB.
// Run: npx tsx scripts/verify-priority.mts
const {
  ALL_PRIORITIES,
  PRIORITIES,
  isPriority,
  toPriority,
  priorityStyle,
  priorityLabel,
  prioritySortKey,
  fromLegacyUrgency,
  autoPriorityOnFirstSubtask,
} = await import("../src/lib/priority");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// The column holds P1..P6, but the pickers only offer P1..P3 (John, 2026-09-29: they map to
// Outlook High / Normal / Low). Two constants, two checks.
check("ALL_PRIORITIES is 1..6 (everything the column can hold)", JSON.stringify([...ALL_PRIORITIES]) === "[1,2,3,4,5,6]");
check("PRIORITIES is 1..3 (what the pickers offer)", JSON.stringify([...PRIORITIES]) === "[1,2,3]");
check("isPriority accepts 1..6", [1, 2, 3, 4, 5, 6].every(isPriority));
check("isPriority rejects 0/7/null/'3'", ![0, 7, null, "3"].some((x) => isPriority(x)));

// coercion
check("toPriority(3) = 3", toPriority(3) === 3);
check('toPriority("p3") = 3', toPriority("p3") === 3);
check('toPriority("3") = 3', toPriority("3") === 3);
check("toPriority(null) = null", toPriority(null) === null);
check("toPriority(0) = null", toPriority(0) === null);
check("toPriority(7) = null", toPriority(7) === null);
check('toPriority("nope") = null', toPriority("nope") === null);

// styles: the 6 colors (P6 neutral)
check("P1 red", priorityStyle(1).name === "red" && priorityStyle(1).dot.includes("red"));
check("P2 gold", priorityStyle(2).name === "gold" && priorityStyle(2).dot.includes("amber"));
check("P3 purple", priorityStyle(3).name === "purple");
check("P4 blue", priorityStyle(4).name === "blue");
check("P5 green", priorityStyle(5).name === "green" && priorityStyle(5).dot.includes("emerald"));
check("P6 none/neutral", priorityStyle(6).name === "none" && priorityStyle(6).dot.includes("neutral"));

// labels + sort
check('priorityLabel(1) = "P1"', priorityLabel(1) === "P1");
check('priorityLabel(null) = "P6"', priorityLabel(null) === "P6");
check("sort: lower = first", prioritySortKey(1) < prioritySortKey(5));
check("sort: null sorts last (=6)", prioritySortKey(null) === 6);

// legacy urgency mapping (the migration table)
check("critical → P1", fromLegacyUrgency("critical") === 1);
check("high → P2", fromLegacyUrgency("high") === 2);
check("normal → P4", fromLegacyUrgency("normal") === 4);
check("low → P6", fromLegacyUrgency("low") === 6);
check("unknown → null", fromLegacyUrgency("bogus") === null && fromLegacyUrgency(null) === null);

// auto-P5 on first subtask: only when unset
check("autoP5: unset → 5", autoPriorityOnFirstSubtask(null) === 5);
check("autoP5: P1 stays (null = no change)", autoPriorityOnFirstSubtask(1) === null);
check("autoP5: P6 stays (null = no change)", autoPriorityOnFirstSubtask(6) === null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
