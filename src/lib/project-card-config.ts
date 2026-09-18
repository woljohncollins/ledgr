// Project-card element config (Tyler, 2026-08-17): which tools a project card
// shows, wherever project cards render — the Recent-style grid on /list/project
// and any saved view (list or board layout) scoped to projects. Pure and
// client-safe (the builder panels import it).
//
// Two storage layers, resolved view → type → default:
//   - Type default: users.settings.cardsByType["project"] (Build → Types →
//     Project → "Card elements"; same settings posture as listTabs/tocByType —
//     no schema change).
//   - Per-view override: views.display.card (the view builder's card panel),
//     so one board can run leaner cards than the grid.
// An ABSENT config means the default card (the classic grid card: status,
// counts, progress, people). An EMPTY show list is a real choice — title-only
// cards — so parse preserves it rather than collapsing to null.

export const PROJECT_CARD_ELEMENTS = [
  { key: "status", label: "Status pill" },
  { key: "counts", label: "Item counts (tasks · milestones · meetings)" },
  { key: "progress", label: "Progress bar" },
  { key: "people", label: "People" },
  { key: "links", label: "Key links" },
  { key: "timeline", label: "Timeline button" },
] as const;

export type ProjectCardElement = (typeof PROJECT_CARD_ELEMENTS)[number]["key"];

export type ProjectCardConfig = { show: ProjectCardElement[] };

// The classic grid card, unchanged for anyone who never opens the config.
export const DEFAULT_PROJECT_CARD: ProjectCardConfig = {
  show: ["status", "counts", "progress", "people"],
};

const ELEMENT_KEYS = new Set<string>(PROJECT_CARD_ELEMENTS.map((e) => e.key));

// Tolerant parse (bad shape → null = "no override"), deduped, catalog order —
// the show list is a set, not an ordering; the card lays elements out itself.
export function parseProjectCardConfig(raw: unknown): ProjectCardConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.show)) return null;
  const picked = new Set<string>();
  for (const entry of r.show) {
    if (typeof entry === "string" && ELEMENT_KEYS.has(entry)) picked.add(entry);
  }
  return {
    show: PROJECT_CARD_ELEMENTS.filter((e) => picked.has(e.key)).map((e) => e.key),
  };
}

// settings.cardsByType: per-type card overrides keyed by type key (only
// "project" today; the key space leaves room for pursuit later). Same tolerant
// posture as parseTocByType — an unparsable entry is dropped.
export function parseCardsByType(raw: unknown): Record<string, ProjectCardConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ProjectCardConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const cfg = parseProjectCardConfig(value);
    if (cfg) out[key] = cfg;
  }
  return out;
}

export function cardShows(config: ProjectCardConfig, el: ProjectCardElement): boolean {
  return config.show.includes(el);
}

// view display.card → type default → the classic card.
export function resolveProjectCardConfig(
  viewCard: ProjectCardConfig | null | undefined,
  typeDefault: ProjectCardConfig | undefined
): ProjectCardConfig {
  return viewCard ?? typeDefault ?? DEFAULT_PROJECT_CARD;
}
