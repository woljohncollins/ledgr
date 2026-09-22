// "I called them" tick for a person row (John, 2026-09-22). One tap stamps the
// person's `lastcontact` date property with today; tapping again the same day
// clears it, so a mis-tap is undoable without opening the record.
//
// It deliberately does NOT complete the person. `person` has statusMode "none"
// and should keep it: a person is never done, they are contacted and then due
// again. Stamping a date is what makes "Who needs a call" self-maintaining —
// sort the view by `lastcontact` ascending and the longest-since-contact float
// to the top, which is what that widget's label has always claimed.
//
// Optimistic + refresh, the FocusStar/SubtaskCheckbox pattern.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { beginSave, endSave } from "@/lib/save-status";

// A `date` property is stored as the bare YYYY-MM-DD string the date input
// emits (CustomProperties, `case "date"`), so a same-day check is string
// equality on the first 10 characters. No parsing, no timezone to get wrong.
export function lastContactOf(properties: unknown): string | null {
  const p = properties as Record<string, unknown> | null;
  const raw = p?.lastcontact;
  return typeof raw === "string" && raw ? raw.slice(0, 10) : null;
}

export default function ContactedCheck({
  itemId,
  lastContact,
  today,
}: {
  itemId: string;
  lastContact: string | null;
  today: string; // YYYY-MM-DD, app timezone — never the browser clock
}) {
  const router = useRouter();
  const [on, setOn] = useState(lastContact === today);
  const [prev, setPrev] = useState(lastContact);
  // Adjust-during-render: a refresh brings the server value, which wins.
  if (lastContact !== prev) {
    setPrev(lastContact);
    setOn(lastContact === today);
  }

  async function toggle() {
    const next = !on;
    setOn(next);
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // propertyPatch merges per key, so church/role/cadence are untouched.
        // Clearing writes null rather than "" — an empty string would sort as a
        // real value and park the person at the wrong end of the list.
        body: JSON.stringify({ propertyPatch: { lastcontact: next ? today : null } }),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      router.refresh();
    } catch {
      setOn(!next);
      endSave(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={on ? "Undo contacted today" : "Mark contacted today"}
      aria-pressed={on}
      title={on ? "Contacted today — tap to undo" : "Mark contacted today"}
      className={`cancel-drag grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2 leading-none transition-colors ${
        on
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : "border-line-strong text-transparent hover:border-ink-subtle"
      }`}
    >
      <span aria-hidden className="text-[10px]">
        ✓
      </span>
    </button>
  );
}

// "3 weeks ago" style age for the row, from the same bare day string. Returns
// null when there is no date, which the row renders as "never" rather than
// hiding: never-contacted is the most important state this list has.
export function contactAge(lastContact: string | null, today: string): string | null {
  if (!lastContact) return null;
  const d = Date.parse(lastContact + "T00:00:00Z");
  const t = Date.parse(today + "T00:00:00Z");
  if (Number.isNaN(d) || Number.isNaN(t)) return null;
  const days = Math.round((t - d) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 31) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
