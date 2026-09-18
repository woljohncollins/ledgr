// The typed-relation panel on the item canvas (ADR-067 R2): renders a type's
// `relation` property fields (Author, Attendees, References) as link boxes.
// Server component — it fetches each field's current links in one query
// (outgoingRelationsByRole: edges from this item whose role is the field key)
// and resolves target-type labels, then hands each field to the client
// RelationField. Sits beside the scalar CustomProperties panel; both read the
// same type.property_schema, split by kind in MarkdownCanvas.
import { getDb } from "@/db";
import { types } from "@/db/schema";
import { outgoingRelationsByRole } from "@/lib/relations";
import type { PropertyDef } from "@/lib/types";
import InlineLabel from "@/components/build/InlineLabel";
import NavGlyph from "@/components/nav/NavGlyph";
import RelationField from "./RelationField";

export default async function RelationProperties({
  ownerId,
  itemId,
  typeKey,
  props,
  hideHeading = false,
  bare = false,
  rail = false,
}: {
  ownerId: string;
  itemId: string;
  typeKey: string;
  props: PropertyDef[];
  // Drop the "Relations" section heading when rendered as a single per-field
  // card (ADR-069) — the field's own label names it (Brandon, 2026-06-17).
  hideHeading?: boolean;
  // Drop the wide centered-column padding so it sits flush in a narrow rail
  // (the task canvas right pane) instead of the full-width classic canvas.
  bare?: boolean;
  // Todoist-style rail sections (Tyler, 2026-08-18): each field is its own
  // hairline-divided section whose label line RelationField draws itself, with
  // the "+" add on the right — replacing the dt/dd rows and the link glyph.
  rail?: boolean;
}) {
  const relationProps = props.filter((p) => p.kind === "relation");
  if (relationProps.length === 0) return null;

  const [byRole, typeRows] = await Promise.all([
    outgoingRelationsByRole(
      ownerId,
      itemId,
      relationProps.map((p) => p.key)
    ),
    getDb().select({ key: types.key, label: types.label }).from(types),
  ]);
  const labels = new Map(typeRows.map((t) => [t.key, t.label]));

  if (rail) {
    return (
      <>
        {relationProps.map((prop) => (
          <div key={prop.key} className="border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0">
            <RelationField
              itemId={itemId}
              role={prop.key}
              targetType={prop.targetType ?? null}
              targetTypeLabel={prop.targetType ? (labels.get(prop.targetType) ?? null) : null}
              cardinality={prop.cardinality ?? "many"}
              initial={(byRole.get(prop.key) ?? []).map((r) => ({ id: r.id, title: r.title }))}
              heading={<InlineLabel typeKey={typeKey} propertyKey={prop.key} label={prop.label} />}
            />
          </div>
        ))}
      </>
    );
  }

  return (
    <section className={bare ? "" : "mx-auto w-full max-w-3xl px-2 pb-6 pt-2 sm:px-8 md:px-12"}>
      {!hideHeading && (
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600">
          Relations
        </h2>
      )}
      <dl className="flex flex-col gap-2">
        {relationProps.map((prop) => (
          // Stacked label in the narrow rail, side-by-side column on the wide
          // canvas — see the note in CustomProperties.renderRow.
          <div
            key={prop.key}
            className={`text-sm ${bare ? "flex flex-col gap-0.5" : "flex items-start gap-3"}`}
          >
            <dt className={bare ? "text-neutral-500" : "w-32 shrink-0 pt-1 text-neutral-500"}>
              {/* A link glyph marks this as a relational property — a field whose
                  value points at other items — distinct from scalar properties
                  in the same Properties panel (the canvas redesign). The Tags
                  field gets the tag glyph instead of the chain (Tyler). */}
              <span className="inline-flex items-center gap-1.5">
                <NavGlyph
                  icon={
                    /^tags?$/i.test(prop.key) ||
                    prop.targetType === "tag" ||
                    /^tags?$/i.test(prop.label ?? "")
                      ? "tag"
                      : "links"
                  }
                  size={12}
                  className="shrink-0 text-[var(--accent)]"
                />
                <InlineLabel
                  typeKey={typeKey}
                  propertyKey={prop.key}
                  label={prop.label}
                />
              </span>
            </dt>
            <dd className="min-w-0 flex-1">
              <RelationField
                itemId={itemId}
                role={prop.key}
                targetType={prop.targetType ?? null}
                targetTypeLabel={
                  prop.targetType ? (labels.get(prop.targetType) ?? null) : null
                }
                cardinality={prop.cardinality ?? "many"}
                initial={(byRole.get(prop.key) ?? []).map((r) => ({
                  id: r.id,
                  title: r.title,
                }))}
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
