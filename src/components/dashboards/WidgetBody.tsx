// Widget body: renders a widget's content by kind.
//  - view/compact: the cheap list preview (ported from the old DashboardGrid).
//  - view/faithful: the slice-27 ViewRenderer at card scale (mini table/board/
//    calendar/agenda) — reused verbatim, fed the widget's effective view.
//  - stat: a single count.
//  - tree: N parent items, each with its (capped) children listed under it.
//  - embed: an item edited in place (the autosaving editor).
//  - container: a tab/stack/section of child widgets.
//  - action: a create/navigation surface (slice 5).
"use client";

import Link from "next/link";
import { useRowMenu } from "@/components/lists/RowMenu";
import SubtaskCheckbox from "@/components/subtasks/SubtaskCheckbox";
import ViewRenderer, { type ViewItem } from "@/components/views/ViewRenderer";
import { useTimezone } from "@/components/providers/TimezoneProvider";
import ActionWidgetBody from "./ActionWidgetBody";
import ContainerWidget from "./ContainerWidget";
import EmbedWidget from "./EmbedWidget";
import InlineViewAdd from "./InlineViewAdd";
import {
  applySettings,
  hasInlineAdd,
  type ActionWidgetSettings,
  type EmbedWidgetSettings,
  type ImageWidgetSettings,
  type StatWidgetSettings,
  type TextWidgetSettings,
  type TreeWidgetSettings,
  type ViewWidgetSettings,
  type WidgetData,
  type WidgetSettings,
} from "@/lib/dashboard-widgets";

const dueFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

type Assoc = { id: string; title: string; type: string };

// One item row, shared by the view-compact list and the tree's child rows: a
// task gets a check-off circle; the title links to the item; an optional
// "associated with" chip; a due-date stamp.
//
// With `today` set (W1) the row also carries the shared row menu (ADR-142) —
// right-click on desktop, long-press on touch → Complete / Focus / Schedule /
// Trash, each optimistic + undo toast. That's what makes a board an activity
// surface: reschedule an overdue task without leaving it.
//
// useRowMenu rather than the plain <RowMenu> wrapper because this row renders
// its own <li>. RowMenu portals the menu itself, which is what keeps it out of
// the RGL cell's transform and the card's overflow-hidden.
function ItemRow({
  item,
  assoc,
  related,
  today,
}: {
  item: ViewItem;
  assoc?: Assoc;
  related?: Assoc[];
  today?: string;
}) {
  const done = item.statusCategory === "done";
  const isTask = item.type === "task";
  const extra = related && related.length > 1 ? related.length - 1 : 0;
  const { handlers, menu } = useRowMenu({
    id: item.id,
    canComplete: isTask,
    done,
    today,
    label: item.title || "Untitled",
  });
  return (
    <li
      className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2"
      {...(today ? handlers : null)}
    >
      {isTask && (
        <span className="cancel-drag shrink-0">
          <SubtaskCheckbox id={item.id} done={done} />
        </span>
      )}
      <Link
        href={`/items/${item.id}`}
        className={`cancel-drag min-w-0 flex-1 truncate text-sm ${
          item.title ? "text-ink-muted" : "text-ink-subtle"
        } ${done ? "line-through opacity-60" : ""}`}
      >
        {item.title || "Untitled"}
      </Link>
      {assoc && (
        <Link
          href={`/items/${assoc.id}`}
          className="cancel-drag shrink-0 max-w-[40%] truncate rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-ink-muted hover:text-ink"
          title={`Related to ${assoc.title || "Untitled"}${extra ? ` +${extra} more` : ""}`}
        >
          {assoc.title || "Untitled"}
          {extra ? ` +${extra}` : ""}
        </Link>
      )}
      <span className="shrink-0 text-xs text-ink-subtle">
        {item.dueDate ? dueFmt.format(item.dueDate) : ""}
      </span>
      {menu}
    </li>
  );
}

export default function WidgetBody({
  data,
  editMode = false,
  onSettings,
  today,
  focusItemId,
}: {
  data: WidgetData;
  editMode?: boolean;
  onSettings?: (id: string, settings: WidgetSettings) => void;
  // App-timezone today (YYYY-MM-DD). Set → rows are interactive (ADR-142);
  // undefined → plain rows (the Desk's read-only dashboard panel).
  today?: string;
  // The dashboard's focus item, if any — the inline add relates new items to it
  // (the resolver focus-scopes the QUERY only, so an unrelated new item would
  // vanish on the next refresh).
  focusItemId?: string | null;
}) {
  const { widget } = data;
  const tz = useTimezone();

  if (widget.kind === "stat") {
    const s = widget.settings as StatWidgetSettings;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-3">
        {/* Compact on a phone (text-3xl), full on desktop — the audit found a
            stat card ~200px tall for one number. */}
        <span className="text-3xl font-bold tabular-nums text-ink sm:text-4xl">{data.count}</span>
        <span className="truncate text-xs text-ink-subtle">{s.label || data.view?.name || ""}</span>
      </div>
    );
  }

  if (widget.kind === "action") {
    return <ActionWidgetBody settings={widget.settings as ActionWidgetSettings} />;
  }

  if (widget.kind === "embed") {
    const s = widget.settings as EmbedWidgetSettings;
    return <EmbedWidget item={data.embedItem ?? null} showBody={s.showBody} />;
  }

  if (widget.kind === "image") {
    const s = widget.settings as ImageWidgetSettings;
    if (!s.url) {
      return (
        <div className="flex h-full items-center justify-center p-3 text-center text-sm text-neutral-600">
          Open the gear to set an image URL.
        </div>
      );
    }
    const img = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={s.url}
        alt={s.alt}
        className={`h-full w-full ${s.fit === "contain" ? "object-contain" : "object-cover"}`}
      />
    );
    return s.link ? (
      <Link href={s.link} className="cancel-drag block h-full w-full">
        {img}
      </Link>
    ) : (
      <div className="h-full w-full">{img}</div>
    );
  }

  if (widget.kind === "container") {
    // today/focusItemId ride down to the children: a nested widget renders
    // through the same WidgetFrame, so without them its rows lost the row menu
    // and the inline add that the same widget has at the top level (R3/6b).
    return (
      <ContainerWidget
        data={data}
        editMode={editMode}
        today={today}
        focusItemId={focusItemId}
        onContainerChange={(settings) => onSettings?.(widget.id, settings)}
      />
    );
  }

  if (widget.kind === "text") {
    const t = widget.settings as TextWidgetSettings;
    // No reserved space below the heading: the body only renders (with a small
    // top margin) when there's actually body text. Tight vertical padding so a
    // one-row (≈40px) header hugs the heading.
    return (
      <div className="flex flex-col px-3 py-1.5">
        {t.heading && (
          <h2 className="text-lg font-semibold tracking-tight text-neutral-100">{t.heading}</h2>
        )}
        {t.body && (
          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-400">{t.body}</p>
        )}
        {!t.heading && !t.body && (
          <p className="text-sm text-neutral-600">Empty text block — open the gear to add a heading.</p>
        )}
      </div>
    );
  }

  if (widget.kind === "tree") {
    const s = widget.settings as TreeWidgetSettings;
    const parents = data.parents ?? [];
    const byParent = data.childrenByParent ?? {};
    const counts = data.childCountByParent ?? {};
    return (
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
        {parents.length === 0 ? (
          <p className="px-1.5 py-1 text-sm text-neutral-600">No items match.</p>
        ) : (
          parents.map((p) => {
            const kids = byParent[p.id] ?? [];
            const total = counts[p.id] ?? kids.length;
            return (
              <div key={p.id}>
                <div className="flex items-center gap-2 px-1.5">
                  <Link
                    href={`/items/${p.id}`}
                    className={`cancel-drag min-w-0 flex-1 truncate text-sm font-semibold hover:text-neutral-100 ${
                      p.title ? "text-neutral-200" : "text-neutral-500"
                    }`}
                  >
                    {p.title || "Untitled"}
                  </Link>
                  <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                    {total}
                  </span>
                </div>
                <ul className="mt-0.5 flex flex-col gap-0.5 border-l border-neutral-800 pl-2">
                  {kids.length === 0 ? (
                    <li className="px-1.5 py-0.5 text-xs text-neutral-600">
                      {s.hideCompletedChildren ? "No open sub-items" : "No sub-items"}
                    </li>
                  ) : (
                    kids.map((c) => <ItemRow key={c.id} item={c} today={today} />)
                  )}
                  {total > kids.length && (
                    <li className="px-1.5 pt-0.5">
                      <Link
                        href={`/items/${p.id}`}
                        className="cancel-drag text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        +{total - kids.length} more →
                      </Link>
                    </li>
                  )}
                </ul>
              </div>
            );
          })
        )}
        {widget.viewId && data.count > parents.length && (
          <Link
            href={`/views/${widget.viewId}`}
            className="cancel-drag px-1.5 text-xs text-neutral-500 hover:text-neutral-300"
          >
            +{data.count - parents.length} more →
          </Link>
        )}
      </div>
    );
  }

  // view kind
  const settings = widget.settings as ViewWidgetSettings;

  // Inline add (W2): a capture line at the bottom of the widget, automatic
  // wherever the view's filter pins a type — nothing to configure. Hidden in
  // edit mode (arranging is layout work, not capture) and on a read-only body
  // (no `today` = the Desk's dashboard panel, same gate as the row menus).
  // hasInlineAdd is that same rule, shared: WidgetFrame reads it to keep an empty
  // capture widget from folding shut (R3/2), so the two can't drift apart.
  const addFilter = hasInlineAdd(data, editMode, today) ? data.view?.filter : null;
  const inlineAdd =
    addFilter && today ? (
      <InlineViewAdd filter={addFilter} today={today} focusItemId={focusItemId} />
    ) : null;

  if (settings.renderStyle === "faithful" && data.view) {
    const view = applySettings(data.view, settings);
    // W3: a faithful BOARD widget's cards drag between columns, PATCHing the
    // grouped property exactly as /views/[id] does (ViewRenderer owns both the
    // mouse and touch paths). Off in edit mode so card drag and the grid's cell
    // drag never compete, and off without `today` — the same "this dashboard is
    // interactive" gate the row menus and inline add use, so the Desk's
    // read-only dashboard panel stays read-only.
    // Reproduce /views/[id]'s drag guard exactly, not a looser version of it.
    // boardDropPatch writes a SCALAR, so only a status/urgency field grouping or
    // a single-select property is safe: a multi_select would be corrupted into a
    // string. The resolver now carries groupPropKind for that check, and the
    // type's real statuses as groupOrder so a status board's columns are the ones
    // the type actually defines (otherwise a drop writes an undefined status).
    const g = view.grouping;
    const fieldGroup = !g || "field" in g ? (g?.field ?? "status") : null;
    const safeToDrag =
      fieldGroup === "status" || fieldGroup === "urgency" || data.groupPropKind === "select";
    const boardDraggable = !editMode && !!today && view.layout === "board" && safeToDrag;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          <ViewRenderer
            view={view}
            boardDraggable={boardDraggable}
            items={data.items}
            groupOrder={data.groupOrder}
            propertyLabels={data.propertyLabels}
            propertyKinds={data.propertyKinds}
            statuses={data.statuses}
            today={today}
            tz={tz}
          />
        </div>
        {inlineAdd}
      </div>
    );
  }

  // compact list preview
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {data.items.length > 0 ? (
          data.items.map((item) => {
            const rel = data.related?.[item.id] ?? [];
            // Prefer a non-task association (the person/meeting/project a task is
            // tagged to) for the chip; fall back to the first related item.
            const assoc = rel.find((r) => r.type !== "task") ?? rel[0];
            return (
              <ItemRow key={item.id} item={item} assoc={assoc} related={rel} today={today} />
            );
          })
        ) : (
          <li className="px-1.5 py-1 text-sm text-neutral-600">No items match.</li>
        )}
        {widget.viewId && data.count > data.items.length && (
          <li className="px-1.5 pt-1">
            <Link
              href={`/views/${widget.viewId}`}
              className="cancel-drag text-xs text-neutral-500 hover:text-neutral-300"
            >
              +{data.count - data.items.length} more →
            </Link>
          </li>
        )}
      </ul>
      {inlineAdd}
    </div>
  );
}
