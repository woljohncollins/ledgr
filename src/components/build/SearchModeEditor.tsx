// What the nav's Search icon opens (ADR-182) — the "Search" panel on Build →
// Navigation.
//
// Ledgr has two search surfaces and used to show both at once: the /search page
// as a seeded nav slot, plus a palette button hardcoded into all four nav layouts
// beside New/More. A default nav therefore carried two search icons, only one of
// which was configurable. Now there's ONE Search slot and this setting decides
// what it does. ⌘K opens the palette in either mode — a shortcut costs no bar
// space, so choosing "page" never strands the palette.
//
// Saving PATCHes /api/settings (the shared merge route) and refreshes, because
// the nav is rendered server-side (Nav → NavShell).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SearchMode } from "@/lib/settings";

const OPTIONS: { value: SearchMode; label: string; hint: string }[] = [
  {
    value: "palette",
    label: "Quick search popup",
    hint: "Opens the command palette over whatever you're looking at — type to jump to an item, a page, or a command. Same thing ⌘K opens.",
  },
  {
    value: "page",
    label: "Full search page",
    hint: "Goes to the search page, where you stack several clues (words, a rough date, a type, a person) and set how sure you are of each.",
  },
];

export default function SearchModeEditor({ initial }: { initial: SearchMode }) {
  const router = useRouter();
  const [mode, setMode] = useState<SearchMode>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function choose(next: SearchMode) {
    if (next === mode || busy) return;
    const before = mode;
    setMode(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchMode: next }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setMode(before);
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-card border border-line p-4">
      <legend className="px-1 ui-section-label text-ink-muted">Search</legend>
      <p className="ui-meta text-ink-subtle">
        The Search icon in your nav can open either search surface. Pick the one
        you want; the keyboard shortcut{" "}
        <kbd className="rounded border border-line bg-surface-2 px-1 text-ink-muted">
          ⌘K
        </kbd>{" "}
        always opens the popup, whichever you choose. Add or remove the icon
        itself in the slots below.
      </p>

      <div className="flex flex-col gap-2">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-start gap-2 ui-row text-ink"
          >
            <input
              type="radio"
              name="search-mode"
              className="ledgr-check ledgr-check-sm mt-0.5"
              checked={mode === opt.value}
              disabled={busy}
              onChange={() => void choose(opt.value)}
            />
            <span className="flex flex-col">
              <span>{opt.label}</span>
              <span className="ui-meta text-ink-subtle">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {(saved || error) && (
        <span className={`ui-meta ${error ? "text-red-400" : "text-green-500"}`}>
          {error ?? "Saved"}
        </span>
      )}
    </fieldset>
  );
}
