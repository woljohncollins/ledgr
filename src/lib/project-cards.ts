// Card data for project cards (Tyler, 2026-07-01; configurable elements
// 2026-08-17): given project rows already queried by a list surface, produce
// each card's status, progress, people, collection counts, and — when the
// resolved element config asks for them — key links. Server-only.
//
// Progress here is a *flat* pass of the weighted-points model — tasks count as
// done/not-done without the per-task subtree probe the record canvas does — so a
// grid of many projects stays cheap (a card is a glance; the open project shows
// the precise bar). Perf note: this runs ~4 bounded queries per project (5 with
// the links element on); if the project count grows large, batch these into
// grouped queries (see next_steps).
import { personImage } from "@/lib/person-image";
import {
  applyMilestoneShares,
  combineProgress,
  meetingPoints,
  taskPoints,
  type PointProgress,
} from "@/lib/project-progress";
import { milestoneProgressParts } from "@/lib/milestones";
import {
  cardShows,
  resolveProjectCardConfig,
  type ProjectCardConfig,
} from "@/lib/project-card-config";
import { getSettings } from "@/lib/settings";
import { statusSchemaForType } from "@/lib/status-schema";
import { queryViewItems, type ViewDefinition } from "@/lib/views";

export type ProjectCard = {
  id: string;
  title: string;
  status: { label: string; color: string; category: string } | null;
  progress: PointProgress;
  people: { id: string; title: string; image: string | null }[];
  counts: { tasks: number; milestones: number; meetings: number };
  // Key links (the "links" card element): the record's most recent link items.
  // Empty when the element is off (not fetched) or the project has none.
  links: { id: string; title: string; url: string | null }[];
  // Starred via ⋯ → favorite (settings.favorites). Visual only for now (Tyler,
  // 2026-08-17): the card wears a star + a subtle highlight; no reordering.
  favorited: boolean;
};

type ProjectRow = { id: string; title: string; status: string; statusCategory: string };

// How many key-link chips a card carries; the card is a glance, not the Links box.
const CARD_LINKS_LIMIT = 3;

async function cardData(
  ownerId: string,
  project: ProjectRow,
  statusColor: (key: string) => { label: string; color: string; category: string } | null,
  withLinks: boolean,
  favorites: ReadonlySet<string>
): Promise<ProjectCard> {
  const [tasks, milestones, meetings, people, links] = await Promise.all([
    // Everything associated with the project (any relation) — matches the canvas
    // boxes (boundFilter): all tasks/milestones/meetings/people connected to it.
    queryViewItems(ownerId, { type: "task", relatedTo: project.id }, { field: "createdAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "milestone", relatedTo: project.id }, { field: "dueDate", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "event", relatedTo: project.id }, { field: "meetingAt", dir: "asc" }, 500),
    queryViewItems(ownerId, { type: "person", relatedTo: project.id }, { field: "updatedAt", dir: "desc" }, 12),
    withLinks
      ? queryViewItems(ownerId, { type: "link", relatedTo: project.id }, { field: "updatedAt", dir: "desc" }, CARD_LINKS_LIMIT)
      : Promise.resolve([]),
  ]);
  const now = Date.now();
  // Milestones complete by checkbox / linked task / date (ADR-196); explicit
  // `points` percents overlay the pooled bar as shares — same math as the
  // record canvas, so a card and its open project agree.
  const { pool: msParts, shares } = await milestoneProgressParts(ownerId, milestones);
  const progress = applyMilestoneShares(
    combineProgress([
      ...tasks.map((t) => taskPoints(t.statusCategory === "done" ? 1 : 0, 0)),
      ...msParts,
      ...meetings.map((e) => {
        const when = e.meetingAt ?? e.scheduledDate ?? e.dueDate;
        return meetingPoints(when ? when.getTime() < now : false);
      }),
    ]),
    shares
  );
  return {
    id: project.id,
    title: project.title,
    status: statusColor(project.status),
    progress,
    people: people.map((p) => ({ id: p.id, title: p.title, image: personImage(p.properties) })),
    counts: { tasks: tasks.length, milestones: milestones.length, meetings: meetings.length },
    links: links.map((l) => ({ id: l.id, title: l.title, url: l.url ?? null })),
    favorited: favorites.has(project.id),
  };
}

export async function listProjectCardData(
  ownerId: string,
  projects: ProjectRow[],
  config?: ProjectCardConfig,
  favorites?: ReadonlySet<string>
): Promise<ProjectCard[]> {
  const schema = await statusSchemaForType("project");
  const statusColor = (key: string) => {
    const def = schema.find((s) => s.key === key);
    return def ? { label: def.label, color: def.color, category: def.category } : null;
  };
  const withLinks = config ? cardShows(config, "links") : false;
  const favs = favorites ?? new Set<string>();
  return Promise.all(projects.map((p) => cardData(ownerId, p, statusColor, withLinks, favs)));
}

export type ViewProjectCards = {
  config: ProjectCardConfig;
  byId: Record<string, ProjectCard>;
};

// Whether a saved view renders project cards at all: scoped to projects, on a
// card-capable layout. Client-safe callers gate the select toggle on the same
// rule via layout alone; this is the server-side decision point.
export function viewRendersProjectCards(view: ViewDefinition): boolean {
  return (
    view.filter.type === "project" &&
    (view.layout === "list" || view.layout === "board")
  );
}

// Resolve everything a view surface needs to render rich project cards, or null
// when the view isn't a project-card surface. One settings read + the per-card
// fan-out above.
export async function projectCardsForView(
  ownerId: string,
  view: ViewDefinition,
  items: ProjectRow[]
): Promise<ViewProjectCards | null> {
  if (!viewRendersProjectCards(view)) return null;
  const settings = await getSettings(ownerId);
  const config = resolveProjectCardConfig(view.display?.card, settings.cardsByType["project"]);
  const cards = await listProjectCardData(ownerId, items, config, new Set(settings.favorites));
  const byId: Record<string, ProjectCard> = {};
  for (const c of cards) byId[c.id] = c;
  return { config, byId };
}
