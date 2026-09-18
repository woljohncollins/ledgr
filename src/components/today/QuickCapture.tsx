// Quick-capture box (PRD §4.2): title-only, type defaults to the catch-all
// `unmarked` (§4.4, ADR-067) so it never pre-assumes a task; Enter submits and
// keeps focus for rapid entry. Captures name their arrival path
// (source: "quick_capture") and the owner's Capture routing decides where they
// land, which is the Inbox unless they changed it (ADR-249).
//
// When `typeOptions` is passed (the Inbox), a small "＋ details" toggle expands
// the slim box into the shared CaptureCard (Slice 3) — the same type-picker +
// AddTaskCard/SimpleCapture the global "+" modal uses — so a capture that needs
// a date, priority, project, or a non-task type can be filed without leaving the
// page. The slim one-line input stays the default fast path.
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import CaptureCard from "@/components/capture/CaptureCard";
import { enqueueCapture } from "@/lib/outbox";

export default function QuickCapture({
  typeOptions,
}: {
  typeOptions?: { key: string; label: string }[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "busy" | "error" | "offline">("idle");
  const [expanded, setExpanded] = useState(false);

  async function capture() {
    const title = inputRef.current?.value.trim();
    if (!title || state === "busy") return;
    const payload = { type: "unmarked", title, source: "quick_capture" };
    setState("busy");
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (inputRef.current) inputRef.current.value = "";
      setState("idle");
      router.refresh();
      inputRef.current?.focus();
    } catch {
      // Offline (or a transient failure): queue locally; the outbox syncs on
      // reconnect (T5, ADR-080) — capture never loses the thought.
      enqueueCapture(payload);
      window.dispatchEvent(new Event("ledgr:outbox"));
      if (inputRef.current) inputRef.current.value = "";
      setState("offline");
      inputRef.current?.focus();
    }
  }

  // Expanded: the full CaptureCard replaces the slim box. Collapses back on
  // add/cancel; the added item shows up via the card's own router.refresh().
  if (expanded) {
    return (
      <CaptureCard
        typeOptions={typeOptions}
        onDone={() => setExpanded(false)}
        onCancel={() => setExpanded(false)}
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        placeholder="Capture anything…"
        aria-label="Quick capture"
        className="w-full rounded-lg border border-line bg-surface-1 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
        onKeyDown={(e) => {
          if (e.key === "Enter") void capture();
        }}
      />
      {typeOptions && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="Add with details (date, priority, project, type…)"
          className="shrink-0 rounded-lg border border-line px-2.5 py-2 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
        >
          ＋ Details
        </button>
      )}
      {state === "error" && (
        <span className="shrink-0 text-xs text-red-400">
          Failed, press Enter to retry
        </span>
      )}
      {state === "offline" && (
        <span className="shrink-0 text-xs text-ink-subtle">
          Saved offline · will sync
        </span>
      )}
    </div>
  );
}
