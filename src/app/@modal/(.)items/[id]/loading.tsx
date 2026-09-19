// Modal item skeleton (UX pass): on a soft nav from a list, the intercepted
// modal route renders ItemCanvas, which awaits the DB. Without this the modal
// slot stayed empty until the round trip, so a tapped row gave no feedback.
// This is a static mirror of Modal's chrome (no client handlers — it's a brief
// fallback the real Modal replaces); the skeleton fills the panel instantly.
export default function ItemModalLoading() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 pb-6 pt-[calc(1.5rem+var(--safe-top))] sm:px-6 sm:py-12"
      aria-hidden
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-[var(--background)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-end gap-1 px-3 pt-2">
          <span className="px-2 py-0.5 text-xs text-ink-faint">⤢ Expand</span>
          <span className="px-2 py-0.5 text-xs text-ink-faint">✕</span>
        </div>
        <div className="min-h-0 overflow-y-auto pb-12">
          <div className="mx-auto w-full max-w-3xl px-12 pt-8">
            <div className="h-9 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="mt-5 flex flex-wrap gap-3">
              <div className="h-5 w-20 animate-pulse rounded bg-surface-1" />
              <div className="h-5 w-24 animate-pulse rounded bg-surface-1" />
            </div>
            <div className="mt-8 space-y-3">
              <div className="h-4 w-full animate-pulse rounded bg-surface-1" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-surface-1" />
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only">Loading item…</span>
    </div>
  );
}
