"use client";

// Meetings widget body (Project Type, Tyler 2026-07-01): the record's contained
// meetings (events) with their dates. The row rules live in the shared
// MeetingList (extracted 2026-08-17 so the full collection page renders the
// same rows); this wrapper adds the "+ Meeting" compact title + date box
// (InlineContainAdd). The date lands on meeting_at server-side.
import AttachExistingButton from "@/components/canvas/widgets/AttachExistingButton";
import InlineContainAdd from "@/components/canvas/widgets/InlineContainAdd";
import MeetingList, { type MeetingRow } from "@/components/meetings/MeetingList";

export default function MeetingsWidget({
  recordId,
  items,
}: {
  recordId: string;
  items: MeetingRow[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <MeetingList items={items} detachFrom={recordId} />
      <div className="flex flex-wrap items-center gap-1">
        <InlineContainAdd recordId={recordId} type="event" label="Meeting" withTime />
        <AttachExistingButton recordId={recordId} type="event" label="meeting" />
      </div>
    </div>
  );
}
