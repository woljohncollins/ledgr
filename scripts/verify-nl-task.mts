import { existsSync, readFileSync } from "node:fs";

// .env.local is gitignored, so it is present locally and ABSENT in CI. A bare
// readFileSync here used to throw ENOENT, which is why this script passed on a
// developer machine and failed on CI's first run. The load is optional — the
// checks below assert whichever branch the env puts them in.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { parseTaskTitle } = await import("../src/lib/nl-date");

const TODAY = "2026-06-18"; // a Thursday
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
function eq<T>(name: string, got: T, want: T) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : `got ${g}, want ${w}`);
}

console.log("\n# Dates (→ scheduled)");
{
  const r = parseTaskTitle("Call Bob tomorrow", TODAY);
  eq("tomorrow → scheduled +1", r.scheduledDate, "2026-06-19");
  eq("tomorrow → title stripped", r.title, "Call Bob");
}
{
  const r = parseTaskTitle("Plan offsite in 2 weeks", TODAY);
  eq("in 2 weeks → scheduled +14", r.scheduledDate, "2026-07-02");
  eq("in 2 weeks → title stripped", r.title, "Plan offsite");
}
{
  const r = parseTaskTitle("Review jun 20 budget", TODAY);
  eq("month-day → scheduled", r.scheduledDate, "2026-06-20");
  eq("month-day → title stripped (mid-string)", r.title, "Review budget");
}
{
  const r = parseTaskTitle("Renew license 6/30", TODAY);
  eq("slash date → scheduled", r.scheduledDate, "2026-06-30");
  eq("slash date → title stripped", r.title, "Renew license");
}
{
  const r = parseTaskTitle("Ship 2026-07-01", TODAY);
  eq("ISO date → scheduled", r.scheduledDate, "2026-07-01");
}
{
  const r = parseTaskTitle("Team review next week", TODAY);
  eq("next week → scheduled +7", r.scheduledDate, "2026-06-25");
  eq("next week → title stripped", r.title, "Team review");
}

console.log("\n# Due ('by <date>')");
{
  const r = parseTaskTitle("Submit report by friday", TODAY);
  eq("by friday → due (not scheduled)", r.dueDate, "2026-06-19");
  check("by friday → scheduled stays null", r.scheduledDate === null);
  eq("by friday → title stripped", r.title, "Submit report");
}

console.log("\n# Recurrence (→ RRULE)");
{
  const r = parseTaskTitle("Pay rent every month", TODAY);
  eq("every month → monthly rrule", r.recurrence?.rrule, "FREQ=MONTHLY");
  eq("every month → scheduled = first occurrence (today)", r.scheduledDate, "2026-06-18");
  eq("every month → title stripped", r.title, "Pay rent");
}
{
  const r = parseTaskTitle("Water plants every 3 days", TODAY);
  eq("every 3 days → daily interval 3", r.recurrence?.rrule, "FREQ=DAILY;INTERVAL=3");
  eq("every 3 days → title stripped", r.title, "Water plants");
}
{
  const r = parseTaskTitle("Team sync every monday", TODAY);
  eq("every monday → weekly BYDAY=MO", r.recurrence?.rrule, "FREQ=WEEKLY;BYDAY=MO");
  eq("every monday → scheduled = next Monday", r.scheduledDate, "2026-06-22");
  eq("every monday → dtstart anchors next Monday's enumeration at today", r.recurrence?.dtstart, "2026-06-18");
  eq("every monday → title stripped", r.title, "Team sync");
}
{
  const r = parseTaskTitle("Standup every weekday", TODAY);
  eq("every weekday → weekly Mon–Fri", r.recurrence?.rrule, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  eq("every weekday → scheduled = today (Thu is a weekday)", r.scheduledDate, "2026-06-18");
}
{
  const r = parseTaskTitle("daily journal", TODAY);
  eq("bare 'daily' → daily rrule", r.recurrence?.rrule, "FREQ=DAILY");
  eq("daily → title stripped", r.title, "journal");
}

console.log("\n# Recurrence: 'every other' (→ INTERVAL=2)");
{
  const r = parseTaskTitle("Trash every other week", TODAY);
  eq("every other week → weekly interval 2", r.recurrence?.rrule, "FREQ=WEEKLY;INTERVAL=2");
  eq("every other week → title stripped", r.title, "Trash");
}
{
  const r = parseTaskTitle("Sermon edit every other friday", TODAY);
  eq("every other friday → biweekly BYDAY=FR", r.recurrence?.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  eq("every other friday → label", r.detections[0].label, "Every other Friday");
}
{
  const r = parseTaskTitle("Deep clean every other month", TODAY);
  eq("every other month → monthly interval 2", r.recurrence?.rrule, "FREQ=MONTHLY;INTERVAL=2");
}

console.log("\n# Recurrence: monthly positional (ADR-076 amendment)");
{
  const r = parseTaskTitle("Pick service first sunday of the month", TODAY);
  eq("first sunday → ordinal BYDAY", r.recurrence?.rrule, "FREQ=MONTHLY;BYDAY=1SU");
  eq("first sunday → scheduled (June's passed → July)", r.scheduledDate, "2026-07-05");
  eq("first sunday → title stripped", r.title, "Pick service");
  eq("first sunday → label", r.detections[0].label, "First Sunday");
}
{
  const r = parseTaskTitle("the third thursday review", TODAY);
  eq("the third thursday → BYDAY=3TH", r.recurrence?.rrule, "FREQ=MONTHLY;BYDAY=3TH");
  eq("third thursday → scheduled = today (June 18 is the 3rd Thu)", r.scheduledDate, "2026-06-18");
  eq("the/of-the-month optional; title stripped", r.title, "review");
}
{
  const r = parseTaskTitle("report first and second thursday", TODAY);
  eq("first and second thursday → BYDAY=1TH,2TH", r.recurrence?.rrule, "FREQ=MONTHLY;BYDAY=1TH,2TH");
  eq("multi-ordinal → label", r.detections[0].label, "First & Second Thursday");
  eq("multi-ordinal → title stripped", r.title, "report");
}
{
  const r = parseTaskTitle("Pay rent 3rd of the month", TODAY);
  eq("3rd of the month → BYMONTHDAY=3", r.recurrence?.rrule, "FREQ=MONTHLY;BYMONTHDAY=3");
  eq("bymonthday → label", r.detections[0].label, "Day 3");
  eq("bymonthday → title stripped", r.title, "Pay rent");
}
{
  const r = parseTaskTitle("Reconcile last of the month", TODAY);
  eq("last of the month → BYMONTHDAY=-1", r.recurrence?.rrule, "FREQ=MONTHLY;BYMONTHDAY=-1");
}

console.log("\n# Urgency (p1..p4 / !1..!4)");
{
  eq("p1 → P1", parseTaskTitle("Fix outage p1", TODAY).urgency, 1);
  eq("p2 → P2", parseTaskTitle("Email p2", TODAY).urgency, 2);
  eq("p3 → P3", parseTaskTitle("Tidy p3", TODAY).urgency, 3);
  eq("p4 → P4", parseTaskTitle("Someday p4", TODAY).urgency, 4);
  eq("!1 → P1", parseTaskTitle("Ship !1", TODAY).urgency, 1);
  eq("urgency strips from title", parseTaskTitle("Fix outage p1", TODAY).title, "Fix outage");
}

console.log("\n# Combined + detections");
{
  const r = parseTaskTitle("Submit report every weekday p2", TODAY);
  eq("combined: recurrence", r.recurrence?.rrule, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  eq("combined: urgency", r.urgency, 2);
  eq("combined: title clean", r.title, "Submit report");
  eq("combined: 2 detections (recurrence + urgency)", r.detections.length, 2);
  eq("combined: recurrence detection first", r.detections[0].field, "recurrence");
}

console.log("\n# No false positives");
{
  const r = parseTaskTitle("Plan the wedding", TODAY);
  check("'wedding' not read as Wednesday", r.scheduledDate === null && r.recurrence === null);
  eq("title untouched", r.title, "Plan the wedding");
  eq("no detections", r.detections.length, 0);
}
{
  const r = parseTaskTitle("Buy milk", TODAY);
  eq("plain title untouched", r.title, "Buy milk");
  check("plain title: nothing detected", r.detections.length === 0);
}
{
  // "p3" inside "mp3" must not match (word boundary).
  const r = parseTaskTitle("Convert mp3 files", TODAY);
  check("'mp3' not read as p3 urgency", r.urgency === null);
  eq("title untouched", r.title, "Convert mp3 files");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
