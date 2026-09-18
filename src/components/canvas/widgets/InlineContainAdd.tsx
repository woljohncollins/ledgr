// A small "+ {label}" add control (Tyler, 2026-07-01) for a project's dated
// collections — Milestones and Meetings (date + time). Collapsed it's a plus
// button; expanded it's a compact box: a title, an icon-only date picker (a
// calendar glyph that opens the native picker — no mm/dd/yyyy field) and, for
// meetings, an icon-only time picker (a clock glyph), then Cancel / Add on
// their own row below. Enter in the title adds. Files a contained item via
// /api/records/[id]/contain (date → due_date for milestones, date+time →
// meeting_at for meetings, handled server-side).
//
// Milestones grow two more optional fields (ADR-196, Tyler 2026-08-17 — these
// were buried on the item page): a points % chip (the milestone's share of the
// project bar) and a "Completes with task" picker that links an existing open
// task in this record or creates one on the spot. What you fill in decides the
// milestone's mode: task-linked / date-driven / manual checkbox.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TimePicker from "@/components/canvas/widgets/TimePicker";

function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const CalendarIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="5" width="16" height="15" rx="1.5" />
    <path d="M4 9h16M8 3v3M16 3v3" />
  </svg>
);

const PercentIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M19 5L5 19" />
    <circle cx="7.5" cy="7.5" r="2.5" />
    <circle cx="16.5" cy="16.5" r="2.5" />
  </svg>
);

const TaskIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </svg>
);

type TaskPick = { id: string; title: string } | { create: string } | null;
type TaskRow = { id: string; title: string; statusCategory: string };

export default function InlineContainAdd({
  recordId,
  type,
  label,
  withTime = false,
}: {
  recordId: string;
  type: string;
  label: string;
  withTime?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);

  // Milestone extras (ADR-196).
  const isMilestone = type === "milestone";
  const [points, setPoints] = useState("");
  const [task, setTask] = useState<TaskPick>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const [taskRows, setTaskRows] = useState<TaskRow[] | null>(null);

  // The record's open tasks, fetched once per expansion of the task picker.
  useEffect(() => {
    if (!isMilestone || !taskOpen || taskRows !== null) return;
    let cancelled = false;
    void fetch(`/api/items/query?type=task&relatedTo=${recordId}&limit=200`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: TaskRow[] } | null) => {
        if (!cancelled) {
          setTaskRows(
            (d?.items ?? []).filter((t) => t.statusCategory !== "done" && t.statusCategory !== "archived")
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTaskRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isMilestone, taskOpen, taskRows, recordId]);

  function reset() {
    setTitle("");
    setDate("");
    setTime("");
    setPoints("");
    setTask(null);
    setTaskOpen(false);
    setTaskQuery("");
    setOpen(false);
  }

  function openPicker(ref: React.RefObject<HTMLInputElement | null>) {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showPicker === "function") el.showPicker();
    else el.focus();
  }

  async function add() {
    const t = title.trim();
    if (!t || busy) return;
    // A meeting combines date + time into one datetime; a milestone is date-only.
    const dateValue = date ? (withTime && time ? `${date}T${time}` : date) : undefined;
    const pct = Number(points);
    setBusy(true);
    try {
      const res = await fetch(`/api/records/${recordId}/contain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          title: t,
          date: dateValue,
          ...(isMilestone && Number.isFinite(pct) && pct > 0 ? { points: pct } : {}),
          ...(isMilestone && task && "id" in task ? { taskId: task.id } : {}),
          ...(isMilestone && task && "create" in task ? { newTaskTitle: task.create } : {}),
        }),
      });
      if (res.ok) {
        reset();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded px-1 py-1 text-sm text-neutral-500 hover:text-neutral-300"
      >
        <span className="text-base leading-none text-[var(--accent)]">+</span> {label}
      </button>
    );
  }

  const chip = "inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2 py-1 text-sm hover:border-neutral-500";
  const q = taskQuery.trim().toLowerCase();
  const matches = (taskRows ?? [])
    .filter((r) => !q || r.title.toLowerCase().includes(q))
    .slice(0, 5);
  const exact = (taskRows ?? []).some((r) => r.title.trim().toLowerCase() === q);

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-2.5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape") {
            reset();
          }
        }}
        placeholder={`${label} name`}
        aria-label={`${label} name`}
        disabled={busy}
        className="w-full bg-transparent text-sm font-medium text-neutral-100 outline-none placeholder:text-neutral-500"
      />

      {/* Date (+ time) as icon-triggered native pickers — no raw mm/dd/yyyy field. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => openPicker(dateRef)} className={`${chip} ${date ? "text-[var(--accent)]" : "text-neutral-400"}`}>
          {CalendarIcon}
          {date ? fmtDate(date) : "Date"}
        </button>
        <input
          ref={dateRef}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Date"
          className="sr-only"
          tabIndex={-1}
        />
        {withTime && <TimePicker value={time} onChange={setTime} />}
        {isMilestone && (
          <>
            {/* Points: this milestone's share of the project bar, as a percent. */}
            <label className={`${chip} cursor-text ${points ? "text-[var(--accent)]" : "text-neutral-400"}`} title="Worth this % of the project's progress bar">
              {PercentIcon}
              <input
                type="number"
                min={1}
                max={100}
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                placeholder="% "
                aria-label="Points (% of project)"
                className="w-10 bg-transparent text-sm outline-none placeholder:text-neutral-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </label>
            {/* Completes with task: link an open task here, or create one. */}
            <button
              type="button"
              onClick={() => setTaskOpen((v) => !v)}
              className={`${chip} ${task ? "text-[var(--accent)]" : "text-neutral-400"}`}
              title="This milestone completes when the linked task does"
              aria-expanded={taskOpen}
            >
              {TaskIcon}
              <span className="max-w-40 truncate">
                {task ? ("id" in task ? task.title : `New: ${task.create}`) : "Completes with task"}
              </span>
            </button>
          </>
        )}
      </div>

      {isMilestone && taskOpen && (
        <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-950/60 p-2">
          <input
            autoFocus
            value={taskQuery}
            onChange={(e) => setTaskQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTaskOpen(false);
            }}
            placeholder="Find or create a task…"
            aria-label="Find or create the completing task"
            className="w-full bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
          />
          <ul className="mt-1.5 flex flex-col">
            {taskRows === null && <li className="px-1 py-0.5 text-xs text-neutral-600">Loading tasks…</li>}
            {matches.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    setTask({ id: r.id, title: r.title });
                    setTaskOpen(false);
                  }}
                  className="w-full truncate rounded px-1 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  {r.title || "Untitled"}
                </button>
              </li>
            ))}
            {q && !exact && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setTask({ create: taskQuery.trim() });
                    setTaskOpen(false);
                  }}
                  className="w-full truncate rounded px-1 py-1 text-left text-sm text-[var(--accent)] hover:bg-neutral-800"
                >
                  + Create task “{taskQuery.trim()}”
                </button>
              </li>
            )}
            {task && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setTask(null);
                    setTaskOpen(false);
                  }}
                  className="w-full rounded px-1 py-1 text-left text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                >
                  Clear linked task
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Actions below, inside the box. */}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button type="button" onClick={reset} className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700">
          Cancel
        </button>
        <button
          type="button"
          disabled={!title.trim() || busy}
          onClick={() => void add()}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}
