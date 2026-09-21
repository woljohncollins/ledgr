// Per-widget settings (the gear, edit mode only). A small popover anchored to
// the gear button — matches the ConfirmButton chrome (dark panel, outside-click
// / Esc close). Split into two tabs: Data (the per-kind fields, onChange → the
// full new settings, plus the "Shows" view picker for the view-backed kinds →
// onViewChange) and Appearance (onAppearance → the full new appearance:
// header/border/background/accent/collapse). Nothing here mutates the backing
// view; the parent persists + refetches where the change affects data.
"use client";

import { useEffect, useState, type RefObject } from "react";
import {
  CHILD_SOURCES,
  CONTAINER_MODES,
  effectiveAppearance,
  WIDGET_ACCENTS,
  WIDGET_BACKGROUNDS,
  type ActionKind,
  type ActionWidgetSettings,
  type ChildSource,
  type ContainerMode,
  type ContainerWidgetSettings,
  type DashboardWidget,
  type EmbedWidgetSettings,
  type ImageFit,
  type ImageWidgetSettings,
  type RenderStyle,
  type StatWidgetSettings,
  type TextWidgetSettings,
  type TreeWidgetSettings,
  type ViewWidgetSettings,
  type WidgetAccent,
  type WidgetAppearance,
  type WidgetBackground,
  type WidgetKind,
  type WidgetSettings,
} from "@/lib/dashboard-widgets";
import { SWATCH_DOT } from "./appearance-styles";
import { FloatingMenu, type PopoverPos } from "./floating-menu";

// Client-safe copy of the view sort fields (views.ts is server-only). The stored
// values are the wire format — only the labels are human.
const SORT_FIELD_OPTS = ["updatedAt", "createdAt", "dueDate", "meetingAt", "title"] as const;
const SORT_FIELD_LABELS: Record<(typeof SORT_FIELD_OPTS)[number], string> = {
  updatedAt: "Updated",
  createdAt: "Created",
  dueDate: "Due date",
  meetingAt: "Event date",
  title: "Title",
};
// The kinds backed by a saved view (widget.viewId) → they get the "Shows" picker.
const VIEW_BACKED = new Set<WidgetKind>(["view", "stat", "tree"]);
const KIND_LABELS: Record<WidgetKind, string> = {
  view: "List",
  stat: "Count",
  tree: "Nested list",
  embed: "Embedded item",
  image: "Image",
  container: "Container",
  text: "Text",
  action: "Action",
};
const ITEM_LIMIT_OPTS = [5, 10, 15, 20, 50] as const;
const PARENT_LIMIT_OPTS = [3, 5, 8, 10] as const;
const CHILD_LIMIT_OPTS = [3, 5, 10, 20] as const;
const ACTION_OPTS: { value: ActionKind; label: string }[] = [
  { value: "quick-capture", label: "Quick capture" },
  { value: "new-from-template", label: "New from template" },
  { value: "link", label: "Link" },
];
const CONTAINER_MODE_LABELS: Record<ContainerMode, string> = {
  tabs: "Tabs",
  stack: "Stack",
  section: "Section",
};
const CHILD_SOURCE_LABELS: Record<ChildSource, string> = {
  children: "Sub-items (hierarchy)",
  relation: "Related by role",
};

const field = "text-xs text-neutral-400";
const input =
  "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-200";

export default function WidgetSettingsPopover({
  widget,
  pos,
  anchorRef,
  onChange,
  onAppearance,
  onViewChange,
  onClose,
}: {
  widget: DashboardWidget;
  pos: PopoverPos | null;
  anchorRef: RefObject<HTMLElement | null>;
  onChange: (settings: WidgetSettings) => void;
  onAppearance: (appearance: WidgetAppearance) => void;
  // Repoint a view-backed widget at a different saved view (patches viewId, which
  // `onChange` can't carry). Optional: the "Shows" picker hides itself where no
  // handler is threaded (container children, the Desk's read-only panel).
  onViewChange?: (viewId: string) => void;
  onClose: () => void;
}) {
  const viewBacked = VIEW_BACKED.has(widget.kind);
  const views = useOwnerViews(viewBacked);
  const [tab, setTab] = useState<"data" | "appearance">("data");
  const viewName = views?.find((v) => v.id === widget.viewId)?.name;

  return (
    <FloatingMenu
      pos={pos}
      // Keep in step with WidgetFrame's usePopoverPosition(300) — a measurement
      // narrower than the real width puts the panel off-screen at the right edge.
      width={300}
      anchorRef={anchorRef}
      onClose={onClose}
      className="cancel-drag rounded-card border border-line bg-surface-1 p-3 shadow-xl"
    >
      <div className="flex items-baseline gap-2 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          {KIND_LABELS[widget.kind]}
        </span>
        {viewName && <span className="min-w-0 truncate text-xs text-ink-muted">{viewName}</span>}
      </div>
      <div className="mb-2 flex gap-1 rounded-card bg-surface-2 p-0.5">
        {(["data", "appearance"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 rounded px-2 py-1 text-xs ${
              tab === t ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {t === "data" ? "Data" : "Appearance"}
          </button>
        ))}
      </div>
      {tab === "data" ? (
        <div className="flex flex-col gap-2">
          {viewBacked && onViewChange && (
            <label className={field}>
              Shows
              <select
                value={widget.viewId ?? ""}
                onChange={(e) => e.target.value && onViewChange(e.target.value)}
                className={input}
              >
                <option value="">{views === null ? "Loading views…" : "Select a view…"}</option>
                {/* Keep a missing/stale current view selectable so it isn't lost. */}
                {widget.viewId && !views?.some((v) => v.id === widget.viewId) && (
                  <option value={widget.viewId}>(current view)</option>
                )}
                {views?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {renderFields(widget, onChange)}
        </div>
      ) : (
        <AppearanceSection widget={widget} onAppearance={onAppearance} />
      )}
    </FloatingMenu>
  );
}

// The owner's saved views (id + name), for the "Shows" picker and the header's
// view name. Fetched only for the view-backed kinds.
function useOwnerViews(enabled: boolean) {
  const [views, setViews] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetch("/api/views")
      .then((r) => r.json())
      .then((d: { views: { id: string; name: string }[] }) => {
        if (alive) setViews(d.views);
      })
      .catch(() => {
        if (alive) setViews([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return views;
}

function renderFields(widget: DashboardWidget, onChange: (s: WidgetSettings) => void) {
  if (widget.kind === "view") {
    const s = widget.settings as ViewWidgetSettings;
    return (
      <>
        <label className={field}>
          Render
          <select
            value={s.renderStyle}
            onChange={(e) => onChange({ ...s, renderStyle: e.target.value as RenderStyle })}
            className={input}
          >
            <option value="compact">Compact list</option>
            <option value="faithful">Faithful layout</option>
          </select>
        </label>
        <label className={field}>
          Items shown
          <select
            value={s.itemLimit ?? ""}
            onChange={(e) =>
              onChange({ ...s, itemLimit: e.target.value ? Number(e.target.value) : null })
            }
            className={input}
          >
            <option value="">Default</option>
            {ITEM_LIMIT_OPTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={s.hideWhenEmpty ?? false}
            onChange={(e) => onChange({ ...s, hideWhenEmpty: e.target.checked })}
          />
          Hide this card when it has nothing to show
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={s.hideAdd ?? false}
            onChange={(e) => onChange({ ...s, hideAdd: e.target.checked })}
          />
          No &quot;+ Add&quot; row (read-only card)
        </label>
        <SortField
          value={s.sortOverride}
          onChange={(sortOverride) => onChange({ ...s, sortOverride })}
        />
        <label className={field}>
          Title
          <input
            type="text"
            value={s.titleOverride ?? ""}
            placeholder="(view name)"
            onChange={(e) => onChange({ ...s, titleOverride: e.target.value || null })}
            className={input}
          />
        </label>
      </>
    );
  }

  if (widget.kind === "stat") {
    const s = widget.settings as StatWidgetSettings;
    return (
      <label className={field}>
        Label
        <input
          type="text"
          value={s.label}
          placeholder="(view name)"
          onChange={(e) => onChange({ ...s, label: e.target.value })}
          className={input}
        />
      </label>
    );
  }

  if (widget.kind === "tree") {
    return <TreeFields s={widget.settings as TreeWidgetSettings} onChange={onChange} />;
  }

  if (widget.kind === "embed") {
    const s = widget.settings as EmbedWidgetSettings;
    return (
      <label className="flex items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={s.showBody}
          onChange={(e) => onChange({ ...s, showBody: e.target.checked })}
        />
        Show the item body
        <span className="text-neutral-600">(off = title only)</span>
      </label>
    );
  }

  if (widget.kind === "image") {
    const s = widget.settings as ImageWidgetSettings;
    return (
      <>
        <label className={field}>
          Image URL
          <input
            type="text"
            value={s.url}
            placeholder="https://…"
            onChange={(e) => onChange({ ...s, url: e.target.value })}
            className={input}
          />
        </label>
        <label className={field}>
          Alt text
          <input
            type="text"
            value={s.alt}
            placeholder="describe the image"
            onChange={(e) => onChange({ ...s, alt: e.target.value })}
            className={input}
          />
        </label>
        <label className={field}>
          Fit
          <select
            value={s.fit}
            onChange={(e) => onChange({ ...s, fit: e.target.value as ImageFit })}
            className={input}
          >
            <option value="cover">Cover (fill + crop)</option>
            <option value="contain">Contain (whole image)</option>
          </select>
        </label>
        <label className={field}>
          Link (optional)
          <input
            type="text"
            value={s.link ?? ""}
            placeholder="/path or https://…"
            onChange={(e) => onChange({ ...s, link: e.target.value || null })}
            className={input}
          />
        </label>
        <p className="text-[11px] text-neutral-600">
          For an uploaded image, embed a note and paste into it.
        </p>
      </>
    );
  }

  if (widget.kind === "container") {
    const s = widget.settings as ContainerWidgetSettings;
    return (
      <>
        <label className={field}>
          Layout
          <select
            value={s.mode}
            onChange={(e) => onChange({ ...s, mode: e.target.value as ContainerMode })}
            className={input}
          >
            {CONTAINER_MODES.map((m) => (
              <option key={m} value={m}>
                {CONTAINER_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className={field}>
          Title
          <input
            type="text"
            value={s.title}
            placeholder="Group"
            onChange={(e) => onChange({ ...s, title: e.target.value })}
            className={input}
          />
        </label>
        <p className="text-[11px] text-neutral-600">Add widgets to this group from inside it.</p>
      </>
    );
  }

  if (widget.kind === "text") {
    const s = widget.settings as TextWidgetSettings;
    return (
      <>
        <label className={field}>
          Heading
          <input
            type="text"
            value={s.heading}
            placeholder="Section title"
            onChange={(e) => onChange({ ...s, heading: e.target.value })}
            className={input}
          />
        </label>
        <label className={field}>
          Note
          <textarea
            value={s.body}
            rows={4}
            placeholder="Optional text…"
            onChange={(e) => onChange({ ...s, body: e.target.value })}
            className={input}
          />
        </label>
      </>
    );
  }

  // action
  return <ActionFields s={widget.settings as ActionWidgetSettings} onChange={onChange} />;
}

// A reusable sort field+direction control (shared by view + tree).
function SortField({
  value,
  onChange,
}: {
  value: ViewWidgetSettings["sortOverride"];
  onChange: (v: ViewWidgetSettings["sortOverride"]) => void;
}) {
  return (
    <label className={field}>
      Sort
      <div className="flex gap-1">
        <select
          value={value?.field ?? ""}
          onChange={(e) =>
            onChange(
              e.target.value
                ? { field: e.target.value as (typeof SORT_FIELD_OPTS)[number], dir: value?.dir ?? "desc" }
                : null
            )
          }
          className={input}
        >
          <option value="">View default</option>
          {SORT_FIELD_OPTS.map((f) => (
            <option key={f} value={f}>
              {SORT_FIELD_LABELS[f]}
            </option>
          ))}
        </select>
        {value && (
          <select
            value={value.dir}
            onChange={(e) => onChange({ ...value, dir: e.target.value as "asc" | "desc" })}
            className={input}
          >
            <option value="desc">↓</option>
            <option value="asc">↑</option>
          </select>
        )}
      </div>
    </label>
  );
}

// /api/types rows, with the relation-kind properties we mine for the role picker.
type ApiTypeWithRelations = {
  key: string;
  label: string;
  propertySchema?: { key: string; label: string; kind: string }[];
};

// Nested-list (tree) fields. childType uses a types dropdown (like quick-capture);
// relationRole is a select of the relation fields defined across types (its key
// is the edge role), shown only for the relation source.
function TreeFields({
  s,
  onChange,
}: {
  s: TreeWidgetSettings;
  onChange: (settings: WidgetSettings) => void;
}) {
  const [types, setTypes] = useState<ApiTypeWithRelations[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/types")
      .then((r) => r.json())
      .then((d: { types: ApiTypeWithRelations[] }) => {
        if (alive) setTypes(d.types);
      })
      .catch(() => {
        if (alive) setTypes([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // The relation roles a "related by role" tree can use = every relation-kind
  // property defined across the types (its key IS the edge role), e.g. a task's
  // "Project" field → role "project". Deduped by key.
  const relationRoles = new Map<string, string>();
  for (const t of types ?? [])
    for (const p of t.propertySchema ?? [])
      if (p.kind === "relation") relationRoles.set(p.key, p.label || p.key);

  return (
    <>
      <label className={field}>
        Children come from
        <select
          value={s.childSource}
          onChange={(e) => onChange({ ...s, childSource: e.target.value as ChildSource })}
          className={input}
        >
          {CHILD_SOURCES.map((c) => (
            <option key={c} value={c}>
              {CHILD_SOURCE_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      {s.childSource === "relation" && (
        <label className={field}>
          Relation role
          <select
            value={s.relationRole ?? ""}
            onChange={(e) => onChange({ ...s, relationRole: e.target.value || null })}
            className={input}
          >
            <option value="">
              {types === null
                ? "Loading…"
                : relationRoles.size === 0
                  ? "No relation fields defined"
                  : "Select a relation…"}
            </option>
            {/* Keep a stale/hidden current value selectable so it isn't lost. */}
            {s.relationRole && !relationRoles.has(s.relationRole) && (
              <option value={s.relationRole}>{s.relationRole}</option>
            )}
            {[...relationRoles.entries()].map(([key, label]) => (
              <option key={key} value={key}>
                {label} ({key})
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={field}>
        Child type
        <select
          value={s.childType ?? ""}
          onChange={(e) => onChange({ ...s, childType: e.target.value || null })}
          className={input}
        >
          <option value="">{types === null ? "Loading…" : "Any type"}</option>
          {s.childType && !types?.some((t) => t.key === s.childType) && (
            <option value={s.childType}>{s.childType}</option>
          )}
          {types?.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <label className={`${field} flex-1`}>
          Parents
          <select
            value={s.parentLimit ?? ""}
            onChange={(e) =>
              onChange({ ...s, parentLimit: e.target.value ? Number(e.target.value) : null })
            }
            className={input}
          >
            <option value="">Default</option>
            {PARENT_LIMIT_OPTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className={`${field} flex-1`}>
          Children each
          <select
            value={s.childLimit}
            onChange={(e) => onChange({ ...s, childLimit: Number(e.target.value) })}
            className={input}
          >
            {CHILD_LIMIT_OPTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={s.hideCompletedChildren}
          onChange={(e) => onChange({ ...s, hideCompletedChildren: e.target.checked })}
        />
        Hide completed children
      </label>
      <SortField value={s.sortOverride} onChange={(sortOverride) => onChange({ ...s, sortOverride })} />
      <label className={field}>
        Title
        <input
          type="text"
          value={s.titleOverride ?? ""}
          placeholder="(view name)"
          onChange={(e) => onChange({ ...s, titleOverride: e.target.value || null })}
          className={input}
        />
      </label>
    </>
  );
}

// Cross-cutting appearance (DC1), the Appearance tab: header/border/collapsible
// toggles + background and accent swatch rows. Seeds from the widget's effective
// appearance and always emits the full object.
function AppearanceSection({
  widget,
  onAppearance,
}: {
  widget: DashboardWidget;
  onAppearance: (appearance: WidgetAppearance) => void;
}) {
  const ap = effectiveAppearance(widget);
  const set = (patch: Partial<WidgetAppearance>) => onAppearance({ ...ap, ...patch });
  const toggle = "flex items-center gap-2 text-xs text-neutral-400";

  return (
    <div className="flex flex-col gap-1.5">
      <label className={toggle}>
        <input type="checkbox" checked={ap.showHeader} onChange={(e) => set({ showHeader: e.target.checked })} />
        Header
      </label>
      <label className={toggle}>
        <input type="checkbox" checked={ap.showBorder} onChange={(e) => set({ showBorder: e.target.checked })} />
        Border
      </label>
      <label className={toggle}>
        <input
          type="checkbox"
          checked={ap.collapsible}
          onChange={(e) => set({ collapsible: e.target.checked })}
        />
        Collapsible
      </label>
      <div className={field}>
        Background
        <div className="mt-1 flex flex-wrap gap-1.5">
          {WIDGET_BACKGROUNDS.map((b) => (
            <Swatch
              key={b}
              token={b}
              selected={ap.background === b}
              onClick={() => set({ background: b as WidgetBackground })}
            />
          ))}
        </div>
      </div>
      <div className={field}>
        Accent
        <div className="mt-1 flex flex-wrap gap-1.5">
          {WIDGET_ACCENTS.map((a) => (
            <Swatch
              key={a}
              token={a}
              selected={ap.accent === a}
              onClick={() => set({ accent: a as WidgetAccent })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Swatch({
  token,
  selected,
  onClick,
}: {
  token: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={token}
      aria-label={token}
      className={`h-5 w-5 rounded-full ${SWATCH_DOT[token] ?? "bg-neutral-700"} ${
        selected ? "ring-2 ring-offset-1 ring-offset-neutral-900 ring-neutral-300" : ""
      }`}
    />
  );
}

// A picked template: id, name, and the type it builds (sets the widget's
// targetType so the apply opens the right type).
type TemplateOption = { id: string; name: string; type: string };
// A type for the quick-capture picker.
type TypeOption = { key: string; label: string };

// The action-widget fields. A separate component so it can fetch the owner's
// templates + types (for the pickers) without conditional hooks in renderFields.
function ActionFields({
  s,
  onChange,
}: {
  s: ActionWidgetSettings;
  onChange: (settings: WidgetSettings) => void;
}) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [types, setTypes] = useState<TypeOption[] | null>(null);
  useEffect(() => {
    if (s.action !== "new-from-template") return;
    let alive = true;
    void fetch("/api/templates")
      .then((r) => r.json())
      .then((d: { templates: TemplateOption[] }) => {
        if (alive) setTemplates(d.templates);
      })
      .catch(() => {
        if (alive) setTemplates([]);
      });
    return () => {
      alive = false;
    };
  }, [s.action]);
  useEffect(() => {
    if (s.action !== "quick-capture") return;
    let alive = true;
    void fetch("/api/types")
      .then((r) => r.json())
      .then((d: { types: TypeOption[] }) => {
        if (alive) setTypes(d.types);
      })
      .catch(() => {
        if (alive) setTypes([]);
      });
    return () => {
      alive = false;
    };
  }, [s.action]);

  return (
    <>
      <label className={field}>
        Action
        <select
          value={s.action}
          onChange={(e) => onChange({ ...s, action: e.target.value as ActionKind })}
          className={input}
        >
          {ACTION_OPTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        Label
        <input
          type="text"
          value={s.label}
          onChange={(e) => onChange({ ...s, label: e.target.value })}
          className={input}
        />
      </label>
      {s.action === "quick-capture" && (
        <label className={field}>
          Type
          <select
            value={s.targetType ?? ""}
            onChange={(e) => onChange({ ...s, targetType: e.target.value || null })}
            className={input}
          >
            <option value="">{types === null ? "Loading types…" : "Select a type…"}</option>
            {s.targetType && !types?.some((t) => t.key === s.targetType) && (
              <option value={s.targetType}>{s.targetType}</option>
            )}
            {types?.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {s.action === "new-from-template" && (
        <label className={field}>
          Template
          <select
            value={s.templateId ?? ""}
            onChange={(e) => {
              const picked = templates?.find((t) => t.id === e.target.value);
              onChange({
                ...s,
                templateId: e.target.value || null,
                targetType: picked ? picked.type : s.targetType,
              });
            }}
            className={input}
          >
            <option value="">
              {templates === null
                ? "Loading templates…"
                : templates.length === 0
                  ? "No templates yet"
                  : "Select a template…"}
            </option>
            {templates?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.type}
              </option>
            ))}
          </select>
        </label>
      )}
      {s.action === "link" && (
        <label className={field}>
          URL / path
          <input
            type="text"
            value={s.href ?? ""}
            placeholder="/tasks or https://…"
            onChange={(e) => onChange({ ...s, href: e.target.value || null })}
            className={input}
          />
        </label>
      )}
    </>
  );
}
