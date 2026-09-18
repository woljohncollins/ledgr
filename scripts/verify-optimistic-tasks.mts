// Verifies the optimistic add/complete paths stay optimistic all the way through
// (2026-08-12, Tyler's two "slight pause" items).
//
// Why this script exists: both paths were ALREADY optimistic at the control — the
// row painted instantly, the circle filled instantly — so the bug was invisible to
// "is it optimistic?" as a question. The lag was that the optimistic state stopped
// half way: the added row kept SAYING "Adding…" for ~900ms after the task existed,
// and the completed row's title kept its un-struck styling until the server
// refetch, because that styling came from the server prop while only the circle
// had local state. A structural guard is the right shape here because the defect
// is "state isn't threaded far enough," which greps cleanly and re-appears easily.
//
//   npx tsx scripts/verify-optimistic-tasks.mts
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${String(detail)})`}`);
  }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const card = read("src/components/tasks/AddTaskCard.tsx");
const inline = read("src/components/tasks/InlineAddTask.tsx");
const circle = read("src/components/tasks/TaskCheckCircle.tsx");
const widget = read("src/components/canvas/widgets/TasksWidget.tsx");
const listRefresh = read("src/lib/list-refresh.ts");

// --- add: the row settles when the POST lands, not when the refresh flushes ---
check(
  "persist() returns the created id (the row needs it to become real)",
  /const persist = async \(\): Promise<string>/.test(card)
);
check(
  "the response body is parsed unconditionally — it can only be read once",
  /const \{ item, relateErrors \} = \(await res\.json\(\)\)/.test(card),
  "the id (and relateErrors) must be read once, before any branch"
);
// ADR-202 addendum 5: known-target edges (destination project, "@"-links,
// existing tags) ride the create itself, so a task can never exist without its
// project because a follow-up POST silently failed — and the offline outbox
// replays the association too, since it lives in the body.
check(
  "known-target edges ride the create body (relateTo), not follow-up POSTs",
  /if \(relateTo\.length > 0\) body\.relateTo = relateTo;/.test(card)
);
check(
  "the destination project is in relateTo",
  /relateTo\.push\(\{ targetId: destId/.test(card)
);
check(
  "a failed server-side relate is surfaced, not swallowed",
  /relateErrors[\s\S]{0,120}showToast\(/.test(card)
);
check("persist() actually returns it", /return item\.id;/.test(card));
check(
  "the card reports settlement with both the provisional and the real id",
  /onOptimisticSettle\?\.\(tmpId, realId\)/.test(card)
);
check(
  "settlement is reported BEFORE scheduling the refresh (that's the whole point)",
  card.indexOf("onOptimisticSettle?.(tmpId, realId)") <
    card.indexOf("scheduleListRefresh(() => router.refresh())"),
  "settling after the refresh would restore the ~900ms wait"
);
check(
  "the provisional id is captured once, so add and settle name the same row",
  /const tmpId = `tmp-\$\{Date\.now\(\)\}`/.test(card) && /id: tmpId/.test(card)
);

// --- add: the host stops announcing a finished thing as pending ---------------
check("the host tracks which rows have settled", /settled\[t\.id\]/.test(inline));
check(
  '"Adding…" is conditional on NOT being settled',
  /\{!realId && <span[^>]*>Adding…<\/span>\}/.test(inline),
  "an unconditional Adding… is the original bug"
);
check(
  "the muted look is conditional too",
  /realId \? "text-ink" : "text-ink-muted opacity-70"/.test(inline)
);
check(
  "a settled row gets a REAL check circle, so it works before the server row lands",
  /<TaskCheckCircle itemId=\{realId\}/.test(inline)
);
check(
  "the settled map is cleared on flush, so it can't grow across a session",
  /onListRefreshFlush\(\(\) => \{[\s\S]{0,120}setSettled\(\{\}\)/.test(inline)
);

// --- complete: the row agrees with its own circle ----------------------------
check(
  "the circle can mirror its optimistic state outward",
  /onOptimisticChange\?: \(done: boolean\) => void/.test(circle)
);
check(
  "it reports on click",
  /setDone\(next\);\s*\n\s*onOptimisticChange\?\.\(next\);/.test(circle)
);
check(
  "and reports the REVERT on failure, so the row can't disagree with the control",
  /setDone\(!next\);\s*\n\s*onOptimisticChange\?\.\(!next\);/.test(circle)
);
check(
  "the row's done styling reads the override first, server prop second",
  /doneOverride\[t\.id\] \?\? t\.statusCategory === "done"/.test(widget),
  "server-prop-only was why the strikethrough lagged the circle"
);
check(
  "the widget wires the mirror",
  /onOptimisticChange=\{\(next\) =>/.test(widget)
);
check(
  "overrides are dropped on flush (the server prop is the source of truth)",
  /onListRefreshFlush\(\(\) => setDoneOverride\(\{\}\)\)/.test(widget)
);

// --- the debounce is deliberately NOT shortened ------------------------------
// Shortening it was the tempting fix and the wrong one: the window exists so a
// triage burst costs ONE refetch, and a mid-burst refresh can reorder rows under
// the pointer. The fix was to stop LOOKING pending, not to wait less.
check(
  "the coalescing window is still 500ms",
  /delayMs = 500/.test(listRefresh),
  "if this changed, confirm it was on purpose — burst coalescing is the reason it exists"
);
check(
  "the post-flush tail that avoids a provisional/real gap is still there",
  /setTimeout\(\(\) => subs\.forEach/.test(listRefresh)
);

console.log(
  failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE${failures === 1 ? "" : "S"}`
);
process.exit(failures === 0 ? 0 : 1);
