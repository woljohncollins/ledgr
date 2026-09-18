// Inline SVG icons for the markdown editor toolbar (no icon-font, no dependency
// — Principle 5). Stroke-based, currentColor, 16px. Keyed by the toolbar item
// id so the data-driven toolbar (and the configurable-toolbar settings) can map
// over them. Headings stay as crisp "H1"/"H2" text labels (conventional).
import type { ReactNode } from "react";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

// The speech-bubble geometry, shared by the toolbar button and the outline's
// comment list. `markdown-editor.css` carries its own copy in --cmt-bubble
// because CSS can't import; keep those two in step.
export const COMMENT_BUBBLE_PATH =
  "M5 4h14a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-5 4v-4H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z";

export const TOOLBAR_ICONS: Record<string, ReactNode> = {
  // undo/redo: the conventional curved arrow over a baseline. Mobile has no
  // Ctrl+Z, so these are the only way to walk an edit back on a phone.
  undo: <Svg><path d="M4 8h10a5 5 0 0 1 0 10h-6" /><polyline points="8 4 4 8 8 12" /></Svg>,
  redo: <Svg><path d="M20 8H10a5 5 0 0 0 0 10h6" /><polyline points="16 4 20 8 16 12" /></Svg>,
  bold: <Svg><path d="M6 4h7a4 4 0 0 1 0 8H6z" /><path d="M6 12h8a4 4 0 0 1 0 8H6z" /></Svg>,
  italic: <Svg><line x1="19" y1="4" x2="10" y2="4" /><line x1="14" y1="20" x2="5" y2="20" /><line x1="15" y1="4" x2="9" y2="20" /></Svg>,
  underline: <Svg><path d="M6 4v6a6 6 0 0 0 12 0V4" /><line x1="5" y1="20" x2="19" y2="20" /></Svg>,
  strike: <Svg><path d="M17 7a4 4 0 0 0-4-3H10a3 3 0 0 0-1 5.8" /><path d="M7 17a4 4 0 0 0 4 3h2a3 3 0 0 0 1-5.8" /><line x1="4" y1="12" x2="20" y2="12" /></Svg>,
  bulletList: <Svg><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></Svg>,
  orderedList: <Svg><line x1="10" y1="6" x2="20" y2="6" /><line x1="10" y1="12" x2="20" y2="12" /><line x1="10" y1="18" x2="20" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M4 15h2v1l-2 1v1h2" /></Svg>,
  tasks: <Svg><path d="M3 6l1.5 1.5L7 5" /><path d="M3 13l1.5 1.5L7 12" /><line x1="10" y1="6" x2="20" y2="6" /><line x1="10" y1="13" x2="20" y2="13" /><line x1="10" y1="19" x2="16" y2="19" /></Svg>,
  quote: <Svg><path d="M7 7H4v5h3l-1 4" /><path d="M17 7h-3v5h3l-1 4" /></Svg>,
  code: <Svg><polyline points="8 6 3 12 8 18" /><polyline points="16 6 21 12 16 18" /></Svg>,
  table: <Svg><rect x="3" y="4" width="18" height="16" rx="1" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="9" y1="4" x2="9" y2="20" /></Svg>,
  image: <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5L5 20" /></Svg>,
  // attach: the conventional paperclip — upload any file and link it in place
  // (the image glyph stays image-only; this one takes everything else too).
  attach: <Svg><path d="M20.5 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5" /></Svg>,
  // weblink: the conventional chain-link glyph, for inserting a hyperlink.
  weblink: <Svg><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></Svg>,
  // link: copy a deep link to the current line (a block anchor) — a hash glyph,
  // distinct from the chain used for true hyperlinks.
  link: <Svg><line x1="9" y1="3" x2="7" y2="21" /><line x1="17" y1="3" x2="15" y2="21" /><line x1="4" y1="9" x2="20" y2="9" /><line x1="3" y1="15" x2="19" y2="15" /></Svg>,
  color: <Svg><path d="M12 3l5.5 9a5.5 5.5 0 1 1-11 0z" /></Svg>,
  highlight: <Svg><path d="M4 20h6" /><path d="M14 4l6 6-9 9H7v-4z" /></Svg>,
  // outdent/indent: list-nesting controls. Lines on the right with a left/right
  // chevron — the conventional indent-decrease / indent-increase glyphs. Mobile
  // has no Tab key, so these are the only way to nest a list there.
  outdent: <Svg><line x1="21" y1="6" x2="9" y2="6" /><line x1="21" y1="12" x2="13" y2="12" /><line x1="21" y1="18" x2="9" y2="18" /><path d="M7 9l-3 3 3 3" /></Svg>,
  indent: <Svg><line x1="21" y1="6" x2="9" y2="6" /><line x1="21" y1="12" x2="13" y2="12" /><line x1="21" y1="18" x2="9" y2="18" /><path d="M4 9l3 3-3 3" /></Svg>,
  // toggle: a disclosure triangle beside lines — inserts a collapsible block.
  toggle: <Svg><path d="M8 5l4 4-4 4" /><line x1="14" y1="7" x2="20" y2="7" /><line x1="14" y1="12" x2="20" y2="12" /><line x1="8" y1="19" x2="20" y2="19" /></Svg>,
  // comment: the conventional speech bubble (ADR-170), from COMMENT_BUBBLE_PATH
  // below — the outline's comment list draws the same glyph, so it's a named
  // export rather than a third copy. For a note anchored to the
  // selected text. Distinct from the highlight marker, which fills rather than
  // annotates. A rounded rectangle with a tail, not the round "chat blob" this
  // replaced: the blob's tail was a thin spike off a circle, which reads as a
  // smudge at 16px and worse as a filled glyph at 14px (Brandon, 2026-07-30 — "a
  // little wonky"). Same geometry as the --cmt-bubble mask in
  // markdown-editor.css; keep the two in step.
  comment: <Svg><path d={COMMENT_BUBBLE_PATH} /></Svg>,
  // slide (ADR-176): a screen on a stand — "put this on the screen." Sits directly
  // left of the comment bubble, since the two are the same gesture (mark a span)
  // for different audiences: a comment is for you, a slide is for the room.
  slide: <Svg><rect x="3" y="4" width="18" height="12" rx="1" /><line x1="12" y1="16" x2="12" y2="20" /><line x1="9" y1="20" x2="15" y2="20" /></Svg>,
};

// The toolbar items in display order (id → label), for the configurable-toolbar
// settings UI. Ids match the gating in MarkdownEditor.
export const TOOLBAR_ITEMS: { id: string; label: string }[] = [
  { id: "undo", label: "Undo / Redo" },
  { id: "bold", label: "Bold" },
  { id: "italic", label: "Italic" },
  { id: "underline", label: "Underline" },
  { id: "strike", label: "Strikethrough" },
  { id: "h1", label: "Heading 1" },
  { id: "h2", label: "Heading 2" },
  { id: "bulletList", label: "Bullet list" },
  { id: "orderedList", label: "Numbered list" },
  { id: "tasks", label: "Checklist" },
  { id: "outdent", label: "Outdent (un-nest)" },
  { id: "indent", label: "Indent (nest)" },
  { id: "quote", label: "Quote" },
  { id: "code", label: "Code" },
  { id: "table", label: "Table" },
  { id: "toggle", label: "Toggle block" },
  { id: "image", label: "Image" },
  { id: "attach", label: "Attach file" },
  { id: "weblink", label: "Insert link" },
  { id: "link", label: "Copy line link" },
  { id: "color", label: "Text color" },
  { id: "highlight", label: "Highlight" },
  { id: "slide", label: "Slide (on screen)" },
  { id: "comment", label: "Comment" },
  { id: "mention", label: "@ mention hint" },
];
