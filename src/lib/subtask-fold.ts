// The Today subtask fold (Tyler, 2026-08-19, ADR-205): on a "today" surface a
// task renders in exactly ONE place — nested under its parent when the parent
// is on the page, flat when it isn't — so dated work never disappears AND
// never duplicates. Pure and shared by both today surfaces (the home page and
// the /tasks Today tab) so the two can't disagree; verify-subtask-fold pins it.
//
// The rules:
// - A due-today task folds (loses its top-level row) when its parent is
//   anywhere on the page, overdue or due-today. Its parent's subtask tree is
//   where it shows instead, pre-expanded (expandIds).
// - An OVERDUE task folds only when its parent is also overdue. Overdue is
//   where the owner acts (roll-forward lives there), so an overdue child never
//   hides behind a merely due-today parent — it stays flat in the Overdue
//   group with its parent breadcrumb for context.
// - A task whose parent is NOT on the page stays flat, always: dating a
//   subtask must mean "on my plate today" no matter what its parent is doing.
// - expandIds names the top-level rows whose subtask tree should start OPEN,
//   so a folded task is visible without a click. When folds chain (parent
//   folded too), the climb marks the topmost listed ancestor — the rendered
//   tree is recursive, so opening that one shows the whole chain.
export type FoldableTask = { id: string; parentId: string | null };

export function foldTodayTasks<T extends FoldableTask>(
  overdue: T[],
  dueToday: T[]
): { overdue: T[]; dueToday: T[]; expandIds: Set<string> } {
  const listedOverdue = new Map<string, boolean>();
  for (const t of overdue) listedOverdue.set(t.id, true);
  for (const t of dueToday) {
    if (!listedOverdue.has(t.id)) listedOverdue.set(t.id, false);
  }
  const parentById = new Map<string, string | null>();
  for (const t of [...overdue, ...dueToday]) parentById.set(t.id, t.parentId);

  // Ids forced to stay flat because folding them would leave no rendered
  // ancestor (only possible with a malformed parent cycle — a real parent
  // chain always terminates at a row whose parent is off the page). The loop
  // below re-runs the fold protecting them: flat beats hidden, always.
  const protectedIds = new Set<string>();

  for (;;) {
    const folds = (t: T, isOverdue: boolean): boolean => {
      if (protectedIds.has(t.id)) return false;
      if (!t.parentId || !listedOverdue.has(t.parentId)) return false;
      return !isOverdue || listedOverdue.get(t.parentId) === true;
    };

    const overdueTop = overdue.filter((t) => !folds(t, true));
    const dueTodayTop = dueToday.filter((t) => !folds(t, false));
    const topIds = new Set([...overdueTop, ...dueTodayTop].map((t) => t.id));

    const expandIds = new Set<string>();
    const orphaned: string[] = [];
    const folded = [
      ...overdue.filter((t) => folds(t, true)),
      ...dueToday.filter((t) => folds(t, false)),
    ];
    for (const t of folded) {
      // Climb listed-but-folded ancestors to the one that actually renders.
      // `seen` guards a malformed parent cycle from looping forever.
      let cur: string | null = t.parentId;
      const seen = new Set<string>();
      while (cur && listedOverdue.has(cur) && !topIds.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = parentById.get(cur) ?? null;
      }
      if (cur && topIds.has(cur)) expandIds.add(cur);
      else orphaned.push(t.id);
    }

    if (orphaned.length === 0) {
      return { overdue: overdueTop, dueToday: dueTodayTop, expandIds };
    }
    // Each pass protects at least one new id, so this terminates.
    for (const id of orphaned) protectedIds.add(id);
  }
}
