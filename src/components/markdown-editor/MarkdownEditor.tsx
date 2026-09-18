// The Tiptap markdown editor (M2, ADR-038). Never imported directly from a
// page — only through LazyMarkdownEditor (code-split, client-only), the same
// discipline the BlockNote editor follows (CLAUDE.md rule 8). It reads and
// writes markdown text: content goes in as { contentType: "markdown" } and
// every edit emits editor.getMarkdown(), because markdown is the source of
// truth (ADR-037). Colors and mentions round-trip through the bespoke
// extensions; the rest is StarterKit + the first-party Markdown extension.
"use client";

import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/Popover";
import { TOOLBAR_ICONS } from "./toolbar-icons";
import { useKeyboardInset } from "./useKeyboardInset";
import { useIsDesktop } from "./useIsDesktop";
import { useRouter } from "next/navigation";
import { openItem } from "@/lib/item-nav";
import { showToast } from "@/components/ui/ActionToast";
import {
  ATTACHMENT_REMOVED_EVENT,
  FILE_DRAG_MIME,
  type AttachmentRemovedDetail,
  type FileDragPayload,
} from "@/components/attachments/upload";
import {
  ACCENT_HIGHLIGHT,
  ACCENT_HIGHLIGHT_BG,
  BLOCKNOTE_COLORS,
  type BlockNoteColor,
  type HighlightColor,
} from "@/lib/colors";
import {
  EmptyListItemFix,
  FootnoteMarkdownFix,
  Highlight,
  LedgrImage,
  LedgrMention,
  LedgrPassage,
  LedgrTable,
  ListBackspaceJoin,
  MarkdownEscapeFix,
  OrderedListTextFix,
  SlideMark,
  TableCell,
  TableHeader,
  TableRow,
  TextColor,
} from "./extensions";
import { createMentionSuggestion } from "./mention-suggestion";
import { ItemTokenDecoration } from "./token-decoration";
import { ItemTokenSuggestion } from "./token-suggestion";
import {
  Toggle,
  ToggleSummary,
  ToggleContent,
  insertToggle,
  wrapSelectionInToggle,
} from "./toggle-extension";
import {
  CollapsibleHeadings,
  setHeadingsCollapsible,
} from "./collapsible-headings";
import {
  SlashCommands,
  setSlashFilePicker,
  setSlashToggleEnabled,
} from "./slash-suggestion";
import { mentionStorage, type MentionStorage } from "./mention-node-view";
import { collectMentionIdsFromMarkdown } from "@/lib/editor/mention-markdown";
import type { ResolvedMention } from "@/lib/mentions";
import {
  BlockAnchor,
  PROMOTE_LINE_EVENT,
  OPEN_ITEM_EVENT,
  ensureAnchorAtPos,
  ensureAnchorAtSelection,
  scrollToBlockId,
  setPromotedRefs,
  type PromotedRefs,
} from "./block-anchor-extension";
import {
  Comment,
  CommentCards,
  EDIT_COMMENT_EVENT,
  commentNoteAt,
  removeComment,
  setComment,
} from "./comment-mark";
import { extractPromotable } from "@/lib/editor/block-anchor";
import { withShortcut } from "@/lib/editor/shortcuts";
import { deskSendAvailable, openDeskSendMenu } from "@/lib/desk/send";
import CommentPopover from "./CommentPopover";
import PromoteLinePopup from "./PromoteLinePopup";
import "./markdown-editor.css";

export type MarkdownEditorProps = {
  // The host item, so the @-menu can exclude it from its own results.
  itemId?: string;
  initialMarkdown: string;
  // Fired with the full markdown string on every edit; the host debounces.
  onChange: (markdown: string) => void;
  // Optional: hands the live editor up once ready, so a host can drive
  // imperative inserts (e.g. the Changelog notes "Sign" stamp). No-op when unset.
  onEditorReady?: (editor: Editor) => void;
  // Optional: upload a file (paste/drop/button/"/file") and resolve its stable
  // /files/<id> URL. Images embed where they land; any other file type inserts
  // as a plain markdown link on its filename. When unset, all file insertion is
  // disabled — controlled hosts with no backing item (scratch route, Changelog
  // notes) pass nothing.
  uploadFile?: (file: File) => Promise<string>;
  // When set (meetings, ADR-090): enable the per-line "→ task" promote
  // affordance, posting to this meeting's promote endpoint.
  promoteToMeetingId?: string;
  // Flush the host's debounced body save and resolve when done — called before a
  // promote POST so the line's freshly-inserted ^id anchor is persisted first.
  onRequestSave?: () => Promise<void>;
  // blockRef → the task it was promoted to (ADR-090): shows a "✓ task" badge on
  // those lines instead of the promote button, and links to the task.
  promotedRefs?: PromotedRefs;
  // Papers only: keep `[^id]` footnote markers and their definitions out of the
  // serializer's backslash-escaping, so a citation survives a save on the rich
  // surface. Footnotes are not in the shared dialect (they are hand-parsed by the
  // Papers module and its .docx renderer), so this is OPT-IN — an ordinary note
  // must keep treating `\[^…\]` as the literal text the owner typed. See
  // FootnoteMarkdownFix in extensions.ts.
  preserveFootnotes?: boolean;
  // Controlled visibility of the formatting bar on desktop (S5): the collapse
  // toggle now lives in BodyEditor's mode-row, which owns this state (and its
  // per-item persistence). When false the bar renders NOTHING on desktop (zero
  // height — no empty reserved strip); on mobile the bar always shows regardless,
  // since the collapse affordance is desktop-only. Default true = always shown,
  // for the direct callers (scratch, changelog) that have no mode-row.
  toolbarOpen?: boolean;
  // Desktop only: the body's view-mode controls (Rich/Source/Preview pill +
  // collapse toggle), rendered right-aligned on the SAME row as the formatting
  // buttons so the two read as one bar (ADR-125 mode switch, merged in S8). The
  // caller (BodyEditor) owns the markup and its own visibility; MarkdownEditor
  // just docks it. When set, the bar always renders (even with the formatting
  // buttons collapsed) so the toggle stays reachable. Direct callers pass none.
  viewControls?: ReactNode;
  // When true, the editor has no tall min-height: it starts one line tall and
  // grows with content (the task canvas, where bodies are short). Default false
  // keeps the roomy 14rem writing area.
  compact?: boolean;
  // When false (a locked item, item lock toggle): the body is read-only.
  // Tiptap drops contenteditable so the cursor can't enter, and the toolbar is
  // hidden — the document still renders, it just can't be changed. Defaults true.
  editable?: boolean;
  // Focus the editor as soon as it mounts. Set by LazyMarkdownEditor's
  // reading-first swap when the user clicks/taps into the body to edit, so the
  // interaction lands as an edit; unused on the direct mount path.
  autoFocus?: boolean;
  // Imperative focus signal: a monotonically increasing counter the host bumps to
  // move the caret INTO the editor (the title's Enter → jump to the body). The
  // mount value 0 means "don't focus", so a normal load never steals focus; each
  // increment focuses once. Defaults 0.
  focusSignal?: number;
};

const COLOR_NAMES = Object.keys(BLOCKNOTE_COLORS) as BlockNoteColor[];

// Pull files out of a paste/drop payload (any type — a payload with no files,
// i.e. ordinary text/markdown paste, falls through to Tiptap's normal handling).
function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files);
}

// Insert a linked filename at the current selection, trailing space included —
// the space keeps back-to-back inserts from fusing into one link and gives the
// caret a mark-free spot to keep typing from. Shared by fresh uploads and by
// an existing file row dragged in from the Files panel.
function insertFileLink(view: EditorView, label: string, url: string): void {
  const linkMark = view.state.schema.marks.link;
  if (!linkMark) return;
  const frag = Fragment.from([
    view.state.schema.text(label || "file", [linkMark.create({ href: url })]),
    view.state.schema.text(" "),
  ]);
  view.dispatch(
    view.state.tr.replaceSelection(new Slice(frag, 0, 0)).scrollIntoView()
  );
}

// When a file is DELETED (the Files panel/section, Build → Files), its
// references in the live doc would keep rendering as links — and worse, an
// unsaved body would resurrect them over the server-side scrub on its next
// autosave. So the editor scrubs its own document: link marks pointing at the
// file unlink to their text plus a "(file deleted)" note, embedded images
// become the note alone. The owner's words are never deleted (Tyler,
// 2026-08-29); the resulting transaction autosaves like any edit.
function scrubDeletedFile(editor: Editor, attachmentId: string): void {
  const { state } = editor.view;
  const { doc, schema } = state;
  const hits: { from: number; to: number; kind: "link" | "image" }[] = [];
  doc.descendants((node, pos) => {
    if (
      node.type === schema.nodes.image &&
      typeof node.attrs.src === "string" &&
      node.attrs.src.includes(attachmentId)
    ) {
      hits.push({ from: pos, to: pos + node.nodeSize, kind: "image" });
      return false;
    }
    if (node.isText) {
      const linked = node.marks.some(
        (m) =>
          m.type === schema.marks.link &&
          typeof m.attrs.href === "string" &&
          m.attrs.href.includes(attachmentId)
      );
      if (linked) hits.push({ from: pos, to: pos + node.nodeSize, kind: "link" });
    }
    return true;
  });
  if (hits.length === 0) return;
  let tr = state.tr;
  // Back to front, so earlier positions stay valid as later spans change.
  for (const h of hits.sort((a, b) => b.from - a.from)) {
    try {
      if (h.kind === "image") {
        tr = tr.replaceWith(h.from, h.to, schema.text("(file deleted)"));
      } else {
        tr = tr.insertText(" (file deleted)", h.to);
        tr = tr.removeMark(h.from, h.to, schema.marks.link);
      }
    } catch {
      // A span the schema won't take the edit on (e.g. a block-position image):
      // leave it rather than corrupt the doc; the server scrub still ran.
    }
  }
  editor.view.dispatch(tr);
}

// Upload each file and drop it in at the current selection: images embed as
// image nodes, everything else inserts as a markdown link on its filename
// (the stable /files/<id> address). Sequential so multiple pasted files keep
// their order; the selection advances past each inserted node, so the next one
// lands after it.
async function insertUploadedFiles(
  view: EditorView,
  files: File[],
  upload: (file: File) => Promise<string>
) {
  for (const file of files) {
    try {
      const url = await upload(file);
      const { schema } = view.state;
      if (file.type.startsWith("image/")) {
        const imageType = schema.nodes.image;
        if (!imageType) continue;
        const alt = (file.name || "").replace(/\.[^.]+$/, "");
        const node = imageType.create({ src: url, alt });
        view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
        continue;
      }
      insertFileLink(view, file.name, url);
    } catch (err) {
      // Say so on screen, not just in the console — a swallowed failure here
      // reads as "I picked a file and nothing happened" (Tyler, 2026-08-29,
      // against a preview with no R2 vars).
      console.error("file upload failed", err);
      showToast(err instanceof Error ? err.message : "File upload failed");
    }
  }
}

// Editor settings the canvas needs (app-wide): the hidden-toolbar ids plus the
// two feature switches. Fetched once per page load (memoized) so every editor
// instance shares the single request.
type EditorSettings = {
  hidden: string[];
  collapsibleHeadings: boolean;
  toggleBlocks: boolean;
};
let editorSettingsPromise: Promise<EditorSettings> | null = null;
function loadEditorSettings(): Promise<EditorSettings> {
  editorSettingsPromise ??= fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const s = d?.settings ?? {};
      return {
        hidden: Array.isArray(s.editorToolbarHidden)
          ? (s.editorToolbarHidden as string[])
          : [],
        // Default on when the field is absent (matches DEFAULT_SETTINGS).
        collapsibleHeadings: s.collapsibleHeadingsEnabled !== false,
        toggleBlocks: s.toggleBlocksEnabled !== false,
      };
    })
    .catch(() => ({ hidden: [], collapsibleHeadings: true, toggleBlocks: true }));
  return editorSettingsPromise;
}

// Shared ghost-button look for every toolbar control (formatting buttons + the
// swatch controls), on the refreshed token layer (ADR-141): quiet idle ink, a
// surface-2 wash on hover/active. Kept in one place so the two control kinds
// can't drift apart.
function toolbarBtnClass(active?: boolean, disabled?: boolean) {
  return `flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 text-sm font-medium ${
    disabled
      ? "cursor-default text-ink-faint"
      : active
        ? "bg-surface-2 text-ink"
        : "text-ink-subtle hover:bg-surface-2 hover:text-ink"
  }`;
}

// A swatch's face: the color's text stroke for the "color" kind, its highlight
// fill for the "highlight" kind, and the owner's live accent for the accent.
function swatchHex(kind: "color" | "highlight", c: HighlightColor) {
  if (c === ACCENT_HIGHLIGHT) return ACCENT_HIGHLIGHT_BG;
  return kind === "color"
    ? BLOCKNOTE_COLORS[c].text
    : BLOCKNOTE_COLORS[c].background;
}

// Roughly how wide the open panel is, per kind: ten 24px swatches plus the clear
// button, the divider, gaps and padding. Only feeds the viewport CLAMP below, and
// over-estimating is the safe direction (it pulls the panel further inside), so
// this doesn't have to track the layout to the pixel.
const SWATCH_PANEL_W = { color: 300, highlight: 344 } as const;

// The text-color / highlight picker: a toolbar button that opens a row of
// swatches (ADR-155).
//
// A COMPONENT rather than the render helper this used to be, because it needs
// useAnchoredPanel and the two pickers are each rendered conditionally on the
// owner's toolbar config — a hook called from a helper invoked behind two
// separate conditions is a hook-order bug waiting to happen.
//
// The panel is portaled and fixed-positioned rather than `absolute right-0`
// (Tyler, 2026-09-09, screenshot): with the window pushed against the right edge
// of the monitor, the row opened off-screen and the last colors were simply
// unreachable. Adding the tenth accent swatch made a narrow miss into an obvious
// one. `useAnchoredPanel` (the placement half of ui/Popover, exported for exactly
// this) clamps into the viewport on both edges and flips above the button when
// there's no room below, so no window position can hide a color.
//
// NOT ui/Popover itself, though the panel is now equivalent: that component owns
// its trigger button and doesn't preventDefault on mousedown, which in an editor
// toolbar blurs the document and throws away the selection being highlighted.
function SwatchControl({
  kind,
  current,
  onPick,
  open,
  onToggle,
  isDesktop,
}: {
  kind: "color" | "highlight";
  current: string;
  onPick: (c: HighlightColor | null) => void;
  open: boolean;
  onToggle: () => void;
  isDesktop: boolean;
}) {
  const { anchorRef, coords } = useAnchoredPanel<HTMLButtonElement>(
    open,
    SWATCH_PANEL_W[kind],
    "right"
  );
  const title = kind === "color" ? "Text color" : "Highlight";

  // Mobile: the formatting bar is a horizontally-scrolling strip pinned above
  // the keyboard, so an absolutely-positioned popover would be clipped by the
  // scroll container (overflow-x:auto forces overflow-y:auto) and would open
  // down into the keyboard. Fall back to a native <select> — the OS picker is
  // unclipped, keyboard-safe, and idiomatic on touch. Desktop gets the swatch
  // popover below.
  if (!isDesktop) {
    return (
      <select
        title={title}
        aria-label={title}
        className="h-7 rounded-md bg-surface-2 px-1 text-sm text-ink-muted"
        value={current}
        onChange={(e) => onPick((e.target.value || null) as HighlightColor | null)}
      >
        <option value="">{title}</option>
        {COLOR_NAMES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
        {kind === "highlight" && (
          <option value={ACCENT_HIGHLIGHT}>my highlight</option>
        )}
      </select>
    );
  }

  const pick = (c: HighlightColor | null) => {
    onPick(c);
    onToggle();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        className={toolbarBtnClass(open || !!current)}
      >
        <span className="flex items-center gap-1">
          {kind === "color" ? (
            <span className="text-sm font-semibold leading-none">A</span>
          ) : (
            <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{TOOLBAR_ICONS.highlight}</span>
          )}
          <span
            className="h-1 w-3.5 rounded-full"
            style={{
              backgroundColor: current
                ? swatchHex(kind, current as HighlightColor)
                : "var(--line-strong, #444)",
              backgroundImage:
                current === ACCENT_HIGHLIGHT
                  ? "var(--accent-highlight-image, none)"
                  : undefined,
            }}
          />
        </span>
      </button>
      {open &&
        coords &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[55]"
              onMouseDown={onToggle}
            />
            <div
              role="dialog"
              aria-label={title}
              style={{ position: "fixed", left: coords.left, top: coords.top, bottom: coords.bottom }}
              className="z-[60] flex w-max items-center gap-1 rounded-card border border-line bg-surface-3 p-1.5 shadow-lg"
            >
              <button
                type="button"
                title="None"
                aria-label="No color"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(null)}
                className="flex h-6 w-6 items-center justify-center rounded text-xs text-ink-subtle ring-1 ring-line hover:text-ink"
              >
                ✕
              </button>
              {COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  aria-label={c}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                  className={`h-6 w-6 rounded ring-1 ring-line ${
                    current === c ? "ring-2 ring-ink" : ""
                  }`}
                  style={{ backgroundColor: swatchHex(kind, c) }}
                />
              ))}
              {/* The owner's own accent as a tenth highlight ("My highlight").
                  Highlight-only: an accent TEXT color is a different thing and
                  wasn't asked for. Separated by a divider because it isn't one
                  of the nine literals — it tracks the accent in settings, so
                  this swatch changes color when that does. Labeled, per the
                  scope-the-UI rule: an unexplained tenth swatch reads as a bug. */}
              {kind === "highlight" && (
                <>
                  <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
                  <button
                    type="button"
                    title="My highlight (your accent color from Settings)"
                    aria-label="My highlight"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(ACCENT_HIGHLIGHT)}
                    className={`h-6 w-6 rounded ring-1 ring-line ${
                      current === ACCENT_HIGHLIGHT ? "ring-2 ring-ink" : ""
                    }`}
                    style={{
                      backgroundColor: ACCENT_HIGHLIGHT_BG,
                      // A gradient accent shows as a gradient here too; layout.tsx
                      // sets this var only when the owner picked one.
                      backgroundImage: "var(--accent-highlight-image, none)",
                    }}
                  />
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

// A viewport rect → coordinates inside `wrap` (which must be position:relative).
// The comment panel positions this way rather than with fixed viewport coords so
// it scrolls with the note instead of detaching from the comment it belongs to.
function toWrapperPos(
  rect: { top: number; left: number },
  wrap: HTMLElement | null
): { top: number; left: number } | null {
  if (!wrap) return null;
  const w = wrap.getBoundingClientRect();
  return { top: rect.top - w.top, left: rect.left - w.left };
}

function ToolbarButton({
  label,
  icon,
  active,
  disabled,
  onClick,
  title,
  keys,
}: {
  label?: string;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  // A Tiptap shortcut spec ("Mod-b"); appended to the tooltip as "Bold (⌘B)"
  // in the notation of the keyboard you're on. aria-label keeps the plain
  // label — a screen reader shouldn't read out "open paren command B".
  keys?: string;
}) {
  return (
    <button
      type="button"
      title={withShortcut(title, keys)}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={toolbarBtnClass(active, disabled)}
    >
      {icon ?? label}
    </button>
  );
}

export default function MarkdownEditor({
  itemId,
  initialMarkdown,
  onChange,
  onEditorReady,
  uploadFile,
  promoteToMeetingId,
  onRequestSave,
  promotedRefs,
  preserveFootnotes = false,
  toolbarOpen = true,
  viewControls,
  compact = false,
  editable = true,
  autoFocus = false,
  focusSignal = 0,
}: MarkdownEditorProps) {
  // onChange and uploadFile are kept in refs so the editor's once-bound
  // callbacks (onUpdate, the paste/drop handlers) always see the latest props
  // without re-creating the editor. Synced in an effect, not during render.
  const onChangeRef = useRef(onChange);
  const uploadRef = useRef(uploadFile);
  const onRequestSaveRef = useRef(onRequestSave);
  // Two hidden pickers: the Image button's (image/* only) and the any-file one
  // behind the Attach button + the "/file" slash command.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const anyFileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  // The promote popup's draft, or null when closed (ADR-090).
  const [promote, setPromote] = useState<{
    blockId: string;
    title: string;
    body: string;
  } | null>(null);
  // Brief "Copied" feedback on the copy-link-to-line button.
  const [linkCopied, setLinkCopied] = useState(false);
  // The hyperlink editor's draft URL, or null when the editor is closed. Opened
  // by the toolbar's Insert-link button; applies the StarterKit Link mark.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  // The open comment editor (ADR-170), or null. `existing` is false when the
  // selection is being commented for the first time, which is what decides
  // whether the panel offers Delete.
  //
  // Rendered as a CommentPopover, not (as it first was) a row under the toolbar:
  // that row lived at the top of the editor, so opening a comment far down the
  // note scrolled the document to the top and took the annotated text off screen
  // (Brandon, 2026-07-30).
  const [commentDraft, setCommentDraft] = useState<
    // `at` is a position inside the comment being edited (absent when creating one
    // over the current selection); it's what Save/Delete extend from. `pos` is
    // where the panel opens on a wide screen, in wrapRef's coordinate space.
    {
      note: string;
      existing: boolean;
      at?: number;
      pos: { top: number; left: number } | null;
    } | null
  >(null);
  // The card currently hidden behind its open editor, so it can be restored
  // however the panel closes (save, delete, cancel, click-away). Toggling a class
  // on the card is safe where the same trick on anchored text is not: the card is
  // a widget decoration, and widgets are exempt from ProseMirror's mutation
  // observer (see comment-mark.ts, setLit).
  const editingCardRef = useRef<HTMLElement | null>(null);
  const hideEditingCard = (el: HTMLElement | null) => {
    editingCardRef.current?.classList.remove("cmt-note-editing");
    editingCardRef.current = el;
    el?.classList.add("cmt-note-editing");
  };
  const closeCommentDraft = () => {
    hideEditingCard(null);
    setCommentDraft(null);
  };

  // The editor's own wrapper, the offset parent the comment panel positions
  // against — so the panel scrolls with the document instead of detaching.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onChangeRef.current = onChange;
    uploadRef.current = uploadFile;
    onRequestSaveRef.current = onRequestSave;
  });

  // The last markdown this editor emitted upward, seeded (in onCreate) with the
  // editor's OWN canonical serialization of the loaded body. Tiptap re-emits the
  // body once on mount (a programmatic transaction), and its serialization is
  // rarely byte-identical to the stored markdown — a Notion import uses `*`/`1)`
  // bullets, extra blank lines, etc., which round-trip to `-`/`1.` and single
  // blanks. Comparing that mount re-emit against the *stored* string (as the
  // autosave dedup does) misses, so merely opening an item PATCHed a normalized
  // body and bumped its edit date + burned a revision — the "viewing an item
  // marks it edited" bug. Comparing against the canonical baseline instead makes
  // the mount re-emit a true no-op; only a real user edit differs and saves.
  const lastEmitted = useRef<string | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit,
      // Serialize nested lists at a 4-space step. @tiptap/markdown defaults to
      // 2 spaces, which the editor's own (lenient) parser nests fine but
      // CommonMark renderers (markdown-it, on the print/share/export path, and
      // any external tool reading the exported .md) read as too shallow under an
      // ordered "1. " marker (needs >=3), flattening the list. 4 keeps the
      // canonical markdown nestable everywhere. The render path also normalizes
      // legacy 2-space content (markdown-render.ts), so this is the source-side
      // half of keeping the editor and every render in agreement.
      Markdown.configure({ indentation: { style: "space", size: 4 } }),
      // Must sit right after Markdown: it patches the markdown manager (created in
      // Markdown's onBeforeCreate) so text inside the color/highlight marks isn't
      // backslash-escaped, which otherwise compounded on every rich⇄source flip.
      // See MarkdownEscapeFix in extensions.ts.
      MarkdownEscapeFix,
      // Papers only (opt-in): the same manager-patching discipline, undoing the
      // escaping on `[^id]` footnote markers so a citation survives a save. Off
      // by default so an ordinary note keeps `\[^…\]` as literal typed text.
      ...(preserveFootnotes ? [FootnoteMarkdownFix] : []),
      // Also right after Markdown (same manager-patching discipline): keeps an
      // empty bullet from being read as a setext heading underline, in both
      // directions. See EmptyListItemFix / spaceEmptyListItems.
      EmptyListItemFix,
      // Empty-state hint: a quiet prompt while the body is empty, the first
      // impression of every new note. First-party (@tiptap/extensions), styled
      // via the is-editor-empty class in markdown-editor.css. The "/" hint points
      // at the slash-command menu (SlashCommands, below).
      Placeholder.configure({ placeholder: "Start writing, or press / for commands…" }),
      // GFM task lists (- [ ] / - [x]): @tiptap/markdown round-trips them, so no
      // bespoke serializer is needed (unlike the color marks). nested lets a
      // checklist item hold a sub-checklist.
      TaskList,
      TaskItem.configure({ nested: true }),
      // Backspace at the start of a bullet deletes the line break instead of
      // outdenting (see ListBackspaceJoin). After the list extensions, but the
      // extension's own priority is what actually beats ListKeymap.
      ListBackspaceJoin,
      // Inline HTML dialect marks (span/mark/ins.slide) survive inside an ORDERED
      // list item, matching a bullet item (see OrderedListTextFix in extensions.ts
      // for the upstream @tiptap/extension-list bug this works around).
      OrderedListTextFix,
      // Block anchors (ADR-090): dim trailing ^id markers + the jump-to/ensure
      // primitives the action-item → task promotion rides on. The per-line
      // "→ task" widget shows only when a meeting wired the promote path; a
      // promoted line shows a "✓ task" badge instead (the ref map is pushed into
      // plugin state by an effect, so the badge updates after a promotion).
      BlockAnchor.configure({ promote: !!promoteToMeetingId }),
      TextColor,
      Highlight,
      // Slide mark (ADR-176): <ins class="slide">, "put this span on the screen."
      // Sits with the other two HTML-wrapped marks because it shares their
      // serialization hazard (see HTML_WRAPPED_MARKS in extensions.ts).
      SlideMark,
      // Body comments (ADR-170): the mark round-trips {==text==}{>>note<<}, and
      // CommentCards renders each note as the same `.cmt-note` margin card the
      // read view emits, so both surfaces share one stylesheet. Deliberately NOT
      // in MarkdownEscapeFix's HTML_WRAPPED_MARKS — it emits CriticMarkup, not raw
      // HTML, so its content needs the serializer's normal escaping.
      Comment,
      CommentCards,
      // Inline images (paste/drop → R2) and GFM tables. Both round-trip to
      // markdown via the hooks in extensions.ts.
      LedgrImage,
      LedgrTable.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      LedgrMention.configure({
        HTMLAttributes: { class: "ledgr-mention" },
        suggestion: createMentionSuggestion(itemId),
      }),
      // Passage @/refs (ADR-149) share the "@" picker via the /ref scope; the
      // node reclaims its own ledgr://passage/ links on parse. Additive to the
      // mention node above.
      LedgrPassage,
      // Live item tokens (LT2, ADR-139): highlight recognized {{item.*}} tokens
      // and offer a `{{` insert menu. Tokens stay plain text — decoration only.
      ItemTokenDecoration,
      ItemTokenSuggestion,
      // Collapsible "toggle" block (<details>). The three nodes are always
      // registered so existing bodies with toggles parse; the toolbar button and
      // "/toggle" command (the creation paths) are gated by toggleBlocksEnabled.
      Toggle,
      ToggleSummary,
      ToggleContent,
      // Collapsible headings (view-only fold). Enabled/disabled at runtime from
      // the user's collapsibleHeadingsEnabled setting (dispatched below).
      CollapsibleHeadings,
      // The "/" slash-command menu (headings + toggle). Toggle entry gated by
      // toggleBlocksEnabled (setSlashToggleEnabled below).
      SlashCommands,
    ],
    // Start EMPTY; the body is loaded in the post-mount effect below via
    // setContent. Parsing markdown in the constructor — before every extension's
    // markdown hooks are wired — mis-nests a standalone inline image (an image
    // alone on its line, common in imported/clipped notes) as a bare child of the
    // doc, which is schema-invalid. The editor doesn't check on load, so the
    // first plugin appendTransaction (TrailingNode) throws "contentMatchAt on a
    // node with invalid content" and the editor never mounts — the item modal
    // then drops back to the list. setContent on the ready editor wraps the image
    // correctly, so loading there yields a valid doc. (ADR-159.)
    content: "",
    contentType: "markdown",
    editorProps: {
      attributes: { class: compact ? "ProseMirror ledgr-prose ledgr-prose-compact" : "ProseMirror ledgr-prose" },
      // Paste/drop of files → upload to R2; images embed, anything else inserts
      // as a link (insertUploadedFiles). Only intercepts when a file is actually
      // present and an uploader is wired; everything else falls through to
      // normal (markdown) paste.
      handlePaste: (view, event) => {
        const upload = uploadRef.current;
        if (!upload) return false;
        const files = filesFrom(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertUploadedFiles(view, files, upload);
        return true;
      },
      handleDrop: (view, event) => {
        const setDropSelection = () => {
          const coords = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (coords) {
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, coords.pos)
              )
            );
          }
        };
        // A row dragged in from the Files panel: link the EXISTING attachment
        // where it lands — no re-upload, no raw URL text (Tyler, 2026-08-29).
        const existing = event.dataTransfer?.getData(FILE_DRAG_MIME);
        if (existing) {
          event.preventDefault();
          try {
            const { id, filename } = JSON.parse(existing) as FileDragPayload;
            if (typeof id !== "string" || !id) return true;
            setDropSelection();
            insertFileLink(view, String(filename ?? "file"), `/files/${id}`);
          } catch {
            // Malformed payload: swallow the drop rather than paste raw JSON.
          }
          return true;
        }
        const upload = uploadRef.current;
        if (!upload) return false;
        const files = filesFrom(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        setDropSelection();
        void insertUploadedFiles(view, files, upload);
        return true;
      },
    },
    // Backstop for the common ordering: seed the baseline with the canonical
    // serialization at creation. Under immediatelyRender:false the mount re-emit
    // can fire onUpdate *before* onCreate, so the null-guard below is what
    // actually catches it — this just keeps the baseline correct when onCreate
    // does win the race.
    onCreate: ({ editor }) => {
      if (lastEmitted.current === null) lastEmitted.current = editor.getMarkdown();
    },
    onUpdate: ({ editor }) => {
      const md = editor.getMarkdown();
      // First emission after mount establishes the baseline WITHOUT saving. Tiptap
      // re-serializes the loaded body once on mount (a programmatic transaction),
      // and that serialization is rarely byte-identical to the stored markdown — a
      // Notion import's `*`/`1)` bullets and double blanks round-trip to `-`/`1.`
      // and single blanks. Treating that first emit (or any emit equal to the
      // baseline) as a save is the "viewing an item marks it edited" bug: it
      // PATCHed a normalized body and bumped the edit date + burned a revision.
      // The user can't have edited before the editor mounted, so the first emit is
      // always this programmatic one — adopt it, don't persist it. A real edit
      // differs from the baseline and saves normally.
      if (lastEmitted.current === null || md === lastEmitted.current) {
        lastEmitted.current = md;
        return;
      }
      lastEmitted.current = md;
      onChangeRef.current(md);
    },
  });

  // Keep the toolbar's active states in sync with the cursor. useEditor alone
  // doesn't re-render React on a bare selection change (clicking into an H1
  // without typing), so reading editor.isActive() during render went stale
  // until the next keystroke — the "toolbar sometimes doesn't update / is
  // slow" symptom. useEditorState subscribes to the selection and re-renders
  // only when one of these derived values actually changes.
  const toolbar = useEditorState({
    editor,
    selector: ({ editor }) => ({
      isBold: editor?.isActive("bold") ?? false,
      isItalic: editor?.isActive("italic") ?? false,
      isUnderline: editor?.isActive("underline") ?? false,
      isStrike: editor?.isActive("strike") ?? false,
      isH1: editor?.isActive("heading", { level: 1 }) ?? false,
      isH2: editor?.isActive("heading", { level: 2 }) ?? false,
      isBulletList: editor?.isActive("bulletList") ?? false,
      isOrderedList: editor?.isActive("orderedList") ?? false,
      isTaskList: editor?.isActive("taskList") ?? false,
      isBlockquote: editor?.isActive("blockquote") ?? false,
      isCodeBlock: editor?.isActive("codeBlock") ?? false,
      isToggle: editor?.isActive("toggle") ?? false,
      isLink: editor?.isActive("link") ?? false,
      isComment: editor?.isActive("comment") ?? false,
      isSlide: editor?.isActive("slide") ?? false,
      // A comment needs something to anchor to, so the button is disabled on an
      // empty selection unless the caret is already inside one (then it edits).
      hasSelection: !(editor?.state.selection.empty ?? true),
      // Undo/redo depth comes from StarterKit's UndoRedo (prosemirror-history,
      // ~100 grouped steps back) — well past the "10 or 20" the toolbar buttons
      // need. can() tells us when the stack is empty so the button greys out.
      canUndo: editor?.can().undo() ?? false,
      canRedo: editor?.can().redo() ?? false,
      textColor: (editor?.getAttributes("textColor").color as string) || "",
      highlight: (editor?.getAttributes("highlight").color as string) || "",
    }),
  });

  // Safety net for the @-mention popup. It lives on document.body (outside
  // React), so if the editor unmounts mid-suggestion — e.g. navigating away
  // with the menu still open — Tiptap may not fire the suggestion's onExit and
  // the popup would strand on the page until a full refresh. Sweep any lingering
  // popup on unmount. (The suggestion also self-closes on click-away; this
  // covers the route-change path.)
  useEffect(() => {
    return () => {
      document
        .querySelectorAll(".ledgr-mention-popup, .ledgr-slash-popup")
        .forEach((n) => n.remove());
    };
  }, []);

  // Hand the editor up once it exists, for hosts that drive imperative inserts.
  useEffect(() => {
    if (editor && onEditorReady) onEditorReady(editor);
  }, [editor, onEditorReady]);

  // Imperative focus (title Enter → jump into the body): when the host bumps
  // focusSignal, move the caret to the start of the body. Guarded on a truthy
  // signal so the mount value (0) can't steal focus on a normal load; each later
  // increment focuses once. No-op on a locked/read-only editor.
  useEffect(() => {
    if (!editor || !focusSignal || !editable) return;
    editor.commands.focus("start");
  }, [editor, focusSignal, editable]);

  // Lock/unlock at runtime (the item lock toggle): a locked item drops
  // contenteditable so the cursor can't enter, and the toolbar hides below.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // Focus once on mount when the reading-first swap asked for it (the user
  // clicked/tapped into the body to edit). focus() with no arg restores the
  // default position rather than scrolling to the end of a long note.
  useEffect(() => {
    if (editor && autoFocus && editable) editor.commands.focus();
    // Mount-only: autoFocus never changes for a given mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Promote affordance (ADR-090): a checkbox line's "→ task" button fires a DOM
  // event carrying its position. Ensure the line has an ^id anchor, then open
  // the popup pre-filled with the line's text + sub-bullets (deterministic).
  useEffect(() => {
    if (!editor || !promoteToMeetingId) return;
    const dom = editor.view.dom;
    const handler = (e: Event) => {
      const pos = (e as CustomEvent<{ pos: number }>).detail?.pos;
      if (typeof pos !== "number") return;
      const id = ensureAnchorAtPos(editor, pos);
      if (!id) return;
      // The insert changed the doc; push it into the host's pending save so the
      // pre-promote flush (onRequestSave) persists the anchor.
      onChangeRef.current(editor.getMarkdown());
      const ex = extractPromotable(editor.getMarkdown(), id) ?? { title: "", body: "" };
      setPromote({ blockId: id, title: ex.title, body: ex.body });
    };
    dom.addEventListener(PROMOTE_LINE_EVENT, handler);
    return () => dom.removeEventListener(PROMOTE_LINE_EVENT, handler);
  }, [editor, promoteToMeetingId]);

  // Type-aware mention chips: resolve the type/icon/status for every mention in
  // the doc (a body-free batch GET /api/items?ids=) into the mention extension's
  // store, then repaint the chips. Runs once when the editor is ready and again,
  // debounced, after edits (so a freshly inserted or re-typed mention resolves).
  // Markdown stays the source of truth — nothing here is written back to it.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const resolve = async () => {
      const store = mentionStorage(editor) as MentionStorage | undefined;
      if (!store) return;
      // Fall back to the INCOMING body while the editor is still empty. The
      // editor is constructed with `content: ""` and the body arrives in a later
      // effect via setContent with emitUpdate:false (see below), so on mount this
      // ran against an empty doc, found no ids, and the "update" listener that
      // would retry never fired, because loading deliberately isn't an edit.
      // Every chip therefore wore the unresolved fallback glyph until the user
      // typed something, and wore it again on the next visit (Tyler, 2026-09-14).
      // The chips mount before this fetch returns either way; the rerender pass
      // below is what paints them, so reading the id set early is safe.
      const ids = collectMentionIdsFromMarkdown(
        editor.getMarkdown() || initialMarkdown
      );
      if (ids.length === 0) {
        store.resolved = new Map();
        store.ready = true;
        store.rerender.forEach((fn) => fn());
        return;
      }
      try {
        const res = await fetch(
          `/api/items?ids=${ids.map(encodeURIComponent).join(",")}`
        );
        if (!res.ok || cancelled) return;
        const { items } = (await res.json()) as { items: ResolvedMention[] };
        store.resolved = new Map(items.map((it) => [it.id, it]));
        store.ready = true;
        store.rerender.forEach((fn) => fn());
      } catch {
        // Leave chips on their last-known glyph; a later edit retries.
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void resolve(), 350);
    };
    void resolve();
    editor.on("update", schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      editor.off("update", schedule);
    };
    // initialMarkdown is a dependency so a host swapping in a different document
    // ("reload from saved") re-resolves its mentions too, for the same reason.
  }, [editor, initialMarkdown]);

  // A "✓ task" badge (or any deep link to a line) fires ledgr-open-item; navigate
  // there with the SPA router rather than a full reload.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const handler = (e: Event) => {
      const itemId = (e as CustomEvent<{ itemId: string }>).detail?.itemId;
      if (itemId) openItem(router, itemId);
    };
    dom.addEventListener(OPEN_ITEM_EVENT, handler);
    return () => dom.removeEventListener(OPEN_ITEM_EVENT, handler);
  }, [editor, router]);

  // Open the comment editor by clicking the comment's own card/icon (ADR-170).
  //
  // ONLY the card, never the anchored text: a click on the underlined phrase has
  // to stay an ordinary click (put the caret there and type), which it couldn't
  // while it also opened the editor — commented text was unclickable (Brandon,
  // 2026-07-30). The toolbar's Comment button still edits the comment the caret
  // sits in, so the keyboard path is unaffected.
  //
  // DOM-level, not a ProseMirror handler: the mark is non-inclusive and the card
  // is a widget at the run's end, so a position lookup there finds no mark. The
  // card suppresses mousedown (a click on it must not drag the selection out of
  // the comment it belongs to), so it hands over the run's start and we place the
  // caret there ourselves. It also hands over its own screen box, which is where
  // the panel opens — you edit the card where it sits.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onCardClick = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; note: string }>).detail;
      if (!d) return;
      const el = e.target as HTMLElement | null;
      const card = el?.getBoundingClientRect?.();
      // The card steps aside while its own note is open: the panel opens at the
      // card's box, so hiding it is what makes the note read as becoming an
      // editable field rather than getting covered by one. The rect is captured
      // first, and `visibility: hidden` keeps the box, so the position stays true.
      hideEditingCard(el ?? null);
      setCommentDraft({
        note: d.note,
        existing: true,
        at: d.from + 1,
        pos: card ? toWrapperPos(card, wrapRef.current) : null,
      });
    };
    dom.addEventListener(EDIT_COMMENT_EVENT, onCardClick);
    return () => dom.removeEventListener(EDIT_COMMENT_EVENT, onCardClick);
  }, [editor]);

  // Right-click a mention chip → the Send-to-Desk menu (S3b, ADR-146), with this
  // item as "current" so "Open beside" puts the host left and the mention right.
  // Desktop-only; otherwise the native context menu is left alone.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const handler = (e: MouseEvent) => {
      if (!deskSendAvailable()) return;
      const chip = (e.target as Element).closest?.(
        ".ledgr-mention[data-item-id]"
      ) as HTMLElement | null;
      const linkedId = chip?.dataset.itemId;
      if (!linkedId) return;
      e.preventDefault();
      openDeskSendMenu({
        itemId: linkedId,
        currentItemId: itemId,
        x: e.clientX,
        y: e.clientY,
      });
    };
    dom.addEventListener("contextmenu", handler);
    return () => dom.removeEventListener("contextmenu", handler);
  }, [editor, itemId]);

  // Deep link to a line (ADR-090): a #^id hash scrolls the editor to that line
  // and flashes it — on first mount (arriving from a copied link / a task's
  // source backlink) and on in-page hashchange. A short delay lets layout settle.
  useEffect(() => {
    if (!editor) return;
    const jump = () => {
      const m = /^#\^([a-z0-9]+)$/.exec(window.location.hash);
      if (m) window.setTimeout(() => scrollToBlockId(editor, m[1]), 80);
    };
    jump();
    window.addEventListener("hashchange", jump);
    return () => window.removeEventListener("hashchange", jump);
  }, [editor]);

  // Push the promoted-ref map into the plugin whenever it changes (e.g. after a
  // promotion refreshes the page) so the "✓ task" badge updates.
  useEffect(() => {
    if (editor) setPromotedRefs(editor, promotedRefs ?? {});
  }, [editor, promotedRefs]);

  // Loads the body into the editor. Runs once on mount (the editor starts empty,
  // see the `content: ""` note above) and again if the host swaps in a different
  // document (e.g. "reload from saved" on the scratch route). setContent on the
  // ready editor parses markdown correctly — including wrapping a standalone
  // inline image in a paragraph, which the constructor path gets wrong (ADR-159).
  // emitUpdate:false so this load never counts as a user edit; we then adopt the
  // canonical serialization as the save baseline so a later programmatic
  // re-serialize isn't mistaken for one either.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getMarkdown();
    if (current !== initialMarkdown) {
      editor.commands.setContent(initialMarkdown, {
        contentType: "markdown",
        emitUpdate: false,
      });
      lastEmitted.current = editor.getMarkdown();
    }
  }, [initialMarkdown, editor]);

  const [hiddenTb, setHiddenTb] = useState<Set<string>>(new Set());
  // Toggle-block creation gate (toolbar button + slash command). Default on;
  // the fetched setting narrows it. Held in state so the toolbar re-renders.
  const [toggleBlocksOn, setToggleBlocksOn] = useState(true);
  useEffect(() => {
    loadEditorSettings().then((s) => {
      setHiddenTb(new Set(s.hidden));
      setToggleBlocksOn(s.toggleBlocks);
      // Gate the "/toggle" slash entry (module-level flag) and switch heading
      // folding on/off in the plugin, now that the setting has resolved.
      setSlashToggleEnabled(s.toggleBlocks);
      if (editor) setHeadingsCollapsible(editor, s.collapsibleHeadings);
    });
  }, [editor]);
  // Register the "/file" slash command's picker for THIS editor instance (a
  // WeakMap entry in slash-suggestion, so it can't outlive the editor). Gated on
  // the uploader being wired, same as the toolbar's insert buttons. Keyed on
  // presence, not identity — hosts pass inline arrows that change every render.
  const hasUploader = !!uploadFile;
  useEffect(() => {
    if (!editor) return;
    setSlashFilePicker(
      editor,
      hasUploader ? () => anyFileInputRef.current?.click() : null
    );
    return () => setSlashFilePicker(editor, null);
  }, [editor, hasUploader]);
  // Scrub deleted files out of the live doc (see scrubDeletedFile above).
  useEffect(() => {
    if (!editor || !itemId) return;
    const onRemoved = (e: Event) => {
      const d = (e as CustomEvent<AttachmentRemovedDetail>).detail;
      if (d.itemId === itemId) scrubDeletedFile(editor, d.id);
    };
    window.addEventListener(ATTACHMENT_REMOVED_EVENT, onRemoved as EventListener);
    return () =>
      window.removeEventListener(ATTACHMENT_REMOVED_EVENT, onRemoved as EventListener);
  }, [editor, itemId]);
  const showTb = (id: string) => !hiddenTb.has(id);
  // Collapse is a DESKTOP affordance only (the toggle lives in BodyEditor's
  // mode-row). On mobile the toolbar floats over the keyboard and must always
  // show its buttons — collapsing it there would leave an empty bar (the mobile
  // regression this guards against). So below `sm`, buttons always render; on
  // desktop the controlled `toolbarOpen` decides, and when it's false the whole
  // bar renders nothing (no reserved strip).
  const isDesktop = useIsDesktop();
  const showToolbarButtons = toolbarOpen || !isDesktop;
  // The merged bar pins at the scroll container's top (its --nav-pt is 0 inside
  // the item modal; on a full page it clears the docked top nav). The mode-row
  // no longer stacks above it — the view controls ride the same row.
  // --item-chrome-h is the full-page item canvas's own sticky chrome row (trash ·
  // type · timestamps · ⋯), published by ItemCanvas; 0 everywhere else. Adding it
  // stacks this bar under that one instead of sliding over it.
  const stickyTop =
    "sm:top-[calc(var(--nav-pt,0px)_+_var(--item-chrome-h,0px))]";
  // Which color popover is open (text color / highlight), or null. Only one at a
  // time; a full-viewport backdrop closes it on an outside click.
  const [openSwatch, setOpenSwatch] = useState<null | "color" | "highlight">(null);

  // Mobile editing posture (≥640px / `sm` is desktop and unaffected). On a phone
  // the toolbar becomes a single-row bar that floats on top of the on-screen
  // keyboard while the editor is focused; `keyboardInset` is how far up from the
  // bottom edge to sit. While focused we also set body[data-editing] so the Work
  // nav pill (which lives at the same bottom-of-screen spot) hides — globals.css
  // owns that one rule, so the two bottom bars never overlap.
  const [focused, setFocused] = useState(false);
  const keyboardInset = useKeyboardInset();
  useEffect(() => {
    if (!editor) return;
    const onFocus = () => {
      setFocused(true);
      document.body.dataset.editing = "true";
    };
    const onBlur = () => {
      setFocused(false);
      delete document.body.dataset.editing;
    };
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
      delete document.body.dataset.editing;
    };
  }, [editor]);

  if (!editor || !toolbar) {
    return (
      <div className="px-4 py-3 text-sm text-neutral-400">Loading editor…</div>
    );
  }

  // Takes the wider HighlightColor because it shares `SwatchControl` with the
  // highlight picker. The accent is a highlight-only value, and that picker
  // renders its swatch only for kind === "highlight", so it can't arrive here;
  // the guard makes that explicit rather than silently setting a bad attribute.
  const setColor = (color: HighlightColor | null) => {
    if (color === ACCENT_HIGHLIGHT) return;
    const chain = editor.chain().focus();
    if (color) chain.setMark("textColor", { color }).run();
    else chain.unsetMark("textColor").run();
  };

  const setHighlight = (color: HighlightColor | null) => {
    const chain = editor.chain().focus();
    if (color) chain.setMark("highlight", { color }).run();
    else chain.unsetMark("highlight").run();
  };

  // Slide mark (ADR-176). A plain toggle, unlike the two controls above: the mark
  // has one state and no attributes, so there's nothing to pick. With a caret
  // (empty selection) inside an existing slide, extend to the whole mark first so
  // the toggle clears the entire span instead of setting a stored mark at the
  // cursor — the same trap the comment toolbar path hit (ADR-174).
  const toggleSlide = () => {
    const chain = editor.chain().focus();
    if (editor.isActive("slide") && editor.state.selection.empty) {
      chain.extendMarkRange("slide");
    }
    chain.toggleMark("slide").run();
  };

  // The two color controls (text color, highlight): a ghost button showing a
  // swatch of the current value that opens a popover of the 9 Notion colors
  // (ADR-155). Replaces the OS-native <select>s, which read as foreign chrome
  // in the toolbar. `hex` is the color's text stroke for the "color" kind and
  // its highlight fill for the "highlight" kind.
  // List nesting (the mobile Tab-key replacement). Bullet/ordered lists nest
  // their `listItem`; the GFM checklist nests `taskItem` (configured nested:true
  // above). Pick the node type from the active list so one pair of buttons
  // covers all three. Disabled outside a list (see `inList`).
  const inList =
    toolbar.isBulletList || toolbar.isOrderedList || toolbar.isTaskList;
  const indent = () =>
    toolbar.isTaskList
      ? editor.chain().focus().sinkListItem("taskItem").run()
      : editor.chain().focus().sinkListItem("listItem").run();
  const outdent = () =>
    toolbar.isTaskList
      ? editor.chain().focus().liftListItem("taskItem").run()
      : editor.chain().focus().liftListItem("listItem").run();

  // The popup owns the create now (it renders the ordinary task capture card, so
  // the line's shorthand is parsed like any typed capture). This still flushes
  // the body save first, so the line's ^id anchor is persisted before the task
  // points at it; the card refreshes on its own once the task lands, which is
  // what gives the promoted line its badge.
  const flushBeforePromote = async () => {
    await onRequestSaveRef.current?.();
  };

  // Open the hidden file picker behind the toolbar's Image button.
  const openImagePicker = () => fileInputRef.current?.click();
  // And the any-file one behind the Attach button + the "/file" slash command.
  const openFilePicker = () => anyFileInputRef.current?.click();

  // Open the hyperlink editor, prefilled with the current link's href if the
  // cursor sits inside one (so the button edits rather than stacks links).
  const openLinkEditor = () => {
    setLinkDraft((editor.getAttributes("link").href as string) || "");
  };

  // Apply the StarterKit Link mark from the editor's draft URL. With a selection
  // (or cursor already in a link) we mark that range; with an empty selection we
  // insert the URL as its own linked text. Bare domains get an https:// scheme.
  const applyLink = (raw: string) => {
    const url = raw.trim();
    setLinkDraft(null);
    if (!url) return;
    const href = /^(https?:|mailto:|tel:|ledgr:|\/|#)/i.test(url)
      ? url
      : `https://${url}`;
    if (editor.state.selection.empty && !editor.isActive("link")) {
      const from = editor.state.selection.from;
      editor
        .chain()
        .focus()
        .insertContent(url)
        .setTextSelection({ from, to: from + url.length })
        .setLink({ href })
        .setTextSelection(from + url.length)
        .unsetMark("link")
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  };

  const removeLink = () => {
    setLinkDraft(null);
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  };

  // Copy a deep link to the cursor's line (ADR-090): ensure that line has an ^id
  // anchor, then copy an absolute /items/<id>#^<id> URL. Works on any line/type.
  const copyLineLink = async () => {
    if (!itemId) return;
    const id = ensureAnchorAtSelection(editor);
    if (!id) return;
    // The insert (if any) changed the doc; feed the host's debounced save so the
    // anchor persists and the link resolves after navigation.
    onChangeRef.current(editor.getMarkdown());
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/items/${itemId}#^${id}`
      );
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      console.error("clipboard write failed");
    }
  };

  // Comment on the selection, or edit the comment the caret sits in (ADR-170).
  // The panel opens beside the text this is about (coordsAtPos), not at the top
  // of the editor: there's no margin card to aim at yet on the create path.
  const openCommentEditor = () => {
    const note = commentNoteAt(editor);
    let pos: { top: number; left: number } | null = null;
    try {
      const c = editor.view.coordsAtPos(editor.state.selection.to);
      pos = toWrapperPos({ top: c.bottom + 6, left: c.left }, wrapRef.current);
    } catch {
      /* no resolvable coords (an empty doc): fall back to the popup form */
    }
    setCommentDraft({
      note: note ?? "",
      existing: note !== null,
      // Editing: carry the caret as the position Save/Delete extend from, exactly
      // like the card path does. Without it, a caret (empty selection) inside a
      // comment would set a stored mark instead of rewriting the run — and on a
      // comment that bridges blocks, only the caret's own block would be rewritten.
      at: note !== null ? editor.state.selection.from : undefined,
      pos,
    });
  };

  const applyComment = (note: string, at?: number) => {
    closeCommentDraft();
    setComment(editor, note, at);
    // setMark leaves the doc changed; feed the host's debounced save so the
    // comment persists (the same reason copyLineLink does this).
    onChangeRef.current(editor.getMarkdown());
  };

  const deleteComment = (at?: number) => {
    closeCommentDraft();
    removeComment(editor, at);
    onChangeRef.current(editor.getMarkdown());
  };

  // Formatting buttons in visual groups (text · headings · lists · blocks ·
  // insert), each rendered as a cluster with a hairline between clusters, so the
  // long run of icons reads in chunks instead of one undifferentiated strip. A
  // group with every button hidden (per-button visibility / feature gates) drops
  // out, and its separator with it.
  // `keys` is the button's Tiptap keyboard shortcut, shown in its tooltip
  // (see @/lib/editor/shortcuts). It is display only: the binding itself lives
  // in the extension, so a button without one simply shows no shortcut.
  type Btn = { id: string; title: string; keys?: string; icon?: ReactNode; label?: string; active?: boolean; disabled?: boolean; when?: boolean; run: () => void };
  const groups: Btn[][] = [
    // Undo/redo lead the bar: leftmost is the one spot that stays visible on a
    // phone, where the bar scrolls sideways and there is no Ctrl+Z. One settings
    // id ("undo") hides the pair.
    [
      { id: "undo", title: "Undo", keys: "Mod-z", icon: TOOLBAR_ICONS.undo, disabled: !toolbar.canUndo, run: () => editor.chain().focus().undo().run() },
      { id: "undo", title: "Redo", keys: "Shift-Mod-z", icon: TOOLBAR_ICONS.redo, disabled: !toolbar.canRedo, run: () => editor.chain().focus().redo().run() },
    ],
    [
      { id: "bold", title: "Bold", keys: "Mod-b", icon: TOOLBAR_ICONS.bold, active: toolbar.isBold, run: () => editor.chain().focus().toggleBold().run() },
      { id: "italic", title: "Italic", keys: "Mod-i", icon: TOOLBAR_ICONS.italic, active: toolbar.isItalic, run: () => editor.chain().focus().toggleItalic().run() },
      { id: "underline", title: "Underline", keys: "Mod-u", icon: TOOLBAR_ICONS.underline, active: toolbar.isUnderline, run: () => editor.chain().focus().toggleUnderline().run() },
      { id: "strike", title: "Strikethrough", keys: "Mod-Shift-s", icon: TOOLBAR_ICONS.strike, active: toolbar.isStrike, run: () => editor.chain().focus().toggleStrike().run() },
    ],
    [
      { id: "h1", title: "Heading 1", keys: "Mod-Alt-1", label: "H1", active: toolbar.isH1, run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
      { id: "h2", title: "Heading 2", keys: "Mod-Alt-2", label: "H2", active: toolbar.isH2, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    ],
    [
      { id: "bulletList", title: "Bullet list", keys: "Mod-Shift-8", icon: TOOLBAR_ICONS.bulletList, active: toolbar.isBulletList, run: () => editor.chain().focus().toggleBulletList().run() },
      { id: "orderedList", title: "Numbered list", keys: "Mod-Shift-7", icon: TOOLBAR_ICONS.orderedList, active: toolbar.isOrderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
      { id: "tasks", title: "Checklist (- [ ])", keys: "Mod-Shift-9", icon: TOOLBAR_ICONS.tasks, active: toolbar.isTaskList, run: () => editor.chain().focus().toggleTaskList().run() },
      { id: "outdent", title: "Outdent (un-nest list item)", keys: "Shift-Tab", icon: TOOLBAR_ICONS.outdent, disabled: !inList, run: outdent },
      { id: "indent", title: "Indent (nest list item)", keys: "Tab", icon: TOOLBAR_ICONS.indent, disabled: !inList, run: indent },
    ],
    [
      { id: "quote", title: "Quote", keys: "Mod-Shift-b", icon: TOOLBAR_ICONS.quote, active: toolbar.isBlockquote, run: () => editor.chain().focus().toggleBlockquote().run() },
      { id: "code", title: "Code block", keys: "Mod-Alt-c", icon: TOOLBAR_ICONS.code, active: toolbar.isCodeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
      { id: "table", title: "Insert table", icon: TOOLBAR_ICONS.table, run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { id: "toggle", title: "Toggle (collapsible block; wraps the selection)", icon: TOOLBAR_ICONS.toggle, when: toggleBlocksOn, active: toolbar.isToggle, run: () => {
        const sel = editor.state.selection;
        if (!sel.empty && wrapSelectionInToggle(editor)) return;
        insertToggle(editor);
      } },
    ],
  ];
  const visibleGroups = groups
    .map((g) => g.filter((b) => showTb(b.id) && b.when !== false))
    .filter((g) => g.length > 0);
  // The insert cluster (image / link / line-link) is rendered explicitly rather
  // than in the data array: its handlers read a DOM ref (the file input) / the
  // clipboard, which the refs lint rule won't allow inside a mapped structure.
  const showImage = showTb("image") && !!uploadFile;
  const showAttach = showTb("attach") && !!uploadFile;
  const showWeblink = showTb("weblink");
  const showCopyLink = showTb("link") && !!itemId;
  const hasInsert = showImage || showAttach || showWeblink || showCopyLink;
  const showColor = showTb("color");
  const showHighlight = showTb("highlight");
  const showSlide = showTb("slide");
  const showComment = showTb("comment");
  const sep = <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />;

  // The formatting/merged bar. Built here (not inline in the return) so the
  // mobile-portal branch below can reference one element. On mobile the focused
  // bar is position:fixed to float above the keyboard; but a field-card canvas
  // (ADR-069) wraps the editor in react-grid-layout, whose CSS transform becomes
  // the containing block for fixed descendants — the bar would anchor to the
  // grid cell (deep in the doc, behind the keyboard). So it's portaled to <body>
  // to escape the transform. Desktop renders it inline (sticky), no portal.
  const formattingBar = (
      <div
        className={
          focused
            ? `fixed inset-x-0 z-50 border-t border-line bg-neutral-900/95 backdrop-blur sm:sticky sm:inset-x-auto ${stickyTop} sm:z-30 sm:border-t-0 sm:bg-surface-1 sm:backdrop-blur-none`
            : `hidden sm:sticky ${stickyTop} sm:z-30 sm:block sm:bg-surface-1`
        }
        style={focused && !isDesktop ? { bottom: keyboardInset } : undefined}
      >
      <div className="flex flex-nowrap items-center gap-0.5 overflow-x-auto overscroll-x-contain px-2 py-1.5 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:flex-wrap sm:overflow-visible">
        {showToolbarButtons && (
          <>
            {visibleGroups.map((g, gi) => (
              <div key={g[0].id} className="flex items-center gap-0.5">
                {gi > 0 && sep}
                {/* keyed by title, not id: undo/redo deliberately share one id
                    (one settings toggle hides the pair), so ids aren't unique. */}
                {g.map((b) => (
                  <ToolbarButton key={b.title} icon={b.icon} label={b.label} title={b.title} keys={b.keys} active={b.active} disabled={b.disabled} onClick={b.run} />
                ))}
              </div>
            ))}

            {hasInsert && (
              <div className="flex items-center gap-0.5">
                {visibleGroups.length > 0 && sep}
                {showImage && (
                  <ToolbarButton icon={TOOLBAR_ICONS.image} title="Insert image (or paste/drop one)" onClick={openImagePicker} />
                )}
                {showAttach && (
                  <ToolbarButton icon={TOOLBAR_ICONS.attach} title="Attach a file (uploads it and links it here — or paste/drop one, or type /file)" onClick={openFilePicker} />
                )}
                {showWeblink && (
                  <ToolbarButton icon={TOOLBAR_ICONS.weblink} title="Insert link" active={toolbar.isLink || linkDraft !== null} onClick={openLinkEditor} />
                )}
                {showCopyLink && (
                  <ToolbarButton icon={TOOLBAR_ICONS.link} title="Copy a link to this line (from the cursor)" active={linkCopied} onClick={() => void copyLineLink()} />
                )}
              </div>
            )}

            {(showColor || showHighlight || showSlide || showComment) && (
              <div className="flex items-center gap-0.5">
                {(visibleGroups.length > 0 || hasInsert) && sep}
                {showColor && (
                  <SwatchControl
                    kind="color"
                    current={toolbar.textColor}
                    onPick={setColor}
                    open={openSwatch === "color"}
                    onToggle={() => setOpenSwatch(openSwatch === "color" ? null : "color")}
                    isDesktop={isDesktop}
                  />
                )}
                {showHighlight && (
                  <SwatchControl
                    kind="highlight"
                    current={toolbar.highlight}
                    onPick={setHighlight}
                    open={openSwatch === "highlight"}
                    onToggle={() => setOpenSwatch(openSwatch === "highlight" ? null : "highlight")}
                    isDesktop={isDesktop}
                  />
                )}
                {showSlide && (
                  <ToolbarButton
                    icon={TOOLBAR_ICONS.slide}
                    title={
                      toolbar.isSlide
                        ? "Remove from the slides (Presentation Export)"
                        : "Put this on the screen — adds it to the slides (Presentation Export)"
                    }
                    active={toolbar.isSlide}
                    // Like a comment, a slide has to anchor to something. Unlike a
                    // comment it has no editor to reopen, so a caret inside one is
                    // enough to toggle it back off.
                    disabled={!toolbar.hasSelection && !toolbar.isSlide}
                    onClick={toggleSlide}
                  />
                )}
                {showComment && (
                  <ToolbarButton
                    icon={TOOLBAR_ICONS.comment}
                    title={
                      toolbar.isComment
                        ? "Edit this comment"
                        : "Comment on the selected text"
                    }
                    active={toolbar.isComment || commentDraft !== null}
                    // A comment has to anchor to something, so this needs either a
                    // selection or a caret already inside a comment to edit.
                    disabled={!toolbar.hasSelection && !toolbar.isComment}
                    onClick={openCommentEditor}
                  />
                )}
              </div>
            )}

            {showTb("mention") && (
              <span className="ml-2 text-xs text-ink-subtle">
                Type <kbd className="rounded bg-surface-2 px-1">@</kbd> to mention
              </span>
            )}
          </>
        )}

        {viewControls && (
          <div className="ml-auto hidden items-center gap-1 pl-2 sm:flex">
            {viewControls}
          </div>
        )}
      </div>
      </div>
  );

  return (
    // relative: the offset parent the comment popover positions against.
    // The closing rule is chrome for a full-height document body; a compact body
    // (task canvas, widget, dashboard embed) sits inline above other content, so
    // the rule just stacks another hairline into the pane (Tyler, 2026-08-14).
    <div ref={wrapRef} className={`relative${compact ? "" : " border-b border-line"}`}>
      {/* The formatting bar is hidden on a locked item (nothing here can act on a
          read-only document). On desktop it merges with the body's view-mode
          controls (viewControls, right-aligned) into one bar; when the collapse
          toggle has hidden the formatting buttons, the bar still renders so the
          toggle and view pill stay reachable. Desktop: sticky so it stays with a
          long note, opaque surface so scrolled text doesn't bleed through, pinned
          at --nav-pt (0 inside the item modal, top-nav height on a full page).
          Mobile: the formatting buttons float above the keyboard (fixed, bottom);
          the view controls live in a separate top row the host renders, so
          viewControls is desktop-only here. */}
      {editable && (showToolbarButtons || viewControls) &&
        (focused && !isDesktop
          ? createPortal(formattingBar, document.body)
          : formattingBar)}

      {/* Hyperlink editor: a one-line URL input below the toolbar, open while
          linkDraft is non-null. Enter applies, Escape cancels; Remove clears an
          existing link. Markdown round-trips the resulting [text](url). */}
      {editable && linkDraft !== null && (
        <div className="flex items-center gap-1.5 border-b border-line bg-surface-1 px-2 py-1.5">
          <input
            type="url"
            autoFocus
            value={linkDraft}
            placeholder="https://… (or paste a URL)"
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink(linkDraft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkDraft(null);
              }
            }}
            className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-500"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyLink(linkDraft)}
            className="rounded bg-neutral-700 px-2 py-1 text-sm font-medium text-neutral-100 hover:bg-neutral-600"
          >
            Apply
          </button>
          {toolbar.isLink && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={removeLink}
              className="rounded px-2 py-1 text-sm font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLinkDraft(null)}
            title="Cancel"
            aria-label="Cancel"
            className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            ✕
          </button>
        </div>
      )}

      <EditorContent editor={editor} />

      {/* Comment editor (ADR-170): the shared popover, open while commentDraft is
          non-null. On a wide screen it opens over the margin card, so you edit the
          comment where it sits; narrower, it's a popup over the text. ⌘/Ctrl+Enter
          saves, Escape cancels, Delete removes the comment and keeps the text it
          annotated (delete IS resolve, ADR-170). The note is markdown: **bold**,
          links, and [@Title](ledgr://item/<id>) mention chips all render wherever
          the body renders. */}
      {editable && commentDraft !== null && (
        <CommentPopover
          editable
          value={commentDraft.note}
          at={commentDraft.pos}
          canDelete={commentDraft.existing}
          onChange={(note) => setCommentDraft({ ...commentDraft, note })}
          onSave={() => applyComment(commentDraft.note, commentDraft.at)}
          onDelete={() => deleteComment(commentDraft.at)}
          onClose={closeCommentDraft}
          // Clicking away keeps what you typed (the panel floats over a document
          // you're meant to keep working in); an empty draft just closes, so a
          // stray click can't leave behind an empty comment.
          onDismiss={() =>
            commentDraft.note.trim()
              ? applyComment(commentDraft.note, commentDraft.at)
              : closeCommentDraft()
          }
        />
      )}

      {/* Hidden picker behind the toolbar's Image button (same R2 upload path
          as paste/drop). */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const upload = uploadRef.current;
          const files = Array.from(e.target.files ?? []).filter((f) =>
            f.type.startsWith("image/")
          );
          e.target.value = ""; // allow re-picking the same file
          if (upload && files.length) {
            editor.chain().focus().run();
            void insertUploadedFiles(editor.view, files, upload);
          }
        }}
      />

      {/* Hidden any-file picker behind the toolbar's Attach button and the
          "/file" slash command. Same upload path; non-images land as links. */}
      <input
        ref={anyFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const upload = uploadRef.current;
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // allow re-picking the same file
          if (upload && files.length) {
            editor.chain().focus().run();
            void insertUploadedFiles(editor.view, files, upload);
          }
        }}
      />

      {promote && (
        <PromoteLinePopup
          initialTitle={promote.title}
          initialBody={promote.body}
          meetingId={promoteToMeetingId!}
          blockRef={promote.blockId}
          onBeforeCreate={flushBeforePromote}
          onDone={() => {
            setPromote(null);
            router.refresh();
          }}
          onCancel={() => setPromote(null)}
        />
      )}
    </div>
  );
}
