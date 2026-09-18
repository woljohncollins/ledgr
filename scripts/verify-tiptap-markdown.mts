// Verifies the bespoke markdown contract the Tiptap editor delegates to: the
// color/highlight encode↔decode round-trip (colors.ts) and the mention link
// (mention-markdown.ts). Pure functions, no DB, no browser.
//
// What this does NOT cover: the full in-editor serialize/parse through Tiptap
// (StarterKit + Markdown + the extensions) and the @-mention popup — those are
// the in-browser check on /scratch/editor (and the real canvas). This proves
// the logic those hooks call is correct.
// Run: npx tsx scripts/verify-tiptap-markdown.mts

const {
  BLOCKNOTE_COLORS,
  ACCENT_HIGHLIGHT,
  accentHighlightImageCss,
  accentHighlightLiteral,
  textColorTag,
  highlightTag,
  textColorName,
  highlightColorName,
} = await import("../src/lib/colors");
const { mentionToMarkdown, mentionItemId, mentionTitleFromLabel } =
  await import("../src/lib/editor/mention-markdown");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const colors = Object.keys(BLOCKNOTE_COLORS) as (keyof typeof BLOCKNOTE_COLORS)[];

// --- color marks: encode → decode round-trip (both channels) ---------------
for (const c of colors) {
  const open = textColorTag(c).open; // <span style="color:#hex">
  const style = open.replace(/^<span style="/, "").replace(/">$/, "");
  check(`textColor ${c} decodes from its own style`, textColorName(style) === c, style);

  const hl = highlightTag(c).open; // <mark class="hl-c" style="background-color:#hex">
  const cls = hl.match(/class="([^"]+)"/)?.[1] ?? null;
  const hlStyle = hl.match(/style="([^"]+)"/)?.[1] ?? null;
  check(`highlight ${c} decodes from class+style`, highlightColorName(cls, hlStyle) === c);
  check(`highlight ${c} decodes from class alone`, highlightColorName(cls, null) === c);
  check(`highlight ${c} decodes from style alone`, highlightColorName(null, hlStyle) === c);
}

// --- clipboard spelling: CSSOM normalizes hex → rgb() on copy/paste --------
check("red decodes from rgb() with spaces", textColorName("color: rgb(242, 58, 74)") === "red");
check("red decodes from rgb() without spaces", textColorName("color:rgb(242,58,74)") === "red");
check("mixed-case RGB() decodes", textColorName("COLOR: RGB(242, 58, 74)") === "red");
check(
  "background-color rgba alone is no text color",
  textColorName("background-color: rgba(242,58,74,0.42)") === null
);
check(
  "bg rgba + real color both present → color wins",
  textColorName("background-color: rgba(234,179,8,0.45); color: rgb(96, 165, 250)") === "blue"
);

// --- non-matches degrade to null, never a wrong color ----------------------
check("foreign text color → null", textColorName("color:#123456") === null);
check("foreign rgb() text color → null", textColorName("color: rgb(1, 2, 3)") === null);
check("no class, no style → null", highlightColorName(null, null) === null);
check("foreign highlight bg → null", highlightColorName("hl-chartreuse", "background-color:#123456") === null);

// --- the accent highlight ("My highlight") ---------------------------------
// It is the one palette value that is a LIVE REFERENCE, so the thing to protect
// is that it stays one: baking a hex here would silently break the feature
// (existing highlights would stop following the owner's accent) while every
// round-trip check below still passed.
const accentOpen = highlightTag(ACCENT_HIGHLIGHT).open;
const accentCls = accentOpen.match(/class="([^"]+)"/)?.[1] ?? null;
const accentStyle = accentOpen.match(/style="([^"]+)"/)?.[1] ?? null;
check("accent highlight carries the hl-accent class", accentCls === "hl-accent", accentOpen);
check(
  "accent highlight stores a live var(--accent) reference, not a resolved color",
  accentStyle !== null && accentStyle.includes("var(--accent)"),
  accentStyle ?? "",
);
check("accent decodes from class+style", highlightColorName(accentCls, accentStyle) === ACCENT_HIGHLIGHT);
check("accent decodes from class alone", highlightColorName(accentCls, null) === ACCENT_HIGHLIGHT);
check(
  "accent decodes from style alone (a paste path that dropped the class)",
  highlightColorName(null, accentStyle) === ACCENT_HIGHLIGHT,
);
// Highlight-only by design: in BLOCKNOTE_COLORS it would also become a text
// color, and a text color cannot be a var() reference (textColorName matches on
// value, so it would decode as "no color" and be lost on every round-trip).
check("accent stays OUT of the nine-color table", !(ACCENT_HIGHLIGHT in BLOCKNOTE_COLORS));
check("accent is not a text color", textColorName(`color:var(--accent)`) === null);

// The literal the offline/share/PDF shell falls back to, since that document
// has no --accent to resolve (print-html.ts).
check(
  "accent resolves to an rgba wash for the offline document",
  accentHighlightLiteral("#2563eb") === "rgba(37,99,235,0.4)",
  accentHighlightLiteral("#2563eb"),
);
check("uppercase hex accent resolves too", accentHighlightLiteral("#2563EB") === "rgba(37,99,235,0.4)");
check(
  "an accent that isn't a plain hex passes through rather than emitting broken CSS",
  accentHighlightLiteral("var(--whatever)") === "var(--whatever)",
);
// A gradient accent reaches the mark through the image channel, veiled so the
// text on top stays readable (globals.css `mark.hl-accent`).
const grad = "linear-gradient(135deg, #fb923c 0%, #ec4899 100%)";
check(
  "a gradient accent is veiled and keeps its own stops",
  accentHighlightImageCss(grad).startsWith("linear-gradient(rgba(") &&
    accentHighlightImageCss(grad).endsWith(grad),
  accentHighlightImageCss(grad),
);

// --- the wiring around the accent highlight, scanned in source ------------
// These three are source scans rather than behavior tests because each one is a
// bug that TYPECHECKS, passes every other check here, and is only visible by
// looking at the running app. Two of them already shipped once.
const { readFileSync } = await import("node:fs");
const settingsForm = readFileSync("src/components/settings/SettingsForm.tsx", "utf8");
const globalsCss = readFileSync("src/app/globals.css", "utf8");
const printHtml = readFileSync("src/lib/print-html.ts", "utf8");

// SHIPPED BUG (2026-09-09): applyAccent wrote --accent and --accent-gradient
// live but not --accent-highlight-image, so changing your accent appeared to do
// nothing to existing highlights until a full page reload. For a gradient accent
// the image is the only layer you can see. The three vars are one setting.
const applyAccent = settingsForm.slice(
  settingsForm.indexOf("const applyAccent"),
  settingsForm.indexOf("const applyTextSize"),
);
for (const v of ["--accent", "--accent-gradient", "--accent-highlight-image"]) {
  check(`applyAccent writes ${v} live`, applyAccent.includes(`"${v}"`));
}

// A highlight brightens its own text, but must never repaint text that carries
// a color of its own (the booth export reads that color as "this is Scripture").
check("mark takes the bright ink", /mark\s*\{[^}]*color:\s*var\(--mark-ink\)/.test(globalsCss));
check(
  "a highlight inside a text-color span still inherits that color",
  /span\[style\*="color"\]\s+mark\s*\{[^}]*color:\s*inherit/.test(globalsCss),
);

// The print/share/offline document prints black-on-white, so bright ink there
// would come out invisible on paper. Its highlights keep color:inherit.
check(
  "the print shell's highlights do NOT take the bright ink",
  printHtml.includes("color:inherit") && !printHtml.includes("--mark-ink"),
);

// The swatch panel must stay reachable and must not cost the selection.
const editorSrc = readFileSync("src/components/markdown-editor/MarkdownEditor.tsx", "utf8");
const swatch = editorSrc.slice(
  editorSrc.indexOf("function SwatchControl"),
  editorSrc.indexOf("export type MarkdownEditorHandle") + 1 || editorSrc.length,
);
// SHIPPED BUG (2026-09-09): the panel was `absolute right-0`, so with the window
// against the right edge of the monitor the last colors opened off-screen and
// could not be clicked at all. useAnchoredPanel clamps it into the viewport.
check(
  "the swatch panel is viewport-clamped, not absolutely positioned",
  swatch.includes("useAnchoredPanel") && !swatch.includes("absolute right-0"),
);
// Every button in this control preventDefaults mousedown. Without it the editor
// blurs on click and the selection being colored is gone before the pick lands —
// which is also why this control cannot just become ui/Popover.
check(
  "the swatch trigger and swatches keep the editor's selection on mousedown",
  (swatch.match(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/g) ?? []).length >= 4,
);

// --- mention link: encode → decode -----------------------------------------
const id = "9f8c2b14-0000-4abc-8def-112233445566";
const md = mentionToMarkdown(id, "Elder Meeting");
check("mention emits the ledgr link", md === `[@Elder Meeting](ledgr://item/${id})`, md);
check("mention id extracts from its href", mentionItemId(`ledgr://item/${id}`) === id);
check("label strips the leading @", mentionTitleFromLabel("@Elder Meeting") === "Elder Meeting");

const brackety = mentionToMarkdown(id, "Plan [draft]");
check("mention escapes brackets in the title", brackety.includes("\\[draft\\]"), brackety);
check("mention id still extracts with an escaped title", mentionItemId(`ledgr://item/${id}`) === id);

// --- non-mentions are left alone -------------------------------------------
check("ordinary https link is not a mention", mentionItemId("https://example.com") === null);
check("empty/garbage href → null", mentionItemId("ledgr://item/") === null && mentionItemId(undefined) === null);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
