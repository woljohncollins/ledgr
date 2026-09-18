// A list row that owns a subtask "n/m" pill and, when the pill is toggled, an
// inline nested checklist below it — the list-surface counterpart to the
// canvas Subtasks section. Used by any flat list of tasks (the Tasks tabs, the
// generic type list, the view-renderer list/agenda layouts). The row's normal
// content is passed as `children` so each surface keeps its own columns; this
// only appends the pill and renders the expansion.
//
// The expansion lazy-loads the same body-free tree the canvas uses
// (GET /api/items/[id]/subtree) the first time it opens, so an idle list pays
// nothing. The row and its expansion are two sibling <li> elements returned
// together so one client component can own the shared open state.
"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import SubtaskCheckbox from "./SubtaskCheckbox";
import TaskDateEdit from "@/components/tasks/TaskDateEdit";
import { useRowMenu, type RowMenuOptions } from "@/components/lists/RowMenu";
import { deadlineDisplay } from "@/lib/format-date";

// App-timezone today comes from the host when it has one (the task tabs and
// Today home already carry it); this local fallback covers hosts that don't
// (generic lists, views) so the picker's quick rows still anchor sensibly.
function localTodayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// How a host places the pill INSIDE its own row markup instead of at the
// trailing edge (the redesigned task row puts it on the meta line, ADR-202).
// A function child can't cross the server→client boundary, so the pill travels
// by context: pass pillPlacement="slot" and render <SubtaskPillSlot /> where
// the pill should appear. Outside a slot-mode expandable row the slot renders
// nothing, so hosts can include it unconditionally.
const PillContext = createContext<ReactNode | null>(null);

export function SubtaskPillSlot() {
  return <>{useContext(PillContext)}</>;
}

// The subtree endpoint serializes dates to strings, so this mirrors SubtaskNode
// with string dates rather than reusing it (which types them as Date).
type TreeNode = {
  id: string;
  type: string;
  title: string;
  statusCategory: string;
  dueDate: string | null;
  scheduledDate: string | null;
  progress: { done: number; total: number } | null;
  children: TreeNode[];
};

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const fmt = (d: string | null) => (d ? dateFmt.format(new Date(d)) : "");

// Hide-completed helpers: prune done task nodes (their subtrees go with them —
// a finished parent's checklist is finished business), and count nodes so the
// "Show N completed" line can say how many rows are tucked away (pruned nodes
// plus everything that rode out with them).
const countAll = (ns: TreeNode[]): number =>
  ns.reduce((sum, n) => sum + 1 + countAll(n.children), 0);
const pruneDone = (ns: TreeNode[]): TreeNode[] =>
  ns
    .filter((n) => !(n.type === "task" && n.statusCategory === "done"))
    .map((n) => ({ ...n, children: pruneDone(n.children) }));

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A tree row's date, click-to-edit with the standard picker (Tyler,
// 2026-08-19: "the same date picker there as well"). Minimal mode — the
// subtree payload carries no recurrence/time, so the popover is date-only.
// `show: "always"` renders the ghost "＋ date" trigger even without a value
// (an undated subtask needs something to click); onCommitted refetches the
// tree, whose nodes are client state router.refresh() can't reach.
function MiniDate({
  node,
  field,
  today,
  done,
  show = "when-set",
  onCommitted,
}: {
  node: TreeNode;
  field: "scheduledDate" | "dueDate";
  today: string;
  done: boolean;
  show?: "when-set" | "always";
  onCommitted: () => void;
}) {
  const iso = field === "scheduledDate" ? node.scheduledDate : node.dueDate;
  if (!iso && show === "when-set") return null;
  const ymd = iso ? iso.slice(0, 10) : null;
  // A deadline is "off" not only when it has passed but when it sits BEFORE the
  // day the work is planned for (ADR-253) — the state that rendered deadpan while
  // stale due dates piled up. The row stays editable either way: clicking a date
  // anywhere in the app still changes it.
  const schedYmd = node.scheduledDate?.slice(0, 10) ?? null;
  const beforePlan =
    field === "dueDate" && ymd != null && schedYmd != null && ymd < schedYmd;
  return (
    <TaskDateEdit
      id={node.id}
      ymd={ymd}
      label={iso ? `${field === "scheduledDate" ? "scheduled" : "due"} ${fmt(iso)}` : null}
      field={field}
      overdue={(!done && ymd != null && ymd < today) || beforePlan}
      today={today}
      scheduledIso={node.scheduledDate}
      dueIso={node.dueDate}
      recurrence={null}
      scheduledTime={null}
      minimal
      onCommitted={onCommitted}
    />
  );
}

function MiniRow({
  node,
  today,
  onCommitted,
}: {
  node: TreeNode;
  today: string;
  onCommitted: () => void;
}) {
  const done = node.type === "task" && node.statusCategory === "done";
  return (
    <li>
      <div className="group/row group flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800/60">
        {node.type === "task" ? (
          // onToggled refetches the tree, so a just-checked subtask tucks
          // under the "Show N completed" line instead of lingering struck-out.
          <SubtaskCheckbox id={node.id} done={done} onToggled={onCommitted} />
        ) : (
          <span className="w-4 shrink-0 text-center text-neutral-600">•</span>
        )}
        <Link
          href={`/items/${node.id}`}
          className={`min-w-0 flex-1 truncate text-sm ${
            node.title ? "text-neutral-300" : "text-neutral-500"
          } ${done ? "text-neutral-500 line-through" : ""}`}
        >
          {node.title || "Untitled"}
        </Link>
        {node.type !== "task" && (
          <span className="shrink-0 rounded bg-neutral-800 px-1.5 text-xs text-neutral-400">
            {node.type}
          </span>
        )}
        {node.progress && (
          <span className="shrink-0 text-xs text-neutral-500">
            {node.progress.done}/{node.progress.total} done
          </span>
        )}
        {node.type === "task" ? (
          <>
            <MiniDate
              node={node}
              field="scheduledDate"
              today={today}
              done={done}
              // An undated subtask still gets a clickable "＋ date" (scheduled,
              // the planning field); dated ones just show their dates.
              show={node.scheduledDate || node.dueDate ? "when-set" : "always"}
              onCommitted={onCommitted}
            />
            <MiniDate node={node} field="dueDate" today={today} done={done} onCommitted={onCommitted} />
          </>
        ) : (
          <>
            {node.scheduledDate && (
              <span className="shrink-0 text-xs text-neutral-500">scheduled {fmt(node.scheduledDate)}</span>
            )}
            {/* Non-task children aren't editable here, so the shared display rule
                applies in full: a deadline on the plan day is redundant and hides
                (ADR-253). */}
            {(() => {
              const dl = deadlineDisplay(node.dueDate, node.scheduledDate, today);
              if (!dl) return null;
              return (
                <span
                  className={`shrink-0 text-xs ${dl.alert ? "text-red-400" : "text-neutral-500"}`}
                >
                  due {dl.label}
                </span>
              );
            })()}
          </>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-4 border-l border-neutral-800 pl-3">
          {node.children.map((child) => (
            <MiniRow key={child.id} node={child} today={today} onCommitted={onCommitted} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function SubtaskExpandableRow({
  id,
  done,
  total,
  liClassName,
  children,
  menuOptions,
  pillPlacement = "trailing",
  defaultOpen = false,
  today,
}: {
  id: string;
  done: number;
  total: number;
  // The <li> classes the host surface uses for a normal row, so the expandable
  // row is visually identical to its neighbors.
  liClassName: string;
  children: ReactNode;
  // Wires the shared row context menu (S4) onto this row too, so a task with
  // subtasks gets the same long-press/right-click actions as a plain row.
  menuOptions?: RowMenuOptions;
  // "trailing" (default) appends the "n/m" pill after the children — the
  // original shape, still what the generic list / views / widgets use. "slot"
  // hands the pill to <SubtaskPillSlot /> inside the children instead.
  pillPlacement?: "trailing" | "slot";
  // Start expanded, fetching the tree on mount (the Today fold, ADR-205: a
  // subtask that folded under this row must be visible without a click). The
  // pill still collapses it; every other surface keeps the lazy default.
  defaultOpen?: boolean;
  // App-timezone YYYY-MM-DD for the tree rows' date pickers; hosts that carry
  // it pass it, others fall back to the browser's local day.
  today?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  // Completed subtasks hide by default (Tyler, 2026-08-20 — a long checklist
  // read as mostly strikethrough); "Show N completed" reveals them.
  const [showDone, setShowDone] = useState(false);
  // In-flight guard as a ref, not state: the mount-effect fetch below must not
  // set state synchronously (react-hooks/set-state-in-effect), and the render
  // treats `nodes === null` as loading anyway.
  const inFlight = useRef(false);
  // Always call the hook (rules-of-hooks); only wire it when the host asked for
  // a menu. The fallback id keeps the hook valid when menuOptions is absent.
  const rowMenu = useRowMenu(menuOptions ?? { id });
  const menu = menuOptions ? rowMenu : null;

  // force=true refetches even when nodes are already loaded — the tree's dates
  // are client state, so an edit made from inside it (MiniDate) re-reads here.
  async function load(force = false) {
    if ((nodes !== null && !force) || inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/items/${id}/subtree`);
      if (res.ok) {
        const data = (await res.json()) as { children?: TreeNode[] };
        setNodes(data.children ?? []);
      }
    } catch {
      // offline/transient; a second click retries
    } finally {
      inFlight.current = false;
    }
  }

  // Mount-only: a pre-expanded row (defaultOpen) needs its tree immediately —
  // the whole point is showing the folded subtask without a click. The
  // set-state-in-effect disable is a false positive: load() only sets state
  // after the fetch resolves (a real side effect), never synchronously.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    if (defaultOpen) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  const shown = nodes === null ? null : showDone ? nodes : pruneDone(nodes);
  const hiddenCount = nodes === null || shown === null ? 0 : countAll(nodes) - countAll(shown);

  const pill = (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-expanded={open}
      title={open ? "Hide subtasks" : "Show subtasks"}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
    >
      <Chevron open={open} />
      {done}/{total}
    </button>
  );

  return (
    <>
      <li className={liClassName} {...(menu ? menu.handlers : {})}>
        {pillPlacement === "slot" ? (
          <PillContext.Provider value={pill}>{children}</PillContext.Provider>
        ) : (
          <>
            {children}
            {pill}
          </>
        )}
        {menu?.menu}
      </li>
      {open && (
        <li>
          <ul className="ml-7 border-l border-neutral-800 pl-3">
            {nodes === null || shown === null ? (
              <li className="px-2 py-1 text-xs text-neutral-600">Loading…</li>
            ) : nodes.length === 0 ? (
              <li className="px-2 py-1 text-xs text-neutral-600">No subtasks.</li>
            ) : (
              <>
                {shown.map((node) => (
                  <MiniRow
                    key={node.id}
                    node={node}
                    today={today ?? localTodayYmd()}
                    onCommitted={() => void load(true)}
                  />
                ))}
                {(hiddenCount > 0 || showDone) && (
                  <li>
                    <button
                      type="button"
                      onClick={() => setShowDone((v) => !v)}
                      className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-800 hover:text-neutral-400"
                    >
                      {showDone
                        ? "Hide completed"
                        : `Show ${hiddenCount} completed`}
                    </button>
                  </li>
                )}
              </>
            )}
          </ul>
        </li>
      )}
    </>
  );
}
