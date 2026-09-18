// Verification: foldTodayTasks, the pure Today subtask-fold rule (ADR-205).
// A task renders in exactly one place on a today surface — under its parent
// when the parent is on the page, flat when it isn't; overdue children hide
// only under an overdue parent; the topmost rendered ancestor of every folded
// task pre-expands. Pure (no DB, no server). Run:
//   npx tsx scripts/verify-subtask-fold.mts
import { foldTodayTasks, type FoldableTask } from "../src/lib/subtask-fold";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
}

const t = (id: string, parentId: string | null = null): FoldableTask => ({ id, parentId });
const ids = (list: FoldableTask[]) => list.map((x) => x.id).join(",");

// 1. A due-today child folds under a due-today parent; the parent pre-expands.
{
  const r = foldTodayTasks([], [t("p"), t("c", "p")]);
  check("due-today child folds under due-today parent", ids(r.dueToday) === "p", ids(r.dueToday));
  check("parent pre-expands", r.expandIds.has("p"));
}

// 2. A due-today child folds under an OVERDUE parent (parent anywhere on page).
{
  const r = foldTodayTasks([t("p")], [t("c", "p")]);
  check("due-today child folds under overdue parent", r.dueToday.length === 0, ids(r.dueToday));
  check("overdue parent pre-expands", r.expandIds.has("p"));
  check("overdue parent stays top-level", ids(r.overdue) === "p");
}

// 3. The overdue carve-out: an overdue child does NOT hide behind a merely
//    due-today parent — it stays flat in Overdue.
{
  const r = foldTodayTasks([t("c", "p")], [t("p")]);
  check("overdue child stays flat under due-today parent", ids(r.overdue) === "c", ids(r.overdue));
  check("due-today parent keeps its row", ids(r.dueToday) === "p");
  check("nothing pre-expands", r.expandIds.size === 0);
}

// 4. Overdue child + overdue parent: folds.
{
  const r = foldTodayTasks([t("p"), t("c", "p")], []);
  check("overdue child folds under overdue parent", ids(r.overdue) === "p", ids(r.overdue));
  check("overdue parent pre-expands", r.expandIds.has("p"));
}

// 5. Parent not on the page at all: the dated child stays flat — dated work
//    never disappears.
{
  const r = foldTodayTasks([], [t("c", "elsewhere")]);
  check("child of an off-page parent stays flat", ids(r.dueToday) === "c", ids(r.dueToday));
}

// 6. Chained folds: grandparent → parent → child all on the page. Parent and
//    child both fold; the expand climbs to the grandparent (the rendered row).
{
  const r = foldTodayTasks([], [t("g"), t("p", "g"), t("c", "p")]);
  check("chain: only the grandparent renders", ids(r.dueToday) === "g", ids(r.dueToday));
  check("chain: expand marks the grandparent", r.expandIds.has("g") && r.expandIds.size === 1);
}

// 7. Mixed chain: overdue grandparent, due-today parent + child.
{
  const r = foldTodayTasks([t("g")], [t("p", "g"), t("c", "p")]);
  check("mixed chain: grandparent alone in Overdue", ids(r.overdue) === "g" && r.dueToday.length === 0);
  check("mixed chain: expand marks the grandparent", r.expandIds.has("g") && r.expandIds.size === 1);
}

// 8. A malformed parent cycle can't loop forever OR vanish rows: each is the
//    other's parent, so a naive fold hides both. The orphan-restore pass keeps
//    them flat instead — flat beats hidden, always. (Real parent chains can't
//    cycle; this pins the invariant against corrupt data.)
{
  const r = foldTodayTasks([], [t("a", "b"), t("b", "a")]);
  check("cycle: terminates", true);
  check("cycle: both rows stay rendered", ids(r.dueToday) === "a,b", ids(r.dueToday));
  check("cycle: no phantom expands", r.expandIds.size === 0, `${r.expandIds.size}`);
}

// 9. Unrelated tasks pass through untouched, order preserved.
{
  const r = foldTodayTasks([t("x")], [t("y"), t("z")]);
  check("no relations: everything flat", ids(r.overdue) === "x" && ids(r.dueToday) === "y,z");
  check("no relations: nothing expands", r.expandIds.size === 0);
}

// 10. Two children under one parent: parent expands once, both fold.
{
  const r = foldTodayTasks([], [t("p"), t("c1", "p"), t("c2", "p")]);
  check("two children fold under one parent", ids(r.dueToday) === "p");
  check("one expand entry", r.expandIds.size === 1 && r.expandIds.has("p"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll subtask-fold checks passed.");
