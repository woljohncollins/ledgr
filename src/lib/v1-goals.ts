// The two v1.0 bars (Brandon + Tyler), rendered as progress bars on the
// Changelog page. Each builder defined their own "done" line (see COLLAB.md):
// Brandon's is "fully replace my Notion workflows"; Tyler's is "replace Todoist
// + Apple Notes, and be my creative + dev workspace." This file is the
// hand-maintained source of truth for that progress — bump an item's `status`
// as the work lands (done counts full, in_progress counts half).

export type GoalStatus = "done" | "in_progress" | "todo";

export type Goal = {
  label: string;
  status: GoalStatus;
  note?: string;
};

export type GoalSet = {
  person: string;
  bar: string; // the one-line "v1.0 =" definition
  goals: Goal[];
};

const WEIGHT: Record<GoalStatus, number> = { done: 1, in_progress: 0.5, todo: 0 };

export function goalProgress(goals: Goal[]): {
  pct: number;
  done: number;
  inProgress: number;
  total: number;
} {
  const total = goals.length;
  const done = goals.filter((g) => g.status === "done").length;
  const inProgress = goals.filter((g) => g.status === "in_progress").length;
  const score = goals.reduce((sum, g) => sum + WEIGHT[g.status], 0);
  const pct = total === 0 ? 0 : Math.round((score / total) * 100);
  return { pct, done, inProgress, total };
}

export const V1_GOALS: GoalSet[] = [
  {
    person: "Brandon",
    bar: "Fully replace my Notion workflows with Ledgr.",
    // Deferred to post-1.0 (Brandon, 2026-06-20): sermon writing/preaching
    // workspace (PDF/MD/Notion suffice for a while; not needed for 1.0) and the
    // web-clipped note archive (important long-term, not vital short-term — the
    // PWA share target already captures URL+title today). Both dropped from the
    // 1.0 bar below.
    goals: [
      {
        label: "Native task tracking (replaces Todoist)",
        status: "done",
        note: "Native Tasks T1–T6 + Polish S1–S6 (ADR-073–086)",
      },
      {
        label: "Meeting notes + transcription → minutes",
        status: "done",
        note: "Meeting Recording v1a + v1b (ADR-087–089)",
      },
      {
        label: "Templates (duplicate-a-prototype workflow)",
        status: "done",
        note: "TPL1–TPL5 shipped (ADR-093)",
      },
      {
        label: "Calendar events + meeting task-matching",
        status: "done",
        note: "Events chunk E1–E4 shipped (ADR-094): meeting→event, tags, calendar feed + click-to-add, configurable task-pull",
      },
      {
        label: "Selective Notion data migration",
        status: "todo",
        note: "have MD-file exports; exploring a direct Notion→Ledgr API transfer",
      },
      {
        label: "Alpha → v1.0 production flip",
        status: "done",
        note: "Flipped 2026-06-26 (ADR-115): production data, migration caution + no-Saturday-deploys in force",
      },
    ],
  },
  {
    person: "Tyler",
    bar: "Replace Todoist + Apple Notes, and be my creative + dev workspace.",
    // Statuses re-called by Tyler from live daily use, 2026-08-20: tasks and
    // projects are "ready to go for my use" (polish continues — ADR-202/204/205
    // rounds), notes is ready, Papers was previously marked done but needs more
    // work, Songs still needs work, and Sermons counts as partially complete
    // because Brandon built a version of the sermons module.
    goals: [
      {
        label: "Native tasks cover my Todoist usage",
        status: "done",
        note: "covering the real workflow in daily use; polish rounds ongoing (tasks-row redesign ADR-202, subtask fold ADR-205)",
      },
      {
        label: "Notes replace Apple Notes (one type, relations)",
        status: "done",
        note: "ready to go (Tyler, 2026-08-20)",
      },
      {
        label: "Papers module",
        status: "in_progress",
        note: "shipped in ADR-048 and previously marked done; pulled back — needs more work (Tyler, 2026-08-20)",
      },
      {
        label: "Finish Songs module (author songs in Ledgr)",
        status: "in_progress",
        note: "chord canvas exists; song-import spec'd; needs more work (Tyler, 2026-08-20)",
      },
      {
        label: "Sermons bespoke type (+ upload existing)",
        status: "in_progress",
        note: "partially complete — Brandon built a version of the sermons module",
      },
      {
        label: "Projects bespoke type (hub: tasks + notes/files/meetings)",
        status: "done",
        note: "done though not perfect — ready for my use (Tyler, 2026-08-20; widget home + tools, ADR-199/200/204)",
      },
      {
        label: "Item windows round: peek + full screen + arrange",
        status: "todo",
        note: "the parked window round (next_steps, 2026-08-17) plus its bugs: the vanishing mid-width field, peek click-through-to-underneath, customize-layout discoverability",
      },
    ],
  },
];
