// One expandable row per type on Build → Types (replaces the old
// checkbox-columns layout; Brandon rejected bare unlabeled checkboxes crammed
// into narrow columns). Collapsed: label, key, badges, chips naming each
// enabled setting, a chevron. Expanded: each setting as a switch + bold label
// + one-line description. Absorbs TypeQuickCaptureToggle/TypeListenToggle's
// POST logic directly (they were 1:1 wrappers around fetch + router.refresh).
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center disabled:cursor-not-allowed">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={label}
        className="peer sr-only"
      />
      <span
        className={`h-5 w-9 rounded-full border border-line-strong bg-surface-2 transition-colors peer-checked:border-[var(--accent)] peer-checked:bg-[var(--accent)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent)] peer-disabled:opacity-40 ${
          disabled ? "opacity-40" : ""
        }`}
      >
        <span
          className={`block h-4 w-4 translate-x-0.5 translate-y-0.5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-[1.125rem]" : ""
          }`}
        />
      </span>
    </label>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-ink-subtle transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export default function TypeSettingsRow({
  typeKey,
  label,
  fieldCount,
  statusHint,
  isSystem,
  hidden,
  showInQuickCapture,
  listenEnabled,
  listenOpenInEdge,
}: {
  typeKey: string;
  label: string;
  fieldCount: number;
  statusHint: string | null;
  isSystem: boolean;
  hidden: boolean;
  showInQuickCapture: boolean;
  listenEnabled: boolean;
  listenOpenInEdge: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const post = async (path: string, body: Record<string, boolean>) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/types/${typeKey}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      // Don't fail silently (Principle 9): a failed click left the toggle
      // snapped back with no signal. Mark it so the no-op is visible.
      setError(true);
      setTimeout(() => setError(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  const chips: string[] = [];
  if (showInQuickCapture) chips.push("Quick capture");
  if (listenEnabled) chips.push("Listen");
  if (hidden) chips.push("Hidden");

  return (
    <li className={`rounded ${hidden ? "opacity-50" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
        <span className="shrink-0 font-mono text-xs text-ink-faint">{typeKey}</span>
        {fieldCount > 0 && (
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-muted">
            {fieldCount} field{fieldCount === 1 ? "" : "s"}
          </span>
        )}
        {statusHint && (
          <span className="hidden shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-muted sm:inline">
            {statusHint}
          </span>
        )}
        {isSystem && <span className="shrink-0 text-xs text-ink-faint">built-in</span>}
        {chips.map((c) => (
          <span
            key={c}
            className="hidden shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted sm:inline"
          >
            {c}
          </span>
        ))}
        <Chevron open={open} />
      </button>

      {open && (
        <div className="ml-2 flex flex-col gap-4 border-l border-line px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="ui-row font-semibold text-ink">Quick capture</div>
              <p className="text-xs text-ink-subtle">
                Offer this type in the quick-add menu.
              </p>
            </div>
            <Switch
              checked={showInQuickCapture}
              disabled={busy}
              label="Quick capture"
              onChange={() =>
                void post("quick-capture", { showInQuickCapture: !showInQuickCapture })
              }
            />
          </div>

          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="ui-row font-semibold text-ink">Listen</div>
              <p className="text-xs text-ink-subtle">
                Add a read-aloud entry to this type&rsquo;s item menu.
              </p>
            </div>
            <Switch
              checked={listenEnabled}
              disabled={busy}
              label="Listen"
              onChange={() => void post("listen", { listenEnabled: !listenEnabled })}
            />
          </div>

          {listenEnabled && (
            <div className="ml-2 flex items-start justify-between gap-3 border-l border-line pl-3">
              <div>
                <div className="ui-row font-semibold text-ink">Open in Edge</div>
                <p className="text-xs text-ink-subtle">
                  Send Listen to Microsoft Edge, which has better free voices.
                </p>
              </div>
              <Switch
                checked={listenOpenInEdge}
                disabled={busy}
                label="Open in Edge for Listen"
                onChange={() =>
                  void post("listen", { listenOpenInEdge: !listenOpenInEdge })
                }
              />
            </div>
          )}

          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="ui-row font-semibold text-ink">Visible</div>
              <p className="text-xs text-ink-subtle">
                Show in lists, menus, and tabs.
              </p>
            </div>
            <Switch
              checked={!hidden}
              disabled={busy}
              label="Visible"
              onChange={() => void post("hidden", { hidden: !hidden })}
            />
          </div>

          <Link
            href={`/build/types/${typeKey}/edit`}
            className="text-xs text-ink-subtle underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Edit fields →
          </Link>
        </div>
      )}
      {error && (
        <p className="px-2 pb-2 text-xs text-red-500">Couldn&rsquo;t save, try again.</p>
      )}
    </li>
  );
}
