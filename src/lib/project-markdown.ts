// The project markdown document (Tyler, 2026-08-17, finalized same day — see
// explorations/project-markdown-file.md and ADR-197): a whole project rendered
// as ONE readable markdown file. Summary → People → Milestones → Meetings →
// Links → Tasks → Timeline (Tyler's order), so someone can read (or be handed)
// the story of a project without opening Ledgr.
//
// A DERIVED PROJECTION, never a stored copy (Principle 1: DB canonical,
// markdown one-way). The document is composed on demand from the project's
// current state, exactly like a chord chart renders from a song's body; the
// only text the owner edits is the Overview, which IS the project's body and
// lands here verbatim as the Summary. Nothing writes this output anywhere.
//
// Split pure/server the usual way: composeProjectMarkdown is a pure string
// builder (unit-verified in scripts/verify-project-markdown.mts), and
// buildProjectMarkdown gathers the collections and feeds it.
import { bodyMarkdown } from "@/lib/body";
import { getItem } from "@/lib/items";
import { milestoneStates } from "@/lib/milestones";
import { getAppTimezone } from "@/lib/today";
import { queryViewItems } from "@/lib/views";

export type ProjectMarkdownInput = {
  title: string;
  // The Overview body, verbatim (may be empty).
  summary: string;
  timezone: string;
  people: { title: string }[];
  milestones: {
    title: string;
    dueDate: Date | null;
    done: boolean;
    completedAt: Date | null;
    pct: number;
    taskTitle: string | null;
  }[];
  meetings: { title: string; when: Date | null }[];
  links: { title: string; url: string | null }[];
  tasks: { title: string; done: boolean; createdAt: Date; completedAt: Date | null }[];
  // Pre-labeled dated history lines; composed sorted ascending.
  timeline: { date: Date; label: string }[];
};

// Calendar-day columns (due dates, created dates) are stored UTC-midnight, so
// they format in UTC; real timestamps (meeting times) format in the owner's
// timezone. Two formatters on purpose — one wrong "today" boundary reads as a
// bug in every export.
function day(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function dayTime(d: Date, tz: string): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

const esc = (s: string) => (s.trim() ? s.trim() : "Untitled");

export function composeProjectMarkdown(input: ProjectMarkdownInput): string {
  const out: string[] = [`# ${esc(input.title)}`];

  if (input.summary.trim()) out.push("", input.summary.trim());

  if (input.people.length > 0) {
    out.push("", "## People", "");
    for (const p of input.people) out.push(`- ${esc(p.title)}`);
  }

  if (input.milestones.length > 0) {
    out.push("", "## Milestones", "");
    for (const m of input.milestones) {
      const bits: string[] = [];
      if (m.dueDate) bits.push(`due ${day(m.dueDate)}`);
      if (m.done && m.completedAt) bits.push(`completed ${day(m.completedAt)}`);
      if (!m.done && m.taskTitle) bits.push(`completes with “${m.taskTitle}”`);
      if (m.pct > 0) bits.push(`${m.pct}% of project`);
      out.push(`- [${m.done ? "x" : " "}] ${esc(m.title)}${bits.length ? ` — ${bits.join(" · ")}` : ""}`);
    }
  }

  if (input.meetings.length > 0) {
    out.push("", "## Meetings", "");
    for (const e of input.meetings) {
      out.push(`- ${esc(e.title)}${e.when ? ` — ${dayTime(e.when, input.timezone)}` : ""}`);
    }
  }

  if (input.links.length > 0) {
    out.push("", "## Links", "");
    for (const l of input.links) {
      // The URL itself lands in the file so the link is clickable anywhere the
      // markdown is read (Tyler).
      out.push(l.url ? `- [${esc(l.title)}](${l.url})` : `- ${esc(l.title)}`);
    }
  }

  if (input.tasks.length > 0) {
    out.push("", "## Tasks", "");
    for (const t of input.tasks) {
      const bits = [`added ${day(t.createdAt)}`];
      if (t.done && t.completedAt) bits.push(`completed ${day(t.completedAt)}`);
      out.push(`- [${t.done ? "x" : " "}] ${esc(t.title)} — ${bits.join(" · ")}`);
    }
  }

  if (input.timeline.length > 0) {
    out.push("", "## Timeline", "");
    const sorted = [...input.timeline].sort((a, b) => a.date.getTime() - b.date.getTime());
    for (const e of sorted) out.push(`- ${day(e.date)} — ${e.label}`);
  }

  return out.join("\n") + "\n";
}

// A task's completion date: the ADR-197 stamp, else — for tasks finished
// before stamping existed — its last write, which for most done tasks was the
// completing one (approximate, noted in the exploration).
function taskCompletedAt(properties: unknown, done: boolean, updatedAt: Date): Date | null {
  if (!done) return null;
  const raw = (properties as Record<string, unknown> | null)?.completed_at;
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return updatedAt;
}

type LoadedRecord = Awaited<ReturnType<typeof getItem>>;

// Gather the record's collections (same home-agnostic association every widget
// box uses) and compose. Bounded fan-out: 500 rows per collection, one
// relations query for the milestone states.
export async function buildProjectMarkdown(ownerId: string, record: LoadedRecord): Promise<string> {
  const [people, milestones, meetings, links, tasks, notes, timezone] = await Promise.all([
    queryViewItems(ownerId, { type: "person", relatedTo: record.id }, { field: "updatedAt", dir: "desc" }, 50),
    queryViewItems(ownerId, { type: "milestone", relatedTo: record.id }, { field: "dueDate", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "event", relatedTo: record.id }, { field: "meetingAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "link", relatedTo: record.id }, { field: "createdAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "task", relatedTo: record.id }, { field: "createdAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "note", relatedTo: record.id }, { field: "createdAt", dir: "asc" }, 500),
    getAppTimezone(ownerId),
  ]);
  const states = await milestoneStates(ownerId, milestones);

  const timeline: { date: Date; label: string }[] = [];
  for (const e of meetings) {
    const when = e.meetingAt ?? e.scheduledDate ?? e.dueDate;
    if (when) timeline.push({ date: when, label: `Meeting: ${esc(e.title)}` });
  }
  for (const m of milestones) {
    const s = states.get(m.id);
    if (s?.done && s.completedAt) timeline.push({ date: s.completedAt, label: `Milestone completed: ${esc(m.title)}` });
    else if (m.dueDate) timeline.push({ date: m.dueDate, label: `Milestone due: ${esc(m.title)}` });
  }
  for (const t of tasks) {
    const done = t.statusCategory === "done";
    const at = taskCompletedAt(t.properties, done, t.updatedAt);
    if (done && at) timeline.push({ date: at, label: `Task completed: ${esc(t.title)}` });
  }
  for (const n of notes) {
    timeline.push({ date: n.noteDate ?? n.createdAt, label: `Note: ${esc(n.title)}` });
  }

  return composeProjectMarkdown({
    title: record.title,
    summary: bodyMarkdown(record.body),
    timezone,
    people: [...people].sort((a, b) => a.title.localeCompare(b.title)),
    milestones: milestones.map((m) => {
      const s = states.get(m.id);
      return {
        title: m.title,
        dueDate: m.dueDate,
        done: s?.done ?? false,
        completedAt: s?.completedAt ?? null,
        pct: s?.pct ?? 0,
        taskTitle: s?.task?.title ?? null,
      };
    }),
    meetings: meetings.map((e) => ({ title: e.title, when: e.meetingAt ?? e.scheduledDate ?? e.dueDate })),
    links: links.map((l) => ({ title: l.title, url: l.url ?? null })),
    tasks: tasks.map((t) => {
      const done = t.statusCategory === "done";
      return { title: t.title, done, createdAt: t.createdAt, completedAt: taskCompletedAt(t.properties, done, t.updatedAt) };
    }),
    timeline,
  });
}
