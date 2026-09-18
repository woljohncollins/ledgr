// The project review timeline's data (ADR-198, Tyler's everything-timeline —
// explorations/project-review-timeline.md): every dated thing that happened in
// a record, merged into one ascending history. Two tiers, decided here so the
// page renders without policy:
//
//   BIG   — meetings, milestones (due or completed), and the record's own
//           creation (the story's opening line): the h2s of the scroll.
//   SMALL — task completions (subtasks of the project's tasks included, via
//           parent_id descent), notes made, links added: the ticks between them.
//
// Same source rules as the Timeline card and the project markdown document
// (project-markdown.ts): home-agnostic association, a milestone plots at its
// due date or its completion stamp, a task's completion date is its ADR-197
// stamp (updated_at fallback for pre-stamp history). Server-only; bounded at
// 500 rows per collection, one relations query for milestone states.
import { milestoneStates } from "@/lib/milestones";
import { getItem } from "@/lib/items";
import { listDescendantTasks } from "@/lib/subtasks";
import type { TimelineEntry, TimelineUndated } from "@/lib/timeline-entry";
import { queryViewItems } from "@/lib/views";

// The entry shape moved to src/lib/timeline-entry.ts when the spine became
// reusable (2026-09-03); re-exported so existing importers keep working.
export type { TimelineEntry, TimelineTier, TimelineUndated } from "@/lib/timeline-entry";

export type ProjectTimeline = {
  entries: TimelineEntry[]; // ascending by date
  // Open milestones with no date to plot — the "Upcoming" tail.
  undated: TimelineUndated[];
  // Index of the first entry after now (-1 = none): where the page's Today
  // marker splits past from future. Computed here because a component render
  // must stay pure (no Date.now() in the page).
  firstFutureIndex: number;
};

function taskCompletedAt(properties: unknown, updatedAt: Date): Date {
  const raw = (properties as Record<string, unknown> | null)?.completed_at;
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return updatedAt;
}

type LoadedRecord = Awaited<ReturnType<typeof getItem>>;

export async function gatherProjectTimeline(
  ownerId: string,
  record: LoadedRecord,
  // Which kinds to keep (the page's ?kinds= chips). Filtering HERE rather than
  // in the page is what keeps firstFutureIndex honest: it is an index into the
  // returned array, so filtering afterwards would point the Today marker at the
  // wrong entry. "created" is never filtered out — it is the story's opening
  // line, not one of the collections.
  kinds?: ReadonlySet<TimelineEntry["kind"]>
): Promise<ProjectTimeline> {
  const [meetings, milestones, tasks, notes, links] = await Promise.all([
    queryViewItems(ownerId, { type: "event", relatedTo: record.id }, { field: "meetingAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "milestone", relatedTo: record.id }, { field: "dueDate", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "task", relatedTo: record.id }, { field: "createdAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "note", relatedTo: record.id }, { field: "createdAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "link", relatedTo: record.id }, { field: "createdAt", dir: "asc" }, 500),
  ]);
  const states = await milestoneStates(ownerId, milestones);

  const entries: TimelineEntry[] = [
    {
      id: `created-${record.id}`,
      itemId: record.id,
      date: record.createdAt,
      tier: "big",
      kind: "created",
      label: "Project created",
      title: record.title,
      hasTime: false,
      calendarDay: false,
    },
  ];

  for (const e of meetings) {
    const when = e.meetingAt ?? e.scheduledDate ?? e.dueDate;
    if (!when) continue;
    entries.push({
      id: `meeting-${e.id}`,
      itemId: e.id,
      date: when,
      tier: "big",
      kind: "meeting",
      label: "Meeting",
      title: e.title,
      hasTime: e.meetingAt != null,
      calendarDay: e.meetingAt == null,
    });
  }

  const undated: TimelineUndated[] = [];
  for (const m of milestones) {
    const s = states.get(m.id);
    const done = s?.done ?? false;
    const date = done && s?.completedAt ? s.completedAt : m.dueDate;
    if (!date) {
      if (!done) undated.push({ id: m.id, title: m.title, badge: "milestone" });
      continue;
    }
    entries.push({
      id: `milestone-${m.id}`,
      itemId: m.id,
      date,
      tier: "big",
      kind: "milestone",
      label: done ? "Milestone completed" : "Milestone due",
      title: m.title,
      hasTime: false,
      // A completion stamp is a timestamp; a due date is a calendar day.
      calendarDay: !(done && s?.completedAt),
      done,
    });
  }

  for (const t of tasks) {
    if (t.statusCategory !== "done") continue;
    entries.push({
      id: `task-${t.id}`,
      itemId: t.id,
      date: taskCompletedAt(t.properties, t.updatedAt),
      tier: "small",
      kind: "task",
      label: "Task completed",
      title: t.title,
      hasTime: false,
      calendarDay: false,
      done: true,
    });
  }

  // Subtasks ride along with their parent (Tyler, 2026-08-17): a task on the
  // project brings every task under it (parent_id descent, derived at read time
  // — no relation edges are written for subtasks). A completed subtask is a
  // small tick like any task completion. Deduped against the direct set, since
  // a subtask can also carry its own relation to the project.
  const directTaskIds = new Set(tasks.map((t) => t.id));
  const subtasks = await listDescendantTasks(ownerId, tasks.map((t) => t.id));
  for (const s of subtasks) {
    if (directTaskIds.has(s.id) || s.statusCategory !== "done") continue;
    entries.push({
      id: `task-${s.id}`,
      itemId: s.id,
      date: taskCompletedAt(s.properties, s.updatedAt),
      tier: "small",
      kind: "task",
      label: "Subtask completed",
      title: s.title,
      hasTime: false,
      calendarDay: false,
      done: true,
    });
  }

  for (const n of notes) {
    entries.push({
      id: `note-${n.id}`,
      itemId: n.id,
      date: n.noteDate ?? n.createdAt,
      tier: "small",
      kind: "note",
      label: "Note",
      title: n.title,
      hasTime: false,
      calendarDay: n.noteDate != null,
    });
  }

  for (const l of links) {
    entries.push({
      id: `link-${l.id}`,
      itemId: l.id,
      date: l.createdAt,
      tier: "small",
      kind: "link",
      label: "Link added",
      title: l.title,
      hasTime: false,
      calendarDay: false,
      url: l.url ?? null,
    });
  }

  const kept = kinds ? entries.filter((e) => e.kind === "created" || kinds.has(e.kind)) : entries;
  kept.sort((a, b) => a.date.getTime() - b.date.getTime());
  const keptUndated = kinds && !kinds.has("milestone") ? [] : undated;
  const now = Date.now();
  return {
    entries: kept,
    undated: keptUndated,
    firstFutureIndex: kept.findIndex((e) => e.date.getTime() > now),
  };
}
