// Where each arrival path lands (ADR-249). Seven paths create items without a
// person choosing a home for them, and until now all seven hardcoded
// `inbox: true`, so the Inbox was compulsory. Each one now names itself with a
// `source` and the owner routes it: queue it in the Inbox, file it straight
// away, or drop it into a project.
//
// A route is ONE string per source — "inbox", "filed", or a project's id —
// stored free-text-keyed in settings.inboxRoutes, following notifications.kind
// so a new source never needs a migration.
import { SETTINGS_UUID_RE } from "@/lib/settings";

// The arrival paths, in the order the Capture settings UI lists them. `key` is
// the value a call site passes as ItemInput.source and the key under
// settings.inboxRoutes.
export const INBOX_SOURCES = [
  {
    key: "quick_capture",
    label: "Quick capture",
    help: "The capture box you open with the q shortcut.",
    defaultRoute: "inbox",
  },
  {
    key: "share_target",
    label: "Phone share sheet",
    help: "A link, note or transcript shared to Ledgr from another app.",
    defaultRoute: "inbox",
  },
  {
    key: "web_clipper",
    label: "Web clipper",
    help: "Pages saved with the browser bookmarklet.",
    defaultRoute: "inbox",
  },
  {
    key: "email_in",
    label: "Email in",
    help: "Messages pulled in by the email sync.",
    defaultRoute: "inbox",
  },
  {
    key: "todoist",
    label: "Todoist",
    help: "Tasks pulled in from your Todoist inbox.",
    defaultRoute: "inbox",
  },
  {
    key: "mention_create",
    label: "New from an @-mention",
    help: "Items created by mentioning a name that doesn't exist yet.",
    defaultRoute: "inbox",
  },
  {
    key: "ai_mcp",
    label: "Claude",
    help: "Items Claude files over the assistant connection.",
    defaultRoute: "filed",
  },
] as const;

export type InboxSourceKey = (typeof INBOX_SOURCES)[number]["key"];

// Resolve one source's route. An unknown source key, a missing value, or a
// value that survived a hand-edit of the settings blob falls back to the
// source's default (and to the Inbox for a source with no row at all), so a bad
// route can never strand a capture somewhere unfindable.
export function routeFor(
  routes: Record<string, string>,
  source: string
): { inbox: boolean; destinationId: string | null } {
  const fallback =
    INBOX_SOURCES.find((s) => s.key === source)?.defaultRoute ?? "inbox";
  const raw = routes[source];
  const route =
    raw === "inbox" || raw === "filed" || (typeof raw === "string" && SETTINGS_UUID_RE.test(raw))
      ? raw
      : fallback;
  if (route === "inbox") return { inbox: true, destinationId: null };
  if (route === "filed") return { inbox: false, destinationId: null };
  return { inbox: false, destinationId: route };
}
