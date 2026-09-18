// The task rail's bespoke People row (ADR-175). "Is a person connected to this
// item?" has exactly one answer: any confirmed edge to a person item, whichever
// writer created it (the inbox chip, MCP relateTo, a promoted action item, or
// + Add right here). So unlike a typed relation field — which owns a single
// role — this reads role-blind and both-direction (listRelatedItems) and edits
// through the generic RelationField (null role: adds write the default
// 'related' edge, removes are role-blind). Persons linked only by a body
// @-mention render as read-only chips, since the body owns that edge.
import Link from "next/link";
import { MENTION_ROLE } from "@/lib/mentions";
import { listRelatedItems } from "@/lib/relations";
import NavGlyph from "@/components/nav/NavGlyph";
import RelationField from "./RelationField";

export default async function PeopleRow({
  ownerId,
  itemId,
  bare = false,
  rail = false,
}: {
  ownerId: string;
  itemId: string;
  // Stack the label above its value instead of holding a fixed 128px label
  // column — the narrow-rail layout its sibling property rows use.
  bare?: boolean;
  // Todoist-style rail section (Tyler, 2026-08-18): RelationField draws the
  // "People" label line itself with the "+" add on the right; mention-only
  // persons ride along as its read-only chips.
  rail?: boolean;
}) {
  const related = await listRelatedItems(ownerId, itemId);
  const people = related.filter(
    (r) => r.type === "person" && r.matchState === "confirmed"
  );
  const mentionOnly = people.filter((p) =>
    p.roles.every((r) => r === MENTION_ROLE)
  );
  const editable = people.filter((p) => p.roles.some((r) => r !== MENTION_ROLE));

  if (rail) {
    return (
      <RelationField
        itemId={itemId}
        role={null}
        targetType="person"
        targetTypeLabel="Person"
        cardinality="many"
        initial={editable.map((p) => ({ id: p.id, title: p.title }))}
        heading="People"
        readOnlyChips={mentionOnly.map((p) => ({
          id: p.id,
          title: p.title,
          hint: "Linked by an @-mention in the body",
        }))}
      />
    );
  }

  // Own <dl> wrapper: this renders as a sibling of RelationProperties' list,
  // and a bare <dt>/<dd> outside a <dl> is invalid markup.
  return (
    <dl className={`text-sm ${bare ? "flex flex-col gap-0.5" : "flex items-start gap-3"}`}>
      <dt className={bare ? "text-neutral-500" : "w-32 shrink-0 pt-1 text-neutral-500"}>
        <span className="inline-flex items-center gap-1.5">
          <NavGlyph
            icon="person"
            size={12}
            className="shrink-0 text-[var(--accent)]"
          />
          People
        </span>
      </dt>
      <dd className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {mentionOnly.map((p) => (
            <Link
              key={p.id}
              href={`/items/${p.id}`}
              title="Linked by an @-mention in the body"
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-neutral-700 bg-neutral-800/60 px-2 py-0.5 text-sm text-neutral-200 hover:underline"
            >
              <span className="text-neutral-500">@</span>
              <span className="max-w-[12rem] truncate">
                {p.title || "Untitled"}
              </span>
            </Link>
          ))}
          <RelationField
            itemId={itemId}
            role={null}
            targetType="person"
            targetTypeLabel="Person"
            cardinality="many"
            initial={editable.map((p) => ({ id: p.id, title: p.title }))}
          />
        </div>
      </dd>
    </dl>
  );
}
