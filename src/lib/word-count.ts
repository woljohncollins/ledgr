// The item canvas word count. Server-rendered from the stored body (so it's
// right the moment the page loads), then kept current by the body editor
// publishing its markdown as you type. Same module-singleton +
// useSyncExternalStore shape as save-status.ts, and for the same reason: the
// chrome that shows the count is server-rendered while the editor that knows the
// live text is a client island, with no common provider above them.
//
// Client-only (the hook): the counting function itself lives in body.ts so server
// components can render the at-load count without pulling React state in here.
import { useSyncExternalStore } from "react";
import { wordCountOf } from "@/lib/body";

// Trailing recount delay. The editor publishes on every keystroke; scanning a
// sermon-length body per character would be wasted work, and the count doesn't
// need to be instantaneous (Brandon, 2026-07-30).
const RECOUNT_MS = 800;

// Scoped by item id: a canvas modal open over an item page mounts a second
// chrome, and neither should show the other item's count. `perTab` marks a
// count that covers only the ACTIVE canvas tab (ADR-095) rather than the whole
// body — on a tabbed note the whole-document number is misleading when you're
// working in one tab (Tyler, 2026-09-02), so TabbedBody publishes the active
// section instead and the chrome labels it "this tab".
export type WordCountSnapshot = { itemId: string; count: number; perTab: boolean };
let current: WordCountSnapshot | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

// Publish the text to count. The whole-body editor calls this with the full
// markdown; TabbedBody calls it (after, in the same commit) with just the active
// tab's markdown and `perTab: true`. Last publish wins, so the tab-scoped count
// lands on top of the whole-body one.
export function publishBodyMarkdown(
  itemId: string,
  markdown: string,
  opts: { perTab?: boolean } = {}
) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    current = { itemId, count: wordCountOf(markdown), perTab: Boolean(opts.perTab) };
    for (const l of listeners) l();
  }, RECOUNT_MS);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// The snapshot is the published object (stable between publishes), not a derived
// value, so useSyncExternalStore stays happy.
function getSnapshot() {
  return current;
}

// The published count for an item, or null if nothing has been published for it
// yet (so the server-rendered count still stands). The hook reads the store
// directly; this is the same read for non-React callers and the verify script.
export function peekWordCount(itemId: string): number | null {
  return current && current.itemId === itemId ? current.count : null;
}

// Whether the published count for an item is tab-scoped (null = nothing
// published for it). For the verify script.
export function peekWordCountPerTab(itemId: string): boolean | null {
  return current && current.itemId === itemId ? current.perTab : null;
}

// `initial` is the server-rendered count (and whether it was tab-scoped); it
// stands until this item's editor has published something newer.
export function useWordCount(
  itemId: string,
  initial: number,
  initialPerTab = false
): { count: number; perTab: boolean } {
  const live = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return live && live.itemId === itemId
    ? { count: live.count, perTab: live.perTab }
    : { count: initial, perTab: initialPerTab };
}
