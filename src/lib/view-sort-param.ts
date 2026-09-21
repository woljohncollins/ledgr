// Click-to-sort for the table layout (2026-09-20). A table header is a link
// that sets `?sort=<key>&dir=asc|desc` on the view page; the page reads it back
// here and overrides the stored view's sort for that one render. Nothing is
// written — the saved view keeps its own sort, and dropping the params restores
// it. Pure module (no DB, no React) so the page, the renderer, and any test
// share one grammar.
//
//   sort=title | plan | dueDate | scheduledDate | meetingAt | urgency |
//        updatedAt | createdAt          -> a built-in SortField
//   sort=prop:<key>                     -> items.properties->>key
//   dir=asc | desc                      -> default asc

import { SORT_FIELDS, type ListSort, type SortField, type ViewColumn } from "./views";

const PROP_PREFIX = "prop:";

export type SortDir = "asc" | "desc";

// The sort a column header would request. null = that column isn't sortable
// (type, status, url have no order worth offering).
export function sortKeyForColumn(col: ViewColumn | { source: "title" }): string | null {
  if (col.source === "title") return "title";
  if (col.source === "property") return PROP_PREFIX + col.key;
  return (SORT_FIELDS as readonly string[]).includes(col.key) ? col.key : null;
}

// The key a stored/active sort answers to, so a header can tell it is the
// active one. null for sorts no header maps to (mostLinked).
export function sortKeyOf(sort: ListSort | undefined): string | null {
  if (!sort) return null;
  if (sort.field === "mostLinked") return null;
  if (sort.field === "property") return PROP_PREFIX + sort.propertyKey;
  return sort.field;
}

// Read the URL params into a ListSort, or null when absent/invalid (the page
// then keeps the view's own sort). `numericKeys` are property keys whose kind is
// number, so a numeric column compares 10 > 9 instead of "10" < "9".
export function parseSortParam(
  sortRaw: unknown,
  dirRaw: unknown,
  numericKeys: ReadonlySet<string> = new Set()
): ListSort | null {
  if (typeof sortRaw !== "string" || !sortRaw) return null;
  const dir: SortDir = dirRaw === "desc" ? "desc" : "asc";
  if (sortRaw.startsWith(PROP_PREFIX)) {
    const key = sortRaw.slice(PROP_PREFIX.length).trim();
    if (!key || key.length > 40) return null;
    return { field: "property", propertyKey: key, numeric: numericKeys.has(key), dir };
  }
  if ((SORT_FIELDS as readonly string[]).includes(sortRaw)) {
    return { field: sortRaw as SortField, dir };
  }
  return null;
}

// The href a header link carries. Clicking the active column flips direction;
// clicking any other column sorts it ascending.
export function sortHref(
  basePath: string,
  key: string,
  active: ListSort | undefined
): string {
  const isActive = sortKeyOf(active) === key;
  const dir: SortDir = isActive && active?.dir === "asc" ? "desc" : "asc";
  const q = new URLSearchParams({ sort: key, dir });
  return `${basePath}?${q.toString()}`;
}
