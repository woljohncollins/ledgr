// A tiny app-wide save-status signal (Brandon feedback, 2026-06-17). The item
// canvas autosaves from many independent surfaces — the title, the body editor,
// each field strip, each custom property, each relation field — and with the
// field-level grid (ADR-069) those surfaces are scattered across the layout, so
// a per-component "Saved" badge is easy to lose track of. This module is the one
// place they all report into, so a single floating SaveStatusIndicator can always
// show the current state.
//
// A module-level singleton (not React context) on purpose: it has to span both
// the classic stacked canvas (where the panels are server-rendered straight into
// the page) and the grid (where they're nodes inside the client grid), with no
// common client provider above them. Components import beginSave/endSave; the
// indicator subscribes via useSaveStatus.
import { useSyncExternalStore } from "react";

// "conflict" (ADR-134) latches when a body save is refused because the item
// changed on another device; it outranks the ordinary states in the snapshot
// and clears when the next save succeeds (the user resolved it) or on reload.
export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

let inFlight = 0;
let state: SaveState = "idle";
let conflicted = false;
let savedTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
// Editors register a flush here so the indicator's "Retry" can force an
// immediate re-save after a failure, instead of the user waiting on the
// debounce timer (or having to type again).
const retryListeners = new Set<() => void>();
// On a conflict the editor registers a "save mine anyway" flush here, so the
// banner's "Keep mine" can re-send the pending body without the guard token
// (overwriting the other device's change — an informed choice, and the
// clobbered version stays in revision history).
const forceSaveListeners = new Set<() => void>();
// Editors register a predicate reporting whether they hold unsaved edits (a
// queued patch or an in-flight save). The refresh-on-focus check (ADR-162)
// reads this to decide, when the item changed elsewhere, whether it's safe to
// silently reload (clean) or must ask first (dirty — reloading would drop the
// owner's own unsaved work).
const dirtyCheckers = new Set<() => boolean>();

// Refresh-on-focus baseline (ADR-134). knownVersion is the item updated_at the
// canvas last saw; the focus check compares the server's value to it.
// localSaveSinceSync absorbs the canvas's own writes — any successful save bumps
// updated_at, so without it a refocus right after editing would read our own
// change as "changed elsewhere". The indicator owns the comparison; this module
// just holds the shared baseline (one canvas, many independent save surfaces).
let knownVersion: string | null = null;
let localSaveSinceSync = false;

function emit() {
  for (const l of listeners) l();
}

// Call around every autosave request. endSave(false) latches an error until the
// next successful save clears it; a quiet period after the last save fades the
// "Saved" pill back to idle.
export function beginSave() {
  inFlight += 1;
  if (state !== "saving") {
    state = "saving";
    emit();
  }
}

export function endSave(ok: boolean) {
  inFlight = Math.max(0, inFlight - 1);
  if (!ok) {
    state = "error";
    emit();
    return;
  }
  // A successful save is our own write: mark it so the focus check treats the
  // resulting updated_at bump as local, and clear any latched conflict (whether
  // this was the "Keep mine" force-save or a later normal save, we're in sync).
  localSaveSinceSync = true;
  conflicted = false;
  if (inFlight === 0 && state !== "error") {
    state = "saved";
    emit();
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (inFlight === 0 && state === "saved") {
        state = "idle";
        emit();
      }
    }, 1600);
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// An editor registers its flush; the returned fn unregisters on unmount.
export function registerSaveRetry(fn: () => void): () => void {
  retryListeners.add(fn);
  return () => {
    retryListeners.delete(fn);
  };
}

// Fire every registered flush (the "Retry" affordance). Each editor flushes
// only its own pending patch, so this is safe with several editors mounted.
export function requestSaveRetry() {
  for (const fn of retryListeners) fn();
}

// Latch the cross-device conflict (ADR-134): a body save was refused (409). The
// indicator shows the "edited elsewhere" banner until a save succeeds or reload.
export function reportConflict() {
  conflicted = true;
  emit();
}

// The editor registers its force-flush (re-send the pending body without the
// guard token); the returned fn unregisters on unmount.
export function registerForceSave(fn: () => void): () => void {
  forceSaveListeners.add(fn);
  return () => {
    forceSaveListeners.delete(fn);
  };
}

// "Keep mine" — fire every registered force-flush.
export function requestForceSave() {
  for (const fn of forceSaveListeners) fn();
}

// Refresh-on-focus baseline accessors (ADR-134), used only by the indicator.
export function setKnownVersion(iso: string) {
  knownVersion = iso;
}
export function getKnownVersion(): string | null {
  return knownVersion;
}
// True (and resets) if the canvas saved since the last sync, or a save is still
// in flight — either way a fresh updated_at is our own work, not another device.
export function consumeLocalSave(): boolean {
  const had = localSaveSinceSync || inFlight > 0;
  localSaveSinceSync = false;
  return had;
}
// Clear the "we saved" flag WITHOUT consuming it (ADR-162). The body/title
// editor advances knownVersion to the server's returned updated_at on every
// successful save, so that write is already fully accounted for by knownVersion;
// leaving localSaveSinceSync set would make the NEXT genuinely-external change
// (e.g. an edit Claude made over MCP while the owner was in another tab) be
// misread as our own and silently swallowed. Editors that advance knownVersion
// call this right after a save; surfaces that bump updated_at without advancing
// knownVersion (field/property saves) keep relying on consumeLocalSave.
export function clearLocalSave() {
  localSaveSinceSync = false;
}

// An editor registers a predicate for "do I have unsaved edits?"; the returned
// fn unregisters on unmount.
export function registerDirtyCheck(fn: () => boolean): () => void {
  dirtyCheckers.add(fn);
  return () => {
    dirtyCheckers.delete(fn);
  };
}
// True if any mounted editor holds a queued or in-flight edit. Used by the
// refresh-on-focus check to choose reload-silently (clean) vs. ask (dirty).
export function hasPendingEdits(): boolean {
  for (const fn of dirtyCheckers) if (fn()) return true;
  return false;
}

// Resolve once no editor has a queued or in-flight save (or after timeoutMs).
// Used by the item popup's close (John, 2026-11-02: an edit made just before
// closing "does not show up and I need to redo it"): the close used to fire
// router.back() and three refreshes while the editor's unmount PATCH was still
// in flight, so the list underneath re-rendered from the pre-edit row. Now the
// popup flushes every editor, waits here, and only then navigates.
export function waitForSaves(timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if ((inFlight === 0 && !hasPendingEdits()) || Date.now() - started > timeoutMs) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

function getSnapshot() {
  return conflicted ? "conflict" : state;
}

export function useSaveStatus(): SaveState {
  return useSyncExternalStore(subscribe, getSnapshot, () => "idle");
}
