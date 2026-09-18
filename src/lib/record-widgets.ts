// The record-scope widget fan-out (Project Type, ADR-111/PJ4): given a record +
// its resolved composition, produce the data each visible widget needs, bound to
// the record. This is DashboardView's per-widget fan-out generalized to a record
// scope — every collection/relation widget binds `relatedTo = record.id` (home-
// scoped for contained collections), and derived/property widgets read the base
// + the log. Server-only (queries the DB); the canvas renders what this returns,
// with no widget-side branching on the record's Type.
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { personImage } from "@/lib/person-image";
import { listActivity, listActivityForSubjects } from "@/lib/activity";
import { listAttachments } from "@/lib/attachments";
import { widgetLimit, type Composition, type RecordWidget } from "@/lib/composition";
import { getItem } from "@/lib/items";
import { getType } from "@/lib/types";
import { describeRule, parseRecurrence } from "@/lib/recurrence";
import {
  applyMilestoneShares,
  combineProgress,
  meetingPoints,
  taskPoints,
  type PointProgress,
} from "@/lib/project-progress";
import { milestoneProgressParts, milestoneStates } from "@/lib/milestones";
import { childRollups, listSubtree, type SubtaskNode } from "@/lib/subtasks";
import { listRelatedItems } from "@/lib/relations";
import { customToolTypeKey, widgetById, type WidgetDefinition } from "@/lib/widgets";
import { countViewItems, queryViewItems, type ViewFilter } from "@/lib/views";

const COLLECTION_LIMIT = 50;
const ACTIVITY_LIMIT = 30;

export type WidgetItemRow = {
  id: string;
  type: string;
  title: string;
  status: string;
  statusCategory: string;
  dueDate: Date | null;
  scheduledDate: Date | null;
  urgency: number | null;
  meetingAt: Date | null;
  // The item's URL (link type) — so a Links widget row can make the title itself
  // the outbound link. Null for non-link items.
  url: string | null;
  // A human recurrence label (e.g. "Weekly on Mon") when the item repeats, else
  // null. Surfaced so a task row can show its recurrence inline with the title.
  recurrence: string | null;
  // Person rows only: the built-in Image (migration 0053), so the header People
  // chips can wear the face. null for other types and unpictured persons.
  image: string | null;
  // Collection rows only (ADR-232): whether this record CONTAINS the item (a
  // home edge, or a project/contains role — the same notion of containment the
  // completion sweep uses) or merely relates to it. A merely-related row is a
  // resource visiting this record, and it wears the detach ✕. Absent on
  // surfaces that don't distinguish (the full collection page), which read as
  // contained and show no ✕.
  contained?: boolean;
  // Task rows only (2026-08-17): the "n/m done" rollup over direct task
  // children, so the Tasks card can fold subtasks out beneath their parent
  // (the same expandable pill the list surfaces use). Absent = no subtasks.
  subtasks?: { done: number; total: number };
  // Task rows only (2026-08-17): the milestone this task completes ("Completes
  // with task", ADR-196), so a task row can wear a subtle flag naming which
  // milestone it belongs to. Absent = not linked to a milestone.
  completesMilestone?: { id: string; title: string };
  // Milestone rows only (ADR-196): resolved completion state + explicit share.
  milestone?: {
    mode: "task" | "date" | "manual";
    done: boolean;
    via: "manual" | "task" | "date" | null;
    taskId: string | null;
    taskTitle: string | null;
    taskDone: boolean;
    pct: number;
  };
};

export type RecordWidgetData = {
  instance: RecordWidget;
  def: WidgetDefinition;
  // collection / relation widgets
  items?: WidgetItemRow[];
  count?: number;
  // Tasks widget only (2026-08-17): how many of the record's tasks are done —
  // the card drops them from its rows, so this backs the "N tasks completed"
  // link into the full collection page.
  doneCount?: number;
  // overview (markdown body is read from the item directly by the canvas)
  // status
  status?: { key: string; category: string };
  // nextAction
  nextAction?: { text: string | null; taskId: string | null; taskTitle: string | null; done: boolean };
  // progress (fraction null = indeterminate "no tasks yet")
  progress?: { done: number; total: number; fraction: number | null };
  // recentActivity
  activity?: { id: string; kind: string; summary: string; occurredAt: Date }[];
  // timeline (meetings + milestones overlaid by date; done marks milestones) +
  // the "Uncompleted" tail: open milestones with no date to plot (Tyler,
  // 2026-08-17 — a finished one gets stamped and joins the axis).
  timeline?: { id: string; title: string; kind: "meeting" | "milestone"; date: Date; done?: boolean }[];
  timelineUndated?: { id: string; title: string }[];
  // files (ADR-236): the record's attachments — not items, so they ride their
  // own field rather than `items`.
  files?: { id: string; filename: string; contentType: string; sizeBytes: number }[];
};

type LoadedRecord = Awaited<ReturnType<typeof getItem>>;

// Recursive completion fraction over a subtask node (PRD §6): a leaf task is
// 0/1; a parent's fraction is the average of its task-children's fractions. Only
// task-type children count — a note/meeting filed under a task is context.
function nodeFraction(node: SubtaskNode): number {
  const taskKids = node.children.filter((c) => c.type === "task");
  if (taskKids.length === 0) return node.statusCategory === "done" ? 1 : 0;
  return taskKids.reduce((a, c) => a + nodeFraction(c), 0) / taskKids.length;
}

// A top-level contained task's fraction: its own done-state if it has no task
// subtasks, else the average of those subtasks' fractions.
function rootFraction(rootCategory: string, children: SubtaskNode[]): number {
  const taskKids = children.filter((c) => c.type === "task");
  if (taskKids.length === 0) return rootCategory === "done" ? 1 : 0;
  return taskKids.reduce((a, c) => a + nodeFraction(c), 0) / taskKids.length;
}

// A record's OWN weighted-points progress (Tyler, 2026-07-01): tasks (worth more
// with subtasks, partial credit by subtree completion), milestones (completable
// — checkbox / linked task / date, ADR-196; ones with an explicit `points`
// percent overlay the bar as shares), and meetings (complete once in the past),
// summed into completed-points ÷ total-points (src/lib/project-progress.ts).
// Extracted so a Pursuit can roll up its projects' progress (PJ9). `done`/
// `total` are POINTS here, not item counts.
async function recordPointProgress(ownerId: string, recordId: string): Promise<PointProgress> {
  const [tasks, milestones, meetings] = await Promise.all([
    // Count everything associated with the record (any relation), matching what
    // the Tasks / Milestones / Meetings boxes show (boundFilter).
    queryViewItems(ownerId, { type: "task", relatedTo: recordId }, { field: "createdAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "milestone", relatedTo: recordId }, { field: "dueDate", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "event", relatedTo: recordId }, { field: "meetingAt", dir: "asc" }, 500),
  ]);
  const now = Date.now();
  const DEEP = 200; // beyond this, treat a task as a leaf (no subtree probe) — bound the fan-out.
  const taskParts = await Promise.all(
    tasks.map(async (t, i) => {
      if (i >= DEEP) return taskPoints(t.statusCategory === "done" ? 1 : 0, 0);
      const sub = await listSubtree(ownerId, t.id).catch(() => null);
      const kids = sub?.children ?? [];
      const subtaskCount = kids.filter((c) => c.type === "task").length;
      return taskPoints(rootFraction(t.statusCategory, kids), subtaskCount);
    })
  );
  // Milestones complete by checkbox / linked task / date (ADR-196, milestones.ts).
  // Ones carrying an explicit `points` percent overlay the pooled bar as shares.
  const { pool: msParts, shares } = await milestoneProgressParts(ownerId, milestones);
  const mtParts = meetings.map((e) => {
    const when = e.meetingAt ?? e.scheduledDate ?? e.dueDate;
    return meetingPoints(when ? when.getTime() < now : false);
  });
  return applyMilestoneShares(combineProgress([...taskParts, ...msParts, ...mtParts]), shares);
}

// The tracked container records this record CONTAINS (home edges) — a Pursuit's
// Projects. Drives the derived roll-ups (PJ9). A plain project contains tasks,
// not projects, so this is empty for it (no roll-up; its own progress is used).
async function containedProjects(ownerId: string, recordId: string) {
  return queryViewItems(
    ownerId,
    { type: "project", relatedTo: recordId, relatedHome: true },
    { field: "createdAt", dir: "asc" },
    200
  );
}

// Every item this record CONTAINS: a home edge from the item, or a
// project/contains role in either direction. Deliberately the same predicate
// as the project-completion sweep (project-completion.ts), so "no ✕" and "the
// sweep may touch this" always mean the same set. One query per record page,
// shared by every collection card.
async function containedIds(ownerId: string, recordId: string): Promise<Set<string>> {
  const res = await getDb().execute(sql`
    select r.source_id as id
      from relations r join items i on i.id = r.source_id
     where i.owner_id = ${ownerId}
       and r.target_id = ${recordId}
       and r.match_state = 'confirmed'
       and (r.home or r.role in ('project', 'contains'))
    union
    select r.target_id as id
      from relations r join items i on i.id = r.target_id
     where i.owner_id = ${ownerId}
       and r.source_id = ${recordId}
       and r.match_state = 'confirmed'
       and r.role in ('project', 'contains')
  `);
  return new Set((res.rows as { id: string }[]).map((r) => r.id));
}

function recurrenceLabel(properties: unknown): string | null {
  const rule = parseRecurrence((properties as Record<string, unknown> | null)?.recurrence);
  return rule ? describeRule(rule) : null;
}

function row(i: Awaited<ReturnType<typeof queryViewItems>>[number]): WidgetItemRow {
  return {
    id: i.id,
    type: i.type,
    title: i.title,
    status: i.status,
    statusCategory: i.statusCategory,
    dueDate: i.dueDate,
    scheduledDate: i.scheduledDate,
    urgency: i.urgency,
    meetingAt: i.meetingAt,
    url: i.url ?? null,
    recurrence: recurrenceLabel(i.properties),
    image: i.type === "person" ? personImage(i.properties) : null,
  };
}

// Done tasks always sink to the bottom (Tyler, 2026-07-01); within each
// completion group, by effective date (scheduled ?? due) ascending, undated
// last. Exported so the card preview AND the full collection page order tasks
// the same way. Generic over anything carrying the three fields.
export function sortTasksDoneLast<T extends { statusCategory: string; scheduledDate: Date | null; dueDate: Date | null }>(
  rows: T[]
): T[] {
  const when = (r: T) => {
    const d = r.scheduledDate ?? r.dueDate;
    return d ? d.getTime() : Number.POSITIVE_INFINITY;
  };
  return [...rows].sort((a, b) => {
    const ad = a.statusCategory === "done" ? 1 : 0;
    const bd = b.statusCategory === "done" ? 1 : 0;
    if (ad !== bd) return ad - bd; // open (0) before done (1)
    return when(a) - when(b);
  });
}

// taskId → the milestone that task completes, over a record's milestones
// (ADR-196 "Completes with task"). Read from the milestone side (one bounded
// fetch + one states read), so the task surfaces in a record's context —
// the Tasks card and the full task list — can flag which milestone a task
// belongs to (Tyler, 2026-08-17: milestones ARE the task grouping; make the
// membership visible, subtly).
export async function milestoneFlagsFor(
  ownerId: string,
  recordId: string
): Promise<Map<string, { id: string; title: string }>> {
  const milestones = await queryViewItems(
    ownerId,
    { type: "milestone", relatedTo: recordId },
    { field: "dueDate", dir: "asc" },
    500
  );
  const flags = new Map<string, { id: string; title: string }>();
  if (milestones.length === 0) return flags;
  const states = await milestoneStates(ownerId, milestones);
  for (const m of milestones) {
    const taskId = states.get(m.id)?.task?.id;
    if (taskId && !flags.has(taskId)) flags.set(taskId, { id: m.id, title: m.title });
  }
  return flags;
}

// The bound filter for a collection/relation widget: items related to this
// record. Contained collections (role "project"/"contains") are home-scoped
// (what LIVES here); people/related are direction-blind associations. Exported
// so the collection drill-down page resolves the same query the card previews.
export function boundFilter(def: WidgetDefinition, recordId: string): ViewFilter | null {
  const q = def.recordQuery;
  if (!q) return null;
  const filter: ViewFilter = { relatedTo: recordId };
  // A typed collection box (Tasks, Docs, Meetings, Milestones, Links, People)
  // shows every item of that type ASSOCIATED with this record, however it was
  // linked — role- and home-agnostic (Tyler, 2026-07-01: "the box should pull
  // anything of that type that is associated with the project"). A link related
  // from the Links page, a task assigned via the field/picker, a note contained
  // via the record — all count. relatedTo matches confirmed edges in either
  // direction, so this is exactly "of this type AND connected to this record".
  if (q.collectionType) {
    filter.type = q.collectionType;
    return filter;
  }
  // The generic contained-records box (relatedRecords / a Pursuit's projects)
  // keeps home/role scoping — what LIVES here, not just anything related.
  if (q.role) filter.relatedRole = q.role;
  if (q.role && q.role !== "related") filter.relatedHome = true;
  return filter;
}

async function dataForWidget(
  ownerId: string,
  record: LoadedRecord,
  instance: RecordWidget,
  def: WidgetDefinition,
  // The record's contained-item ids, resolved once for the whole page.
  contained: Set<string>
): Promise<RecordWidgetData> {
  const base: RecordWidgetData = { instance, def };

  // Property widgets read the record base.
  if (def.id === "status") {
    return { ...base, status: { key: record.status, category: record.statusCategory } };
  }
  if (def.id === "overview") return base; // canvas reads record.body directly
  // Properties: the canvas reads the type's propertySchema + the record's own
  // properties object directly, the same way the markdown canvas does.
  if (def.id === "properties") return base;

  // Derived widgets.
  if (def.id === "nextAction") {
    // Own pinned Next Action, else roll up: the single next step across the
    // contained projects (the first project that has one) — PJ9.
    if (record.nextActionTaskId || record.nextActionText) {
      let taskTitle: string | null = null;
      let done = false;
      if (record.nextActionTaskId) {
        const t = await getItem(ownerId, record.nextActionTaskId).catch(() => null);
        taskTitle = t?.title ?? null;
        done = t?.statusCategory === "done";
      }
      return {
        ...base,
        nextAction: { text: record.nextActionText ?? null, taskId: record.nextActionTaskId ?? null, taskTitle, done },
      };
    }
    const projects = await containedProjects(ownerId, record.id);
    for (const p of projects) {
      const proj = await getItem(ownerId, p.id).catch(() => null);
      if (proj?.nextActionTaskId || proj?.nextActionText) {
        let taskTitle: string | null = null;
        if (proj.nextActionTaskId) {
          const t = await getItem(ownerId, proj.nextActionTaskId).catch(() => null);
          taskTitle = t?.title ?? null;
        }
        return {
          ...base,
          nextAction: { text: proj.nextActionText ?? null, taskId: proj.nextActionTaskId ?? null, taskTitle, done: false },
        };
      }
    }
    return { ...base, nextAction: { text: null, taskId: null, taskTitle: null, done: false } };
  }
  if (def.id === "progress") {
    // Roll-up (PJ9): a record that contains projects (a Pursuit) shows the
    // average of its projects' fractions — done = # projects fully complete,
    // total = # projects. Otherwise the record's own weighted-points progress.
    const projects = await containedProjects(ownerId, record.id);
    if (projects.length > 0) {
      const child = await Promise.all(projects.map((p) => recordPointProgress(ownerId, p.id)));
      const fracs = child.map((c) => c.fraction).filter((f): f is number => f !== null);
      const done = child.filter((c) => c.fraction === 1).length;
      return {
        ...base,
        progress: { done, total: projects.length, fraction: fracs.length ? fracs.reduce((a, b) => a + b, 0) / fracs.length : null },
      };
    }
    return { ...base, progress: await recordPointProgress(ownerId, record.id) };
  }
  if (def.id === "recentActivity") {
    // Roll-up (PJ9): a Pursuit's timeline is the union of its own + its projects'
    // logs. A plain record just reads its own (subjects = [itself]).
    const projects = await containedProjects(ownerId, record.id);
    const subjects = [record.id, ...projects.map((p) => p.id)];
    const events =
      subjects.length === 1
        ? await listActivity(ownerId, record.id, ACTIVITY_LIMIT)
        : await listActivityForSubjects(ownerId, subjects, ACTIVITY_LIMIT);
    return {
      ...base,
      // checkin_reviewed is plumbing (the view beacon's staleness reset,
      // 2026-08-17), not narrative — a daily "Reviewed" line would drown the
      // card. It stays in the log; it just doesn't display here.
      activity: events
        .filter((e) => e.kind !== "checkin_reviewed")
        .map((e) => ({ id: e.id, kind: e.kind, summary: e.summary, occurredAt: e.occurredAt })),
    };
  }

  // relatedRecords: every contained record (home), any type.
  if (def.id === "relatedRecords") {
    const related = await listRelatedItems(ownerId, record.id).catch(() => []);
    const typeFilter = (instance.options?.typeFilter as string | null | undefined) ?? null;
    const home = related
      .filter((r) => (r as { home?: boolean }).home)
      .filter((r) => (typeFilter ? r.type === typeFilter : true));
    const mapped = home.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      status: r.status,
      statusCategory: r.statusCategory,
      dueDate: r.dueDate,
      scheduledDate: r.scheduledDate,
      urgency: r.urgency,
      meetingAt: r.meetingAt,
      url: (r as { url?: string | null }).url ?? null,
      recurrence: null,
      // listRelatedItems rows are body/property-free; the contained-records box
      // doesn't render avatars anyway.
      image: null,
    }));
    // Preview cap (Tyler, 2026-07-01): show `limit`, keep the true count for the
    // "Showing N of M →" drill-down.
    return { ...base, items: mapped.slice(0, widgetLimit(instance)), count: mapped.length };
  }

  // files (ADR-236): the record's attachments, upload order. All rows come
  // back — a record rarely carries many files, and the panel has no preview cap.
  if (def.id === "files") {
    const files = await listAttachments(ownerId, record.id);
    files.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return {
      ...base,
      files: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
      })),
      count: files.length,
    };
  }

  if (def.id === "timeline") {
    // Read-only overlay of the record's Meetings + Milestones by date (PRD §6) —
    // the two collections shown together without merging their data. Same
    // home-agnostic association the Meetings/Milestones boxes use (boundFilter):
    // home-only scoping left milestones that were related-but-not-contained off
    // the timeline while showing in their box (bug, Tyler 2026-08-17).
    //
    // A milestone plots at its due date, or — undated but finished — at its
    // completion stamp, so completing an undated milestone moves it from the
    // "Uncompleted" tail onto the axis (Tyler, 2026-08-17). The card previews a
    // window around today (upcoming first, backfilled with the most recent
    // past), capped by the hover gear's limit; the full set lives at
    // /items/[id]/timeline.
    const [events, milestones] = await Promise.all([
      queryViewItems(ownerId, { type: "event", relatedTo: record.id }, { field: "meetingAt", dir: "asc" }, 200),
      queryViewItems(ownerId, { type: "milestone", relatedTo: record.id }, { field: "dueDate", dir: "asc" }, 200),
    ]);
    const states = await milestoneStates(ownerId, milestones);
    const dated = [
      ...events
        .map((e) => ({ id: e.id, title: e.title, kind: "meeting" as const, date: e.meetingAt ?? e.scheduledDate ?? e.dueDate }))
        .filter((x): x is { id: string; title: string; kind: "meeting"; date: Date } => x.date != null),
      ...milestones
        .map((m) => {
          const s = states.get(m.id);
          const date = m.dueDate ?? s?.completedAt ?? null;
          return date ? { id: m.id, title: m.title, kind: "milestone" as const, date, done: s?.done ?? false } : null;
        })
        .filter((x): x is { id: string; title: string; kind: "milestone"; date: Date; done: boolean } => x != null),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    const undated = milestones
      .filter((m) => {
        const s = states.get(m.id);
        return !m.dueDate && !(s?.done && s.completedAt);
      })
      .map((m) => ({ id: m.id, title: m.title }));

    const limit = widgetLimit(instance);
    let shown = dated;
    if (Number.isFinite(limit) && dated.length > limit) {
      const now = Date.now();
      const futureStart = dated.findIndex((e) => e.date.getTime() >= now);
      const split = futureStart === -1 ? dated.length : futureStart;
      const takeFuture = Math.min(dated.length - split, limit);
      const takePast = Math.min(split, limit - takeFuture);
      shown = dated.slice(split - takePast, split + takeFuture);
    }
    const undatedShown = Number.isFinite(limit) ? undated.slice(0, limit) : undated;
    return {
      ...base,
      timeline: shown,
      timelineUndated: undatedShown,
      count: dated.length + undated.length,
    };
  }

  // Collection + people widgets: a bound query. The card shows only a PREVIEW —
  // `limit` rows (the hover gear's options.limit, default 5) — while `count` is
  // the true total, so the card can offer "Showing 5 of 20 →" into the full
  // collection page. People is the header chip row (no card, no gear), so it's
  // never capped. We fetch a headroom window and slice, so the task done-sink
  // sort can run over more than just the previewed rows.
  const filter = boundFilter(def, record.id);
  if (filter) {
    // Done tasks disappear from the card, count included (Tyler, 2026-08-17) —
    // the box previews what's left to do. The full set stays one click away on
    // the collection drill-down page, which builds its own unfiltered query.
    if (def.recordQuery?.collectionType === "task") filter.statusCategory = "active";
    const limit = def.id === "people" ? COLLECTION_LIMIT : widgetLimit(instance);
    // The gear's "All" reads as limit = Infinity; widen the fetch window (still
    // bounded) instead of the usual 50-row headroom.
    const fetchLimit = Number.isFinite(limit) ? COLLECTION_LIMIT : 500;
    const [rows, count] = await Promise.all([
      queryViewItems(ownerId, filter, { field: "updatedAt", dir: "desc" }, fetchLimit),
      countViewItems(ownerId, filter),
    ]);
    let mapped = rows.map(row).map((m) => ({ ...m, contained: contained.has(m.id) }));
    if (def.recordQuery?.collectionType === "task") mapped = sortTasksDoneLast(mapped);
    if (def.recordQuery?.collectionType === "milestone") {
      // Resolve each milestone's mode + completion (manual / linked task /
      // date) and its explicit share, so the widget renders the right
      // affordance without re-querying.
      const states = await milestoneStates(ownerId, rows);
      mapped = mapped.map((m) => {
        const s = states.get(m.id);
        return s
          ? {
              ...m,
              milestone: {
                mode: s.mode,
                done: s.done,
                via: s.via,
                taskId: s.task?.id ?? null,
                taskTitle: s.task?.title ?? null,
                taskDone: s.task?.done ?? false,
                pct: s.pct,
              },
            }
          : m;
      });
    }
    let preview = mapped.slice(0, limit);
    let doneCount: number | undefined;
    if (def.recordQuery?.collectionType === "task") {
      if (preview.length > 0) {
        // Subtask rollups for the previewed rows only (one grouped query), so
        // the card can render the expandable "n/m" pill without paying for rows
        // it doesn't show.
        const rollups = await childRollups(ownerId, preview.map((r) => r.id));
        preview = preview.map((r) => {
          const p = rollups.get(r.id);
          return p ? { ...r, subtasks: p } : r;
        });
        // The milestone each previewed task completes (ADR-196 link), so a row
        // can wear its subtle milestone flag. One bounded fetch + one states
        // read, shared with what the Milestones card fetches anyway.
        const flags = await milestoneFlagsFor(ownerId, record.id);
        preview = preview.map((r) => {
          const m = flags.get(r.id);
          return m ? { ...r, completesMilestone: m } : r;
        });
      }
      // Done tasks left the card's rows (statusCategory: "active" above); this
      // is their count, backing the "N tasks completed" link.
      const doneFilter = boundFilter(def, record.id);
      if (doneFilter) {
        doneFilter.statusCategory = "done";
        doneCount = await countViewItems(ownerId, doneFilter);
      }
    }
    return { ...base, items: preview, count, ...(doneCount !== undefined ? { doneCount } : {}) };
  }

  // timeline + any unmapped derived: leave for PJ6/PJ11; render an empty state.
  return base;
}

// Resolve the data for every VISIBLE widget in the composition, in order.
// Hidden widgets (Layer-3 disabled) are skipped — their backing items are
// untouched, so re-enabling restores them.
export async function resolveRecordWidgets(
  ownerId: string,
  record: LoadedRecord,
  composition: Composition
): Promise<RecordWidgetData[]> {
  const visible = composition.widgets.filter((iw) => !iw.hidden);
  const contained = await containedIds(ownerId, record.id);
  return Promise.all(
    visible.map(async (instance) => {
      let def = widgetById(instance.defId);
      if (!def) return null;
      // A custom-type tool's synthetic def carries a placeholder label; dress
      // it with the type's real one. A deleted/hidden type retires the card
      // (the instance stays in the composition — restore the type, it returns).
      const customKey = customToolTypeKey(def.id);
      if (customKey) {
        const t = await getType(customKey).catch(() => null);
        if (!t || t.hidden) return null;
        def = { ...def, label: t.label };
      }
      return dataForWidget(ownerId, record, instance, def, contained);
    })
  ).then((arr) => arr.filter((x): x is RecordWidgetData => x !== null));
}
