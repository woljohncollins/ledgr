// Per-owner UI settings (v5). A single jsonb blob on the users row so each new
// preference isn't a migration. Validated/defaulted on read so a hand-edited or
// partial blob always yields a complete, safe object. Owner-scoped like
// everything else. Surfaces: the highlight-accent color (themed via a CSS var),
// the Trash retention window, and the nav position.
import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { isIconRef, NAV_ICON_FALLBACK } from "@/lib/nav-icons";
import { parseListTabs, type Lens } from "@/lib/list-lenses";
import { parseTocByType, type TocConfig } from "@/lib/toc";
import { parseCardsByType, type ProjectCardConfig } from "@/lib/project-card-config";
import { sanitizeLayout, type DeskLayout } from "@/lib/desk/layout";
import { parseJobOwners, type JobOwners } from "@/lib/job-owners";

// The accent palette offered in settings. Stored as the hex so it can drop
// straight into the `--accent` CSS variable.
export const HIGHLIGHT_COLORS = [
  { name: "Red", value: "#dc2626" },
  { name: "Rose", value: "#e11d48" },
  { name: "Pink", value: "#db2777" },
  { name: "Fuchsia", value: "#c026d3" },
  { name: "Violet", value: "#7c3aed" },
  { name: "Indigo", value: "#4f46e5" },
  { name: "Blue", value: "#2563eb" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Cyan", value: "#0891b2" },
  { name: "Teal", value: "#0d9488" },
  { name: "Emerald", value: "#059669" },
  { name: "Lime", value: "#65a30d" },
  { name: "Amber", value: "#d97706" },
  { name: "Orange", value: "#ea580c" },
  { name: "Slate", value: "#475569" },
] as const;

// Gradient accents (an alternative to the solid HIGHLIGHT_COLORS). A CSS
// gradient is an image, not a color, so it can't drive `color`/`border-color`/
// box-shadow/`color-mix` the way a solid hex can. Each gradient therefore ships
// a representative solid `accent` (used for `--accent`, so text/borders/glows
// stay valid) alongside the gradient `value` (used for `--accent-gradient`,
// applied to accent *fills* like checkboxes and count badges).
export const HIGHLIGHT_GRADIENTS = [
  { name: "Sunset", value: "linear-gradient(135deg, #fb923c 0%, #ec4899 100%)", accent: "#f472b6" },
  { name: "Ember", value: "linear-gradient(135deg, #ef4444 0%, #f97316 100%)", accent: "#fb6a3c" },
  { name: "Gold", value: "linear-gradient(135deg, #fbbf24 0%, #f97316 100%)", accent: "#f59e0b" },
  { name: "Emerald", value: "linear-gradient(135deg, #34d399 0%, #0d9488 100%)", accent: "#10b981" },
  { name: "Lagoon", value: "linear-gradient(135deg, #2dd4bf 0%, #3b82f6 100%)", accent: "#0ea5e9" },
  { name: "Ocean", value: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)", accent: "#3b82f6" },
  { name: "Aurora", value: "linear-gradient(135deg, #22d3ee 0%, #a855f7 100%)", accent: "#818cf8" },
  { name: "Grape", value: "linear-gradient(135deg, #a855f7 0%, #ec4899 100%)", accent: "#c026d3" },
] as const;

// Every accent solid that's valid for `--accent`: the named solids plus each
// gradient's representative accent (chosen when a gradient is active).
const ALLOWED_ACCENTS = new Set<string>([
  ...HIGHLIGHT_COLORS.map((c) => c.value),
  ...HIGHLIGHT_GRADIENTS.map((g) => g.accent),
]);

// True when `tz` is an IANA zone the runtime's own timezone database knows
// (e.g. "America/Chicago"). Validated by asking Intl to build a formatter for
// it — a bad string throws a RangeError. Used to keep a hand-edited or stale
// setting from poisoning every date format.
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Text size for the markdown prose canvas. Maps to the `--prose-font-size`
// CSS variable; sm/base/lg/xl scale the reading body without touching UI chrome.
export const TEXT_SIZES = ["sm", "base", "lg", "xl"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_PX: Record<TextSize, string> = {
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.25rem",
};

// Interface density (whole-UI scale). Unlike textSize, which sizes only the
// markdown prose canvas, this scales the *entire* interface — nav, menus,
// titles, buttons, toggles, spacing — at once. It does so by scaling the root
// font-size (the --ui-scale CSS var, applied in globals.css), so every
// rem-based dimension grows or shrinks together; nothing is enumerated, so new
// UI built later inherits the scaling for free. "default" (1.0) leaves the app
// pixel-identical to before, so it's a safe opt-in (Tyler's instance is
// untouched until he chooses a level). The factors stay modest so the layout
// never breaks. Distinct from navDensity, which is only how nav slots pack.
export const UI_DENSITIES = ["compact", "default", "comfortable", "roomy"] as const;

// App theme. `data-theme` on <html> (unset for dark, the :root default);
// globals.css carries one variable block per theme ([data-theme=…]), and
// tier 1 of the token layer (ADR-141) routes every neutral utility through those
// variables, so the flip is one class, not a per-component rewrite. Stored as the
// plain product word so the value reads the same in the blob and on screen.
export const THEMES = ["dark", "light", "gray", "sepia"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  gray: "Gray",
  sepia: "Sepia",
};
// Each theme's page color (= its --surface-0 in globals.css). Feeds the
// <meta name="theme-color"> so the mobile title bar matches the page.
export const THEME_PAGE_COLOR: Record<Theme, string> = {
  dark: "#191919",
  light: "#ffffff",
  gray: "#2b2b2b",
  sepia: "#f4ecd8",
};
export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}
export type UiDensity = (typeof UI_DENSITIES)[number];
export const UI_SCALE: Record<UiDensity, number> = {
  compact: 0.9,
  default: 1,
  comfortable: 1.1,
  roomy: 1.2,
};

// Item-canvas section style (the canvas redesign). Drives how the standardized
// CanvasSection panels (People, Open tasks, Properties, Linked here, …) carry
// visual weight, set as `data-section-style` on <body> so the CSS in globals.css
// styles every panel from one knob — same per-owner rail as accent/textSize.
// "heavy" = bordered cards; "light" = a divider rule, no box; "unified" = flat,
// minimal chrome. "light" is the default (clean for a fresh instance).
export const SECTION_STYLES = ["heavy", "light", "unified"] as const;
export type SectionStyle = (typeof SECTION_STYLES)[number];

export const NAV_POSITIONS = ["top", "bottom", "left", "right"] as const;
export type NavPosition = (typeof NAV_POSITIONS)[number];

// The Search slot's href, and what tapping it does (ADR-182). Ledgr has TWO
// search surfaces — the ⌘K command palette and the full /search page (stacked
// criteria with per-criterion confidence, ADR-172) — and both used to appear at
// once: the page as a default nav slot, the palette as a hardcoded button every
// layout carried. One search icon in the nav, one owner choice about what it
// opens. ⌘K still opens the palette either way; that's a keyboard shortcut, not
// an icon, so it costs no space and stays available.
export const SEARCH_HREF = "/search";
export const SEARCH_MODES = ["palette", "page"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

// Where an item opens when you click it from a list (Tyler, 2026-08-12). The
// shape used to be inferred purely from measured width — ≥1280px of content and
// no right rail meant a docked side panel, otherwise a center popup — so an owner
// on a wide screen had no way to ask for the popup, and no say in which edge the
// panel took. It's a reading preference, not a fact about the viewport, so it's a
// setting now.
//
//   auto   — the measured behavior above (the default; nothing changes for anyone
//            who never touches this)
//   left   — always a docked panel on the leading edge
//   right  — always a docked panel on the trailing edge
//   center — always the center popup, at any width
//
// A phone is always the bottom sheet regardless: below the `sm` breakpoint there
// is no room for a side panel, so the setting is a desktop preference only. A
// docked side is also skipped when the nav's own rail already occupies that edge,
// since two panels can't share it — that guard lives in Modal.computeMode.
export const ITEM_OPEN_MODES = ["auto", "left", "right", "center"] as const;
export type ItemOpenMode = (typeof ITEM_OPEN_MODES)[number];

// Width of the left/right side rail. Only meaningful when navPosition is
// left or right: "fat" shows icons + names, "thin" is an icon-only rail,
// "hidden" rolls it up to a sliver tab at the screen edge. The nav's collapse
// arrow cycles fat → thin → hidden.
export const RAIL_SIZES = ["fat", "thin", "hidden"] as const;
export type RailSize = (typeof RAIL_SIZES)[number];

// How the nav items pack into the bar/rail. "spread" pins them to the edges
// (nav slots one end, the New/More utilities the other, filling the space);
// "compact" groups everything together and anchors the cluster (see
// RailAnchor). The bottom bar is always compact.
export const NAV_DENSITIES = ["spread", "compact"] as const;
export type NavDensity = (typeof NAV_DENSITIES)[number];

// For a compact rail or top bar: where the grouped cluster sits along the bar's
// long axis. On a left/right rail that axis is vertical (top / center / bottom
// edge); on the top bar it's horizontal, where top/center/bottom read as
// left/center/right (the same start/center/end idea). Ignored when spread, and
// on the bottom bar.
export const RAIL_ANCHORS = ["top", "bottom", "center"] as const;
export type RailAnchor = (typeof RAIL_ANCHORS)[number];

// --- Configurable nav slots (ADR-056) -------------------------------------
// The nav bar has three zones: a locked Home (always first), the configurable
// middle slots stored here, then locked New + More (added at render time, never
// stored). A middle slot is either a single `destination` (one route) or a
// `tools` group (a button that opens a popover of child destinations).
//
// Stored in the users.settings jsonb (no migration). parseNavSlots is tolerant:
// a malformed slot is dropped and an unknown icon falls back, so a hand-edited
// blob still yields a safe, complete list rather than throwing.

// Recommended slot counts — guidance, not hard limits. They're sized for the
// tight surfaces: the desktop floating pill and the phone bottom bar. A left/
// right rail or the top bar have far more room, so the editor surfaces these as
// advice (dims the overflow in the preview, shows a hint) and lets the user
// exceed them rather than blocking. The phone bottom bar now scrolls
// horizontally (NavShell floatingPill), so exceeding the recommendation there
// is a soft "you'll need to swipe" rather than an overflow-off-screen problem.
// A single generous hard ceiling still bounds the stored array so a hand-edited
// blob can't produce an unbounded nav.
export const RECOMMENDED_NAV_SLOTS = 5;
export const RECOMMENDED_MOBILE_NAV_SLOTS = 5;
export const NAV_SLOTS_HARD_CAP = 30;
export const MAX_TOOLS_CHILDREN = 20;

// --- Favorites -------------------------------------------------------------
// A small, owner-curated list of items for instant access (the star toggle on
// any item canvas, surfaced as a flyout from the Favorites nav slot). Stored as
// an ordered list of item ids in users.settings (no schema change, same posture
// as navSlots); order is the array order, reorderable by drag. The route the
// Favorites nav slot points at; NavShell special-cases it into a flyout rather
// than navigating. A generous cap bounds a hand-edited blob.
export const FAVORITES_HREF = "/favorites";
export const FAVORITES_HARD_CAP = 100;

// Pinned-outline items (ADR-167). Same id-list shape as favorites, a looser cap
// since pinning is cheap and unremarkable (you pin a note and forget about it).
export const TOC_PINNED_HARD_CAP = 500;

// --- Desk workspaces (ADR-146) --------------------------------------------
// Named, saved Desk layouts. Synced (in this jsonb, no migration) so they
// follow the owner across devices, unlike the live layout + Recent ring which
// are per-device in localStorage. A DeskLayout is validated by sanitizeLayout on
// read, same tolerant posture as navSlots: a malformed entry is dropped.
export const DESK_WORKSPACES_CAP = 50;
export type DeskWorkspace = {
  id: string;
  name: string;
  savedAt: number; // epoch ms
  layout: DeskLayout;
};

// A destination points at one route. `builtin` is a hardcoded app page, `view`
// a saved view (/views/[id]), `type` a type's list (/list/[key]). The kind is
// metadata for the editor; the nav only needs href/label/icon to render.
export const NAV_DEST_KINDS = ["builtin", "view", "type", "dashboard"] as const;
export type NavDestKind = (typeof NAV_DEST_KINDS)[number];

export type NavBadge = "inbox" | "notifications";

export type NavDestination = {
  kind: NavDestKind;
  href: string;
  label: string;
  icon: string;
  badge?: NavBadge; // optional count badge; only the inbox count for now
};

export type NavSlotConfig =
  | ({ type: "destination" } & NavDestination)
  | {
      type: "tools";
      label: string;
      icon: string;
      children: NavDestination[]; // up to MAX_TOOLS_CHILDREN; no nesting
    };

export type UserSettings = {
  // Configurable editor toolbar (app-wide): ids the user hid from the markdown
  // toolbar. Empty = show all. See toolbar-icons / TOOLBAR_ITEMS.
  editorToolbarHidden: string[];
  // Configurable Quick Add: capture-card action ids the user hid (deadline,
  // priority, assignee). Empty = show all.
  quickAddHidden: string[];
  highlightColor: string; // solid hex (a HIGHLIGHT_COLORS value, or a gradient's representative accent)
  // When set, an accent gradient (a HIGHLIGHT_GRADIENTS value) layered over fills;
  // null = a plain solid accent. highlightColor still holds the representative solid.
  highlightGradient: string | null;
  trashRetentionDays: number; // 1..365
  navPosition: NavPosition;
  // Where a clicked item opens: docked panel (left/right), center popup, or the
  // measured default. Desktop only; a phone is always the bottom sheet.
  itemOpenMode: ItemOpenMode;
  railSize: RailSize;
  navDensity: NavDensity;
  railAnchor: RailAnchor;
  // What the nav's Search slot opens (ADR-182): the ⌘K command palette, or the
  // full /search page. One icon, one choice; ⌘K reaches the palette regardless.
  searchMode: SearchMode;
  // The configurable middle nav slots (Home/New/More are added at render time).
  navSlots: NavSlotConfig[];
  // Mobile override: null mirrors the desktop slots; an array is a distinct
  // mobile list (recommended tighter, see RECOMMENDED_MOBILE_NAV_SLOTS).
  mobileNavSlots: NavSlotConfig[] | null;
  // How this owner signs shared content (the Changelog notes "Sign" stamp).
  // Empty falls back to the email's local part (see effectiveDisplayName).
  displayName: string;
  // Optional: a custom dashboard assigned as the Home (/) and/or Today surface.
  // null = render the fixed built-in layout (the default). A deleted/unowned id
  // parses back to null, so a removed dashboard silently falls back.
  homeDashboardId: string | null;
  todayDashboardId: string | null;
  // The unguessable token in the owner's published ICS task-feed URL (T4,
  // ADR-079). null = no feed published yet; generated/rotated from User
  // Settings. The feed route resolves the owner by this token (no Clerk),
  // same posture as a share link.
  icsToken: string | null;
  // Prose canvas font size (sm/base/lg/xl). Stored as a string key; layout
  // maps it to the --prose-font-size CSS variable so the setting applies
  // globally without a client-side effect.
  textSize: TextSize;
  // Whole-UI density. uiDensity is the desktop level; mobileUiDensity null
  // mirrors desktop, else overrides it on phones (< sm). Both map to UI_SCALE,
  // emitted as the --ui-scale CSS var per surface in layout. Independent of
  // textSize (which sizes the prose canvas only).
  uiDensity: UiDensity;
  mobileUiDensity: UiDensity | null;
  // App theme (dark/light/gray/sepia); data-theme on <html> set in layout.
  theme: Theme;
  // Item-canvas section style (heavy/light/unified). Maps to the
  // `data-section-style` attribute on <body>; the CanvasSection CSS reads it.
  sectionStyle: SectionStyle;
  // Ordered item ids the owner has starred (the Favorites flyout). Order is the
  // list order; a missing/deleted id is silently dropped when the list resolves.
  favorites: string[];
  // Per-type list-tab overrides (the customizable sort/view "lenses" on a type's
  // list page). Keyed by type key; an absent key = the virtual defaults
  // (defaultLenses). Additive, no migration, same posture as navSlots/favorites.
  listTabs: Record<string, Lens[]>;
  // Per-type floating-TOC overrides (ADR-114). Keyed by type key; an absent key
  // resolves to DEFAULT_TOC (auto-on). Additive, no migration.
  tocByType: Record<string, TocConfig>;
  // Per-type project-card element overrides (2026-08-17): which tools a project
  // card shows wherever cards render (the grid, view lenses, boards). Keyed by
  // type key ("project" today); an absent key = DEFAULT_PROJECT_CARD. A saved
  // view can further override via views.display.card. Additive, no migration.
  cardsByType: Record<string, ProjectCardConfig>;
  // Type keys the owner offers as TOOLS on widget-home records (2026-08-17):
  // each becomes a synthetic collection card ("collection:<key>") in Add a
  // Tool, so a "Chapter" type can be a Chapters card on a Book project.
  // Toggled from the type's edit page. Additive, no migration.
  toolTypes: string[];
  // Item ids whose outline the owner has pinned open as a sidebar (ADR-167).
  // Per ITEM, not per type: "I pinned the outline on this long note" is a fact
  // about that note, so it follows the note to every device. Deliberately NOT
  // items.properties — every write to `items` bumps updated_at ($onUpdate), and
  // pinning an outline is a reading preference, not an edit to the note. Same
  // shape and parser as `favorites`. Unordered (membership is all that matters).
  tocPinnedItems: string[];
  // Related-panel lens choice: which of a related type's lenses structures that
  // type's group on an item's detail page. Keyed "hostType:relatedType" (so the
  // Tasks group under a Meeting can differ from Tasks under a Person), value is
  // the chosen lens id. An absent key = the related type's default lens.
  // Additive, no migration, same posture as listTabs.
  relatedLensChoices: Record<string, string>;
  // Per-source notification toggles (ADR-129). One on/off switch per
  // notification source; a falsy switch makes recordNotification a no-op for
  // that kind, so the single toggle gates BOTH the persisted row and the push.
  // An absent key defaults to on (see NOTIFICATION_KINDS / notificationEnabled),
  // so a new source is on until the owner turns it off. Additive, no migration.
  notificationPrefs: Record<string, boolean>;
  // Where each arrival path lands (ADR-249). Keyed by source (see
  // INBOX_SOURCES in src/lib/inbox-sources.ts), value is ONE string: "inbox",
  // "filed", or a project's id. An absent key = that source's default route,
  // so a fresh instance keeps the old always-Inbox behavior. Keys are free
  // text, like notifications.kind, so a new source needs no migration.
  inboxRoutes: Record<string, string>;
  // The owner's IANA timezone (e.g. "America/Chicago"), defining every "today"
  // boundary and the wall-clock of every displayed time. null = follow the
  // server default (the LEDGR_TIMEZONE env var, else America/New_York), which is
  // how a fresh instance and Tyler's instance behave until the owner picks one.
  // Resolved server-side by getAppTimezone(); see src/lib/today.ts.
  timezone: string | null;
  // AI Memory subsystem master switch (ADR-137). Off by default: a fresh Ledgr
  // behaves exactly as before. When on, the memory-specific MCP tools
  // (get_memory_stumps, remember) and the memory-protocol resource are exposed,
  // and the Build → AI Memory surface appears. When off, none of those are
  // listed or callable, so a "vanilla" MCP client never sees the memory concept.
  aiMemoryEnabled: boolean;
  // Live editing context subsystem switch (ADR-162). Off by default: a fresh
  // Ledgr behaves exactly as before. When on, the open item canvas reports the
  // item you're viewing (and your current text selection) to a single per-owner
  // active_context row, the context-specific MCP tools (get_active_context,
  // edit_item_body) are exposed, and a "Note Editing Partner" prompt item is
  // seeded so Claude can co-edit the note you're looking at. When off, nothing
  // is tracked and those tools aren't listed or callable.
  liveContextEnabled: boolean;
  // The "Note Editing Partner" prompt item seeded when Live editing context is
  // first turned on (ADR-162). The canonical text lives in the repo
  // (note-editing-prompt.ts); this points at the owner's editable copy so the
  // settings surface can link to it and "Revert to default" can find it. null
  // until the feature is enabled (or if the item was purged — it's re-seeded).
  noteEditingPromptItemId: string | null;
  // Editor: show a fold chevron on H1/H2/H3 to collapse the section beneath a
  // heading (view-only, never written to the body). On by default. When off the
  // markdown editor renders headings plainly.
  collapsibleHeadingsEnabled: boolean;
  // Editor: offer the collapsible "toggle" block (a <details> disclosure) via
  // the toolbar button and the "/toggle" slash command. On by default. When off
  // those creation affordances hide; existing toggles in a body still render.
  toggleBlocksEnabled: boolean;
  // Named, saved Desk layouts (ADR-146), synced across devices. The live layout
  // and the Recent auto-snapshot ring stay per-device in localStorage.
  deskWorkspaces: DeskWorkspace[];
  // The owner's personal search dictionary (ADR-172): word -> extra synonyms that
  // fuzzy search should treat as matches. Layered ON TOP of the committed WordNet
  // map (src/data/synonyms.json) and winning over it, because WordNet knows English
  // but not this owner's vocabulary ("message" meaning sermon, campus
  // abbreviations, staff nicknames). Starts empty and is meant to grow one line at
  // a time, only when a search actually misses. Same no-migration posture as
  // listTabs/tocByType.
  searchSynonyms: Record<string, string[]>;
  // Which install runs each EXCLUSIVE scheduled job (src/lib/job-owners.ts).
  // Lives here rather than in per-machine config precisely BECAUSE settings
  // sync (ADR-206): one slot per job means two owners cannot be represented,
  // and every install reads the same answer. Absent = every install behaves as
  // it did before this existed, so an owner who never touches it changes
  // nothing. Same no-migration posture as listTabs/searchSynonyms.
  jobOwners: JobOwners;
  // Whether a saved YouTube video gets its transcript written into its body.
  //
  // WHY IT LIVES HERE, WITH THE SYNCED SETTINGS. There are two questions and
  // they have different answers. "Do I want my videos transcribed?" is the
  // owner's own preference, so it belongs in the synced blob and follows them
  // to every copy. "Which machine actually does the work?" is a separate
  // question with a control that already exists: the "Runs on" dropdown under
  // Scheduled work (jobOwners above). Merging the two would mean either every
  // copy trying (and the cloud failing, since it has no yt-dlp and YouTube
  // refuses data-center addresses) or the switch being invisible on the very
  // machine you would go looking for it on.
  //
  // Off by default, because the work needs tools that not every machine has:
  // yt-dlp, and Whisper for a video with no captions.
  youtubeTranscripts: { enabled: boolean };
  // Saved searches (ADR-063 palette / /search): named snapshots of the full
  // search state (q, filters, tuning criteria). Synced like everything else
  // here. `state` is opaque to settings.ts — SearchClient owns its shape.
  savedSearches: { id: string; name: string; state: Record<string, unknown> }[];
};

// The notification sources (ADR-129), in the order the settings UI lists them.
// Each is individually on/off-toggleable (Brandon). `kind` is the value stored
// on notifications.kind and keyed in settings.notificationPrefs.
export const NOTIFICATION_KINDS = [
  { kind: "agenda", label: "Morning agenda", help: "A daily summary of today's events and due tasks." },
  { kind: "meeting_prep", label: "Event prep ready", help: "When an event with people is coming up soon." },
  { kind: "task_due", label: "Task due", help: "When a task is due or overdue." },
  { kind: "calendar_soon", label: "Event starting soon", help: "When a calendar event is about to begin." },
  { kind: "sync_error", label: "Sync & system errors", help: "When a sync or background job fails." },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["kind"];

// A source is enabled unless its toggle is explicitly false (default-on).
export function notificationEnabled(
  prefs: Record<string, boolean>,
  kind: string
): boolean {
  return prefs[kind] !== false;
}

// Keep only known kinds with boolean values; an unknown key or non-boolean is
// dropped (an absent key already defaults to on).
function parseNotificationPrefs(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const { kind } of NOTIFICATION_KINDS) {
    if (typeof r[kind] === "boolean") out[kind] = r[kind] as boolean;
  }
  return out;
}

// Keep only routable values: the two mode words, or a project id. Any other
// value is dropped, and the source falls back to its default in routeFor.
function parseInboxRoutes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (value === "inbox" || value === "filed" || SETTINGS_UUID_RE.test(value)) {
      out[key] = value;
    }
  }
  return out;
}

// Type keys offered as tools on widget-home records (slug-shaped, deduped,
// bounded — a malformed entry is dropped, not rejected).
function parseToolTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (!/^[a-z][a-z0-9_]*$/.test(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
    if (out.length >= 50) break;
  }
  return out;
}

// The starting middle slots: Inbox (with its count badge), Tasks, Search. The
// developer/admin destinations (Views, Items) that used to live in the nav are
// intentionally not here — they belong in Build, not daily nav.
export const DEFAULT_NAV_SLOTS: NavSlotConfig[] = [
  { type: "destination", kind: "builtin", href: "/inbox", label: "Inbox", icon: "inbox", badge: "inbox" },
  { type: "destination", kind: "builtin", href: "/notifications", label: "Notifications", icon: "bell", badge: "notifications" },
  { type: "destination", kind: "builtin", href: "/tasks", label: "Tasks", icon: "tasks" },
  { type: "destination", kind: "builtin", href: "/planner", label: "Planner", icon: "calendar" },
  { type: "destination", kind: "builtin", href: FAVORITES_HREF, label: "Favorites", icon: "starred" },
  { type: "destination", kind: "builtin", href: "/search", label: "Search", icon: "search" },
];

export const DEFAULT_SETTINGS: UserSettings = {
  editorToolbarHidden: [],
  quickAddHidden: [],
  highlightColor: "#2563eb",
  highlightGradient: null,
  trashRetentionDays: 30,
  navPosition: "bottom",
  // "auto" reproduces the pre-setting behavior exactly, so an owner who never
  // opens this control sees no change.
  itemOpenMode: "auto",
  railSize: "fat",
  navDensity: "spread",
  railAnchor: "top",
  searchMode: "palette",
  navSlots: DEFAULT_NAV_SLOTS,
  mobileNavSlots: null,
  displayName: "",
  homeDashboardId: null,
  todayDashboardId: null,
  icsToken: null,
  textSize: "base",
  uiDensity: "default",
  mobileUiDensity: null,
  theme: "dark",
  sectionStyle: "light",
  favorites: [],
  listTabs: {},
  tocByType: {},
  cardsByType: {},
  toolTypes: [],
  tocPinnedItems: [],
  relatedLensChoices: {},
  notificationPrefs: {},
  inboxRoutes: {},
  timezone: null,
  aiMemoryEnabled: false,
  liveContextEnabled: false,
  noteEditingPromptItemId: null,
  collapsibleHeadingsEnabled: true,
  toggleBlocksEnabled: true,
  deskWorkspaces: [],
  searchSynonyms: {},
  jobOwners: {},
  youtubeTranscripts: { enabled: false },
  savedSearches: [],
};

export const SETTINGS_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate one destination, returning null if it's unusable. An unknown icon
// falls back rather than failing; the locked Home route ("/") is stripped so it
// can never be duplicated into the middle zone. badge keeps only "inbox".
function parseNavDestination(raw: unknown): NavDestination | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const href = typeof r.href === "string" ? r.href.trim() : "";
  if (!href || href === "/") return null; // empty or the locked Home slot
  const label = typeof r.label === "string" ? r.label.trim().slice(0, 40) : "";
  if (!label) return null;
  const kind = (NAV_DEST_KINDS as readonly string[]).includes(r.kind as string)
    ? (r.kind as NavDestKind)
    : "builtin";
  const icon = isIconRef(r.icon) ? r.icon : NAV_ICON_FALLBACK;
  const dest: NavDestination = { kind, href, label, icon };
  if (r.badge === "inbox" || r.badge === "notifications") dest.badge = r.badge;
  return dest;
}

// Validate one middle slot. A `tools` group flattens its children to plain
// destinations (so a nested group can't sneak in) and caps the count; an empty
// group is dropped. Returns null for anything unusable.
function parseNavSlot(raw: unknown): NavSlotConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "tools") {
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 40) : "";
    if (!label) return null;
    const icon = isIconRef(r.icon) ? r.icon : "tools";
    const children = (Array.isArray(r.children) ? r.children : [])
      .map(parseNavDestination)
      .filter((c): c is NavDestination => c !== null)
      .slice(0, MAX_TOOLS_CHILDREN);
    if (children.length === 0) return null;
    return { type: "tools", label, icon, children };
  }
  // Anything else is treated as a destination (the common case).
  const dest = parseNavDestination(r);
  return dest ? { type: "destination", ...dest } : null;
}

// Parse a stored slot list, dropping malformed entries and capping the count.
// Returns the fallback when `raw` isn't an array at all (an empty array is a
// legitimate "no middle slots" choice and is preserved).
function parseNavSlots(raw: unknown, max: number, fallback: NavSlotConfig[]): NavSlotConfig[] {
  if (!Array.isArray(raw)) return fallback;
  return raw
    .map(parseNavSlot)
    .filter((s): s is NavSlotConfig => s !== null)
    .slice(0, max);
}

// Carry a nav slot's presentation (icon, badge) over from the slot already at
// that href when a write leaves it out. parseNavDestination stamps a missing
// icon with the generic bullet-list fallback rather than refusing the slot, so
// ANY caller that read the nav lossily and wrote the whole list back silently
// re-iconed the owner's entire toolbar. MCP update_nav did exactly that twice
// (2026-09-14, and again 2026-09-17 on Brandon's rail). #387 taught one reader
// to return icons; this fixes the seam every writer routes through, so the next
// lossy caller cannot do it again. Same lesson as ADR-258's type icon/color
// loss: a lossy read plus a wholesale write destroys a presentation choice.
// A caller that DOES send an icon still wins, so this never blocks a real edit.
export function keepNavPresentation(
  incoming: unknown,
  current: NavSlotConfig[] | null | undefined
): unknown {
  if (!Array.isArray(incoming) || !current?.length) return incoming;
  // Keyed by href for destinations; a tools group has no route, so by label.
  const known = new Map<string, { icon: string; badge?: NavBadge }>();
  const remember = (key: string, v: { icon: string; badge?: NavBadge }) => {
    if (!known.has(key)) known.set(key, v); // first wins on a duplicate href
  };
  for (const s of current) {
    if (s.type === "tools") {
      remember(`tools:${s.label}`, { icon: s.icon });
      for (const c of s.children) remember(c.href, c);
    } else {
      remember(s.href, s);
    }
  }
  const fill = (raw: unknown): unknown => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const r = { ...(raw as Record<string, unknown>) };
    const prev = known.get(
      r.type === "tools" ? `tools:${String(r.label ?? "")}` : String(r.href ?? "")
    );
    if (prev) {
      if (!isIconRef(r.icon)) r.icon = prev.icon;
      if (r.badge === undefined && prev.badge) r.badge = prev.badge;
    }
    if (Array.isArray(r.children)) r.children = r.children.map(fill);
    return r;
  };
  return incoming.map(fill);
}

// Parse a stored list of item ids (favorites; pinned-outline items): keep only
// well-formed uuid strings, dedupe (first occurrence wins, preserving order),
// and cap the count. Anything that isn't an array yields the empty list.
function parseItemIdList(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !SETTINGS_UUID_RE.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

// Parse the related-panel lens choices map ("hostType:relatedType" → lensId).
// Tolerant like parseListTabs: drop keys without the host:related shape or with
// a non-string value, bound the count and the string lengths.
function parseRelatedLensChoices(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 400) break;
    const k = key.trim().slice(0, 120);
    if (!k.includes(":")) continue;
    if (typeof value === "string" && value.trim()) {
      out[k] = value.trim().slice(0, 40);
      count++;
    }
  }
  return out;
}

// Parse saved Desk workspaces: drop entries missing an id/name or with an
// unreadable layout (sanitizeLayout returns null on an unknown version), bound
// the count and the name length. Anything not an array yields the empty list.
function parseDeskWorkspaces(raw: unknown): DeskWorkspace[] {
  if (!Array.isArray(raw)) return [];
  const out: DeskWorkspace[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : null;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
    const layout = sanitizeLayout(o.layout);
    if (!id || !name || !layout) continue;
    const savedAt = typeof o.savedAt === "number" && Number.isFinite(o.savedAt) ? o.savedAt : Date.now();
    out.push({ id, name, savedAt, layout });
    if (out.length >= DESK_WORKSPACES_CAP) break;
  }
  return out;
}

// Parse the owner's search dictionary (ADR-172): word -> extra synonyms. Tolerant
// like parseListTabs — a malformed row is dropped rather than throwing, so a
// hand-edited blob still yields a usable dictionary. Keys and values are
// lowercased and trimmed here so lookups in lib/synonyms.ts need no normalizing,
// and both are bounded: a runaway entry would bloat every tsquery it touches.
export const SEARCH_SYNONYM_WORD_CAP = 200; // distinct words the owner can define
export const SEARCH_SYNONYM_VALUE_CAP = 12; // synonyms per word
function parseSearchSynonyms(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  let words = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (words >= SEARCH_SYNONYM_WORD_CAP) break;
    const word = key.trim().toLowerCase().slice(0, 60);
    if (!word || !Array.isArray(value)) continue;
    const synonyms = value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase().slice(0, 60))
      .filter((v, i, all) => v.length > 0 && v !== word && all.indexOf(v) === i)
      .slice(0, SEARCH_SYNONYM_VALUE_CAP);
    if (synonyms.length === 0) continue; // a word with no synonyms is a no-op
    out[word] = synonyms;
    words += 1;
  }
  return out;
}

export const SAVED_SEARCHES_CAP = 100;

// Parse saved searches: id and name must be non-empty strings, state a plain
// object (its shape is SearchClient's business, not settings.ts's — kept
// permissive). Anything not an array yields the empty list.
function parseSavedSearches(
  raw: unknown
): { id: string; name: string; state: Record<string, unknown> }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; name: string; state: Record<string, unknown> }[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : null;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 80) : null;
    const state =
      o.state && typeof o.state === "object" && !Array.isArray(o.state)
        ? (o.state as Record<string, unknown>)
        : null;
    if (!id || !name || !state) continue;
    out.push({ id, name, state });
    if (out.length >= SAVED_SEARCHES_CAP) break;
  }
  return out;
}

export function parseSettings(raw: unknown): UserSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const highlightColor =
    typeof r.highlightColor === "string" && ALLOWED_ACCENTS.has(r.highlightColor)
      ? r.highlightColor
      : DEFAULT_SETTINGS.highlightColor;
  // Keep the gradient only if it's a known one (else fall back to a solid accent).
  const highlightGradient = HIGHLIGHT_GRADIENTS.some((g) => g.value === r.highlightGradient)
    ? (r.highlightGradient as string)
    : DEFAULT_SETTINGS.highlightGradient;
  const days = typeof r.trashRetentionDays === "number" && r.trashRetentionDays > 0
    ? Math.min(Math.round(r.trashRetentionDays), 365)
    : DEFAULT_SETTINGS.trashRetentionDays;
  const navPosition = (NAV_POSITIONS as readonly string[]).includes(r.navPosition as string)
    ? (r.navPosition as NavPosition)
    : DEFAULT_SETTINGS.navPosition;
  const itemOpenMode = (ITEM_OPEN_MODES as readonly string[]).includes(
    r.itemOpenMode as string
  )
    ? (r.itemOpenMode as ItemOpenMode)
    : DEFAULT_SETTINGS.itemOpenMode;
  const railSize = (RAIL_SIZES as readonly string[]).includes(r.railSize as string)
    ? (r.railSize as RailSize)
    : DEFAULT_SETTINGS.railSize;
  const searchMode = (SEARCH_MODES as readonly string[]).includes(r.searchMode as string)
    ? (r.searchMode as SearchMode)
    : DEFAULT_SETTINGS.searchMode;
  const navDensity = (NAV_DENSITIES as readonly string[]).includes(r.navDensity as string)
    ? (r.navDensity as NavDensity)
    : DEFAULT_SETTINGS.navDensity;
  const railAnchor = (RAIL_ANCHORS as readonly string[]).includes(r.railAnchor as string)
    ? (r.railAnchor as RailAnchor)
    : DEFAULT_SETTINGS.railAnchor;
  const displayName =
    typeof r.displayName === "string" ? r.displayName.trim().slice(0, 60) : DEFAULT_SETTINGS.displayName;
  const dashRef = (v: unknown) =>
    typeof v === "string" && SETTINGS_UUID_RE.test(v) ? v : null;
  const homeDashboardId = dashRef(r.homeDashboardId);
  const todayDashboardId = dashRef(r.todayDashboardId);
  // base64url token, bounded; anything else → no feed.
  const icsToken =
    typeof r.icsToken === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(r.icsToken)
      ? r.icsToken
      : null;
  const editorToolbarHidden = Array.isArray(r.editorToolbarHidden)
    ? (r.editorToolbarHidden.filter((x) => typeof x === "string") as string[])
    : DEFAULT_SETTINGS.editorToolbarHidden;
  const quickAddHidden = Array.isArray(r.quickAddHidden)
    ? (r.quickAddHidden.filter((x) => typeof x === "string") as string[])
    : DEFAULT_SETTINGS.quickAddHidden;
  const navSlots = parseNavSlots(r.navSlots, NAV_SLOTS_HARD_CAP, DEFAULT_NAV_SLOTS);
  // null (or absent) means mirror desktop; an array is a distinct mobile list.
  const mobileNavSlots =
    r.mobileNavSlots == null
      ? null
      : parseNavSlots(r.mobileNavSlots, NAV_SLOTS_HARD_CAP, []);
  const textSize = (TEXT_SIZES as readonly string[]).includes(r.textSize as string)
    ? (r.textSize as TextSize)
    : DEFAULT_SETTINGS.textSize;
  const uiDensity = (UI_DENSITIES as readonly string[]).includes(r.uiDensity as string)
    ? (r.uiDensity as UiDensity)
    : DEFAULT_SETTINGS.uiDensity;
  // null (or absent) means mirror desktop; a known level is a distinct mobile
  // override. An unknown value falls back to null rather than throwing.
  const mobileUiDensity =
    r.mobileUiDensity == null
      ? null
      : (UI_DENSITIES as readonly string[]).includes(r.mobileUiDensity as string)
        ? (r.mobileUiDensity as UiDensity)
        : null;
  const theme = isTheme(r.theme) ? r.theme : DEFAULT_SETTINGS.theme;
  const sectionStyle = (SECTION_STYLES as readonly string[]).includes(r.sectionStyle as string)
    ? (r.sectionStyle as SectionStyle)
    : DEFAULT_SETTINGS.sectionStyle;
  const favorites = parseItemIdList(r.favorites, FAVORITES_HARD_CAP);
  const listTabs = parseListTabs(r.listTabs);
  const tocByType = parseTocByType(r.tocByType);
  const cardsByType = parseCardsByType(r.cardsByType);
  const toolTypes = parseToolTypes(r.toolTypes);
  // ponytail: the whole list is rewritten on every pin toggle. Fine for the
  // dozens of long notes worth pinning; if this ever reaches thousands, move it
  // to its own table (or an items column) rather than growing the settings blob.
  const tocPinnedItems = parseItemIdList(r.tocPinnedItems, TOC_PINNED_HARD_CAP);
  const relatedLensChoices = parseRelatedLensChoices(r.relatedLensChoices);
  const notificationPrefs = parseNotificationPrefs(r.notificationPrefs);
  const inboxRoutes = parseInboxRoutes(r.inboxRoutes);
  const timezone =
    typeof r.timezone === "string" && isValidTimezone(r.timezone)
      ? r.timezone
      : DEFAULT_SETTINGS.timezone;
  const aiMemoryEnabled =
    typeof r.aiMemoryEnabled === "boolean" ? r.aiMemoryEnabled : DEFAULT_SETTINGS.aiMemoryEnabled;
  const liveContextEnabled =
    typeof r.liveContextEnabled === "boolean" ? r.liveContextEnabled : DEFAULT_SETTINGS.liveContextEnabled;
  const noteEditingPromptItemId = dashRef(r.noteEditingPromptItemId);
  const collapsibleHeadingsEnabled =
    typeof r.collapsibleHeadingsEnabled === "boolean"
      ? r.collapsibleHeadingsEnabled
      : DEFAULT_SETTINGS.collapsibleHeadingsEnabled;
  const toggleBlocksEnabled =
    typeof r.toggleBlocksEnabled === "boolean"
      ? r.toggleBlocksEnabled
      : DEFAULT_SETTINGS.toggleBlocksEnabled;
  const deskWorkspaces = parseDeskWorkspaces(r.deskWorkspaces);
  const searchSynonyms = parseSearchSynonyms(r.searchSynonyms);
  const jobOwners = parseJobOwners(r.jobOwners);
  const savedSearches = parseSavedSearches(r.savedSearches);
  // Only an explicit `true` turns it on: an absent, partial or hand-edited blob
  // leaves the feature off, which is the safe answer on a machine without the
  // tools to do the work.
  const youtubeTranscripts = {
    enabled:
      (r.youtubeTranscripts as { enabled?: unknown } | undefined)?.enabled === true,
  };
  return {
    highlightColor,
    highlightGradient,
    editorToolbarHidden,
    quickAddHidden,
    trashRetentionDays: days,
    navPosition,
    itemOpenMode,
    searchMode,
    railSize,
    navDensity,
    railAnchor,
    navSlots,
    mobileNavSlots,
    displayName,
    homeDashboardId,
    todayDashboardId,
    icsToken,
    textSize,
    uiDensity,
    mobileUiDensity,
    theme,
    sectionStyle,
    favorites,
    listTabs,
    tocByType,
    cardsByType,
    toolTypes,
    tocPinnedItems,
    relatedLensChoices,
    notificationPrefs,
    inboxRoutes,
    timezone,
    aiMemoryEnabled,
    liveContextEnabled,
    noteEditingPromptItemId,
    collapsibleHeadingsEnabled,
    toggleBlocksEnabled,
    deskWorkspaces,
    searchSynonyms,
    jobOwners,
    youtubeTranscripts,
    savedSearches,
  };
}

// The name to sign with: the explicit setting, else a readable fallback from
// the email's local part ("tyler@…" -> "Tyler"). Each instance is one owner.
export function effectiveDisplayName(settings: UserSettings, email: string): string {
  if (settings.displayName) return settings.displayName;
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
  if (!local) return "Someone";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// Wrapped in React cache() the way resolveOwnerState is (owner.ts): the Nav
// and the page each read settings on every render, which was two identical
// queries per navigation — two extra HTTP round trips on the neon-http driver.
// cache() makes every caller in one request await the same promise; in route
// handlers it is a passthrough, so updateSettings below never reads stale.
export const getSettings = cache(async (ownerId: string): Promise<UserSettings> => {
  const [row] = await getDb()
    .select({ settings: users.settings })
    .from(users)
    .where(eq(users.id, ownerId));
  return parseSettings(row?.settings);
});

export async function updateSettings(
  ownerId: string,
  patch: Partial<UserSettings>
): Promise<UserSettings> {
  const before = await getSettings(ownerId);
  const merged: Record<string, unknown> = { ...before, ...patch };
  if (patch.navSlots !== undefined) {
    merged.navSlots = keepNavPresentation(patch.navSlots, before.navSlots);
  }
  if (patch.mobileNavSlots !== undefined) {
    // A first custom phone list is normally built from the desktop one, so fall
    // back to the desktop slots when no phone list is stored yet.
    merged.mobileNavSlots = keepNavPresentation(
      patch.mobileNavSlots,
      before.mobileNavSlots ?? before.navSlots
    );
  }
  const next = parseSettings(merged);
  await getDb().update(users).set({ settings: next }).where(eq(users.id, ownerId));
  return next;
}
