// The one always-visible autosave indicator for the item canvas (Brandon
// feedback, 2026-06-17). A fixed-position pill in the corner, so it stays put no
// matter where the title / body / a field card sits in the arranged layout
// (ADR-069). Subscribes to the app-wide save-status signal; renders nothing while
// idle, so it's invisible until something is actually saving or has just saved.
//
// It also owns the two cross-device edit affordances (ADR-134): the "conflict"
// banner (a body save was refused because the item changed elsewhere), and the
// refresh-on-focus check (when this tab regains focus, re-read the item's
// updated_at and, if it moved past what we last saw, offer to reload). Both live
// here because this is the one component mounted once per canvas, above every
// save surface.
"use client";

import { useEffect, useState } from "react";
import {
  consumeLocalSave,
  getKnownVersion,

  requestForceSave,
  requestSaveRetry,
  setKnownVersion,
  useSaveStatus,
} from "@/lib/save-status";

export default function SaveStatusIndicator({
  itemId,
  loadedAt,
}: {
  itemId: string;
  // The item's updated_at at load (ISO). Seeds the refresh-on-focus baseline.
  loadedAt: string;
}) {
  const state = useSaveStatus();
  const [stale, setStale] = useState(false);

  // Seed the shared focus baseline with what this page loaded.
  useEffect(() => {
    setKnownVersion(loadedAt);
  }, [loadedAt]);

  // Refresh-on-focus (ADR-134): when the tab becomes visible or the window
  // refocuses, re-read just the item's updated_at. If it moved past what we last
  // saw and the bump isn't one of our own saves, the item was edited on another
  // device — offer a reload. A single tiny request per refocus, gated on
  // visibility, so an idle background tab costs nothing.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/items/${itemId}/version`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const { updatedAt } = (await res.json()) as { updatedAt: string };
        const known = getKnownVersion();
        if (cancelled) return;
        if (!known || updatedAt === known) {
          consumeLocalSave();
          return;
        }
        // The server moved on. Our own save? (one happened since the last sync,
        // or one is in flight) — adopt it silently. Otherwise it's another
        // writer (another device, or Claude over MCP): adopt the new version so
        // we act once, not in a loop, then reconcile. Auto-swap when clean
        // (ADR-162): with no unsaved local edits there's nothing to lose, so
        // silently reload to show the new text — the fluid AI-editing loop. Only
        // when the owner has their own unsaved work do we stop and ask, so a
        // reload can't drop it.
        setKnownVersion(updatedAt);
        // Never reload the page on our own (2026-11-02): a full reload mid-work
        // is the "system goes away and comes back" John kept hitting, and a
        // field save that bumps updated_at without advancing knownVersion made
        // it fire on ordinary edits. Always offer the banner instead.
        if (!consumeLocalSave()) setStale(true);
      } catch {
        // A failed version check is non-fatal: leave the baseline as-is.
      }
    }
    void check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [itemId]);

  // A refused save (the item's body changed on another device). Outranks the
  // stale banner and the ordinary pills: a real lost-update risk, so it asks for
  // a decision rather than just informing.
  if (state === "conflict") {
    return (
      <div
        role="alert"
        className="fixed bottom-4 right-4 z-[60] flex max-w-xs flex-col gap-2 rounded-lg border border-amber-500 bg-amber-950/95 px-3 py-2 text-xs text-amber-100 shadow-lg backdrop-blur"
      >
        <span>
          This was edited on another device. Saving here will overwrite that
          change (it stays in revision history).
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => requestForceSave()}
            className="rounded border border-amber-400/60 bg-amber-900/60 px-2 py-1 font-medium hover:bg-amber-800"
          >
            Keep mine
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-amber-400/60 px-2 py-1 hover:bg-amber-900/60"
          >
            Reload
          </button>
        </span>
      </div>
    );
  }

  // Edited elsewhere while this tab sat open: informational, dismissible.
  if (stale) {
    return (
      <div
        role="status"
        className="fixed bottom-4 right-4 z-[60] flex max-w-xs items-center gap-2 rounded-lg border border-sky-600 bg-sky-950/95 px-3 py-2 text-xs text-sky-100 shadow-lg backdrop-blur"
      >
        <span>Updated on another device.</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded border border-sky-400/60 bg-sky-900/60 px-2 py-1 font-medium hover:bg-sky-800"
        >
          Reload
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setStale(false)}
          className="rounded px-1 py-1 text-sky-300 hover:text-sky-100"
        >
          ✕
        </button>
      </div>
    );
  }

  if (state === "idle") return null;
  // A failed save latches here; make it a button so the user can force an
  // immediate retry instead of waiting on the debounce (or typing again).
  if (state === "error") {
    return (
      <button
        type="button"
        onClick={() => requestSaveRetry()}
        aria-label="Save failed. Retry now."
        className="fixed bottom-4 right-4 z-[60] rounded-full border border-red-500 bg-red-950/90 px-3 py-1 text-xs text-red-200 shadow-lg backdrop-blur transition-colors hover:bg-red-900"
      >
        Save failed · Retry
      </button>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] rounded-full border border-neutral-700 bg-neutral-900/90 px-3 py-1 text-xs text-neutral-300 shadow-lg backdrop-blur transition-opacity"
    >
      {state === "saving" ? "Saving…" : "Saved"}
    </div>
  );
}
