"use client";

// The under-title Overview (Tyler, 2026-08-17): it shows only when the owner
// has written something. Empty, it collapses to a small lines glyph (the same
// affordance as the task card's description icon) that expands the editor for
// typing; written, the text renders inline-editable with the toolbar appearing
// on focus. Same editor the old Overview card mounted, so nothing about how
// the body saves changed — only when it takes up space.
import { useState } from "react";
import ItemEditor from "@/components/markdown-editor/ItemEditor";

export default function HeaderOverview({
  itemId,
  body,
  hasContent,
}: {
  itemId: string;
  body: unknown;
  hasContent: boolean;
}) {
  const [open, setOpen] = useState(hasContent);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add an overview"
        title="Add an overview"
        className="rounded p-1 text-neutral-600 transition-colors hover:bg-neutral-800/60 hover:text-neutral-300"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M4 11h16M4 16h9" />
        </svg>
      </button>
    );
  }

  return (
    <ItemEditor
      item={{ id: itemId, title: "", body: body as never }}
      slot="body"
      collapsibleToolbar
      compactBody
    />
  );
}
