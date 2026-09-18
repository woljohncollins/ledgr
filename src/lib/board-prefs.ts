// Per-board UI preference: which kanban columns are collapsed to a rail.
//
// The terminal columns (Done, and anything in the archived bucket) collapse by
// DEFAULT — a board should read as live work, so finished projects shouldn't eat
// a full column's width on arrival. They're never hidden: the rail still shows
// the label and the count, still expands on a tap, and still accepts a dropped
// card, so dragging a project onto a collapsed Done column completes it exactly
// as an expanded one would. (Same stance as the Linked here panel's hidden
// done rows and the dashboard tree's hideCompletedChildren.)
//
// Persistence is per board, not global: collapsing Done on the Projects board
// sticks for that board while every other board keeps its own defaults.
// localStorage, not a server setting — a tiny view preference, single user, and
// it wants to be instant.
//
// Exposed as a useSyncExternalStore hook, mirroring related-prefs.ts: the server
// snapshot is the caller's DEFAULT, so SSR and the first client paint agree and
// there's no hydration mismatch; the persisted value takes over after mount.
// Unlike related-prefs the stored map is tri-state — a key is present only when
// the owner has overridden that column's default, absent means "use the
// default" — because here the default differs per column (terminal columns start
// collapsed, the rest start open) and a presence-only map couldn't express both.
import { useSyncExternalStore } from "react";

const KEY = "ledgr.board.collapsed-columns.v1";
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function read(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? (obj as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota or privacy mode: a lost view preference is harmless */
  }
}

// One column's slot in the stored map. `boardKey` scopes to a board (a saved
// view's id, else the type key), `col` is the group value (a status key).
function slot(boardKey: string, col: string): string {
  return `${boardKey}:${col}`;
}

export function setColumnCollapsed(
  boardKey: string,
  col: string,
  value: boolean,
  defaultCollapsed: boolean
): void {
  const map = read();
  const k = slot(boardKey, col);
  // Returning a column to its default DROPS the key rather than storing the
  // default again, so the map holds only real overrides and can't accrete an
  // entry for every column of every board the owner has ever opened.
  if (value === defaultCollapsed) delete map[k];
  else map[k] = value;
  write(map);
  emit();
}

export function useColumnCollapsed(
  boardKey: string,
  col: string,
  defaultCollapsed: boolean
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const v = read()[slot(boardKey, col)];
      return typeof v === "boolean" ? v : defaultCollapsed;
    },
    () => defaultCollapsed
  );
}
