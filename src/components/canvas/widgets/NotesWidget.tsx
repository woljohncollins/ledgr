"use client";

// Docs widget body (Project Type, Tyler 2026-07-01): the project's contained
// notes. The rows live in the shared NoteList (extracted 2026-08-17 so the full
// collection page renders the same rows); "+ Add note" creates a note
// associated with this project and opens it in the note editor modal.
import AddContainedItemButton from "@/components/canvas/widgets/AddContainedItemButton";
import NoteList, { type NoteRow } from "@/components/notes/NoteList";

export default function NotesWidget({
  recordId,
  items,
}: {
  recordId: string;
  items: NoteRow[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <NoteList items={items} detachFrom={recordId} />
      <AddContainedItemButton recordId={recordId} type="note" label="Add note" />
    </div>
  );
}
