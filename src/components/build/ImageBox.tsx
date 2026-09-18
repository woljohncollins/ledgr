// The picture box for ANY image-kind property (ADR-255), not just the person
// page (Tyler, 2026-08-18 — ADR-202 addendum 4, the original built-in — person
// is one caller of this generic box). A square box near the title shows the
// property's image, and clicking it opens the two ways to set one — upload a
// file, or paste a URL — plus Remove. An upload is center-cropped to a SQUARE
// on a canvas before it leaves the browser (Tyler: "force the user to trim the
// image down to a square"; v1 is a deterministic center crop — a drag-to-
// position cropper can layer on later) and capped at 512px, so avatars stay
// small. The bytes go browser → presigned R2 PUT (the standard attachment
// path) and the stable public URL lands in the given property, which for
// person's built-in `image` is what every avatar reads.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";

const SIDE = 512;

async function squareJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const crop = Math.min(bmp.width, bmp.height);
  const out = Math.min(crop, SIDE);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bmp, (bmp.width - crop) / 2, (bmp.height - crop) / 2, crop, crop, 0, 0, out, out);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("crop failed"))), "image/jpeg", 0.85)
  );
}

export default function ImageBox({
  itemId,
  propKey,
  initial,
}: {
  itemId: string;
  propKey: string;
  initial: string | null;
}) {
  const router = useRouter();
  const [image, setImage] = useState(initial);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function save(next: string | null) {
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyPatch: { [propKey]: next } }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setImage(next);
      setOpen(false);
      setUrl("");
      router.refresh();
    } catch {
      showToast("Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      const blob = await squareJpeg(file);
      const reserve = await fetch("/api/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          filename: `${propKey}.jpg`,
          contentType: "image/jpeg",
          sizeBytes: blob.size,
        }),
      });
      if (!reserve.ok) throw new Error(String(reserve.status));
      // fileUrl, not publicUrl: the property stores the stable /files/<id>
      // address so it survives a storage change (ADR-228).
      const { uploadUrl, fileUrl } = (await reserve.json()) as {
        uploadUrl: string;
        fileUrl: string;
      };
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (!put.ok) throw new Error(String(put.status));
      await save(fileUrl);
    } catch {
      showToast("Image upload failed");
      setBusy(false);
    }
  }

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={image ? "Change image" : "Add image"}
        aria-label={image ? "Change image" : "Add image"}
        className={`group block h-28 w-28 overflow-hidden rounded-card border transition-colors ${
          image
            ? "border-line hover:border-line-strong"
            : "border-dashed border-line-strong hover:bg-surface-2/60"
        }`}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-subtle group-hover:text-ink-muted">
            <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="15" rx="2" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="M4.5 18l4.5-4.5 3 3 3.5-3.5 4 4" />
            </svg>
            <span className="text-xs">Image</span>
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 flex w-64 flex-col gap-2 rounded-card border border-line-strong bg-surface-3 p-2 shadow-xl shadow-black/40">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="rounded border border-line px-2 py-1.5 text-sm text-ink hover:border-line-strong hover:bg-surface-2 disabled:opacity-50"
          >
            {busy ? "Working…" : "Upload an image"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <div className="flex items-center gap-1.5">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && url.trim()) void save(url.trim());
              }}
              placeholder="…or paste an image URL"
              aria-label="Image URL"
              disabled={busy}
              className="min-w-0 flex-1 rounded border border-line bg-surface-1 px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
            {url.trim() && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(url.trim())}
                className="rounded border border-line-strong px-2 py-1 text-sm text-[var(--accent)] hover:bg-surface-2 disabled:opacity-50"
              >
                Save
              </button>
            )}
          </div>
          {image && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(null)}
              className="rounded px-2 py-1 text-left text-sm text-red-400 hover:bg-surface-2 disabled:opacity-50"
            >
              Remove image
            </button>
          )}
        </div>
      )}
    </div>
  );
}
