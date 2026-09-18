// The Save Offline / share document render (PRD §4.7, §4.12).
//
// A self-contained HTML page: inline CSS, no scripts beyond one print button,
// no app chrome, no /_next chunks. Self-containment is the point — this exact
// response is what the service worker pins into ledgr-pin-v1 and what a public
// share link serves from the CDN, so it must render with nothing else loaded,
// and its @media print rules make the browser's print-to-PDF the PDF leg. Dark
// on screen (stage-friendly, app-consistent), black-on-white in print.
//
// The body is canonical markdown (ADR-037/ADR-040); markdownToHtml turns it
// into the body markup (mentions as tappable /items/<id> links, color HTML
// preserved, headings
// shifted under the title's <h1>). This module owns only the document shell and
// its styles.
import { accentHighlightLiteral, BLOCKNOTE_COLORS, LIGHT_TEXT_COLORS } from "@/lib/colors";
import { THEME_LABELS, THEMES, type Theme } from "@/lib/settings";
import { bodyMarkdown, isItemBody } from "@/lib/body";
import { CHART_CSS } from "@/lib/chordpro/chart-css";
import { chordProToHtml } from "@/lib/chordpro/render";
import { CHORDPRO_FORMAT } from "@/lib/chordpro/types";
import { markdownToHtml } from "@/lib/markdown-render";
import type { ResolvedMention } from "@/lib/mentions";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The self-contained document shell, shared by Save Offline's print route
// (slice 18) and public share links (slice 31). Inline CSS, no /_next chunks,
// no hydration; dark on screen (stage-friendly, app-consistent),
// black-on-white under @media print so the browser's print-to-PDF is the PDF
// leg. Because it carries its own styles it renders identically when pinned
// offline or served from a public CDN with no app context. The hl-* rules
// mirror the highlight colors the body markup carries inline.
// `color:inherit` is load-bearing, not tidying. The UA stylesheet gives <mark> its
// own `color` (black), which BEATS an inherited color from an ancestor — so
// `<span style="color:red"><mark>verse</mark></span>` rendered a black verse, and
// a highlight silently cost the text its color. Highlighting a red Scripture span
// should leave it red: a highlight owns the FILL channel and has no business
// touching the foreground. Marks compose in the markdown either way round; the CSS
// has to let them. (Found while building the slide mark, which briefly rode the
// highlight channel — see ADR-176 — but the fix stands on its own.)
const HL_CSS = Object.entries(BLOCKNOTE_COLORS)
  .map(
    ([name, c]) =>
      `mark.hl-${name}{background-color:${c.background};color:inherit}`
  )
  .join("\n");

// Body comments (ADR-170), present only when the caller opted in
// (`?comments=1`); the default render strips them, so these rules are usually
// dead weight in the document — a few hundred bytes, versus threading a second
// CSS variant through the shell. On paper there's no gutter (the document is a
// centered 46rem column), so a comment reads as a bracketed inline aside right
// after the text it annotates. The note stays INLINE deliberately: a block-level
// note inside a paragraph splits the sentence it belongs to, orphaning the rest of
// the line into what looks like a new paragraph. Paper has no hover either, so the
// note has to be legible on its own, hence the brackets. The accent is the
// palette's yellow so it stays in the same family as a yellow highlight; the
// comment is told apart by carrying an underline instead of a fill.
const CMT_CSS = `
.cmt{text-decoration:underline;text-decoration-color:${BLOCKNOTE_COLORS.yellow.text};
  text-decoration-thickness:2px;text-underline-offset:3px}
.cmt-point{display:none}
.cmt-note{font-style:italic;color:var(--muted);margin-left:.25em}
.cmt-note::before{content:"["}
.cmt-note::after{content:"]"}`;

// Slide mark (ADR-176), on the preacher's own copy. A rule bracketing each end of
// the span, deliberately NOT an underline (comments own that channel) and NOT a
// fill (highlights own that one), so a slide can sit on the same words as either
// without a fight — and so the signal is a shape, which survives on top of any of
// the palette's text colors. `text-decoration:none` kills the UA underline <ins>
// carries by default; box-decoration-break stays `slice` so a wrapped slide
// brackets the whole span rather than every line fragment.
//
// The PRESENTATION copy never sees this: booth-export.ts strips the tag and leaves
// a [SLIDE N] cue, so the sound booth gets plain prose.
const SLIDE_CSS = `
ins.slide{text-decoration:none;padding:0 .375rem;
  border-left:3px solid ${BLOCKNOTE_COLORS.blue.text};
  border-right:3px solid ${BLOCKNOTE_COLORS.blue.text};
  background:rgba(96,165,250,0.08)}`;

// The document's four looks (settings.ts THEMES), as one variable set each. The
// data-theme on <html> picks one; the Appearance control on the page switches it
// and remembers the choice in the reader's browser. Values shadow the app's
// globals.css palettes, on the document's own darker/paper-ish grounds.
const THEME_VARS: Record<Theme, string> = {
  dark: `color-scheme:dark;--bg:#0a0a0a;--fg:#e5e5e5;--muted:#a3a3a3;--faint:#737373;
  --rule:#404040;--code:#171717;--code-line:#262626;--link:#7cb3ff;--btn:#262626`,
  gray: `color-scheme:dark;--bg:#2b2b2b;--fg:#e6e6e6;--muted:#b0b0b0;--faint:#8a8a8a;
  --rule:#4a4a4a;--code:#333333;--code-line:#3e3e3e;--link:#8ec0ff;--btn:#3d3d3d`,
  light: `color-scheme:light;--bg:#ffffff;--fg:#1f1f1f;--muted:#555555;--faint:#777777;
  --rule:#cccccc;--code:#f5f5f5;--code-line:#e5e5e5;--link:#1a4d8f;--btn:#f0f0f0`,
  sepia: `color-scheme:light;--bg:#f4ecd8;--fg:#3b2f1e;--muted:#6b5a3e;--faint:#8c7b5e;
  --rule:#cdbf9f;--code:#ede3cc;--code-line:#e0d5bd;--link:#6b4c1e;--btn:#e5dac0`,
};
const THEME_CSS = THEMES.map((t) => `html${t === "dark" ? "" : `[data-theme="${t}"]`}{${THEME_VARS[t]}}`).join("\n");

// Text colors on the light looks: the body stores the bright dark-canvas hex
// inline, so a light page repaints each by attribute match (same posture as
// globals.css; `!important` because inline style beats any selector).
const LIGHT_TEXT_CSS = (Object.keys(BLOCKNOTE_COLORS) as (keyof typeof BLOCKNOTE_COLORS)[])
  .map(
    (c) =>
      `html[data-theme="light"] span[style*="color:${BLOCKNOTE_COLORS[c].text}"],html[data-theme="sepia"] span[style*="color:${BLOCKNOTE_COLORS[c].text}"]{color:${LIGHT_TEXT_COLORS[c]}!important}`
  )
  .join("\n");

const DOC_CSS = `
${THEME_CSS}
${LIGHT_TEXT_CSS}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--fg);font:17px/1.65 Georgia,'Times New Roman',serif;
  max-width:46rem;margin:0 auto;padding:3rem 1.5rem 6rem}
h1{font-size:1.9rem;line-height:1.25;margin-bottom:1.5rem}
h2,h3,h4,h5,h6{margin:1.6em 0 .5em;line-height:1.3}
h2{font-size:1.45rem}h3{font-size:1.2rem}h4{font-size:1.05rem}
p,ul,ol,blockquote,figure,table,pre{margin-bottom:.85em}
ul,ol{padding-left:1.5em}
li>ul,li>ol{margin-bottom:0}
ul.contains-task-list{list-style:none;padding-left:.2em}
ul.contains-task-list li{margin-bottom:.2em}
li.task-list-item input{margin-right:.2em}
blockquote{border-left:3px solid var(--rule);padding-left:1em;color:var(--muted)}
pre{background:var(--code);border:1px solid var(--code-line);border-radius:6px;
  padding:.75em 1em;overflow-x:auto;font-size:.85em}
code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
p code,li code{background:var(--code);border-radius:3px;padding:.1em .3em}
a{color:var(--link)}
.mention{color:var(--link);font-weight:600;text-decoration:none}
.mention .mention-icon{width:1em;height:1em;vertical-align:-0.15em;margin-right:.12em}
.mention--missing{color:var(--faint);font-weight:400}
hr{border:none;border-top:1px solid var(--rule);margin:1.5em 0}
img{max-width:100%;height:auto;border-radius:4px}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid var(--rule);padding:.35em .6em;vertical-align:top}
th{text-align:left;font-weight:600;background:var(--code)}
.doc-footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--code-line);
  font:13px system-ui,sans-serif;color:var(--faint)}
.print-bar{position:fixed;top:.75rem;right:.75rem;display:flex;gap:.5rem;align-items:center;
  font:13px system-ui,sans-serif}
.print-bar button,.print-bar select{background:var(--btn);color:var(--fg);border:1px solid var(--rule);
  border-radius:6px;padding:.4rem .9rem;font:inherit;cursor:pointer}
.print-bar label{display:flex;align-items:center;gap:.4rem;background:var(--btn);color:var(--fg);
  border:1px solid var(--rule);border-radius:6px;padding:0 0 0 .7rem}
.print-bar label select{border:0;border-left:1px solid var(--rule);border-radius:0 6px 6px 0;padding:.4rem .6rem}
${HL_CSS}
${CMT_CSS}
${SLIDE_CSS}
@page{size:letter;margin:0.5in}
@media print{
  html{color-scheme:light;--fg:#111;--muted:#444;--faint:#666;--rule:#999;--code:#f5f5f5;--code-line:#ddd;--link:#1a4d8f}
  body{background:#fff;max-width:none;padding:0;font-size:12pt}
  .cmt{text-decoration-color:#999}
  ins.slide{border-left-color:#666;border-right-color:#666;background:transparent}
  .cmt-note{border-left-color:#999;color:#444}
  a,.mention{text-decoration:none}
  th{background:transparent}
  .doc-footer{display:none}
  .print-bar{display:none}
  h2,h3,h4{page-break-after:avoid}
}
${CHART_CSS}
`;

// Renders one item to a complete HTML page. `body` is the item's stored body
// ({ format, text }); `footerHtml` (already escaped/safe markup) appends a small
// note below the document — used by share links to mark the page read-only; the
// print-to-PDF leg drops it (@media print).
export function renderPrintDocument(
  title: string,
  body: unknown,
  opts: {
    footerHtml?: string;
    mentions?: Map<string, ResolvedMention>;
    // Body comments (ADR-170) default to OFF here: this shell is the print, PDF,
    // pinned-offline, and public-share document, and a comment is a private note
    // to self. The owner opts in per render (`?comments=1`); a share link cannot
    // opt in at all yet.
    comments?: boolean;
    // The owner's accent, as a solid hex (settings.highlightColor). Present so
    // the accent highlight ("My highlight", colors.ts) survives into THIS
    // document: in the app it renders from a live `var(--accent)` reference,
    // and this page deliberately carries no app context, so the reference has
    // nothing to resolve against. Resolving it server-side to a literal rgba()
    // is what keeps the offline/PDF copy faithful (Principle 4, Sunday-proof).
    // Omitted, the mark falls back to the UA's default highlight — still
    // visibly highlighted, just not in the owner's color.
    accent?: string;
    // The look the page opens in (settings.ts THEMES). Dark when omitted. The
    // reader can switch it from the page's Appearance control, which remembers
    // the choice in their browser (localStorage) for every Ledgr document.
    theme?: Theme;
  } = {}
): string {
  const theme: Theme = opts.theme ?? "dark";
  const themeOptions = THEMES.map(
    (t) => `<option value="${t}"${t === theme ? " selected" : ""}>${THEME_LABELS[t]}</option>`
  ).join("");
  const safeTitle = escapeHtml(title || "Untitled");
  // Appended after DOC_CSS so it sits in the same cascade as the nine literal
  // hl-* rules. `color:inherit` for the same load-bearing reason they have it:
  // a highlight owns the fill channel and must not repaint colored text black.
  const accentHl = opts.accent
    ? `mark.hl-accent{background-color:${accentHighlightLiteral(opts.accent)};color:inherit}`
    : "";
  const footer = opts.footerHtml ? `<div class="doc-footer">${opts.footerHtml}</div>` : "";
  // A chordpro body renders as a chord chart whose own header carries the title,
  // key/capo/tempo/time line — so the outer <h1> is suppressed for it. Every
  // other body stays on the markdown path under the title heading, unchanged.
  const isChordpro = isItemBody(body) && body.format === CHORDPRO_FORMAT;
  const heading = isChordpro ? "" : `<h1>${safeTitle}</h1>`;
  // The mentions map (when present) makes @-mentions type-aware on the rendered
  // document; the caller resolves it owner-scoped and may omit it to render
  // plain links (a share with icons turned off).
  const bodyHtml = isChordpro
    ? chordProToHtml(bodyMarkdown(body))
    : markdownToHtml(bodyMarkdown(body), opts.mentions, {
        comments: opts.comments === true,
      });
  return `<!doctype html>
<html lang="en"${theme === "dark" ? "" : ` data-theme="${theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${DOC_CSS}${accentHl}</style>
</head>
<body>
<div class="print-bar"><label for="theme-pick">Appearance<select id="theme-pick" aria-label="Page appearance">${themeOptions}</select></label><button onclick="window.print()">Print / PDF</button></div>
${heading}
${bodyHtml}
${footer}
<script>(function(){var k="ledgr-doc-theme",h=document.documentElement,s=document.getElementById("theme-pick"),ok=${JSON.stringify(THEMES)};function set(v){if(v==="dark")delete h.dataset.theme;else h.dataset.theme=v;s.value=v}try{var v=localStorage.getItem(k);if(ok.indexOf(v)>=0)set(v)}catch(e){}s.onchange=function(){set(s.value);try{localStorage.setItem(k,s.value)}catch(e){}}})()</script>
</body>
</html>`;
}
