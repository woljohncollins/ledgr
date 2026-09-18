// A subtle chip naming the milestone a task completes (ADR-196 "Completes with
// task"), worn by task rows in a record's context — the Tasks card and the full
// task list — so it's visible which tasks go with a milestone (Tyler,
// 2026-08-17: milestones ARE the task grouping). Links to the milestone.
// No "use client" directive: stateless, renders on server pages and inside
// client widgets alike. Hidden on the narrowest screens (the title wins).
import Link from "next/link";
import NavGlyph from "@/components/nav/NavGlyph";

export default function MilestoneFlag({ id, title }: { id: string; title: string }) {
  return (
    <Link
      href={`/items/${id}`}
      title={`Milestone: ${title || "Untitled"}`}
      draggable={false}
      className="hidden max-w-36 shrink-0 items-center gap-1 rounded bg-neutral-800/60 px-1.5 py-0.5 text-xs text-neutral-500 hover:text-neutral-300 sm:inline-flex"
    >
      <NavGlyph icon="flag" size={11} className="shrink-0" />
      <span className="truncate">{title || "Untitled"}</span>
    </Link>
  );
}
