// Shared longform canvas (item-view refresh, bespoke-first per Principle 6): a
// document-shaped view for prose types where the markdown body is the star —
// notes, links, journal, prayer, logos notes, email, transcripts, and any type
// that attaches the `longform` capability. The body runs the full reading
// column; the item's metadata sits in one intentional "byline" under the title
// (a clickable URL when it has one, its date, tags/relation fields inline,
// custom scalars beneath), rendered through ItemEditor's own `fields` slot so it
// aligns with the title and body. System fields (type/created/updated) are
// chrome, shown on the item chrome row (ItemCanvas), not here.
//
// Wired to canvasId "longform" (module-wiring.tsx). Core types point at it via
// their CORE_TYPES canvasId (note, link); user types via the `longform`
// capability. The grid customizer stays the per-type override: a saved custom
// layout — or arrange mode (?arrange=1) — delegates to the default canvas's
// draggable grid, like TaskCanvas.
import ItemEditor from "@/components/markdown-editor/ItemEditor";
import MarkdownCanvas from "@/components/canvas/MarkdownCanvas";
import FieldStrip, { type StripValues } from "@/components/canvas/FieldStrip";
import CustomProperties from "@/components/build/CustomProperties";
import RelationField from "@/components/relations/RelationField";
import RelatedPanel from "@/components/relations/RelatedPanel";
import DiscoverPanel from "@/components/relations/DiscoverPanel";
import ItemUtilitiesFooter from "@/components/canvas/ItemUtilitiesFooter";
import NavGlyph from "@/components/nav/NavGlyph";
import SmartHref from "@/components/ui/SmartHref";
import { getDb } from "@/db";
import { types } from "@/db/schema";
import { outgoingRelationsByRole } from "@/lib/relations";
import { topStripFields } from "@/lib/canvas-fields";
import { getType } from "@/lib/types";
import { resolveStatusSchema } from "@/lib/status";
import { appTodayYmd } from "@/lib/recurrence-service";
import { bodyMarkdown } from "@/lib/body";
import type { CanvasProps } from "@/lib/modules";

export default async function LongformCanvas(canvasProps: CanvasProps) {
  const { item, ownerId, arrange = false } = canvasProps;
  const typeDef = await getType(item.type).catch(() => null);
  // Customizer override: a saved custom layout or arrange mode uses the default
  // canvas's field-level draggable grid (the per-type "change it by type" path).
  if (arrange || typeDef?.canvasLayout != null) {
    return <MarkdownCanvas {...canvasProps} />;
  }

  const locked = Boolean((item.properties as Record<string, unknown> | null)?.locked);
  // The URL renders as a clickable chip in the byline (link, and any URL type),
  // so drop it from the editable field strip WHEN SET, to avoid showing it
  // twice. A URL-less item keeps the field — otherwise a fresh link's page had
  // no way to set (or upload, ADR-237) its URL at all.
  const fields = topStripFields(item.type).filter((f) => f !== "url" || !item.url);
  const strip: StripValues = {
    status: item.status,
    dueDate: item.dueDate?.toISOString() ?? null,
    scheduledDate: item.scheduledDate?.toISOString() ?? null,
    urgency: item.urgency,
    meetingAt: item.meetingAt?.toISOString() ?? null,
    noteDate: item.noteDate?.toISOString() ?? null,
    url: item.url,
  };
  const today = appTodayYmd();
  const statuses = resolveStatusSchema(typeDef?.statusSchema ?? null);
  // A longform document enables tabs (ADR-095) itself, so a type wanting both a
  // document layout and tabs attaches only the `longform` capability (the single
  // capability slot can't also hold `tabs`). Harmless when unused — the tab
  // affordance simply goes untouched and the body renders as one section.
  const tabsEnabled = true;
  const propertySchema = typeDef?.propertySchema ?? [];
  const scalarFields = propertySchema.filter((p) => p.kind !== "relation");
  const relationFields = propertySchema.filter((p) => p.kind === "relation");

  const [byRole, typeRows] = relationFields.length
    ? await Promise.all([
        outgoingRelationsByRole(ownerId, item.id, relationFields.map((f) => f.key)),
        getDb().select({ key: types.key, label: types.label }).from(types),
      ])
    : [new Map<string, { id: string; title: string }[]>(), [] as { key: string; label: string }[]];
  const typeLabels = new Map(typeRows.map((t) => [t.key, t.label]));

  const showUrl = Boolean(item.url);
  const hasByline = showUrl || fields.length > 0 || relationFields.length > 0 || scalarFields.length > 0;

  // The byline: one intentional row of the item's own metadata, under the title.
  // Rendered through ItemEditor's `fields` slot (below) so it aligns with the
  // title and body. Self-pads to the reading column, matching the editor.
  const byline = hasByline ? (
    <div className="px-2 pt-1 sm:px-8 md:px-12">
      <div className="flex flex-col gap-2 border-b border-line pb-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
          {showUrl && (
            // SmartHref: file:// URLs copy-on-click (a web page can't open
            // them); everything else opens in a new tab as before.
            <SmartHref
              href={item.url!}
              title={item.url!}
              className="inline-flex max-w-full items-center gap-1.5 rounded-card border border-line bg-surface-1 px-2.5 py-0.5 text-[var(--accent)] hover:border-line-strong hover:brightness-110"
            >
              <span className="truncate">{item.url}</span>
              <NavGlyph icon="external-link" size={12} className="shrink-0 text-ink-subtle" />
            </SmartHref>
          )}
          {fields.length > 0 && (
            <FieldStrip itemId={item.id} fields={fields} initial={strip} today={today} statuses={statuses} locked={locked} flush />
          )}
          {relationFields.map((f) => (
            <span key={f.key} className="inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-xs text-ink-subtle">
                <NavGlyph icon={f.targetType === "tag" ? "tag" : "links"} size={12} className="text-[var(--accent)]" />
                {f.label}
              </span>
              <RelationField
                itemId={item.id}
                role={f.key}
                targetType={f.targetType ?? null}
                targetTypeLabel={f.targetType ? (typeLabels.get(f.targetType) ?? null) : null}
                cardinality={f.cardinality ?? "many"}
                initial={(byRole.get(f.key) ?? []).map((r) => ({ id: r.id, title: r.title }))}
              />
            </span>
          ))}
        </div>
        {scalarFields.length > 0 && (
          <CustomProperties itemId={item.id} typeKey={item.type} schema={scalarFields} initial={(item.properties as Record<string, unknown>) ?? {}} locked={locked} hideHeading bare />
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <ItemEditor
        item={{ id: item.id, title: item.title, body: item.body }}
        fields={byline}
        tabsEnabled={tabsEnabled}
        collapsibleToolbar
        locked={locked}
      />
      {/* Full-width below the editor: the connected-data web, deterministic
          suggestions, and the shared export/history utilities. */}
      <RelatedPanel ownerId={ownerId} itemId={item.id} />
      <DiscoverPanel itemId={item.id} anchorTitle={item.title} />
      <ItemUtilitiesFooter itemId={item.id} currentText={bodyMarkdown(item.body)} />
    </>
  );
}
