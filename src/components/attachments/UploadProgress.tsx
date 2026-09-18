// A single global upload indicator, mounted once in the root layout beside
// ActionToast and built on the same window-event trick (no dependency,
// Principle 5): uploadAttachment fires progress events from wherever it runs —
// the editor's paste/drop//file, the file panel, a widget card — and this
// component, living outside every list subtree, renders them as a small
// bottom-right stack with a real progress bar, surviving any router.refresh().
// Exists because a silent multi-second upload reads as "nothing happened"
// (Tyler, 2026-08-29).
"use client";

import { useEffect, useState } from "react";

export type UploadProgressPayload = {
  id: string;
  filename: string;
  // 0..1 through the PUT; a done/failed event removes the row (after a beat,
  // so a fast upload still visibly completes rather than flickering).
  fraction: number;
  done?: boolean;
};

const EVENT = "ledgr:upload-progress";
// Long enough that a small file's bar still registers as "something happened"
// rather than a flicker (Tyler, 2026-08-29).
const LINGER_MS = 1500;

// Fire from anywhere on the client (upload.ts). Safe on the server (no-op).
export function reportUploadProgress(payload: UploadProgressPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<UploadProgressPayload>(EVENT, { detail: payload }));
}

export default function UploadProgress() {
  const [jobs, setJobs] = useState<Map<string, UploadProgressPayload>>(new Map());

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent<UploadProgressPayload>).detail;
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(detail.id, detail);
        return next;
      });
      if (detail.done && !timers.has(detail.id)) {
        timers.set(
          detail.id,
          setTimeout(() => {
            timers.delete(detail.id);
            setJobs((prev) => {
              const next = new Map(prev);
              next.delete(detail.id);
              return next;
            });
          }, LINGER_MS)
        );
      }
    };
    window.addEventListener(EVENT, onProgress as EventListener);
    return () => {
      window.removeEventListener(EVENT, onProgress as EventListener);
      timers.forEach(clearTimeout);
    };
  }, []);

  if (jobs.size === 0) return null;
  return (
    // Top-center (Tyler, 2026-08-29 — after bottom-right, then bottom-center):
    // nothing else claims the top edge mid-typing, and on mobile the keyboard
    // owns the bottom half, so this is the spot a transient bar is actually seen.
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] mx-auto flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {[...jobs.values()].map((j) => {
        const pct = Math.round(j.fraction * 100);
        return (
          <div
            key={j.id}
            className="rounded-card border border-line-strong bg-surface-3 px-3 py-2 shadow-xl shadow-black/50"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-ink">
              <span className="truncate">{j.filename}</span>
              <span className="shrink-0 text-ink-subtle">
                {j.done ? "done" : `${pct}%`}
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-700/50">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
