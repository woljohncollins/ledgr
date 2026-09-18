// "Save as template" (ADR-093, TPL2): turn the current item into a reusable
// template. Opens a small popover with a name (prefilled from the title), POSTs
// to /api/templates/from-item (clone the subtree into a hidden prototype + a
// registry row), then opens the new prototype so the user can refine it. Shown
// in the modal header and the full-page chrome for real (non-template) items.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { openItem } from "@/lib/item-nav";

export default function SaveAsTemplateButton({
  itemId,
  defaultName,
  triggerClassName,
  align = "left",
  leading,
}: {
  itemId: string;
  defaultName: string;
  triggerClassName?: string;
  align?: "left" | "right";
  // Optional leading glyph rendered before the label (the actions-menu icon).
  leading?: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/templates/from-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, name: name.trim() || defaultName }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `failed (${res.status})`);
        setBusy(false);
        return;
      }
      const { template } = (await res.json()) as { template: { prototypeItemId: string } };
      setOpen(false);
      // Open the new prototype in the canvas to refine the template.
      openItem(router, template.prototypeItemId);
      router.refresh();
    } catch {
      setError("failed (offline?)");
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setName(defaultName);
          setError(null);
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={triggerClassName}
      >
        {leading}
        Save as template
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Save as template"
          className={`absolute z-50 mt-2 w-72 rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-xl shadow-black/50 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <p className="text-sm font-medium text-neutral-100">Save as a template</p>
          <p className="mt-1 text-xs text-neutral-400">
            Creates a reusable template from this item — its body, subtasks,
            properties, and related items.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="Template name"
            autoFocus
            className="mt-2 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600"
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded px-2.5 py-1 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded bg-neutral-100 px-2.5 py-1 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
