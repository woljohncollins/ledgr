// A standalone Todoist-style completion circle (Tyler, 2026-07-01), extracted
// from TaskTitle so list surfaces (the project Tasks card, and any future task
// list) get the SAME check UI as the task type: a ring that fills with the
// user's highlight color when done, with a check that hints on hover. Optimistic
// — fills instantly, then the /complete endpoint lands (recurrence-aware) and a
// coalesced (debounced) refresh re-syncs, so triaging many tasks in a burst
// queues one refetch on idle. Priority-colored ring when a priority is set, else neutral;
// the done fill uses the priority color when present, otherwise the accent.
"use client";

import { useState } from "react";
import { beginSave, endSave } from "@/lib/save-status";
import { useListRefresh } from "@/lib/list-refresh";
import { priorityStyle, toPriority } from "@/lib/priority";

export default function TaskCheckCircle({
  itemId,
  done: initialDone,
  priority = null,
  onOptimisticChange,
}: {
  itemId: string;
  done: boolean;
  priority?: number | null;
  // Mirrors this circle's optimistic state to the row around it, so the ROW can
  // look done at the same instant the circle does (Tyler's "slight pause",
  // 2026-08-12). Without it the circle filled immediately but the title's
  // strikethrough waited on the server refetch — the completion looked half-
  // applied for ~500ms+. Fires on click and again if the request fails and the
  // circle reverts, so the row never disagrees with the control.
  onOptimisticChange?: (done: boolean) => void;
}) {
  const refresh = useListRefresh();
  const [done, setDone] = useState(initialDone);
  const [prev, setPrev] = useState(initialDone);
  if (initialDone !== prev) {
    setPrev(initialDone);
    setDone(initialDone);
  }

  async function toggle() {
    const next = !done;
    setDone(next);
    onOptimisticChange?.(next);
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}/complete`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      refresh();
    } catch {
      setDone(!next);
      onOptimisticChange?.(!next);
      endSave(false);
    }
  }

  const p = toPriority(priority);
  const ps = p ? priorityStyle(p) : null;
  const ringColor = ps ? ps.ring : "border-neutral-600";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggle();
      }}
      aria-label={done ? "Mark not done" : "Mark done"}
      aria-pressed={done}
      title={done ? "Completed — click to reopen" : "Mark complete"}
      className={`group/circle flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${ringColor} ${
        done ? (ps ? ps.dot : "") : "bg-transparent hover:bg-neutral-800/50"
      }`}
      // No priority → the done fill is the user's accent (their highlight color).
      style={done && !ps ? { backgroundColor: "var(--accent)" } : undefined}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden
        className={`h-2.5 w-2.5 transition-opacity ${
          done
            ? "text-white opacity-100"
            : `${ps ? ps.text : "text-neutral-400"} opacity-0 group-hover/circle:opacity-60`
        }`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
