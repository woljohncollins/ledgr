// In-context delete confirmation (the project standard, replacing window.confirm
// — Tyler's call, 2026-06-15). A trigger button that, on click, opens a small
// popover anchored to itself asking the user to confirm. The popover can carry
// extra UI (e.g. a "also delete its items" checkbox) via `children`. Closes on
// outside click or Esc.
//
// onConfirm runs when the user confirms: await it, show a busy state, and close
// on success. If it throws, the thrown message stays visible in the popover and
// the popover stays open (so the caller surfaces API errors by throwing).
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export default function ConfirmButton({
  onConfirm,
  title,
  description,
  confirmLabel = "Delete",
  trigger,
  triggerClassName,
  triggerLabel,
  children,
  align = "left",
  disabled = false,
  panelClassName = "w-64",
  onOpen,
  tone = "danger",
}: {
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: string;
  confirmLabel?: string;
  // The trigger's visible content and styling.
  trigger: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string; // aria-label when the trigger is icon-only
  // Extra content rendered inside the confirmation popover (above the buttons).
  children?: ReactNode;
  align?: "left" | "right";
  disabled?: boolean;
  // Panel width utility. Defaults to w-64; widen it when the description
  // carries more than a one-line consequence.
  panelClassName?: string;
  // Fired when the popover OPENS. For a confirm whose consequence isn't known
  // until it's looked up ("complete this project and its N open items?"), so the
  // count can be fetched lazily on open instead of on every page render.
  onOpen?: () => void;
  // The confirm button's tone. This component started as the delete
  // confirmation, so "danger" (red) stays the default and every existing call
  // site is unchanged; "primary" is for a confirm that is consequential and
  // worth pausing on but not destructive — completing a project, not deleting
  // one. Red on a non-destructive action teaches the owner to ignore red.
  tone?: "danger" | "primary";
}) {
  const [open, setOpen] = useState(false);
  // Which way the popover opens. Measured from the trigger when it opens so a
  // trigger near the bottom of the viewport (the bottom-fixed BulkActionBar)
  // flips upward instead of rendering off-screen.
  const [side, setSide] = useState<"bottom" | "top">("bottom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Claim the Esc so the parent modal doesn't also close. The item Modal
        // skips closing when defaultPrevented is already set, but its listener
        // sits earlier on `document`, so a bubble-phase preventDefault here runs
        // too late. Listening in the CAPTURE phase runs us first — we mark the
        // Esc handled, then the modal's bubble handler sees it and stands down
        // (mirrors Popover.tsx, ADR-108).
        e.preventDefault();
        close();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => {
          if (!open) {
            const r = wrapRef.current?.getBoundingClientRect();
            // ponytail: fixed 220px estimate of the panel's height rather than
            // measuring it post-render; good enough for a w-64 confirm box.
            setSide(r && window.innerHeight - r.bottom < 220 ? "top" : "bottom");
            onOpen?.();
          }
          setOpen((o) => !o);
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={title}
          className={`absolute z-50 ${panelClassName} rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-xl shadow-black/50 ${
            align === "right" ? "right-0" : "left-0"
          } ${side === "top" ? "bottom-full mb-2" : "top-full mt-2"}`}
        >
          <p className="text-sm font-medium text-neutral-100">{title}</p>
          {description && (
            <p className="mt-1 text-xs text-neutral-400">{description}</p>
          )}
          {children && <div className="mt-2">{children}</div>}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="rounded px-2.5 py-1 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className={`rounded px-2.5 py-1 text-sm font-medium text-white disabled:opacity-50 ${
                tone === "danger"
                  ? "bg-red-600 hover:bg-red-500"
                  : "bg-[var(--accent)] hover:opacity-90"
              }`}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
