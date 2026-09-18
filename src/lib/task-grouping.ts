// Optional grouping for a record's task surfaces (Tyler, 2026-08-17): the
// Tasks card and the full task list can section tasks under the milestone they
// complete, or under their priority. Pure + client-safe — the card (client)
// and the collection page (server) group with the same rule. The choice lives
// on the Tasks widget instance (options.groupBy, see WIDGET_CATALOG).

export const TASK_GROUP_MODES = ["none", "milestone", "priority"] as const;
export type TaskGroupBy = (typeof TASK_GROUP_MODES)[number];

export function parseTaskGroupBy(raw: unknown): TaskGroupBy {
  return (TASK_GROUP_MODES as readonly unknown[]).includes(raw) ? (raw as TaskGroupBy) : "none";
}

export type TaskGroup<T> = { key: string; label: string; rows: T[] };

// Group rows. Milestone groups keep first-appearance order (the caller's row
// order — done-sunk, date-ascending — decides); tasks under no milestone land
// in a trailing "Other tasks" group. Priority groups run P1→P6 with
// no-priority last. "none" (or a grouping with nothing to group) returns one
// unlabeled group, which callers render exactly like today's flat list.
export function groupTasks<T extends { id: string; urgency?: number | null }>(
  rows: T[],
  groupBy: TaskGroupBy,
  milestoneOf?: (row: T) => { id: string; title: string } | null | undefined
): TaskGroup<T>[] {
  if (groupBy === "milestone" && milestoneOf) {
    const groups: TaskGroup<T>[] = [];
    const byKey = new Map<string, TaskGroup<T>>();
    const rest: T[] = [];
    for (const row of rows) {
      const m = milestoneOf(row);
      if (!m) {
        rest.push(row);
        continue;
      }
      let g = byKey.get(m.id);
      if (!g) {
        g = { key: m.id, label: m.title || "Untitled milestone", rows: [] };
        byKey.set(m.id, g);
        groups.push(g);
      }
      g.rows.push(row);
    }
    if (groups.length === 0) return [{ key: "all", label: "", rows }];
    if (rest.length > 0) groups.push({ key: "other", label: "Other tasks", rows: rest });
    return groups;
  }
  if (groupBy === "priority") {
    const groups: TaskGroup<T>[] = [];
    for (const p of [1, 2, 3, 4, 5]) {
      const g = rows.filter((r) => r.urgency === p);
      if (g.length) groups.push({ key: `p${p}`, label: `Priority ${p}`, rows: g });
    }
    const none = rows.filter((r) => r.urgency == null || r.urgency === 6);
    if (none.length) groups.push({ key: "p-none", label: groups.length ? "No priority" : "", rows: none });
    return groups.length ? groups : [{ key: "all", label: "", rows }];
  }
  return [{ key: "all", label: "", rows }];
}
