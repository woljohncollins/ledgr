// The canvas top strip (PRD §4.13): the type's at-a-glance fields laid out
// horizontally as label-value pairs, one line instead of a Notion-style
// vertical stack. Every change PATCHes immediately and optimistically; a
// failure reverts to the server truth and says so.
"use client";

import { useRef, useState } from "react";
import { uploadAttachment } from "@/components/attachments/upload";
import { showToast } from "@/components/ui/ActionToast";
import type { CanvasField } from "@/lib/canvas-fields";
import { ITEM_STATUSES, URGENCIES } from "@/lib/item-enums";
import { priorityStyle, type Priority } from "@/lib/priority";
import type { StatusDef } from "@/lib/status";
import { beginSave, endSave } from "@/lib/save-status";
import { addDaysYmd } from "@/lib/recurrence";
import { parseNaturalDate } from "@/lib/nl-date";

export type StripValues = {
  status: string;
  dueDate: string | null; // ISO strings; Dates don't round-trip user edits
  scheduledDate: string | null;
  urgency: number | null;
  meetingAt: string | null;
  noteDate: string | null;
  url: string | null;
};

// datetime-local wants local wall-clock time, no zone suffix.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

// Styled from the S1 token layer (ui-refresh S3): quieter borders (--line) on a
// panel surface, brighter on focus/hover — the calm chip strip under the title.
const selectClass =
  "rounded-md border border-line bg-surface-1 px-2 py-0.5 text-sm text-ink outline-none focus:border-line-strong";
const inputClass = selectClass;
// Reschedule shortcut chips on the scheduled field (T2).
const chipClass =
  "rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted hover:border-line-strong hover:text-ink";

// ISO instant (UTC midnight) for a calendar day, matching how scheduled/due are
// stored and sliced elsewhere.
function ymdToIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

export default function FieldStrip({
  itemId,
  fields,
  initial,
  today,
  statuses,
  layout = "strip",
  flush = false,
  locked = false,
}: {
  itemId: string;
  fields: CanvasField[];
  initial: StripValues;
  // "strip" (default) = the horizontal one-line top strip of the classic canvas.
  // "rail" = a vertical stack of labeled, divided sections for a narrow right
  // pane (the task canvas), flush (no wide centered-column padding).
  layout?: "strip" | "rail";
  // Drop the strip's built-in centered-column padding so it aligns inside a
  // parent that already provides the column padding (e.g. the note byline).
  flush?: boolean;
  // App-timezone today (YYYY-MM-DD); enables the reschedule shortcuts + natural-
  // language date entry on the scheduled field (native tasks, T2). Absent → the
  // scheduled field is a plain date picker.
  today?: string;
  // The item type's resolved statuses (S2): the dropdown options with their
  // labels + colors, and a done-glyph on done-category statuses. Absent → the
  // inherited default keys (a non-task field strip never shows status anyway).
  statuses?: StatusDef[];
  // When true (the item lock toggle): every control is disabled and can't be
  // clicked into, via a disabled <fieldset> wrapping the row.
  locked?: boolean;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState(false);
  // The URL field's upload path (Tyler, 2026-08-29): a link can point at your
  // own storage — pick or drop a file and its stable /files/<id> address
  // becomes this URL. One affordance, no second concept beside the File type.
  const urlFileRef = useRef<HTMLInputElement>(null);
  const [uploadingUrl, setUploadingUrl] = useState(false);

  // One field per request is fine here: strip edits are single deliberate
  // clicks, not keystroke streams like the body autosave.
  async function save(patch: Partial<StripValues>) {
    const before = values;
    setValues((v) => ({ ...v, ...patch }));
    setError(false);
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
    } catch {
      setValues(before);
      setError(true);
      endSave(false);
    }
  }

  async function uploadAsUrl(file: File) {
    setUploadingUrl(true);
    try {
      const up = await uploadAttachment(itemId, file);
      await save({ url: up.fileUrl });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingUrl(false);
    }
  }

  function field(name: CanvasField) {
    switch (name) {
      case "status": {
        const opts: StatusDef[] =
          statuses && statuses.length
            ? statuses
            : ITEM_STATUSES.map((k) => ({
                key: k,
                label: k,
                category: "not_started" as const,
                color: "#64748b",
              }));
        const current = opts.find((s) => s.key === values.status);
        return (
          <span className="inline-flex items-center gap-1.5">
            {/* A color dot for the current status; done-category options carry a
                ✓ in their label (a native select can't style each option). */}
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: current?.color ?? "#64748b" }}
            />
            <select
              className={selectClass}
              value={values.status}
              onChange={(e) => void save({ status: e.target.value })}
            >
              {opts.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                  {s.category === "done" ? " ✓" : ""}
                </option>
              ))}
            </select>
          </span>
        );
      }
      case "dueDate":
        return (
          <input
            type="date"
            className={inputClass}
            // Due dates are stored as UTC midnight; slicing the ISO string
            // (not local formatting) keeps the picked day stable.
            value={values.dueDate ? values.dueDate.slice(0, 10) : ""}
            onChange={(e) =>
              void save({ dueDate: e.target.value || null })
            }
          />
        );
      case "scheduledDate": {
        const set = (ymd: string | null) =>
          void save({ scheduledDate: ymd ? ymdToIso(ymd) : null });
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              className={inputClass}
              // Scheduled is a calendar day like due (UTC midnight); slice, don't
              // local-format, so the picked day stays put (native tasks, ADR-076).
              value={values.scheduledDate ? values.scheduledDate.slice(0, 10) : ""}
              onChange={(e) => set(e.target.value || null)}
            />
            {today && (
              <>
                <button type="button" className={chipClass} onClick={() => set(today)}>
                  Today
                </button>
                <button type="button" className={chipClass} onClick={() => set(addDaysYmd(today, 1))}>
                  Tomorrow
                </button>
                <button type="button" className={chipClass} onClick={() => set(addDaysYmd(today, 7))}>
                  +1wk
                </button>
                <input
                  type="text"
                  className={`${inputClass} w-28`}
                  placeholder="e.g. next fri"
                  // Free-text NL date: parse on Enter/blur (T2). A phrase we don't
                  // understand is ignored (the field clears), not guessed.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (!v) return;
                    const ymd = parseNaturalDate(v, today);
                    if (ymd) set(ymd);
                    e.target.value = "";
                  }}
                />
              </>
            )}
          </span>
        );
      }
      case "urgency":
        return (
          <select
            className={`${selectClass} ${values.urgency ? priorityStyle(values.urgency as Priority).text : ""}`}
            value={values.urgency ?? ""}
            onChange={(e) =>
              void save({ urgency: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">none</option>
            {URGENCIES.map((u) => (
              <option key={u} value={u}>
                {`P${u}`}
              </option>
            ))}
          </select>
        );
      case "meetingAt":
        return (
          <input
            type="datetime-local"
            className={inputClass}
            value={values.meetingAt ? toLocalInput(values.meetingAt) : ""}
            onChange={(e) =>
              void save({
                meetingAt: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : null,
              })
            }
          />
        );
      case "noteDate":
        return (
          <input
            type="date"
            className={inputClass}
            // The date the note was taken; stored UTC-midnight like due/scheduled
            // (ADR-110), so slice the ISO rather than local-format to keep the
            // picked day stable. Clearing reverts it to empty (no date taken).
            value={values.noteDate ? values.noteDate.slice(0, 10) : ""}
            onChange={(e) => void save({ noteDate: e.target.value || null })}
          />
        );
      case "url":
        return (
          <span className="inline-flex items-center gap-1">
            <input
              type="url"
              // Keyed on the saved value so an upload (or any external save)
              // refreshes this otherwise-uncontrolled input's display.
              key={values.url ?? ""}
              className={`${inputClass} w-56`}
              placeholder="https:// (or drop a file)"
              defaultValue={values.url ?? ""}
              // Free-text fields commit on blur/Enter, not per keystroke.
              onBlur={(e) => {
                const v = e.target.value.trim() || null;
                if (v !== values.url) void save({ url: v });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              // Drop a file straight onto the field: it uploads and its stable
              // address becomes the URL.
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const file = e.dataTransfer?.files?.[0];
                if (!file) return;
                e.preventDefault();
                void uploadAsUrl(file);
              }}
            />
            <button
              type="button"
              disabled={uploadingUrl}
              title="Upload a file — its address becomes this URL"
              aria-label="Upload a file as this link's URL"
              onClick={() => urlFileRef.current?.click()}
              className="rounded-md border border-line bg-surface-1 p-1 text-ink-subtle hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20.5 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5" />
              </svg>
            </button>
            <input
              ref={urlFileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadAsUrl(file);
              }}
            />
          </span>
        );
    }
  }

  const labels: Record<CanvasField, string> = {
    status: "Status",
    dueDate: "Due",
    scheduledDate: "Scheduled",
    urgency: "Urgency",
    meetingAt: "When",
    noteDate: "Date taken",
    url: "URL",
  };

  if (layout === "rail") {
    return (
      <div className="flex flex-col">
        {fields.map((name) => (
          <div
            key={name}
            className="border-t border-line py-3 first:border-t-0 first:pt-0"
          >
            <div className="ui-section-label mb-1.5">{labels[name]}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
              {field(name)}
            </div>
          </div>
        ))}
        {error && (
          <span className="text-xs text-red-400">Save failed, change reverted</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 ${
        flush ? "" : "px-2 pb-2 sm:px-8 md:px-12"
      } ${locked ? "opacity-60" : ""}`}
    >
      {/* A disabled fieldset locks every control inside at once (a locked item);
          `contents` keeps the flex layout flat, so the row looks unchanged. */}
      <fieldset disabled={locked} className="contents">
        {fields.map((name) => (
          <label
            key={name}
            className="flex items-center gap-1.5 text-xs text-ink-subtle"
          >
            {labels[name]}
            {field(name)}
          </label>
        ))}
      </fieldset>
      {error && (
        <span className="text-xs text-red-400">Save failed, change reverted</span>
      )}
    </div>
  );
}
