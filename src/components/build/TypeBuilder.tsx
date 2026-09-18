// The custom type & property builder (slice 33, PRD §3.6/§4.10): the form that
// creates and edits a `types` row. It POSTs/PATCHes the whole definition to
// /api/types; the server (types.ts parseTypeInput) is the source of truth for
// validation. Kind labels are duplicated here as a plain client array so this
// component never imports the DB-backed types module (only its erased types).
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import NavIconPicker from "@/components/build/NavIconPicker";
import NavGlyph from "@/components/nav/NavGlyph";
import type {
  PropertyDef,
  PropertyKind,
  RelationCardinality,
  TypeDefinition,
} from "@/lib/types";

// Mirrors PROPERTY_KINDS in src/lib/types.ts (validation lives there).
const KINDS: { kind: PropertyKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "number", label: "Number" },
  { kind: "date", label: "Date" },
  { kind: "checkbox", label: "Checkbox (yes/no)" },
  { kind: "url", label: "URL" },
  { kind: "image", label: "Image (upload or URL)" },
  // Labelled by what they DO, not by their storage: both are text, and the
  // reason to pick one is the tap-to-call / tap-to-mail link it renders.
  { kind: "phone", label: "Phone (tap to call)" },
  { kind: "email", label: "Email (tap to mail)" },
  { kind: "select", label: "Select (one)" },
  { kind: "multi_select", label: "Multi-select" },
  { kind: "relation", label: "Relation (link to items)" },
];
const NEEDS_OPTIONS: PropertyKind[] = ["select", "multi_select"];

const selectClass =
  "rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

// Client-side slug, kept in step with the server SLUG_RE: lowercase, non-alnum
// to underscore, must start with a letter.
function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "";
  return /^[a-z]/.test(base) ? base : `f_${base}`;
}

// Editor row: a stable local id for React, the (immutable once set) property
// key, the editable label/kind, and options as raw comma-separated text. For a
// `relation` kind, targetType (a type key, "" = any) and cardinality also apply;
// they're ignored for the other kinds.
type Row = {
  id: number;
  key: string; // "" for a new row; derived at save so a rename never orphans values
  label: string;
  kind: PropertyKind;
  optionsText: string;
  targetType: string;
  cardinality: RelationCardinality;
  // `date` kind only: range end + wall-clock time (ADR-166 / ADR-254).
  withEnd: boolean;
  withTime: boolean;
};

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

// Compact icon chooser: a trigger showing the current glyph + key that opens the
// searchable NavIconPicker grid (the same picker the nav slot editor uses), so
// the type icon is picked visually instead of typed. Keeps the form tight — the
// grid only appears while open.
function IconField({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${selectClass} flex w-44 items-center gap-2`}
      >
        <span className="text-neutral-300">
          <NavGlyph icon={value || "items"} size={18} />
        </span>
        <span className="flex-1 truncate text-left">{value || "Choose icon…"}</span>
        <span className="text-neutral-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="w-72">
          <NavIconPicker
            value={value}
            onChange={(key) => {
              onChange(key);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function TypeBuilder({
  initial,
  attached,
  itemCount = 0,
  availableTypes = [],
}: {
  initial?: TypeDefinition;
  // SPIKE (bespoke-tool catalog): the bespoke tool this type borrows, resolved
  // server-side to {id, label} so this client form never imports the registry.
  // Set when arriving from the catalog (new) or editing a type that has one.
  attached?: { id: string; label: string } | null;
  // How many items currently use this type — drives the delete confirmation's
  // "also delete its items" option.
  itemCount?: number;
  // The live types (key + label), to populate a relation field's target-type
  // dropdown. Server-resolved (listTypes) so this client form never imports the
  // DB-backed registry; hidden types are already excluded upstream.
  availableTypes?: { key: string; label: string }[];
}) {
  const router = useRouter();
  const editing = !!initial;
  const isSystem = initial?.isSystem ?? false;
  const capability = attached?.id ?? null;
  // Tabs (ADR-095) are surfaced here as a plain per-type toggle rather than only
  // via the bespoke-tool catalog, so ANY type — new or existing — can turn the
  // canvas tabs strip on/off without the "create a bespoke type" detour. Under
  // the hood it's still the "tabs" capability; we keep any OTHER attached
  // capability (a real bespoke canvas like the chord grid) untouched, since
  // `capability` is single-valued.
  const otherCapability = capability && capability !== "tabs" ? capability : null;
  // The built-in Note type always has tabs (MarkdownCanvas hardcodes it), so the
  // toggle is shown checked + locked there for honesty rather than hidden.
  const isNote = initial?.key === "note";
  const hasItems = itemCount > 0;
  const [deleteItems, setDeleteItems] = useState(false);
  // A brief "Saved" toast after an edit-save. We stay on the page (no bounce to
  // the types list) so the builder now needs its own success affordance.
  const [justSaved, setJustSaved] = useState(false);

  // Ref counter for stable React keys on new rows. Seeded past the initial
  // rows' count so a freshly-added row never collides with a seeded one. Only
  // read in event handlers (makeRow), never during render.
  const nextId = useRef(initial?.propertySchema.length ?? 0);
  const makeRow = (p?: PropertyDef): Row => ({
    id: nextId.current++,
    key: p?.key ?? "",
    label: p?.label ?? "",
    kind: p?.kind ?? "text",
    optionsText: p?.options?.join(", ") ?? "",
    targetType: p?.targetType ?? "",
    cardinality: p?.cardinality ?? "many",
    withEnd: p?.withEnd === true,
    withTime: p?.withTime === true,
  });

  const [label, setLabel] = useState(initial?.label ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [keyEdited, setKeyEdited] = useState(editing); // don't auto-fill once editing/typed
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [showInQuickCapture, setShowInQuickCapture] = useState(
    initial?.showInQuickCapture ?? true
  );
  const [tabsEnabled, setTabsEnabled] = useState(capability === "tabs");
  // Project-style page: EXPLICIT opt-in (Tyler, 2026-08-18/19 — ADR-204). New
  // custom types used to get the widget homepage silently, which read as "my
  // type got treated as a Project"; now it's this checkbox. A type that already
  // carries widget-home starts checked (grandfathered on; uncheck to leave).
  const [projectStyle, setProjectStyle] = useState(capability === "widget-home");
  // Seed rows from the existing schema with index ids (no ref read in render).
  const [rows, setRows] = useState<Row[]>(() =>
    (initial?.propertySchema ?? []).map((p, i) => ({
      id: i,
      key: p.key,
      label: p.label,
      kind: p.kind,
      optionsText: p.options?.join(", ") ?? "",
      targetType: p.targetType ?? "",
      cardinality: p.cardinality ?? "many",
      withEnd: p.withEnd === true,
      withTime: p.withTime === true,
    }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeLabel(v: string) {
    setLabel(v);
    if (!editing && !keyEdited) setKey(slugify(v));
  }

  function updateRow(id: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: number) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  function moveRow(id: number, dir: -1 | 1) {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  // Build the PropertyDef[] payload: derive a stable key for new rows, ensure
  // keys are unique (suffixing collisions), and split option text.
  function buildSchema(): { schema: PropertyDef[]; error?: string } {
    const used = new Set<string>();
    const schema: PropertyDef[] = [];
    for (const r of rows) {
      const propLabel = r.label.trim();
      if (!propLabel) return { schema, error: "Every property needs a label." };
      let k = r.key || slugify(propLabel) || "field";
      while (used.has(k)) k = `${k}_2`;
      used.add(k);
      const def: PropertyDef = { key: k, label: propLabel, kind: r.kind };
      if (NEEDS_OPTIONS.includes(r.kind)) {
        const options = Array.from(
          new Set(
            r.optionsText
              .split(",")
              .map((o) => o.trim())
              .filter(Boolean)
          )
        );
        if (options.length === 0) {
          return { schema, error: `"${propLabel}" needs at least one option.` };
        }
        def.options = options;
      }
      if (r.kind === "relation") {
        def.targetType = r.targetType || null; // "" = any type
        def.cardinality = r.cardinality;
      }
      if (r.kind === "date") {
        if (r.withEnd) def.withEnd = true;
        if (r.withTime) def.withTime = true;
      }
      schema.push(def);
    }
    return { schema };
  }

  async function save() {
    if (busy) return;
    setError(null);
    if (!label.trim()) {
      setError("Give the type a name.");
      return;
    }
    const finalKey = editing ? initial!.key : key || slugify(label);
    if (!editing && !finalKey) {
      setError("Give the type a key (letters, digits, underscore).");
      return;
    }
    const { schema, error: schemaError } = buildSchema();
    if (schemaError) {
      setError(schemaError);
      return;
    }
    setBusy(true);
    const payload = {
      label: label.trim(),
      icon: icon.trim() || null,
      showInQuickCapture,
      propertySchema: schema,
      // One capability slot, three explicit claimants: the "tabs" toggle, the
      // "Project-style page" checkbox (widget-home — an OPT-IN since ADR-204;
      // it used to be the silent default for custom types), then any real
      // bespoke canvas the type already borrowed. None of them → null, the
      // plain document canvas (core/system types resolve their module canvas
      // regardless).
      capability: tabsEnabled
        ? "tabs"
        : projectStyle
          ? "widget-home"
          : otherCapability !== "widget-home"
            ? otherCapability
            : null,
      ...(editing ? {} : { key: finalKey }),
    };
    try {
      const res = await fetch(
        editing ? `/api/types/${initial!.key}` : "/api/types",
        {
          method: editing ? "PATCH" : "POST",
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
      if (!editing) {
        // Land on the new type's edit page, not the list: statuses live in the
        // StatusSchemaEditor, which only renders on edit. Bouncing to the list
        // hid them until the user saved and reopened the type (the worst Build
        // friction the audit found).
        const data = (await res.json().catch(() => null)) as
          | { type?: { key?: string } }
          | null;
        router.push(`/build/types/${data?.type?.key ?? finalKey}/edit`);
        router.refresh();
      } else {
        // Editing: stay put (Brandon, 2026-07-01 — saving shouldn't dump you
        // back at the types list). Flash a "Saved" toast and refresh so the page
        // header/label/icon reflect the change.
        setBusy(false);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2200);
        router.refresh();
      }
    } catch {
      setError("save failed (offline?)");
      setBusy(false);
    }
  }

  // The in-context delete (ConfirmButton owns the confirm popover + its own
  // busy/error). Throwing surfaces the message inside the popover; success
  // navigates away. With `deleteItems`, the type's items are taken too
  // (?withItems=1), otherwise the server blocks while items still reference it.
  async function confirmDelete() {
    const url = `/api/types/${initial!.key}${deleteItems ? "?withItems=1" : ""}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `delete failed (${res.status})`);
    }
    router.push("/build/types");
    router.refresh();
  }

  // The Project-style checkbox renders only where it can actually apply: not on
  // system types (their module canvas wins) and not on a type borrowing a real
  // bespoke canvas (single capability slot).
  const projectStyleAvailable =
    !isSystem && (otherCapability === null || otherCapability === "widget-home");

  return (
    <div className="mt-6 flex max-w-xl flex-col gap-4">
      {/* Brief success toast — top-centered, auto-dismisses. Shown after an
          edit-save now that saving keeps you on the page. */}
      {justSaved && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 top-6 z-[70] flex justify-center"
        >
          <div className="flex items-center gap-2 rounded-full border border-green-700/60 bg-neutral-900/95 px-4 py-2 text-sm font-medium text-green-300 shadow-xl shadow-black/40 backdrop-blur">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Saved
          </div>
        </div>
      )}
      {attached && attached.id !== "tabs" && (
        <div className="rounded-lg border border-neutral-700 bg-neutral-900/60 px-3 py-2 text-sm">
          <span className="text-neutral-500">Bespoke tool: </span>
          <span className="font-medium text-neutral-200">{attached.label}</span>
          <p className="mt-0.5 text-xs text-neutral-500">
            This type will use the {attached.label} canvas. Give it any name you
            like.
          </p>
        </div>
      )}
      <Field label="Name">
        <input
          value={label}
          onChange={(e) => changeLabel(e.target.value)}
          placeholder="e.g. Hiring Candidate"
          className={selectClass}
        />
      </Field>

      <Field
        label="Key"
        hint={
          editing
            ? "The internal id this type is stored under. Fixed once created so existing items don't break."
            : "The internal id this type is stored under (lowercase, no spaces). Auto-filled from the name; you rarely need to change it."
        }
      >
        <input
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setKeyEdited(true);
          }}
          disabled={editing}
          placeholder="hiring_candidate"
          className={`${selectClass} font-mono ${editing ? "opacity-60" : ""}`}
        />
      </Field>

      <div className="flex flex-wrap items-end gap-4">
        {/* A div, not a Field: Field wraps a <label>, which would hijack clicks
            on the picker's buttons/search input. Same label styling, manual. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-400">Icon</span>
          <IconField value={icon} onChange={setIcon} />
          <span className="text-xs text-neutral-600">
            The glyph shown next to this type in the nav and on its @-mentions.
          </span>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={showInQuickCapture}
            onChange={(e) => setShowInQuickCapture(e.target.checked)}
            className="ledgr-check"
          />
          Show in quick capture
        </label>
        <label className="group relative flex items-center gap-2 pb-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={isNote || tabsEnabled}
            disabled={isNote}
            onChange={(e) => {
              setTabsEnabled(e.target.checked);
              // One capability slot: tabs and the project-style page can't
              // both be on.
              if (e.target.checked) setProjectStyle(false);
            }}
            className="ledgr-check"
          />
          <span className="cursor-help underline decoration-dotted decoration-neutral-600 underline-offset-2">
            Enable tabs
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs normal-case text-neutral-300 opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
          >
            {isNote
              ? "Notes always have canvas tabs."
              : "Split this type's canvas into named tabs, each a section of the same body — e.g. research vs. draft on one item."}
          </span>
        </label>
      </div>

      {projectStyleAvailable && (
        <label className="group relative flex items-center gap-2 pb-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={projectStyle && !tabsEnabled}
            onChange={(e) => {
              setProjectStyle(e.target.checked);
              if (e.target.checked) setTabsEnabled(false);
            }}
            className="ledgr-check"
          />
          <span className="cursor-help underline decoration-dotted decoration-neutral-600 underline-offset-2">
            Project-style page
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-72 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs normal-case text-neutral-300 opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
          >
            Records of this type open like a Project: a composable page of
            tools (tasks, notes, milestones, progress, …) bound to each record,
            with Add a Tool to shape it. Off = the plain document canvas.
          </span>
        </label>
      )}

      <fieldset className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Properties
        </legend>
        {rows.length === 0 && (
          <p className="px-1 text-sm text-neutral-600">
            No custom properties yet. Add fields this type should carry.
          </p>
        )}
        {rows.map((row, i) => (
          <div
            key={row.id}
            className="flex flex-col gap-2 rounded border border-neutral-800/70 bg-neutral-900/40 p-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={row.label}
                onChange={(e) => updateRow(row.id, { label: e.target.value })}
                placeholder="Field name"
                aria-label="Property label"
                className={`${selectClass} min-w-0 flex-1`}
              />
              <select
                value={row.kind}
                onChange={(e) =>
                  updateRow(row.id, { kind: e.target.value as PropertyKind })
                }
                aria-label="Property kind"
                className={selectClass}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <div className="flex items-center">
                <button
                  onClick={() => moveRow(row.id, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveRow(row.id, 1)}
                  disabled={i === rows.length - 1}
                  aria-label="Move down"
                  className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  onClick={() => removeRow(row.id)}
                  aria-label="Remove property"
                  className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            </div>
            {row.kind === "date" && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-500">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="ledgr-check"
                    checked={row.withTime}
                    onChange={(e) => updateRow(row.id, { withTime: e.target.checked })}
                  />
                  Include a time of day
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="ledgr-check"
                    checked={row.withEnd}
                    onChange={(e) => updateRow(row.id, { withEnd: e.target.checked })}
                  />
                  Has an end (a range)
                </label>
              </div>
            )}
            {NEEDS_OPTIONS.includes(row.kind) && (
              <input
                value={row.optionsText}
                onChange={(e) =>
                  updateRow(row.id, { optionsText: e.target.value })
                }
                placeholder="Comma-separated options, e.g. Applied, Interview, Offer"
                aria-label="Options"
                className={`${selectClass} w-full`}
              />
            )}
            {row.kind === "relation" && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                  Links to
                  <select
                    value={row.targetType}
                    onChange={(e) =>
                      updateRow(row.id, { targetType: e.target.value })
                    }
                    aria-label="Target type"
                    className={selectClass}
                  >
                    <option value="">Any type</option>
                    {availableTypes.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                  How many
                  <select
                    value={row.cardinality}
                    onChange={(e) =>
                      updateRow(row.id, {
                        cardinality: e.target.value as RelationCardinality,
                      })
                    }
                    aria-label="Cardinality"
                    className={selectClass}
                  >
                    <option value="many">Many</option>
                    <option value="single">One</option>
                  </select>
                </label>
              </div>
            )}
          </div>
        ))}
        <button
          onClick={() => setRows((rs) => [...rs, makeRow()])}
          className="self-start rounded border border-neutral-800 px-2.5 py-1 text-sm text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800/60"
        >
          + Add property
        </button>
      </fieldset>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : editing ? "Save changes" : "Create type"}
        </button>
        {editing && !isSystem && (
          <ConfirmButton
            onConfirm={confirmDelete}
            title={`Delete the “${initial!.label}” type?`}
            description={
              hasItems
                ? `${itemCount} item${itemCount === 1 ? "" : "s"} use this type.`
                : "This can't be undone."
            }
            confirmLabel={
              hasItems && deleteItems ? `Delete type + ${itemCount}` : "Delete type"
            }
            triggerClassName="text-sm text-red-400 hover:text-red-300"
            trigger="Delete"
          >
            {hasItems && (
              <>
                <label className="flex items-start gap-2 text-xs text-neutral-200">
                  <input
                    type="checkbox"
                    checked={deleteItems}
                    onChange={(e) => setDeleteItems(e.target.checked)}
                    className="ledgr-check mt-0.5"
                  />
                  <span>
                    Also move the {itemCount} item{itemCount === 1 ? "" : "s"}{" "}
                    using this type to Trash. You can restore the type and its
                    items from Trash.
                  </span>
                </label>
                {!deleteItems && (
                  <p className="mt-1.5 text-xs text-neutral-500">
                    Leave unchecked to keep the items — the type can&rsquo;t be
                    deleted while they exist.
                  </p>
                )}
              </>
            )}
          </ConfirmButton>
        )}
        {isSystem && (
          <span className="text-xs text-neutral-600">
            Built-in type — can be extended, not deleted.
          </span>
        )}
      </div>
    </div>
  );
}
