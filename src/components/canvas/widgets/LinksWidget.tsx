"use client";

// Links widget body (Project Type, Tyler 2026-07-01): the project's contained
// links / resources. The rows live in the shared LinkList (extracted 2026-08-17
// so the full collection page renders the same rows — the title is the outbound
// link, a URL-less one links to the item); "+ Add link" creates a link
// associated with this project and opens it in the link editor modal (where the
// URL is set).
import AddContainedItemButton from "@/components/canvas/widgets/AddContainedItemButton";
import LinkList, { type LinkRow } from "@/components/links/LinkList";

export default function LinksWidget({
  recordId,
  items,
}: {
  recordId: string;
  items: LinkRow[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <LinkList items={items} detachFrom={recordId} />
      <AddContainedItemButton recordId={recordId} type="link" label="Add link" />
    </div>
  );
}
