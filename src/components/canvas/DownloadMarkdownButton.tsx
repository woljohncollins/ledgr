// Download-the-markdown button for the full-markdown view (ADR-197): the
// project document is meant to leave Ledgr — read it in an editor, hand it to
// someone — so alongside Copy there's a real .md file. Client-side Blob, no
// round trip; the text is already on the page.
"use client";

export default function DownloadMarkdownButton({ text, filename }: { text: string; filename: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-card border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      Download .md
    </button>
  );
}
