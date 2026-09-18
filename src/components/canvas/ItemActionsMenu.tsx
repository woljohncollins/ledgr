// The item's "⋯" actions menu (top-right of the canvas, in both the modal
// header and the full-page chrome). It gathers the actions that used to sit
// loose in the chrome — Save as template, Apply template, Customize layout —
// behind one kebab so they collapse on mobile, and adds the lock toggle.
//
// Lock state lives in items.properties.locked (a per-key merge via
// propertyPatch, so it never clobbers a sibling property). A locked item's
// title, body, field strip, and properties all render read-only; the canvas
// reads the same flag and threads `locked` down to them.
"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAnchoredPanel } from "@/components/ui/Popover";
import SaveAsTemplateButton from "./SaveAsTemplateButton";
import ApplyTemplateButton from "./ApplyTemplateButton";
import ChangeTypeDialog from "./ChangeTypeDialog";
import ActionGlyph from "./action-icons";
import WordCount from "./WordCount";
import MoveUnderMenu from "@/components/items/MoveUnderMenu";
import { announceFloatingOpen, onOtherFloatingOpen } from "@/lib/floating";

const rowClass =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800";

export default function ItemActionsMenu({
  itemId,
  type,
  title,
  locked,
  favorited,
  createdLabel,
  updatedLabel,
  wordCount,
  wordCountPerTab = false,
  wordCountLive = true,
  listen = false,
}: {
  itemId: string;
  type: string;
  title: string;
  locked: boolean;
  favorited: boolean;
  // Chrome info shown at the top of the open menu (page canvas only). On mobile
  // this is where Created/Updated live, since the top-right chrome hides them for
  // width; word count sits alongside. Omitted by the modal peek.
  createdLabel?: string;
  updatedLabel?: string;
  wordCount?: number;
  // The server count covers only the first canvas tab (tabbed body, ADR-095).
  wordCountPerTab?: boolean;
  // false = the count is a composed-document snapshot (widget-home records),
  // not the live body — see WordCount's `live` prop.
  wordCountLive?: boolean;
  // Whether this item's type has Listen (read-aloud) turned on (Build → Types).
  // The menu stays dumb: a click just dispatches a window event; ListenBar
  // (mounted once per item in ItemCanvas) owns the Edge-redirect-or-play logic.
  listen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [changeTypeOpen, setChangeTypeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Optimistic star state so the menu reflects the toggle instantly; the server
  // is the source of truth and a refresh re-syncs it.
  const [fav, setFav] = useState(favorited);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Both panels are PORTALED and viewport-clamped (Tyler, 2026-09-11): anchored
  // `absolute right-0` they hung off the bottom of the window on short screens
  // and the lower actions simply could not be reached — the same failure the
  // color swatch panel had, and the same fix. `useAnchoredPanel` is the
  // placement half of ui/Popover, exported for exactly this: it clamps both
  // horizontal edges and flips above the trigger when below is cramped.
  const { anchorRef: menuAnchorRef, coords: menuCoords } =
    useAnchoredPanel<HTMLDivElement>(open, 224, "right");
  const { anchorRef: moveAnchorRef, coords: moveCoords } =
    useAnchoredPanel<HTMLDivElement>(moveOpen, 288, "right");
  // A portaled panel is not inside wrapRef, so the outside-click test has to
  // know about it or every click inside the menu would close the menu.
  const menuRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<HTMLDivElement>(null);

  // Announce this menu when it opens, and stand down when another floating panel
  // opens. The case that needed it: the "@" typeahead opens from a KEYSTROKE, so
  // the outside-click listener below never fires and both stayed open, overlapping
  // (Tyler's screenshot). Sub-popovers inside this menu don't announce, so "Save
  // as template" still opens without closing its own parent.
  useEffect(() => {
    if (!open && !moveOpen) return;
    announceFloatingOpen("item-actions");
    return onOtherFloatingOpen("item-actions", () => {
      setOpen(false);
      setMoveOpen(false);
    });
  }, [open, moveOpen]);

  useEffect(() => {
    if (!open && !moveOpen) return;
    function onDocClick(e: MouseEvent) {
      // Sub-popovers (Save as template, Make subtask of…) and the Apply modal
      // render inside this wrapper, so clicks in them keep it open; an outside
      // click closes both the menu and the move popover.
      const t = e.target as Node;
      if (
        !wrapRef.current?.contains(t) &&
        !menuRef.current?.contains(t) &&
        !moveRef.current?.contains(t)
      ) {
        setOpen(false);
        setMoveOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault(); // close the menu, not the parent modal underneath
        setOpen(false);
        setMoveOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, moveOpen]);

  // Re-adopt the server value if a refresh changes it (adjust-during-render).
  const [prevFav, setPrevFav] = useState(favorited);
  if (favorited !== prevFav) {
    setPrevFav(favorited);
    setFav(favorited);
  }

  // Star/unstar this item (the owner's favorites list lives in settings, not on
  // the item). Optimistic; reverts on failure. The flyout reads the same list,
  // so a refresh keeps the nav in sync.
  async function toggleFavorite() {
    if (busy) return;
    const next = !fav;
    setBusy(true);
    setFav(next);
    try {
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, favorite: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setOpen(false);
      router.refresh();
    } catch {
      setFav(!next); // revert
    } finally {
      setBusy(false);
    }
  }

  // Flip items.properties.locked via a per-key merge, then refresh so the canvas
  // re-renders read-only (or editable again). Leaves the menu open on failure so
  // a transient error can be retried.
  async function toggleLock() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyPatch: { locked: !locked } }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setOpen(false);
      router.refresh();
    } catch {
      // keep the menu open; the toggle can be retried
    } finally {
      setBusy(false);
    }
  }

  // Reparent this item under a picked target (or send it to the top level),
  // via the same cycle-guarded PATCH parentId the bulk Move… uses.
  async function makeSubtaskOf(parentId: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMoveOpen(false);
      router.refresh();
    } catch {
      // keep the popover open so a rejected move (e.g. a cycle) can be retried
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        menuAnchorRef.current = el;
        moveAnchorRef.current = el;
      }}
      className="relative inline-block"
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Item actions"
        title="More actions"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-2 py-0.5 text-base leading-none text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
      >
        ⋯
      </button>
      {open && menuCoords && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: "fixed",
            left: menuCoords.left,
            top: menuCoords.top,
            bottom: menuCoords.bottom,
            width: 224,
            maxHeight: menuCoords.maxHeight,
          }}
          className="z-[60] overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl shadow-black/50"
        >
          {(createdLabel || updatedLabel || wordCount !== undefined) && (
            <>
              <div className="px-2 py-1.5 text-xs text-neutral-500">
                {createdLabel && <div>Created {createdLabel}</div>}
                {updatedLabel && <div>Updated {updatedLabel}</div>}
                {wordCount !== undefined && (
                  <div>
                    <WordCount
                      itemId={itemId}
                      initial={wordCount}
                      initialPerTab={wordCountPerTab}
                      live={wordCountLive}
                    />
                  </div>
                )}
              </div>
              <div className="my-1 h-px bg-neutral-800" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void toggleFavorite()}
            disabled={busy}
            className={`${rowClass} disabled:opacity-50`}
          >
            <ActionGlyph
              icon={fav ? "starFilled" : "starOutline"}
              className={fav ? "text-[var(--accent)]" : undefined}
            />
            {fav ? "Remove from favorites" : "Add to favorites"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void toggleLock()}
            disabled={busy}
            className={`${rowClass} disabled:opacity-50`}
          >
            <ActionGlyph icon={locked ? "lockOpen" : "lockClosed"} />
            {locked ? "Unlock item" : "Lock item"}
          </button>
          {/* Hard nav (plain <a>) so ?arrange=1 escapes the intercept modal. */}
          <a role="menuitem" href={`/items/${itemId}?arrange=1`} className={rowClass}>
            <ActionGlyph icon="grid" />
            Customize layout
          </a>
          {/* Related Explorer (ADR-127 Phase 2): the always-available entry to
              the score-sorted neighborhood map, reachable even when the Discover
              panel auto-hid. */}
          <a role="menuitem" href={`/items/${itemId}/explore`} className={rowClass}>
            <ActionGlyph icon="network" />
            Explore related
          </a>
          {/* The canonical body as plain markdown, with a copy button (Tyler,
              2026-08-12). Reachable on EVERY type, not just bespoke ones: the
              need is sharpest on a song (the chord canvas shows a rendering, not
              the text) but "let me see and take the whole thing" is universal.
              Hard nav so it escapes the intercept modal, like Customize layout. */}
          <a role="menuitem" href={`/items/${itemId}/markdown`} className={rowClass}>
            <ActionGlyph icon="markdown" />
            View full markdown
          </a>
          {listen && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("ledgr:listen"));
                setOpen(false);
              }}
              className={rowClass}
            >
              <ActionGlyph icon="speaker" />
              Listen
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setChangeTypeOpen(true);
              setOpen(false);
            }}
            className={rowClass}
          >
            <ActionGlyph icon="swap" />
            Change type…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoveOpen(true);
              setOpen(false);
            }}
            className={rowClass}
          >
            <ActionGlyph icon="subtask" />
            Make subtask of…
          </button>
          <div className="my-1 h-px bg-neutral-800" />
          <SaveAsTemplateButton
            itemId={itemId}
            defaultName={title || "Untitled"}
            align="right"
            triggerClassName={rowClass}
            leading={<ActionGlyph icon="templateSave" />}
          />
          <ApplyTemplateButton
            itemId={itemId}
            type={type}
            triggerClassName={rowClass}
            leading={<ActionGlyph icon="templateApply" />}
          />
        </div>,
        document.body
      )}
      {/* The reparent popover, anchored under the kebab. Rendered outside the
          {open} block so choosing "Make subtask of…" (which closes the menu)
          keeps the picker mounted. Portaled + clamped like the menu above. */}
      {moveOpen && moveCoords && createPortal(
        <div
          ref={moveRef}
          style={{
            position: "fixed",
            left: moveCoords.left,
            top: moveCoords.top,
            bottom: moveCoords.bottom,
            width: 288,
            maxHeight: moveCoords.maxHeight,
          }}
          className="z-[60] overflow-y-auto overflow-x-hidden rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-xl shadow-black/50"
        >
          {/* Empty className, not omitted: MoveUnderMenu's DEFAULT_CLASS carries
              its own absolute positioning and card chrome, which would fight the
              portaled wrapper that now owns both. */}
          <MoveUnderMenu
            busy={busy}
            onPick={(parentId) => void makeSubtaskOf(parentId)}
            className=""
            placeholder="Search a task or project…"
            topLevelLabel="Move to top level"
          />
        </div>,
        document.body
      )}
      {/* Rendered outside the {open} block so closing the menu doesn't unmount
          the dialog mid-move. */}
      {changeTypeOpen && (
        <ChangeTypeDialog
          itemId={itemId}
          currentType={type}
          onClose={() => setChangeTypeOpen(false)}
        />
      )}
    </div>
  );
}
