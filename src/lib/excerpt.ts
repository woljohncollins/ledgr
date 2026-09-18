// First-line excerpt for a task row's description line (tasks-row-redesign,
// ADR-202). Takes the capped raw markdown head the list query ships (see
// task-row-meta.ts for the read and the body-in-lists carve-out) and reduces it
// to ONE plain-text line: the first non-empty line, markdown syntax stripped so
// the row shows words, not markup. PURE + client-safe (no DB, no imports), so a
// verify script can pin its behavior.
//
// Stripping is deliberately light — this is a glance line, not a renderer. Link
// labels survive, URLs in plain text survive (a pasted URL IS the description
// for many captured tasks), and anything that still looks like markup after
// these passes just shows as-is.

// A line that is only an image or a horizontal rule carries nothing readable;
// skip it and try the next line.
const SKIP_LINE = /^(\s*!\[[^\]]*\]\([^)]*\)\s*|\s*(-{3,}|\*{3,}|_{3,})\s*)$/;

export function excerptLine(raw: string | null | undefined): string {
  if (!raw) return "";
  for (const line of raw.split("\n")) {
    if (SKIP_LINE.test(line)) continue;
    const text = line
      // CriticMarkup notes-to-self are not description text; anchored text is.
      .replace(/\{>>.*?<<\}/g, "")
      .replace(/\{==(.*?)==\}/g, "$1")
      // Inline HTML from the dialect (<mark>, <span>, <ins>, <details>…).
      .replace(/<[^>]+>/g, "")
      // Links (including ledgr:// mention chips): keep the label.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Leading block syntax: headings, quotes, list markers, task boxes.
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "")
      // Emphasis/underline/code marks.
      .replace(/(\*\*|__|\+\+|==|~~|`)/g, "")
      .trim();
    if (text) return text;
  }
  return "";
}
