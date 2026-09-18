// Server-side markdown rendering (M3, ADR-040). Markdown is the canonical body
// (ADR-037); every server-side render derives from it here:
//
//  - markdownToHtml feeds the Save Offline / share print document and the
//    OneDrive export's HTML needs. Bespoke handling: ledgr://item/<id> links
//    render as flat mention spans (a ledgr:// URI means nothing on paper or a
//    public link), the color/highlight inline HTML the editor emits
//    (<span style>, <mark class>) passes through, and body headings shift down
//    one level so the document title keeps the <h1>.
//  - markdownToText feeds full-text search (items.body_text). It renders, then
//    strips tags, so the FTS document indexes mention labels and code text but
//    never URIs, color hexes, or markup.
//
// markdown-it is the one vetted markdown dependency (roadmap Phase M; a
// Principle-5 call): a single synchronous, battle-tested CommonMark/GFM package.
// It is never imported by a client component — print, export, and FTS are all
// server paths, so the editor bundle never pays for it.
import MarkdownIt from "markdown-it";
import { stripBlockAnchors } from "@/lib/editor/block-anchor";
import { flattenTabs } from "@/lib/editor/canvas-tabs";
import { renderComments, stripComments } from "@/lib/editor/comment-markdown";
import { spaceEmptyListItems } from "@/lib/editor/list-markdown";
import { MENTION_URI_PREFIX, mentionItemId } from "@/lib/editor/mention-markdown";
import { mentionGlyphSvg } from "@/lib/mention-glyph";
import type { ResolvedMention } from "@/lib/mentions";

// html:true passes raw inline HTML through, which is required: the editor
// encodes sermon colors/highlights as <span style>/<mark class> (colors.ts).
// Safe under Ledgr's model — a single trusted author rendering their own
// content (Save Offline is owner-only; a share link publishes the owner's own
// note, and there is no other user's data on the instance). Revisit with a
// sanitizer if Ledgr ever renders content authored by someone other than the
// viewer's owner.
const md = new MarkdownIt({
  html: true, // pass the editor's <span style>/<mark class> color HTML through
  linkify: false, // only explicit [text](url) links become anchors
  breaks: false, // a lone newline is a CommonMark soft break, not <br>
});

// One token-rewriting pass, run before rendering. Stateless (mutates tokens in
// place), so there's no cross-render state to leak.
md.core.ruler.push("ledgr_transforms", (state) => {
  for (const token of state.tokens) {
    // The document title owns <h1>, so a body "# Heading" renders <h2>; clamp
    // at <h6> (the deepest real heading tag). Matches the pre-cutover render.
    if (token.type === "heading_open" || token.type === "heading_close") {
      const level = Number(token.tag.slice(1)) || 1;
      token.tag = "h" + Math.min(level + 1, 6);
      continue;
    }
    // Mention links → <a href="/items/<id>" class="mention">@Title</a>. The
    // ledgr://item/<id> URI means nothing to a reader, so rewrite the href to
    // the in-app item route: a tappable link on the print/share view (the
    // hover-target span was dead on touch). Links never nest in markdown, so the
    // first link_close after a mention link_open is its match.
    //
    // Type-aware mentions: when the caller passes a resolved-mentions map via the
    // render env (markdownToHtml's second arg), each mention also gets its target
    // type's glyph prepended and a `mention--<type>` class. With NO map (the FTS
    // path, or a share with icons turned off) the behavior is exactly as before:
    // a plain styled link. With a map present but the id unresolved (trashed,
    // not the owner's, or template), the mention flattens to a muted,
    // non-navigating span instead of a dead link.
    const mentions = (state.env as { mentions?: Map<string, ResolvedMention> })
      ?.mentions;
    if (token.type === "inline" && token.children) {
      const kids = token.children;
      for (let j = 0; j < kids.length; j++) {
        if (kids[j].type !== "link_open") continue;
        const href = kids[j].attrGet("href") ?? "";
        if (!href.startsWith(MENTION_URI_PREFIX)) continue;
        const id = mentionItemId(href);
        const resolved = id && mentions ? mentions.get(id) : undefined;
        if (id && (!mentions || resolved)) {
          // Tappable in-app link. With a resolved map, add the type class and
          // prepend the type glyph (an html_inline token) inside the anchor.
          kids[j].attrs = [
            ["href", `/items/${id}`],
            ["class", resolved ? `mention mention--${resolved.type}` : "mention"],
            ...(resolved ? [["data-type", resolved.type] as [string, string]] : []),
          ];
          if (resolved) {
            const iconTok = new state.Token("html_inline", "", 0);
            iconTok.content = mentionGlyphSvg({
              type: resolved.type,
              icon: resolved.icon,
              statusCategory: resolved.statusCategory,
            });
            kids.splice(j + 1, 0, iconTok); // before the label text
            j++; // skip the token we just inserted
          }
          continue;
        }
        // Malformed mention (empty id) OR a present-but-unresolved target:
        // flatten to a muted span so no broken anchor or ledgr:// URI reaches
        // the page.
        kids[j].tag = "span";
        kids[j].attrs = [["class", id ? "mention mention--missing" : "mention"]];
        for (let k = j + 1; k < kids.length; k++) {
          if (kids[k].type === "link_close") {
            kids[k].tag = "span";
            kids[k].attrs = null;
            break;
          }
        }
      }
    }
  }
});

// GFM task lists: render "- [ ] " / "- [x] " list items as real (disabled)
// checkboxes, so the markdown the editor round-trips (@tiptap/markdown task
// lists, ADR-044) renders the same way on the print/share document and the
// export. Compact hand-rolled rule (the markdown-it-task-lists approach) rather
// than a dependency (Principle 5): a list item's first inline child is a text
// token starting with the marker; strip it, prepend a checkbox, and tag the
// item + its list so CSS can drop the disc bullet.
md.core.ruler.after("inline", "task_lists", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== "inline") continue;
    if (tokens[i - 2].type !== "list_item_open") continue; // open, paragraph, inline
    const children = tokens[i].children;
    const first = children?.[0];
    if (!first || first.type !== "text") continue;
    const m = /^\[([ xX])\]\s+/.exec(first.content);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    first.content = first.content.slice(m[0].length);
    tokens[i - 2].attrJoin("class", "task-list-item");
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
    children!.unshift(box);
    // Tag the enclosing list so CSS can remove its bullet.
    for (let k = i - 2; k >= 0; k--) {
      if (tokens[k].type === "bullet_list_open") {
        tokens[k].attrJoin("class", "contains-task-list");
        break;
      }
      if (tokens[k].type === "bullet_list_close") break;
    }
  }
});

// `++text++` → <u>text</u>. That is what the editor's underline mark serializes
// to (@tiptap/extension-underline, via StarterKit — it owns both ends of the
// round-trip, so this is not a new dialect element, just the render side of one
// that was already reaching the body). markdown-it has no `ins` rule and
// markdown-it-ins is a whole dependency for one delimiter (Principle 5), so this
// is a minimal inline rule instead. Runs before `emphasis` so the `+`s never
// reach the emphasis machinery.
//
// ponytail: matches the NEAREST closing `++` rather than doing markdown-it's
// nesting-aware delimiter pairing, so `++a ++b++ c++` pairs shallowly. The
// editor can't produce that (a mark doesn't nest inside itself) and neither can
// a person who means it. Upgrade path if it ever bites: port markdown-it-ins's
// tokenize/postProcess pair. Inner content is re-parsed inline, so **bold** and
// colors inside an underline survive.
md.inline.ruler.before("emphasis", "ledgr_underline", (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x2b || state.src.charCodeAt(start + 1) !== 0x2b) {
    return false;
  }
  const close = state.src.indexOf("++", start + 2);
  // Nothing between the delimiters, or the pair straddles the end of this inline
  // run: not ours.
  if (close < 0 || close === start + 2 || close + 2 > state.posMax) return false;
  if (!silent) {
    state.push("u_open", "u", 1);
    state.md.inline.parse(
      state.src.slice(start + 2, close),
      state.md,
      state.env,
      state.tokens
    );
    state.push("u_close", "u", -1);
  }
  state.pos = close + 2;
  return true;
});

// Re-indent indentation-nested lists to CommonMark-correct widths so this
// renderer nests them the same way the editor shows them. (Don't undo this
// without re-checking the editor's serializer.)
//
// WHY: the editor (Tiptap @tiptap/markdown, on the lenient `marked` parser)
// treats a sub-list item indented by as little as 2 spaces as a child, and that
// is exactly what it serializes — its default indent step is 2 spaces. But
// markdown-it follows CommonMark, where a sub-list must be indented to its
// parent item's content column: for an ordered marker "1. " that column is 3,
// so a 2-space indent is too shallow and the whole list collapses into one
// renumbered top-level sequence. That is the "the editor shows nested numbered
// lists but the print/PDF/share view renders one flat 1..N list" bug, and the
// Notion import wrote its nesting at 2 spaces, so most imported notes hit it.
//
// This pass reads the document's own indentation as relative nesting (the way
// the editor interprets it) and re-emits each list line indented to its
// parent's content column, which is also marker-width-aware (a "10." parent
// needs 4), so markdown-it nests it identically. Already-correct documents are
// effectively unchanged. Fenced code is passed through untouched; a flush-left
// non-list line ends the current list (clears the nesting stack).
const LIST_ITEM_RE = /^( *)([-+*]|\d{1,9}[.)])( +)(.*)$/;
const CODE_FENCE_RE = /^ *(`{3,}|~{3,})/;

export function normalizeListIndent(markdown: string): string {
  if (!markdown.includes("\n") && !LIST_ITEM_RE.test(markdown)) return markdown;
  // Each open list level: how deep it was indented in the source, what we
  // re-indent it to, and the column its own children must reach.
  const stack: { srcIndent: number; outIndent: number; contentCol: number }[] = [];
  let inCode = false;
  const out = markdown.split("\n").map((line) => {
    if (CODE_FENCE_RE.test(line)) {
      inCode = !inCode;
      return line;
    }
    if (inCode) return line;
    if (/^\s*$/.test(line)) return line; // blank lines keep a (loose) list open

    const m = LIST_ITEM_RE.exec(line);
    if (!m) {
      // A flush-left paragraph/heading/HR ends any open list; an indented
      // continuation line is left as-is (rare in practice).
      if ((line.match(/^ */)?.[0].length ?? 0) === 0) stack.length = 0;
      return line;
    }

    const srcIndent = m[1].length;
    const marker = m[2];
    const content = m[4];
    while (stack.length && stack[stack.length - 1].srcIndent >= srcIndent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const outIndent = parent ? parent.contentCol : 0;
    // We always emit a single space after the marker, so the child column is
    // outIndent + marker length + 1.
    stack.push({ srcIndent, outIndent, contentCol: outIndent + marker.length + 1 });
    return " ".repeat(outIndent) + marker + " " + content;
  });
  return out.join("\n");
}

// Markdown → HTML for the print/share document body and export. Empty in,
// empty out (the document shell renders the title and an empty body).
//
// Pass `mentions` (a resolved-mentions map, owner-scoped) to render @-mentions
// type-aware: each gets its target type's glyph and a `mention--<type>` class,
// and an unresolved target renders muted instead of as a dead link. Omit it for
// the plain-link behavior (the FTS path, or a share with icons turned off).
export function markdownToHtml(
  markdown: string,
  mentions?: Map<string, ResolvedMention>,
  opts: { comments?: boolean } = {}
): string {
  if (!markdown) return "";
  return md.render(prepare(markdown, opts.comments !== false), { mentions });
}

// The one text-pass chain every server render shares. Block anchors (^id,
// ADR-090) are an editor-only back-reference mechanism; strip them so
// shared/printed/exported notes read as clean prose. Canvas tab markers
// (ADR-095) flatten to `## Title` sections so a multi-tab note reads as titled
// sections when shared/printed/exported.
//
// `comments` (ADR-170) chooses which end of the comment parser runs: true expands
// CriticMarkup into the paired `.cmt`/`.cmt-note` spans the read view styles,
// false removes the notes and keeps the prose. It defaults TRUE, so the in-app
// read view and the FTS document both see comments (they're the owner's own
// notes, and searching them is the point); the print/share/docx paths pass false
// so a private note to self never reaches a reader.
function prepare(markdown: string, comments: boolean): string {
  const body = comments ? renderComments(markdown) : stripComments(markdown);
  // spaceEmptyListItems: a body written before the editor learned to separate
  // them still carries `- ` flush under a paragraph, which CommonMark reads as a
  // setext heading. Heal it here too, so an old note prints/shares/exports as
  // the bullets it was meant to be rather than a giant heading.
  return normalizeListIndent(
    spaceEmptyListItems(stripBlockAnchors(flattenTabs(body)))
  );
}

// Markdown → plain text for the FTS document. Render, then strip tags and decode
// the handful of entities the renderer emits, and collapse whitespace. Going
// through the renderer (not a raw regex strip of the markdown) is what drops
// ledgr:// URIs and color hexes while keeping mention labels and code text.
export function markdownToText(markdown: string): string {
  if (!markdown) return "";
  const text = md
    .render(prepare(markdown, true))
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

// Fenced/inline code, stripped to a space rather than read aloud (the Listen
// feature, ADR-listen-tts). Cheap regexes rather than a fence-aware line walk
// (comment-markdown.ts's mapLines) because speech text tolerates a little
// imprecision that FTS/print can't — this only ever feeds speechSynthesis.
function stripCodeForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]+`/g, " ");
}

// Markdown → plain text for the Listen (read-aloud) control. Strips
// CriticMarkup comments entirely (stripComments — a private note to self
// should never be read aloud, same rule print/share/export already follow),
// then code (spoken code is noise, not prose), then renders through
// markdownToText for the rest (headings, links, mentions → plain words).
export function speechTextFor(markdown: string): string {
  if (!markdown) return "";
  return markdownToText(stripCodeForSpeech(stripComments(markdown)));
}
