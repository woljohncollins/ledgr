// Configurable, category-backed task statuses (Tasks Polish S2, ADR-082).
//
// The problem this solves: status was a hardcoded enum (open/done/archived).
// Now a type can define its own ordered statuses with labels + colors, and the
// user can add as many as they like. The trick that keeps every existing query,
// the done-checkbox, and recurrence working unchanged: each status belongs to
// one fixed *category*, and the plumbing keys off the category, never the label.
//
//   - Categories are fixed and small (the four below). They are the only thing
//     the hot queries, the checkbox, and recurrence-complete look at.
//   - Statuses are the user's: any number, any label/color, each mapped to one
//     category. They are what every surface *displays* and what a kanban groups
//     by — never the bare category.
//
// Pure + client-safe (no DB, no server imports) so the editor, the canvas, the
// board, and the verify script all share one source of truth — the same split
// as recurrence.ts / canvas-layout.ts.

// The four fixed categories. `not_started` + `in_progress` are both "active"
// (what the old status='open' meant); `done` is complete (the checkbox +
// recurrence-complete target); `archived` is the terminal/closed bucket (what
// status='archived' meant). The user never edits this list — they add statuses
// *into* these buckets.
export const STATUS_CATEGORIES = [
  "not_started",
  "in_progress",
  "done",
  "archived",
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

// Categories that count as "active / not yet complete" — exactly what
// status='open' covered before. Hot queries (Today, the default task filter,
// the subtask-progress denominator) test membership in this set.
export const ACTIVE_CATEGORIES: StatusCategory[] = ["not_started", "in_progress"];

// Display + ordering metadata for the category groups (the Build editor's four
// sections, in this order). "Closed" reads better than "Archived" as a group
// header (ClickUp's framing), while the default status in it keeps the familiar
// "Archived" label and `archived` key.
export const CATEGORY_META: Record<
  StatusCategory,
  { label: string; order: number }
> = {
  not_started: { label: "Not Started", order: 0 },
  in_progress: { label: "In Progress", order: 1 },
  done: { label: "Done", order: 2 },
  archived: { label: "Closed", order: 3 },
};

// A sensible starting color when the user adds a new status to a category (they
// can recolor it). Slate / blue / green / gray.
export const CATEGORY_DEFAULT_COLOR: Record<StatusCategory, string> = {
  not_started: "#64748b",
  in_progress: "#3b82f6",
  done: "#16a34a",
  archived: "#6b7280",
};

// One status in a type's schema. `key` is the stable slug stored in
// items.status (immutable once created, like a property key — renaming the
// label never rewrites rows); `category` is the fixed bucket the plumbing uses;
// `color` themes its chip/column; `isDefault` marks the pick the system reaches
// for within that category (the new-item status for not_started, the target the
// done-checkbox sets for done).
export type StatusDef = {
  key: string;
  label: string;
  category: StatusCategory;
  color: string;
  isDefault?: boolean;
};

// The default set every type inherits when it defines none. Deliberately the
// original three, recategorized — so no existing row needs rewriting (the keys
// open/done/archived are preserved) and behavior is unchanged until the user
// adds a status. The In Progress category ships empty: the plumbing is ready,
// it just has no status in it yet (add one and it works system-wide).
export const SYSTEM_DEFAULT_STATUSES: StatusDef[] = [
  { key: "open", label: "To Do", category: "not_started", color: "#64748b", isDefault: true },
  { key: "done", label: "Done", category: "done", color: "#16a34a", isDefault: true },
  { key: "archived", label: "Archived", category: "archived", color: "#6b7280", isDefault: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-type status DISPLAY MODE (ADR-106). ORTHOGONAL to the categories above:
// categories are the completion *plumbing* (every hot query, the done-checkbox,
// and recurrence-complete key off them); the mode is only how a type *presents*
// that plumbing. Three modes:
//
//   - "none"     — the type has no completion concept (person, link, most notes).
//                  No status control on the canvas, no status filter/group/column
//                  in the view builder, no chip/checkbox in lists. The row still
//                  carries the harmless status/status_category defaults in the DB;
//                  "none" only hides the affordance (defer-by-hiding).
//   - "checkbox" — a binary done / not-done checkbox (the default for `task`).
//                  Checking completes to the 'done' category default via the same
//                  toggleItemDone the row/subtask checkboxes use; unchecking
//                  returns to the 'not_started' default. Any extra statuses in the
//                  resolved schema simply aren't surfaced.
//   - "select"   — the full multi-status dropdown / colored kanban (e.g. project:
//                  Ongoing / Waiting for Others / Paused / Future / Done).
//
// WHY a mode and NOT a boolean `done` column — DO NOT "simplify" this back to one
// (ADR-106, building on ADR-082): the done/undone the user sees in checkbox mode
// is ALREADY the category plumbing — `status_category === 'done'` IS the boolean.
// Collapsing status to a real boolean would delete the category abstraction that
// (a) lets a recurring task advance instead of "completing", (b) backs the
// `archived` / `in_progress` buckets and the planned archive axis, (c) lets
// `project` (and any type) keep genuine multi-status, and (d) keeps the
// machine/MCP status contract (a text key + a category) stable. The mode is the
// cheap, reversible presentation choice; the category is the load-bearing model.
// Switching a type to checkbox/none NEVER rewrites its stored status_schema, so
// flipping back to "select" restores the user's statuses untouched.
export const STATUS_MODES = ["none", "checkbox", "select"] as const;
export type StatusMode = (typeof STATUS_MODES)[number];

export function isStatusMode(v: unknown): v is StatusMode {
  return typeof v === "string" && (STATUS_MODES as readonly string[]).includes(v);
}

// Read-tolerant resolve of a type's stored status_mode (types.status_mode).
// Status is opt-in: an unset/unknown mode resolves to "none" so a brand-new type
// shows no status noise until the user enables it — UNLESS the type already
// defines custom statuses, where it resolves to "select" so a multi-status type
// can never accidentally hide its own statuses. System types are seeded
// explicitly (task=checkbox, project=select, the rest=none); this default only
// governs hand-edited or freshly-created rows.
export function resolveStatusMode(
  raw: unknown,
  hasCustomSchema = false
): StatusMode {
  if (isStatusMode(raw)) return raw;
  return hasCustomSchema ? "select" : "none";
}

// Slug shape shared with type/property keys (types.ts SLUG_RE): a stable JS-safe
// identifier, lowercased so "Done" and "done" can't both exist.
const STATUS_KEY_RE = /^[a-z][a-z0-9_]*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isCategory(v: unknown): v is StatusCategory {
  return typeof v === "string" && (STATUS_CATEGORIES as readonly string[]).includes(v);
}

// Tolerant parse of a stored/submitted status schema. Returns null when the
// value isn't a usable list (so the caller falls back to the inherited default
// — a type with null status_schema inherits, exactly like a board with no
// grouping). A malformed entry is dropped, not fatal; an unparseable shape
// degrades to null rather than throwing on read (mirrors parsePropertySchema's
// read-tolerance). Strict validation for *saves* lives in validateStatusSchema.
export function parseStatusSchema(raw: unknown): StatusDef[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: StatusDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key.trim().toLowerCase() : "";
    if (!key || key.length > 40 || !STATUS_KEY_RE.test(key) || seen.has(key)) continue;
    if (!isCategory(e.category)) continue;
    const label =
      typeof e.label === "string" && e.label.trim() ? e.label.trim().slice(0, 60) : key;
    const color =
      typeof e.color === "string" && HEX_RE.test(e.color)
        ? e.color
        : CATEGORY_DEFAULT_COLOR[e.category];
    seen.add(key);
    out.push({
      key,
      label,
      category: e.category,
      color,
      ...(e.isDefault === true ? { isDefault: true as const } : {}),
    });
  }
  return out.length ? normalizeDefaults(out) : null;
}

// Guarantee each *present* category has exactly one default (the flagged one,
// else the first status in that category). Pure; used after parse + resolve so
// every lookup of "the default status for a category" is well-defined.
function normalizeDefaults(schema: StatusDef[]): StatusDef[] {
  const defaulted = new Set<StatusCategory>();
  return schema.map((s) => {
    if (s.isDefault && !defaulted.has(s.category)) {
      defaulted.add(s.category);
      return s;
    }
    return s.isDefault ? { ...s, isDefault: undefined } : s;
  }).map((s) => {
    // If a category had no flagged default, the first status in it becomes one.
    if (!defaulted.has(s.category)) {
      defaulted.add(s.category);
      return { ...s, isDefault: true as const };
    }
    return s;
  });
}

// The effective status set for a type: its own schema, else the system default.
// (An owner-level editable default could slot in between later; the resolution
// point is centralized here so adding it is a one-line change.) Always returns a
// non-empty, defaults-normalized list.
export function resolveStatusSchema(typeSchema: StatusDef[] | null): StatusDef[] {
  const base = typeSchema && typeSchema.length ? typeSchema : SYSTEM_DEFAULT_STATUSES;
  return normalizeDefaults(base);
}

// Look up one status by key within a resolved schema.
export function statusDef(schema: StatusDef[], key: string): StatusDef | undefined {
  return schema.find((s) => s.key === key);
}

// The category a status key belongs to, per the resolved schema. Falls back to
// not_started for an unknown key (a status removed from the schema while a row
// still holds it reads as "active" rather than vanishing) — the re-sync on a
// schema edit keeps this from happening in practice.
export function categoryOfStatus(schema: StatusDef[], key: string): StatusCategory {
  return statusDef(schema, key)?.category ?? "not_started";
}

// Resolve a caller-supplied status to a real key in this type's schema (ADR-243).
// Accepts the KEY, the key in any case, or the LABEL in any case: a model reading
// list_types will send "Waiting for Others" as readily as `waiting`, and no API
// caller should have to know which of the two Ledgr stores. Returns null when
// nothing matches, so a WRITE can refuse instead of storing a key the type
// doesn't have — which renders as nothing on the canvas and silently buckets as
// not_started through categoryOfStatus's read-path fallback above. That fallback
// is deliberate and stays: forgiving on READ (a status dropped from the schema
// while rows still hold it), strict on WRITE (a key that was never real).
export function resolveStatusKey(
  schema: StatusDef[],
  input: string
): string | null {
  const want = input.trim().toLowerCase();
  if (!want) return null;
  // Keys are always lowercase slugs, so the key pass is already case-insensitive.
  return (
    schema.find((s) => s.key === want)?.key ??
    schema.find((s) => s.label.trim().toLowerCase() === want)?.key ??
    null
  );
}

// The default status key for a category (the isDefault one, else the first in
// that category, else null when the category is empty). The new-item status is
// defaultStatusKey(schema,'not_started'); the done-checkbox target is
// defaultStatusKey(schema,'done').
export function defaultStatusKey(
  schema: StatusDef[],
  category: StatusCategory
): string | null {
  const inCat = schema.filter((s) => s.category === category);
  if (inCat.length === 0) return null;
  return (inCat.find((s) => s.isDefault) ?? inCat[0]).key;
}

// The status a brand-new item of this type should get (ADR-111/PJ2). Prefer the
// schema's first explicitly-default NON-terminal status, so a type whose working
// default is in_progress (a Project's "Active"/"Ongoing") starts there instead
// of being forced into a not_started bucket; then fall back to the not_started
// default, then the first non-terminal status, then "open". A type with an
// explicit not_started default (task/note/…) is unchanged — that status is found
// first either way.
export function initialStatusKey(schema: StatusDef[]): string {
  const nonTerminal = schema.filter(
    (s) => s.category !== "done" && s.category !== "archived"
  );
  const explicit = nonTerminal.find((s) => s.isDefault);
  if (explicit) return explicit.key;
  return defaultStatusKey(schema, "not_started") ?? nonTerminal[0]?.key ?? "open";
}

export const isActiveCategory = (c: StatusCategory) => ACTIVE_CATEGORIES.includes(c);
export const isDoneCategory = (c: StatusCategory) => c === "done";

// The TERMINAL buckets — finished work, the columns you don't work out of. A
// kanban collapses these to a rail by default (board-prefs.ts) so a board reads
// as live work on arrival. Not the same question as isActiveCategory: `archived`
// is neither active nor done, and belongs on this side of the line.
export const isTerminalCategory = (c: StatusCategory) =>
  c === "done" || c === "archived";

// Statuses in canonical display order: by category order, preserving the
// author's order within a category. The order a kanban shows columns and a
// dropdown lists options.
export function orderedStatuses(schema: StatusDef[]): StatusDef[] {
  return [...schema].sort(
    (a, b) =>
      CATEGORY_META[a.category].order - CATEGORY_META[b.category].order
  );
}

// Strict validation for a *save* (the Build editor / API), distinct from the
// read-tolerant parse. Returns the normalized schema or throws `message` via the
// provided `fail`. Rules: 1..50 statuses, valid slugs/labels/colors/categories,
// unique keys, and — so the checkbox and "active" semantics always work — at
// least one `done` status and at least one active (not_started/in_progress) one.
export function validateStatusSchema(
  raw: unknown,
  fail: (message: string) => never
): StatusDef[] {
  if (!Array.isArray(raw)) fail("statuses must be an array");
  const arr = raw as unknown[];
  if (arr.length === 0) fail("a type needs at least one status");
  if (arr.length > 50) fail("a type can have at most 50 statuses");
  const out: StatusDef[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("each status must be an object");
    }
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key.trim().toLowerCase() : "";
    if (!key || !STATUS_KEY_RE.test(key) || key.length > 40) {
      fail(`status key '${String(e.key)}' must start with a letter and use only letters, digits, _`);
    }
    if (seen.has(key)) fail(`duplicate status key '${key}'`);
    if (!isCategory(e.category)) fail(`status '${key}' has an unknown category`);
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (!label) fail(`status '${key}' needs a label`);
    if (label.length > 60) fail(`status '${key}' label too long`);
    const color = typeof e.color === "string" && HEX_RE.test(e.color) ? e.color : null;
    if (!color) fail(`status '${key}' needs a hex color`);
    seen.add(key);
    out.push({
      key,
      label,
      category: e.category as StatusCategory,
      color,
      ...(e.isDefault === true ? { isDefault: true as const } : {}),
    });
  }
  if (!out.some((s) => s.category === "done")) {
    fail("a type needs at least one Done status (the checkbox completes to it)");
  }
  if (!out.some((s) => isActiveCategory(s.category))) {
    fail("a type needs at least one active status (Not Started or In Progress)");
  }
  return normalizeDefaults(out);
}
