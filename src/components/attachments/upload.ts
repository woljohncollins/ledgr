// The presigned-upload handshake (PRD §3.4), shared by every browser surface
// that adds a file to an item: a metadata row + URL from our API, the bytes
// PUT straight to R2 (they never proxy through the app server), the stable
// /files/<id> address back. Any file type — callers decide what to do with the
// address (embed an image, insert a link, or nothing when the panel lists it).
// Extracted from ItemEditor (2026-08-29) so the editor, the file canvas, and
// the Files card all ride one implementation.
"use client";

import { showToast } from "@/components/ui/ActionToast";
import { reportUploadProgress } from "@/components/attachments/UploadProgress";

export type UploadedAttachment = {
  id: string;
  filename: string;
  // The stable /files/<id> address (ADR-228) — what belongs in a body.
  fileUrl: string;
};

// Window events so live surfaces (the per-item Files section) can update the
// moment a file lands or leaves, without a router.refresh() mid-typing —
// the same no-dependency event trick ActionToast/UploadProgress use.
export const ATTACHMENT_ADDED_EVENT = "ledgr:attachment-added";
export const ATTACHMENT_REMOVED_EVENT = "ledgr:attachment-removed";
export type AttachmentAddedDetail = {
  itemId: string;
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};
export type AttachmentRemovedDetail = { itemId: string; id: string };

// Drag payload for an EXISTING file (a FilePanel row dragged into the editor):
// the editor inserts a link to the already-uploaded attachment instead of
// re-uploading or pasting a raw URL (Tyler, 2026-08-29).
export const FILE_DRAG_MIME = "application/x-ledgr-file";
export type FileDragPayload = { id: string; filename: string };
export function announceAttachmentRemoved(detail: AttachmentRemovedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AttachmentRemovedDetail>(ATTACHMENT_REMOVED_EVENT, { detail })
  );
}

// The PUT rides XMLHttpRequest, not fetch, for one reason: fetch exposes no
// upload progress, and the bytes-to-R2 leg is the whole wait. Progress feeds
// the global UploadProgress stack via its window event.
function putWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`storage upload failed (${xhr.status})`));
    // XHR cannot tell a CORS rejection from a dead connection — the browser
    // hides the preflight result on purpose — and CORS is by far the likelier
    // of the two here, because the bucket's allowed-origin list has to be
    // re-applied by hand every time an install's address changes and nothing
    // fails until someone tries to upload. Name it, so the next person doesn't
    // spend an afternoon on it: `node scripts/r2-cors.mjs --check` answers it
    // in one command (2026-09-16).
    xhr.onerror = () =>
      reject(
        new Error(
          "Couldn't reach file storage. Its allowed-address list (CORS) may not " +
            "include this address — see runbook §1."
        )
      );
    xhr.send(file);
  });
}

export async function uploadAttachment(
  itemId: string,
  file: File
): Promise<UploadedAttachment> {
  const displayName =
    file.name ||
    (file.type.startsWith("image/") ? "pasted-image.png" : "pasted-file");
  const jobId = crypto.randomUUID();
  reportUploadProgress({ id: jobId, filename: displayName, fraction: 0 });
  try {
    const res = await fetch("/api/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId,
        filename: displayName,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error ?? `upload rejected (${res.status})`);
    }
    const { id, filename, uploadUrl, fileUrl, usage } = await res.json();
    await putWithProgress(uploadUrl, file, (fraction) =>
      reportUploadProgress({ id: jobId, filename: displayName, fraction })
    );
    // The storage warning (ADR-231) rides the upload response; until 2026-08-29
    // the UI dropped it on the floor. Fired after the PUT so it can't outrank a
    // failure.
    if (usage?.message) showToast(usage.message);
    reportUploadProgress({ id: jobId, filename: displayName, fraction: 1, done: true });
    window.dispatchEvent(
      new CustomEvent<AttachmentAddedDetail>(ATTACHMENT_ADDED_EVENT, {
        detail: {
          itemId,
          id,
          filename,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
      })
    );
    return { id, filename, fileUrl };
  } catch (err) {
    // Clear the bar either way; the caller's toast reports the failure.
    reportUploadProgress({ id: jobId, filename: displayName, fraction: 0, done: true });
    throw err;
  }
}
