// Editor-side block anchors (ADR-090). Over the trailing "^id" markers the pure
// helpers (src/lib/editor/block-anchor.ts) define, this extension:
//   1. dims every marker in the doc so it's near-invisible while editing
//      (Obsidian's reading-view feel) without removing it from the markdown;
//   2. on a checkbox line, shows either a "→ task" promote button (fires a
//      `ledgr-promote-line` event) OR, if that line is already promoted, a
//      "✓ task" badge linking to the task (fires `ledgr-open-item`) — so a line
//      can't be double-promoted and reading the notes shows what's been promoted;
//   3. ensureAnchorAtPos / ensureAnchorAtSelection — give a line a stable id
//      (the seat for a back-reference / deep link); scrollToBlockId jumps to one
//      and flashes it via a plugin-managed decoration (a manual class would be
//      wiped by the next ProseMirror re-render).
// The promoted-ref map and the flash target live in PLUGIN STATE (pushed in by a
// meta transaction), not a render-time ref, so the decorations always read fresh
// values and the badge updates after a promotion without re-creating the editor.
// The markdown stays the source of truth: the marker is real text in the body
// (markdownToHtml strips it for clean share/print).
"use client";

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blockIdOf, trailingAnchor, uniqueBlockId } from "@/lib/editor/block-anchor";

// A blockRef → its promoted task. Drives the "✓ task" badge.
export type PromotedRef = { id: string; title: string };
export type PromotedRefs = Record<string, PromotedRef>;

type BlockAnchorState = { flashId: string | null; promotedRefs: PromotedRefs };

const blockAnchorKey = new PluginKey<BlockAnchorState>("blockAnchor");

// DOM events the editor host (MarkdownEditor) listens for on the editor root.
export const PROMOTE_LINE_EVENT = "ledgr-promote-line"; // {pos}: open the promote popup
export const OPEN_ITEM_EVENT = "ledgr-open-item"; // {itemId}: SPA-navigate to an item

export interface BlockAnchorOptions {
  // Whether to render the per-line "→ task" promote affordance (meetings only).
  promote: boolean;
}

function promoteButton(pos: number): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "promote-line-btn";
  btn.textContent = "→ task";
  btn.title = "Promote this action item to a task";
  btn.contentEditable = "false";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.dispatchEvent(
      new CustomEvent(PROMOTE_LINE_EVENT, { detail: { pos }, bubbles: true })
    );
  });
  return btn;
}

function promotedBadge(ref: PromotedRef): HTMLButtonElement {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "promoted-line-badge";
  badge.textContent = "✓ task";
  badge.title = ref.title ? `Promoted: ${ref.title}` : "Open the task";
  badge.contentEditable = "false";
  badge.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    badge.dispatchEvent(
      new CustomEvent(OPEN_ITEM_EVENT, { detail: { itemId: ref.id }, bubbles: true })
    );
  });
  return badge;
}

// Dim markers; on each checkbox line a badge (already promoted) or promote button
// (when `promote` is on); and a node-level flash on the deep-link target line.
function buildDecorations(
  doc: PMNode,
  promote: boolean,
  refs: PromotedRefs,
  flashId: string | null
): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const id = blockIdOf(node.textContent);
      const t = trailingAnchor(node.textContent);
      if (t) {
        const end = pos + node.nodeSize - 1;
        decos.push(
          Decoration.inline(end - t.markerLength, end, { class: "block-anchor-marker" })
        );
      }
      if (flashId && id === flashId) {
        decos.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "block-anchor-flash" })
        );
      }
      return false; // a textblock's children are inline; nothing to recurse into
    }
    if (node.type.name === "taskItem" && node.firstChild) {
      // End of the item's first paragraph — resolves INTO that paragraph (a
      // textblock), which ensureAnchorAtPos needs.
      const paraEnd = pos + 1 + node.firstChild.nodeSize - 1;
      const id = blockIdOf(node.firstChild.textContent);
      const ref = id ? refs[id] : undefined;
      if (ref) {
        decos.push(
          Decoration.widget(paraEnd, () => promotedBadge(ref), {
            side: 1,
            ignoreSelection: true,
            key: `badge-${id}`,
          })
        );
      } else if (promote) {
        decos.push(
          Decoration.widget(paraEnd, () => promoteButton(paraEnd), {
            side: 1,
            ignoreSelection: true,
            key: `promote-${paraEnd}`,
          })
        );
      }
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export const BlockAnchor = Extension.create<BlockAnchorOptions>({
  name: "blockAnchor",
  addOptions() {
    return { promote: false };
  },
  addProseMirrorPlugins() {
    const promote = this.options.promote;
    return [
      new Plugin<BlockAnchorState>({
        key: blockAnchorKey,
        state: {
          init: () => ({ flashId: null, promotedRefs: {} }),
          apply(tr, value) {
            const meta = tr.getMeta(blockAnchorKey) as Partial<BlockAnchorState> | undefined;
            if (meta && typeof meta === "object") {
              return {
                flashId: "flashId" in meta ? meta.flashId ?? null : value.flashId,
                promotedRefs: meta.promotedRefs ?? value.promotedRefs,
              };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const s = blockAnchorKey.getState(state);
            return buildDecorations(
              state.doc,
              promote,
              s?.promotedRefs ?? {},
              s?.flashId ?? null
            );
          },
        },
      }),
    ];
  },
});

// Push the latest promoted-ref map into plugin state (the badge reads from there).
// The host calls this whenever the map changes — after a promotion refreshes it.
export function setPromotedRefs(editor: Editor, refs: PromotedRefs): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(blockAnchorKey, { promotedRefs: refs }));
}

// Ensure the textblock at `pos` carries an anchor; return its id (existing or
// freshly appended, unique within the document). null if pos isn't in a textblock.
export function ensureAnchorAtPos(editor: Editor, pos: number): string | null {
  const size = editor.state.doc.content.size;
  const $pos = editor.state.doc.resolve(Math.max(0, Math.min(pos, size)));
  const block = $pos.parent;
  if (!block.isTextblock) return null;
  const existing = blockIdOf(block.textContent);
  if (existing) return existing;
  const id = uniqueBlockId(editor.getMarkdown());
  // updateSelection:false — the caret must NOT follow the anchor to the end of
  // the line. It did, and on a line ending in an "@mention" that dropped the
  // cursor inside the mention token, waking the editor's mention autocomplete
  // right on top of the promote popup (a stray click then created a junk item
  // named after the anchor). The anchor is bookkeeping; it shouldn't move the
  // user's cursor at all.
  editor
    .chain()
    .insertContentAt($pos.end(), ` ^${id}`, { updateSelection: false })
    .run();
  return id;
}

// Same, anchored at the current selection (the toolbar "copy link" / keyboard path).
export function ensureAnchorAtSelection(editor: Editor): string | null {
  return ensureAnchorAtPos(editor, editor.state.selection.from);
}

// Scroll the editor to the line carrying `id` and flash it (a plugin decoration,
// so a transaction can't wipe it). Returns false if no line has that anchor.
export function scrollToBlockId(editor: Editor, id: string): boolean {
  let target: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.isTextblock && blockIdOf(node.textContent) === id) {
      target = pos;
      return false;
    }
    return true;
  });
  if (target === null) return false;
  const dom = editor.view.nodeDOM(target) as HTMLElement | null;
  if (dom?.scrollIntoView) dom.scrollIntoView({ behavior: "smooth", block: "center" });
  editor.view.dispatch(editor.state.tr.setMeta(blockAnchorKey, { flashId: id }));
  window.setTimeout(() => {
    if (!editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(blockAnchorKey, { flashId: null }));
    }
  }, 1600);
  return true;
}
