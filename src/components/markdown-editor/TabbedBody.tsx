// Canvas tabs (ADR-095): a thin client wrapper around the markdown editor that
// splits one item's body into named tabs (a strip across the top; the active
// chip is enlarged and doubles as the section header, double-click to rename it
// in place, drag to reorder). Tabs are sections of the SAME body
// (src/lib/editor/canvas-tabs.ts); this component only manages which section is
// shown and reassembles the whole body on save. The editor is unchanged — it's
// remounted per tab (via `key`) on a switch so it reloads that tab's content,
// and on each keystroke it's re-fed its own emitted markdown (a no-op guard in
// MarkdownEditor: getMarkdown() === initialMarkdown → no reset), so the cursor
// is never disturbed.
"use client";

import { useEffect, useState, type RefObject } from "react";
import LazyMarkdownEditor from "./LazyMarkdownEditor";
import ConfirmButton from "@/components/ui/ConfirmButton";
import type { PromotedRefs } from "./block-anchor-extension";
import {
  parseTabs,
  serializeTabs,
  type CanvasTab,
} from "@/lib/editor/canvas-tabs";
import { publishBodyMarkdown } from "@/lib/word-count";

export type TabbedBodyProps = {
  itemId: string;
  initialMarkdown: string;
  uploadFile: (file: File) => Promise<string>;
  // Receives the full reassembled body markdown (all tabs) to save.
  onChange: (markdown: string) => void;
  onRequestSave?: () => Promise<void>;
  promoteToMeetingId?: string;
  promotedRefs?: PromotedRefs;
  // Papers only: forwarded straight to the active tab's editor so `[^id]`
  // footnote markers survive a save (FootnoteMarkdownFix, extensions.ts).
  preserveFootnotes?: boolean;
  // When false (a locked item): the editor is read-only and the tab controls
  // (add / rename / delete) are hidden, so the body can't be restructured.
  editable?: boolean;
  // Formatting-bar visibility + sticky offset (S5), owned by BodyEditor's
  // mode-row and forwarded straight to the active tab's editor.
  toolbarOpen?: boolean;
  // The body's view-mode controls, forwarded straight to the active tab's editor
  // so they ride the right end of its formatting bar (desktop). See BodyEditor.
  viewControls?: React.ReactNode;
  // Desk panels (ADR-147 D5): when set, the active section is CONTROLLED by the
  // panel chrome (its merged sub-tab chips) and TabbedBody's own strip + title
  // input are hidden — section nav lives in the panel, not here. The index is
  // clamped to the parsed sections. Undefined = the normal full-canvas behavior
  // (internal strip, internal active state).
  controlledSection?: number;
  // Reading-first: forwarded to the per-tab editor so a tabbed note opens as
  // rendered HTML and mounts Tiptap only on edit (perceived speed).
  readingFirst?: boolean;
  // Follower mode (ADR-165, the Desk): re-parse the source's latest body into the
  // sections in place when it changes, so a mirror panel's active section updates
  // without a remount. Ignored on the sole-source editor (its sections are driven
  // by its own edits).
  follower?: boolean;
  // Imperative focus signal (title Enter → jump to the body): forwarded to the
  // active tab's editor.
  focusSignal?: number;
  // Add-tab affordance now lives in BodyEditor's controls row, not a standalone
  // line here (Brandon, 2026-07-20). We report whether tabs currently exist (so
  // BodyEditor shows its "+ tab" icon only when there are none) and expose our
  // addTab through this ref so that icon can trigger it.
  onTabsPresence?: (hasTabs: boolean) => void;
  addTabRef?: RefObject<(() => void) | null>;
};

export default function TabbedBody({
  itemId,
  initialMarkdown,
  uploadFile,
  onChange,
  onRequestSave,
  promoteToMeetingId,
  promotedRefs,
  preserveFootnotes = false,
  editable = true,
  controlledSection,
  readingFirst,
  follower = false,
  focusSignal,
  toolbarOpen,
  viewControls,
  onTabsPresence,
  addTabRef,
}: TabbedBodyProps) {
  const parsed = parseTabs(initialMarkdown);
  const [tabs, setTabs] = useState<CanvasTab[] | null>(parsed);
  const [untabbed, setUntabbed] = useState<string>(parsed ? "" : initialMarkdown);
  const [internalActive, setInternalActive] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Which chip is being inline-renamed (double-click). The active chip doubles as
  // the section header now that the standalone title heading is gone, so its name
  // is edited in place rather than in a separate field.
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);

  // Follower mode (ADR-165): re-derive the sections from the source's latest body
  // when it changes, so a mirror panel's active section updates in place. Done as
  // a render-time state adjustment (not an effect) so it doesn't cascade; uses
  // setTabs directly (not commitTabs) so it never publishes. Content-only edits
  // keep the section count stable, so the active editor is re-fed, not remounted.
  // Tracked for the source too (so becoming a follower later re-syncs cleanly),
  // but only APPLIED when following — the source's sections are its own edits.
  const [lastInitial, setLastInitial] = useState(initialMarkdown);
  if (initialMarkdown !== lastInitial) {
    setLastInitial(initialMarkdown);
    if (follower) {
      const next = parseTabs(initialMarkdown);
      setTabs(next);
      setUntabbed(next ? "" : initialMarkdown);
    }
  }

  // In the Desk the active section is controlled by the panel chrome; elsewhere
  // TabbedBody owns it. Either way the index is clamped to the parsed sections.
  const controlled = controlledSection !== undefined;
  const hideChrome = controlled;
  const active = controlled ? controlledSection : internalActive;
  // A controlled switch is owned by the parent; internal buttons still drive the
  // local state on the full canvas.
  const setActive = (i: number) => {
    if (!controlled) setInternalActive(i);
  };

  const activeIdx = tabs ? Math.min(active, tabs.length - 1) : 0;

  function commitTabs(next: CanvasTab[]) {
    setTabs(next);
    onChange(serializeTabs(next));
  }

  function onEditorChange(md: string) {
    if (tabs) {
      commitTabs(tabs.map((t, i) => (i === activeIdx ? { ...t, body: md } : t)));
    } else {
      setUntabbed(md);
      onChange(md);
    }
  }

  function addTab() {
    if (!tabs) {
      setActive(1);
      commitTabs([
        { title: "Tab 1", body: untabbed.trim() },
        { title: "Tab 2", body: "" },
      ]);
    } else {
      setActive(tabs.length);
      commitTabs([...tabs, { title: `Tab ${tabs.length + 1}`, body: "" }]);
    }
  }

  // Drag-reorder the strip: reordering the tabs array reassembles the body with
  // its sections in the new order (commitTabs → serializeTabs). The active index
  // is remapped so the same tab stays selected after the move.
  function reorderTabs(from: number, to: number) {
    if (!tabs || from === to) return;
    const next = [...tabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const a = activeIdx;
    if (a === from) setActive(to);
    else if (from < a && a <= to) setActive(a - 1);
    else if (to <= a && a < from) setActive(a + 1);
    commitTabs(next);
  }

  function renameTab(i: number, title: string) {
    if (!tabs) return;
    commitTabs(tabs.map((t, idx) => (idx === i ? { ...t, title } : t)));
  }

  function deleteTab(i: number) {
    if (!tabs) return;
    if (tabs.length <= 1) {
      // Removing the last tab reverts to a plain untabbed body (content kept).
      const kept = tabs[0]?.body ?? "";
      setActive(0);
      setUntabbed(kept);
      setTabs(null);
      onChange(kept);
    } else {
      const next = tabs.filter((_, idx) => idx !== i);
      setActive(Math.min(activeIdx, next.length - 1));
      commitTabs(next);
    }
  }

  const editorInitial = tabs ? (tabs[activeIdx]?.body ?? "") : untabbed;

  // Point BodyEditor's controls-row "+ tab" icon at our addTab (always the latest
  // closure), and tell it whether any tab exists so it can hide the icon once the
  // strip's own "+ New tab" takes over. The ref is written in a no-deps effect
  // (after commit, not during render) so it refreshes to the current addTab every
  // render — the icon only calls it in a click handler, well after commit.
  useEffect(() => {
    if (addTabRef) addTabRef.current = addTab;
  });
  useEffect(() => {
    onTabsPresence?.(tabs !== null);
  }, [tabs, onTabsPresence]);

  // Word count by tab (Tyler, 2026-09-02): while the body is tabbed, the chrome
  // counts the ACTIVE tab, not the whole document. Published after commit, so it
  // lands on top of ItemEditor's whole-body publish from the same change (last
  // publish wins in the store) and again on every tab switch. A follower (Desk
  // mirror) stays quiet so it can't fight the source editor over the count.
  // When the last tab is removed, tabs go null and ItemEditor's whole-body
  // publish for that change stands on its own.
  useEffect(() => {
    if (follower || !tabs) return;
    publishBodyMarkdown(itemId, tabs[activeIdx]?.body ?? "", { perTab: true });
  }, [tabs, activeIdx, itemId, follower]);

  return (
    <div>
      {hideChrome ? null : tabs ? (
        <div className="mb-2 flex flex-wrap items-center gap-1 border-b border-neutral-800 pb-2">
          {tabs.map((t, i) => {
            const isActive = i === activeIdx;
            const isRenaming = renamingIdx === i;
            return (
              <span
                key={i}
                draggable={editable && !isRenaming}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) reorderTabs(dragIndex, i);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                className={`group inline-flex items-center gap-1 rounded-md ${
                  editable && !isRenaming ? "cursor-grab active:cursor-grabbing" : ""
                } ${dragIndex === i ? "opacity-50" : ""} ${
                  isActive
                    ? "bg-neutral-800 px-3 py-1.5 text-base font-semibold text-neutral-100"
                    : "px-2.5 py-1 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                {isRenaming ? (
                  <input
                    type="text"
                    autoFocus
                    value={t.title}
                    onChange={(e) => renameTab(i, e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => setRenamingIdx(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape") {
                        e.preventDefault();
                        setRenamingIdx(null);
                      }
                    }}
                    placeholder="Tab title"
                    className="w-40 max-w-[14rem] bg-transparent text-base font-semibold text-neutral-100 outline-none placeholder:text-neutral-500"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setActive(i)}
                    onDoubleClick={() => {
                      if (!editable) return;
                      setActive(i);
                      setRenamingIdx(i);
                    }}
                    title={editable ? "Double-click to rename" : undefined}
                    className="max-w-[14rem] truncate"
                  >
                    {t.title.trim() || "Untitled"}
                  </button>
                )}
                {editable && !isRenaming && (
                  <ConfirmButton
                    onConfirm={() => deleteTab(i)}
                    title="Delete this tab?"
                    description={
                      tabs.length <= 1
                        ? "This removes the tabs; the content stays as a plain note."
                        : `"${t.title.trim() || "Untitled"}" and its content are removed.`
                    }
                    confirmLabel="Delete"
                    align="right"
                    trigger="×"
                    triggerLabel="Delete tab"
                    triggerClassName="leading-none text-neutral-600 opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
                  />
                )}
              </span>
            );
          })}
          {/* Farthest-right item in the strip, browser-style: add another tab. */}
          {editable && (
            <button
              type="button"
              onClick={addTab}
              className="ml-auto rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
            >
              + New tab
            </button>
          )}
        </div>
      ) : null}

      <LazyMarkdownEditor
        // Remount on tab switch / structural change so the editor reloads the
        // active tab's content; stable key when untabbed.
        key={tabs ? `tab-${activeIdx}-${tabs.length}` : "untabbed"}
        itemId={itemId}
        initialMarkdown={editorInitial}
        uploadFile={uploadFile}
        onChange={onEditorChange}
        promoteToMeetingId={promoteToMeetingId}
        promotedRefs={promotedRefs}
        onRequestSave={onRequestSave}
        editable={editable}
        readingFirst={readingFirst}
        focusSignal={focusSignal}
        toolbarOpen={toolbarOpen}
        viewControls={viewControls}
        preserveFootnotes={preserveFootnotes}
      />
    </div>
  );
}
