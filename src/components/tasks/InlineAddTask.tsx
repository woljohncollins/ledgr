// "+ Add task" → expands the shared AddTaskCard in place (Tyler: the same card
// everywhere a task is added). Used per-day in Upcoming, under Today/Inbox, and
// in each project card. Prefills the day's due date / the project.
//
// Optimistic add (perceived speed): when the card commits, it hands back a
// provisional task that we paint immediately as a muted row while the POST runs
// behind it. A coalesced refresh brings the real row from the server, and the
// shared flush signal clears the provisional one (a beat late, so there is a
// brief muted overlap rather than a gap). Mirrors how completing a task feels.
//
// The row SETTLES when the POST lands (Tyler's "slight pause", 2026-08-12). The
// pause was never the add itself — the row painted instantly — it was that the
// row went on ANNOUNCING itself as unfinished ("Adding…", opacity-70) for the
// whole ~900ms until the coalesced refresh flushed, when the task had actually
// existed since ~150ms. Now the POST's resolution drops the muted look and swaps
// in a real check circle bound to the real id, so the row is complete and usable
// immediately and the later refresh is an invisible reconciliation rather than
// the end of a wait. The debounce is deliberately NOT shortened: it exists to
// coalesce a triage burst into one refetch, and that is still worth having.
"use client";

import { useEffect, useState } from "react";
import AddTaskCard, { type OptimisticTask } from "./AddTaskCard";
import TaskCheckCircle from "./TaskCheckCircle";
import { onListRefreshFlush } from "@/lib/list-refresh";

export default function InlineAddTask({
  dueYmd,
  host,
  parentId,
  label = "Add task",
  lockDestination = false,
  buttonClassName,
}: {
  dueYmd?: string;
  host?: { id: string; label: string; role?: string };
  // Subtask mode (Tyler, 2026-08-19): the card creates the task nested under
  // this parent — the same full card (chips, "/", "@", kebab), not a bare box.
  parentId?: string;
  label?: string;
  // When the destination is already known (e.g. a project's Tasks card), hide the
  // destination picker so the task always lands on the host.
  lockDestination?: boolean;
  // Host override for the "+ label" button's classes (the Subtasks section keeps
  // its deliberately bright button, Tyler 2026-08-14).
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<OptimisticTask[]>([]);
  // tmpId → real id, for the rows whose POST has landed. Presence here is what
  // "settled" means: the row stops looking pending and gets a working circle.
  const [settled, setSettled] = useState<Record<string, string>>({});

  // Drop provisional rows once a coalesced refresh has flushed — the real rows
  // are in the server tree by then. Clear the settled map with them so it can't
  // grow across a long session of adds.
  useEffect(
    () =>
      onListRefreshFlush(() => {
        setOptimistic([]);
        setSettled({});
      }),
    []
  );

  return (
    <>
      {optimistic.map((t) => {
        const realId = settled[t.id];
        return (
          <div
            key={t.id}
            // w-full: inside a flex-wrap host (the Subtasks add row) the
            // provisional row and the card each take their own full line;
            // in block hosts it's a no-op.
            className={`my-1 flex w-full items-center gap-2 rounded-card px-2 py-1.5 text-sm ${
              realId ? "text-ink" : "text-ink-muted opacity-70"
            }`}
          >
            {realId ? (
              // Real id in hand, so this is a working control, not a placeholder:
              // the row can be completed before the server row ever arrives.
              <TaskCheckCircle itemId={realId} done={false} />
            ) : (
              <span
                aria-hidden
                className="h-[18px] w-[18px] shrink-0 rounded-full border-2 border-line-strong"
              />
            )}
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {t.scheduleLabel && (
              <span className="shrink-0 text-xs text-ink-subtle">{t.scheduleLabel}</span>
            )}
            {/* "Adding…" only while it genuinely is. Once settled the row says
                nothing, because there is nothing left to report. */}
            {!realId && <span className="shrink-0 text-xs text-ink-faint">Adding…</span>}
          </div>
        );
      })}

      {open ? (
        <div className="my-1.5 w-full">
          <AddTaskCard
            defaultDueYmd={dueYmd}
            host={host}
            parentId={parentId}
            lockDestination={lockDestination}
            onOptimisticAdd={(t) => setOptimistic((cur) => [...cur, t])}
            onOptimisticSettle={(tmpId, realId) =>
              setSettled((cur) => ({ ...cur, [tmpId]: realId }))
            }
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={
            buttonClassName ??
            "flex items-center gap-1.5 rounded px-2 py-1 text-sm text-neutral-500 hover:text-neutral-300"
          }
        >
          <span className="text-base leading-none text-[var(--accent)]">+</span> {label}
        </button>
      )}
    </>
  );
}
