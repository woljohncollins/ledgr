// "Mark this project done" — the record header's completion checkbox (Tyler,
// 2026-08-25). Sits top-right beside the Status pill and does the thing the pill
// can't say in one gesture: finish the project AND everything open inside it, so
// a completed project stops trailing open tasks through every task list and its
// progress bar actually reads 100%.
//
// Checking it is a bulk write, so it is deliberately a two-step:
//
//   1. Opening the confirm FETCHES THE PLAN (GET) and names the real counts —
//      "Completes this project and 18 tasks, 3 milestones" — plus anything
//      deliberately left alone (repeating tasks; types with no Done state). The
//      owner sees the blast radius before it happens and can cancel.
//   2. Confirming applies it and raises the standard undo toast, which holds
//      every item's previous status and puts them all back verbatim.
//
// UNCHECKING (Tyler's call): reopens the PROJECT only and leaves the tasks done.
// The undo toast is the way to take back a whole sweep; unchecking weeks later
// shouldn't resurrect twenty tasks you'd genuinely finished in the meantime. The
// label says so, so it isn't a surprise.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { beginSave, endSave } from "@/lib/save-status";
import { initialStatusKey, isDoneCategory, type StatusDef } from "@/lib/status";

type Plan = {
  count: number;
  summary: string;
  skipped: {
    noCompletion: number;
    noCompletionSummary: string;
    recurring: number;
    recurringSummary: string;
  };
};

export default function ProjectDoneCheckbox({
  itemId,
  statuses,
  status,
}: {
  itemId: string;
  statuses: StatusDef[];
  status: string;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [busy, setBusy] = useState(false);

  const cur = statuses.find((s) => s.key === status);
  const done = cur ? isDoneCategory(cur.category) : false;

  async function loadPlan() {
    setPlan(null);
    setLoadingPlan(true);
    try {
      const res = await fetch(`/api/items/${itemId}/complete-project`);
      if (!res.ok) throw new Error(String(res.status));
      setPlan((await res.json()) as Plan);
    } catch {
      // A failed preview leaves the popover showing its fallback wording rather
      // than a number we can't stand behind. Confirming still works.
      setPlan(null);
    } finally {
      setLoadingPlan(false);
    }
  }

  async function complete() {
    const res = await fetch(`/api/items/${itemId}/complete-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      // Thrown, not swallowed: ConfirmButton keeps the popover open and shows it.
      throw new Error(d.error ?? `Couldn't complete this project (${res.status})`);
    }
    const data = (await res.json()) as {
      changed: { id: string; status: string }[];
      count: number;
      summary: string;
      failed: { id: string; error: string }[];
    };
    router.refresh();

    const undo = () => {
      void (async () => {
        beginSave();
        try {
          const r = await fetch(`/api/items/${itemId}/complete-project`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ undo: data.changed }),
          });
          endSave(r.ok);
          router.refresh();
        } catch {
          endSave(false);
        }
      })();
    };

    const failedNote = data.failed.length ? ` · ${data.failed.length} couldn't be updated` : "";
    showToast(
      data.count > 0
        ? `Project done · completed ${data.summary}${failedNote}`
        : `Project marked done${failedNote}`,
      undo
    );
  }

  // --- Already done: a checked box that reopens the project ---------------
  if (done) {
    const reopenTo = initialStatusKey(statuses);
    const reopenLabel = statuses.find((s) => s.key === reopenTo)?.label ?? "open";
    return (
      <label
        className="inline-flex items-center gap-2 text-sm text-ink-muted"
        title={`Reopen this project (back to ${reopenLabel}). Its completed tasks stay done — use the undo toast right after completing if you meant to take the whole sweep back.`}
      >
        <input
          type="checkbox"
          className="ledgr-check ledgr-check-sm"
          checked
          disabled={busy}
          onChange={async () => {
            setBusy(true);
            beginSave();
            try {
              const res = await fetch(`/api/items/${itemId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: reopenTo }),
              });
              endSave(res.ok);
              if (res.ok) {
                showToast(`Project reopened · ${reopenLabel}`);
                router.refresh();
              }
            } catch {
              endSave(false);
            } finally {
              setBusy(false);
            }
          }}
        />
        Project done
      </label>
    );
  }

  // --- Not done: the confirm-gated checkbox ------------------------------
  const description = loadingPlan
    ? "Checking what's still open…"
    : plan && plan.count > 0
      ? `Sets this project to Done and completes ${plan.summary}.`
      : "Sets this project to Done. Nothing open inside it to complete.";

  return (
    <ConfirmButton
      title="Mark this project done?"
      description={description}
      confirmLabel="Mark done"
      tone="primary"
      align="right"
      panelClassName="w-72"
      onOpen={() => void loadPlan()}
      onConfirm={complete}
      triggerClassName="inline-flex items-center gap-2 rounded-full border border-line-strong px-2.5 py-1 text-sm text-ink-muted hover:text-ink"
      triggerLabel="Mark this project done"
      trigger={
        <>
          {/* A real box glyph, not an <input>: the actual state change happens
              on confirm, so a checkbox you could tick without confirming would
              be lying about what it did. */}
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 shrink-0 rounded-sm border border-current"
          />
          Mark this project done
        </>
      }
    >
      {plan && (plan.skipped.recurring > 0 || plan.skipped.noCompletion > 0) && (
        <ul className="flex flex-col gap-1 text-xs text-ink-subtle">
          {plan.skipped.recurring > 0 && (
            <li>
              Leaves {plan.skipped.recurringSummary} alone — repeating tasks
              advance to their next date instead of closing.
            </li>
          )}
          {plan.skipped.noCompletion > 0 && (
            <li>
              Leaves {plan.skipped.noCompletionSummary} alone — those types have
              no done state. Give one a Done checkbox in Build to include it.
            </li>
          )}
        </ul>
      )}
    </ConfirmButton>
  );
}
