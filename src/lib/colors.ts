// The single color-name → export-encoding mapping table (PRD §4.1). The
// markdown serializer reads it on the way out and any future importer reads it
// on the way back in; nothing else may hard-code these names or values.
//
// The palette started as BlockNote's COLORS_DEFAULT (Notion's), but those were
// tuned for a white page: the text colors lacked contrast on Ledgr's dark
// canvas and the highlight backgrounds were ~95%-lightness pastels that all
// composited toward white on #191919. These values are retuned for the dark
// canvas (ADR: custom editor palette, 2026-07-16):
//   - text: bright, saturated hex (a true green, a cherry red), readable on dark.
//   - highlight: rgba() washes instead of near-white hex, so they read as
//     distinct colors on dark AND degrade to soft pastels over a white page —
//     one value works in both modes, so a future light mode needs no highlight
//     table. (Text colors can't do that; a light mode would need a second text
//     table.) Highlights round-trip via the hl-* class, not the value, so the
//     background may be any CSS color without breaking parse (see
//     highlightColorName below). Text colors round-trip via a value lookup
//     that accepts the exact hex AND its rgb() spelling — the browser's CSSOM
//     normalizes hex to rgb() the moment the style hits the DOM, so clipboard
//     HTML (copy/paste within the editor) arrives in rgb() form.
// The names are the stable contract; changing a value means migrating stored
// bodies (scripts/backfill-editor-colors.mts) so old inline hexes still map back.

export const BLOCKNOTE_COLORS = {
  gray: { text: "#a1a1aa", background: "rgba(148,148,148,0.40)" },
  brown: { text: "#c08552", background: "rgba(150,95,55,0.45)" },
  red: { text: "#f23a4a", background: "rgba(242,58,74,0.42)" },
  orange: { text: "#fb923c", background: "rgba(249,115,22,0.42)" },
  yellow: { text: "#facc15", background: "rgba(234,179,8,0.45)" },
  green: { text: "#4ade80", background: "rgba(34,197,94,0.42)" },
  blue: { text: "#60a5fa", background: "rgba(59,130,246,0.42)" },
  purple: { text: "#c084fc", background: "rgba(168,85,247,0.42)" },
  pink: { text: "#f472b6", background: "rgba(236,72,153,0.42)" },
} as const;

export type BlockNoteColor = keyof typeof BLOCKNOTE_COLORS;

// The same nine text colors as darker shades for a LIGHT page (light/sepia
// themes). The bright dark-canvas values above are what the body stores, so a
// light page repaints them by attribute match on the stored hex (globals.css
// carries the in-app rules; print-html.ts generates the document's from this
// table). Keep the globals.css block in step when changing a value.
export const LIGHT_TEXT_COLORS: Record<BlockNoteColor, string> = {
  gray: "#52525b",
  brown: "#8a5a2b",
  red: "#c81e2e",
  orange: "#c2410c",
  yellow: "#a16207",
  green: "#15803d",
  blue: "#1d4ed8",
  purple: "#7e22ce",
  pink: "#be185d",
};

export function isBlockNoteColor(name: unknown): name is BlockNoteColor {
  return typeof name === "string" && name in BLOCKNOTE_COLORS;
}

// The ACCENT highlight ("User Highlight", 2026-09-09): a tenth highlight whose
// color is whatever accent the owner picked in settings, so the marker pen
// matches the app. Highlight-only on purpose — it is NOT in BLOCKNOTE_COLORS,
// because that table feeds the text-color picker and both value lookups too,
// and an accent *text* color is a different (and unrequested) thing.
//
// It is the one palette value that is a LIVE REFERENCE rather than a literal:
// the body stores `var(--accent)`, not the hex it resolved to on the day it was
// typed, so re-picking an accent in settings restyles every existing accent
// highlight. That is the whole point of the feature, and it is why this can't
// just be a preset hex. The cost is that the value means nothing to a renderer
// that doesn't define --accent (Obsidian, GitHub): there the `<mark>` degrades
// to that renderer's own default highlight, still visibly highlighted, just not
// in the owner's color. Ledgr's own offline/share/PDF document does NOT pay
// that cost — print-html.ts resolves the accent server-side into a literal
// rgba() so the Sunday-proof copy is self-contained (Principle 4).
export const ACCENT_HIGHLIGHT = "accent";

// The wash. Same 0.40 alpha family as the nine literal highlights, so an accent
// highlight sits at the same weight as its neighbours, and alpha over the dark
// canvas keeps text legible whatever accent is chosen.
export const ACCENT_HIGHLIGHT_ALPHA = 0.4;
export const ACCENT_HIGHLIGHT_BG =
  `color-mix(in srgb, var(--accent) ${ACCENT_HIGHLIGHT_ALPHA * 100}%, transparent)`;

// A highlight name: one of the nine literals, or the owner's accent.
export type HighlightColor = BlockNoteColor | typeof ACCENT_HIGHLIGHT;

export function isHighlightColor(name: unknown): name is HighlightColor {
  return name === ACCENT_HIGHLIGHT || isBlockNoteColor(name);
}

// The accent highlight as a LITERAL rgba(), for a document that has no
// --accent to resolve: the offline/share/PDF shell. `accent` is the owner's
// stored solid hex (settings.highlightColor, always a solid even when a
// gradient is active — see HIGHLIGHT_GRADIENTS). Falls back to the value
// as-given if it isn't a hex we can read, so a hand-edited setting can't
// produce broken CSS.
export function accentHighlightLiteral(accent: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(accent.trim());
  if (!m) return accent;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${ACCENT_HIGHLIGHT_ALPHA})`;
}

// A GRADIENT accent as the accent highlight's background-image (globals.css
// `mark.hl-accent`, set from layout.tsx). A gradient is a CSS image, so it
// can't ride the `background-color` an ordinary highlight uses, and at full
// saturation it reads as a solid band that fights the text on top of it. So it
// gets a page-colored veil stacked over it, which is the alpha the nine literal
// highlights get from their rgba() — one layered value works for ANY gradient,
// with no rewriting of its color stops.
//
// The veil is the dark canvas (--surface-0, #191919). A future light theme
// wants a white veil instead; that is a one-line change here, not a rework,
// which is why the veil is named rather than inlined at the call site.
const HIGHLIGHT_VEIL = "rgba(25,25,25,0.55)";

export function accentHighlightImageCss(gradient: string): string {
  return `linear-gradient(${HIGHLIGHT_VEIL}, ${HIGHLIGHT_VEIL}), ${gradient}`;
}

// Text color: standard inline HTML, renders everywhere with no plugin.
export function textColorTag(color: BlockNoteColor): {
  open: string;
  close: string;
} {
  return {
    open: `<span style="color:${BLOCKNOTE_COLORS[color].text}">`,
    close: "</span>",
  };
}

// Highlight: <mark> renders highlighted in Obsidian/GitHub with no plugin;
// the hl-* class is the stable hook for a CSS theme snippet, and the inline
// style keeps the exact color even without one.
export function highlightTag(color: HighlightColor): {
  open: string;
  close: string;
} {
  const background =
    color === ACCENT_HIGHLIGHT
      ? ACCENT_HIGHLIGHT_BG
      : BLOCKNOTE_COLORS[color].background;
  return {
    open: `<mark class="hl-${color}" style="background-color:${background}">`,
    close: "</mark>",
  };
}

// Reverse lookups — the way back IN (markdown → editor). The serializer above
// owns the way out; these own the parse side so the round-trip is symmetric
// off the one table. Matching is case-insensitive and tolerant of spacing;
// the hl-* class is the primary, unambiguous hook for highlights.
//
// Each text color is keyed by both its hex (the stored markdown, read raw by
// the tokenizer) and its rgb() spelling (what CSSOM hands back once the style
// has been through the DOM — i.e. every clipboard/paste path).
const hexToRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
};
const TEXT_VALUE_TO_COLOR: Record<string, BlockNoteColor> = Object.fromEntries(
  (Object.keys(BLOCKNOTE_COLORS) as BlockNoteColor[]).flatMap((c) => {
    const hex = BLOCKNOTE_COLORS[c].text.toLowerCase();
    return [
      [hex, c],
      [hexToRgb(hex), c],
    ];
  })
) as Record<string, BlockNoteColor>;

// Highlight backgrounds are now rgba() (not hex), so match on the whole color
// value with spaces stripped, e.g. "rgba(242,58,74,0.42)". Keyed off the same
// table so it stays symmetric. The hl-* class is still the primary hook; this
// is the fallback for a highlight that reached us with its class stripped
// (some markdown processors / paste paths keep style but drop class).
const normColor = (v: string) => v.replace(/\s+/g, "").toLowerCase();
const BG_VALUE_TO_COLOR: Record<string, BlockNoteColor> = Object.fromEntries(
  (Object.keys(BLOCKNOTE_COLORS) as BlockNoteColor[]).map((c) => [
    normColor(BLOCKNOTE_COLORS[c].background),
    c,
  ])
) as Record<string, BlockNoteColor>;

// The background(-color) value out of a style string, normalized for lookup.
function bgValueInStyle(style: string): string | null {
  const m = style.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  return m ? normColor(m[1]) : null;
}

// A style string's `color:` property back to its palette name, or null if it
// isn't one of ours. Anchored to the `color` property itself (start or `;`),
// so a `background-color: rgba(...)` in the same style can't false-match.
export function textColorName(style: string): BlockNoteColor | null {
  const m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  const v = m ? normColor(m[1]) : null;
  return v && v in TEXT_VALUE_TO_COLOR ? TEXT_VALUE_TO_COLOR[v] : null;
}

// A <mark>'s class ("hl-yellow", "hl-accent") or background style back to its
// palette name. The accent highlight's fallback is a substring test rather than
// a table lookup: its value carries a var() reference, and what comes back out
// of CSSOM for `color-mix(in srgb, var(--accent) 40%, transparent)` varies by
// browser and by whether the property resolved, so the stable signal is that
// the value mentions --accent at all.
export function highlightColorName(
  className: string | null,
  style: string | null
): HighlightColor | null {
  const cls = (className ?? "").match(/\bhl-([a-z]+)\b/);
  if (cls && isHighlightColor(cls[1])) return cls[1];
  if (style) {
    const v = bgValueInStyle(style);
    if (v && v in BG_VALUE_TO_COLOR) return BG_VALUE_TO_COLOR[v];
    if (v && v.includes("--accent")) return ACCENT_HIGHLIGHT;
  }
  return null;
}
