// "Learn more" affordance for the AI Memory setting (ADR-137): a small button
// that opens a modal explaining how AI Memory works and how to use it well. The
// write-up itself is the shared AiMemoryGuide (also on the Build → AI Memory
// page); this only owns the trigger + the modal chrome + a copy button for the
// instruction stanza. Self-contained (the canvas Modal is item-specific).
"use client";

import { useEffect, useState } from "react";
import AiMemoryGuide, { MEMORY_INSTRUCTION_STANZA } from "@/components/memory/AiMemoryGuide";

export default function AiMemoryLearnMore() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const copyStanza = async () => {
    try {
      await navigator.clipboard.writeText(MEMORY_INSTRUCTION_STANZA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the pre block is selectable */
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-[var(--accent)] hover:underline"
      >
        Learn more
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 pb-3 pt-[calc(0.75rem+var(--safe-top))] sm:px-6 sm:py-8"
          role="dialog"
          aria-modal="true"
          aria-label="How AI Memory works"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-[var(--background)] shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-800 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-neutral-100">How AI Memory works</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={copyStanza}
                  className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  {copied ? "Copied" : "Copy instruction"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  title="Close (Esc)"
                  className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto px-4 py-4">
              <AiMemoryGuide />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
