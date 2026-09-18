// List lenses: the per-type tab strip on the generic /list/[type] page and the
// bespoke Notes/Links lists (the /tasks tab pattern generalized to every type).
// A lens is either a SORT (the plain item list in a chosen order) or a VIEW (a
// saved view rendered with ViewRenderer — the dashboard "view widget" reused as
// a tab). Four sort lenses are virtual defaults every type gets for free; the
// owner can reorder/rename/add/remove them per type in Build, stored in
// users.settings.listTabs (no schema change, same posture as navSlots /
// favorites). This module is pure and client-safe (no DB / server imports), so
// settings.ts, the list pages, and the client editor all share it.
import type { ListSort } from "@/lib/views";

// --- Types ----------------------------------------------------------------

// A sort lens orders the plain list by a built-in field or one of the type's
// own properties (numeric = cast the JSONB text to a number for ordering).
export type LensSortSource =
  | { field: LensField }
  | { property: string; numeric?: boolean };

// Bespoke lenses render a custom body instead of a sorted list or a saved view.
// They carry no sort/source — the list page branches on `kind` to pick the body.
// Both are event-only defaults (see defaultLenses): "calendar" is the un-promoted
// upcoming calendar feed with one-click Add; "timeline" is the Upcoming/Past/
// No-date grouping by meeting time. External-data / grouped renderings like these
// aren't expressible as sort or view lenses, so they get their own kinds.
export type Lens =
  | { id: string; kind: "sort"; label: string; source: LensSortSource; dir: "asc" | "desc" }
  | { id: string; kind: "view"; label: string; viewId: string }
  | { id: string; kind: "calendar"; label: string }
  | { id: string; kind: "timeline"; label: string }
  // The status kanban of a type (Tyler, 2026-08-25) and its completed-work
  // archive. Both are SYNTHETIC view lenses: they render through ViewRenderer
  // like a "view" lens, but over a view definition built on the fly from the
  // type (see resolveSyntheticLens in view-render.ts) rather than a saved view.
  // That's what lets a type ship a board as its DEFAULT tab — a "view" lens
  // needs a stored view id, which a fresh instance doesn't have.
  | { id: string; kind: "board"; label: string }
  | { id: string; kind: "completed"; label: string };

// Built-in sort fields a lens can use. A subset of the view engine's columns
// plus "mostLinked" (the confirmed-relation count). Date/scheduled/meeting
// fields aren't offered as generic defaults (they're type-specific); a type
// that wants them adds a property lens or a view lens.
// "urgency" (task priority P1–P6, ADR-096) is allowed for tasks so a list tab
// can order by priority; it's only OFFERED by the editor where the type has it
// (see ListTabsEditor), not in the generic default strip.
export const LENS_FIELDS = ["updatedAt", "createdAt", "title", "mostLinked", "urgency"] as const;
export type LensField = (typeof LENS_FIELDS)[number];

const LENS_CAP = 12; // per type
const TYPE_CAP = 200; // distinct types with overrides
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Defaults -------------------------------------------------------------

// The virtual default strip a type gets when it has no stored override. Each
// sort lens is reversible at render time via the active-tab direction toggle, so
// "A → Z" inverts to "Z → A", "Most linked" to "Least linked", etc. The event
// type prepends two bespoke lenses (Calendar feed, then the meeting-time
// Timeline) ahead of the generic sorts — the calendar-import surface Brandon
// clicks to add meetings, kept default/leftmost but reorderable and hideable in
// Build like any tab. Every other type gets just the four generic sorts.
export function defaultLenses(typeKey?: string): Lens[] {
  const generic: Lens[] = [
    { id: "recent", kind: "sort", label: "Recent", source: { field: "updatedAt" }, dir: "desc" },
    { id: "newest", kind: "sort", label: "Newest", source: { field: "createdAt" }, dir: "desc" },
    { id: "az", kind: "sort", label: "A → Z", source: { field: "title" }, dir: "asc" },
    { id: "linked", kind: "sort", label: "Most linked", source: { field: "mostLinked" }, dir: "desc" },
  ];
  // A type with real multi-stage statuses leads with its BOARD (Tyler,
  // 2026-08-25): for projects the kanban is the primary way the work is read,
  // not a tab you go find. "Completed" closes the strip — the searchable archive
  // of finished work, which is what lets the board's Done column stay collapsed
  // without anything becoming unreachable. Both are reorderable/removable in
  // Build like any other tab, and this only sets the DEFAULT strip.
  if (typeKey === "project") {
    return [
      { id: "board", kind: "board", label: "Board" },
      ...generic,
      { id: "completed", kind: "completed", label: "Completed" },
    ];
  }
  if (typeKey === "event") {
    return [
      { id: "calendar", kind: "calendar", label: "Calendar" },
      // "Agenda" (not "Timeline") — the meeting-time upcoming/past list. Renamed
      // from "Timeline" (ADR-166) so it isn't confused with the planner's new
      // Timeline calendar mode; the internal kind stays "timeline" (no migration).
      { id: "timeline", kind: "timeline", label: "Agenda" },
      ...generic,
    ];
  }
  return generic;
}

// The lenses for a type: the stored override if present and non-empty, else the
// virtual defaults. Typed structurally so this file needs no settings import.
export function lensesForType(
  settings: { listTabs?: Record<string, Lens[]> },
  typeKey: string
): Lens[] {
  const stored = settings.listTabs?.[typeKey];
  return stored && stored.length ? stored : defaultLenses(typeKey);
}

// Pick the active lens from a `?lens=` param, falling back to the first lens.
export function selectLens(lenses: Lens[], lensParam: string | undefined): Lens {
  return lenses.find((l) => l.id === lensParam) ?? lenses[0] ?? defaultLenses()[0];
}

// The settings.relatedLensChoices key for "this host type's view of that related
// type" (the Tasks group under a Meeting can differ from Tasks under a Person).
// Pure + client-safe so the panel picker and the server resolver share it.
export function relatedLensKey(hostType: string, relatedType: string): string {
  return `${hostType}:${relatedType}`;
}

// The lenses a related-type group can render: sort and view only. Bespoke
// lenses (calendar/timeline) are list-page surfaces — a calendar feed or a
// meeting-time timeline makes no sense inside a host item's related panel — so
// they're filtered out of both the default choice and the panel's lens picker.
// Falls back to the generic defaults if a type somehow has no supported lens.
export function relatedLensCandidates(lenses: Lens[]): Lens[] {
  const supported = lenses.filter((l) => l.kind === "sort" || l.kind === "view");
  return supported.length ? supported : defaultLenses();
}

// The lens that structures a related-type group: the owner's stored choice for
// (hostType:relatedType) if it still exists among that type's supported lenses,
// else the related type's default (first supported) lens.
export function relatedLensFor(
  settings: { listTabs?: Record<string, Lens[]>; relatedLensChoices?: Record<string, string> },
  hostType: string,
  relatedType: string
): Lens {
  const lenses = relatedLensCandidates(lensesForType(settings, relatedType));
  const chosenId = settings.relatedLensChoices?.[relatedLensKey(hostType, relatedType)];
  return lenses.find((l) => l.id === chosenId) ?? lenses[0];
}

// Map a SORT lens to the engine's ListSort, flipping direction when reversed.
// View lenses render via ViewRenderer instead, so they return null here.
export function resolveLensSort(lens: Lens, reversed: boolean): ListSort | null {
  if (lens.kind !== "sort") return null;
  const dir: "asc" | "desc" = reversed ? (lens.dir === "asc" ? "desc" : "asc") : lens.dir;
  if ("property" in lens.source) {
    return { field: "property", propertyKey: lens.source.property, numeric: lens.source.numeric, dir };
  }
  return { field: lens.source.field, dir } as ListSort;
}

// --- Editor helpers -------------------------------------------------------

type PropLike = { key: string; label: string; kind: string };

// The type's properties that make sense to sort a lens by: text, number, date,
// and single-select. (multi_select is an array; url/checkbox/relation aren't
// useful orderings.) Numeric properties get the numeric cast in the query.
export function lensPropertyOptions(
  schema: PropLike[]
): { key: string; label: string; numeric: boolean }[] {
  return schema
    .filter((p) => p.kind === "text" || p.kind === "number" || p.kind === "date" || p.kind === "select")
    .map((p) => ({ key: p.key, label: p.label, numeric: p.kind === "number" }));
}

// --- Validation (used by parseSettings + the API route) -------------------

function isLensField(v: unknown): v is LensField {
  return typeof v === "string" && (LENS_FIELDS as readonly string[]).includes(v);
}

function parseLens(raw: unknown): Lens | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim().slice(0, 40) : "";
  const label = typeof r.label === "string" ? r.label.trim().slice(0, 40) : "";
  if (!id || !label) return null;

  if (r.kind === "view") {
    const viewId = typeof r.viewId === "string" && UUID_RE.test(r.viewId) ? r.viewId : "";
    if (!viewId) return null;
    return { id, kind: "view", label, viewId };
  }

  // Bespoke bodies: id + label, no source.
  if (r.kind === "calendar") return { id, kind: "calendar", label };
  if (r.kind === "timeline") return { id, kind: "timeline", label };
  if (r.kind === "board") return { id, kind: "board", label };
  if (r.kind === "completed") return { id, kind: "completed", label };

  // Default kind is "sort".
  const dir: "asc" | "desc" = r.dir === "asc" ? "asc" : "desc";
  const src = r.source && typeof r.source === "object" ? (r.source as Record<string, unknown>) : {};
  if (typeof src.property === "string" && src.property.trim()) {
    const property = src.property.trim().slice(0, 40);
    return { id, kind: "sort", label, source: { property, numeric: src.numeric === true }, dir };
  }
  if (isLensField(src.field)) {
    return { id, kind: "sort", label, source: { field: src.field }, dir };
  }
  return null;
}

// Parse a stored lens array: drop malformed entries, dedupe by id, cap the
// count. Returns null when nothing valid remains, so the type falls back to the
// virtual defaults (an empty override is not a meaningful "no tabs" choice).
export function parseLenses(raw: unknown): Lens[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Lens[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const lens = parseLens(entry);
    if (!lens || seen.has(lens.id)) continue;
    seen.add(lens.id);
    out.push(lens);
    if (out.length >= LENS_CAP) break;
  }
  return out.length ? out : null;
}

// Parse the whole listTabs map (typeKey → lenses) for parseSettings. Tolerant:
// drop unusable keys/values, cap the number of customized types.
export function parseListTabs(raw: unknown): Record<string, Lens[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Lens[]> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= TYPE_CAP) break;
    const k = key.trim().slice(0, 60);
    if (!k) continue;
    const lenses = parseLenses(value);
    if (lenses) {
      out[k] = lenses;
      count++;
    }
  }
  return out;
}
