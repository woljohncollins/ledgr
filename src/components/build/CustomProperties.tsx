// The editable custom-property panel on the item canvas (slice 33, PRD §3.6):
// renders a type's property_schema as inputs over items.properties and PATCHes
// on change, the same optimistic-with-revert pattern as the FieldStrip.
//
// items.properties also holds namespaced system keys (email/todoist/calendar/
// match/notify), so this never sends only the schema fields — it keeps the full
// properties object in state and overlays the edited field, so a PATCH can't
// wipe a system key the schema doesn't know about.
"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { contactInputType, contactLink } from "@/lib/contact-links";
import { beginSave, endSave } from "@/lib/save-status";
import type { PropertyDef } from "@/lib/types";
import { propInstant } from "@/lib/placement";
import ImageBox from "./ImageBox";
import { imageUrl } from "@/lib/person-image";

// datetime-local speaks the BROWSER's zone, which for a single-user app is the
// owner's zone in practice. ponytail: if a device ever edits from another zone,
// route these through users.settings.timezone (zone.ts zonedInstant) instead.
const pad2 = (n: number) => String(n).padStart(2, "0");
function toLocalInput(stored: string): string {
  const inst = propInstant(stored);
  if (inst) {
    return `${inst.getFullYear()}-${pad2(inst.getMonth() + 1)}-${pad2(inst.getDate())}T${pad2(inst.getHours())}:${pad2(inst.getMinutes())}`;
  }
  // A day-only value in a timed field seeds the day; the clock starts at 00:00.
  return stored.length >= 10 ? `${stored.slice(0, 10)}T00:00` : "";
}
function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
import InlineLabel from "./InlineLabel";

// max-w-full so a fixed-width control (w-56, w-32) can't push past a narrow
// container — the task rail scrolls on overflow-y, which makes overflow-x `auto`
// too, so any few px of horizontal spill shows up as a scrollbar + shifted rail.
const inputClass =
  "max-w-full rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

// Box-like kinds whose empty control reads as visual noise (the row of blank
// inputs on a sparse Person). When empty they collapse into a "+ label" add-chip
// cluster. The others always render as rows: checkbox IS its control, select
// shows a compact "—", and multi_select must show its options to be usable.
const RECEDE_KINDS = new Set(["text", "url", "phone", "email", "number", "date"]);

// A value worth showing as a filled row (and offering an explicit clear for).
// Checkbox has no "empty" state — the toggle is the control — so it's excluded.
function isFilled(v: unknown, kind: string): boolean {
  return (
    kind !== "checkbox" &&
    v != null &&
    v !== "" &&
    !(Array.isArray(v) && v.length === 0)
  );
}

// A clickable target derived from a filled scalar value, so a Person's email /
// phone / website property isn't a dead text box. The `phone`/`email`/`url` kinds
// declare the intent outright (ADR-192); a legacy `text` field keyed or shaped
// like one still gets the same affordance, so imported data keeps working.
// Shared with the list's table layout — lib/contact-links.ts owns the rules.
function openTarget(prop: PropertyDef, value: unknown) {
  return contactLink(prop.kind, prop.key, value);
}

type Values = Record<string, unknown>;

// A `phone`/`email` field, or a legacy `text` field keyed like one, renders as a
// single-line typed input (right on-screen keyboard on mobile, format hint)
// instead of the default wrapping textarea. Null keeps the textarea.
function textInputType(prop: PropertyDef) {
  return contactInputType(prop.kind, prop.key);
}

// An uncontrolled textarea whose height tracks its content, for the wrapping
// `text` property (Brandon, 2026-06-17). Uncontrolled (defaultValue) so a parent
// re-render never collapses it; grows on input.
function AutoGrowTextarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(grow, []);
  return <textarea ref={ref} rows={1} onInput={grow} {...props} />;
}

export default function CustomProperties({
  itemId,
  typeKey,
  schema,
  initial,
  hideHeading = false,
  bare = false,
  wide = false,
  locked = false,
}: {
  itemId: string;
  typeKey: string;
  schema: PropertyDef[];
  initial: Values;
  // Drop the "Properties" section heading when rendered as a single per-field
  // card (ADR-069) — the field's own label already names it, so the category
  // heading on every card was noise (Brandon, 2026-06-17).
  hideHeading?: boolean;
  // Drop the wide centered-column padding for a narrow rail (task canvas).
  bare?: boolean;
  // Lay the filled rows out across the available width instead of one narrow
  // column (Tyler, 2026-09-14). For a wide surface like the project canvas,
  // where a single stacked column leaves most of the row empty.
  wide?: boolean;
  // When true (the item lock toggle): every field (and its clear button) is
  // disabled and can't be clicked into, via a disabled <fieldset> wrapper.
  locked?: boolean;
}) {
  const [values, setValues] = useState<Values>(initial ?? {});
  const [error, setError] = useState(false);
  // Remount key per field, bumped when the × clears a value. The text/url/number
  // inputs are uncontrolled (defaultValue, to avoid per-keystroke re-render), so
  // clearing state alone wouldn't empty the visible box — remounting reads the
  // now-null state as a fresh empty defaultValue. Controlled kinds ignore it.
  const [rev, setRev] = useState<Record<string, number>>({});
  // Keys the user has explicitly opened for editing on an otherwise-empty,
  // box-like field. Empty text/url/number/date fields recede to a quiet "+ Add"
  // so a sparse item reads as intentional, not unfinished (Brandon, 2026-06-21:
  // scope by hiding); clicking "+ Add" reveals the control focused, and blurring
  // it still empty recedes it again.
  const [editing, setEditing] = useState<Set<string>>(new Set());
  // Keys with a PATCH in flight, for a per-field "saving" dim (the global
  // indicator is small and easy to miss inside a modal).
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const openField = (key: string) =>
    setEditing((s) => new Set(s).add(key));
  const recedeIfEmpty = (key: string, nv: unknown) => {
    if (nv == null || nv === "")
      setEditing((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
  };

  // Update the changed key and PATCH it as a per-key merge (propertyPatch),
  // not a wholesale properties replace — so an instance rendering only a subset
  // of the schema (a single per-property canvas card, ADR-069) can't clobber the
  // keys it doesn't own. Revert to the prior object on failure.
  async function save(patch: Values) {
    const before = values;
    const next = { ...values, ...patch };
    const keys = Object.keys(patch);
    setValues(next);
    setError(false);
    setSaving((s) => {
      const n = new Set(s);
      keys.forEach((k) => n.add(k));
      return n;
    });
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyPatch: patch }),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
    } catch {
      setValues(before);
      setError(true);
      endSave(false);
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  }

  function control(prop: PropertyDef, autoFocus = false) {
    const v = values[prop.key];
    switch (prop.kind) {
      // phone/email share this branch (ADR-192): textInputType always returns a
      // typed input for them, so they take the single-line path below and need no
      // control of their own. No placeholder on purpose — a sample number would
      // imply a required format, and any format is accepted.
      case "phone":
      case "email":
      case "text": {
        const typed = textInputType(prop);
        // Email/phone-keyed text is a single-line typed input; everything else is
        // a wrapping, auto-growing field (Brandon, 2026-06-17) so long text shows
        // in full instead of scrolling in a single line. Both commit on blur.
        if (typed) {
          return (
            <input
              key={`${prop.key}:${rev[prop.key] ?? 0}`}
              type={typed.type}
              inputMode={typed.inputMode}
              autoFocus={autoFocus}
              className={`${inputClass} w-56`}
              defaultValue={typeof v === "string" ? v : ""}
              onBlur={(e) => {
                const nv = e.target.value.trim() || null;
                if (nv !== (v ?? null)) void save({ [prop.key]: nv });
                recedeIfEmpty(prop.key, nv);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          );
        }
        return (
          <AutoGrowTextarea
            key={`${prop.key}:${rev[prop.key] ?? 0}`}
            autoFocus={autoFocus}
            className={`${inputClass} w-56 resize-none overflow-hidden leading-snug`}
            defaultValue={typeof v === "string" ? v : ""}
            onBlur={(e) => {
              const nv = e.target.value.trim() || null;
              if (nv !== (v ?? null)) void save({ [prop.key]: nv });
              recedeIfEmpty(prop.key, nv);
            }}
          />
        );
      }
      case "url":
        return (
          <input
            key={`${prop.key}:${rev[prop.key] ?? 0}`}
            type="url"
            inputMode="url"
            autoFocus={autoFocus}
            className={`${inputClass} w-56`}
            placeholder="https://"
            defaultValue={typeof v === "string" ? v : ""}
            onBlur={(e) => {
              const nv = e.target.value.trim() || null;
              if (nv !== (v ?? null)) void save({ [prop.key]: nv });
              recedeIfEmpty(prop.key, nv);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        );
      // The picture box (ADR-255) carries its own upload/paste/remove UI, so
      // it needs no defaultValue/onBlur wiring like the scalar controls above.
      case "image":
        return <ImageBox itemId={itemId} propKey={prop.key} initial={imageUrl(v)} />;
      case "number":
        return (
          <input
            key={`${prop.key}:${rev[prop.key] ?? 0}`}
            type="number"
            autoFocus={autoFocus}
            className={`${inputClass} w-32`}
            defaultValue={typeof v === "number" ? String(v) : ""}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const nv = raw === "" ? null : Number(raw);
              if (nv !== null && Number.isNaN(nv)) return;
              if (nv !== (typeof v === "number" ? v : null)) {
                void save({ [prop.key]: nv });
              }
              recedeIfEmpty(prop.key, raw);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        );
      case "date": {
        // A withTime field (ADR-254) edits a local wall-clock and stores an
        // instant; a withEnd field shows a second input for its `__end` sibling.
        const endKey = `${prop.key}__end`;
        const input = (key: string, focus: boolean) => {
          const raw = values[key];
          const str = typeof raw === "string" ? raw : "";
          return prop.withTime ? (
            <input
              key={key}
              type="datetime-local"
              autoFocus={focus}
              className={inputClass}
              value={toLocalInput(str)}
              onChange={(e) => void save({ [key]: fromLocalInput(e.target.value) })}
              onBlur={(e) => key === prop.key && recedeIfEmpty(prop.key, e.target.value)}
            />
          ) : (
            <input
              key={key}
              type="date"
              autoFocus={focus}
              className={inputClass}
              value={str.slice(0, 10)}
              onChange={(e) => void save({ [key]: e.target.value || null })}
              onBlur={(e) => key === prop.key && recedeIfEmpty(prop.key, e.target.value)}
            />
          );
        };
        if (!prop.withEnd) return input(prop.key, autoFocus);
        return (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {input(prop.key, autoFocus)}
            <span className="text-xs text-ink-subtle">to</span>
            {input(endKey, false)}
          </span>
        );
      }
      case "checkbox":
        return (
          <input
            type="checkbox"
            className="ledgr-check"
            checked={v === true}
            onChange={(e) => void save({ [prop.key]: e.target.checked })}
          />
        );
      case "select":
        return (
          <select
            className={inputClass}
            value={typeof v === "string" ? v : ""}
            onChange={(e) => void save({ [prop.key]: e.target.value || null })}
          >
            <option value="">—</option>
            {prop.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      case "multi_select": {
        const selected = Array.isArray(v) ? (v as string[]) : [];
        return (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {prop.options?.map((o) => (
              <label key={o} className="flex items-center gap-1 text-neutral-300">
                <input
                  type="checkbox"
                  className="ledgr-check ledgr-check-sm"
                  checked={selected.includes(o)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, o]
                      : selected.filter((x) => x !== o);
                    void save({ [prop.key]: next });
                  }}
                />
                {o}
              </label>
            ))}
          </span>
        );
      }
    }
  }

  // One filled-or-open property, rendered as a labelled row: the control, then
  // (when filled) the open-out affordance and the × clear.
  function renderRow(prop: PropertyDef, filled: boolean, isEditing: boolean) {
    const isSaving = saving.has(prop.key);
    return (
      // In the narrow rail (bare) the label stacks ABOVE its value (Tyler,
      // 2026-08-14): a fixed 128px label column ate most of a 280px rail and
      // squeezed every value into a truncated sliver. The wide canvas keeps the
      // side-by-side column, where it lines up and there's room for both.
      <div
        key={prop.key}
        className={`group text-sm ${bare ? "flex flex-col gap-0.5" : "flex items-center gap-3"}`}
      >
        <dt className={bare ? "text-xs font-medium text-ink-subtle" : "w-32 shrink-0 text-neutral-500"}>
          <InlineLabel typeKey={typeKey} propertyKey={prop.key} label={prop.label} />
        </dt>
        <dd className="flex min-w-0 items-center gap-1">
          {/* min-w-0: the controls are `w-56 max-w-full`, and max-w-full only
              caps them if THIS wrapper can shrink below its content. Without it a
              narrow layout card (4 of 12 columns, `overflow-auto`) is spilled by
              the 128px label + 224px control, and Windows paints a horizontal
              scrollbar under every field. */}
          <span className={`min-w-0 ${isSaving ? "opacity-50 transition-opacity" : ""}`}>
            {control(prop, isEditing && !filled)}
          </span>
          {filled && (() => {
            const target = openTarget(prop, values[prop.key]);
            if (!target) return null;
            return (
              <a
                href={target.href}
                target={target.external ? "_blank" : undefined}
                rel={target.external ? "noreferrer" : undefined}
                title={target.title}
                aria-label={target.title}
                className="shrink-0 rounded px-0.5 text-neutral-500 hover:text-[var(--accent)]"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M14 5h5v5M19 5l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
                </svg>
              </a>
            );
          })()}
          {/* Image already has its own Remove inside the box's popup, so the
              row-level clear here would just duplicate it (skipped for
              "image"; ADR-255). */}
          {filled && prop.kind !== "image" && (
            <button
              type="button"
              onClick={() => {
                void save({ [prop.key]: null });
                setRev((r) => ({ ...r, [prop.key]: (r[prop.key] ?? 0) + 1 }));
              }}
              aria-label={`Clear ${prop.label}`}
              title="Clear"
              className="shrink-0 rounded px-0.5 text-xs text-neutral-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100 max-sm:opacity-100"
            >
              ✕
            </button>
          )}
        </dd>
      </div>
    );
  }

  // Relation kinds (ADR-067) don't live in items.properties — their value is a
  // set of relations edges with role = the field key, rendered by the typed
  // relation input (RelationProperties), not here. Skip them so this scalar
  // panel doesn't draw an empty control for them.
  const scalarSchema = schema.filter((p) => p.kind !== "relation");
  if (scalarSchema.length === 0) return null;

  // Split the schema into filled/open fields (labelled rows) and empty box-like
  // fields (a wrapped cluster of "+ label" add-chips). Opening a chip moves that
  // field up into the rows; blurring it still-empty sends it back to a chip.
  const rowProps = scalarSchema.filter(
    (p) =>
      isFilled(values[p.key], p.kind) ||
      !RECEDE_KINDS.has(p.kind) ||
      editing.has(p.key)
  );
  const chipProps = scalarSchema.filter((p) => !rowProps.includes(p));

  return (
    <section className={bare ? "" : "mx-auto w-full max-w-3xl px-2 pb-6 pt-2 sm:px-8 md:px-12"}>
      {!hideHeading && (
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600">
          Properties
        </h2>
      )}
      {/* A disabled fieldset locks every control (and add-chip) at once on a
          locked item; `contents` keeps the flex/dl layout below it flat. */}
      <fieldset disabled={locked} className="contents">
        <div className={`flex flex-col gap-2 ${locked ? "opacity-60" : ""}`}>
          {rowProps.length > 0 && (
            <dl
              className={
                wide
                  ? "grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-2"
              }
            >
              {rowProps.map((prop) =>
                renderRow(prop, isFilled(values[prop.key], prop.kind), editing.has(prop.key))
              )}
            </dl>
          )}
          {chipProps.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chipProps.map((prop) => (
                <button
                  key={prop.key}
                  type="button"
                  onClick={() => openField(prop.key)}
                  className="inline-flex items-center gap-1 rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
                >
                  <span aria-hidden>+</span> {prop.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </fieldset>
      {error && (
        <p className="mt-2 text-xs text-red-400">Save failed, change reverted</p>
      )}
    </section>
  );
}
