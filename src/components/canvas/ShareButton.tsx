// Share (2026-09-22, John): one visible button in the item chrome. Opens a
// small menu: the device share sheet when the browser has one (phone, Edge),
// copy the text, download the .md (which another Ledgr can import at Build →
// Import & Migration), or start an email with the text in it.
"use client";

import { useEffect, useRef, useState } from "react";
import { showToast } from "@/components/ui/ActionToast";
import ActionGlyph from "./action-icons";

type Bundle = { filename: string; markdown: string; title: string };

export default function ShareButton({ itemId, className = "" }: { itemId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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

  async function load(): Promise<Bundle> {
    const res = await fetch(`/api/items/${itemId}/export-md`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Bundle;
  }

  // Public read-only web link (Ledgr's existing share tokens): mint one and copy
  // the absolute URL. Anyone with the link can read the rendered item.
  async function copyLink() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${itemId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(String(res.status));
      const { token } = (await res.json()) as { token: string };
      await navigator.clipboard.writeText(`${window.location.origin}/share/${token}`);
      showToast("Link copied — anyone with it can read this");
      setOpen(false);
    } catch {
      showToast("Couldn't make a link");
    } finally {
      setBusy(false);
    }
  }

  // Strip the front matter for the "human" outlets; keep it for the .md file.
  const plain = (b: Bundle) => b.markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

  async function run(kind: "share" | "copy" | "download" | "email") {
    if (busy) return;
    setBusy(true);
    try {
      const b = await load();
      if (kind === "share") {
        const file = new File([b.markdown], b.filename, { type: "text/markdown" });
        const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
        if (nav.share && nav.canShare?.({ files: [file] })) {
          await nav.share({ files: [file], title: b.title, text: plain(b) });
        } else if (nav.share) {
          await nav.share({ title: b.title, text: plain(b) });
        } else {
          await navigator.clipboard.writeText(plain(b));
          showToast("No share sheet here — copied the text instead");
        }
      } else if (kind === "copy") {
        await navigator.clipboard.writeText(plain(b));
        showToast("Copied");
      } else if (kind === "download") {
        const blob = new Blob([b.markdown], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = b.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (kind === "email") {
        const text = plain(b);
        const bodyText = text.length > 1800 ? text.slice(0, 1800) + "\n\n[…] (full note attached as a file is best — use Download .md)" : text;
        window.location.href = `mailto:?subject=${encodeURIComponent(b.title)}&body=${encodeURIComponent(bodyText)}`;
      }
      setOpen(false);
    } catch (e) {
      // The share sheet's own cancel rejects with AbortError: not an error to show.
      if (!(e instanceof DOMException && e.name === "AbortError")) showToast("Couldn't share that");
    } finally {
      setBusy(false);
    }
  }

  const canShareSheet = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const row = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-60";

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
        title="Share this item"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ActionGlyph icon="share" />
        Share
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-line bg-[var(--background)] p-1 shadow-xl"
        >
          <button role="menuitem" className={row} disabled={busy} onClick={() => void copyLink()}>
            <span>
              Copy link
              <span className="block text-xs text-ink-faint">Read-only web page, no sign-in needed</span>
            </span>
          </button>
          {canShareSheet && (
            <button role="menuitem" className={row} disabled={busy} onClick={() => void run("share")}>
              Share… <span className="text-xs text-ink-faint">(device share sheet)</span>
            </button>
          )}
          <button role="menuitem" className={row} disabled={busy} onClick={() => void run("copy")}>
            Copy as text
          </button>
          <button role="menuitem" className={row} disabled={busy} onClick={() => void run("email")}>
            Email…
          </button>
          <button role="menuitem" className={row} disabled={busy} onClick={() => void run("download")}>
            <span>
              Download .md
              <span className="block text-xs text-ink-faint">Another Ledgr imports this at Build → Import</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
