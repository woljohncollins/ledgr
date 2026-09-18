"use client";

// The meeting row list, shared by the Meetings tool (card) and the full
// collection page (2026-08-17: the full page carries the tool's capability).
// Rows link to the meeting with a timezone-aware date label — a date-only
// meeting (stored at UTC midnight) shows just the day, a timed one shows the
// time in the owner's timezone. Sorted by date ascending, undated last (Tyler,
// 2026-07-01). `selectable` adds the ADR-118 SelectCheckbox at the leading edge
// (the collection page wraps this in a SelectionProvider); the card leaves it
// off, like every widget preview.
import Link from "next/link";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import DetachButton from "@/components/lists/DetachButton";
import { useTimezone } from "@/components/providers/TimezoneProvider";

export type MeetingRow = { id: string; title: string; when: string | null ; contained?: boolean };

function dayLabel(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const dateOnly = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  if (dateOnly) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
}

export default function MeetingList({
  items,
  selectable = false,
  detachFrom,
}: {
  items: MeetingRow[];
  selectable?: boolean;
  // The record these rows are shown on, when the surface distinguishes a
  // resource that LIVES here from one merely related to it (ADR-232). Given it,
  // a row with `contained: false` wears the detach ✕.
  detachFrom?: string;
}) {
  const tz = useTimezone();
  // By date, closest on top (ascending); undated last.
  const sorted = [...items].sort((a, b) => {
    if (!a.when) return b.when ? 1 : 0;
    if (!b.when) return -1;
    return a.when.localeCompare(b.when);
  });

  return (
    <ul className="flex flex-col gap-1 empty:hidden">
      {sorted.map((m) => (
        <li key={m.id} className="flex items-center gap-2 text-sm">
          {selectable && <SelectCheckbox id={m.id} />}
          <Link href={`/items/${m.id}`} className="min-w-0 flex-1 truncate text-neutral-200 hover:text-neutral-100">
            {m.title || "Untitled"}
          </Link>
          {dayLabel(m.when, tz) && <span className="shrink-0 text-xs text-neutral-500">{dayLabel(m.when, tz)}</span>}
          {detachFrom && m.contained === false && (
            <DetachButton recordId={detachFrom} itemId={m.id} label={m.title} />
          )}
        </li>
      ))}
    </ul>
  );
}
