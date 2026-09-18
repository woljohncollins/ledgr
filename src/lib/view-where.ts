// View rule conditions (ADR-164): the optional AND/OR "rules" layer on a View
// Definition's filter, letting the owner filter by ANY property (custom ones
// included) and relation, combined by a single combinator ("match all" / "match
// any"). This module is pure and client-safe (no DB / server imports), so the
// ViewBuilder's RuleBuilder, the parse layer, and the SQL builder in views.ts
// all share one vocabulary of subjects, operators, and validation.
//
// Scope by decision (Brandon, 2026-07-19): ONE combinator per view (a flat list
// of conditions that are all-AND or all-OR), not a nested tree. Nesting can come
// later as its own additive step. The group is AND-ed with the view's existing
// scalar filters (type/status/urgency/date/relatedTo), so "tasks tagged A or B"
// is `type=task AND (tagged A OR tagged B)`.

// The operators a condition can use. Not every op is valid for every subject —
// opsForKind() narrows the menu the builder offers, and parse tolerantly drops a
// condition whose op/value shape is incoherent.
export const WHERE_OPS = [
  "set", // has any value
  "empty", // has no value
  "eq", // equals (scalar) — also array membership for multi_select
  "neq", // not equals
  "contains", // substring (text/url)
  "gt", // > / after
  "lt", // < / before
  "gte", // ≥ / on or after
  "lte", // ≤ / on or before
  "anyOf", // is any of (OR over values)
  "allOf", // has all of (AND over values)
  "noneOf", // is none of (NOT any)
  "checked", // checkbox true
  "unchecked", // checkbox false/absent
] as const;
export type WhereOp = (typeof WHERE_OPS)[number];

// What a condition is ABOUT. "property" = a scalar field in items.properties;
// "relation" = a typed relation field (Tags/People/Project…), matched against
// relations edges by role; "priority"/"status" = the two built-in fields worth
// mixing into a rule (so "priority is P1 OR tagged urgent" is expressible).
export const WHERE_SUBJECTS = ["property", "relation", "priority", "status"] as const;
export type WhereSubject = (typeof WHERE_SUBJECTS)[number];

export type WhereCondition = {
  subject: WhereSubject;
  // Property key or relation role. Required for property/relation; ignored for
  // priority/status (which name a fixed column).
  key?: string;
  op: WhereOp;
  // Single-value ops (eq/neq/contains/gt/lt/gte/lte) carry `value`; membership
  // ops (anyOf/allOf/noneOf) carry `values`; the rest (set/empty/checked/
  // unchecked) carry neither.
  value?: string;
  values?: string[];
  // Cast hint for a numeric property, so gt/lt compare as numbers not text.
  numeric?: boolean;
};

export type WhereGroup = {
  combinator: "and" | "or";
  conditions: WhereCondition[];
};

// --- Relative value tokens -------------------------------------------------
// A rule value is normally a literal the owner typed, which makes "today" one
// thing a view cannot say: a rotation ("show the entry whose day is the 17th")
// would need editing every morning. These two tokens stand in for a literal and
// are resolved at QUERY time, in the owner's timezone, by resolveRelativeValue:
//   "@dayofmonth" → today's date number, "17" — for a day-of-month rotation
//                   (the Baillie prayers, the attributes of God).
//   "@today"      → today's calendar day, "2026-09-17" — for a date property.
// They are ordinary strings, so a stored view definition needs no new shape and
// an older reader just sees a value that matches nothing.
export const DAY_OF_MONTH_TOKEN = "@dayofmonth";
export const TODAY_TOKEN = "@today";
export const RELATIVE_VALUE_TOKENS: readonly string[] = [DAY_OF_MONTH_TOKEN, TODAY_TOKEN];

export function isRelativeToken(value: string | undefined): boolean {
  return value != null && RELATIVE_VALUE_TOKENS.includes(value);
}

// Pure so the SQL builder, the rule builder, and a node check share one
// resolution. `today` is the reference day (from todayBounds, already in the
// owner's zone); a non-token value passes through untouched.
export function resolveRelativeValue(
  value: string | undefined,
  today: { y: number; m: number; d: number }
): string | undefined {
  if (value === DAY_OF_MONTH_TOKEN) return String(today.d);
  if (value === TODAY_TOKEN) {
    return `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
  }
  return value;
}

// Human label for a token, for the rule builder's chip.
export function relativeTokenLabel(value: string): string {
  if (value === DAY_OF_MONTH_TOKEN) return "Today's date number";
  if (value === TODAY_TOKEN) return "Today";
  return value;
}

// Ops that need no value at all.
export const NO_VALUE_OPS: readonly WhereOp[] = ["set", "empty", "checked", "unchecked"];
// Ops that take a LIST of values (membership).
export const MULTI_OPS: readonly WhereOp[] = ["anyOf", "allOf", "noneOf"];

// The operator menu offered for a subject/property-kind. Relation is passed as
// the pseudo-kind "relation"; the two built-ins as "priority" / "status".
export function opsForKind(kind: string): WhereOp[] {
  switch (kind) {
    case "text":
    case "url":
    // phone/email filter as text (ADR-192): they store the string as typed, so
    // `contains` over the raw value is the honest operator — a stored
    // "(309) 555-0142" does not match a "3095550142" search, and pretending
    // otherwise would need a normalized shadow value nothing writes.
    case "phone":
    case "email":
      return ["contains", "eq", "neq", "set", "empty"];
    case "number":
      return ["eq", "neq", "gt", "lt", "gte", "lte", "set", "empty"];
    case "date":
      return ["eq", "gt", "lt", "gte", "lte", "set", "empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    // image (ADR-255) is a picture, not searchable text: the rule builder only
    // offers "is set" / "is empty".
    case "image":
      return ["set", "empty"];
    case "select":
      return ["anyOf", "noneOf", "set", "empty"];
    case "multi_select":
      return ["anyOf", "allOf", "noneOf", "set", "empty"];
    case "relation":
      return ["anyOf", "allOf", "noneOf", "set", "empty"];
    case "priority":
      return ["anyOf", "set", "empty"];
    case "status":
      return ["anyOf"];
    default:
      return ["set", "empty"];
  }
}

// Human labels for an operator, tuned per kind where a symbol reads better as a
// word (dates say "is before", numbers say "greater than").
export function opLabel(op: WhereOp, kind?: string): string {
  if (kind === "date") {
    const m: Partial<Record<WhereOp, string>> = {
      eq: "is on",
      gt: "is after",
      lt: "is before",
      gte: "on or after",
      lte: "on or before",
    };
    if (m[op]) return m[op] as string;
  }
  if (kind === "number") {
    const m: Partial<Record<WhereOp, string>> = {
      gt: "greater than",
      lt: "less than",
      gte: "at least",
      lte: "at most",
    };
    if (m[op]) return m[op] as string;
  }
  const base: Record<WhereOp, string> = {
    set: "is set",
    empty: "is empty",
    eq: "is",
    neq: "is not",
    contains: "contains",
    gt: ">",
    lt: "<",
    gte: "≥",
    lte: "≤",
    anyOf: "is any of",
    allOf: "has all of",
    noneOf: "is none of",
    checked: "is checked",
    unchecked: "is unchecked",
  };
  return base[op];
}

// --- Validation -----------------------------------------------------------

const MAX_CONDITIONS = 25;
const MAX_VALUES = 50;

function parseCondition(raw: unknown): WhereCondition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const subject = r.subject as WhereSubject;
  if (!WHERE_SUBJECTS.includes(subject)) return null;
  const op = r.op as WhereOp;
  if (!WHERE_OPS.includes(op)) return null;

  const out: WhereCondition = { subject, op };

  if (subject === "property" || subject === "relation") {
    const key = String(r.key ?? "").trim();
    if (!key || key.length > 60) return null;
    out.key = key;
  }

  if (MULTI_OPS.includes(op)) {
    if (!Array.isArray(r.values)) return null;
    const values = r.values
      .map((v) => String(v ?? "").trim())
      .filter((v) => v.length > 0 && v.length <= 200)
      .slice(0, MAX_VALUES);
    if (!values.length) return null;
    out.values = Array.from(new Set(values));
  } else if (!NO_VALUE_OPS.includes(op)) {
    const value = r.value == null ? "" : String(r.value).trim();
    if (!value || value.length > 200) return null;
    out.value = value;
  }

  if (r.numeric === true) out.numeric = true;
  return out;
}

// Parse a stored/submitted rule group. Tolerant: an unusable condition is
// dropped, not rejected, and an empty group collapses to null so the view falls
// back to "no rules" rather than wedging.
export function parseWhere(raw: unknown): WhereGroup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const combinator = r.combinator === "or" ? "or" : "and";
  if (!Array.isArray(r.conditions)) return null;
  const conditions: WhereCondition[] = [];
  for (const entry of r.conditions) {
    const c = parseCondition(entry);
    if (c) conditions.push(c);
    if (conditions.length >= MAX_CONDITIONS) break;
  }
  return conditions.length ? { combinator, conditions } : null;
}
