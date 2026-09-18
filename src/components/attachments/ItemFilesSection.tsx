// The per-item Files section (ADR-237 addendum 2/3): a collapsible
// canvas-section like Export & sharing and Version History, rendered ONLY when
// the item actually has files. Client-side and event-fed, because the footer
// is server-rendered and an editor upload doesn't refresh the route — without
// this, a first upload's Files section only appeared after a reload (Tyler,
// 2026-08-29). uploadAttachment announces adds; FilePanel announces removes;
// this listens and keeps the list (and the summary count) live.
"use client";

import { useEffect, useState } from "react";
import FilePanel, { type FileRow } from "@/components/attachments/FilePanel";
import {
  ATTACHMENT_ADDED_EVENT,
  ATTACHMENT_REMOVED_EVENT,
  type AttachmentAddedDetail,
  type AttachmentRemovedDetail,
} from "@/components/attachments/upload";

export default function ItemFilesSection({
  itemId,
  initial,
  bare = false,
  column = true,
}: {
  itemId: string;
  initial: FileRow[];
  // The arrange-grid "Files" card (MarkdownCanvas) and the task canvas's
  // footer: the host already provides the header/placement, so render just the
  // live panel. (It used to render even when empty; it no longer does — see
  // below.)
  bare?: boolean;
  // Keep the collapsible section, drop the centered reading column — for a host
  // that already has its own width, like the task canvas's 248px rail.
  column?: boolean;
}) {
  const [rows, setRows] = useState<FileRow[]>(initial);

  useEffect(() => {
    const onAdd = (e: Event) => {
      const d = (e as CustomEvent<AttachmentAddedDetail>).detail;
      if (d.itemId !== itemId) return;
      setRows((prev) =>
        prev.some((r) => r.id === d.id)
          ? prev
          : [
              ...prev,
              {
                id: d.id,
                filename: d.filename,
                contentType: d.contentType,
                sizeBytes: d.sizeBytes,
                // Freshly uploaded — whether the body links it isn't knowable
                // client-side, so no chip until the next server render.
                referenced: undefined,
              },
            ]
      );
    };
    const onRemove = (e: Event) => {
      const d = (e as CustomEvent<AttachmentRemovedDetail>).detail;
      if (d.itemId !== itemId) return;
      setRows((prev) => prev.filter((r) => r.id !== d.id));
    };
    window.addEventListener(ATTACHMENT_ADDED_EVENT, onAdd as EventListener);
    window.addEventListener(ATTACHMENT_REMOVED_EVENT, onRemove as EventListener);
    return () => {
      window.removeEventListener(ATTACHMENT_ADDED_EVENT, onAdd as EventListener);
      window.removeEventListener(ATTACHMENT_REMOVED_EVENT, onRemove as EventListener);
    };
  }, [itemId]);

  // Nothing to show costs nothing (Tyler, 2026-09-11): an item with no files
  // renders no Files UI at all, in EVERY mode. `bare` used to mean "render even
  // when empty" for the arrange-grid card, which is how a "No files yet." line
  // plus an upload button ended up sitting under items that had never had a
  // file. The grid card simply collapses instead, and the section reappears the
  // moment an upload event arrives (the listener above stays mounted).
  if (rows.length === 0) return null;
  if (bare) {
    return (
      <FilePanel
        key={rows.map((r) => r.id).join(",")}
        itemId={itemId}
        initial={rows}
      />
    );
  }
  const section = (
    <details className={`canvas-section ${column ? "" : "canvas-section-bare"}`}>
        {/* Same summary shape as Discover related: label + the count chip. */}
        <summary className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cs-label)] hover:text-neutral-300">
          <span>Files</span>
          <span className="canvas-section-count">{rows.length}</span>
        </summary>
        <div className="mt-2">
          {/* Keyed on the row set so an event-driven change re-seeds FilePanel's
              own optimistic state instead of fighting it. */}
          <FilePanel key={rows.map((r) => r.id).join(",")} itemId={itemId} initial={rows} />
        </div>
    </details>
  );
  return column ? (
    <div className="canvas-section-wrap mx-auto w-full max-w-3xl px-2 sm:px-8 md:px-12">
      {section}
    </div>
  ) : (
    section
  );
}
