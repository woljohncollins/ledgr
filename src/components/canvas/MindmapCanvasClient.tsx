// Client half of the mindmap canvas (Mindmap module). Owns the tree, the computed
// left-to-right layout, in-place editing, and autosave. The map is a view over
// one markdown nested list (PRD §3): every edit re-serializes the tree to the
// `{format:"markdown"}` body and patches it, so the body stays canonical and the
// standard markdown/OneDrive export emits the `.md` for free.
//
// Editing model is a familiar outliner: Enter adds a sibling, Tab indents
// (demote under the previous spoke), Shift+Tab outdents, Backspace on an empty
// node deletes it. Hover actions (+ spoke, + sibling, ×) and a collapse chevron
// cover the same moves by mouse. Node positions are computed, never stored
// (PRD §7) — collapse state is view-only and not serialized.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bodyMarkdown, makeMarkdownBody } from "@/lib/body";
import { useItemAutosave } from "@/components/chord-editor/useItemAutosave";
import { LAYOUT_PAD, NODE_H, NODE_W, layoutMindmap } from "@/lib/mindmap/layout";
import {
  addChild,
  addSibling,
  countNodes,
  indentNode,
  neighborAfterRemove,
  outdentNode,
  parseMindmap,
  removeNode,
  serializeMindmap,
  toggleCollapse,
  updateText,
  type MindNode,
} from "@/lib/mindmap/tree";

type Props = { itemId: string; initialTitle: string; initialBody: unknown };

const STATUS: Record<string, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Save failed, retrying",
};

// Canvas-chrome glyphs (SVG, never emoji — house rule). A chevron disclosure for
// collapse/expand (the file-tree standard; the old +/− read as add/delete), plus
// + and × for the add/delete affordances.
const ICON = {
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
};

function Glyph({ d, size = 12 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: `<path d="${d}"/>` }}
    />
  );
}

export default function MindmapCanvasClient({ itemId, initialTitle, initialBody }: Props) {
  const [root, setRoot] = useState<MindNode>(() =>
    parseMindmap(bodyMarkdown(initialBody), initialTitle)
  );
  const [copied, setCopied] = useState(false);
  const { patch, saveState } = useItemAutosave(itemId);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  // Hover-intent for the node action buttons (Tyler, 2026-08-17): pure
  // :hover made the +/× vanish the instant the cursor slipped off the node,
  // so the buttons were often unreachable (especially the delete ×). Leaving a
  // node now starts a short grace timer before the buttons hide; re-entering
  // the node OR any of its buttons (they're DOM children) cancels it.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverNode = (id: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoveredId(id);
  };
  const unhoverNode = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoveredId(null), 400);
  };
  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);
  // The node to focus once the next tree render commits (a created/moved node).
  // A ref, not state, so setting it never triggers an extra render — the focus
  // happens in the effect that runs after `root` re-renders.
  const pendingFocus = useRef<string | null>(null);

  const layout = useMemo(() => layoutMindmap(root), [root]);

  // Persist a new tree: re-serialize to the markdown body. Editing the center
  // node also renames the item (it IS the title), so its heading and the item
  // title stay one and the same.
  const commit = (next: MindNode, opts?: { titleFromRoot?: boolean }) => {
    setRoot(next);
    const body = makeMarkdownBody(serializeMindmap(next));
    patch(opts?.titleFromRoot ? { title: next.text, body } : { body });
  };

  // Focus (and select) a node's input after a structural op creates or moves it.
  // Runs after each tree render; clears the ref so it fires once per op.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const el = inputs.current.get(id);
    if (el) {
      el.focus();
      el.select();
    }
  }, [root]);

  const onText = (id: string, text: string) => {
    const next = updateText(root, id, text);
    setRoot(next);
    const body = makeMarkdownBody(serializeMindmap(next));
    patch(id === root.id ? { title: text, body } : { body });
  };

  const onEnter = (id: string) => {
    // The center node has no sibling slot — Enter sprouts its first spoke.
    if (id === root.id) {
      const [next, created] = addChild(root, id);
      commit(next);
      pendingFocus.current = created;
      return;
    }
    const [next, created] = addSibling(root, id);
    commit(next);
    pendingFocus.current = created;
  };

  const onAddChild = (id: string) => {
    const [next, created] = addChild(root, id);
    commit(next);
    pendingFocus.current = created;
  };

  // Add a sibling above ("before") or below ("after") — the up/down hover
  // affordances. The center node has no siblings, so it's a no-op there.
  const onAddSibling = (id: string, pos: "before" | "after") => {
    if (id === root.id) return;
    const [next, created] = addSibling(root, id, pos);
    commit(next);
    pendingFocus.current = created;
  };

  const onIndent = (id: string) => {
    const [next] = indentNode(root, id);
    commit(next);
    pendingFocus.current = id; // id is stable across the move — keep focus on it
  };

  const onOutdent = (id: string) => {
    const [next] = outdentNode(root, id);
    commit(next);
    pendingFocus.current = id;
  };

  const onDelete = (id: string) => {
    if (id === root.id) return; // the center node is never deleted
    const focusTo = neighborAfterRemove(root, id);
    const next = removeNode(root, id);
    commit(next);
    if (focusTo) pendingFocus.current = focusTo;
  };

  const onCollapse = (id: string) => commit(toggleCollapse(root, id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, id: string, text: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter(id);
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      onIndent(id);
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      onOutdent(id);
    } else if (e.key === "Backspace" && text === "" && id !== root.id) {
      e.preventDefault();
      onDelete(id);
    }
  };

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(serializeMindmap(root));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const downloadMarkdown = () => {
    const url = URL.createObjectURL(
      new Blob([serializeMindmap(root)], { type: "text/markdown" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(root.text || "mindmap").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const total = countNodes(root);

  return (
    <div className="w-full">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-6 pt-4">
        <span className="text-xs text-neutral-500">
          {total} {total === 1 ? "node" : "nodes"}
        </span>
        <span className={`text-xs ${saveState === "error" ? "text-red-400" : "text-neutral-500"}`}>
          {STATUS[saveState]}
        </span>
        <button
          onClick={() => void copyMarkdown()}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
          title="Copy the mindmap as a markdown nested list"
        >
          {copied ? "Copied ✓" : "Copy as markdown"}
        </button>
        <button
          onClick={downloadMarkdown}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
          title="Download the mindmap as a .md file"
        >
          Download .md
        </button>
        <span className="ml-auto text-xs text-neutral-600">
          Hover a node to add a spoke or sibling · Enter: sibling · Tab: indent · Shift+Tab: outdent · Backspace: delete empty
        </span>
      </div>

      <div className="mx-auto mt-3 w-full max-w-6xl overflow-auto px-6 pb-6">
        <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: "100%" }}>
          {/* Connector layer: a path from each parent's right edge to the child's
              left edge. Behind the node boxes. */}
          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={layout.width}
            height={layout.height}
          >
            {layout.nodes.map((n) => {
              if (!n.parentId) return null;
              const p = layout.byId.get(n.parentId);
              if (!p) return null;
              // Left-side children connect parent's LEFT edge → child's RIGHT
              // edge (mirrored); right-side is the original right→left.
              const onLeft = n.side === "left";
              const px = onLeft ? p.x + LAYOUT_PAD : p.x + LAYOUT_PAD + NODE_W;
              const py = p.y + LAYOUT_PAD + NODE_H / 2;
              const cx = onLeft ? n.x + LAYOUT_PAD + NODE_W : n.x + LAYOUT_PAD;
              const cy = n.y + LAYOUT_PAD + NODE_H / 2;
              const mid = (cx - px) / 2;
              return (
                <path
                  key={n.id}
                  d={`M ${px} ${py} C ${px + mid} ${py}, ${cx - mid} ${cy}, ${cx} ${cy}`}
                  fill="none"
                  stroke="rgb(82 82 91)"
                  strokeWidth={1.5}
                />
              );
            })}
          </svg>

          {layout.nodes.map((n) => {
            const isRoot = !n.parentId;
            const onLeft = n.side === "left";
            // Outward = away from the root, where this node's children fan out.
            // Buttons are hidden until the node is hovered/focused and sit FLUSH
            // against the node edge (no dead gap to cross, so hover never drops
            // before you reach them).
            const outward = onLeft ? "right-full" : "left-full";
            const inward = onLeft ? "left-full" : "right-full";
            // Shown by the hover-intent state (grace period), not raw :hover —
            // keyboard focus still reveals them via group-focus-within.
            const shown = hoveredId === n.id ? "flex" : "hidden group-focus-within:flex";
            const addBtn =
              `${shown} absolute z-10 h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-400 shadow-md shadow-black/40 hover:border-[var(--accent)] hover:text-neutral-100`;
            return (
              <div
                key={n.id}
                className="group absolute flex items-center"
                style={{
                  left: n.x + LAYOUT_PAD,
                  top: n.y + LAYOUT_PAD,
                  width: NODE_W,
                  height: NODE_H,
                  flexDirection: onLeft ? "row-reverse" : "row",
                }}
                onMouseEnter={() => hoverNode(n.id)}
                onMouseLeave={unhoverNode}
              >
                {n.hasChildren && (
                  <button
                    onClick={() => onCollapse(n.id)}
                    className={`${onLeft ? "ml-1" : "mr-1"} flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200`}
                    title={n.collapsed ? "Expand branch" : "Collapse branch"}
                  >
                    <Glyph d={n.collapsed ? ICON.chevronRight : ICON.chevronDown} />
                  </button>
                )}
                <input
                  ref={(el) => {
                    if (el) inputs.current.set(n.id, el);
                    else inputs.current.delete(n.id);
                  }}
                  value={n.text}
                  onChange={(e) => onText(n.id, e.target.value)}
                  onKeyDown={(e) => onKeyDown(e, n.id, n.text)}
                  placeholder={isRoot ? "Central idea" : "…"}
                  className={`h-full min-w-0 flex-1 rounded-md border bg-neutral-900 px-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[var(--accent)] ${
                    isRoot
                      ? "border-neutral-600 font-medium"
                      : "border-neutral-800 hover:border-neutral-700"
                  }`}
                />
                {/* Add a spoke (outward, in this branch's direction). */}
                <button
                  onClick={() => onAddChild(n.id)}
                  className={`${addBtn} top-1/2 -translate-y-1/2 ${outward}`}
                  title="Add a spoke"
                >
                  <Glyph d={ICON.plus} />
                </button>
                {/* The root can grow both ways, so it also offers a spoke on the
                    opposite side. */}
                {isRoot && (
                  <button
                    onClick={() => onAddChild(n.id)}
                    className={`${addBtn} top-1/2 -translate-y-1/2 ${inward}`}
                    title="Add a spoke"
                  >
                    <Glyph d={ICON.plus} />
                  </button>
                )}
                {!isRoot && (
                  <>
                    {/* Sibling above / below — the up & down directions. */}
                    <button
                      onClick={() => onAddSibling(n.id, "before")}
                      className={`${addBtn} bottom-full left-1/2 -translate-x-1/2`}
                      title="Add a sibling above"
                    >
                      <Glyph d={ICON.plus} />
                    </button>
                    <button
                      onClick={() => onAddSibling(n.id, "after")}
                      className={`${addBtn} top-full left-1/2 -translate-x-1/2`}
                      title="Add a sibling below"
                    >
                      <Glyph d={ICON.plus} />
                    </button>
                    {/* Delete — flush on the inward edge (toward the root),
                        vertically centered, away from the add cluster. It used
                        to sit diagonally off the corner, where the only path to
                        it left the hover zone and the button vanished mid-reach
                        (Tyler, 2026-08-17); flush + the grace timer fix that. */}
                    <button
                      onClick={() => onDelete(n.id)}
                      className={`${shown} absolute z-10 top-1/2 -translate-y-1/2 ${inward} h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-500 shadow-md shadow-black/40 hover:border-red-700 hover:text-red-400`}
                      title="Delete this spoke and everything under it"
                    >
                      <Glyph d={ICON.close} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
