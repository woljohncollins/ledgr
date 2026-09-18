// Server wrapper for the nav shell: resolves the signed-in owner (no nav on
// the signed-out hero or /sign-in), reads the owner's configurable nav slots
// (ADR-056), fills any count badges (PRD §4.11), and gathers the type options
// the quick-capture modal offers, before handing render-ready slots to the
// client chrome.
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { types } from "@/db/schema";
import NavAuthHeal from "@/components/nav/NavAuthHeal";
import NavShell, {
  type ShellDest,
  type ShellSlot,
} from "@/components/nav/NavShell";
import { INBOX_SOURCES, routeFor } from "@/lib/inbox-sources";
import { countInbox } from "@/lib/items";
import { countUnread } from "@/lib/notifications";
import { NOTIFICATION_CENTER_ENABLED } from "@/lib/notifications-enabled";
import { resolveOwnerState } from "@/lib/owner";
import {
  getSettings,
  type NavBadge,
  type NavSlotConfig,
} from "@/lib/settings";
import { syncEnabled } from "@/lib/sync/client";
import { compareTypeKeys } from "@/lib/type-order";
import { listTypes } from "@/lib/types";

export default async function Nav() {
  // No owner, no nav — correct for the signed-out hero and /sign-in, since this
  // renders from the root layout on every route. But note what it costs when the
  // owner fails to resolve for a BAD reason (ADR-184): the bar/rail disappears
  // whole, kebab and user menu with it, and the page body still renders — so the
  // symptom reads as "the user menu vanished," not "auth is broken." Two things
  // make that diagnosable now, and neither belongs here: resolveOwnerState logs
  // the unrecognized-session case (src/lib/owner.ts), and the middleware refuses
  // to serve a deployment with no auth configured (src/proxy.ts). If you are
  // looking at a nav-less page, check those two before suspecting the nav.
  // A THIRD door (ADR-216): the post-sign-in soft navigation reuses the root
  // layout from its signed-out render, so the nav is missing even though auth
  // and the owner row are fine. NavAuthHeal (mounted below on signed-out
  // renders) detects that and router.refresh()es the chrome back.
  const state = await resolveOwnerState();
  if (state.kind !== "owner") {
    // A signed-out render additionally mounts the self-heal (ADR-216): if the
    // client-side Clerk session turns out to disagree — the post-sign-in soft
    // navigation that keeps this stale signed-out layout — it refreshes the
    // router once so the real chrome takes over. "unrecognized" deliberately
    // does NOT mount it: that state is signed-in on both sides, so a heal
    // refresh would loop without ever changing anything.
    return state.kind === "signed-out" &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
      <NavAuthHeal />
    ) : null;
  }
  const owner = state.owner;

  // Quick-capture types are data-driven and opt-in (type-and-kind-ux §2): only
  // types flagged show_in_quick_capture appear, so a custom type can be
  // captured into and a "data only" one can stay out of the dropdown.
  const [inboxCount, unreadCount, typeRows, settings, buildTypes] = await Promise.all([
    countInbox(owner.id),
    // Notification center paused (ADR-130): skip the unread query, badge stays 0.
    NOTIFICATION_CENTER_ENABLED ? countUnread(owner.id) : Promise.resolve(0),
    getDb()
      .select({ key: types.key, label: types.label })
      .from(types)
      .where(
        and(
          eq(types.showInQuickCapture, true),
          eq(types.hidden, false),
          isNull(types.deletedAt)
        )
      ),
    getSettings(owner.id),
    // The owner's live types (non-hidden, non-deleted) for the Build sidebar's
    // Types & Properties dropdown. Tiny instance-global table; cheap to read.
    listTypes(),
  ]);
  typeRows.sort((a, b) => compareTypeKeys(a.key, b.key));

  const counts: Record<NavBadge, number | null> = {
    inbox: inboxCount,
    notifications: unreadCount,
  };
  const badgeCount = (badge?: NavBadge) => (badge ? counts[badge] : null);

  const toDest = (d: {
    href: string;
    label: string;
    icon: string;
    badge?: NavBadge;
  }): ShellDest => ({
    label: d.label,
    href: d.href,
    icon: d.icon,
    count: badgeCount(d.badge),
  });

  const toShellSlot = (slot: NavSlotConfig): ShellSlot => {
    if (slot.type === "tools") {
      // A group surfaces the sum of its badge-carrying children's counts, so a
      // collapsed group still shows there's something waiting inside.
      const childCounts = slot.children
        .map((c) => badgeCount(c.badge))
        .filter((n): n is number => typeof n === "number");
      const groupCount = childCounts.length
        ? childCounts.reduce((a, b) => a + b, 0)
        : null;
      return {
        kind: "tools",
        label: slot.label,
        icon: slot.icon,
        count: groupCount,
        children: slot.children.map(toDest),
      };
    }
    return { kind: "destination", ...toDest(slot) };
  };

  // The Inbox hides itself when nothing feeds it (ADR-249): no arrival path
  // routes there AND nothing is sitting in it. A filter over two values already
  // awaited above, no extra query. Mind the defaults — six of the seven sources
  // default to "inbox" — so an owner who has configured nothing still sees it.
  // This HIDES THE NAV SLOT, NEVER THE ROUTE: /inbox keeps working, reachable
  // from /build/capture and the command palette, so a preference can't strand
  // whatever is already sitting in there.
  const showInbox =
    inboxCount > 0 ||
    INBOX_SOURCES.some((s) => routeFor(settings.inboxRoutes, s.key).inbox);
  const keep = (d: { href: string }) => showInbox || d.href !== "/inbox";
  const shellSlots = (config: NavSlotConfig[]) =>
    config
      .filter((s) => s.type === "tools" || keep(s))
      .map((s) => (s.type === "tools" ? { ...s, children: s.children.filter(keep) } : s))
      .map(toShellSlot);

  const slots = shellSlots(settings.navSlots);
  // null mobileNavSlots mirrors the desktop list.
  const mobileSlots = shellSlots(settings.mobileNavSlots ?? settings.navSlots);

  return (
    <NavShell
      slots={slots}
      mobileSlots={mobileSlots}
      unreadCount={unreadCount}
      typeOptions={typeRows}
      buildTypes={buildTypes.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))}
      aiMemoryEnabled={settings.aiMemoryEnabled}
      navPosition={settings.navPosition}
      railSize={settings.railSize}
      navDensity={settings.navDensity}
      railAnchor={settings.railAnchor}
      searchMode={settings.searchMode}
      syncEnabled={syncEnabled()}
    />
  );
}
