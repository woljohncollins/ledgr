// The mindmap row list, shared by the Mindmap tool (card) and the full
// collection page (2026-08-17: the full page carries the tool's capability).
// A mindmap is a full canvas, so rows are launchers — glyph + title, linking
// into the mindmap canvas. No "use client" directive: stateless, so it renders
// on the server page and inside the client widget alike. `selectable` adds the
// ADR-118 SelectCheckbox (the collection page wraps this in a SelectionProvider).
import Link from "next/link";
import NavGlyph from "@/components/nav/NavGlyph";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import DetachButton from "@/components/lists/DetachButton";

export type MindmapRow = { id: string; title: string ; contained?: boolean };

export default function MindmapList({
  items,
  selectable = false,
  detachFrom,
}: {
  items: MindmapRow[];
  selectable?: boolean;
  // The record these rows are shown on, when the surface distinguishes a
  // resource that LIVES here from one merely related to it (ADR-232). Given it,
  // a row with `contained: false` wears the detach ✕.
  detachFrom?: string;
}) {
  return (
    <ul className="flex flex-col gap-1 empty:hidden">
      {items.map((m) => (
        <li key={m.id} className="flex items-center gap-2 text-sm">
          {selectable && <SelectCheckbox id={m.id} />}
          <NavGlyph icon="mindmap" size={15} className="shrink-0 text-neutral-500" />
          <Link href={`/items/${m.id}`} className="min-w-0 flex-1 truncate text-neutral-200 hover:text-neutral-100">
            {m.title || "Untitled mindmap"}
          </Link>
          {detachFrom && m.contained === false && (
            <DetachButton recordId={detachFrom} itemId={m.id} label={m.title} />
          )}
        </li>
      ))}
    </ul>
  );
}
