// The guided "New Workflow" / "New Wiki" form (slice 35, PRD §4.14). It collects
// the key parameters — name, (workflow) the stages, the fields each record
// carries, and whether to surface it on Work — then POSTs to
// /api/build/structures, which generates the type + properties + starter views.
// On success it opens the primary view. Prefilled from a preset when one is
// chosen; fully editable (tweak on the fly is the point).
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { StructureKind, StructurePreset } from "@/lib/structure-templates";
import type { PropertyDef, PropertyKind } from "@/lib/types";

const KINDS: { kind: PropertyKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "number", label: "Number" },
  { kind: "date", label: "Date" },
  { kind: "checkbox", label: "Checkbox (yes/no)" },
  { kind: "url", label: "URL" },
  { kind: "image", label: "Image (upload or URL)" },
  { kind: "phone", label: "Phone (tap to call)" },
  { kind: "email", label: "Email (tap to mail)" },
  { kind: "select", label: "Select (one)" },
  { kind: "multi_select", label: "Multi-select" },
];
const NEEDS_OPTIONS: PropertyKind[] = ["select", "multi_select"];

const selectClass =
  "rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "";
  return /^[a-z]/.test(base) ? base : `f_${base}`;
}

type Row = {
  id: number;
  key: string;
  label: string;
  kind: PropertyKind;
  optionsText: string;
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

export default function StructureBuilder({
  kind,
  preset,
}: {
  kind: StructureKind;
  preset?: StructurePreset | null;
}) {
  const router = useRouter();
  const isWorkflow = kind === "workflow";

  // Row ids: a monotonic counter. Seeded past any preset rows so makeRow()
  // (used by the "Add field" handler) never collides with the index-seeded
  // initial rows below.
  const nextId = useRef(preset?.properties.length ?? 0);
  const makeRow = (p?: PropertyDef): Row => ({
    id: nextId.current++,
    key: p?.key ?? "",
    label: p?.label ?? "",
    kind: p?.kind ?? "text",
    optionsText: p?.options?.join(", ") ?? "",
  });

  const [name, setName] = useState(preset?.name ?? "");
  const [stages, setStages] = useState<string[]>(
    isWorkflow ? preset?.stages ?? ["", "", ""] : []
  );
  // Seed preset rows by index, not makeRow(), so the counter ref isn't read
  // during render (react-hooks/refs).
  const [rows, setRows] = useState<Row[]>(() =>
    (preset?.properties ?? []).map((p, i) => ({
      id: i,
      key: p.key ?? "",
      label: p.label ?? "",
      kind: p.kind ?? "text",
      optionsText: p.options?.join(", ") ?? "",
    }))
  );
  const [addToDashboard, setAddToDashboard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- stages (workflow) ---
  function setStage(i: number, v: string) {
    setStages((s) => s.map((x, j) => (j === i ? v : x)));
  }
  function addStage() {
    setStages((s) => [...s, ""]);
  }
  function removeStage(i: number) {
    setStages((s) => s.filter((_, j) => j !== i));
  }
  function moveStage(i: number, dir: -1 | 1) {
    setStages((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  // --- properties ---
  function updateRow(id: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: number) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  function buildSchema(): { schema: PropertyDef[]; error?: string } {
    const used = new Set<string>();
    const schema: PropertyDef[] = [];
    for (const r of rows) {
      const propLabel = r.label.trim();
      if (!propLabel) return { schema, error: "Every field needs a name." };
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
      schema.push(def);
    }
    return { schema };
  }

  async function save() {
    if (busy) return;
    setError(null);
    if (!name.trim()) {
      setError("Give it a name.");
      return;
    }
    const cleanStages = stages.map((s) => s.trim()).filter(Boolean);
    if (isWorkflow && cleanStages.length < 2) {
      setError("A workflow needs at least two stages.");
      return;
    }
    const { schema, error: schemaError } = buildSchema();
    if (schemaError) {
      setError(schemaError);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/build/structures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name: name.trim(),
          stages: isWorkflow ? cleanStages : undefined,
          properties: schema,
          addToDashboard,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `creation failed (${res.status})`);
        setBusy(false);
        return;
      }
      const { result } = (await res.json()) as {
        result: { typeKey: string; primaryViewId: string | null };
      };
      router.push(
        result.primaryViewId
          ? `/views/${result.primaryViewId}`
          : `/list/${result.typeKey}`
      );
      router.refresh();
    } catch {
      setError("creation failed (offline?)");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex max-w-xl flex-col gap-4">
      <Field
        label="Name"
        hint={
          isWorkflow
            ? "What one record is called, e.g. “Hiring Candidate” or “Content Piece”."
            : "What one entry is called, e.g. “Trip” or “Character”."
        }
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isWorkflow ? "e.g. Hiring Candidate" : "e.g. Trip"}
          className={selectClass}
        />
      </Field>

      {isWorkflow && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Stages
          </legend>
          <p className="px-1 text-xs text-neutral-600">
            The steps a record moves through. These become the board columns, in
            this order.
          </p>
          {stages.map((stage, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-right text-xs text-neutral-600">
                {i + 1}
              </span>
              <input
                value={stage}
                onChange={(e) => setStage(i, e.target.value)}
                placeholder="Stage name"
                aria-label={`Stage ${i + 1}`}
                className={`${selectClass} min-w-0 flex-1`}
              />
              <button
                onClick={() => moveStage(i, -1)}
                disabled={i === 0}
                aria-label="Move up"
                className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                onClick={() => moveStage(i, 1)}
                disabled={i === stages.length - 1}
                aria-label="Move down"
                className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                onClick={() => removeStage(i)}
                aria-label="Remove stage"
                className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={addStage}
            className="self-start rounded border border-neutral-800 px-2.5 py-1 text-sm text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800/60"
          >
            + Add stage
          </button>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-3 rounded-lg border border-neutral-800 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Fields each {isWorkflow ? "record" : "entry"} carries
        </legend>
        {rows.length === 0 && (
          <p className="px-1 text-sm text-neutral-600">
            No extra fields yet. Add the data each {isWorkflow ? "record" : "entry"}{" "}
            should hold.
          </p>
        )}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-col gap-2 rounded border border-neutral-800/70 bg-neutral-900/40 p-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={row.label}
                onChange={(e) => updateRow(row.id, { label: e.target.value })}
                placeholder="Field name"
                aria-label="Field name"
                className={`${selectClass} min-w-0 flex-1`}
              />
              <select
                value={row.kind}
                onChange={(e) =>
                  updateRow(row.id, { kind: e.target.value as PropertyKind })
                }
                aria-label="Field kind"
                className={selectClass}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeRow(row.id)}
                aria-label="Remove field"
                className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              >
                ✕
              </button>
            </div>
            {NEEDS_OPTIONS.includes(row.kind) && (
              <input
                value={row.optionsText}
                onChange={(e) =>
                  updateRow(row.id, { optionsText: e.target.value })
                }
                placeholder="Comma-separated options"
                aria-label="Options"
                className={`${selectClass} w-full`}
              />
            )}
          </div>
        ))}
        <button
          onClick={() => setRows((rs) => [...rs, makeRow()])}
          className="self-start rounded border border-neutral-800 px-2.5 py-1 text-sm text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800/60"
        >
          + Add field
        </button>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input
          type="checkbox"
          checked={addToDashboard}
          onChange={(e) => setAddToDashboard(e.target.checked)}
          className="ledgr-check"
        />
        Add {isWorkflow ? "the board" : "it"} to my Work dashboard
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy
            ? "Creating…"
            : isWorkflow
              ? "Create workflow"
              : "Create wiki"}
        </button>
      </div>
    </div>
  );
}
