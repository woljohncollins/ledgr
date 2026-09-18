// The apply-time prompt form (ADR-093, TPL3): when a template has {{ask:Label}}
// prompts, picking it from "+ New" opens this small modal to collect the values,
// then applies (POST …/apply with answers) and opens the new item. Templates
// with no prompts skip this entirely (NewItemButton applies directly).
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { openItem } from "@/lib/item-nav";

export default function TemplateApplyDialog({
  templateId,
  name,
  askLabels,
  onClose,
}: {
  templateId: string;
  name: string;
  askLabels: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `failed (${res.status})`);
        setBusy(false);
        return;
      }
      const { item } = (await res.json()) as { item: { id: string } };
      onClose(); // clear the picker state before navigating so it doesn't linger
      openItem(router, item.id);
      router.refresh();
    } catch {
      setError("failed (offline?)");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-10"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`New from ${name}`}
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-[var(--background)] p-4 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-neutral-100">
          New from “{name}”
        </h2>
        <p className="mt-1 text-xs text-neutral-400">
          Fill these in to start — they replace the template&apos;s prompts.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {askLabels.map((label, i) => (
            <label key={label} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-400">{label}</span>
              <input
                autoFocus={i === 0}
                value={answers[label] ?? ""}
                onChange={(e) =>
                  setAnswers((a) => ({ ...a, [label]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600"
              />
            </label>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-2.5 py-1 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded bg-neutral-100 px-2.5 py-1 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
