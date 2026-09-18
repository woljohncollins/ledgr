// The Build-mode left sidebar structure (ADR-063): the hardcoded taxonomy of
// the system tools, grouped under four verbs — DATA (build the data model),
// INTERFACE (build how you see and reach it), MAINTAIN (understand and care for
// what exists), SYSTEM (the software and the machine it runs on). This is the
// single source of truth for two surfaces:
//
//   1. BuildSidebar renders these groups + entries directly.
//   2. The Work nav's destination picker offers them as a "Build tools" category
//      (buildToolDests below), so a power user can pull any Build tool into their
//      daily Work nav — the "separation is the default, not a wall" principle.
//
// Kept as data with no JSX (the nav-slot-options pattern) so both a server page
// and the client sidebar can read it. Icon keys come from the shared nav-icons
// library. The sidebar is a system surface, not user-configurable (no DB row).
import type { NavIconKey } from "@/lib/nav-icons";

export type BuildGroupLabel = "DATA" | "INTERFACE" | "MAINTAIN" | "SYSTEM";

// A per-owner setting flag that, when false, hides an entry from the Build
// sidebar. The taxonomy itself stays static (single source of truth); the
// sidebar filters gated entries with the owner's settings at render time.
export type BuildEntryFlag = "aiMemoryEnabled";

export type BuildEntry = {
  label: string;
  href: string;
  icon: NavIconKey;
  // Most entries are flat links. `expandable` marks the few with genuine
  // sub-navigation (Vercel discipline: dropdowns sparingly). The dynamic ones
  // (Types → the user's actual types) inject children at render; the rest grow
  // their sub-nav in later phases (see the stub plan-notes).
  expandable?: boolean;
  // When set, the Build sidebar shows this entry only if the owner has the named
  // setting on (ADR-137: AI Memory). The entry stays in the static taxonomy (so
  // the picker/palette/describe_workspace still know it) — only the sidebar
  // doorway is hidden while the feature is off.
  gatedBy?: BuildEntryFlag;
  // Extra search words for the command palette, when what a person types isn't
  // what the entry is called ("help" → User Guide). Sidebar ignores these.
  keywords?: string[];
};

export type BuildGroup = {
  label: BuildGroupLabel;
  entries: BuildEntry[];
};

// The three groups, in display order. These exact labels render in the UI.
export const BUILD_NAV: BuildGroup[] = [
  {
    label: "DATA",
    entries: [
      // Types & Properties is the one entry that expands this phase: its
      // dropdown lists the user's actual types for a quick edit-jump.
      { label: "Types & Properties", href: "/build/types", icon: "layers", expandable: true },
      { label: "Templates", href: "/build/templates", icon: "document" },
      { label: "Workflows & Wikis", href: "/build/new", icon: "board" },
      { label: "Bespoke Tools", href: "/build/tools", icon: "bolt" },
      // The storage browser (ADR-237): every uploaded file, its item, and
      // whether the item still points at it. Data, not maintenance — files are
      // content the owner owns, not a mess to clean (that's hygiene's sweep).
      { label: "Files", href: "/build/files", icon: "folder" },
      // Capture & Inbox (ADR-249): where each arrival path lands — queued in the
      // Inbox, filed straight away, or dropped into a project — plus the web
      // clipper setup, moved here from the bottom of User Settings so "how does
      // stuff get into Ledgr" has one address. DATA, not MAINTAIN: capture
      // routing shapes what data exists.
      {
        label: "Capture & Inbox",
        href: "/build/capture",
        icon: "inbox",
        keywords: ["capture", "inbox", "clipper", "routing", "source", "email", "todoist"],
      },
    ],
  },
  {
    label: "INTERFACE",
    entries: [
      { label: "Views", href: "/build/views", icon: "views" },
      { label: "Dashboards", href: "/dashboards", icon: "dashboard" },
      { label: "Navigation", href: "/build/navigation", icon: "navigation" },
    ],
  },
  {
    label: "MAINTAIN",
    entries: [
      // Model Overview is the /build home — the bird's-eye view you land on.
      { label: "Model Overview", href: "/build", icon: "compass" },
      // User Guide (ADR-189): what Ledgr can do and where each feature lives.
      // Sits next to Model Overview because the pair answers the two "what have
      // I got" questions — that one for your data, this one for the tool. Also
      // linked from the Work "More" menu and findable in the command palette,
      // since the problem it solves is not knowing a feature exists at all.
      {
        label: "User Guide",
        href: "/build/guide",
        icon: "book",
        keywords: ["help", "docs", "documentation", "manual", "how to"],
      },
      { label: "Data Hygiene", href: "/build/hygiene", icon: "filter" },
      // Loose Ends (ADR-127 Phase 3): under-connected items + their top
      // suggested links — the relatedness engine inverted across the corpus.
      { label: "Loose Ends", href: "/build/loose-ends", icon: "affiliate" },
      { label: "Import & Migration", href: "/build/import", icon: "download" },
      // Labelled "AI & MCP", not "Claude": the MCP server is client-agnostic
      // (any MCP-speaking AI can connect), so the surface name stays generic
      // even though Claude is the reference client. Route slug stays /claude.
      { label: "AI & MCP", href: "/build/claude", icon: "bolt" },
      // API Tokens (ADR-179): tokens for non-AI callers — an external app that
      // pushes data in over /api/machine/*. Its own entry rather than a section
      // on AI & MCP, because "give my app an API token" doesn't read as an AI
      // task; the previous home (User Settings → Save from the web) was
      // effectively undiscoverable for that.
      { label: "API", href: "/build/api", icon: "tools" },
      // AI Memory (ADR-137): the durable memory an AI reads over MCP. Gated —
      // the sidebar shows it only when the owner has turned AI Memory on in
      // Settings; the page itself also gates, so it's discoverable-but-off until
      // enabled. "affiliate" (connected nodes) nods to the memory relation graph.
      { label: "AI Memory", href: "/build/memory", icon: "affiliate", gatedBy: "aiMemoryEnabled" },
      // The one deliberate both-places entry: also reachable from the Work kebab
      // so personal/cosmetic settings don't require entering Build. Label stays
      // "User Settings" everywhere (never bare "Settings").
      { label: "User Settings", href: "/settings", icon: "tools" },
    ],
  },
  // SYSTEM = the software and the machine it runs on (updates, network,
  // scheduled jobs, backups), split out of MAINTAIN 2026-09-12 because those
  // four are about running Ledgr, not caring for the data in it.
  {
    label: "SYSTEM",
    entries: [
      // Updates: is this instance running the latest Ledgr, and has its database
      // caught up with the code it's running? It earns a doorway of its own
      // rather than a corner of the Changelog: the Changelog answers "what
      // changed", this answers "am I behind", and only the second one has a
      // button.
      {
        label: "Updates",
        href: "/build/updates",
        icon: "repeat",
        keywords: ["update", "upgrade", "version", "migrate", "latest"],
      },
      // Network (ADR-209): the sync topology — hubs this instance syncs TO,
      // devices that sync FROM it. Split out of Updates the moment a third
      // node made two buried sections illegible.
      {
        label: "Network",
        href: "/build/network",
        icon: "affiliate",
        keywords: ["sync", "hub", "spoke", "device", "peer", "topology", "replication"],
      },
      {
        label: "Scheduled Jobs",
        href: "/build/jobs",
        icon: "repeat",
        keywords: ["jobs", "cron", "schedule", "transcripts", "youtube", "export", "owner"],
      },
      {
        label: "Backups",
        href: "/build/backups",
        icon: "download",
        keywords: ["backup", "snapshot", "restore", "recovery"],
      },
    ],
  },
];

// Every Build entry as a flat list (group order preserved), for the destination
// picker's "Build tools" category and the command palette's section index.
export const BUILD_ENTRIES: BuildEntry[] = BUILD_NAV.flatMap((g) => g.entries);

// True for any route that renders within the Build surface (so NavShell shows
// the Build sidebar). Model Overview is `/build` exactly; everything else is a
// `/build/...` child. The dashboards INDEX (`/dashboards`, the management
// surface: rename/duplicate/delete/reorder + Home/Today assignment) is Build
// chrome; an INDIVIDUAL dashboard (`/dashboards/<id>`) is the "using it"
// context and keeps Work chrome — the destination picker offers dashboards as
// Work-nav slots, and Home/Today already render the same grid under Work
// chrome. (Claiming `/dashboards/...` as Build here is what once made Build
// mode the only way to view an unassigned dashboard.) `/settings` is reachable
// from both sides, so it is NOT treated as Build chrome (it keeps the Work nav
// when reached from the Work kebab); the sidebar's User Settings entry links
// to it.
export function isBuildPath(pathname: string): boolean {
  return (
    pathname === "/build" ||
    pathname.startsWith("/build/") ||
    pathname === "/dashboards"
  );
}
