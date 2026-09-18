// Copy-the-whole-body button for the full-markdown view (Tyler, 2026-08-12). A
// bespoke canvas (a song's chord chart, a paper workspace) renders its type's own
// shape, which is the point of bespoke-first — but it also means there is no
// surface showing the canonical markdown that IS the item (Principle: markdown is
// the source of truth, every other output is rendered from it). This is the
// "see it plainly / take it with me" escape hatch.
//
// navigator.clipboard needs a secure context; the textarea+execCommand fallback
// keeps it working over plain http on the LAN (how the phone reaches a dev box).
"use client";

import { useState } from "react";

export default function CopyMarkdownButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        // Off-screen but still focusable — execCommand needs a real selection.
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy refused");
      }
      setState("copied");
    } catch {
      setState("failed");
    }
    // Return to idle so the button stays usable for a second copy.
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-live="polite"
      className="rounded-card border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-3"
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed — select and copy"
          : "Copy markdown"}
    </button>
  );
}
