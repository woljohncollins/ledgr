// Tab strip across the per-type list pages (PRD §4.2) plus the All-items
// browse (which keeps the Trash). The five system types keep their bespoke
// routes (/tasks etc.); custom types (Build surface, ADR-044) are appended,
// each linking to the generic focused list at /list/<key>, so a type you
// create shows up here without a hand-written page. Data-driven now; when the
// view engine fully owns these they become stored views (same seam as nav.ts).
import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { types } from "@/db/schema";

// Active tab is identified by a string: a system tab key, a type key, or "all".
export type ListTabKey = string;

// `person` and `event` are system types with no bespoke page; they ride the
// generic /list/<key> route like custom types do (their tab key is the type
// key, which the generic page sets as the active tab — so the key must match the
// type key, not a plural like "events"). Events unified onto /list/event so the
// calendar feed + timeline could become lenses. Each tab carries its typeKey so
// a hidden type (ADR-059) drops its tab.
const SYSTEM_TABS = [
  { key: "tasks", typeKey: "task", label: "Tasks", href: "/tasks" },
  { key: "event", typeKey: "event", label: "Events", href: "/list/event" },
  { key: "notes", typeKey: "note", label: "Notes", href: "/notes" },
  { key: "links", typeKey: "link", label: "Links", href: "/links" },
  { key: "person", typeKey: "person", label: "People", href: "/list/person" },
];

export default async function ListTabs({ active }: { active: ListTabKey }) {
  const rows = await getDb()
    .select({ key: types.key, label: types.label, isSystem: types.isSystem })
    .from(types)
    // Hidden and trashed types drop out of the tab strip.
    .where(sql`${types.hidden} = false and ${types.deletedAt} is null`);
  const visible = new Set(rows.map((r) => r.key));
  // Keep a system tab only while its type is visible — but never drop the active
  // tab, so you're not stranded on a page whose tab vanished.
  const systemTabs = SYSTEM_TABS.filter(
    (t) => visible.has(t.typeKey) || t.key === active
  );
  // Every other visible type gets a generic tab. This used to filter on
  // `!isSystem`, but `project` and `tag` are built-in now (migration 0052) and
  // must keep their tabs, so the rule is by KEY: exclude the types a SYSTEM_TAB
  // already covers (so nothing renders twice / collides on a duplicate React
  // key) and the utility child types that never deserve a top-level tab
  // (transcript is visible-but-contained; milestone/unmarked/memory are already
  // dropped by the hidden filter above, listed here as a backstop).
  const systemTypeKeys = new Set([
    ...SYSTEM_TABS.map((t) => t.typeKey),
    "transcript",
    "milestone",
    "unmarked",
    "memory",
  ]);
  const custom = rows
    .filter((r) => !systemTypeKeys.has(r.key))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((c) => ({ key: c.key, label: c.label, href: `/list/${c.key}` }));

  const tabs = [
    ...systemTabs,
    ...custom,
    { key: "all", label: "All", href: "/items" },
  ];

  return (
    <div className="flex gap-1 overflow-x-auto border-b border-neutral-800 pb-px">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={`whitespace-nowrap rounded-t px-3 py-1.5 text-sm ${
            tab.key === active
              ? "border-b-2 border-neutral-200 font-medium text-neutral-100"
              : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
