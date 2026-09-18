"use client";

// Copy one address to the clipboard (ADR-212). The whole point of showing a
// hub its own addresses is that adding a spoke becomes copy-here,
// paste-there — so the copy has to be a button, not a select-and-drag.
import { useState } from "react";

export default function CopyAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard denied (an insecure origin, usually): the address is on
      // screen either way, so say nothing and let the owner select it.
    }
  }

  return (
    <button
      type="button"
      className="ui-meta shrink-0 rounded-card border border-line-strong bg-surface-2 px-2 py-0.5 text-ink hover:bg-surface-3"
      onClick={() => void copy()}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
