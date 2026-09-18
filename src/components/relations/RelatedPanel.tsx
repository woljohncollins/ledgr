// Related panel (slice 15, PRD §4.9): every item's detail page shows what links
// here — both-direction relations, grouped by type. Server component; the
// queries are body-free and owner-scoped.
//
// Each type group is structured by the owner's chosen LENS and rendered through
// the standard ViewRenderer (the same renderer the list pages and dashboards
// use), scoped with the pre-existing ViewFilter.relatedTo. So sorting, filtering,
// grouping, and the five layouts are the type's own saved lenses/views reused
// verbatim — no parallel machinery. The lens is switched in place from the group
// header (RelatedLensPicker) and persists per host-type + related-type.
//
// Rows keep their relation controls via ViewRenderer's rowActions slot
// (un-relate; the @-mention marker). The relatedTo filter matches CONFIRMED
// edges, so suggested (Phase-2 matcher) edges render in a small separate
// section with the existing confirm/reject row, untouched by the lens path.
//
// Typed relation fields (ADR-067 R4): when this item's type declares relation
// properties (Author, Attendees), their links render under Properties, so we
// claim those items here to keep them out of the type grouping below.
import type { ReactNode } from "react";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items, types } from "@/db/schema";
import { bulkConfigForType } from "@/lib/bulk-config";
import { lensesForType, relatedLensCandidates, relatedLensFor } from "@/lib/list-lenses";
import { MENTION_ROLE } from "@/lib/mentions";
import {
  listRelatedItems,
  outgoingRelationsByRole,
  type RelatedItem,
} from "@/lib/relations";
import { resolveRelatedGroup } from "@/lib/related-views";
import { formatPassageRef, passageSlug } from "@/lib/passages/ref";
import { resolvePassageRefs } from "@/lib/passages/refs";
import { getSettings } from "@/lib/settings";
import { compareTypeKeys } from "@/lib/type-order";
import { getType } from "@/lib/types";
import { canvasIdForType } from "@/lib/modules";
import CanvasSection from "@/components/canvas/CanvasSection";
import AddRelation from "./AddRelation";
import NewRelatedTask from "./NewRelatedTask";
import RelatedGroupView from "./RelatedGroupView";
import RelatedRow, { type RelatedRowItem } from "./RelatedRow";
import RelationActions from "./RelationActions";

const UNMARKED = "unmarked";

export default async function RelatedPanel({
  ownerId,
  itemId,
  // Rendered as a grid card (ADR-069): drop the CanvasSection card chrome and the
  // centered column so the grid's own card wraps it.
  bare = false,
  // The host canvas renders its own People surface (the task rail's PeopleRow,
  // ADR-175), so confirmed persons are claimed there and don't repeat here.
  // Prop-driven (not host-type-driven) because only the bespoke task canvas has
  // the row — the ADR-069 grid layout for the same type does not.
  claimPersons = false,
  // Whether this panel owns the "+ Relate" / "+ Task" affordances. The task
  // canvas turns them OFF (ADR-253) and carries a "Linked" row in its rail
  // instead, beside Project / Tags / People — which are relation edges too, so
  // the add lives with its siblings rather than as an unlabelled button floating
  // under the body. With no links yet this panel then renders nothing at all.
  addBar: showAddBar = true,
}: {
  ownerId: string;
  itemId: string;
  bare?: boolean;
  claimPersons?: boolean;
  addBar?: boolean;
}) {
  const [related, typeRows, hostRows, settings, passages] = await Promise.all([
    listRelatedItems(ownerId, itemId),
    getDb().select({ key: types.key, label: types.label }).from(types),
    getDb()
      .select({ type: items.type })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.ownerId, ownerId))),
    getSettings(ownerId),
    // Passage @/refs authored in the body (ADR-149). Body-owned like mentions, so
    // these render as read-only chips to the passage page — no un-relate control.
    resolvePassageRefs(ownerId, itemId),
  ]);

  const hostType = hostRows[0]?.type ?? "";
  // This item's type → its relation fields + its canvas (both read below too).
  const hostDef = hostType ? await getType(hostType).catch(() => null) : null;

  // The add affordances ride along whether or not anything is linked yet.
  // "+ Task" is back everywhere EXCEPT tasks and project-shaped records (Tyler,
  // 2026-09-12). The 2026-09-11 removal was too wide: on a note, a person or a
  // meeting, "add a task about this" is the point of the panel and there is no
  // "Add subtask" beside it to confuse it with. Where there IS one — a task
  // (subtasks) or a widget-home record like Project/Pursuit (its own Tasks
  // widget) — a second, subtly different "new task" button is the duplicate
  // that started this, so it stays hidden there.
  const showNewTask =
    hostType !== "task" &&
    canvasIdForType(hostType, ownerId, hostDef?.capability) !== "widgets";
  const addBar = (
    <div className="flex flex-wrap items-center gap-1">
      <AddRelation itemId={itemId} />
      {showNewTask && <NewRelatedTask hostId={itemId} />}
    </div>
  );

  const emptyState = bare ? (
    <>{addBar}</>
  ) : (
    <div className="mx-auto w-full max-w-3xl px-2 pt-2 sm:px-8 md:px-12">{addBar}</div>
  );

  // Nothing linked yet: just the quiet add affordances, no section chrome — or
  // nothing whatsoever when the host owns the add affordance itself.
  if (related.length === 0 && passages.length === 0) {
    return showAddBar ? emptyState : null;
  }

  const labels = new Map(typeRows.map((t) => [t.key, t.label]));

  // hostType/hostDef are resolved above (the add bar needs them before the
  // nothing-linked-yet return). This item's relation fields render under
  // Properties, so claim those items here to avoid listing them twice.
  const relationFields = (hostDef?.propertySchema ?? []).filter((p) => p.kind === "relation");
  const byRole = relationFields.length
    ? await outgoingRelationsByRole(ownerId, itemId, relationFields.map((f) => f.key))
    : new Map<string, { id: string }[]>();
  const relatedById = new Map(related.map((r) => [r.id, r]));
  const claimed = new Set<string>();
  for (const f of relationFields) {
    for (const t of byRole.get(f.key) ?? []) {
      if (relatedById.has(t.id)) claimed.add(t.id);
    }
  }
  // On an event, the People card (ADR-144) owns EVERY person and group —
  // attending, absent, ghosts, groups, and the "Also mentioned" line — so none
  // of them repeat down here. This is what retires the old three-list split.
  if (hostType === "event") {
    for (const r of related) {
      if (r.type === "person" || r.type === "group") claimed.add(r.id);
    }
  }
  // The task canvas's People row (ADR-175) owns confirmed persons the same way.
  // Suggested person edges stay below — confirm/reject lives in this panel.
  if (claimPersons) {
    for (const r of related) {
      if (r.type === "person" && r.matchState !== "suggested") claimed.add(r.id);
    }
  }

  // Suggested edges render with the existing confirm/reject row (the relatedTo
  // view filter is confirmed-only). Everything else groups by type for the lens.
  const unclaimed = related.filter((r) => !claimed.has(r.id));
  // The THIRD place this panel can bail out, and the one that kept "+ Relate"
  // alive on the task canvas after the other two were gated: an item can HAVE
  // relations and still have nothing to list here, because its typed fields
  // (Project, Tags) and People claimed them all. It must respect `addBar` like
  // the other two exits, or a host that owns its own add affordance gets a
  // stray one back exactly when every link is accounted for elsewhere.
  if (unclaimed.length === 0 && passages.length === 0) {
    return showAddBar ? emptyState : null;
  }
  const suggested = unclaimed.filter((r) => r.matchState === "suggested");
  const confirmed = unclaimed.filter((r) => r.matchState !== "suggested");

  const byType = new Map<string, RelatedItem[]>();
  for (const item of confirmed) {
    const group = byType.get(item.type);
    if (group) group.push(item);
    else byType.set(item.type, [item]);
  }
  const typeGroups = [...byType.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === UNMARKED) return 1;
    if (b === UNMARKED) return -1;
    return compareTypeKeys(a, b);
  });

  // Per-group relation controls (un-relate + the @-mention marker), keyed by id,
  // handed to ViewRenderer's rowActions slot. mention-only rows have no remove
  // control (the body owns that edge).
  const rowActionsFor = (group: RelatedItem[]): Record<string, ReactNode> => {
    const out: Record<string, ReactNode> = {};
    for (const r of group) {
      const mentionOnly = r.roles.every((role) => role === MENTION_ROLE);
      out[r.id] = (
        <span className="flex shrink-0 items-center gap-2">
          {r.roles.includes(MENTION_ROLE) && (
            <span title="Linked by an @-mention in the body" className="text-xs text-neutral-600">
              @
            </span>
          )}
          <RelationActions itemId={itemId} otherId={r.id} suggested={false} removable={!mentionOnly} />
        </span>
      );
    }
    return out;
  };

  // Resolve each group's lens + items in parallel. A chosen view lens that was
  // deleted resolves to null; fall back to the type's default (first) lens.
  const groups = await Promise.all(
    typeGroups.map(async (key) => {
      // Bespoke lenses (calendar/timeline) are list-page-only; the related panel
      // offers and defaults to sort/view lenses only.
      const lenses = relatedLensCandidates(lensesForType(settings, key));
      let lens = relatedLensFor(settings, hostType, key);
      // Generic sort lenses hide completed items (the panel reads as live work);
      // a view lens owns its own status filter, so leave it to show what it filters.
      let data = await resolveRelatedGroup(ownerId, itemId, key, lens, lens.kind === "sort");
      if (!data) {
        lens = lenses[0];
        data = await resolveRelatedGroup(ownerId, itemId, key, lens, lens.kind === "sort");
      }
      // Multi-select for the group (ADR-118): a related group is always one type,
      // so it gets that type's full bulk actions (status/date/select + Move +
      // Delete), not a mixed surface's Move+Delete. A type that fails to resolve
      // (best-effort load) just renders read-only.
      const typeDef = await getType(key).catch(() => null);
      const bulkConfig = typeDef ? bulkConfigForType(typeDef) : undefined;
      return {
        key,
        lenses,
        lensId: lens.id,
        data,
        rowActions: rowActionsFor(byType.get(key)!),
        bulkConfig,
      };
    })
  );
  const renderGroups = groups.filter((g) => g.data);

  const totalCount =
    renderGroups.reduce((n, g) => n + (g.data?.count ?? 0), 0) +
    suggested.length +
    passages.length;

  const body = (
    <>
      {renderGroups.map((g) => (
        <RelatedGroupView
          key={g.key}
          hostType={hostType}
          typeKey={g.key}
          label={labels.get(g.key) ?? g.key}
          lenses={g.lenses}
          currentLensId={g.lensId}
          data={g.data!}
          rowActions={g.rowActions}
          bulkConfig={g.bulkConfig}
        />
      ))}
      {suggested.length > 0 && (
        <div className="mt-4">
          <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Suggested
            <span className="ml-2 font-normal text-ink-subtle">{suggested.length}</span>
          </h3>
          <ul className="mt-1">
            {suggested.map((r) => {
              const row: RelatedRowItem = {
                id: r.id,
                type: r.type,
                title: r.title,
                status: r.status,
                statusCategory: r.statusCategory,
                dueDate: r.dueDate ? r.dueDate.toISOString() : null,
                updatedAt: r.updatedAt.toISOString(),
              };
              return (
                <RelatedRow
                  key={r.id}
                  hostId={itemId}
                  item={row}
                  suggested
                  mention={r.roles.includes(MENTION_ROLE)}
                  mentionOnly={r.roles.every((role) => role === MENTION_ROLE)}
                />
              );
            })}
          </ul>
        </div>
      )}
      {passages.length > 0 && (
        <div className="mt-4">
          <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Passages
            <span className="ml-2 font-normal text-ink-subtle">{passages.length}</span>
          </h3>
          <ul className="mt-1 flex flex-wrap gap-1.5 px-2">
            {passages.map((p) => (
              <li key={p.id}>
                <a
                  href={`/passage/${passageSlug(p.startRef, p.endRef)}`}
                  className="inline-flex items-center rounded-card border border-line bg-surface-2 px-2 py-0.5 text-sm text-ink hover:border-line-strong"
                >
                  {formatPassageRef(p.startRef, p.endRef)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showAddBar && <div className="mt-4">{addBar}</div>}
    </>
  );

  if (bare) return body;
  return (
    <CanvasSection icon="affiliate" title="Linked here" count={totalCount}>
      {body}
    </CanvasSection>
  );
}
