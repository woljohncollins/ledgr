// Shared item utility footer (item-view UI refresh). One home for the item's
// export/share/history controls so every canvas gets the same footer — build
// once, applies to each type. It folds Save Offline + Share link (previously two
// always-open button rows on every item) into a single collapsed "Export &
// sharing" section, matching the existing collapsed "Fields" pattern, then keeps
// Version History as its own collapsed section beside it (it already carries its
// own diff/restore chrome, so it stays first-class rather than nested).
//
// The FILES section (ADR-237, Tyler 2026-08-29) sits above Export & sharing —
// a collapsible section like its neighbors, visible only when the item has
// files — so deleting an inline link out of the body never strands a file
// invisibly: it's listed here with a "not linked" chip, a Copy link to put it
// back, and Delete to remove it for real. Client-mounted and event-fed
// (ItemFilesSection) so it appears the moment the FIRST upload lands, without
// a reload. EVERY canvas that renders this footer gets it — the file canvas
// included, whose own lead panel repeats it (Tyler, 2026-09-12): one place to
// look sitewide beats one type where the answer is somewhere else. Tasks are
// the exception and don't render this footer at all; Files is a rail row there
// (ADR-253).
//
// A server component — the controls are client islands, the wrappers are
// plain markup. MarkdownCanvas's arrange grid places Save Offline / Share /
// History as individually arrangeable cards, so it renders those directly and
// does NOT use this footer; every non-arranged canvas does.
import SaveOffline from "@/components/canvas/SaveOffline";
import ShareLink from "@/components/canvas/ShareLink";
import PresentationExport from "@/components/canvas/PresentationExport";
import HistoryPanel from "@/components/canvas/HistoryPanel";
import ItemFilesSection from "@/components/attachments/ItemFilesSection";
import { listItemFilesWithRefs } from "@/lib/attachments";
import { resolveOwner } from "@/lib/owner";

export default async function ItemUtilitiesFooter({
  itemId,
  currentText,
  filesSection = true,
  exportSharing = true,
  history = true,
  bare = false,
}: {
  itemId: string;
  // The live body markdown, for the Version History "vs. current" diff.
  currentText: string;
  // Kept as an escape hatch for a canvas that truly owns the whole story; no
  // canvas turns it off today (the file canvas used to — see the header).
  filesSection?: boolean;
  // The TASK canvas opts out (Tyler, 2026-09-11): Save Offline, Share link and
  // the presentation export are BODY-shaped features, and a task's body is a
  // line or two. Files and Version History still render — hiding those was an
  // overreach, since a file whose body link is deleted would be stranded with
  // nowhere to find it (the safety property ADR-237 exists for), and revisions
  // are a task's only undo for a clobbered description.
  exportSharing?: boolean;
  // The TASK canvas renders Version History in its RAIL instead (Tyler,
  // 2026-09-11), directly under Linked, so it opts out of the copy here rather
  // than showing the same panel twice.
  history?: boolean;
  // Drop the centered reading column, for a host that already provides one (the
  // task canvas renders this inside its two-pane main column).
  bare?: boolean;
}) {
  const owner = filesSection ? await resolveOwner() : null;
  const files = owner
    ? await listItemFilesWithRefs(owner.id, itemId).catch(() => [])
    : [];
  return (
    <>
      {filesSection && (
        // Mounted even with zero files: it renders nothing until an upload
        // event arrives, which is what makes the section appear live on the
        // FIRST upload instead of after a reload. Collapsible like its
        // neighbors (Tyler, 2026-08-29).
        <ItemFilesSection itemId={itemId} initial={files} bare={bare} />
      )}
      {exportSharing && (
        <div
          className={
            bare
              ? ""
              : "canvas-section-wrap mx-auto w-full max-w-3xl px-2 sm:px-8 md:px-12"
          }
        >
          <details className={`canvas-section ${bare ? "canvas-section-bare" : ""}`}>
            <summary className="canvas-section-title cursor-pointer hover:text-ink">
              Export &amp; sharing
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <SaveOffline itemId={itemId} bare />
              <ShareLink itemId={itemId} bare />
              <PresentationExport itemId={itemId} bare />
            </div>
          </details>
        </div>
      )}
      {history && (
        <HistoryPanel itemId={itemId} currentText={currentText} bare={bare} />
      )}
    </>
  );
}
