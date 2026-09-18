// "Apply template…" on an already-started item (ADR-093, TPL4b). Opens a modal
// to pick a template of the item's type, choose a merge mode (fill-blanks /
// overwrite), and fill any {{ask:…}} prompts, then POSTs the apply with a
// targetId so the store merges into this item (vs. creating a new one). Shown in
// the item modal header + full-page chrome for real (non-template) items.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

type Opt = { id: string; name: string; isDefault: boolean };

const fieldClass =
  "rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

export default function ApplyTemplateButton({
  itemId,
  type,
  triggerClassName,
  leading,
}: {
  itemId: string;
  type: string;
  triggerClassName?: string;
  // Optional leading glyph rendered before the label (the actions-menu icon).
  leading?: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Opt[]>([]);
  const [loading, setLoading] = useState(false);
  const [selId, setSelId] = useState("");
  const [mode, setMode] = useState<"fill" | "overwrite">("fill");
  const [askLabels, setAskLabels] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the type's templates when opened (loading is flipped on by the trigger
  // so no synchronous setState runs inside the effect).
  useEffect(() => {
    if (!open) return;
    fetch(`/api/templates?type=${encodeURIComponent(type)}&preview=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { templates?: Opt[] } | null) => {
        const t = d?.templates ?? [];
        setTemplates(t);
        setSelId(t[0]?.id ?? "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, type]);

  // Load the selected template's {{ask:…}} prompts (answers are reset where the
  // selection changes, not here, to avoid a synchronous setState in the effect).
  useEffect(() => {
    if (!open || !selId) return;
    fetch(`/api/templates/${selId}/vars`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { askLabels?: string[] } | null) => setAskLabels(d?.askLabels ?? []))
      .catch(() => setAskLabels([]));
  }, [open, selId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy]);

  async function apply() {
    if (busy || !selId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${selId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: itemId, mode, answers }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `failed (${res.status})`);
        setBusy(false);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("failed (offline?)");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setLoading(true);
          setAskLabels([]);
          setAnswers({});
          setError(null);
          setOpen(true);
        }}
        className={triggerClassName}
      >
        {leading}
        Apply template…
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-10"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label="Apply a template"
            className="w-full max-w-md rounded-lg border border-neutral-800 bg-[var(--background)] p-4 shadow-2xl"
          >
            <h2 className="text-sm font-semibold text-neutral-100">Apply a template</h2>
            <p className="mt-1 text-xs text-neutral-400">
              Merge a template into this item — its body, subtasks, properties, and
              related items.
            </p>
            {loading ? (
              <p className="mt-3 text-sm text-neutral-500">Loading…</p>
            ) : templates.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">No templates for this type yet.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-400">Template</span>
                  <select
                    value={selId}
                    onChange={(e) => {
                      setSelId(e.target.value);
                      setAnswers({});
                    }}
                    className={fieldClass}
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.isDefault ? " ★" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-neutral-400">How</span>
                  <label className="flex items-start gap-2 text-sm text-neutral-200">
                    <input
                      type="radio"
                      name="apply-mode"
                      checked={mode === "fill"}
                      onChange={() => setMode("fill")}
                      className="mt-1"
                    />
                    <span>
                      Fill blanks{" "}
                      <span className="text-neutral-500">— set only empty fields, add missing subtasks</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-neutral-200">
                    <input
                      type="radio"
                      name="apply-mode"
                      checked={mode === "overwrite"}
                      onChange={() => setMode("overwrite")}
                      className="mt-1"
                    />
                    <span>
                      Overwrite{" "}
                      <span className="text-neutral-500">— replace fields with the template&apos;s</span>
                    </span>
                  </label>
                </fieldset>
                {askLabels.map((label, i) => (
                  <label key={label} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-neutral-400">{label}</span>
                    <input
                      autoFocus={i === 0}
                      value={answers[label] ?? ""}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, [label]: e.target.value }))
                      }
                      className={fieldClass}
                    />
                  </label>
                ))}
                {error && <p className="text-xs text-red-400">{error}</p>}
                <div className="flex items-center justify-end gap-2">
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
                    onClick={() => void apply()}
                    disabled={busy || !selId}
                    className="rounded bg-neutral-100 px-2.5 py-1 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
                  >
                    {busy ? "Applying…" : "Apply"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
