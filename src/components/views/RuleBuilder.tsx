// The AND/OR "rules" builder (ADR-164): a single-combinator group of conditions
// over any property, relation field, or the priority/status built-ins. Lives
// inside the ViewBuilder as the advanced-filter layer beneath the plain scalar
// filters. Controlled: owns no persistence, just edits a WhereGroup value and
// calls onChange. The engine (views.ts buildWhereSql) and validation
// (view-where.ts parseWhere) are the source of truth; this only produces the
// same shape.
"use client";

import { useEffect, useState } from "react";
import {
  DAY_OF_MONTH_TOKEN,
  MULTI_OPS,
  NO_VALUE_OPS,
  TODAY_TOKEN,
  isRelativeToken,
  opLabel,
  opsForKind,
  relativeTokenLabel,
  type WhereCondition,
  type WhereGroup,
  type WhereOp,
} from "@/lib/view-where";

// One selectable subject: a scalar property, a relation field, or a built-in.
export type RuleSubjectOption =
  | { subject: "property"; key: string; label: string; kind: string; options?: string[]; numeric?: boolean }
  | { subject: "relation"; key: string; label: string; targetType?: string | null }
  | { subject: "priority"; label: string }
  | { subject: "status"; label: string };

// Encode/decode a subject option as the <select> value.
function encodeSubject(o: RuleSubjectOption): string {
  return o.subject === "property" || o.subject === "relation"
    ? `${o.subject}:${o.key}`
    : o.subject;
}
function subjectKind(o: RuleSubjectOption): string {
  return o.subject === "property" ? o.kind : o.subject;
}

const PRIORITY_VALUES = [1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `P${n}` }));
const STATUS_VALUES = [
  { value: "active", label: "Active" },
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

const selectClass =
  "rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";
const inputClass = selectClass;

type Candidate = { id: string; title: string };

// A compact multi-pick of related items, fetched by target type. Tags/people are
// modest in a single-user workspace, so we pull up to 200 and filter client-side.
function RelationValuePicker({
  targetType,
  selected,
  onChange,
}: {
  targetType: string | null | undefined;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ limit: "200" });
    if (targetType) params.set("type", targetType);
    void fetch(`/api/items?${params}`)
      .then((r) => r.json())
      .then((d: { items: Candidate[] }) => {
        if (alive) setCands(d.items ?? []);
      })
      .catch(() => {
        if (alive) setCands([]);
      });
    return () => {
      alive = false;
    };
  }, [targetType]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const titleOf = (id: string) => cands?.find((c) => c.id === id)?.title ?? "…";
  const filtered = (cands ?? []).filter(
    (c) => !q || (c.title ?? "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              className="flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
              title="Remove"
            >
              {titleOf(id)} <span className="text-neutral-500">×</span>
            </button>
          ))}
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={cands === null ? "Loading…" : "Filter…"}
        className={inputClass}
      />
      <div className="max-h-40 overflow-y-auto rounded border border-neutral-800">
        {filtered.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-neutral-600">
            {cands === null ? "Loading…" : "No matches"}
          </p>
        )}
        {filtered.slice(0, 50).map((c) => (
          <label
            key={c.id}
            className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm text-neutral-300 hover:bg-neutral-900"
          >
            <input
              type="checkbox"
              className="ledgr-check ledgr-check-sm"
              checked={selected.includes(c.id)}
              onChange={() => toggle(c.id)}
            />
            <span className="truncate">{c.title || "Untitled"}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// A multi-pick of fixed options (select/multi_select property, priority, status).
function OptionMultiPick({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (vals: string[]) => void;
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
      {options.length === 0 && (
        <span className="text-xs text-neutral-600">No options defined.</span>
      )}
      {options.map((o) => (
        <label
          key={o.value}
          className="flex items-center gap-1.5 text-sm text-neutral-300"
        >
          <input
            type="checkbox"
            className="ledgr-check ledgr-check-sm"
            checked={selected.includes(o.value)}
            onChange={() => toggle(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

// The value control for one condition, chosen by its op + the subject's kind.
function ConditionValue({
  cond,
  option,
  onChange,
}: {
  cond: WhereCondition;
  option: RuleSubjectOption | undefined;
  onChange: (patch: Partial<WhereCondition>) => void;
}) {
  if (NO_VALUE_OPS.includes(cond.op)) return null;
  const kind = option ? subjectKind(option) : "text";

  if (MULTI_OPS.includes(cond.op)) {
    const values = cond.values ?? [];
    if (option?.subject === "relation") {
      return (
        <RelationValuePicker
          targetType={option.targetType}
          selected={values}
          onChange={(ids) => onChange({ values: ids })}
        />
      );
    }
    if (cond.subject === "priority") {
      return (
        <OptionMultiPick options={PRIORITY_VALUES} selected={values} onChange={(v) => onChange({ values: v })} />
      );
    }
    if (cond.subject === "status") {
      return (
        <OptionMultiPick options={STATUS_VALUES} selected={values} onChange={(v) => onChange({ values: v })} />
      );
    }
    // select / multi_select property
    const opts = (option?.subject === "property" ? option.options : undefined) ?? [];
    // A day-of-month field (every option is 1..31) also offers the relative
    // token, so "the entry for today" is pickable rather than a value the owner
    // has to retype each morning.
    // ponytail: the shape of the options is the only hint a field is calendar
    // days; give the property kind a flag if a second such field ever appears.
    const isDayField =
      opts.length > 0 && opts.every((o) => /^\d{1,2}$/.test(o) && +o >= 1 && +o <= 31);
    return (
      <OptionMultiPick
        options={[
          ...(isDayField
            ? [{ value: DAY_OF_MONTH_TOKEN, label: relativeTokenLabel(DAY_OF_MONTH_TOKEN) }]
            : []),
          ...opts.map((o) => ({ value: o, label: o })),
        ]}
        selected={values}
        onChange={(v) => onChange({ values: v })}
      />
    );
  }

  // Single-value ops (contains/eq/neq/gt/lt/gte/lte) — text/number/date input.
  // A number or date field can hold a relative token instead of a literal; the
  // token has no place in a number/date input, so it shows as a chip you clear.
  const token = kind === "number" ? DAY_OF_MONTH_TOKEN : kind === "date" ? TODAY_TOKEN : null;
  if (isRelativeToken(cond.value)) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="rounded-card border border-line bg-surface-2 px-2 py-1 text-sm text-ink">
          {relativeTokenLabel(cond.value as string)}
        </span>
        <button
          type="button"
          onClick={() => onChange({ value: "" })}
          className="text-xs text-ink-subtle underline decoration-dotted underline-offset-2"
        >
          clear
        </button>
      </span>
    );
  }
  const type = kind === "number" ? "number" : kind === "date" ? "date" : "text";
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <input
        type={type}
        value={cond.value ?? ""}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="value"
        className={`${inputClass} min-w-0 flex-1`}
      />
      {token && (
        <button
          type="button"
          onClick={() => onChange({ value: token })}
          className="whitespace-nowrap text-xs text-ink-subtle underline decoration-dotted underline-offset-2"
        >
          {relativeTokenLabel(token)}
        </button>
      )}
    </span>
  );
}

export default function RuleBuilder({
  value,
  onChange,
  subjectOptions,
}: {
  value: WhereGroup | null;
  onChange: (next: WhereGroup | null) => void;
  subjectOptions: RuleSubjectOption[];
}) {
  const combinator = value?.combinator ?? "and";
  const conditions = value?.conditions ?? [];

  const optionFor = (c: WhereCondition): RuleSubjectOption | undefined =>
    subjectOptions.find(
      (o) =>
        o.subject === c.subject &&
        (o.subject === "property" || o.subject === "relation" ? o.key === c.key : true)
    );

  function commit(nextConds: WhereCondition[], nextComb = combinator) {
    onChange(nextConds.length ? { combinator: nextComb, conditions: nextConds } : null);
  }

  function addCondition() {
    const first = subjectOptions[0];
    if (!first) return;
    const kind = subjectKind(first);
    const op = opsForKind(kind)[0] ?? "set";
    const cond: WhereCondition = {
      subject: first.subject,
      op,
      ...(first.subject === "property" || first.subject === "relation" ? { key: first.key } : {}),
      ...(first.subject === "property" && first.numeric ? { numeric: true } : {}),
    };
    commit([...conditions, cond]);
  }

  function updateCondition(i: number, patch: Partial<WhereCondition>) {
    commit(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function changeSubject(i: number, encoded: string) {
    const opt = subjectOptions.find((o) => encodeSubject(o) === encoded);
    if (!opt) return;
    const kind = subjectKind(opt);
    const op = opsForKind(kind)[0] ?? "set";
    // Reset value/values/key/numeric when the subject changes — a stale value
    // rarely makes sense against a different field.
    const next: WhereCondition = {
      subject: opt.subject,
      op,
      ...(opt.subject === "property" || opt.subject === "relation" ? { key: opt.key } : {}),
      ...(opt.subject === "property" && opt.numeric ? { numeric: true } : {}),
    };
    commit(conditions.map((c, j) => (j === i ? next : c)));
  }

  function changeOp(i: number, op: WhereOp) {
    // Drop any value not relevant to the new op.
    const patch: Partial<WhereCondition> = { op, value: undefined, values: undefined };
    commit(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function removeCondition(i: number) {
    commit(conditions.filter((_, j) => j !== i));
  }

  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Rules
      </legend>
      <p className="text-xs text-neutral-600">
        Extra conditions on any field, tag, or property. Combined with the filters
        above.
      </p>

      {conditions.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          Match
          <select
            value={combinator}
            onChange={(e) => commit(conditions, e.target.value as "and" | "or")}
            className={`${selectClass} py-1`}
            aria-label="Match all or any"
          >
            <option value="and">all (AND)</option>
            <option value="or">any (OR)</option>
          </select>
          of these:
        </div>
      )}

      <div className="flex flex-col gap-2">
        {conditions.map((c, i) => {
          const opt = optionFor(c);
          const kind = opt ? subjectKind(opt) : "text";
          const ops = opsForKind(kind);
          return (
            <div
              key={i}
              className="flex flex-wrap items-start gap-2 rounded border border-neutral-800 bg-neutral-900/40 p-2"
            >
              <select
                value={opt ? encodeSubject(opt) : ""}
                onChange={(e) => changeSubject(i, e.target.value)}
                className={selectClass}
                aria-label="Field"
              >
                {!opt && <option value="">(field removed)</option>}
                {subjectOptions.map((o) => (
                  <option key={encodeSubject(o)} value={encodeSubject(o)}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                value={c.op}
                onChange={(e) => changeOp(i, e.target.value as WhereOp)}
                className={selectClass}
                aria-label="Condition"
              >
                {ops.map((op) => (
                  <option key={op} value={op}>
                    {opLabel(op, kind)}
                  </option>
                ))}
              </select>
              <ConditionValue
                cond={c}
                option={opt}
                onChange={(patch) => updateCondition(i, patch)}
              />
              <button
                type="button"
                onClick={() => removeCondition(i)}
                aria-label="Remove condition"
                className="ml-auto shrink-0 rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {subjectOptions.length > 0 ? (
        <button
          type="button"
          onClick={addCondition}
          className="self-start rounded bg-neutral-800 px-2.5 py-1 text-sm text-neutral-200 hover:bg-neutral-700"
        >
          ＋ Add condition
        </button>
      ) : (
        <p className="text-xs text-neutral-600">
          Pick a type above to add property or tag conditions.
        </p>
      )}
    </fieldset>
  );
}
