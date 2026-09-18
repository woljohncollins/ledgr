// The template's "dates on apply" rules (ADR-093, TPL3b), authored from the
// Template banner. Each dated field (Scheduled, Due) gets a rule: no date, N days
// after the apply date (0 = the apply day), or a fixed calendar date. Applied
// items take these — the prototype's own dates don't carry (the clone clears
// them). PATCHes apply_config on every change.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApplyConfig, DateRule } from "@/lib/template-vars";

type Mode = "none" | "offset" | "fixed";

function modeOf(rule?: DateRule): Mode {
  return rule?.mode === "offset" ? "offset" : rule?.mode === "fixed" ? "fixed" : "none";
}

const selectClass =
  "rounded border border-neutral-800 bg-neutral-950 px-1.5 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600";

function FieldRow({
  label,
  rule,
  onChange,
}: {
  label: string;
  rule?: DateRule;
  onChange: (rule: DateRule | undefined) => void;
}) {
  const mode = modeOf(rule);
  const days = rule?.mode === "offset" ? rule.days : 0;
  const date = rule?.mode === "fixed" ? rule.date : "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-neutral-400">{label}</span>
      <select
        value={mode}
        onChange={(e) => {
          const m = e.target.value as Mode;
          if (m === "none") onChange(undefined);
          else if (m === "offset") onChange({ mode: "offset", days });
          else onChange(date ? { mode: "fixed", date } : undefined);
        }}
        className={selectClass}
      >
        <option value="none">No date</option>
        <option value="offset">Days after apply</option>
        <option value="fixed">Fixed date</option>
      </select>
      {mode === "offset" && (
        <span className="flex items-center gap-1">
          <input
            type="number"
            value={days}
            onChange={(e) =>
              onChange({ mode: "offset", days: Math.trunc(Number(e.target.value) || 0) })
            }
            className={`${selectClass} w-16`}
          />
          <span className="text-xs text-neutral-500">
            days {days === 0 ? "(apply day)" : days > 0 ? "after" : "before"}
          </span>
        </span>
      )}
      {mode === "fixed" && (
        <input
          type="date"
          value={date}
          onChange={(e) =>
            onChange(e.target.value ? { mode: "fixed", date: e.target.value } : undefined)
          }
          className={selectClass}
        />
      )}
    </div>
  );
}

export default function TemplateDatesControl({
  templateId,
  applyConfig,
}: {
  templateId: string;
  applyConfig: ApplyConfig;
}) {
  const router = useRouter();
  const [cfg, setCfg] = useState<ApplyConfig>(applyConfig);
  const [error, setError] = useState<string | null>(null);

  async function save(next: ApplyConfig) {
    setCfg(next);
    setError(null);
    const res = await fetch(`/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applyConfig: next }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `failed (${res.status})`);
    } else {
      router.refresh();
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-amber-800/40 bg-amber-950/20 p-2.5">
      <p className="text-xs text-amber-200/70">
        Dates new items get on apply — the prototype&apos;s own dates don&apos;t carry.
      </p>
      <FieldRow
        label="Scheduled"
        rule={cfg.scheduledDate}
        onChange={(r) => void save({ ...cfg, scheduledDate: r })}
      />
      <FieldRow
        label="Due"
        rule={cfg.dueDate}
        onChange={(r) => void save({ ...cfg, dueDate: r })}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
