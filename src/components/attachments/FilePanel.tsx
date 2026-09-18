// The item's files, as a panel (Files as a first-class citizen, ADR-236): one
// row per attachment — filename opens the file in a new tab (/files/<id>; HTML
// and PDFs render, everything else downloads), Download saves it to disk under
// its real filename, Copy link yields a markdown link, Share copies a public
// link gated by the item's share token, and Delete removes it (ConfirmButton,
// the project standard). One component serves both homes: the `file` type's canvas
// (FileCanvas) and the Files record card (WidgetCanvas), so the two can't
// drift — the LinkList/MilestoneList pattern.
"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { attachmentUrl, attachmentUrlWithShare } from "@/lib/attachment-url";
import { showToast } from "@/components/ui/ActionToast";
import {
  announceAttachmentRemoved,
  uploadAttachment,
  FILE_DRAG_MIME,
  type FileDragPayload,
} from "@/components/attachments/upload";
import ConfirmButton from "@/components/ui/ConfirmButton";
import NavGlyph from "@/components/nav/NavGlyph";
import { formatBytes } from "@/lib/format-count";

export type FileRow = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // When present (the per-item Files section): does anything in the parent item
  // still point at this file? false renders the "not linked" chip; absent (the
  // file canvas / Files card, where the panel itself is the home) shows none.
  referenced?: boolean;
};


// Mint-or-reuse the ITEM's share token, then compose the file's public address
// (ADR-231: a token is scoped to the attachment's parent item, so when the item
// is the file — the `file` type — sharing the file and sharing the item are the
// same act; on a many-file item the same token opens its siblings too).
async function copyFileShareLink(itemId: string, attachmentId: string) {
  const listed = await fetch(`/api/items/${itemId}/share`);
  if (!listed.ok) throw new Error("couldn't read share links");
  const tokens: { token: string; revokedAt: string | null }[] =
    (await listed.json()).tokens ?? [];
  let token = tokens.find((t) => !t.revokedAt)?.token;
  if (!token) {
    const created = await fetch(`/api/items/${itemId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!created.ok) throw new Error("couldn't create a share link");
    token = (await created.json()).token as string;
  }
  await navigator.clipboard.writeText(
    `${window.location.origin}${attachmentUrlWithShare(attachmentId, token)}`
  );
}

// Save a file to disk under its real name (Tyler, 2026-09-12). Opening
// /files/<id> is a NAVIGATION to a 302 into R2, so `<a download>` is ignored
// (the attribute is same-origin only) and the browser renders whatever R2's
// content-type says it can render — a JSON backup or an image opens in a tab
// instead of landing in Downloads. So fetch the bytes and hand the blob to a
// synthetic link: the app server still never touches them (the fetch follows
// the redirect straight to R2, which allows GET from our origins —
// scripts/r2-cors.mjs), and the filename is ours to set.
async function downloadFile(id: string, filename: string) {
  const res = await fetch(attachmentUrl(id));
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: Safari needs the object URL to outlive the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function FilePanel({
  itemId,
  initial,
}: {
  itemId: string;
  initial: FileRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<FileRow[]>(initial);
  // Only the setter is read now: the "+ Add file" button that consumed `busy`
  // is gone (below), but the upload path still tracks in-flight state so
  // restoring the affordance needs no rewiring.
  const [, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        const up = await uploadAttachment(itemId, file);
        setRows((prev) => [
          ...prev,
          {
            id: up.id,
            filename: up.filename,
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          },
        ]);
      }
      router.refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`delete failed (${res.status})`);
    setRows((prev) => prev.filter((r) => r.id !== id));
    announceAttachmentRemoved({ itemId, id });
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {rows.map((f) => (
          // Wrapping row (Tyler, 2026-09-11): the name side and the action side
          // are two flex items, not six siblings, so the actions drop to their
          // own line intact when there isn't room beside the filename. The name
          // group asks for 12rem via `basis-48`; in a 248px host (the task rail)
          // the ~180px of buttons can't also fit, so they wrap — while a wide
          // host still renders the single line it always did. Before this, every
          // part competed for the same line: the filename collapsed to nothing
          // and the buttons pushed the panel into a horizontal scroll.
          <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
            <NavGlyph icon="document" size={14} className="shrink-0 text-ink-subtle" />
            <a
              href={attachmentUrl(f.id)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${f.filename} in a new tab — or drag it into the body to link it there`}
              className="truncate text-ink hover:text-[var(--accent)]"
              draggable
              // Dragging the row into the editor links the EXISTING file (the
              // editor reads FILE_DRAG_MIME); the text/plain fallback pastes
              // the markdown link anywhere else.
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  FILE_DRAG_MIME,
                  JSON.stringify({ id: f.id, filename: f.filename } satisfies FileDragPayload)
                );
                e.dataTransfer.setData(
                  "text/plain",
                  `[${f.filename.replace(/([[\]])/g, "\\$1")}](${attachmentUrl(f.id)})`
                );
              }}
            >
              {f.filename}
            </a>
            <span className="shrink-0 text-xs text-ink-faint">{formatBytes(f.sizeBytes)}</span>
            {f.referenced === false && (
              <span
                title="Nothing in this item's body or fields points at this file anymore. Copy link puts it back; it counts against your storage either way."
                className="shrink-0 cursor-help rounded-full border border-line px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-subtle"
              >
                not linked
              </span>
            )}
            </span>
            {/* Always visible, not hover-revealed: hover-only actions never show
                on touch and hid Delete from the first real user (Tyler,
                2026-08-29) — "scope the UI" (Brandon, 2026-06-21). */}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                title={`Download ${f.filename} to this device`}
                className="rounded px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                onClick={() =>
                  downloadFile(f.id, f.filename).catch(() => {
                    // Whatever blocked the blob (an offline tab, a CORS gap on
                    // a new origin), opening the file still works — say so
                    // rather than failing silently.
                    showToast("Couldn't download — opening it instead");
                    window.open(attachmentUrl(f.id), "_blank", "noopener");
                  })
                }
              >
                Download
              </button>
              <button
                type="button"
                title="Copy a markdown link to this file — paste it anywhere in a body"
                className="rounded px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                onClick={() =>
                  navigator.clipboard
                    .writeText(`[${f.filename.replace(/([[\]])/g, "\\$1")}](${attachmentUrl(f.id)})`)
                    .then(() => showToast("Markdown link copied — paste it into a body"))
                    .catch(() => showToast("Couldn't copy the link"))
                }
              >
                Copy link
              </button>
              <button
                type="button"
                title="Copy a public link to this file (anyone with the link can open it — it also unlocks this item's share page and its other files)"
                className="rounded px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                onClick={() =>
                  copyFileShareLink(itemId, f.id)
                    .then(() => showToast("Public file link copied"))
                    .catch(() => showToast("Couldn't copy a share link"))
                }
              >
                Share
              </button>
              <ConfirmButton
                title="Delete this file?"
                description="Deletes it from storage for good — links to it stop working."
                confirmLabel="Delete"
                trigger={<span aria-hidden>Delete</span>}
                triggerLabel={`Delete ${f.filename}`}
                triggerClassName="rounded px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-red-400"
                align="right"
                onConfirm={() => remove(f.id)}
              />
            </span>
          </li>
        ))}
      </ul>
      {/* No "+ Add file" button (Tyler, 2026-09-11, sitewide): files arrive by
          pasting or dropping into the body, through MCP, or from email-in, so a
          dedicated upload button earned a row on every item for a path nobody
          used. The input and its upload handler stay MOUNTED and wired
          (defer-by-hiding, not deleted) so restoring the affordance is one
          button. */}
      <div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void add(files);
          }}
        />
      </div>
    </div>
  );
}
