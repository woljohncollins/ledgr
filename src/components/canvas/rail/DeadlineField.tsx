// The deadline's editor (ADR-253), opened by the rail's Due row. It briefly lived
// inside the Schedule popover, on the theory that a task wants one date most
// days — but that made the deadline invisible on any task without one, so the
// Due row came back and this control moved into it. See DueRow for that story.
//
// Two states, no rule-authoring: a deadline FOLLOWS the plan date by default,
// keeping whatever gap the two currently have, or it is PINNED — a hard external
// date that ignores everything (Apr 15, a grant submission, a hand-off). The gap
// is never typed in: you pick a date, and the gap is simply what it now is.
//
// Server-side anchoring does the actual shifting (item-mutations.ts); this control
// only writes the date and the pin, the FieldStrip optimistic-PATCH pattern.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { beginSave, endSave } from "@/lib/save-status";
import DayField from "./DayField";
import { PinGlyph } from "./row-ui";
import { formatDayLabel } from "@/lib/format-date";

function ymdToIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

export default function DeadlineField({
  itemId,
  today,
  scheduled,
  due,
  pinned,
}: {
  itemId: string;
  today: string;
  scheduled: string | null; // ISO instant or null
  due: string | null; // ISO instant or null
  pinned: boolean;
}) {
  const router = useRouter();
  const [iso, setIso] = useState(due);
  const [isPinned, setPinned] = useState(pinned);
  const [prev, setPrev] = useState(due);
  if (due !== prev) {
    setPrev(due);
    setIso(due);
  }

  async function patch(body: Record<string, unknown>, revert: () => void) {
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      router.refresh();
    } catch {
      revert();
      endSave(false);
    }
  }

  async function pickDue(ymd: string | null) {
    const before = iso;
    const next = ymd ? ymdToIso(ymd) : null;
    setIso(next);
    await patch({ dueDate: next }, () => setIso(before));
  }

  async function togglePin() {
    const before = isPinned;
    const next = !before;
    setPinned(next);
    await patch(
      { propertyPatch: { datePins: next ? { due: true } : null } },
      () => setPinned(before)
    );
  }

  // Pull the plan back onto the deadline. `dueDate` is sent explicitly alongside
  // so the server reads it as "both dates stated deliberately" and does NOT then
  // drag the deadline along by the same delta.
  async function movePlanToDue() {
    if (!iso) return;
    await patch({ scheduledDate: iso, dueDate: iso }, () => {});
  }

  const dueYmd = iso ? iso.slice(0, 10) : null;
  const schedYmd = scheduled ? scheduled.slice(0, 10) : null;
  // The incoherent state: a deadline landing BEFORE the day the work is planned
  // for. Never blocked — sometimes you genuinely missed it and "due Aug 28,
  // working it Sep 14" is the honest record — but it should not render deadpan,
  // which is exactly how the Aug 28 fossils went unnoticed for weeks.
  const beforePlan = !!dueYmd && !!schedYmd && dueYmd < schedYmd;
  // Only offer to pull the plan back to a deadline that hasn't already passed;
  // "move the plan to Aug 28" in September helps nobody.
  const canMovePlan = beforePlan && !!dueYmd && dueYmd >= today;

  return (
    <div className="flex flex-col gap-2">
      <DayField valueYmd={dueYmd} today={today} onPick={pickDue} />

      {iso && (
        <button
          type="button"
          onClick={togglePin}
          aria-pressed={isPinned}
          className={`flex items-center gap-1.5 self-start rounded px-1.5 py-1 text-xs transition-colors hover:bg-surface-2 ${
            isPinned ? "text-[var(--accent)]" : "text-ink-subtle"
          }`}
        >
          <PinGlyph className="h-3.5 w-3.5" />
          {isPinned ? "Pinned — stays put" : "Follows the plan date"}
        </button>
      )}

      {beforePlan && (
        <div className="rounded-card border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-xs text-ink-muted">
          <span className="text-red-400">
            Deadline is before the day this is planned for.
          </span>
          {canMovePlan && (
            <button
              type="button"
              onClick={movePlanToDue}
              className="mt-1 block text-left text-ink hover:underline"
            >
              Move the plan to {formatDayLabel(iso)} too
            </button>
          )}
        </div>
      )}
    </div>
  );
}
