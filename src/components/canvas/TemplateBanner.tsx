// The "Template" banner on a prototype item's canvas (ADR-093, TPL2/TPL3b). Makes
// it unmistakable you're editing a template (not a real item), and carries its
// registry actions: inline rename, set-as-default, duplicate, delete, and the
// "dates on apply" rules (TPL3b). Apply itself is elsewhere ("+ New" / the
// chooser, TPL4); this is the authoring surface.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { openItem } from "@/lib/item-nav";
import ConfirmButton from "@/components/ui/ConfirmButton";
import TemplateDatesControl from "@/components/canvas/TemplateDatesControl";
import type { ApplyConfig } from "@/lib/template-vars";
import type { TemplateMatchConfig } from "@/lib/templates/match-config";

// Plain-language summary of a match rule (ADR-123) — "what events auto-apply
// this template". Mirrors the condition kinds the pin/suggester use.
function describeRule(mc: TemplateMatchConfig): string {
  const c = mc.condition;
  switch (c.kind) {
    case "attendeeEmail":
      return `events where ${c.email} is invited`;
    case "seriesId":
      return "events in this recurring calendar series";
    case "titleRegex":
      return `events whose title matches /${c.pattern}/${c.flags ?? ""}`;
    case "titleFuzzy":
      return `events titled like “${c.pattern}”`;
  }
}

export default function TemplateBanner({
  templateId,
  name,
  isDefault,
  typeLabel,
  applyConfig,
  matchConfig,
}: {
  templateId: string;
  name: string;
  isDefault: boolean;
  typeLabel: string;
  applyConfig: ApplyConfig;
  matchConfig: TemplateMatchConfig | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [showDates, setShowDates] = useState(false);
  const [busy, setBusy] = useState<null | "rename" | "default" | "duplicate" | "unpin">(null);
  const [error, setError] = useState<string | null>(null);
  const hasDateRules = !!(applyConfig.dueDate || applyConfig.scheduledDate);

  async function unpinRule() {
    if (busy) return;
    setBusy("unpin");
    // Clear the rule but KEEP the template (it becomes a plain content template).
    if (await patch({ matchConfig: null })) router.refresh();
    setBusy(null);
  }

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    const res = await fetch(`/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `failed (${res.status})`);
      return false;
    }
    return true;
  }

  async function rename() {
    if (busy) return;
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      setDraft(name);
      return;
    }
    setBusy("rename");
    if (await patch({ name: next })) {
      setEditing(false);
      router.refresh();
    }
    setBusy(null);
  }

  async function toggleDefault() {
    if (busy) return;
    setBusy("default");
    if (await patch({ isDefault: !isDefault })) router.refresh();
    setBusy(null);
  }

  async function duplicate() {
    if (busy) return;
    setBusy("duplicate");
    setError(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/duplicate`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `failed (${res.status})`);
        setBusy(null);
        return;
      }
      const { template } = (await res.json()) as { template: { prototypeItemId: string } };
      openItem(router, template.prototypeItemId);
      router.refresh();
    } catch {
      setError("failed (offline?)");
      setBusy(null);
    }
  }

  async function confirmDelete() {
    const res = await fetch(`/api/templates/${templateId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `delete failed (${res.status})`);
    }
    router.push("/build/templates");
    router.refresh();
  }

  const actionClass =
    "rounded px-2 py-0.5 text-xs text-amber-200/80 hover:bg-amber-900/40 hover:text-amber-100 disabled:opacity-50";

  return (
    <div className="mx-auto w-full max-w-3xl px-2 pt-4 sm:px-8 md:px-12">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2">
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
          Template
        </span>
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(name);
              }
            }}
            autoFocus
            className="min-w-0 flex-1 rounded border border-amber-800/60 bg-neutral-950 px-2 py-0.5 text-sm text-neutral-100 outline-none focus:border-amber-600"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            title="Rename template"
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-neutral-100 hover:text-white"
          >
            {name}
          </button>
        )}
        <span className="text-xs text-amber-200/50">{typeLabel}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void toggleDefault()}
            disabled={busy !== null}
            title={isDefault ? "This type's default for “+ New”" : "Make this the type's default for “+ New”"}
            className={actionClass}
          >
            {isDefault ? "★ Default" : "☆ Set default"}
          </button>
          <button
            type="button"
            onClick={() => void duplicate()}
            disabled={busy !== null}
            className={actionClass}
          >
            {busy === "duplicate" ? "Duplicating…" : "Duplicate"}
          </button>
          <button
            type="button"
            onClick={() => setShowDates((s) => !s)}
            aria-expanded={showDates}
            title="Set the dates new items get on apply"
            className={`${actionClass} ${hasDateRules ? "text-amber-300 hover:text-amber-200" : ""}`}
          >
            {hasDateRules ? "★ Dates" : "Dates"}
          </button>
          <ConfirmButton
            onConfirm={confirmDelete}
            title={`Delete the “${name}” template?`}
            description="The prototype moves to Trash. Items already created from it aren't affected."
            align="right"
            trigger="Delete"
            triggerClassName={actionClass}
          />
          <Link
            href="/build/templates"
            className="rounded px-2 py-0.5 text-xs text-amber-200/60 hover:bg-amber-900/40 hover:text-amber-100"
          >
            All templates
          </Link>
        </div>
        {matchConfig && (
          <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-t border-amber-800/30 pt-1.5 text-xs text-amber-200/80">
            <span aria-hidden>⚡</span>
            <span className="min-w-0 flex-1">
              Auto-applies to {describeRule(matchConfig)}
              {matchConfig.autoApply ? "" : " (paused)"}.
            </span>
            <button
              type="button"
              onClick={() => void unpinRule()}
              disabled={busy !== null}
              title="Remove the auto-apply rule (keeps the template)"
              className={actionClass}
            >
              {busy === "unpin" ? "Removing…" : "Unpin rule"}
            </button>
          </div>
        )}
        {error && <span className="w-full text-xs text-red-400">{error}</span>}
      </div>
      {showDates && (
        <TemplateDatesControl templateId={templateId} applyConfig={applyConfig} />
      )}
    </div>
  );
}
