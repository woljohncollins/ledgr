// Task priority P1–P6 (ADR-096): replaces the old 4-level `urgency` enum. 1 is
// highest, 6 is lowest / "no special priority". One vocab so the checkbox, the
// capture-card chip, the row metadata, the Today grouping headers, the board,
// and the NL quick-add all share the same numbers, labels, and colors.
//
// Colors (Tyler, 2026-06-21): P1 red · P2 gold · P3 purple · P4 blue · P5 green ·
// P6 none (plain/neutral). Stored as a smallint 1..6 (null = unset, treated as
// P6 for display/sort-last).

// Everything the column can hold (1..6) - stored data and the style table.
export const ALL_PRIORITIES = [1, 2, 3, 4, 5, 6] as const;
export type Priority = (typeof ALL_PRIORITIES)[number];
// What the pickers OFFER (John, 2026-09-29: "only P1, P2, P3, no others" - they
// map to Outlook High / Normal / Low). Older P4-P6 values still render.
export const PRIORITIES = [1, 2, 3] as const;

export function isPriority(n: unknown): n is Priority {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 6;
}

// Coerce arbitrary input (number, "p3", "3", null) to a Priority or null.
export function toPriority(raw: unknown): Priority | null {
  if (raw == null) return null;
  if (isPriority(raw)) return raw;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^p?([1-6])$/i);
    if (m) return Number(m[1]) as Priority;
  }
  return null;
}

export type PriorityStyle = {
  n: Priority;
  label: string; // "P1"
  name: string; // color name
  // Tailwind classes (the app's palette). P6 is intentionally neutral (no accent).
  text: string;
  border: string;
  // A solid fill for the checkbox ring / dot.
  ring: string;
  dot: string;
};

// P6 = "no special priority": neutral, no color (a plain checkbox).
const STYLES: Record<Priority, PriorityStyle> = {
  1: { n: 1, label: "P1", name: "red", text: "text-red-400", border: "border-red-500", ring: "border-red-500", dot: "bg-red-500" },
  2: { n: 2, label: "P2", name: "gold", text: "text-amber-400", border: "border-amber-500", ring: "border-amber-500", dot: "bg-amber-500" },
  3: { n: 3, label: "P3", name: "purple", text: "text-purple-400", border: "border-purple-500", ring: "border-purple-500", dot: "bg-purple-500" },
  4: { n: 4, label: "P4", name: "blue", text: "text-blue-400", border: "border-blue-500", ring: "border-blue-500", dot: "bg-blue-500" },
  5: { n: 5, label: "P5", name: "green", text: "text-emerald-400", border: "border-emerald-500", ring: "border-emerald-500", dot: "bg-emerald-500" },
  6: { n: 6, label: "P6", name: "none", text: "text-neutral-400", border: "border-neutral-600", ring: "border-neutral-600", dot: "bg-neutral-600" },
};

export function priorityStyle(n: Priority): PriorityStyle {
  return STYLES[n];
}

// Display label for a (possibly null) priority. Null shows as P6's plain state.
export function priorityLabel(n: Priority | null): string {
  return n == null ? "P6" : STYLES[n].label;
}

// Sort key: lower number = higher priority = sorts first. Null/unset sorts last
// (treated as 6), matching "no special priority".
export function prioritySortKey(n: Priority | null): number {
  return n == null ? 6 : n;
}

// Migration map from the legacy 4-level urgency enum → P1–P6 (ADR-095).
// critical→P1, high→P2, normal→P4, low→P6; unknown/null→null.
export function fromLegacyUrgency(u: string | null | undefined): Priority | null {
  switch (u) {
    case "critical":
      return 1;
    case "high":
      return 2;
    case "normal":
      return 4;
    case "low":
      return 6;
    default:
      return null;
  }
}

// When a task gains its first subtask it auto-bumps to P5/green (Tyler,
// 2026-06-21) — only if it had no explicit priority yet (don't override a
// deliberate P1/P2…). Returns the priority to set, or null to leave unchanged.
export function autoPriorityOnFirstSubtask(current: Priority | null): Priority | null {
  return current == null ? 5 : null;
}
