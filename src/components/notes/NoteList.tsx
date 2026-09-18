// The note (Docs) row list, shared by the Docs tool (card) and the full
// collection page (2026-08-17: the full page carries the tool's capability).
// Each row is a note icon + the title, linking to the note. No "use client"
// directive: stateless, so it renders on the server page and inside the client
// widget alike. `selectable` adds the ADR-118 SelectCheckbox at the leading
// edge (the collection page wraps this in a SelectionProvider).
import Link from "next/link";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import DetachButton from "@/components/lists/DetachButton";

export type NoteRow = { id: string; title: string ; contained?: boolean };

const NoteIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </svg>
);

export default function NoteList({
  items,
  selectable = false,
  detachFrom,
}: {
  items: NoteRow[];
  selectable?: boolean;
  // The record these rows are shown on, when the surface distinguishes a
  // resource that LIVES here from one merely related to it (ADR-232). Given it,
  // a row with `contained: false` wears the detach ✕. Omitted on surfaces that
  // don't distinguish, where nothing shows.
  detachFrom?: string;
}) {
  return (
    <ul className="flex flex-col gap-1 empty:hidden">
      {items.map((n) => (
        <li key={n.id} className="flex items-center gap-2 text-sm">
          {selectable && <SelectCheckbox id={n.id} />}
          <span className="shrink-0 text-neutral-500">{NoteIcon}</span>
          <Link href={`/items/${n.id}`} className="min-w-0 flex-1 truncate text-neutral-200 hover:text-neutral-100">
            {n.title || "Untitled note"}
          </Link>
          {detachFrom && n.contained === false && (
            <DetachButton recordId={detachFrom} itemId={n.id} label={n.title} />
          )}
        </li>
      ))}
    </ul>
  );
}
