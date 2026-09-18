// The per-card options gear (Tyler, 2026-07-01): a small gear that appears on
// card hover, beside the remove ×. It opens a tiny popover of per-card choices,
// each persisting to the widget instance's options in the record's composition
// (PATCH), same mechanism as RemoveSection: how many rows a collection card
// previews before the "Showing N of M →" link takes over (options.limit,
// default 5 — see widgetLimit; PREVIEW size only, the backing items are
// untouched), the Tasks card's "Group by", and Rename (options.title, 2026-08-19
// — a per-record display title, so "Docs" can read "Sermon research" on one
// project; empty restores the default). Every card gets the gear; the count
// presets render only where a preview cap applies (`current` set).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WIDGET_LIMIT_ALL, WIDGET_LIMIT_MAX, WIDGET_TITLE_MAX, type Composition } from "@/lib/composition";

// "All" persists as the literal "all" and reads back as Infinity (widgetLimit).
const PRESETS: (number | "all")[] = [3, 5, 10, 20, 50, "all"];

function presetLabel(v: number | "all"): string {
  return v === "all" ? "All" : String(v);
}

export default function SectionCountGear({
  itemId,
  composition,
  instanceId,
  current,
  label,
  defaultTitle,
  customTitle,
  groupChoices,
  groupCurrent,
}: {
  itemId: string;
  composition: Composition;
  instanceId: string;
  // The preview cap, when this card has one (collection/timeline cards).
  // Undefined → no "Show on card" section; the gear still offers Rename.
  current?: number;
  label: string;
  // Rename (2026-08-19): the card's catalog default title (the input's
  // placeholder + what an empty save restores) and the stored per-record
  // override, null when none.
  defaultTitle: string;
  customTitle: string | null;
  // Optional second control (the Tasks card, 2026-08-17): a "Group by" radio
  // block writing options.groupBy through the same composition PATCH.
  groupChoices?: string[];
  groupCurrent?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(customTitle ?? "");

  async function setLimit(value: number | "all") {
    const stored =
      value === "all" ? WIDGET_LIMIT_ALL : Math.min(Math.max(Math.round(value), 1), WIDGET_LIMIT_MAX);
    const asNumber = value === "all" ? Number.POSITIVE_INFINITY : stored;
    if (busy || asNumber === current) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const next: Composition = {
      ...composition,
      widgets: composition.widgets.map((w) =>
        w.instanceId === instanceId ? { ...w, options: { ...w.options, limit: stored } } : w
      ),
    };
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition: next }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  // Rename commits on Enter (the form submit) — draft-commit, like DateInput.
  // An empty (or all-space) save REMOVES options.title, restoring the default,
  // rather than storing "".
  async function commitTitle() {
    const trimmed = title.trim().slice(0, WIDGET_TITLE_MAX);
    if (busy || trimmed === (customTitle ?? "")) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const next: Composition = {
      ...composition,
      widgets: composition.widgets.map((w) => {
        if (w.instanceId !== instanceId) return w;
        const { title: _prev, ...rest } = w.options ?? {};
        return { ...w, options: trimmed ? { ...rest, title: trimmed } : rest };
      }),
    };
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition: next }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  async function setOption(key: string, value: string) {
    if (busy) return;
    setBusy(true);
    const next: Composition = {
      ...composition,
      widgets: composition.widgets.map((w) =>
        w.instanceId === instanceId ? { ...w, options: { ...w.options, [key]: value } } : w
      ),
    };
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition: next }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-label={`Options for ${label}`}
        title="Card options"
        className="rounded p-0.5 text-neutral-600 opacity-0 transition-opacity hover:text-neutral-300 group-hover/card:opacity-100 disabled:opacity-40 aria-expanded:opacity-100"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <>
          {/* click-away backdrop */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-lg"
          >
            {current !== undefined && (
              <>
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500">Show on card</p>
                {PRESETS.map((n) => {
                  const active = n === "all" ? !Number.isFinite(current) : n === current;
                  return (
                  <button
                    key={n}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => void setLimit(n)}
                    disabled={busy}
                    className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-neutral-800 ${
                      active ? "text-neutral-100" : "text-neutral-300"
                    }`}
                  >
                    <span>{presetLabel(n)}</span>
                    {active && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                  );
                })}
              </>
            )}
            {groupChoices && groupChoices.length > 0 && (
              <>
                <p className="mt-1 border-t border-neutral-800 px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide text-neutral-500">
                  Group by
                </p>
                {groupChoices.map((c) => {
                  const active = c === (groupCurrent ?? groupChoices[0]);
                  return (
                    <button
                      key={c}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => void setOption("groupBy", c)}
                      disabled={busy}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm capitalize hover:bg-neutral-800 ${
                        active ? "text-neutral-100" : "text-neutral-300"
                      }`}
                    >
                      <span>{c}</span>
                      {active && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </>
            )}
            <p
              className={`px-2 pb-1 text-[10px] uppercase tracking-wide text-neutral-500 ${
                current !== undefined || (groupChoices && groupChoices.length > 0)
                  ? "mt-1 border-t border-neutral-800 pt-2"
                  : "py-1"
              }`}
            >
              Rename
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void commitTitle();
              }}
              className="px-2 pb-1"
            >
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={defaultTitle}
                maxLength={WIDGET_TITLE_MAX}
                disabled={busy}
                aria-label={`Rename ${defaultTitle} card`}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-40"
              />
              <p className="mt-1 text-[10px] text-neutral-600">
                Enter saves · empty restores &ldquo;{defaultTitle}&rdquo;
              </p>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
