"use client";

// Mindmap widget body (Tyler, 2026-07-01): the project's contained mindmap(s).
// The rows live in the shared MindmapList (extracted 2026-08-17 so the full
// collection page renders the same rows); "+ Add mindmap" creates a mindmap
// associated with this project (via the contain route → home edge) and opens it
// in the mindmap canvas. A mindmap is a full canvas, so the card is a launcher
// (list + add), not an inline editor — mirrors the Docs/Links widgets.
import AddContainedItemButton from "@/components/canvas/widgets/AddContainedItemButton";
import MindmapList, { type MindmapRow } from "@/components/mindmaps/MindmapList";

export default function MindmapWidget({
  recordId,
  items,
}: {
  recordId: string;
  items: MindmapRow[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <MindmapList items={items} detachFrom={recordId} />
      <AddContainedItemButton recordId={recordId} type="mindmap" label="Add mindmap" />
    </div>
  );
}
