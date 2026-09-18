// The weighted-points progress model for Project homepages (Tyler, 2026-07-01).
// A project's progress bar is derived from the *things inside it*, not just a
// task count: tasks carry weight (more when they have subtasks), milestones and
// meetings each contribute, and the bar reads completed-points ÷ total-points.
//
// Pure and client-safe (no DB, no dates baked in) so it can be unit-verified and
// reused by both the record canvas (record-widgets.ts, precise per-task subtree
// credit) and the all-projects card grid (project-cards.ts, a cheaper flat pass).
// The "is it complete?" predicates for milestones/meetings live at the call site
// (they need today's date); this file only turns counts + fractions into points.

export const POINT_WEIGHTS = {
  // A task is worth this on its own, plus `subtask` per direct subtask — so a
  // task with real structure weighs more than a one-liner.
  task: 3,
  subtask: 1,
  // A milestone is a dated commitment; complete once its date has passed.
  milestone: 5,
  // A meeting is light; complete once it's in the past.
  meeting: 1,
} as const;

export type PointProgress = {
  // Completed and total *points* (not item counts).
  done: number;
  total: number;
  // done / total, or null when there's nothing to track yet (empty project).
  fraction: number | null;
};

export const EMPTY_PROGRESS: PointProgress = { done: 0, total: 0, fraction: null };

// One task's point contribution. `subtaskCount` is its direct subtask count;
// `fraction` is how done it is (0..1) — a leaf task is 0 or 1, a parent task is
// its subtree completion fraction. Earned scales the total by that fraction, so
// a half-finished task with subtasks earns partial credit.
export function taskPoints(fraction: number, subtaskCount: number): PointProgress {
  const total = POINT_WEIGHTS.task + Math.max(subtaskCount, 0) * POINT_WEIGHTS.subtask;
  const clamped = Math.max(0, Math.min(fraction, 1));
  return { done: total * clamped, total, fraction: clamped };
}

export function milestonePoints(passed: boolean): PointProgress {
  return { done: passed ? POINT_WEIGHTS.milestone : 0, total: POINT_WEIGHTS.milestone, fraction: passed ? 1 : 0 };
}

// A milestone's explicit share of the bar (ADR-196): its `points` property read
// as a PERCENT of the whole project, 0–100. 0 / missing / junk = no share (the
// milestone stays in the default 5-point pool above).
export function milestoneSharePct(properties: unknown): number {
  const raw = (properties as Record<string, unknown> | null)?.points;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
}

export type MilestoneShare = { pct: number; done: boolean };

// Overlay explicit milestone shares onto the pooled points bar (ADR-196). Each
// share claims its percent of the WHOLE bar ("this milestone done = +30%"), and
// the pooled items (tasks, meetings, unweighted milestones) split what's left.
// Shares summing past 100 are scaled down proportionally so the bar stays sane.
// The result is re-expressed on a 100-point scale (fraction is what the bars
// render; done/total only need to stay proportional).
export function applyMilestoneShares(base: PointProgress, shares: MilestoneShare[]): PointProgress {
  const live = shares.filter((s) => s.pct > 0);
  if (live.length === 0) return base;
  const sum = live.reduce((a, s) => a + s.pct, 0);
  const scale = sum > 100 ? 100 / sum : 1;
  const shareFrac = Math.min(sum * scale, 100) / 100;
  const doneFrac = live.reduce((a, s) => a + (s.done ? s.pct * scale : 0), 0) / 100;
  // No pooled items: the shares ARE the project (their claimed slice rescales
  // to the whole bar). Otherwise the pool fills the remaining (1 - shares) slice.
  const fraction =
    base.total === 0
      ? doneFrac / shareFrac
      : (base.fraction ?? 0) * (1 - shareFrac) + doneFrac;
  return { done: fraction * 100, total: 100, fraction };
}

export function meetingPoints(past: boolean): PointProgress {
  return { done: past ? POINT_WEIGHTS.meeting : 0, total: POINT_WEIGHTS.meeting, fraction: past ? 1 : 0 };
}

// Sum a set of point contributions into one bar. total 0 → fraction null so the
// UI can say "nothing to track yet" instead of "0%".
export function combineProgress(parts: PointProgress[]): PointProgress {
  let done = 0;
  let total = 0;
  for (const p of parts) {
    done += p.done;
    total += p.total;
  }
  return { done, total, fraction: total === 0 ? null : done / total };
}

// A percentage 0..100 (rounded) or null when indeterminate. Shared by the bar
// renderers so the canvas and the cards agree on rounding.
export function progressPct(p: PointProgress): number | null {
  return p.fraction === null ? null : Math.round(p.fraction * 100);
}
