// Auto-link tasks to projects by title (2026-09-22, John: "I want all projects
// to grab tasks even if I forget to list that — based on if it has the project
// abbreviation or name in the title").
//
// A task with no `project` edge is matched against every live, not-done project:
//   - the project's title, the title with a trailing year stripped ("Reverb 2026"
//     → "Reverb"), and the segment before an em-dash / dash / colon ("YES — Youth
//     Emphasis Sunday" → "YES");
//   - anything listed in the project's `aliases` property, comma-separated
//     ("TI, Teens Involved").
// Terms match on word boundaries, case-insensitively — except a short all-caps
// term (≤ 4 letters, e.g. "YES", "LDC", "TI") which must appear in caps, so the
// word "yes" in an ordinary task title doesn't file it under Youth Emphasis
// Sunday. The longest matching term wins; on a tie the first project listed.
// Best-effort everywhere: a failure here never fails the capture that called it.
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items, relations } from "@/db/schema";
import { relateItems } from "@/lib/relations";

export const PROJECT_ALIASES_KEY = "aliases";

type ProjectTerm = { projectId: string; term: string; caseSensitive: boolean };

function stripYear(s: string): string {
  return s.replace(/\s+(19|20)\d{2}\s*$/u, "").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function termsForProject(p: {
  id: string;
  title: string;
  properties: unknown;
}): ProjectTerm[] {
  const raw = new Set<string>();
  const title = (p.title ?? "").trim();
  if (title) {
    raw.add(title);
    raw.add(stripYear(title));
    const head = title.split(/\s+[—–-]\s+|:\s+/u)[0]?.trim();
    if (head) {
      raw.add(head);
      raw.add(stripYear(head));
    }
  }
  const props = (p.properties ?? {}) as Record<string, unknown>;
  const aliases = props[PROJECT_ALIASES_KEY];
  if (typeof aliases === "string") {
    for (const a of aliases.split(/[,;\n]/)) {
      const t = a.trim();
      if (t) raw.add(t);
    }
  }
  return [...raw]
    .filter((t) => t.length >= 2)
    .map((term) => ({
      projectId: p.id,
      term,
      caseSensitive: term.length <= 4 && term === term.toUpperCase() && /[A-Z]/.test(term),
    }));
}

export function matchProject(title: string, terms: ProjectTerm[]): string | null {
  let best: ProjectTerm | null = null;
  for (const t of terms) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(t.term)}(?=$|[^A-Za-z0-9])`, t.caseSensitive ? "u" : "iu");
    if (!re.test(title)) continue;
    if (!best || t.term.length > best.term.length) best = t;
  }
  return best?.projectId ?? null;
}

async function liveProjects(ownerId: string) {
  return getDb()
    .select({ id: items.id, title: items.title, properties: items.properties })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, "project"),
        isNull(items.deletedAt),
        eq(items.isTemplate, false),
        ne(items.statusCategory, "done"),
        ne(items.statusCategory, "archived")
      )
    )
    .orderBy(items.createdAt);
}

async function hasProjectEdge(taskId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: relations.id })
    .from(relations)
    .where(and(eq(relations.sourceId, taskId), eq(relations.role, "project")))
    .limit(1);
  return rows.length > 0;
}

/** Link one task to a project by its title, if it has no project yet. Returns the project id linked, or null. */
export async function autoLinkTaskToProject(
  ownerId: string,
  taskId: string,
  title: string
): Promise<string | null> {
  if (!title?.trim()) return null;
  if (await hasProjectEdge(taskId)) return null;
  const projects = await liveProjects(ownerId);
  const terms = projects.flatMap(termsForProject);
  const projectId = matchProject(title, terms);
  if (!projectId) return null;
  await relateItems(ownerId, taskId, projectId, "project");
  return projectId;
}

/** Backfill: walk every open task without a project edge. Returns what was linked. */
export async function autoLinkAllTasks(ownerId: string, opts: { includeDone?: boolean } = {}) {
  const projects = await liveProjects(ownerId);
  const terms = projects.flatMap(termsForProject);
  const nameOf = new Map(projects.map((p) => [p.id, p.title]));
  const doneFilter = opts.includeDone ? sql`true` : ne(items.statusCategory, "done");
  const tasks = await getDb()
    .select({ id: items.id, title: items.title })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, "task"),
        isNull(items.deletedAt),
        eq(items.isTemplate, false),
        doneFilter,
        sql`not exists (select 1 from ${relations} r where r.source_id = ${items.id} and r.role = 'project')`
      )
    );
  const linked: { taskId: string; title: string; projectId: string; project: string }[] = [];
  for (const t of tasks) {
    const projectId = matchProject(t.title ?? "", terms);
    if (!projectId) continue;
    try {
      await relateItems(ownerId, t.id, projectId, "project");
      linked.push({ taskId: t.id, title: t.title, projectId, project: nameOf.get(projectId) ?? "" });
    } catch {
      // best-effort
    }
  }
  return { scanned: tasks.length, linked };
}
