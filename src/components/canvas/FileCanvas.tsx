// The file canvas (Files as a first-class citizen, ADR-236): for the `file`
// type, where the item IS the file — the uploaded attachment is the object and
// the markdown body is the owner's description of it (what it is, why it's
// kept, where it came from). The file panel leads, rendered through
// ItemEditor's `fields` slot so it sits between title and body the way the
// longform byline does; open is a new tab on /files/<id> (HTML and PDFs render
// live, ADR-231's private-bucket redirect), Share copies a public link riding
// the item's share token, and the description edits below. Inline preview was
// deliberately deferred (Tyler, 2026-08-29) — Open in a new tab is v1.
//
// Wired to canvasId "file" (module-wiring.tsx) by the files module.
import ItemEditor from "@/components/markdown-editor/ItemEditor";
import MarkdownCanvas from "@/components/canvas/MarkdownCanvas";
import FilePanel from "@/components/attachments/FilePanel";
import RelatedPanel from "@/components/relations/RelatedPanel";
import DiscoverPanel from "@/components/relations/DiscoverPanel";
import ItemUtilitiesFooter from "@/components/canvas/ItemUtilitiesFooter";
import { listAttachments } from "@/lib/attachments";
import { getType } from "@/lib/types";
import { bodyMarkdown } from "@/lib/body";
import type { CanvasProps } from "@/lib/modules";

export default async function FileCanvas(canvasProps: CanvasProps) {
  const { item, ownerId, arrange = false } = canvasProps;
  const typeDef = await getType(item.type).catch(() => null);
  // Customizer override: a saved custom layout or arrange mode uses the default
  // canvas's field-level draggable grid (same escape hatch as LongformCanvas).
  if (arrange || typeDef?.canvasLayout != null) {
    return <MarkdownCanvas {...canvasProps} />;
  }

  const locked = Boolean((item.properties as Record<string, unknown> | null)?.locked);
  const files = await listAttachments(ownerId, item.id);
  files.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // The file panel as the "byline": self-pads to the reading column, matching
  // the editor, so the file sits where a longform item's URL chip would.
  const filePanel = (
    <div className="px-2 pt-1 sm:px-8 md:px-12">
      <div className="border-b border-line pb-3">
        <FilePanel
          itemId={item.id}
          initial={files.map((f) => ({
            id: f.id,
            filename: f.filename,
            contentType: f.contentType,
            sizeBytes: f.sizeBytes,
          }))}
        />
      </div>
    </div>
  );

  return (
    <>
      <ItemEditor
        item={{ id: item.id, title: item.title, body: item.body }}
        fields={filePanel}
        collapsibleToolbar
        locked={locked}
      />
      <RelatedPanel ownerId={ownerId} itemId={item.id} />
      <DiscoverPanel itemId={item.id} anchorTitle={item.title} />
      {/* The Files section stays ON here (Tyler, 2026-09-12): every type other
          than task answers "is a file attached?" in the same place, the
          utilities stack, and a `file` item is where that question gets asked
          most. It repeats the panel above, collapsed and one row wide — the
          lead panel is the file as the OBJECT (ADR-236), this is the item's
          file inventory, and the repetition is cheaper than the one type
          where the answer is somewhere else. */}
      <ItemUtilitiesFooter itemId={item.id} currentText={bodyMarkdown(item.body)} />
    </>
  );
}
