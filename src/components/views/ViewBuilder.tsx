// View builder (slice 27, PRD §4.2/§4.9): the form that creates and edits a
// stored View Definition. It POSTs/PATCHes the whole definition to
// /api/views; the server (views.ts parseViewInput) is the source of truth for
// validation. Option lists are duplicated here as plain UI arrays so this
// client component never imports the DB-backed views module.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import RuleBuilder, { type RuleSubjectOption } from "@/components/views/RuleBuilder";
import type { StatusMode } from "@/lib/status";
import type { PropertyDef } from "@/lib/types";
import type { WhereGroup } from "@/lib/view-where";
import { CALENDAR_MODES, TIMELINE_ZOOMS } from "@/lib/views";
import type { ColumnField, ViewColumn, ViewDefinition, ViewDisplay, CalendarMode, TimelineZoom } from "@/lib/views";
import {
  DEFAULT_PROJECT_CARD,
  PROJECT_CARD_ELEMENTS,
  type ProjectCardElement,
} from "@/lib/project-card-config";

// Friendly labels for the calendar-display controls (ADR-166). "timegrid"
// (Multi-day) is retired from new views but kept selectable when a stored view
// already uses it, so editing round-trips it rather than silently flipping it.
const MODE_LABELS: Record<CalendarMode, string> = {
  month: "Month",
  timegrid: "Multi-day (legacy)",
  timeline: "Timeline",
  spine: "History (vertical)",
};
const ZOOM_LABELS: Record<TimelineZoom, string> = {
  hour: "Hour", day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year", halfDecade: "5-Year",
};

const LAYOUTS = ["list", "table", "board", "calendar", "agenda"] as const;
// Status filter is by CATEGORY now (S2): statuses are user-defined per type, so
// a generic view filters by the bucket. "active" = not started + in progress.
const STATUS_CATEGORY_OPTS = [
  { value: "active", label: "active" },
  { value: "not_started", label: "not started" },
  { value: "in_progress", label: "in progress" },
  { value: "done", label: "done" },
  { value: "archived", label: "archived (closed)" },
];
// Task priority P1–P6 (ADR-096; 1 highest, 6 = no special priority). Stored as
// the numeric `urgency` column; the option value is the number, label is "P1"…
const PRIORITY_OPTS = [1, 2, 3, 4, 5, 6].map((n) => ({
  value: String(n),
  label: `P${n}`,
}));
// Mirrors views.ts PROPERTY_FILTER_NONE (kept local so this client form never
// imports the DB-backed views module). "" = any (no filter); this = "not set".
const FILTER_NONE = "__none__";

// Friendly labels for the "by which field" selects.
const DATE_LABELS: Record<string, string> = {
  plan: "plan date (scheduled, else due)",
  dueDate: "due date",
  scheduledDate: "scheduled date",
  meetingAt: "when",
  createdAt: "created",
  updatedAt: "updated",
};
const GROUP_LABELS: Record<string, string> = {
  status: "status",
  urgency: "urgency",
  type: "type",
  plan: "plan window",
  due: "due window",
  scheduled: "scheduled window",
};

// The whole point of Brandon's feedback: a field is only offered if it exists
// for the view's type. Meetings have no due date, so a meeting view never lets
// you sort/place/filter by it; tasks have no "when"; notes/links have neither.
// Every field select below draws from these, and changeType() reconciles the
// current pick when the type changes.
function dateFieldsFor(type: string): string[] {
  // "plan" (scheduled ?? due, ADR-109) is offered first for tasks/any, so it's
  // the default the builder picks — scheduled-primary, due-secondary.
  if (type === "task") return ["plan", "scheduledDate", "dueDate", "createdAt", "updatedAt"];
  if (type === "event") return ["meetingAt", "createdAt", "updatedAt"];
  if (type === "")
    return ["plan", "scheduledDate", "dueDate", "meetingAt", "createdAt", "updatedAt"];
  return ["createdAt", "updatedAt"]; // note / link / person
}
function sortFieldsFor(type: string): string[] {
  // Priority is offered only where the type has it (task/any), alongside title.
  const extra = showsUrgency(type) ? ["urgency", "title"] : ["title"];
  return [...dateFieldsFor(type), ...extra];
}
// Sort-select labels: dates reuse DATE_LABELS; urgency reads as "priority".
const SORT_LABELS: Record<string, string> = { ...DATE_LABELS, urgency: "priority", title: "title" };
// urgency + due window are task-only in the UI (ADR-018).
function groupFieldsFor(type: string): string[] {
  if (type === "task") return ["status", "urgency", "plan", "due", "scheduled", "type"];
  if (type === "event") return ["status", "type"];
  if (type === "") return ["status", "urgency", "plan", "due", "scheduled", "type"];
  return ["status", "type"]; // note / link / person
}
const showsUrgency = (type: string) => type === "task" || type === "";

// Columns are offered for the row-based layouts (list/table/agenda); board and
// calendar have their own card shapes and ignore the column choice. The one
// calendar exception is the History spine, which renders the chosen columns as
// each entry's second line (a work log reads its category that way).
const showsColumns = (layout: string, mode?: string) =>
  layout === "list" ||
  layout === "table" ||
  layout === "agenda" ||
  (layout === "calendar" && mode === "spine");

// Built-in field columns offered for a type, mirroring which fields that type
// actually has (the same discipline as the date/sort selects above).
const FIELD_COLUMN_LABELS: Record<ColumnField, string> = {
  type: "Type",
  status: "Status",
  urgency: "Urgency",
  plan: "Plan date",
  dueDate: "Due date",
  scheduledDate: "Scheduled date",
  meetingAt: "When",
  createdAt: "Created",
  updatedAt: "Updated",
  url: "URL",
};
function fieldColumnsFor(type: string): ColumnField[] {
  const cols: ColumnField[] = ["type", "status"];
  if (showsUrgency(type)) cols.push("urgency");
  for (const d of dateFieldsFor(type)) cols.push(d as ColumnField);
  if (type === "link" || type === "") cols.push("url");
  return cols;
}

type PersonOption = { id: string; title: string };

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-600">{hint}</span>}
    </label>
  );
}

const selectClass =
  "rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

function Opt({ value, label }: { value: string; label?: string }) {
  return <option value={value}>{label ?? value}</option>;
}

export default function ViewBuilder({
  initial,
  people,
  types,
}: {
  initial?: ViewDefinition;
  people: PersonOption[];
  // The full type registry (system + custom), so a view can filter to a
  // user-created type, not just the five system ones. propertySchema rides
  // along so a board can group by the type's select properties (a workflow's
  // "Stage", slice 35); statusMode (ADR-106) decides whether the Status filter/
  // group/column appear for this type at all.
  types: {
    key: string;
    label: string;
    propertySchema?: PropertyDef[];
    statusMode?: StatusMode;
  }[];
}) {
  // A type's select/multi_select properties, as group-by options encoded
  // "prop:<key>" so they share the one Group-by control with the built-in
  // fields. A board grouped by one of these reads as a workflow board.
  function groupPropsFor(
    typeKey: string
  ): { value: string; label: string; suffix: string }[] {
    const schema = types.find((t) => t.key === typeKey)?.propertySchema ?? [];
    return [
      ...schema
        .filter((p) => p.kind === "select" || p.kind === "multi_select")
        .map((p) => ({ value: `prop:${p.key}`, label: p.label, suffix: "field" })),
      // Relation fields (Tags, and any other the owner declares) encoded
      // "rel:<role>" — this is how "group my tasks by tag" becomes a saved view
      // (Tyler, 2026-08-12). A relation grouping FANS OUT, so a task with two tags
      // shows in both columns, and the board is read-only (a tag column can't be
      // dropped into — moving edges isn't the PATCH a drop writes).
      ...schema
        .filter((p) => p.kind === "relation")
        .map((p) => ({ value: `rel:${p.key}`, label: p.label, suffix: "links" })),
    ];
  }
  // The type's own `date` properties, offered beside the built-in date fields so
  // a bespoke type can be placed by the date it actually keeps (a work log's
  // `logdate`). Stored as display.startField ({prop}), the engine's DateRef,
  // which placement.ts has always read but nothing could set until now. Encoded
  // "prop:<key>", the Sort control's convention.
  function datePropsFor(typeKey: string): { key: string; label: string }[] {
    const schema = types.find((t) => t.key === typeKey)?.propertySchema ?? [];
    return schema.filter((p) => p.kind === "date").map((p) => ({ key: p.key, label: p.label }));
  }
  function datePlacementFor(typeKey: string): string[] {
    return [...dateFieldsFor(typeKey), ...datePropsFor(typeKey).map((p) => `prop:${p.key}`)];
  }
  function datePlacementLabel(typeKey: string, value: string): string {
    if (!value.startsWith("prop:")) return DATE_LABELS[value] ?? value;
    const key = value.slice(5);
    return datePropsFor(typeKey).find((p) => p.key === key)?.label ?? key;
  }
  // The type's custom properties, offered as property columns.
  function propColumnsFor(typeKey: string): { key: string; label: string }[] {
    const schema = types.find((t) => t.key === typeKey)?.propertySchema ?? [];
    return schema.map((p) => ({ key: p.key, label: p.label }));
  }
  // A type's select/multi_select properties offered as list filters, with their
  // option lists (the filter counterpart to groupPropsFor).
  function filterPropsFor(
    typeKey: string
  ): { key: string; label: string; options: string[] }[] {
    const schema = types.find((t) => t.key === typeKey)?.propertySchema ?? [];
    return schema
      .filter((p) => p.kind === "select" || p.kind === "multi_select")
      .map((p) => ({ key: p.key, label: p.label, options: p.options ?? [] }));
  }
  // Properties usable as a SORT key (ADR-164): text/number/date/select/checkbox
  // order sensibly; url/multi_select/relation don't. Encoded "prop:<key>" so the
  // one Sort-by control carries them beside the built-in fields.
  function sortPropsFor(typeKey: string): { key: string; label: string; numeric: boolean }[] {
    const schema = types.find((t) => t.key === typeKey)?.propertySchema ?? [];
    return schema
      .filter((p) => ["text", "number", "date", "select", "checkbox"].includes(p.kind))
      .map((p) => ({ key: p.key, label: p.label, numeric: p.kind === "number" }));
  }
  // Every condition subject the rule builder offers for a type: scalar
  // properties, relation fields, plus the priority/status built-ins where the
  // type has them (ADR-164).
  function subjectOptionsFor(typeKey: string): RuleSubjectOption[] {
    const schema = types.find((t) => t.key === typeKey)?.propertySchema ?? [];
    const opts: RuleSubjectOption[] = [];
    for (const p of schema) {
      if (p.kind === "relation") {
        opts.push({ subject: "relation", key: p.key, label: p.label, targetType: p.targetType ?? null });
      } else {
        opts.push({
          subject: "property",
          key: p.key,
          label: p.label,
          kind: p.kind,
          options: p.options,
          numeric: p.kind === "number",
        });
      }
    }
    if (showsUrgency(typeKey)) opts.push({ subject: "priority", label: "Priority" });
    if (usesStatus(typeKey)) opts.push({ subject: "status", label: "Status" });
    return opts;
  }
  // Whether the view's type surfaces status at all (ADR-106). A type whose mode
  // is 'none' (person, link, a note) hides the Status filter, the status group
  // option, and the status column — the same "offer a field only if the type has
  // it" rule the dates/urgency already follow. "any" (no type → undefined mode)
  // keeps status, since a mixed view may include types that use it.
  const usesStatus = (typeKey: string) =>
    types.find((t) => t.key === typeKey)?.statusMode !== "none";
  // The type's built-in field columns, minus status when the type doesn't use it.
  const fieldColumnsForView = (typeKey: string): ColumnField[] =>
    fieldColumnsFor(typeKey).filter((k) => k !== "status" || usesStatus(typeKey));
  const validGroup = (typeKey: string, val: string | undefined): string => {
    if (!val) return "";
    const ok =
      (groupFieldsFor(typeKey).includes(val) &&
        (val !== "status" || usesStatus(typeKey))) ||
      groupPropsFor(typeKey).some((o) => o.value === val);
    return ok ? val : "";
  };
  // The stored grouping is {field} or {propertyKey}; collapse to the control's
  // string form ("status" | "prop:stage").
  const groupingToValue = (g: ViewDefinition["grouping"] | undefined): string =>
    g
      ? "propertyKey" in g
        ? `prop:${g.propertyKey}`
        : "relationRole" in g
          ? `rel:${g.relationRole}`
          : g.field
      : "";
  const router = useRouter();
  // Clamp anything the stored definition holds that's no longer valid for its
  // type (e.g. a legacy meeting calendar saved with date field "due date"):
  // it snaps to the first valid field, so editing + saving repairs it.
  const t0 = initial?.filter.type ?? "";
  const df0 = dateFieldsFor(t0);
  const pick = (allowed: string[], val: string | null | undefined, fallback: string) =>
    val && allowed.includes(val) ? val : fallback;

  const [name, setName] = useState(initial?.name ?? "");
  const [layout, setLayout] = useState<string>(initial?.layout ?? "list");
  const [type, setType] = useState(t0);
  const [statusCategory, setStatusCategory] = useState<string>(
    initial?.filter.statusCategory ?? ""
  );
  const [urgency, setUrgency] = useState<string>(
    showsUrgency(t0) ? (initial?.filter.urgency != null ? String(initial.filter.urgency) : "") : ""
  );
  const [dateField, setDateField] = useState<string>(
    pick(df0, initial?.filter.dateField, df0[0])
  );
  // Window control: "" | overdue | today | week | none | "within". "within"
  // reveals the day-count input below.
  const [dateWindow, setDateWindow] = useState<string>(
    initial?.filter.withinDays != null ? "within" : initial?.filter.due ?? ""
  );
  const [withinDays, setWithinDays] = useState<string>(
    initial?.filter.withinDays != null ? String(initial.filter.withinDays) : "7"
  );
  const [relatedTo, setRelatedTo] = useState(initial?.filter.relatedTo ?? "");
  // Property filters as a key→value map ("" = any; FILTER_NONE = not set; else
  // an option string). Seeded from the stored array.
  const [propFilters, setPropFilters] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const pf of initial?.filter.propertyFilters ?? []) {
      m[pf.key] = pf.value === null ? FILTER_NONE : pf.value;
    }
    return m;
  });
  // Sort key: a built-in field, or "prop:<key>" for a custom-property sort
  // (ADR-164). Seeded from the stored ListSort (property or field).
  const [sortField, setSortField] = useState<string>(() => {
    const s = initial?.sort;
    if (s && s.field === "property") {
      return sortPropsFor(t0).some((p) => p.key === s.propertyKey)
        ? `prop:${s.propertyKey}`
        : "updatedAt";
    }
    return pick(sortFieldsFor(t0), s?.field, "updatedAt");
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(
    initial?.sort.dir ?? "desc"
  );
  const [groupField, setGroupField] = useState<string>(
    validGroup(t0, groupingToValue(initial?.grouping))
  );
  const [dateProperty, setDateProperty] = useState<string>(() => {
    const sf = initial?.display?.startField;
    if (sf && "prop" in sf) return `prop:${sf.prop}`;
    return pick(datePlacementFor(t0), initial?.dateProperty, df0[0]);
  });
  // Calendar display defaults (ADR-166): the mode a calendar view opens in and,
  // for the Timeline, its initial zoom. Stored in views.display; null → defaults.
  const [calMode, setCalMode] = useState<CalendarMode>(initial?.display?.mode ?? "month");
  const [calZoom, setCalZoom] = useState<TimelineZoom>(initial?.display?.zoom ?? "week");
  // The AND/OR rules group (ADR-164); null = no rules. Cleared when the type
  // changes, since its conditions reference that type's properties.
  const [where, setWhere] = useState<WhereGroup | null>(initial?.filter.where ?? null);
  // Chosen columns, in order; empty = the layout's default columns. Toggling
  // appends (so check order = column order) or removes.
  const [columns, setColumns] = useState<ViewColumn[]>(initial?.columns ?? []);
  // Project cards (2026-08-17): whether THIS view overrides the type-default
  // card, and with which elements. Applies only to a project-scoped list/board
  // view; stored as views.display.card (null/absent = inherit the type default).
  const [cardCustom, setCardCustom] = useState<boolean>(initial?.display?.card != null);
  const [cardShow, setCardShow] = useState<ProjectCardElement[]>(
    initial?.display?.card?.show ?? [...DEFAULT_PROJECT_CARD.show]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasColumn = (col: ViewColumn) =>
    columns.some((c) => c.source === col.source && c.key === col.key);
  function toggleColumn(col: ViewColumn) {
    setColumns((cs) =>
      cs.some((c) => c.source === col.source && c.key === col.key)
        ? cs.filter((c) => !(c.source === col.source && c.key === col.key))
        : [...cs, col]
    );
  }

  const needsDate = layout === "calendar" || layout === "agenda";
  const canGroup = layout === "board" || layout === "agenda";
  // Project cards render on project-scoped list/board views (2026-08-17).
  const cardApplies = type === "project" && (layout === "list" || layout === "board");
  const dateFields = dateFieldsFor(type);
  const sortFields = sortFieldsFor(type);
  const groupFields = groupFieldsFor(type).filter(
    (f) => f !== "status" || usesStatus(type)
  );

  // Selecting a type reconciles every field pick to what that type supports —
  // the "lists update based on what the view shows" rule.
  function changeType(t: string) {
    setType(t);
    const df = dateFieldsFor(t);
    setDateField((v) => (df.includes(v) ? v : df[0]));
    const dp = datePlacementFor(t);
    setDateProperty((v) => (dp.includes(v) ? v : df[0]));
    setSortField((v) => {
      if (v.startsWith("prop:")) {
        return sortPropsFor(t).some((p) => `prop:${p.key}` === v) ? v : "updatedAt";
      }
      return sortFieldsFor(t).includes(v) ? v : "updatedAt";
    });
    setGroupField((v) => validGroup(t, v));
    // Rules reference the old type's properties; clear them on a type change.
    setWhere(null);
    if (!showsUrgency(t)) setUrgency("");
    // Clear a status filter the new type can't use (ADR-106), mirroring urgency.
    if (!usesStatus(t)) setStatusCategory("");
    // Drop any column the new type doesn't have (a stale field or a property
    // key that isn't in the new type's schema, or status on a none-status type).
    const okFields = new Set<string>(fieldColumnsForView(t));
    const okProps = new Set(propColumnsFor(t).map((p) => p.key));
    setColumns((cs) =>
      cs.filter((c) =>
        c.source === "field" ? okFields.has(c.key) : okProps.has(c.key)
      )
    );
    // Drop property filters for properties the new type doesn't have.
    const okFilterProps = new Set(filterPropsFor(t).map((p) => p.key));
    setPropFilters((pf) =>
      Object.fromEntries(Object.entries(pf).filter(([k]) => okFilterProps.has(k)))
    );
  }

  async function save() {
    if (busy) return;
    setError(null);
    if (!name.trim()) {
      setError("Give the view a name.");
      return;
    }
    setBusy(true);
    const filter: Record<string, unknown> = {};
    if (type) filter.type = type;
    // Don't persist a status filter on a type that doesn't use status (ADR-106).
    if (statusCategory && usesStatus(type)) filter.statusCategory = statusCategory;
    if (urgency) filter.urgency = Number(urgency);
    if (relatedTo) filter.relatedTo = relatedTo;
    if (dateWindow) {
      if (dateField) filter.dateField = dateField;
      if (dateWindow === "within") {
        const n = parseInt(withinDays, 10);
        if (!Number.isInteger(n) || n < 1) {
          setError("Enter a positive number of days.");
          setBusy(false);
          return;
        }
        filter.withinDays = String(n);
      } else {
        filter.due = dateWindow;
      }
    }
    const propertyFilters = filterPropsFor(type)
      .filter((p) => propFilters[p.key])
      .map((p) => ({
        key: p.key,
        value: propFilters[p.key] === FILTER_NONE ? null : propFilters[p.key],
      }));
    if (propertyFilters.length) filter.propertyFilters = propertyFilters;
    // The AND/OR rules group (ADR-164): only persist conditions that still
    // resolve to a subject the current type offers (a stale one is dropped).
    if (where && where.conditions.length) {
      const okSubjects = subjectOptionsFor(type);
      const conditions = where.conditions.filter((c) =>
        c.subject === "property" || c.subject === "relation"
          ? okSubjects.some((o) => o.subject === c.subject && "key" in o && o.key === c.key)
          : okSubjects.some((o) => o.subject === c.subject)
      );
      if (conditions.length) filter.where = { combinator: where.combinator, conditions };
    }
    // Sort by a built-in field, or by a custom property ("prop:<key>", ADR-164).
    const sort = sortField.startsWith("prop:")
      ? {
          field: "property" as const,
          propertyKey: sortField.slice(5),
          numeric: sortPropsFor(type).find((p) => `prop:${p.key}` === sortField)?.numeric ?? false,
          dir: sortDir,
        }
      : { field: sortField, dir: sortDir };
    const payload = {
      name: name.trim(),
      layout,
      filter,
      sort,
      grouping:
        canGroup && groupField
          ? groupField.startsWith("prop:")
            ? { propertyKey: groupField.slice(5) }
            : groupField.startsWith("rel:")
              ? { relationRole: groupField.slice(4) }
              : { field: groupField }
          : null,
      columns: showsColumns(layout, calMode) && columns.length ? columns : null,
      // dateProperty names a BUILT-IN field only; a custom date property rides
      // display.startField below, so the two never both claim the placement.
      dateProperty: needsDate && !dateProperty.startsWith("prop:") ? dateProperty : null,
      // Preserve any other display fields the view already had (dayCount, etc.),
      // overlay the calendar mode + timeline zoom on a calendar layout, and set
      // or clear the project-card override this builder edits. An empty display
      // collapses to null so a plain view stores nothing.
      display: (() => {
        const d = { ...(initial?.display ?? {}) } as ViewDisplay;
        if (layout === "calendar") {
          d.mode = calMode;
          d.zoom = calZoom;
        }
        if (needsDate && dateProperty.startsWith("prop:")) {
          d.startField = { prop: dateProperty.slice(5) };
        } else if (needsDate) {
          // Clear a stale custom-property placement, or it would keep winning
          // over the built-in field the owner just chose.
          delete d.startField;
        }
        if (cardApplies && cardCustom) d.card = { show: cardShow };
        else delete d.card;
        return Object.keys(d).length ? d : null;
      })(),
    };
    try {
      const res = await fetch(
        initial ? `/api/views/${initial.id}` : "/api/views",
        {
          method: initial ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `save failed (${res.status})`);
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { view: { id: string } };
      router.push(`/views/${data.view.id}`);
      router.refresh();
    } catch {
      setError("save failed (offline?)");
      setBusy(false);
    }
  }

  // In-context delete (ConfirmButton owns the confirm popover). Throwing keeps
  // the message visible in the popover; success navigates away.
  async function confirmDelete() {
    if (!initial) return;
    const res = await fetch(`/api/views/${initial.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `delete failed (${res.status})`);
    }
    router.push("/views");
    router.refresh();
  }

  return (
    <div className="mt-6 flex max-w-md flex-col gap-4">
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. This week's tasks"
          className={selectClass}
        />
      </Field>

      <Field label="Layout">
        <select
          value={layout}
          onChange={(e) => setLayout(e.target.value)}
          className={selectClass}
        >
          {LAYOUTS.map((l) => (
            <Opt key={l} value={l} />
          ))}
        </select>
      </Field>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Filter
        </legend>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => changeType(e.target.value)}
            className={selectClass}
          >
            <Opt value="" label="any" />
            {types.map((t) => (
              <Opt key={t.key} value={t.key} label={t.label} />
            ))}
          </select>
        </Field>
        {usesStatus(type) && (
          <Field label="Status">
            <select
              value={statusCategory}
              onChange={(e) => setStatusCategory(e.target.value)}
              className={selectClass}
            >
              <Opt value="" label="any" />
              {STATUS_CATEGORY_OPTS.map((s) => (
                <Opt key={s.value} value={s.value} label={s.label} />
              ))}
            </select>
          </Field>
        )}
        {showsUrgency(type) && (
          <Field label="Priority">
            <select
              value={urgency}
              onChange={(e) => setUrgency(e.target.value)}
              className={selectClass}
            >
              <Opt value="" label="any" />
              {PRIORITY_OPTS.map((p) => (
                <Opt key={p.value} value={p.value} label={p.label} />
              ))}
            </select>
          </Field>
        )}
        <Field
          label="Date filter"
          hint="Filter by a date, and which date it applies to."
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={dateField}
              onChange={(e) => setDateField(e.target.value)}
              className={selectClass}
              aria-label="Date field"
            >
              {dateFields.map((f) => (
                <Opt key={f} value={f} label={DATE_LABELS[f]} />
              ))}
            </select>
            <select
              value={dateWindow}
              onChange={(e) => setDateWindow(e.target.value)}
              className={selectClass}
              aria-label="Date window"
            >
              <Opt value="" label="any time" />
              <Opt value="overdue" label="in the past" />
              <Opt value="today" />
              <Opt value="week" label="next 7 days" />
              <Opt value="within" label="next N days…" />
              <Opt value="none" label="no date set" />
            </select>
            {dateWindow === "within" && (
              <span className="flex items-center gap-1 text-xs text-neutral-500">
                next
                <input
                  type="number"
                  min={1}
                  max={366}
                  value={withinDays}
                  onChange={(e) => setWithinDays(e.target.value)}
                  className="w-16 rounded border border-neutral-800 bg-neutral-900 px-1.5 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                  aria-label="Number of days"
                />
                days
              </span>
            )}
          </div>
        </Field>
        <Field label="Related to person">
          <select
            value={relatedTo}
            onChange={(e) => setRelatedTo(e.target.value)}
            className={selectClass}
          >
            <Opt value="" label="any" />
            {people.map((p) => (
              <Opt key={p.id} value={p.id} label={p.title || "Untitled"} />
            ))}
          </select>
        </Field>
        {filterPropsFor(type).map((p) => (
          <Field key={p.key} label={p.label}>
            <select
              value={propFilters[p.key] ?? ""}
              onChange={(e) =>
                setPropFilters((pf) => ({ ...pf, [p.key]: e.target.value }))
              }
              className={selectClass}
            >
              <Opt value="" label="any" />
              {p.options.map((o) => (
                <Opt key={o} value={o} />
              ))}
              <Opt value={FILTER_NONE} label="not set" />
            </select>
          </Field>
        ))}
      </fieldset>

      <RuleBuilder
        value={where}
        onChange={setWhere}
        subjectOptions={subjectOptionsFor(type)}
      />

      <div className="flex gap-3">
        <Field label="Sort by">
          <select
            value={sortField}
            onChange={(e) => {
              const f = e.target.value;
              setSortField(f);
              // Priority reads highest-first (P1) by default; switching to it
              // flips direction to asc so P1 leads without a second click.
              if (f === "urgency") setSortDir("asc");
            }}
            className={selectClass}
          >
            {sortFields.map((f) => (
              <Opt key={f} value={f} label={SORT_LABELS[f] ?? f} />
            ))}
            {sortPropsFor(type).length > 0 && (
              <optgroup label="Properties">
                {sortPropsFor(type).map((p) => (
                  <option key={`prop:${p.key}`} value={`prop:${p.key}`}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label="Direction">
          <select
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value as "asc" | "desc")}
            className={selectClass}
          >
            {sortField === "urgency" ? (
              <>
                <Opt value="asc" label="highest first (P1→P6)" />
                <Opt value="desc" label="lowest first (P6→P1)" />
              </>
            ) : (
              <>
                <Opt value="desc" label="newest / Z-A" />
                <Opt value="asc" label="oldest / A-Z" />
              </>
            )}
          </select>
        </Field>
      </div>

      {canGroup && (
        <Field label="Group by" hint="Columns for a board; sections for an agenda.">
          <select
            value={groupField}
            onChange={(e) => setGroupField(e.target.value)}
            className={selectClass}
          >
            <Opt
              value=""
              label={
                layout === "board" && usesStatus(type) ? "status (default)" : "none"
              }
            />
            {groupFields.map((g) => (
              <Opt key={g} value={g} label={GROUP_LABELS[g]} />
            ))}
            {groupPropsFor(type).map((o) => (
              <Opt key={o.value} value={o.value} label={`${o.label} (${o.suffix})`} />
            ))}
          </select>
        </Field>
      )}

      {showsColumns(layout, calMode) && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Columns
          </legend>
          <p className="text-xs text-neutral-600">
            Which fields show beside each item. None checked = the default
            (status, urgency, date).
          </p>
          <div className="flex flex-col gap-1.5">
            {fieldColumnsForView(type).map((key) => {
              const col: ViewColumn = { source: "field", key };
              return (
                <label key={`field:${key}`} className="flex items-center gap-2 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    className="ledgr-check ledgr-check-sm"
                    checked={hasColumn(col)}
                    onChange={() => toggleColumn(col)}
                  />
                  {FIELD_COLUMN_LABELS[key]}
                </label>
              );
            })}
            {propColumnsFor(type).map(({ key, label }) => {
              const col: ViewColumn = { source: "property", key };
              return (
                <label key={`property:${key}`} className="flex items-center gap-2 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    className="ledgr-check ledgr-check-sm"
                    checked={hasColumn(col)}
                    onChange={() => toggleColumn(col)}
                  />
                  {label}{" "}
                  <span className="text-xs text-neutral-600">(property)</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {cardApplies && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Project cards
          </legend>
          <p className="text-xs text-neutral-600">
            This view renders projects as rich cards. By default it uses the
            card set from Build → Types → Project; customize to pick a
            different set just for this view.
          </p>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              className="ledgr-check ledgr-check-sm"
              checked={cardCustom}
              onChange={(e) => setCardCustom(e.target.checked)}
            />
            Customize card elements for this view
          </label>
          {cardCustom && (
            <div className="flex flex-col gap-1.5 pl-6">
              {PROJECT_CARD_ELEMENTS.map((el) => (
                <label key={el.key} className="flex items-center gap-2 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    className="ledgr-check ledgr-check-sm"
                    checked={cardShow.includes(el.key)}
                    onChange={() =>
                      setCardShow((s) =>
                        s.includes(el.key) ? s.filter((x) => x !== el.key) : [...s, el.key]
                      )
                    }
                  />
                  {el.label}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {needsDate && (
        <Field
          label="Date field"
          hint={`Which date places items on the ${layout}. A type's own date properties are offered too.`}
        >
          <select
            value={dateProperty}
            onChange={(e) => setDateProperty(e.target.value)}
            className={selectClass}
          >
            {datePlacementFor(type).map((d) => (
              <Opt key={d} value={d} label={datePlacementLabel(type, d)} />
            ))}
          </select>
        </Field>
      )}

      {layout === "calendar" && (
        <Field
          label="Default view"
          hint="How this calendar opens. Month is the grid; Timeline is a zoomable horizontal axis where any writable date can be dragged; History is a read-only vertical spine that scrolls through time."
        >
          <select
            value={calMode}
            onChange={(e) => setCalMode(e.target.value as CalendarMode)}
            className={selectClass}
          >
            {CALENDAR_MODES.filter((m) => m !== "timegrid" || calMode === "timegrid").map((m) => (
              <Opt key={m} value={m} label={MODE_LABELS[m]} />
            ))}
          </select>
        </Field>
      )}

      {layout === "calendar" && (calMode === "timeline" || calMode === "spine") && (
        <Field
          label={calMode === "spine" ? "Group by" : "Timeline zoom"}
          hint={
            calMode === "spine"
              ? "How much time each chip on the spine covers. Every grain is offered on every type; a type whose dates are calendar days simply groups by day at the finest setting."
              : "The span the timeline shows at first. You can still zoom in and out inside the view."
          }
        >
          <select
            value={calZoom}
            onChange={(e) => setCalZoom(e.target.value as TimelineZoom)}
            className={selectClass}
          >
            {TIMELINE_ZOOMS.map((z) => (
              <Opt key={z} value={z} label={ZOOM_LABELS[z]} />
            ))}
          </select>
        </Field>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Create view"}
        </button>
        {initial && !initial.isSystem && (
          <ConfirmButton
            onConfirm={confirmDelete}
            title="Delete this view?"
            description="This can't be undone. The items it lists aren't affected."
            triggerClassName="text-sm text-red-400 hover:text-red-300"
            trigger="Delete"
          />
        )}
      </div>
    </div>
  );
}
