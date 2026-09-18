// AI Memory subsystem (ADR-137). The plumbing behind the `memory` type: the
// always-on "stump" index an AI loads at the start of a session, and the shape
// helpers shared by the MCP tools (tools.ts) and the Build → AI Memory page.
//
// Deterministic by default (Principle 3): nothing here calls a model. The AI
// decides *what* is worth remembering and calls `remember`; this decides which
// stored memories are worth *pushing* every session vs. leaving to be pulled on
// demand. Every read is body-free (Principle 8) and owner-scoped — it reuses the
// same items/relations/views libs the rest of the app does, so the memory
// surface can never drift from the app's own contract.
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items, relations } from "@/db/schema";
import { relatedSummaryFor } from "@/lib/relations";
import { queryViewItems } from "@/lib/views";

export const MEMORY_TYPE = "memory";

// The invalidation edge (ADR-259): OLD memory --supersedes--> NEW memory. The
// old one is never deleted or rewritten; its stump and its search hits render
// "SUPERSEDED <date> -><new id>" so a reader stops having to compare ages.
export const SUPERSEDES_ROLE = "supersedes";

// The two facets that drive the stump index (mirrors the type's property_schema
// in drizzle/0040_memory_type.sql). `kind` = what a memory is about; `horizon` =
// how long it stays true. Both are plain selects; the third field, `pinned`
// (checkbox), forces a stump always-on regardless of horizon/age.
export const MEMORY_KINDS = ["user", "feedback", "project", "reference"] as const;
export const MEMORY_HORIZONS = ["evergreen", "seasonal", "episodic"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryHorizon = (typeof MEMORY_HORIZONS)[number];

// How long a memory whose truth is expected to expire may sit untouched before
// its stump renders a STALE marker (ADR-230). This is a *read-time hedge*, not a
// filter: nothing is ever hidden or deleted, because "this was true once" is
// worth keeping. Evergreen never goes stale by definition.
const STALE_AFTER_DAYS: Record<MemoryHorizon, number> = {
  evergreen: Infinity,
  seasonal: 90,
  episodic: 90,
};

// How many memory rows the always-on read scans to find the pinned few. The
// pinned set is meant to stay under ~15, so this is generous.
// ponytail: full scan of the (body-free) memory rows; push a
// properties->>'pinned' filter into queryViewItems if the store outgrows 500.
const PINNED_SCAN_LIMIT = 500;

export type MemoryStump = {
  id: string;
  title: string;
  kind: MemoryKind | null;
  horizon: MemoryHorizon | null;
  pinned: boolean;
  updatedAt: Date;
  // The newer memory that replaced this one, when a `supersedes` edge exists.
  supersededBy: { id: string; date: string } | null;
  // Up to 4 confirmed neighbours (relatedSummaryFor cap) — the entry points for
  // the "follow the graph" recall. The AI decides whether to pull any of them.
  linked: { id: string; title: string; type: string }[];
};

// Read a memory item's built-in facets tolerantly from its properties jsonb: an
// unknown/renamed/missing value degrades to a sensible default rather than
// throwing (the same posture as parseSettings), so the user editing the type's
// properties in Build can never break the stump reader.
export function memoryFacets(raw: unknown): {
  kind: MemoryKind | null;
  horizon: MemoryHorizon | null;
  pinned: boolean;
} {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = (MEMORY_KINDS as readonly string[]).includes(p.kind as string)
    ? (p.kind as MemoryKind)
    : null;
  const horizon = (MEMORY_HORIZONS as readonly string[]).includes(p.horizon as string)
    ? (p.horizon as MemoryHorizon)
    : null;
  return { kind, horizon, pinned: p.pinned === true };
}

// The stump index. Default = the always-on set, which is `pinned` and nothing
// else (ADR-230). `horizon` deliberately plays no part here: it says whether a
// claim stays TRUE, which is a different question from whether an agent needs it
// loaded on every run. Everything unpinned is Tier 2, pulled on demand by
// search_items(type: "memory"). Pass includeAll for the whole store (the Build
// page's browse view, or an explicit deep recall). Newest-touch first, body-free.
export async function getMemoryStumps(
  ownerId: string,
  opts: { includeAll?: boolean; limit?: number } = {}
): Promise<{ stumps: MemoryStump[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = await queryViewItems(
    ownerId,
    { type: MEMORY_TYPE },
    { field: "updatedAt", dir: "desc" },
    opts.includeAll ? limit : PINNED_SCAN_LIMIT
  );
  // An archived memory is retired: out of the always-on set and out of the
  // browse, but kept (never deleted) for the record. MCP has no trash tool, so
  // status=archived is how an agent retires a memory (ADR-259).
  const live = rows.filter((r) => r.statusCategory !== "archived");
  // Filter before the cap: a pinned memory nobody has touched in months must
  // still load, so the limit applies to what's chosen, not to what's scanned.
  const chosen = (
    opts.includeAll ? live : live.filter((r) => memoryFacets(r.properties).pinned)
  ).slice(0, limit);
  const ids = chosen.map((r) => r.id);
  const [linkedMap, supersededMap] = await Promise.all([
    relatedSummaryFor(ownerId, ids),
    supersededByFor(ownerId, ids),
  ]);
  const stumps = chosen.map((r) => {
    const { kind, horizon, pinned } = memoryFacets(r.properties);
    return {
      id: r.id,
      title: r.title,
      kind,
      horizon,
      pinned,
      updatedAt: r.updatedAt,
      supersededBy: supersededMap.get(r.id) ?? null,
      linked: linkedMap.get(r.id) ?? [],
    };
  });
  return { stumps, total: live.length };
}

// For a set of memories, the live newer memory each one points at with a
// `supersedes` edge (old -> new). One query, body-free, owner-scoped on the
// target. A memory superseded twice reports the most recently touched successor.
export async function supersededByFor(
  ownerId: string,
  ids: string[]
): Promise<Map<string, { id: string; date: string }>> {
  const out = new Map<string, { id: string; date: string }>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select({ oldId: relations.sourceId, id: items.id, updatedAt: items.updatedAt })
    .from(relations)
    .innerJoin(items, eq(items.id, relations.targetId))
    .where(
      and(
        inArray(relations.sourceId, ids),
        eq(relations.role, SUPERSEDES_ROLE),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt)
      )
    )
    .orderBy(desc(items.updatedAt));
  for (const r of rows) {
    if (!out.has(r.oldId)) {
      out.set(r.oldId, { id: r.id, date: r.updatedAt.toISOString().slice(0, 10) });
    }
  }
  return out;
}

// The read-time hedge rendered after a memory's age, in stumps and in
// search_items hits alike (ADR-259): "" | ", STALE" | ", SUPERSEDED <date> -><id>".
// SUPERSEDED wins over STALE: a replaced fact is not merely old, it is retired.
export function memoryMarker(
  horizon: MemoryHorizon | null,
  updatedAt: Date,
  supersededBy: { id: string; date: string } | null,
  now: number = Date.now()
): string {
  if (supersededBy) return `, SUPERSEDED ${supersededBy.date} ->${supersededBy.id}`;
  const ageDays = Math.floor((now - updatedAt.getTime()) / 86_400_000);
  return horizon && ageDays > STALE_AFTER_DAYS[horizon] ? ", STALE" : "";
}

// Near-duplicate check for `remember` (ADR-259): existing live memories whose
// title is trigram-similar to the candidate. Advisory only, never blocks the
// write; the calling agent decides supersede / update / link / proceed.
// ponytail: full-string pg_trgm similarity at a low floor; add an FTS leg if
// long titles start slipping under it.
export async function findSimilarMemoryTitles(
  ownerId: string,
  title: string,
  limit = 3
): Promise<{ id: string; title: string; updatedAt: Date }[]> {
  const t = title.trim();
  if (!t) return [];
  const sim = sql<number>`similarity(lower(${items.title}), lower(${t}))`;
  return getDb()
    .select({ id: items.id, title: items.title, updatedAt: items.updatedAt })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, MEMORY_TYPE),
        isNull(items.deletedAt),
        sql`${sim} >= 0.2`
      )
    )
    .orderBy(desc(sim))
    .limit(limit);
}

// `about`-link nudge for `remember` (ADR-259): live people and projects whose
// full title appears inside the candidate memory title. Deterministic substring
// match, no model. Titles under 4 characters are skipped so "AI" or "PCO" can't
// match everything.
export async function suggestAboutFor(
  ownerId: string,
  title: string,
  limit = 5
): Promise<{ id: string; title: string; type: string }[]> {
  const t = title.trim();
  if (!t) return [];
  return getDb()
    .select({ id: items.id, title: items.title, type: items.type })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        inArray(items.type, ["person", "project"]),
        isNull(items.deletedAt),
        eq(items.isTemplate, false),
        ne(items.title, ""),
        sql`length(${items.title}) >= 4`,
        sql`position(lower(${items.title}) in lower(${t})) > 0`
      )
    )
    .orderBy(desc(items.updatedAt))
    .limit(limit);
}

// Compact relative age, e.g. "today", "3d ago", "5mo ago", "2y ago". Deliberately
// coarser and shorter than relativeTime(): this renders once per stump in a
// context an AI pays for by the token.
export function memoryAge(updatedAt: Date, now: number = Date.now()): string {
  const days = Math.floor((now - updatedAt.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const KIND_ABBR: Record<MemoryKind, string> = {
  user: "user",
  feedback: "feed",
  project: "proj",
  reference: "refr",
};
const HORIZON_ABBR: Record<MemoryHorizon, string> = {
  evergreen: "ever",
  seasonal: "seas",
  episodic: "epis",
};

// One line per stump, for the MCP wire (ADR-230). Pretty-printed JSON of the same
// index ran ~19k tokens and blew the tool-result ceiling; this is ~4x smaller and
// loses nothing an agent needs to judge relevance. `linked` is dropped here (it
// was a third of the payload and most stumps have none); get_item pulls the
// relations along with the body. Ids stay full: the default set is a handful of
// lines, and truncating them would only pay off on the rare includeAll browse
// while forcing get_item to resolve ambiguous prefixes.
export function renderStumpIndex(
  stumps: MemoryStump[],
  total: number,
  now: number = Date.now()
): string {
  const lines = stumps.map((s) => {
    const kind = s.kind ? KIND_ABBR[s.kind] : "?";
    const horizon = s.horizon ? HORIZON_ABBR[s.horizon] : "?";
    const date = s.updatedAt.toISOString().slice(0, 10);
    const marker = memoryMarker(s.horizon, s.updatedAt, s.supersededBy, now);
    return `${s.id} [${kind}/${horizon}] (${date}, ${memoryAge(s.updatedAt, now)}${marker}) ${s.title}`;
  });
  const body = lines.join("\n");
  const header =
    `${stumps.length} shown of ${total} total, ~${Math.round((body.length + 200) / 4)} tokens. ` +
    `Always-on = pinned only. Everything else is Tier 2: find it with ` +
    `search_items(<name>, type: "memory") whenever a task names a person, project, or system. ` +
    `A stump is a pointer; get_item its id for the detail and its links.`;
  return stumps.length ? `${header}\n\n${body}` : header;
}
