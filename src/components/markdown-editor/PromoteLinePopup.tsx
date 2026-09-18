// The promote-to-task popup (ADR-090). Opened when a checkbox line's "→ task"
// button is clicked: pre-filled with the line's text as the title and its
// sub-bullets as the description, so promotion is "confirm + tweak" not "fill a
// form."
//
// The form itself is the ordinary task capture card (Brandon, 2026-08-28): a
// meeting's action line carries the same shorthand a typed capture does — a due
// date, "p2", "#tag", "+project", "@person" — and it was being thrown away here,
// because this popup only ever sent a title and a body. Same card, same parsing,
// one place to fix when the shorthand grows. The card POSTs to the meeting's
// promote-task route (createVia), which adds the source anchor and the meeting's
// people on the server side.
"use client";

import { useEffect } from "react";
import AddTaskCard from "@/components/tasks/AddTaskCard";

export default function PromoteLinePopup({
  initialTitle,
  initialBody,
  meetingId,
  blockRef,
  onBeforeCreate,
  onDone,
  onCancel,
}: {
  initialTitle: string;
  initialBody: string;
  meetingId: string;
  blockRef?: string;
  onBeforeCreate?: () => Promise<void> | void;
  onDone: () => void;
  onCancel: () => void;
}) {
  // Esc closes anywhere in the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[18vh]">
      <div className="w-full max-w-lg" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          Promote to task
        </h2>
        <AddTaskCard
          initialTitle={initialTitle}
          initialDescription={initialBody}
          createVia={{
            url: `/api/items/${meetingId}/promote-task`,
            ...(blockRef ? { extra: { blockRef } } : {}),
          }}
          onBeforeCreate={onBeforeCreate}
          submitLabel="Create task"
          onDone={onDone}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
