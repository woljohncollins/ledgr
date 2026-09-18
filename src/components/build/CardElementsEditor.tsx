// Build → Types → Project: the "Card elements" panel (2026-08-17). Picks which
// tools a project card shows everywhere cards render — the Recent-style grid on
// /list/project and any saved list/board view scoped to projects. Saves to
// users.settings.cardsByType via PATCH /api/types/[key]/cards — no schema
// change, the same posture/optimistic-save pattern as TocSettingsEditor. A
// saved view can override this per view (the view builder's card panel).
// "Reset to default" drops the override (back to the classic card).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_PROJECT_CARD,
  PROJECT_CARD_ELEMENTS,
  type ProjectCardConfig,
  type ProjectCardElement,
} from "@/lib/project-card-config";

function snap(show: ProjectCardElement[]): string {
  return JSON.stringify([...show].sort());
}

export default function CardElementsEditor({
  typeKey,
  initial,
  customized,
}: {
  typeKey: string;
  initial: ProjectCardConfig;
  customized: boolean;
}) {
  const router = useRouter();
  const [show, setShow] = useState<ProjectCardElement[]>(initial.show);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(() => snap(initial.show));
  const dirty = snap(show) !== baseline;

  function toggle(key: ProjectCardElement) {
    setShow((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));
    setSaved(false);
  }

  async function persist(body: { config: ProjectCardConfig | null }, after: () => void) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/types/${typeKey}/cards`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Save failed (${res.status})`);
        return;
      }
      after();
      setSaved(true);
      router.refresh();
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  function save() {
    const cfg: ProjectCardConfig = { show };
    void persist({ config: cfg }, () => setBaseline(snap(cfg.show)));
  }

  function reset() {
    void persist({ config: null }, () => {
      setShow([...DEFAULT_PROJECT_CARD.show]);
      setBaseline(snap(DEFAULT_PROJECT_CARD.show));
      setSaved(false);
    });
  }

  return (
    <section className="mt-8 rounded-xl border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-300">
          Card elements
        </h2>
        <span className="text-xs text-neutral-600">
          {customized ? "Customized" : "Default"}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        What each project card shows, wherever cards render: the grid on the
        Projects list and any saved list or board view of projects. Counts, key
        links, and the Timeline button are clickable and deep-link into their
        tools. A saved view can override this set in its own editor.
      </p>

      <div className="mt-3 divide-y divide-neutral-800/70 rounded-lg border border-neutral-800">
        {PROJECT_CARD_ELEMENTS.map((el) => (
          <label
            key={el.key}
            className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5"
          >
            <span className="text-sm text-neutral-200">{el.label}</span>
            <input
              type="checkbox"
              checked={show.includes(el.key)}
              onChange={() => toggle(el.key)}
              className="ledgr-check"
            />
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={saving || (!customized && !dirty)}
          className="text-sm text-neutral-500 hover:text-neutral-300 disabled:opacity-40"
        >
          Reset to default
        </button>
        {saved && !dirty && <span className="text-xs text-emerald-500">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
