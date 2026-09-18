// The destination options the nav-slot editor offers (ADR-056): built-in app
// pages, the owner's saved views, and the item types. A slot's "Points to"
// dropdown is built from these; picking one prefills the slot's href/kind/label/
// icon. Kept as data (no JSX) so the server page can assemble the list and hand
// it to the client editor.
//
// Only routes that actually exist are offered, so a configured slot never
// dead-links. `badgeEligible` marks the one destination (Inbox) that can show a
// count badge for now.
import { BUILD_ENTRIES } from "@/lib/build-nav";
import { isIconRef } from "@/lib/nav-icons";
import { NOTIFICATION_CENTER_ENABLED } from "@/lib/notifications-enabled";
import { SEARCH_HREF, type NavBadge, type NavDestKind } from "@/lib/settings";

export type DestGroup = "Built-in" | "Dashboards" | "Views" | "Types" | "Build tools";

export type DestOption = {
  group: DestGroup;
  kind: NavDestKind;
  href: string;
  label: string;
  icon: string;
  badgeEligible: boolean;
  // Which count this destination shows when its badge is on. Set only on
  // badge-eligible built-ins (inbox / notifications); the editor stamps it onto
  // the stored slot so Nav.tsx reads the right counter.
  badge?: NavBadge;
};

// The built-in pages that make sense as daily-nav destinations. Views/Items/Types
// live here too (they exist as routes); Archive is intentionally absent — there's
// no /archive route yet, so offering it would dead-link. "Types" points at the
// Types directory (/list), the 30k-ft index of every type with its item count.
export const BUILTIN_DESTS: DestOption[] = [
  { group: "Built-in", kind: "builtin", href: "/inbox", label: "Inbox", icon: "inbox", badgeEligible: true, badge: "inbox" },
  { group: "Built-in", kind: "builtin", href: "/notifications", label: "Notifications", icon: "bell", badgeEligible: true, badge: "notifications" },
  { group: "Built-in", kind: "builtin", href: "/tasks", label: "Tasks", icon: "tasks", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/planner", label: "Planner", icon: "calendar", badgeEligible: false },
  // The Desk (ADR-146): a desktop-only multi-panel workspace. Offered in the
  // destination picker so the owner can add it to their own Work nav (ADR-063
  // opt-in posture); it's not a default slot.
  { group: "Built-in", kind: "builtin", href: "/desk", label: "Desk", icon: "grid", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/favorites", label: "Favorites", icon: "starred", badgeEligible: false },
  // ONE Search destination (ADR-182). It used to be listed as "Advanced search"
  // to distinguish the PAGE from the ⌘K palette that every layout hardcoded a
  // second, permanent button for — so a default nav showed search twice, and only
  // one of the two was configurable. Now it's a single icon whose behavior is the
  // owner's `searchMode` choice (palette | page), set on Build → Navigation.
  { group: "Built-in", kind: "builtin", href: SEARCH_HREF, label: "Search", icon: "search", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/dashboards", label: "Dashboards", icon: "dashboard", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/items", label: "Items", icon: "items", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/views", label: "Views", icon: "views", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/list", label: "Types", icon: "layers", badgeEligible: false },
  { group: "Built-in", kind: "builtin", href: "/changelog", label: "Changelog", icon: "changelog", badgeEligible: false },
];

// The Build/Maintain tools as nav destinations (ADR-063): the same hardcoded
// sidebar entries (build-nav.ts), offered as a "Build tools" category so a power
// user can pull a Build tool into their daily Work nav — a "Clean" (Data Hygiene)
// slot, a "New Type" shortcut, etc. This is what makes the cross-the-line
// capability *discoverable* (the separation is the default, not a wall). No route
// is artificially excluded; the picker doesn't enforce the use/build line.
export const BUILD_TOOL_DESTS: DestOption[] = BUILD_ENTRIES.map((e) => ({
  group: "Build tools" as const,
  kind: "builtin" as const,
  href: e.href,
  label: e.label,
  icon: e.icon,
  badgeEligible: false,
}));

export function buildDestOptions(
  views: { id: string; name: string }[],
  types: { key: string; label: string; icon: string | null }[],
  dashboards: { id: string; name: string }[] = []
): DestOption[] {
  return [
    // Notification center paused (ADR-130): don't offer /notifications as a nav
    // destination while it's detached. Re-enabling the flag restores it.
    ...BUILTIN_DESTS.filter(
      (d) => NOTIFICATION_CENTER_ENABLED || d.href !== "/notifications"
    ),
    ...BUILD_TOOL_DESTS,
    ...dashboards.map((d) => ({
      group: "Dashboards" as const,
      kind: "dashboard" as const,
      href: `/dashboards/${d.id}`,
      label: d.name,
      icon: "dashboard",
      badgeEligible: false,
    })),
    ...views.map((v) => ({
      group: "Views" as const,
      kind: "view" as const,
      href: `/views/${v.id}`,
      label: v.name,
      icon: "views",
      badgeEligible: false,
    })),
    ...types.map((t) => ({
      group: "Types" as const,
      kind: "type" as const,
      href: `/list/${t.key}`,
      label: t.label,
      icon: isIconRef(t.icon) ? t.icon : "items",
      badgeEligible: false,
    })),
  ];
}

// Find the option a stored href points at (to resolve badge-eligibility and the
// current dropdown selection). Returns undefined for an orphaned href (e.g. a
// view that was since deleted) — the slot still renders from its stored fields.
export function findDestOption(
  options: DestOption[],
  href: string
): DestOption | undefined {
  return options.find((o) => o.href === href);
}
