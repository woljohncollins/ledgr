// The `song` type's canvas (Song module, S3). A server shell that mounts the
// client editor/preview (ChordCanvasClient owns the ChordChart + autosave +
// the Edit ⇄ Preview toggle), then the standard bottom panels reused from the
// default canvas — backlinks, Save Offline, Share, and any custom properties
// (e.g. the workflow Stage). The chord chart itself replaces the markdown
// editor; everything below it is shared.
import ChordCanvasClient from "@/components/canvas/ChordCanvasClient";
import CanvasSection from "@/components/canvas/CanvasSection";
import CustomProperties from "@/components/build/CustomProperties";
import RelatedPanel from "@/components/relations/RelatedPanel";
import RelationProperties from "@/components/relations/RelationProperties";
import ItemUtilitiesFooter from "@/components/canvas/ItemUtilitiesFooter";
import { bodyMarkdown } from "@/lib/body";
import { getType } from "@/lib/types";
import type { CanvasProps } from "@/lib/modules";

export default async function ChordCanvas({ item, ownerId }: CanvasProps) {
  const typeDef = await getType(item.type).catch(() => null);
  const propertySchema = typeDef?.propertySchema ?? [];

  return (
    <>
      <ChordCanvasClient
        itemId={item.id}
        initialTitle={item.title}
        initialBody={item.body}
        initialProperties={item.properties}
      />
      {/* Properties: scalar + relation fields under one header (the canvas
          redesign), matching the default canvas. */}
      {propertySchema.length > 0 && (
        <CanvasSection icon="properties" title="Properties">
          <div className="flex flex-col gap-2">
            <CustomProperties
              itemId={item.id}
              typeKey={item.type}
              schema={propertySchema}
              initial={(item.properties as Record<string, unknown>) ?? {}}
              hideHeading
              bare
            />
            <RelationProperties
              ownerId={ownerId}
              itemId={item.id}
              typeKey={item.type}
              props={propertySchema}
              hideHeading
              bare
            />
          </div>
        </CanvasSection>
      )}
      <RelatedPanel ownerId={ownerId} itemId={item.id} />
      <ItemUtilitiesFooter itemId={item.id} currentText={bodyMarkdown(item.body)} />
    </>
  );
}
