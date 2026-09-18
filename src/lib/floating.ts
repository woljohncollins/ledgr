// One open floating panel at a time.
//
// The bug this fixes (Tyler, 2026-08-12, screenshot): the "@" / relate typeahead
// and the item "⋯" kebab were open SIMULTANEOUSLY and painted over each other
// with text bleeding through. Two causes, and this file is the second half of the
// fix. The first half is the layer scale in globals.css (both panels sat at z 50,
// one portaled to <body> and one in-page, so the winner was a stacking-context
// accident). But layering only decides which overlap looks better — the real
// problem is that two panels claiming the same corner of the screen were open at
// all. Nothing coordinated them, because each owns its own `open` state and its
// own outside-click listener, and an outside-click listener does not fire for a
// panel that opens without a click (the "@" popup opens from a KEYSTROKE).
//
// So: a panel announces itself when it opens, and every other open panel closes.
// A broadcast rather than a registry/context, because these panels are scattered
// across server-rendered trees with no common client ancestor to hold a provider,
// and one of them (the editor's mention popup) isn't a React component at all —
// it's imperative DOM inside a Tiptap plugin. A window event is the one channel
// all three shapes can already reach. Same idiom as the existing
// `window.dispatchEvent(new Event("ledgr:outbox"))`.
//
// Deliberately NOT covered: nested/child panels (a sub-popover inside a menu,
// like "Save as template" inside the kebab). Those are legitimately co-open, and
// they don't call this — only top-level surfaces do.
"use client";

const EVENT = "ledgr:floating-open";

// A per-surface identity so a panel ignores its own announcement (re-announcing
// on every keystroke must not close the panel doing the announcing).
export type FloatingId = string;

// Announce that `id` just opened. Every other open surface hears it and closes.
export function announceFloatingOpen(id: FloatingId): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FloatingId>(EVENT, { detail: id }));
}

// Listen for OTHER surfaces opening. Returns an unsubscribe fn. `onOther` fires
// only when a different id opened — never for `id` itself, so a surface can
// announce freely (on open, on re-anchor, on every repaint) without self-closing.
export function onOtherFloatingOpen(
  id: FloatingId,
  onOther: () => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const who = (e as CustomEvent<FloatingId>).detail;
    if (who !== id) onOther();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
