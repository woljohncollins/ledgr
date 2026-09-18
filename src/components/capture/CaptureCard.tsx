// The capture card body: a TYPE PICKER header + the per-type card (Brandon,
// 2026-06-28). Extracted from CaptureModal (Slice 3) so it can be rendered both
// inside the global capture dialog AND inline on the Inbox ("＋ details" on the
// slim capture box). Defaults to "task" — the overwhelmingly common capture —
// honoring the last-used type per browser. A capture names its arrival path
// (source: "quick_capture") and the owner's Capture routing says where it lands,
// which is the Inbox for deliberate triage unless they changed it (ADR-249).
//
// task → Tyler's shared AddTaskCard (NL-highlighted title + chip row +
// #project/@person + destination). Any other type → a lean same-styled
// SimpleCapture (title with "@"-mention linking + optional description).
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AddTaskCard from "@/components/tasks/AddTaskCard";
import MentionTitleField, { type LinkedItem } from "@/components/capture/MentionTitleField";
import { enqueueCapture } from "@/lib/outbox";

// --- inline SVG icons (16px, currentColor), matching AddTaskCard's set ---
function I({ d, extra }: { d: string; extra?: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
      {extra}
    </svg>
  );
}
const IconInbox = <I d="M4 13h4l1 3h6l1-3h4" extra={<path d="M4 13l2-7h12l2 7v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />} />;
const IconDescription = <I d="M4 7h16M4 12h16M4 17h10" />;
const IconChevron = <I d="M6 9l6 6 6-6" />;

export default function CaptureCard({
  typeOptions,
  onDone,
  onCancel,
}: {
  typeOptions?: { key: string; label: string }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  // Prepend the catch-all "Unsorted" as the one `unmarked` entry, dropping any
  // `unmarked` already in the passed options (some callers pass the raw type list
  // that still includes the hidden type) so its key stays unique. Every capture
  // lands in the Inbox regardless of type.
  const captureOptions = [
    { key: "unmarked", label: "Unsorted" },
    ...(typeOptions ?? []).filter((o) => o.key !== "unmarked"),
  ];
  const [type, setType] = useState<string>(() => {
    if (typeof window === "undefined") return "task";
    try {
      const last = localStorage.getItem("capture:lastType");
      if (last && captureOptions.some((o) => o.key === last)) return last;
    } catch {
      /* storage unavailable */
    }
    return "task";
  });
  const chooseType = (next: string) => {
    setType(next);
    try {
      localStorage.setItem("capture:lastType", next);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <>
      {/* Type picker header — the choice that makes capture multi-type. */}
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 shadow-lg shadow-black/40">
        <span className="text-xs uppercase tracking-wide text-neutral-500">New</span>
        <span className="relative inline-flex items-center">
          <select
            value={type}
            onChange={(e) => chooseType(e.target.value)}
            aria-label="Type to capture"
            className="appearance-none rounded-md border border-neutral-700 bg-neutral-800 py-1 pl-2.5 pr-7 text-sm text-neutral-200 outline-none hover:border-neutral-600 focus:border-neutral-500"
          >
            {captureOptions.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-1.5 text-neutral-500">{IconChevron}</span>
        </span>
      </div>

      {type === "task" ? (
        <AddTaskCard onDone={onDone} onCancel={onCancel} />
      ) : (
        <SimpleCapture type={type} onDone={onDone} onCancel={onCancel} />
      )}
    </>
  );
}

// A lean capture card for any non-task type, styled to match AddTaskCard: a
// title with "@"-mention linking (MentionTitleField) and an optional
// description. Always lands in the Inbox (ADR-010). Offline-safe via the outbox
// (T5, ADR-080).
function SimpleCapture({
  type,
  onDone,
  onCancel,
}: {
  type: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showDesc, setShowDesc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState<LinkedItem[]>([]);

  // Esc closes. MentionTitleField registers its own capture-phase Esc listener
  // first (child effects run before parent effects) and swallows Escape while
  // its picker is open, so this only fires to close the card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  async function create() {
    const raw = title.trim();
    if (!raw || busy) return;
    setBusy(true);
    const body: Record<string, unknown> = { type, title: raw, source: "quick_capture" };
    if (description.trim()) body.body = { format: "markdown", text: description.trim() };
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (linked.length > 0) {
        const { item } = (await res.json()) as { item: { id: string } };
        await Promise.all(
          linked.map((l) =>
            fetch(`/api/items/${item.id}/relations`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ targetId: l.id, role: "related" }),
            }).catch(() => {})
          )
        );
      }
      router.refresh();
      onDone();
    } catch {
      enqueueCapture(body);
      window.dispatchEvent(new Event("ledgr:outbox"));
      onDone();
    }
  }

  return (
    <div className="rounded-xl border border-neutral-700 bg-neutral-900 p-3 shadow-lg shadow-black/40">
      <div className="flex items-start gap-2 border-b border-neutral-800 pb-3">
        <MentionTitleField
          value={title}
          onChange={setTitle}
          linked={linked}
          onLinkedChange={setLinked}
          onEnter={() => void create()}
          placeholder="Capture…  (type @ to link)"
        />
        <button type="button" title="Toggle description" aria-label="Toggle description" onClick={() => setShowDesc((v) => !v)} className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300">{IconDescription}</button>
      </div>

      {(showDesc || description) && (
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          aria-label="Description"
          className="mt-2 w-full bg-transparent text-sm text-neutral-300 outline-none placeholder:text-neutral-600"
        />
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm text-neutral-400">
          {IconInbox} Inbox
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700">Cancel</button>
          <button type="button" disabled={!title.trim() || busy} onClick={() => void create()} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40">
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
