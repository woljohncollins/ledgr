// The universal command palette's index + ranking (ADR-063). One palette serves
// both modes (Work and Build) and searches everything: items (content, via the
// FTS API), built-in pages, saved views, item types, Build/Maintain sections,
// and named user settings. This module is the pure, node-testable core — the
// entry builders and the context-aware ranking — with no React or fetch in it.
//
// The result model is a union from the start (`destination | action`) so adding
// command-results later ("New Sermon", "Clean up unused") is a populate, not a
// refactor. Only `destination` results are produced this phase.
import { BUILD_ENTRIES } from "@/lib/build-nav";

// Which mode the palette opened in. The active mode only shifts ranking — the
// same entries are always searchable from both sides.
export type CommandMode = "work" | "build";

// Result groups, in no particular order here (display order is per-mode, see
// groupOrder). "Pages" = built-in Work pages; "Build & Settings" = Build/Maintain
// sections plus named user settings.
export const COMMAND_GROUPS = [
  "Items",
  "Pages",
  "Views",
  "Types",
  "Build & Settings",
  "Actions",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export type CommandResult =
  | {
      kind: "destination";
      id: string;
      group: CommandGroup;
      label: string;
      sublabel?: string;
      href: string;
      icon: string;
      // Extra words that should find this entry, for the case where the thing
      // someone types is not what the entry is called (ADR-189: "help" and
      // "docs" must reach the User Guide). Matched exactly like the label, and
      // scored the same — a keyword hit is not a weaker hit.
      keywords?: string[];
    }
  | {
      kind: "action";
      id: string;
      group: "Actions";
      label: string;
      sublabel?: string;
      icon: string;
      actionId: string;
    };

// The builders below only ever produce destinations this phase (the action
// variant is the populate-later seam), so they return the narrowed type.
export type DestinationResult = Extract<CommandResult, { kind: "destination" }>;

// Built-in Work pages worth jumping to. These exist as routes, so none dead-links.
// Advanced search is deliberately NOT a row here: the palette carries a permanent
// footer button for it instead (CommandPalette), which is always visible and
// carries the typed query across via ?q=. A row would be a second, worse door to
// the same place — it would compete for the arrow-key selection and lose the query.
const BUILTIN_PAGES: { label: string; href: string; icon: string }[] = [
  { label: "Inbox", href: "/inbox", icon: "inbox" },
  { label: "Tasks", href: "/tasks", icon: "tasks" },
  { label: "Dashboards", href: "/dashboards", icon: "dashboard" },
  { label: "All items", href: "/items", icon: "items" },
  { label: "Trash", href: "/trash", icon: "archive" },
  { label: "Changelog", href: "/changelog", icon: "changelog" },
];

// Named user settings. They all live on /settings for now (no in-page anchors
// wired yet), but indexing them by name means "trash retention" jumps there.
const SETTINGS_ENTRIES: { label: string; icon: string }[] = [
  { label: "Accent color", icon: "tools" },
  { label: "Trash retention", icon: "archive" },
  { label: "Nav position", icon: "grid" },
  { label: "Display name", icon: "person" },
];

// The static (data-independent) entries: pages, Build/Maintain sections, and
// named settings. Build sections come straight from build-nav.ts so the palette
// and the sidebar never drift.
export function staticCommandEntries(): DestinationResult[] {
  const pages: DestinationResult[] = BUILTIN_PAGES.map((p) => ({
    kind: "destination",
    id: `page:${p.href}`,
    group: "Pages",
    label: p.label,
    href: p.href,
    icon: p.icon,
  }));
  const sections: DestinationResult[] = BUILD_ENTRIES.map((e) => ({
    kind: "destination",
    id: `section:${e.href}`,
    group: "Build & Settings",
    label: e.label,
    sublabel: "Build",
    href: e.href,
    icon: e.icon,
    keywords: e.keywords,
  }));
  const settings: DestinationResult[] = SETTINGS_ENTRIES.map((s) => ({
    kind: "destination",
    id: `setting:${s.label}`,
    group: "Build & Settings",
    label: s.label,
    sublabel: "User Settings",
    href: "/settings",
    icon: s.icon,
  }));
  return [...pages, ...sections, ...settings];
}

// The dynamic entries from owner data. A type jumps to *editing* it in Build,
// or to its item list in Work (mode-aware href — the spec's "a type name jumps
// to editing it" in Build, content elsewhere). Views open to run; a template
// opens its prototype item's canvas — the same target the templates index links
// to (ADR-093), since a template *is* a real item and has no separate editor.
export function dynamicCommandEntries(
  data: {
    types: { key: string; label: string; icon: string | null }[];
    views: { id: string; name: string }[];
    templates: {
      id: string;
      name: string;
      type: string;
      prototypeItemId: string;
    }[];
  },
  mode: CommandMode
): DestinationResult[] {
  const types: DestinationResult[] = data.types.map((t) => ({
    kind: "destination",
    id: `type:${t.key}`,
    group: "Types",
    label: t.label,
    sublabel: mode === "build" ? "Edit type" : "View items",
    href: mode === "build" ? `/build/types/${t.key}/edit` : `/list/${t.key}`,
    icon: t.icon ?? "layers",
  }));
  const views: DestinationResult[] = data.views.map((v) => ({
    kind: "destination",
    id: `view:${v.id}`,
    group: "Views",
    label: v.name,
    href: `/views/${v.id}`,
    icon: "views",
  }));
  const templates: DestinationResult[] = data.templates.map((t) => ({
    kind: "destination",
    id: `template:${t.id}`,
    group: "Build & Settings",
    label: t.name,
    sublabel: `Template · ${t.type}`,
    href: `/items/${t.prototypeItemId}`,
    icon: "document",
  }));
  return [...types, ...views, ...templates];
}

// Match a query against a label. Higher is better; null means no match. Prefix
// beats word-boundary beats substring beats all-tokens-present, so "inb" surfaces
// Inbox above an item whose body merely contains "inbox".
export function matchScore(label: string, q: string): number | null {
  const l = label.toLowerCase();
  const query = q.trim().toLowerCase();
  if (!query) return 0;
  if (l.startsWith(query)) return 100;
  // Word-boundary prefix (e.g. "settings" matches "User Settings").
  if (l.split(/[\s&/·]+/).some((w) => w.startsWith(query))) return 80;
  if (l.includes(query)) return 55;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => l.includes(t))) return 35;
  return null;
}

// Per-mode group weight: in Work, content (items/pages/views) ranks higher; in
// Build, sections/settings/types do. Added to the match score so ranking shifts
// with the active mode without changing what's searchable.
function groupWeight(group: CommandGroup, mode: CommandMode): number {
  const work: Record<CommandGroup, number> = {
    Items: 30,
    Pages: 25,
    Views: 20,
    Types: 10,
    "Build & Settings": 5,
    Actions: 0,
  };
  const build: Record<CommandGroup, number> = {
    "Build & Settings": 30,
    Types: 25,
    Views: 15,
    Items: 10,
    Pages: 8,
    Actions: 0,
  };
  return (mode === "build" ? build : work)[group];
}

// The display order of groups for a mode (Items-first in Work, Build-first in
// Build). Groups with no matches are simply skipped by the renderer.
export function groupOrder(mode: CommandMode): CommandGroup[] {
  return mode === "build"
    ? ["Build & Settings", "Types", "Views", "Items", "Pages", "Actions"]
    : ["Items", "Pages", "Views", "Types", "Build & Settings", "Actions"];
}

// Rank a set of entries against the query for a mode. With an empty query the
// entries pass through unscored (the palette shows a capped jump-list on open);
// otherwise unmatched entries drop out and the rest sort by score within their
// group. Items are ranked elsewhere (they come pre-ranked from the FTS API), so
// pass only the non-item entries here.
export function rankCommands(
  entries: CommandResult[],
  q: string,
  mode: CommandMode
): CommandResult[] {
  const query = q.trim();
  if (!query) return entries;
  return entries
    .map((e) => {
      // Best of the label and any keyword aliases, so "help" reaches an entry
      // labelled "User Guide" without a second row pointing at the same route.
      const scores = [
        matchScore(e.label, query),
        ...(e.kind === "destination" && e.keywords
          ? e.keywords.map((k) => matchScore(k, query))
          : []),
      ].filter((s): s is number => s != null);
      if (scores.length === 0) return null;
      return { e, score: Math.max(...scores) + groupWeight(e.group, mode) };
    })
    .filter((x): x is { e: CommandResult; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label))
    .map((x) => x.e);
}
