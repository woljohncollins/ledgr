// One kanban column's shell: the header (color dot, label, count, collapse
// toggle), the collapsed rail, and the mobile sizing. Shared by BOTH board
// paths — the read-only server render in ViewRenderer and the draggable
// BoardDnd — so a column looks and behaves the same whether or not its cards
// can be dragged, and the two can't drift apart.
//
// Two behaviors live here:
//
//   COLLAPSE. Terminal columns (Done / archived) start as a narrow rail showing
//   just the label and count, so a board reads as live work on arrival without
//   hiding anything (board-prefs.ts). A collapsed rail KEEPS its data-col and
//   its drop handlers, so dragging a card onto collapsed Done still completes
//   it — the whole point of the column.
//
//   MOBILE WIDTH. A column is ~85% of the viewport on a phone and snaps, so you
//   swipe status to status and always see that you're mid-board; from `sm` up it
//   returns to the fixed 15rem desktop column. The snap container is the
//   caller's (it owns the scroller), which is also what lets BoardDnd disable
//   snapping mid-drag.
"use client";

import type { ReactNode } from "react";
import { setColumnCollapsed, useColumnCollapsed } from "@/lib/board-prefs";
import { badgeCount } from "@/lib/format-count";

// The expanded column's width: a phone shows one column plus a sliver of the
// next (so the board reads as scrollable), desktop keeps the original w-60.
export const BOARD_COLUMN_WIDTH = "w-[85vw] max-w-80 sm:w-60 sm:max-w-none";

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

export default function BoardColumn({
  col,
  label,
  color,
  count,
  boardKey,
  defaultCollapsed = false,
  highlighted = false,
  onDragOver,
  onDrop,
  children,
}: {
  // The group value this column holds (a status key) — also its data-col, which
  // the touch-drag hit test reads to find the column under a finger.
  col: string;
  label: string;
  color?: string;
  count: number;
  // Scopes the remembered collapse state to one board (a saved view's id, else
  // the type key).
  boardKey: string;
  defaultCollapsed?: boolean;
  // Drag is hovering this column (BoardDnd only) — accents the border.
  highlighted?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  children: ReactNode;
}) {
  const collapsed = useColumnCollapsed(boardKey, col, defaultCollapsed);
  const borderClass = highlighted ? "border-[var(--accent)]" : "border-line";
  const dot = color ? (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  ) : null;

  if (collapsed) {
    return (
      <div
        data-col={col}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`flex w-11 shrink-0 snap-start flex-col items-center gap-2 rounded-card border bg-surface-1 py-2 ${borderClass}`}
      >
        <button
          type="button"
          onClick={() => setColumnCollapsed(boardKey, col, false, defaultCollapsed)}
          title={`Expand ${label}`}
          aria-label={`Expand ${label} (${count})`}
          aria-expanded={false}
          className="flex flex-1 flex-col items-center gap-2 text-ink-subtle hover:text-ink"
        >
          <Chevron collapsed />
          {dot}
          {/* Vertical label so a rail stays readable without a tooltip. */}
          <span
            className="ui-section-label flex-1 whitespace-nowrap"
            style={{ writingMode: "vertical-rl" }}
          >
            {label}
          </span>
          <span className="ui-meta text-ink-faint">{badgeCount(count)}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-col={col}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex shrink-0 snap-start flex-col rounded-card border bg-surface-1 ${BOARD_COLUMN_WIDTH} ${borderClass}`}
    >
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => setColumnCollapsed(boardKey, col, true, defaultCollapsed)}
          title={`Collapse ${label}`}
          aria-label={`Collapse ${label}`}
          aria-expanded
          className="shrink-0 text-ink-faint hover:text-ink"
        >
          <Chevron collapsed={false} />
        </button>
        <span className="ui-section-label flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {dot}
          {label}
        </span>
        <span className="ui-meta shrink-0 text-ink-faint">{badgeCount(count)}</span>
      </div>
      {children}
    </div>
  );
}
