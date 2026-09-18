"use client";

// Milestones widget body (Project Type). The row rules — mode-dependent
// completion circles, upcoming/passed/done badges, points chips, done-sink
// sort — live in the shared MilestoneList (ADR-196; extracted 2026-08-17 so
// the full collection page renders the same rows). This wrapper adds the
// "+ Milestone" box: title, optional date, optional points %, and an optional
// completes-with task picker (InlineContainAdd).
import AttachExistingButton from "@/components/canvas/widgets/AttachExistingButton";
import InlineContainAdd from "@/components/canvas/widgets/InlineContainAdd";
import MilestoneList, { type MilestoneRow } from "@/components/milestones/MilestoneList";

export default function MilestonesWidget({
  recordId,
  items,
}: {
  recordId: string;
  items: MilestoneRow[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <MilestoneList items={items} />
      <div className="flex flex-wrap items-center gap-1">
        <InlineContainAdd recordId={recordId} type="milestone" label="Milestone" />
        <AttachExistingButton recordId={recordId} type="milestone" label="milestone" />
      </div>
    </div>
  );
}
