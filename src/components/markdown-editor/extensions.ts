// Ledgr's bespoke Tiptap extensions: the two color marks and the mention
// node, each wired to emit the exact markdown the v0.17 serializer produced
// (so the M4 migration and existing exports agree on one shape). The hard
// encode/decode logic lives in pure, node-tested helpers (src/lib/colors.ts,
// src/lib/editor/mention-markdown.ts); these extensions only bind Tiptap's
// renderMarkdown / parseHTML hooks to them. Markdown is the source of truth
// (ADR-037), so every renderMarkdown here is part of the canonical contract.
"use client";

import {
  Extension,
  Mark,
  Node,
  isAtStartOfNode,
  mergeAttributes,
  type JSONContent,
} from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { NodeRange } from "@tiptap/pm/model";
import { liftTarget } from "@tiptap/pm/transform";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import {
  BLOCKNOTE_COLORS,
  ACCENT_HIGHLIGHT,
  ACCENT_HIGHLIGHT_BG,
  highlightColorName,
  highlightTag,
  isHighlightColor,
  isBlockNoteColor,
  textColorName,
  textColorTag,
} from "@/lib/colors";
import {
  MENTION_URI_PREFIX,
  mentionToMarkdown,
} from "@/lib/editor/mention-markdown";
import {
  imageAttrsFromToken,
  imageToMarkdown,
  type ImageToken,
} from "@/lib/editor/image-markdown";
import {
  hydrateEmptyListItems,
  spaceEmptyListItems,
  stripSentinelText,
} from "@/lib/editor/list-markdown";
import {
  formatPassageRef,
  parsePassageSlug,
  passageSlug,
  passageToMarkdown,
} from "@/lib/passages/ref";
import { tableToGfm } from "@/lib/editor/table-markdown";
import { createMentionNodeView } from "./mention-node-view";

// Text color → <span style="color:#hex"> (markdown) / styled span (editor DOM).
export const TextColor = Mark.create({
  name: "textColor",

  // Render OUTSIDE the underline/strike marks (StarterKit default priority 100)
  // so those decoration-bearing elements sit inside the colored span and inherit
  // its `color` as currentColor — otherwise the underline paints in the default
  // text color, not the text's own color. Below Link (1000) so links still wrap.
  priority: 120,

  addAttributes() {
    return {
      // The palette name (e.g. "red"); the hex is derived so the single
      // table in colors.ts stays authoritative. Not emitted as its own
      // attribute — the style carries it.
      color: { default: null, renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[style]",
        getAttrs: (el) => {
          const name = textColorName(
            (el as HTMLElement).getAttribute("style") || ""
          );
          return name ? { color: name } : false;
        },
      },
    ];
  },

  renderHTML({ mark }) {
    const color = mark.attrs.color;
    const style = isBlockNoteColor(color)
      ? `color:${BLOCKNOTE_COLORS[color].text}`
      : undefined;
    return ["span", style ? mergeAttributes({ style }) : {}, 0];
  },

  renderMarkdown(node, helpers) {
    const content = helpers.renderChildren(node);
    const color = node.attrs?.color;
    if (!isBlockNoteColor(color)) return content;
    const tag = textColorTag(color);
    return `${tag.open}${content}${tag.close}`;
  },

  // Reclaim <span style="color:…">…</span> at the INLINE level, before marked's
  // generic inline-HTML handling can claim it. That default path (see
  // @tiptap/markdown parseInlineTokens) merges the opening tag with the RAW text
  // of every following token up to </span> and re-parses the blob as literal
  // HTML — which flattens any **bold**/*italic*/~~strike~~ inside the span to
  // literal text (the "formatting drops inside colored text on a source⇄rich
  // flip" bug). Instead we capture the inner markdown and re-tokenize it, then
  // apply the color mark over the parsed result, so nested formatting survives
  // the round-trip. Same reclaim-before-Link shape as the mention/passage nodes.
  // parseHTML above still covers the HTML paste/clipboard path.
  markdownTokenizer: {
    name: "textColor",
    level: "inline",
    start: (src: string) => {
      const i = src.indexOf("<span");
      return i < 0 ? src.length : i;
    },
    tokenize: (src: string) => {
      const m = /^<span\b([^>]*)>([\s\S]*?)<\/span>/i.exec(src);
      if (!m) return undefined;
      const styleM = /style\s*=\s*"([^"]*)"/i.exec(m[1]);
      const color = styleM ? textColorName(styleM[1]) : null;
      // Only a recognized palette color is ours; anything else (e.g. a mention's
      // fallback span) falls through to the default handling untouched.
      if (!color) return undefined;
      return { type: "textColor", raw: m[0], color, inner: m[2] };
    },
  },

  parseMarkdown(token, helpers) {
    // tokenizeInline is always present at runtime; the type marks it optional.
    const inner = helpers.parseInline(helpers.tokenizeInline?.(token.inner) ?? []);
    return helpers.applyMark("textColor", inner, { color: token.color });
  },
});

// Highlight → <mark class="hl-name" style="background-color:#hex">. The class
// is the primary parse hook (unambiguous); the style keeps the exact color.
export const Highlight = Mark.create({
  name: "highlight",

  addAttributes() {
    return {
      color: { default: null, renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: "mark",
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const name = highlightColorName(
            node.getAttribute("class"),
            node.getAttribute("style")
          );
          return name ? { color: name } : {};
        },
      },
    ];
  },

  renderHTML({ mark }) {
    const color = mark.attrs.color;
    if (!isHighlightColor(color)) return ["mark", {}, 0];
    // The accent highlight keeps the owner's live --accent reference rather than
    // a literal, so re-picking an accent in settings restyles it (colors.ts).
    const background =
      color === ACCENT_HIGHLIGHT
        ? ACCENT_HIGHLIGHT_BG
        : BLOCKNOTE_COLORS[color].background;
    return [
      "mark",
      mergeAttributes({
        class: `hl-${color}`,
        style: `background-color:${background}`,
      }),
      0,
    ];
  },

  renderMarkdown(node, helpers) {
    const content = helpers.renderChildren(node);
    const color = node.attrs?.color;
    if (!isHighlightColor(color)) return `<mark>${content}</mark>`;
    const tag = highlightTag(color);
    return `${tag.open}${content}${tag.close}`;
  },

  // Reclaim <mark …>…</mark> at the inline level, same reason as TextColor above:
  // keep the default inline-HTML merge from flattening formatting inside the mark.
  // A <mark> with no recognized color is still ours (renderMarkdown emits a bare
  // <mark>), so we claim it too and parse with a null color.
  markdownTokenizer: {
    name: "highlight",
    level: "inline",
    start: (src: string) => {
      const i = src.indexOf("<mark");
      return i < 0 ? src.length : i;
    },
    tokenize: (src: string) => {
      const m = /^<mark\b([^>]*)>([\s\S]*?)<\/mark>/i.exec(src);
      if (!m) return undefined;
      const clsM = /class\s*=\s*"([^"]*)"/i.exec(m[1]);
      const styleM = /style\s*=\s*"([^"]*)"/i.exec(m[1]);
      const color = highlightColorName(
        clsM ? clsM[1] : null,
        styleM ? styleM[1] : null
      );
      return { type: "highlight", raw: m[0], color, inner: m[2] };
    },
  },

  parseMarkdown(token, helpers) {
    // tokenizeInline is always present at runtime; the type marks it optional.
    const inner = helpers.parseInline(helpers.tokenizeInline?.(token.inner) ?? []);
    return helpers.applyMark(
      "highlight",
      inner,
      token.color ? { color: token.color } : undefined
    );
  },
});

// Slide mark (ADR-176) → <ins class="slide">…</ins>. "Put this span on the screen":
// the marker the presentation export reads (src/lib/editor/booth-export.ts).
//
// WHY `<ins>` AND NOT A span OR A mark — three constraints, one tag that satisfies
// all of them. Don't "simplify" this to a span.
//   1. A slide almost always wraps colored text (a red Scripture span), and
//      `<span class="slide"><span style="color:…">…</span></span>` is same-tag
//      nesting: the non-greedy regex the export and the tokenizer both use would
//      close on the INNER </span> and capture a broken fragment.
//   2. `<mark class="slide">` would be claimed by the Highlight mark above, whose
//      tokenizer takes any <mark> and parses an unrecognized class as a bare
//      highlight. Guarding that means surgery on a shared extension.
//   3. `<ins>` is claimed by nothing here (CriticMarkup's {++ins++} is deliberately
//      NOT implemented, see comment-markdown.ts), and it degrades legibly as
//      underlined text in any other markdown reader.
//
// It carries NO attributes: unlike the two marks above it has exactly one state,
// so there is no color to round-trip. The visual (a blue rule bracketing each end
// of the span, NOT an underline and NOT a fill) is pure CSS — see the .slide block
// in markdown-editor.css and print-html.ts. That choice is load-bearing: comments
// own the underline channel and highlights own the fill channel, so a slide has to
// live in a third channel or it fights one of them on the same words.
export const SlideMark = Mark.create({
  name: "slide",

  parseHTML() {
    return [{ tag: "ins.slide" }];
  },

  renderHTML() {
    return ["ins", mergeAttributes({ class: "slide" }), 0];
  },

  renderMarkdown(node, helpers) {
    return `<ins class="slide">${helpers.renderChildren(node)}</ins>`;
  },

  // Reclaim <ins class="slide">…</ins> at the inline level, same reason as the two
  // marks above: the default inline-HTML path merges the opening tag with the raw
  // text up to the closing one and re-parses the blob as literal HTML, which
  // flattens the **bold** and the color span inside a slide to literal text.
  markdownTokenizer: {
    name: "slide",
    level: "inline",
    start: (src: string) => {
      const i = src.indexOf("<ins");
      return i < 0 ? src.length : i;
    },
    tokenize: (src: string) => {
      const m = /^<ins\b[^>]*\bclass\s*=\s*"[^"]*\bslide\b[^"]*"[^>]*>([\s\S]*?)<\/ins>/i.exec(
        src
      );
      if (!m) return undefined;
      return { type: "slide", raw: m[0], inner: m[1] };
    },
  },

  parseMarkdown(token, helpers) {
    // tokenizeInline is always present at runtime; the type marks it optional.
    const inner = helpers.parseInline(helpers.tokenizeInline?.(token.inner) ?? []);
    return helpers.applyMark("slide", inner);
  },
});

// @tiptap/markdown 3.26 backslash-escapes markdown-significant characters
// (* _ [ ] ` ~ \) in every non-code text node on serialize, so a literal `*`
// in text can't be misread as an emphasis delimiter when the output is parsed
// again AS MARKDOWN. But the two marks above emit their content inside raw
// inline HTML (<span style="color:…">…</span>, <mark>…</mark>), and the parse
// side reads HTML content back as LITERAL text — it never decodes the escapes.
// So every rich⇄source round-trip re-escaped the escapes of colored/highlighted
// text (** → \*\* → \\\*\\\* → …), corrupting it without bound and dropping the
// bold. Fix: for a text node carrying one of those marks, undo the markdown
// escaping the serializer just added (HTML-entity encoding is left intact),
// restoring the raw-content shape the export/render pipeline has always
// expected. Patches the one manager method the library exposes no hook for;
// added to the editor's extension list alongside the marks it protects.
// "slide" belongs here for exactly the reason above: it emits its content inside
// raw inline HTML too, so without it every rich⇄source flip re-escapes the escapes
// inside a slide (** → \*\* → \\\*\\\* …) and eventually eats the bold.
const HTML_WRAPPED_MARKS = new Set(["textColor", "highlight", "slide"]);
export const MarkdownEscapeFix = Extension.create({
  name: "markdownEscapeFix",
  // onBeforeCreate (not onCreate): the Markdown extension sets `editor.markdown`
  // in its own onBeforeCreate, and all onBeforeCreate hooks run — in registration
  // order, so this must sit AFTER Markdown in the extension list — before any
  // onCreate. Patching here means the wrapper is in place the moment the manager
  // exists, with no dependency on the (deferred) onCreate tick.
  onBeforeCreate() {
    const mgr = (this.editor as unknown as { markdown?: Record<string, unknown> }).markdown;
    const orig = mgr?.encodeTextForMarkdown;
    if (!mgr || typeof orig !== "function") return;
    const bound = (orig as (...a: unknown[]) => string).bind(mgr);
    mgr.encodeTextForMarkdown = (text: string, node: { marks?: unknown[] }, parentNode: unknown) => {
      const encoded = bound(text, node, parentNode);
      const marks = node?.marks ?? [];
      const inHtmlMark = marks.some((m) =>
        HTML_WRAPPED_MARKS.has(typeof m === "string" ? m : (m as { type?: string })?.type ?? "")
      );
      return inHtmlMark ? encoded.replace(/\\([\\`*_[\]~])/g, "$1") : encoded;
    };
  },
});

// Empty list items round-trip safely (Brandon, 2026-08-01). See list-markdown.ts
// for the setext trap this closes; both ends of the manager are patched because
// both ends need it:
//  - parse:     an empty bullet loads as a bullet (marked needs the sentinel to
//               see one at all), so a body stored before this fix heals on open
//               instead of showing a giant fake heading.
//  - serialize: what we store (and export, and print) is never ambiguous again.
// Same onBeforeCreate discipline as MarkdownEscapeFix above — register after
// Markdown. getMarkdown()/setContent/insertContent all route through these two
// methods, so patching here covers every caller.
export const EmptyListItemFix = Extension.create({
  name: "emptyListItemFix",
  onBeforeCreate() {
    const mgr = (this.editor as unknown as { markdown?: Record<string, unknown> }).markdown;
    if (!mgr) return;
    const parse = mgr.parse;
    if (typeof parse === "function") {
      const bound = (parse as (md: string) => unknown).bind(mgr);
      mgr.parse = (markdown: string) =>
        typeof markdown === "string"
          ? stripSentinelText(bound(hydrateEmptyListItems(markdown)))
          : bound(markdown);
    }
    const serialize = mgr.serialize;
    if (typeof serialize === "function") {
      const bound = (serialize as (doc: unknown) => string).bind(mgr);
      mgr.serialize = (doc: unknown) => spaceEmptyListItems(bound(doc));
    }
  },
});

// Footnote markers survive the rich editor (Tyler, 2026-09-16). Footnotes
// (`[^id]` markers plus their `[^id]: text` definitions) are deliberately NOT in
// the shared body dialect — they are hand-parsed by the Papers module and its
// .docx renderer (CLAUDE.md; src/lib/papers/msm-docx.ts) and render as literal
// text everywhere else. "Literal text" was fine while the Draft tab was a raw
// textarea, but the moment the Draft moved onto the shared Tiptap surface the
// markers stopped surviving a save: @tiptap/markdown backslash-escapes
// markdown-significant characters in every text node on serialize, so
// `[^1]` came back as `\[^1\]` and `[^1]: John Calvin…` as `\[^1\]: …`.
// msm-docx's `/^\[\^([^\]]+)\]:/` definition matcher then finds nothing, every
// marker is dropped as "a marker with no definition" (allocRuns), and the paper
// exports with its citations silently gone — the module's actual deliverable.
//
// This is the same class of bug as MarkdownEscapeFix above and takes the same
// shape: the serializer is right to escape text it emits AS markdown, but these
// markers are read back literally by a hand-written parser, so the escapes are
// pure corruption. Patching `serialize` (not encodeTextForMarkdown) because a
// footnote marker carries no mark to key off — it is bare text, so the fix has
// to be a pass over the finished document.
//
// OPT-IN, not global: only a host that actually speaks footnotes should get it
// (the Papers Draft), because un-escaping `\[^…\]` in an ordinary note would
// rewrite text the owner typed literally. MarkdownEditor adds it only when
// `preserveFootnotes` is set.
const ESCAPED_FOOTNOTE_RE = /\\\[\^([^\]\\]+)\\\]/g;

export function unescapeFootnotes(markdown: string): string {
  return markdown.replace(ESCAPED_FOOTNOTE_RE, "[^$1]");
}

export const FootnoteMarkdownFix = Extension.create({
  name: "footnoteMarkdownFix",
  // Same onBeforeCreate discipline as the two fixes above: register AFTER
  // Markdown so the manager exists to patch.
  onBeforeCreate() {
    const mgr = (this.editor as unknown as { markdown?: Record<string, unknown> }).markdown;
    if (!mgr) return;
    const serialize = mgr.serialize;
    if (typeof serialize !== "function") return;
    const bound = (serialize as (doc: unknown) => string).bind(mgr);
    mgr.serialize = (doc: unknown) => unescapeFootnotes(bound(doc));
  },
});

// Inline HTML dialect elements (<span style=color>, <mark>, <ins class="slide">)
// survive inside an ORDERED list item exactly as they do inside a bullet (Brandon,
// 2026-08-13 — confirmed from a sermon note corrupted twice: a colored span nested
// under an ordered sub-list came back as literal `&lt;span style="color:…"&gt;` text
// after a save round-trip; the identical span one line down, under an unordered
// sub-list, was untouched).
//
// Root cause lives in @tiptap/extension-list's OrderedList.parseMarkdown
// (parseListItems, ordered-list/utils.ts — can't patch it, it's in node_modules).
// A tight list item's content arrives from marked as a "text" token carrying BOTH
// a flattened raw string (`.text`, HTML and all, un-parsed) and the properly
// inline-tokenized breakdown (`.tokens` — the same span split into html-open/
// text/html-close, or, once the color/highlight/slide extensions below claim it,
// a dedicated textColor/highlight/slide token). BulletList's item handling
// (ListItem.parseMarkdown, shared by every non-ordered list) reads `.tokens` via
// `helpers.parseInline(firstToken.tokens)` — correct. OrderedList's own
// `parseListItems` instead calls `helpers.parseChildren([itemToken])`, which
// dispatches by token TYPE through the generic per-tokenName registry and lands on
// @tiptap/extension-text's built-in Text.parseMarkdown — which ignores `.tokens`
// and returns `.text` verbatim. The doc ends up with a literal `<span…>` substring
// inside a plain text node, which the markdown serializer then HTML-entity-escapes
// on save like any other literal `<` in plain text — the `&lt;span` corruption.
//
// Fix: register our OWN parseMarkdown for the SAME "text" markdownTokenName, at a
// priority above the built-in Text node's (100) so MarkdownManager.parseToken's
// per-tokenName handler list (populated in extension REGISTRATION order, tried
// first-to-last) tries ours first. When the token carries `.tokens` (marked always
// populates it for a tight list item, empty only for the rare token with none),
// inline-parse those — reclaiming any dialect mark exactly the way a bullet item
// would — instead of the flattened string. A token with no `.tokens` returns `[]`,
// which MarkdownManager treats as "no match" and falls through to the built-in
// Text handler unchanged, so plain text is untouched. Not special-cased to spans:
// this fixes the shared dispatch bug, so every HTML-wrapped mark (and any future
// one) survives an ordered list the same way it survives a bullet.
export const OrderedListTextFix = Extension.create({
  name: "orderedListTextFix",
  priority: 200,
  markdownTokenName: "text",
  parseMarkdown(token, helpers) {
    const tokens = (token as { tokens?: unknown[] }).tokens;
    if (!tokens || tokens.length === 0) return [];
    return helpers.parseInline(tokens as Parameters<typeof helpers.parseInline>[0]);
  },
});

// Backspace at the start of a bullet DELETES the line break, it does not outdent
// (Brandon, 2026-08-01).
//
// Tiptap's ListKeymap binds Backspace-at-start-of-item to liftListItem: the
// bullet un-nests a level, then un-nests again, then finally merges — so
// removing one line out of a list takes three presses, and every press drags
// that line's sub-bullets a level left with it. Deleting a line is the common
// edit when you're reshaping an outline, and it shouldn't reorganize the outline
// to do it.
//
// So at the start of a list item, Backspace joins backward — the plain
// text-editor behavior: the line merges into the line above, and the line's own
// sub-bullets come up into the gap it left. Outdenting keeps its own gestures
// (Shift+Tab and the toolbar's outdent button), which is where it belongs.
//
// TWO commands, one keypress (so one undo step, and the intermediate state is
// never painted):
//  1. Promote this item's sub-bullets one level, but ONLY when it is the FIRST
//     item of its list. That is exactly the case where the line above lives
//     outside this list — the parent's line, or the paragraph before the list —
//     so joining leaves a gap the children have to move into. Without it the
//     item's shell stays behind as an empty bullet holding children that are now
//     a level too deep (Brandon, 2026-08-01: "if the line is empty it should go
//     away and drag the sub bullets over"). With a preceding sibling there is no
//     gap, so nothing is promoted and the children keep the depth they had.
//  2. joinTextblockBackward, not joinBackward: the plain join pulls the item up
//     as a SECOND PARAGRAPH inside the bullet above (still two lines, one
//     marker) and needs another press to merge the text. This one merges the
//     line into the line above in a single press, which is what "delete the line
//     break" means.
//
// Deliberately narrow, so everything else keeps working: with a selection we
// return false (Backspace deletes the highlighted bullets, the normal path), and
// undoInputRule still runs first so backspacing right after "- " undoes the
// bullet you just typed. Priority beats ListKeymap's (100) so this handler wins.
const LIST_ITEM_NAMES = new Set(["listItem", "taskItem"]);
const LIST_NAMES = new Set(["bulletList", "orderedList", "taskList"]);
export const ListBackspaceJoin = Extension.create({
  name: "listBackspaceJoin",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        if (!editor.state.selection.empty) return false;
        if (!editor.isActive("listItem") && !editor.isActive("taskItem")) return false;
        if (!isAtStartOfNode(editor.state)) return false;
        if (editor.commands.undoInputRule()) return true;
        const { $from } = editor.state.selection;
        // The enclosing list item.
        let depth = $from.depth;
        while (depth > 0 && !LIST_ITEM_NAMES.has($from.node(depth).type.name)) depth -= 1;
        const item = depth > 0 ? $from.node(depth) : null;
        const sub = item?.lastChild;
        const chain = editor.chain();
        // First item of its list, and it has sub-bullets: promote them a level so
        // they land as this item's siblings, which is where they belong once this
        // line is gone. (Lifting the ITEM instead would work when the list is
        // nested, but at the top level that un-lists it and flattens the lot.)
        if (item && sub && LIST_NAMES.has(sub.type.name) && $from.index(depth - 1) === 0) {
          const subEnd = $from.after(depth) - 1;
          const subStart = subEnd - sub.nodeSize;
          chain.command(({ tr, dispatch }) => {
            const range = new NodeRange(
              tr.doc.resolve(subStart + 1),
              tr.doc.resolve(subEnd - 1),
              tr.doc.resolve(subStart + 1).depth
            );
            const target = liftTarget(range);
            // No legal home for them: leave the sub-list alone and just join.
            if (target !== null && dispatch) tr.lift(range, target);
            return true;
          });
        }
        return chain.joinTextblockBackward().run();
      },
    };
  },
});

// The mention node. Reuses @tiptap/extension-mention (id/label attrs + the
// "@" suggestion machinery) and binds the markdown contract on top:
//  - out: renderMarkdown → [@Title](ledgr://item/<uuid>)
//  - in:  a custom inline tokenizer reclaims that exact link as a mention
//         token before the Link mark can claim it, so the round-trip holds.
// The suggestion items are supplied where the editor is created.
export const LedgrMention = Mention.extend({
  // A non-serialized `type` attr (the target's type key) on top of Mention's
  // id/label. The suggestion sets it on insert so the chip is glyphed instantly;
  // it never reaches the markdown (renderMarkdown below emits only id + label),
  // so the canonical body contract is untouched.
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      type: { default: null, rendered: false },
    };
  },

  // Per-editor store the mention chips (the NodeView) read for live type/icon/
  // status. MarkdownEditor fills `resolved` via a batch resolve and calls every
  // `rerender` callback; `ready` gates the "missing" state until the first load.
  addStorage() {
    return {
      ...(this.parent?.() ?? {}),
      resolved: new Map(),
      rerender: new Set<() => void>(),
      ready: false,
    };
  },

  // The chip is a NodeView (mention-node-view.ts): live glyph, click-to-open,
  // and an interactive task checkbox — none of which a static renderHTML can do.
  addNodeView() {
    return (props) => createMentionNodeView(props);
  },

  // Static fallback for getHTML()/clipboard (the NodeView owns the live editor
  // DOM). Carries the id + the type class so a copied chip keeps its hook.
  renderHTML({ node }) {
    const type = typeof node.attrs.type === "string" ? node.attrs.type : null;
    return [
      "span",
      mergeAttributes({
        class: "ledgr-mention" + (type ? ` mention--${type}` : ""),
        "data-item-id": node.attrs.id ?? "",
        ...(type ? { "data-item-type": type } : {}),
      }),
      `@${node.attrs.label || "untitled"}`,
    ];
  },

  renderText({ node }) {
    return `@${node.attrs.label || "untitled"}`;
  },

  renderMarkdown(node) {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    const label =
      typeof node.attrs?.label === "string" && node.attrs.label
        ? node.attrs.label
        : "untitled";
    return mentionToMarkdown(id, label);
  },

  // Reclaim [@Title](ledgr://item/<id>) at the inline level. start() points
  // marked at the next candidate so the tokenizer isn't asked to run on every
  // character; tokenize() only matches our exact mention-link shape.
  markdownTokenizer: {
    name: "mention",
    level: "inline",
    start: (src: string) => {
      const i = src.indexOf("[@");
      return i < 0 ? src.length : i;
    },
    tokenize: (src: string) => {
      const m = /^\[@((?:\\.|[^\]\\])+)\]\(ledgr:\/\/item\/([^)\s]+)\)/.exec(
        src
      );
      if (!m) return undefined;
      const label = m[1].replace(/\\([\\[\]])/g, "$1");
      return {
        type: "mention",
        raw: m[0],
        // carried through to parseMarkdown below
        mentionLabel: label,
        mentionId: m[2],
      };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("mention", {
      id: token.mentionId,
      label: token.mentionLabel,
    });
  },
});

// The passage node (ADR-149). A static inline atom — the passage sibling of
// LedgrMention, but with NO NodeView: a passage is fixed reference data (no live
// status, no checkbox), so a static chip is right. The markdown contract mirrors
// the mention exactly:
//  - out: renderMarkdown → [Label](ledgr://passage/<start>[-<end>])
//  - in:  a custom inline tokenizer reclaims that exact link BEFORE the Link mark
//         can claim it, so the round-trip holds (same as the mention tokenizer).
// The href points at the virtual passage page (/passage/<slug>); the ledgr://
// URI lives only in the markdown so syncPassageRefs can find the edge.
export const LedgrPassage = Node.create({
  name: "passage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      startRef: { default: null },
      endRef: { default: null },
      // The human display label ("Romans 8:5–9"); regenerated from the refs when
      // absent so a hand-authored link with no label still chips correctly.
      label: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "a[data-passage-start]",
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const start = Number(node.getAttribute("data-passage-start"));
          if (!Number.isSafeInteger(start)) return false;
          const endAttr = node.getAttribute("data-passage-end");
          const end = endAttr != null && endAttr !== "" ? Number(endAttr) : start;
          return { startRef: start, endRef: end, label: node.textContent || null };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { start, end, label } = passageAttrs(node);
    return [
      "a",
      mergeAttributes({
        class: "ledgr-passage",
        href: `/passage/${passageSlug(start, end)}`,
        "data-passage-start": String(start),
        "data-passage-end": String(end),
      }),
      label,
    ];
  },

  renderText({ node }) {
    return passageAttrs(node).label;
  },

  renderMarkdown(node) {
    // Cast like LedgrImage/LedgrMention: @tiptap/markdown's augmented hook types
    // the node loosely, but it always carries attrs at runtime.
    const { start, end, label } = passageAttrs(node as { attrs?: Record<string, unknown> });
    return passageToMarkdown(start, end, label);
  },

  // Reclaim [Label](ledgr://passage/<slug>) at the inline level, before Link.
  // Passage labels carry no "@" sentinel, so start() locates the href marker and
  // backs up to the opening "[" (labels are canon refs, never contain "]").
  markdownTokenizer: {
    name: "passage",
    level: "inline",
    start: (src: string) => {
      const i = src.indexOf("](ledgr://passage/");
      if (i < 0) return src.length;
      const open = src.lastIndexOf("[", i);
      return open < 0 ? src.length : open;
    },
    tokenize: (src: string) => {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(ledgr:\/\/passage\/(\d+(?:-\d+)?)\)/.exec(src);
      if (!m) return undefined;
      const ref = parsePassageSlug(m[2]);
      if (!ref) return undefined;
      const label = m[1].replace(/\\([\\[\]])/g, "$1");
      return {
        type: "passage",
        raw: m[0],
        passageStart: ref.startRef,
        passageEnd: ref.endRef,
        passageLabel: label,
      };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("passage", {
      startRef: token.passageStart,
      endRef: token.passageEnd,
      label: token.passageLabel,
    });
  },
});

// Coerce a passage node's attrs to numbers + a display label, deriving the label
// from the refs when it's missing. Shared by every render hook above.
function passageAttrs(node: { attrs?: Record<string, unknown> }): {
  start: number;
  end: number;
  label: string;
} {
  const a = node.attrs ?? {};
  const start = Number(a.startRef);
  const end = a.endRef != null ? Number(a.endRef) : start;
  const label =
    typeof a.label === "string" && a.label ? a.label : formatPassageRef(start, end);
  return { start, end, label };
}

// Inline image node. inline:true is required, not cosmetic: marked emits a
// `![]()` as an inline token inside a paragraph, and @tiptap/markdown dispatches
// that token to this node's parseMarkdown — a block image would violate the
// paragraph's content schema. The markdown shape (![alt](src)) lives in the
// pure helper; the bytes are uploaded to R2 by the editor's paste/drop handler.
// Params are untyped so @tiptap/markdown's augmented hook signatures infer
// them (the color/mention extensions above do the same); we cast to the precise
// shapes inside, where the structure is known.
export const LedgrImage = Image.extend({
  inline: true,
  group: "inline",

  renderMarkdown(node) {
    const a = (node as { attrs?: Record<string, unknown> }).attrs ?? {};
    return imageToMarkdown({
      src: typeof a.src === "string" ? a.src : "",
      alt: typeof a.alt === "string" ? a.alt : "",
      title: typeof a.title === "string" ? a.title : null,
    });
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("image", imageAttrsFromToken(token as ImageToken));
  },
});

// The table node carries the whole-table markdown contract; the row/header/cell
// nodes are registered as-is (re-exported below) and walked by these hooks.
// On serialize the node arrives as Tiptap JSON (content is a JSONContent[]); on
// parse, marked hands one table block token (header[] + rows[][], each cell
// holding inline tokens), so parseMarkdown rebuilds the subtree and
// renderMarkdown flattens it to GFM via the pure assembler. The server renderer
// (markdown-it) already renders GFM tables, so print/share/export are covered.
type MarkedTableCell = { tokens?: unknown[]; text?: string };
type MarkedTableToken = { header: MarkedTableCell[]; rows: MarkedTableCell[][] };
type JsonNode = { content?: JsonNode[] };

export const LedgrTable = Table.extend({
  renderMarkdown(node, helpers) {
    const rows: string[][] = [];
    for (const rowNode of (node as JsonNode).content ?? []) {
      const cells: string[] = [];
      for (const cellNode of rowNode.content ?? []) {
        cells.push(helpers.renderChildren(cellNode));
      }
      rows.push(cells);
    }
    return tableToGfm(rows);
  },

  parseMarkdown(token, helpers) {
    const t = token as unknown as MarkedTableToken;
    const cellContent = (cell: MarkedTableCell): JSONContent[] => {
      if (cell.tokens && cell.tokens.length) {
        return helpers.parseInline(
          cell.tokens as Parameters<typeof helpers.parseInline>[0]
        ) as JSONContent[];
      }
      if (cell.text) return [helpers.createTextNode(cell.text) as JSONContent];
      return [];
    };
    const makeCell = (cell: MarkedTableCell, header: boolean) =>
      helpers.createNode(header ? "tableHeader" : "tableCell", null, [
        helpers.createNode("paragraph", null, cellContent(cell)),
      ]);
    const headerRow = helpers.createNode(
      "tableRow",
      null,
      t.header.map((c) => makeCell(c, true))
    );
    const bodyRows = t.rows.map((r) =>
      helpers.createNode(
        "tableRow",
        null,
        r.map((c) => makeCell(c, false))
      )
    );
    return helpers.createNode("table", null, [headerRow, ...bodyRows]);
  },
});

export { TableRow, TableHeader, TableCell };

// The "ledgr://item/" prefix is the load-bearing piece of the round-trip;
// re-exported so the editor and any consumer reference one constant.
export const MENTION_PREFIX = MENTION_URI_PREFIX;
