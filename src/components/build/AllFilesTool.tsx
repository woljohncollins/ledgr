// All files (ADR-237, Data Hygiene tool #2): every attachment, its size, the
// item it hangs off, and whether that item still points at it. The "not
// linked" chip answers the question that created this tool — "I backspaced
// the link, did the file delete?" (no: it's here, still counting against the
// quota, until Delete). Delete rides the existing attachment endpoint.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { attachmentUrl } from "@/lib/attachment-url";
import { announceAttachmentRemoved } from "@/components/attachments/upload";
import { showToast } from "@/components/ui/ActionToast";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { formatBytes } from "@/lib/format-count";

type FileRow = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  parent: { id: string; title: string; type: string };
  referenced: boolean;
};


export default function AllFilesTool() {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/hygiene/files")
      .then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().catch(() => null);
          throw new Error(detail?.error ?? `failed (${r.status})`);
        }
        return r.json();
      })
      .then((d: { files: FileRow[] }) => {
        if (!cancelled) setFiles(d.files);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (f: FileRow) => {
    const res = await fetch(`/api/attachments/${f.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`delete failed (${res.status})`);
    announceAttachmentRemoved({ itemId: f.parent.id, id: f.id });
    setFiles((prev) => (prev ?? []).filter((x) => x.id !== f.id));
    showToast("File deleted from storage");
  };

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (files === null) return <p className="text-sm text-ink-subtle">Loading…</p>;
  if (files.length === 0) {
    return <p className="text-sm text-ink-subtle">No files in storage yet.</p>;
  }
  const totalBytes = files.reduce((a, f) => a + f.sizeBytes, 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-subtle">
        {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} of storage
      </p>
      <ul className="flex flex-col gap-1.5">
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <a
              href={attachmentUrl(f.id)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${f.filename} in a new tab`}
              className="truncate text-ink hover:text-[var(--accent)]"
            >
              {f.filename}
            </a>
            <span className="shrink-0 text-xs text-ink-faint">{formatBytes(f.sizeBytes)}</span>
            <span className="shrink-0 text-xs text-ink-subtle">
              on{" "}
              <Link href={`/items/${f.parent.id}`} className="underline decoration-dotted underline-offset-2 hover:text-ink">
                {f.parent.title || "Untitled"}
              </Link>
            </span>
            {!f.referenced && (
              <span
                title="Nothing in that item's body or fields points at this file anymore (normal for a file listed in an item's file panel). It still counts against your storage until deleted."
                className="shrink-0 cursor-help rounded-full border border-line px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-subtle"
              >
                not linked
              </span>
            )}
            <span className="ml-auto shrink-0">
              <ConfirmButton
                title="Delete this file?"
                description="Deletes it from storage for good — anything still linking to it stops working."
                confirmLabel="Delete"
                trigger={<span>Delete</span>}
                triggerLabel={`Delete ${f.filename}`}
                triggerClassName="rounded px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-red-400"
                align="right"
                onConfirm={() => remove(f)}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
