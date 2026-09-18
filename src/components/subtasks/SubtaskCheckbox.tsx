// Done-toggle for a subtask row. Optimistic (rule 8): the box flips
// immediately, the PATCH lands behind it, and a failure flips it back; a
// coalesced refresh re-renders strike-through and rollups from the server. The
// refresh is debounced (list-refresh) so triaging many tasks in a burst queues
// one refetch on idle, not one per click.
"use client";

import { useRef, useState } from "react";
import { useListRefresh } from "@/lib/list-refresh";
import { showToast } from "@/components/ui/ActionToast";

export default function SubtaskCheckbox({
  id,
  done,
  vanishRow = false,
  openSubtasks = 0,
  onToggled,
}: {
  id: string;
  done: boolean;
  // Optimistically fade + hide the row's <li> when this completes (Tyler,
  // 2026-08-18: the row lingered until the coalesced refresh returned from the
  // server). Only for list surfaces whose done rows LEAVE the list (the Tasks
  // tabs, a record's task list) — a subtask expansion keeps its done rows, so
  // it stays default-off. Deliberate direct-DOM: the <li> is server-rendered
  // (SwipeRow / the expandable row own it), so no React state can reach it; the
  // styles ride on the li that this task's key owns, and the refresh unmounts
  // it, so nothing leaks onto other rows. A failed PATCH restores it.
  vanishRow?: boolean;
  // How many of this task's subtasks are still open (rollup.total - done).
  // Completing a PARENT with open children is allowed — the hierarchy informs,
  // it never gates (ADR-205: finishing the parent can genuinely moot the
  // children) — but the toast says so, so it's a choice, not an accident.
  openSubtasks?: number;
  // Fires after a successful toggle. Hosts whose rows are client state that
  // router.refresh() can't reach (the subtask tree) refetch through it.
  onToggled?: () => void;
}) {
  const refresh = useListRefresh();
  const [checked, setChecked] = useState(done);
  const boxRef = useRef<HTMLLabelElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-adopt the server value when a refresh changes it (adjust-during-
  // render pattern; an effect here would double-render).
  const [prevDone, setPrevDone] = useState(done);
  if (done !== prevDone) {
    setPrevDone(done);
    setChecked(done);
  }

  function setRowHidden(hide: boolean) {
    const li = boxRef.current?.closest("li");
    if (!li) return;
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (hide) {
      li.style.transition = "opacity 200ms ease";
      li.style.opacity = "0.35";
      hideTimer.current = setTimeout(() => {
        li.style.display = "none";
      }, 350);
    } else {
      li.style.transition = "";
      li.style.opacity = "";
      li.style.display = "";
    }
  }

  async function toggle() {
    const next = !checked;
    setChecked(next);
    if (vanishRow && next) setRowHidden(true);
    try {
      // The complete endpoint toggles to the item type's default done /
      // not-started status (S2), so the checkbox needs no status schema.
      const res = await fetch(`/api/items/${id}/complete`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      onToggled?.();
      if (next && openSubtasks > 0) {
        showToast(
          `Completed. ${openSubtasks} subtask${openSubtasks === 1 ? "" : "s"} still open`
        );
      }
      refresh();
    } catch {
      setChecked(!next);
      if (vanishRow && next) setRowHidden(false);
    }
  }

  // A padded label wraps the 16px control so touch gets a ~40px tap target
  // (clearing the ~44px minimum with the row's own padding) without abutting the
  // tap-to-open title; the enlargement is scoped to coarse pointers, so desktop
  // density is unchanged (globals.css `.ledgr-check-hit`). Swipe-right stays the
  // primary mobile complete gesture (SwipeRow).
  return (
    <label ref={boxRef} className="ledgr-check-hit">
      <input
        type="checkbox"
        checked={checked}
        onChange={toggle}
        className="ledgr-check"
        aria-label={checked ? "Mark not done" : "Mark done"}
      />
    </label>
  );
}
